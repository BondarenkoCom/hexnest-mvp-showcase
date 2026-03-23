import { spawn } from "child_process";
import { newId, nowIso } from "../utils/ids";

export type WebSearchJobStatus = "queued" | "running" | "done" | "failed" | "timeout";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchJob {
  id: string;
  roomId: string;
  agentId: string;
  agentName: string;
  status: WebSearchJobStatus;
  query: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  results?: SearchResult[];
  error?: string;
}

export type WebSearchJobUpdateKind = "queued" | "started" | "finished";

export interface WebSearchJobUpdate {
  kind: WebSearchJobUpdateKind;
  job: WebSearchJob;
}

export interface WebSearchManagerOptions {
  concurrency: number;
  maxResults: number;
  timeoutMs: number;
  pythonCommand: string;
  onUpdate?: (update: WebSearchJobUpdate) => void;
}

export class WebSearchManager {
  private readonly jobs = new Map<string, WebSearchJob>();
  private readonly roomJobs = new Map<string, string[]>();
  private readonly queue: string[] = [];
  private activeCount = 0;

  constructor(private readonly options: WebSearchManagerOptions) {}

  public static defaultOptions(
    onUpdate?: (update: WebSearchJobUpdate) => void
  ): WebSearchManagerOptions {
    return {
      concurrency: 3,
      maxResults: 8,
      timeoutMs: 20_000,
      pythonCommand: process.env.HEXNEST_PYTHON_CMD || "python",
      onUpdate
    };
  }

  public submit(input: {
    roomId: string;
    agentId: string;
    agentName: string;
    query: string;
  }): WebSearchJob {
    const query = (input.query || "").trim();
    if (!query) throw new Error("query is required");
    if (query.length > 500) throw new Error("query too long (max 500 chars)");

    const job: WebSearchJob = {
      id: newId(),
      roomId: input.roomId,
      agentId: input.agentId,
      agentName: input.agentName,
      status: "queued",
      query,
      createdAt: nowIso()
    };

    this.jobs.set(job.id, job);
    this.queue.push(job.id);

    const roomList = this.roomJobs.get(job.roomId) || [];
    roomList.unshift(job.id);
    this.roomJobs.set(job.roomId, roomList);

    this.emit("queued", job);
    this.drain();
    return cloneJob(job);
  }

  public listByRoom(roomId: string): WebSearchJob[] {
    const ids = this.roomJobs.get(roomId) || [];
    return ids
      .map((id) => this.jobs.get(id))
      .filter((item): item is WebSearchJob => Boolean(item))
      .map((job) => cloneJob(job));
  }

  public get(jobId: string): WebSearchJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? cloneJob(job) : undefined;
  }

  private drain(): void {
    while (this.activeCount < this.options.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) return;
      void this.runJob(jobId);
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    this.activeCount += 1;
    job.status = "running";
    job.startedAt = nowIso();
    this.emit("started", job);

    try {
      const results = await this.searchViaPython(job.query);
      job.status = "done";
      job.results = results;
      job.finishedAt = nowIso();
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = nowIso();
    } finally {
      this.emit("finished", job);
      this.activeCount -= 1;
      this.drain();
    }
  }

  private searchViaPython(query: string): Promise<SearchResult[]> {
    return new Promise((resolve, reject) => {
      const maxResults = this.options.maxResults;
      const script = `
import json
try:
    from ddgs import DDGS
    results = DDGS().text(${JSON.stringify(query)}, max_results=${maxResults})
    out = [{"title": r.get("title",""), "url": r.get("href",""), "snippet": r.get("body","")} for r in results]
    print(json.dumps(out))
except ImportError:
    from duckduckgo_search import DDGS
    results = DDGS().text(${JSON.stringify(query)}, max_results=${maxResults})
    out = [{"title": r.get("title",""), "url": r.get("href",""), "snippet": r.get("body","")} for r in results]
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const proc = spawn(this.options.pythonCommand, ["-c", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" }
      });

      proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, this.options.timeoutMs);

      proc.on("close", () => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error("Search timed out"));
          return;
        }
        try {
          const data = JSON.parse(stdout.trim());
          if (data.error) {
            reject(new Error(data.error));
            return;
          }
          if (Array.isArray(data)) {
            resolve(data.filter((r: SearchResult) => r.title && r.url));
            return;
          }
          resolve([]);
        } catch {
          reject(new Error(stderr || "Failed to parse search results"));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private emit(kind: WebSearchJobUpdateKind, job: WebSearchJob): void {
    if (!this.options.onUpdate) return;
    this.options.onUpdate({ kind, job: cloneJob(job) });
  }
}

function cloneJob(job: WebSearchJob): WebSearchJob {
  return JSON.parse(JSON.stringify(job)) as WebSearchJob;
}
