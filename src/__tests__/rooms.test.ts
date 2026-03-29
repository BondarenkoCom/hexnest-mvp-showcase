import express from "express";
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";
import { createRoomsRouter } from "../routes/rooms";
import { tempDbPath } from "./helpers";
import { upsertSpectator } from "../utils/spectators";

function buildApp(store: SQLiteRoomStore): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api", createRoomsRouter(store));
  return app;
}

describe("GET /api/health", () => {
  it("returns ok: true", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const res = await request(buildApp(store)).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe("hexnest-mvp");
  });
});

describe("GET /api/stats", () => {
  it("returns zero counts for empty store", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const res = await request(buildApp(store)).get("/api/stats");
    expect(res.status).toBe(200);
    expect(res.body.totalRooms).toBe(0);
    expect(res.body.totalMessages).toBe(0);
    expect(typeof res.body.totalAgents).toBe("number");
  });
});

describe("POST /api/rooms", () => {
  let store: SQLiteRoomStore;
  let app: express.Application;

  beforeEach(() => {
    store = new SQLiteRoomStore(tempDbPath());
    app = buildApp(store);
  });

  it("returns 400 when task is missing", async () => {
    const res = await request(app).post("/api/rooms").send({ name: "Test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/task/i);
  });

  it("returns 400 for unknown subnest", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .send({ task: "debate", subnest: "not-a-real-subnest" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/subnest/i);
  });

  it("creates room with valid payload and returns 201", async () => {
    const res = await request(app).post("/api/rooms").send({
      name: "My Room",
      task: "Debate AI",
      subnest: "ai",
      pythonShellEnabled: true,
      webSearchEnabled: false,
      marketDataEnabled: true
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe("My Room");
    expect(res.body.task).toBe("Debate AI");
    expect(res.body.subnest).toBe("ai");
    expect(res.body.settings?.marketDataEnabled).toBe(true);
  });

  it("rejects string booleans for room settings", async () => {
    const res = await request(app).post("/api/rooms").send({
      task: "Debate AI",
      pythonShellEnabled: "true"
    });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/boolean/i);
  });

  it("rejects non-boolean marketDataEnabled", async () => {
    const res = await request(app).post("/api/rooms").send({
      task: "Debate AI",
      marketDataEnabled: "yes"
    });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/marketDataEnabled/i);
  });

  it("auto-generates a room name when name is omitted", async () => {
    const res = await request(app).post("/api/rooms").send({ task: "Some task" });
    expect(res.status).toBe(201);
    expect(res.body.name).toMatch(/^Room-/);
  });
});

describe("GET /api/rooms", () => {
  it("returns value array", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const res = await request(buildApp(store)).get("/api/rooms");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.value)).toBe(true);
  });

  it("lists created rooms", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    await store.createRoom({ name: "R1", task: "t1", agentIds: [], pythonShellEnabled: false, webSearchEnabled: false, subnest: "general" });
    await store.createRoom({ name: "R2", task: "t2", agentIds: [], pythonShellEnabled: false, webSearchEnabled: false, subnest: "general" });
    const res = await request(buildApp(store)).get("/api/rooms");
    expect(res.body.value).toHaveLength(2);
  });

  it("applies limit query parameter", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    await store.createRoom({ name: "R1", task: "t1", agentIds: [], pythonShellEnabled: false, webSearchEnabled: false, subnest: "general" });
    await store.createRoom({ name: "R2", task: "t2", agentIds: [], pythonShellEnabled: false, webSearchEnabled: false, subnest: "general" });
    const res = await request(buildApp(store)).get("/api/rooms?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.value).toHaveLength(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.hasMore).toBe(true);
  });

  it("returns pythonJobsCount from aggregate even in list mode", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const room = await store.createRoom({
      name: "Jobs Room",
      task: "jobs",
      agentIds: [],
      pythonShellEnabled: true,
      webSearchEnabled: false,
      subnest: "general"
    });
    room.pythonJobs.push({
      id: "job-1",
      roomId: room.id,
      agentId: "agent-1",
      agentName: "Agent",
      status: "done",
      code: "print(1)",
      createdAt: new Date().toISOString(),
      timeoutSec: 10,
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      stdout: "1"
    });
    await store.saveRoom(room);

    const res = await request(buildApp(store)).get("/api/rooms?limit=10");
    expect(res.status).toBe(200);
    expect(res.body.value[0].pythonJobsCount).toBe(1);
  });
});

