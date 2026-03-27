import express from "express";
import { IAppStore } from "../orchestration/RoomStore";
import {
  PythonJobManager,
  PythonJobUpdate,
  SubmitPythonJobInput
} from "../tools/PythonJobManager";
import { WebSearchManager, WebSearchJobUpdate } from "../tools/WebSearchManager";
import { ConnectedAgent, RoomSnapshot } from "../types/protocol";
import { newId, nowIso } from "../utils/ids";
import { normalizeText } from "../utils/normalize";
import { newSystemEvent } from "../utils/room-builders";

export function createPythonJobUpdateHandler(
  store: IAppStore
): (update: PythonJobUpdate) => void {
  return function onPythonJobUpdate(update: PythonJobUpdate): void {
    void (async () => {
      const room = await store.getRoom(update.job.roomId);
      if (!room) return;

      upsertPythonJob(room, update.job);

      if (update.kind === "queued") {
        room.timeline.push(
          newSystemEvent(room.id, "open_room", "python_job_queued",
            `${update.job.agentName} queued Python job ${update.job.id.slice(0, 8)}`)
        );
      } else if (update.kind === "started") {
        room.timeline.push(
          newSystemEvent(room.id, "open_room", "python_job_started",
            `${update.job.agentName} started Python job ${update.job.id.slice(0, 8)}`)
        );
      } else if (update.kind === "finished") {
        room.timeline.push(
          newSystemEvent(room.id, "open_room", `python_job_${update.job.status}`,
            `${update.job.agentName} finished Python job ${update.job.id.slice(0, 8)} with status ${update.job.status}`)
        );

        room.artifacts.push({
          id: newId(),
          taskId: room.id,
          type: "note",
          label: `Python job ${update.job.id.slice(0, 8)} (${update.job.status})`,
          producer: update.job.agentName,
          timestamp: nowIso(),
          content: [
            `status=${update.job.status}`,
            `exit_code=${String(update.job.exitCode)}`,
            update.job.error ? `error=${update.job.error}` : "",
            "",
            "stdout:",
            update.job.stdout || "",
            "",
            "stderr:",
            update.job.stderr || ""
          ]
            .filter(Boolean)
            .join("\n")
        });
      }

      room.status = "open";
      await store.saveRoom(room);
    })().catch(err => console.error("python job update error:", err));
  };
}

export function createWebSearchJobUpdateHandler(
  store: IAppStore
): (update: WebSearchJobUpdate) => void {
  return function onWebSearchJobUpdate(update: WebSearchJobUpdate): void {
    void (async () => {
      const room = await store.getRoom(update.job.roomId);
      if (!room) return;

      if (!room.searchJobs) room.searchJobs = [];
      const idx = room.searchJobs.findIndex((j) => j.id === update.job.id);
      if (idx >= 0) room.searchJobs[idx] = update.job;
      else room.searchJobs.unshift(update.job);

      if (update.kind === "queued") {
        room.timeline.push(
          newSystemEvent(room.id, "open_room", "web_search_queued",
            `${update.job.agentName} searched: "${update.job.query}"`)
        );
      } else if (update.kind === "started") {
        room.timeline.push(
          newSystemEvent(room.id, "open_room", "web_search_started",
            `${update.job.agentName} web search running...`)
        );
      } else if (update.kind === "finished") {
        room.timeline.push(
          newSystemEvent(room.id, "open_room", `web_search_${update.job.status}`,
            `${update.job.agentName} web search finished (${update.job.status})`)
        );

        if (update.job.results && update.job.results.length > 0) {
          const content = update.job.results
            .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
            .join("\n\n");

          room.artifacts.push({
            id: newId(),
            taskId: room.id,
            type: "note",
            label: `Web search: "${update.job.query}" (${update.job.results.length} results)`,
            producer: update.job.agentName,
            timestamp: nowIso(),
            content: `Query: ${update.job.query}\n\n${content}`
          });
        }
      }

      room.status = "open";
      await store.saveRoom(room);
    })().catch(err => console.error("web search job update error:", err));
  };
}

