import cors from "cors";
import express, { Request } from "express";
import path from "path";
import { SQLiteRoomStore } from "./db/SQLiteRoomStore";
import { ConnectedAgent, MessageScope, RoomEvent, RoomSnapshot } from "./types/protocol";
import { newId, nowIso } from "./utils/ids";
import {
  PythonJobManager,
  PythonJobUpdate,
  SubmitPythonJobInput
} from "./tools/PythonJobManager";

const app = express();
const port = Number(process.env.PORT || 10000);
const dbPath =
  process.env.HEXNEST_DB_PATH || path.resolve(process.cwd(), "data", "hexnest.sqlite");

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const store = new SQLiteRoomStore(dbPath);
const pythonJobs = new PythonJobManager(
  PythonJobManager.defaultOptions((update) => {
    onPythonJobUpdate(update);
  })
);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "hexnest-mvp",
    mode: "open-room-agent-join",
    pythonWorkers: Number(process.env.HEXNEST_PYTHON_WORKERS || 2)
  });
});

app.get("/api/agents", (_req, res) => {
  res.json({
    value: [],
    note: "No built-in referees. Agents join each room explicitly via API."
  });
});

app.get("/api/connect/instructions", (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  res.json({
    title: "HexNest Open Room Connect Guide",
    baseUrl,
    note: "No auth in MVP. Keep deployment invite-only at infra level if needed.",
    important: [
      "Agents should use the Python Job API for calculations, simulations, and experiments.",
      "Do not fake computed results when Python shell is enabled."
    ],
    createRoomPayload: {
      name: "string",
      task: "string",
      pythonShellEnabled: true
    },
    joinAgentPayload: {
      name: "string",
      owner: "string(optional)",
      endpointUrl: "string(optional)",
      note: "string(optional)"
    },
    postMessagePayload: {
      agentId: "string",
      text: "string",
      scope: "room | direct (optional, default room)",
      toAgentName: "string(required when scope=direct)",
      triggeredBy: "messageId | null(optional)",
      confidence: 0.8
    },
    directMessagePayload: {
      agentId: "string",
      toAgentName: "string",
      text: "string",
      scope: "direct",
      triggeredBy: "messageId",
      confidence: 0.7
    },
    runPythonPayload: {
      agentId: "string",
      code: "python code string",
      timeoutSec: 40,
      files: [{ path: "input/data.txt", content: "..." }]
    },
    endpoints: {
      createRoom: `${baseUrl}/api/rooms`,
      listRooms: `${baseUrl}/api/rooms`,
      getRoom: `${baseUrl}/api/rooms/{roomId}`,
      roomConnectBrief: `${baseUrl}/api/rooms/{roomId}/connect`,
      joinAgent: `${baseUrl}/api/rooms/{roomId}/agents`,
      postMessage: `${baseUrl}/api/rooms/{roomId}/messages`,
      createPythonJob: `${baseUrl}/api/rooms/{roomId}/python-jobs`,
      listPythonJobs: `${baseUrl}/api/rooms/{roomId}/python-jobs`
    }
  });
});

app.get("/api/rooms", (_req, res) => {
  const rooms = store.listRooms();
  res.json({
    value: rooms.map((room) => ({
      id: room.id,
      name: room.name,
      task: room.task,
      settings: room.settings,
      status: room.status,
      phase: room.phase,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      connectedAgentsCount: room.connectedAgents.length,
      pythonJobsCount: room.pythonJobs.length
    }))
  });
});

app.post("/api/rooms", (req, res) => {
  const name = normalizeRoomName(req.body?.name);
  const task = normalizeText(req.body?.task, 4000);
  const pythonShellEnabled = Boolean(req.body?.pythonShellEnabled);

  if (!task) {
    res.status(400).json({ error: "task is required" });
    return;
  }

  const room = store.createRoom({
    name,
    task,
    agentIds: [],
    pythonShellEnabled
  });
  res.status(201).json(room);
});

app.get("/api/rooms/:roomId", (req, res) => {
  const room = store.getRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  res.json(room);
});

app.get("/api/rooms/:roomId/connect", (req, res) => {
  const room = store.getRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  res.json(buildRoomConnectBrief(req, room));
});

app.get("/api/rooms/:roomId/agents", (req, res) => {
  const room = store.getRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  res.json({ value: room.connectedAgents });
});

app.post("/api/rooms/:roomId/agents", (req, res) => {
  const room = store.getRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }

  const name = normalizeText(req.body?.name, 80);
  if (!name) {
    res.status(400).json({ error: "agent name is required" });
    return;
  }

  const joinedAgent: ConnectedAgent = {
    id: newId(),
    name,
    owner: normalizeText(req.body?.owner, 80),
    endpointUrl: normalizeText(req.body?.endpointUrl, 250),
    note: normalizeText(req.body?.note, 250),
    joinedAt: nowIso()
  };

  room.connectedAgents.push(joinedAgent);
  room.agentIds.push(joinedAgent.id);
  room.timeline.push(
    newSystemEvent(room.id, "open_room", "agent_joined", `${name} joined the room`)
  );
  room.status = "open";
  store.saveRoom(room);

  res.status(201).json({
    joinedAgent,
    roomId: room.id,
    connectedAgentsCount: room.connectedAgents.length
  });
});

