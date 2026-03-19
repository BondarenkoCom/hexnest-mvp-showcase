import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { PythonJob } from "../types/protocol";
import { newId, nowIso } from "../utils/ids";

export interface PythonJobFileInput {
  path: string;
  content: string;
}

export interface SubmitPythonJobInput {
  roomId: string;
  agentId: string;
  agentName: string;
  code: string;
  timeoutSec?: number;
  files?: PythonJobFileInput[];
}

export type PythonJobUpdateKind = "queued" | "started" | "finished";

export interface PythonJobUpdate {
  kind: PythonJobUpdateKind;
  job: PythonJob;
}

interface ExecuteResult {
  status: PythonJob["status"];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string;
  outputTruncated: boolean;
}

export interface PythonJobManagerOptions {
  concurrency: number;
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  maxCodeChars: number;
  maxOutputChars: number;
  pythonCommand: string;
  workRoot: string;
  onUpdate?: (update: PythonJobUpdate) => void;
}

export class PythonJobManager {
  private readonly jobs = new Map<string, PythonJob>();
  private readonly roomJobs = new Map<string, string[]>();
  private readonly queue: string[] = [];
  private readonly inputFiles = new Map<string, PythonJobFileInput[]>();
  private activeCount = 0;

  constructor(private readonly options: PythonJobManagerOptions) {}

  public static defaultOptions(
    onUpdate?: (update: PythonJobUpdate) => void
  ): PythonJobManagerOptions {
    return {
      concurrency: Number(process.env.HEXNEST_PYTHON_WORKERS || 2),
      defaultTimeoutSec: Number(process.env.HEXNEST_PYTHON_TIMEOUT_SEC || 35),
      maxTimeoutSec: Number(process.env.HEXNEST_PYTHON_MAX_TIMEOUT_SEC || 120),
      maxCodeChars: Number(process.env.HEXNEST_PYTHON_MAX_CODE_CHARS || 25000),
      maxOutputChars: Number(process.env.HEXNEST_PYTHON_MAX_OUTPUT_CHARS || 18000),
      pythonCommand: process.env.HEXNEST_PYTHON_CMD || "python",
      workRoot: path.join(os.tmpdir(), "hexnest-python-jobs"),
      onUpdate
    };
  }

  public submit(input: SubmitPythonJobInput): PythonJob {
    const code = normalizeCode(input.code, this.options.maxCodeChars);
    const timeoutSec = normalizeTimeout(
      input.timeoutSec,
      this.options.defaultTimeoutSec,
      this.options.maxTimeoutSec
    );
    const files = normalizeFiles(input.files || []);

    const job: PythonJob = {
      id: newId(),
      roomId: input.roomId,
      agentId: input.agentId,
      agentName: input.agentName,
      status: "queued",
      code,
      createdAt: nowIso(),
      timeoutSec
    };

    this.jobs.set(job.id, job);
    this.inputFiles.set(job.id, files);
    this.queue.push(job.id);

    const roomList = this.roomJobs.get(job.roomId) || [];
    roomList.unshift(job.id);
    this.roomJobs.set(job.roomId, roomList);

    this.emit("queued", job);
    this.drain();
    return cloneJob(job);
  }

  public listByRoom(roomId: string): PythonJob[] {
    const ids = this.roomJobs.get(roomId) || [];
    return ids
      .map((id) => this.jobs.get(id))
      .filter((item): item is PythonJob => Boolean(item))
      .map((job) => cloneJob(job));
  }