export function createJobsRouter(
  store: IAppStore,
  pythonJobs: PythonJobManager,
  webSearch: WebSearchManager
): express.Router {
  const router = express.Router();

  // ── Python Jobs ──

  router.post("/rooms/:roomId/python-jobs", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    if (!room.settings.pythonShellEnabled) {
      res.status(400).json({ error: "pythonShellEnabled is false for this room. Enable it in room setup." });
      return;
    }

    if (!req.body?.agentId && !req.body?.agentName) {
      res.status(400).json({ error: "agentId or agentName is required" });
      return;
    }
    const from = resolveAgentInRoom(room, req.body?.agentId, req.body?.agentName);
    if (!from) {
      res.status(403).json({ error: "agent not found in room" });
      return;
    }

    try {
      const input: SubmitPythonJobInput = {
        roomId: room.id,
        agentId: from.id,
        agentName: from.name,
        code: normalizeText(req.body?.code, Number(process.env.HEXNEST_PYTHON_MAX_CODE_CHARS || 25000)),
        timeoutSec: Number(req.body?.timeoutSec),
        files: Array.isArray(req.body?.files)
          ? req.body.files.map((item: unknown) => ({
              path: normalizeText((item as { path?: unknown }).path, 150),
              content: normalizeText((item as { content?: unknown }).content, 100000)
            }))
          : []
      };

      const job = pythonJobs.submit(input);
      res.status(202).json(job);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "python job submission failed"
      });
    }
  });

  router.get("/rooms/:roomId/python-jobs", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    res.json({ value: room.pythonJobs });
  });

  router.get("/rooms/:roomId/python-jobs/:jobId", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    const job = room.pythonJobs.find((j) => j.id === req.params.jobId)
      ?? pythonJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "python job not found" });
      return;
    }
    res.json(job);
  });

  router.get("/python-jobs/:jobId", (req, res) => {
    const job = pythonJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "python job not found" });
      return;
    }
    res.json(job);
  });

  // ── Web Search Jobs ──

  router.post("/rooms/:roomId/search-jobs", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) { res.status(404).json({ error: "room not found" }); return; }
    if (!room.settings.webSearchEnabled) {
      res.status(400).json({ error: "Web search is disabled for this room. Enable it in room setup." });
      return;
    }

    const body = req.body || {};
    if (!body.agentId && !body.agentName) {
      res.status(400).json({ error: "agentId or agentName is required" });
      return;
    }
    const agent = room.connectedAgents.find(
      (a: ConnectedAgent) => a.id === body.agentId || a.name === body.agentId || a.name === body.agentName
    );
    if (!agent) { res.status(403).json({ error: "agent not found in room" }); return; }

    const query = (body.query || "").trim();
    if (!query) { res.status(400).json({ error: "query is required" }); return; }

    try {
      const job = webSearch.submit({
        roomId: room.id,
        agentId: agent.id,
        agentName: agent.name,
        query
      });
      res.status(202).json(job);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.get("/rooms/:roomId/search-jobs", async (req, res) => {
    const room = await store.getRoom(req.params.roomId);
    if (!room) { res.status(404).json({ error: "room not found" }); return; }
    res.json(webSearch.listByRoom(room.id));
  });

  router.get("/rooms/:roomId/search-jobs/:jobId", (req, res) => {
    const job = webSearch.get(req.params.jobId);
    if (!job) { res.status(404).json({ error: "search job not found" }); return; }
    res.json(job);
  });

  router.get("/search-jobs/:jobId", (req, res) => {
    const job = webSearch.get(req.params.jobId);
    if (!job) { res.status(404).json({ error: "search job not found" }); return; }
    res.json(job);
  });

  return router;
}

function upsertPythonJob(
  room: RoomSnapshot,
  job: RoomSnapshot["pythonJobs"][number]
): void {
  const index = room.pythonJobs.findIndex((item) => item.id === job.id);
  if (index >= 0) {
    room.pythonJobs[index] = job;
    return;
  }
  room.pythonJobs.unshift(job);
}

function resolveAgentInRoom(
  room: RoomSnapshot,
  agentIdRaw: unknown,
  agentNameRaw: unknown
): { id: string; name: string } | null {
  const agentId = typeof agentIdRaw === "string" ? agentIdRaw.trim().slice(0, 80) : "";
  if (agentId) {
    const found = room.connectedAgents.find((a) => a.id === agentId);
    if (found) return { id: found.id, name: found.name };
  }
  const agentName = typeof agentNameRaw === "string" ? agentNameRaw.trim().slice(0, 80) : "";
  if (!agentName) return null;
  const byName = room.connectedAgents.find((a) => a.name === agentName);
  if (byName) return { id: byName.id, name: byName.name };
  return null;
}