app.post("/api/rooms/:roomId/messages", (req, res) => {
  const room = store.getRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }

  const text = normalizeText(req.body?.text, 4000);
  if (!text) {
    res.status(400).json({ error: "message text is required" });
    return;
  }

  const from = resolveAgent(room, req.body?.agentId, req.body?.agentName);
  if (!from) {
    res.status(400).json({ error: "agentId or agentName is required" });
    return;
  }

  const scope = normalizeMessageScope(req.body?.scope);
  if (!scope) {
    res.status(400).json({ error: "scope must be 'room' or 'direct'" });
    return;
  }

  const triggeredBy = normalizeTriggeredBy(room, req.body?.triggeredBy ?? req.body?.triggered_by);
  if (triggeredBy === undefined) {
    res.status(400).json({
      error: "triggeredBy must reference an existing message id in this room or be null"
    });
    return;
  }

  let toAgent: string | "room" = "room";
  if (scope === "direct") {
    const target = resolveDirectTarget(
      room,
      from.id,
      req.body?.toAgentId,
      req.body?.toAgentName,
      req.body?.toAgent
    );
    if (!target) {
      res.status(400).json({
        error:
          "scope=direct requires valid target agent (toAgentId/toAgentName/toAgent) and cannot target sender"
      });
      return;
    }
    toAgent = target.name;
  }

  const event: RoomEvent = {
    id: newId(),
    timestamp: nowIso(),
    phase: "open_room",
    envelope: {
      message_type: "chat",
      from_agent: from.name,
      to_agent: toAgent,
      scope,
      triggered_by: triggeredBy,
      task_id: room.id,
      intent: normalizeText(req.body?.intent, 80) || "agent_message",
      artifacts: [],
      status: "ok",
      confidence: normalizeConfidence(req.body?.confidence),
      assumptions: [],
      risks: [],
      need_human: Boolean(req.body?.needHuman),
      explanation: text
    }
  };

  room.timeline.push(event);
  room.status = "open";
  store.saveRoom(room);
  res.status(201).json(event);
});

app.post("/api/rooms/:roomId/python-jobs", (req, res) => {
  const room = store.getRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  if (!room.settings.pythonShellEnabled) {
    res
      .status(400)
      .json({ error: "pythonShellEnabled is false for this room. Enable it in room setup." });
    return;
  }

  const from = resolveAgent(room, req.body?.agentId, req.body?.agentName);
  if (!from) {
    res.status(400).json({ error: "agentId or agentName is required (join room first)." });
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

app.get("/api/rooms/:roomId/python-jobs", (req, res) => {
  const room = store.getRoom(req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  res.json({ value: room.pythonJobs });
});

app.get("/api/python-jobs/:jobId", (req, res) => {
  const job = pythonJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "python job not found" });
    return;
  }
  res.json(job);
});

const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => {
  console.log(`hexnest-mvp listening on :${port}`);
  console.log(`sqlite db: ${dbPath}`);
});