  public get(jobId: string): PythonJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? cloneJob(job) : undefined;
  }

  private drain(): void {
    const limit = Math.max(1, this.options.concurrency);
    while (this.activeCount < limit && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) {
        return;
      }
      void this.runJob(jobId);
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    this.activeCount += 1;
    job.status = "running";
    job.startedAt = nowIso();
    this.emit("started", job);

    try {
      const files = this.inputFiles.get(jobId) || [];
      const result = await this.executePython(job, files);

      job.status = result.status;
      job.exitCode = result.exitCode;
      job.stdout = result.stdout;
      job.stderr = result.stderr;
      job.error = result.error;
      job.outputTruncated = result.outputTruncated;
      job.finishedAt = nowIso();
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.exitCode = null;
      job.finishedAt = nowIso();
    } finally {
      this.inputFiles.delete(jobId);
      this.emit("finished", job);
      this.activeCount -= 1;
      this.drain();
    }
  }

  private async executePython(
    job: PythonJob,
    files: PythonJobFileInput[]
  ): Promise<ExecuteResult> {
    await fs.mkdir(this.options.workRoot, { recursive: true });
    const workDir = path.join(this.options.workRoot, job.id);
    await fs.mkdir(workDir, { recursive: true });

    try {
      for (const file of files) {
        const rel = toSafeRelativePath(file.path);
        const fullPath = path.join(workDir, rel);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, file.content, "utf8");
      }

      const scriptPath = path.join(workDir, "main.py");
      await fs.writeFile(scriptPath, job.code, "utf8");

      // Copy sandbox wrapper into workdir
      const wrapperSrc = path.resolve(__dirname, "sandbox_wrapper.py");
      const wrapperDst = path.join(workDir, "_sandbox.py");
      await fs.copyFile(wrapperSrc, wrapperDst);

      const maxOutput = Math.max(1000, this.options.maxOutputChars);
      let stdout = "";
      let stderr = "";
      let outputTruncated = false;
      let timedOut = false;

      // Run sandbox wrapper instead of user script directly
      const proc = spawn(this.options.pythonCommand, ["-I", "-u", wrapperDst], {
        cwd: workDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PYTHONUNBUFFERED: "1"
        }
      });

      const append = (bucket: "stdout" | "stderr", chunk: Buffer): void => {
        const text = chunk.toString("utf8");
        if (bucket === "stdout") {
          stdout += text;
          if (stdout.length > maxOutput) {
            stdout = `${stdout.slice(0, maxOutput)}\n...[truncated]`;
            outputTruncated = true;
          }
          return;
        }
        stderr += text;
        if (stderr.length > maxOutput) {
          stderr = `${stderr.slice(0, maxOutput)}\n...[truncated]`;
          outputTruncated = true;
        }
      };

      proc.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      proc.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

      const timeoutMs = Math.max(1, job.timeoutSec) * 1000;
      const killTimer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        proc.on("error", reject);
        proc.on("close", (code) => resolve(code));
      }).finally(() => {
        clearTimeout(killTimer);
      });

      if (timedOut) {
        return {
          status: "timeout",
          exitCode,
          stdout,
          stderr,
          error: `Execution timed out after ${job.timeoutSec}s`,
          outputTruncated
        };
      }

      if (exitCode === 0) {
        return {
          status: "done",
          exitCode,
          stdout,
          stderr,
          error: "",
          outputTruncated
        };
      }

      return {
        status: "failed",
        exitCode,
        stdout,
        stderr,
        error: "Python process exited with non-zero code.",
        outputTruncated
      };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private emit(kind: PythonJobUpdateKind, job: PythonJob): void {
    if (!this.options.onUpdate) {
      return;
    }
    this.options.onUpdate({
      kind,
      job: cloneJob(job)
    });
  }
}

function cloneJob(job: PythonJob): PythonJob {
  return JSON.parse(JSON.stringify(job)) as PythonJob;
}

function normalizeTimeout(
  value: number | undefined,
  defaultValue: number,
  maxValue: number
): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return defaultValue;
  }
  return Math.min(maxValue, Math.max(1, Math.floor(num)));
}

// Patterns that should never appear in agent code
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bos\.system\b/, reason: "os.system() is blocked" },
  { pattern: /\bos\.popen\b/, reason: "os.popen() is blocked" },
  { pattern: /\bos\.exec\w*\b/, reason: "os.exec*() is blocked" },
  { pattern: /\bos\.spawn\w*\b/, reason: "os.spawn*() is blocked" },
  { pattern: /\bos\.remove\b/, reason: "os.remove() is blocked" },
  { pattern: /\bos\.unlink\b/, reason: "os.unlink() is blocked" },
  { pattern: /\bos\.rmdir\b/, reason: "os.rmdir() is blocked" },
  { pattern: /\bos\.rename\b/, reason: "os.rename() is blocked" },
  { pattern: /\bsubprocess\b/, reason: "subprocess is blocked" },
  { pattern: /\bshutil\b/, reason: "shutil is blocked" },
  { pattern: /\b__import__\b/, reason: "__import__() is blocked" },
  { pattern: /\beval\s*\(/, reason: "eval() is blocked" },
  { pattern: /\bexec\s*\(/, reason: "exec() is blocked" },
  { pattern: /\bopen\s*\([^)]*['"][wa+]/, reason: "file writing is blocked" },
  { pattern: /\bsocket\b/, reason: "socket access is blocked" },
  { pattern: /\bctypes\b/, reason: "ctypes is blocked" },
  { pattern: /\brequest[s]?\.(get|post|put|delete)\b/, reason: "HTTP requests are blocked" },
  { pattern: /\burllib\b/, reason: "urllib is blocked" },
];

function normalizeCode(code: string, maxChars: number): string {
  if (typeof code !== "string") {
    throw new Error("code is required");
  }
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    throw new Error("code is required");
  }
  if (trimmed.length > maxChars) {
    throw new Error(`code exceeds max length (${maxChars})`);
  }

  // Pre-scan for dangerous patterns
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error(`[Sandbox] Code rejected: ${reason}`);
    }
  }

  return trimmed;
}

function normalizeFiles(files: PythonJobFileInput[]): PythonJobFileInput[] {
  return files.map((file) => ({
    path: toSafeRelativePath(file.path),
    content: typeof file.content === "string" ? file.content : ""
  }));
}

function toSafeRelativePath(rawPath: string): string {
  const value = String(rawPath || "").trim().replaceAll("\\", "/");
  if (!value || value.startsWith("/")) {
    throw new Error("invalid file path");
  }
  if (value.includes("..")) {
    throw new Error("path traversal is not allowed");
  }
  return value;
}