describe("GET /api/rooms/:roomId", () => {
  it("returns 404 for unknown room", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const res = await request(buildApp(store)).get("/api/rooms/room-does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("room not found");
  });

  it("returns room for known id", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const room = await store.createRoom({ name: "Visible", task: "task", agentIds: [], pythonShellEnabled: false, webSearchEnabled: false, subnest: "general" });
    const res = await request(buildApp(store)).get(`/api/rooms/${room.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(room.id);
  });
});

describe("POST /api/rooms/:roomId/agents", () => {
  let store: SQLiteRoomStore;
  let app: express.Application;
  let roomId: string;

  beforeEach(async () => {
    store = new SQLiteRoomStore(tempDbPath());
    app = buildApp(store);
    const room = await store.createRoom({ name: "R", task: "t", agentIds: [], pythonShellEnabled: false, webSearchEnabled: false, subnest: "general" });
    roomId = room.id;
  });

  it("returns 404 for unknown room", async () => {
    const res = await request(app).post("/api/rooms/no-room/agents").send({ name: "Bot" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when agent name is missing", async () => {
    const res = await request(app).post(`/api/rooms/${roomId}/agents`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("joins agent and returns 201", async () => {
    const res = await request(app).post(`/api/rooms/${roomId}/agents`).send({ name: "AgentX" });
    expect(res.status).toBe(201);
    expect(res.body.joinedAgent.name).toBe("AgentX");
    expect(res.body.roomId).toBe(roomId);
  });

  it("rejects invalid endpointUrl", async () => {
    const res = await request(app)
      .post(`/api/rooms/${roomId}/agents`)
      .send({ name: "AgentX", endpointUrl: "not-a-url" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/url/i);
  });

  it("returns ok:true with alreadyJoined when agent joins twice", async () => {
    await request(app).post(`/api/rooms/${roomId}/agents`).send({ name: "AgentX" });
    const res = await request(app).post(`/api/rooms/${roomId}/agents`).send({ name: "AgentX" });
    expect(res.status).toBe(200);
    expect(res.body.alreadyJoined).toBe(true);
  });
});

describe("POST /api/rooms/:roomId/messages", () => {
  let store: SQLiteRoomStore;
  let app: express.Application;
  let roomId: string;
  let agentId: string;

  beforeEach(async () => {
    store = new SQLiteRoomStore(tempDbPath());
    app = buildApp(store);
    const room = await store.createRoom({ name: "R", task: "t", agentIds: [], pythonShellEnabled: false, webSearchEnabled: false, subnest: "general" });
    roomId = room.id;

    const agentRes = await request(app)
      .post(`/api/rooms/${roomId}/agents`)
      .send({ name: "Speaker" });
    agentId = agentRes.body.joinedAgent.id;
  });

  it("returns 404 for unknown room", async () => {
    const res = await request(app)
      .post("/api/rooms/no-room/messages")
      .send({ agentId, text: "hello" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when text is missing", async () => {
    const res = await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ agentId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it("returns 400 when agentId and agentName are both missing", async () => {
    const res = await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ text: "hello" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agentId/i);
  });

  it("returns 403 when agent is not in the room", async () => {
    const res = await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ agentId: "wrong-id", text: "hello" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/agent not found/i);
  });

  it("posts message and returns 201 with event", async () => {
    const res = await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ agentId, text: "Hello world!" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.envelope.explanation).toBe("Hello world!");
    expect(res.body.envelope.from_agent).toBe("Speaker");
  });

  it("message appears in GET /api/rooms/:id/messages", async () => {
    await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ agentId, text: "Test message" });

    const res = await request(app).get(`/api/rooms/${roomId}/messages`);
    expect(res.status).toBe(200);
    const texts = res.body.messages.map((m: { text: string }) => m.text);
    expect(texts).toContain("Test message");
  });

  it("rejects non-boolean needHuman", async () => {
    const res = await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ agentId, text: "hello", needHuman: "true" });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/boolean/i);
  });

  it("filters messages by scope=direct|room", async () => {
    const secondAgent = await request(app)
      .post(`/api/rooms/${roomId}/agents`)
      .send({ name: "Listener" });

    await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ agentId, text: "public", scope: "room" });

    await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({
        agentId,
        text: "private",
        scope: "direct",
        toAgentId: secondAgent.body.joinedAgent.id
      });

    const directRes = await request(app).get(`/api/rooms/${roomId}/messages?scope=direct`);
    expect(directRes.status).toBe(200);
    expect(directRes.body.messages).toHaveLength(1);
    expect(directRes.body.messages[0].scope).toBe("direct");

    const roomRes = await request(app).get(`/api/rooms/${roomId}/messages?scope=room`);
    expect(roomRes.status).toBe(200);
    const roomTexts = roomRes.body.messages.map((m: { text: string }) => m.text);
    expect(roomTexts).toContain("public");
    expect(roomTexts).not.toContain("private");
  });
});

describe("POST /api/rooms/:roomId/messages/:messageId/share", () => {
  let store: SQLiteRoomStore;
  let app: express.Application;
  let roomId: string;
  let messageId: string;

  beforeEach(async () => {
    store = new SQLiteRoomStore(tempDbPath());
    app = buildApp(store);
    const room = await store.createRoom({
      name: "Share Room",
      task: "share test",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: false,
      subnest: "general"
    });
    roomId = room.id;

    const agentRes = await request(app)
      .post(`/api/rooms/${roomId}/agents`)
      .send({ name: "Aya-9X" });

    const messageRes = await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ agentId: agentRes.body.joinedAgent.id, text: "Shareable thought." });

    messageId = messageRes.body.id;
  });

  it("creates a short share link for a message", async () => {
    const res = await request(app).post(`/api/rooms/${roomId}/messages/${messageId}/share`);
    expect(res.status).toBe(200);
    expect(res.body.shortCode).toBe(messageId.slice(0, 8));
    expect(res.body.url).toMatch(new RegExp(`/s/${messageId.slice(0, 8)}$`));
  });

  it("returns the existing link when sharing the same message twice", async () => {
    const first = await request(app).post(`/api/rooms/${roomId}/messages/${messageId}/share`);
    const second = await request(app).post(`/api/rooms/${roomId}/messages/${messageId}/share`);

    expect(second.status).toBe(200);
    expect(second.body.shortCode).toBe(first.body.shortCode);
    expect(second.body.url).toBe(first.body.url);
  });
});

describe("GET /api/rooms/:roomId/stats", () => {
  it("returns room message, share, viewer, and agent stats", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const app = buildApp(store);
    const room = await store.createRoom({
      name: "Stats Room",
      task: "count everything",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: false,
      subnest: "general"
    });

    const speaker = await request(app)
      .post(`/api/rooms/${room.id}/agents`)
      .send({ name: "Aya-9X" });

    const message = await request(app)
      .post(`/api/rooms/${room.id}/messages`)
      .send({ agentId: speaker.body.joinedAgent.id, text: "Numbers matter." });

    await request(app).post(`/api/rooms/${room.id}/messages/${message.body.id}/share`);
    upsertSpectator(room.id, "spectator-a");
    upsertSpectator(room.id, "spectator-b");

    const res = await request(app).get(`/api/rooms/${room.id}/stats`);
    expect(res.status).toBe(200);
    expect(res.body.agents).toBe(1);
    expect(res.body.agentNames).toEqual(["Aya-9X"]);
    expect(res.body.totalMessages).toBe(1);
    expect(res.body.totalShares).toBe(1);
    expect(res.body.totalViewers).toBe(2);
    expect(res.body.lastActivity).toBe(message.body.timestamp);
  });
});

describe("GET /api/discover", () => {
  it("returns count and rooms array", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const app = buildApp(store);
    const res = await request(app).get("/api/discover");
    expect(res.status).toBe(200);
    expect(typeof res.body.count).toBe("number");
    expect(Array.isArray(res.body.rooms)).toBe(true);
  });

  it("filters by query string q", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    await store.createRoom({ name: "Blockchain debate", task: "pros and cons of blockchain", agentIds: [], pythonShellEnabled: false, webSearchEnabled: false, subnest: "general" });
    await store.createRoom({ name: "Other room", task: "something else entirely", agentIds: [], pythonShellEnabled: false, webSearchEnabled: false, subnest: "general" });
    const app = buildApp(store);

    const res = await request(app).get("/api/discover?q=blockchain");
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    const names = res.body.rooms.map((r: { name: string }) => r.name);
    expect(names).toContain("Blockchain debate");
  });
});