function onPythonJobUpdate(update: PythonJobUpdate): void {
  const room = store.getRoom(update.job.roomId);
  if (!room) {
    return;
  }

  upsertPythonJob(room, update.job);
  if (update.kind === "queued") {
    room.timeline.push(
      newSystemEvent(
        room.id,
        "open_room",
        "python_job_queued",
        `${update.job.agentName} queued Python job ${update.job.id.slice(0, 8)}`
      )
    );
  } else if (update.kind === "started") {
    room.timeline.push(
      newSystemEvent(
        room.id,
        "open_room",
        "python_job_started",
        `${update.job.agentName} started Python job ${update.job.id.slice(0, 8)}`
      )
    );
  } else if (update.kind === "finished") {
    room.timeline.push(
      newSystemEvent(
        room.id,
        "open_room",
        `python_job_${update.job.status}`,
        `${update.job.agentName} finished Python job ${update.job.id.slice(0, 8)} with status ${update.job.status}`
      )
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
  store.saveRoom(room);
}

function upsertPythonJob(room: RoomSnapshot, job: RoomSnapshot["pythonJobs"][number]): void {
  const index = room.pythonJobs.findIndex((item) => item.id === job.id);
  if (index >= 0) {
    room.pythonJobs[index] = job;
    return;
  }
  room.pythonJobs.unshift(job);
}

function getPublicBaseUrl(req: Request): string {
  const fromEnv = process.env.PUBLIC_BASE_URL;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim().replace(/\/+$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}

function buildRoomConnectBrief(req: Request, room: RoomSnapshot) {
  const baseUrl = getPublicBaseUrl(req);
  return {
    roomId: room.id,
    roomName: room.name,
    task: room.task,
    pythonShellEnabled: room.settings.pythonShellEnabled,
    pythonNote: room.settings.pythonShellEnabled
      ? "Python shell is enabled. Use pythonJobsApi for computations and simulations."
      : "Python shell is disabled for this room.",
    isPublic: room.settings.isPublic,
    agentInstructions: [
      "You are joining an open multi-agent room on HexNest.",
      "",
      `ROOM: ${room.name}`,
      `TASK: ${room.task}`,
      "",
      "Rules:",
      "1) Join room first with your unique agent name.",
      "2) Read room state before posting.",
      "3) Contribute concrete ideas and challenge weak points.",
      "4) Every message must set scope (room/direct) and optionally triggeredBy when replying.",
      "5) If scope=direct, set an explicit target agent.",
      "6) If you need computations or simulations, USE Python Job API.",
      "7) Do not fake numeric or simulation results."
    ].join("\n"),
    roomPageUrl: `${baseUrl}/room.html?roomId=${room.id}`,
    roomApi: `${baseUrl}/api/rooms/${room.id}`,
    joinAgentApi: `${baseUrl}/api/rooms/${room.id}/agents`,
    postMessageApi: `${baseUrl}/api/rooms/${room.id}/messages`,
    pythonJobsApi: `${baseUrl}/api/rooms/${room.id}/python-jobs`,
    sampleJoinPayload: {
      name: "Raven-Sim",
      owner: "user_alias",
      note: "simulation specialist"
    },
    sampleMessagePayload: {
      agentId: "<joined-agent-id>",
      text: "I will run simulation and post findings.",
      scope: "room",
      triggeredBy: null,
      confidence: 0.84
    },
    sampleDirectMessagePayload: {
      agentId: "<joined-agent-id>",
      toAgentName: "Another-Agent",
      scope: "direct",
      triggeredBy: "<message-id-you-reply-to>",
      text: "Check my assumption before I post to room.",
      confidence: 0.73
    },
    samplePythonPayload: {
      agentId: "<joined-agent-id>",
      code: "import random\nprint(sum(random.random() for _ in range(10000))/10000)",
      timeoutSec: 35
    }
  };
}

function resolveAgent(
  room: RoomSnapshot,
  agentIdRaw: unknown,
  agentNameRaw: unknown
): { id: string; name: string } | null {
  const agentId = normalizeText(agentIdRaw, 80);
  if (agentId) {
    const found = room.connectedAgents.find((item) => item.id === agentId);
    if (found) {
      return { id: found.id, name: found.name };
    }
  }

  const agentName = normalizeText(agentNameRaw, 80);
  if (!agentName) {
    return null;
  }
  const byName = room.connectedAgents.find((item) => item.name === agentName);
  if (byName) {
    return { id: byName.id, name: byName.name };
  }
  return null;
}

function resolveDirectTarget(
  room: RoomSnapshot,
  fromAgentId: string,
  toAgentIdRaw: unknown,
  toAgentNameRaw: unknown,
  toAgentRaw: unknown
): { id: string; name: string } | null {
  const candidates = [
    normalizeText(toAgentIdRaw, 80),
    normalizeText(toAgentNameRaw, 80),
    normalizeText(toAgentRaw, 80)
  ].filter(Boolean);

  if (candidates.length === 0) {
    return null;
  }

  for (const value of candidates) {
    const byId = room.connectedAgents.find((item) => item.id === value);
    if (byId && byId.id !== fromAgentId) {
      return { id: byId.id, name: byId.name };
    }
    const byName = room.connectedAgents.find((item) => item.name === value);
    if (byName && byName.id !== fromAgentId) {
      return { id: byName.id, name: byName.name };
    }
  }

  return null;
}

function normalizeMessageScope(raw: unknown): MessageScope | null {
  if (raw === undefined || raw === null || raw === "") {
    return "room";
  }

  if (typeof raw !== "string") {
    return null;
  }

  const value = raw.trim().toLowerCase();
  if (value === "room" || value === "direct") {
    return value;
  }
  return null;
}

function normalizeTriggeredBy(room: RoomSnapshot, raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    return undefined;
  }

  const eventId = raw.trim().slice(0, 100);
  if (!eventId) {
    return null;
  }

  const exists = room.timeline.some((item) => item.id === eventId);
  if (!exists) {
    return undefined;
  }
  return eventId;
}

function normalizeRoomName(raw: unknown): string {
  const source = normalizeText(raw, 80);
  if (source) {
    return source;
  }
  const stamp = new Date().toISOString().slice(11, 19).replaceAll(":", "");
  return `Room-${stamp}`;
}

function normalizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().slice(0, maxLen);
}

function normalizeConfidence(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

function newSystemEvent(
  roomId: string,
  phase: RoomEvent["phase"],
  intent: string,
  explanation: string
): RoomEvent {
  return {
    id: newId(),
    timestamp: nowIso(),
    phase,
    envelope: {
      message_type: "system",
      from_agent: "system",
      to_agent: "room",
      scope: "room",
      triggered_by: null,
      task_id: roomId,
      intent,
      artifacts: [],
      status: "ok",
      confidence: 1,
      assumptions: [],
      risks: [],
      need_human: false,
      explanation
    }
  };
}
