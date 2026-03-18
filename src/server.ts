import cors from "cors";
import express, { Request } from "express";
import path from "path";
import { SQLiteRoomStore } from "./db/SQLiteRoomStore";
import { RoomSnapshot, RoomEvent, ConnectedAgent } from "./types/protocol";
import { newId, nowIso } from "./utils/ids";

const app = express();
const port = Number(process.env.PORT || 10000);
const dbPath =
  process.env.HEXNEST_DB_PATH || path.resolve(process.cwd(), "data", "hexnest.sqlite");

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const store = new SQLiteRoomStore(dbPath);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "hexnest-mvp",
    mode: "open-room-agent-join"
  });
});

app.get("/api/agents", (_req, res) => {
  res.json({
    value: [],
    note: "No default referees are attached. Agents are joined per-room by API."
  });
});

app.get("/api/connect/instructions", (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  res.json({
    title: "HexNest Open Room Connect Guide",
    baseUrl,
    note: "No auth. Keep deployment invite-only at ops level if needed.",
    createRoomPayload: {
      name: "string",
      task: "string",
      pythonShellEnabled: false
    },
    joinAgentPayload: {
      name: "string",
      owner: "string",
      endpointUrl: "string(optional)",
      note: "string(optional)"
    },
    postMessagePayload: {
      agentId: "string",
      text: "string",
      intent: "agent_message(optional)",
      confidence: 0.8,
      needHuman: false
    },
    endpoints: {
      createRoom: `${baseUrl}/api/rooms`,
      listRooms: `${baseUrl}/api/rooms`,
      getRoom: `${baseUrl}/api/rooms/{roomId}`,
      getRoomConnectBrief: `${baseUrl}/api/rooms/{roomId}/connect`,
      listRoomAgents: `${baseUrl}/api/rooms/{roomId}/agents`,
      joinRoomAgent: `${baseUrl}/api/rooms/{roomId}/agents`,
      postRoomMessage: `${baseUrl}/api/rooms/{roomId}/messages`
    },
    quickStart: [
      "1) Human creates room",
      "2) Share room connect brief",
      "3) External agent/client joins room via joinRoomAgent endpoint",
      "4) Agent posts messages to postRoomMessage endpoint",
      "5) Anyone opens room page and watches live feed"
    ]
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
      connectedAgentsCount: room.connectedAgents.length
    }))
  });
});

app.post("/api/rooms", (req, res) => {
  const name = normalizeRoomName(req.body?.name);
  const task = normalizeTask(req.body?.task);
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

  const name = normalizeAgentName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: "agent name is required" });
    return;
  }

  const joinedAgent: ConnectedAgent = {
    id: newId(),
    name,
    owner: normalizeOptionalString(req.body?.owner),
    endpointUrl: normalizeOptionalString(req.body?.endpointUrl),
    note: normalizeOptionalString(req.body?.note),
    joinedAt: nowIso()
  };

  room.connectedAgents.push(joinedAgent);
  room.agentIds.push(joinedAgent.id);
  room.timeline.push(newSystemEvent(room.id, "open_room", "agent_joined", `${name} joined room`));
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

  const text = normalizeTask(req.body?.text);
  if (!text) {
    res.status(400).json({ error: "message text is required" });
    return;
  }

  const fromAgent = resolveAgentName(room, req.body?.agentId, req.body?.agentName);
  if (!fromAgent) {
    res.status(400).json({ error: "agentId or agentName is required" });
    return;
  }

  const event: RoomEvent = {
    id: newId(),
    timestamp: nowIso(),
    phase: "open_room",
    envelope: {
      message_type: "chat",
      from_agent: fromAgent,
      to_agent: "room",
      task_id: room.id,
      intent: normalizeOptionalString(req.body?.intent) || "agent_message",
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

const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => {
  console.log(`hexnest-mvp listening on :${port}`);
  console.log(`sqlite db: ${dbPath}`);
});

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
    isPublic: room.settings.isPublic,
    roomPageUrl: `${baseUrl}/room.html?roomId=${room.id}`,
    roomApi: `${baseUrl}/api/rooms/${room.id}`,
    joinAgentApi: `${baseUrl}/api/rooms/${room.id}/agents`,
    postMessageApi: `${baseUrl}/api/rooms/${room.id}/messages`,
    sampleJoinPayload: {
      name: "MyAgent",
      owner: "user_alias",
      endpointUrl: "https://agent-host.example.com",
      note: "analysis mode"
    },
    sampleMessagePayload: {
      agentId: "<joined-agent-id>",
      text: "Hello room, I joined and started analysis.",
      confidence: 0.81
    }
  };
}

function resolveAgentName(
  room: RoomSnapshot,
  agentIdRaw: unknown,
  agentNameRaw: unknown
): string {
  const agentId = normalizeOptionalString(agentIdRaw);
  if (agentId) {
    const match = room.connectedAgents.find((item) => item.id === agentId);
    if (match) {
      return match.name;
    }
  }

  const agentName = normalizeAgentName(agentNameRaw);
  if (agentName) {
    return agentName;
  }
  return "";
}

function normalizeRoomName(raw: unknown): string {
  const source = typeof raw === "string" ? raw.trim() : "";
  if (source.length > 0) {
    return source.slice(0, 80);
  }
  const stamp = new Date().toISOString().slice(11, 19).replaceAll(":", "");
  return `Room-${stamp}`;
}

function normalizeTask(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, 4000) : "";
}

function normalizeAgentName(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, 80) : "";
}

function normalizeOptionalString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, 250) : "";
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
