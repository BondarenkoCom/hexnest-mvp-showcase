import express from "express";
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";
import { createA2ARouter } from "../routes/a2a";
import { tempDbPath } from "./helpers";

function buildApp(store: SQLiteRoomStore): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api", createA2ARouter(store));
  return app;
}

describe("POST /api/a2a", () => {
  let store: SQLiteRoomStore;
  let app: express.Application;

  beforeEach(() => {
    store = new SQLiteRoomStore(tempDbPath());
    app = buildApp(store);
  });

  it("GET /api/a2a returns machine-readable method catalog", async () => {
    const res = await request(app).get("/api/a2a");

    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe("2.0");
    expect(res.body.methods).toBeDefined();
    expect(res.body.methods["message/send"]).toBeDefined();
  });

  // ── JSON-RPC validation ──

  it("returns -32600 for missing jsonrpc field", async () => {
    const res = await request(app)
      .post("/api/a2a")
      .send({ method: "message/send", params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32600);
  });

  it("returns -32600 for missing method field", async () => {
    const res = await request(app)
      .post("/api/a2a")
      .send({ jsonrpc: "2.0", params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32600);
  });

  it("returns -32601 for unknown method", async () => {
    const res = await request(app)
      .post("/api/a2a")
      .send({ jsonrpc: "2.0", id: 1, method: "rooms/list", params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32601);
  });

  it("preserves the request id in the response", async () => {
    const res = await request(app)
      .post("/api/a2a")
      .send({ jsonrpc: "2.0", id: "req-42", method: "unknown", params: {} });

    expect(res.body.id).toBe("req-42");
  });

  // ── message/send ──

  it("message/send without roomId returns available rooms list", async () => {
    const room = await store.createRoom({
      name: "Count Room",
      task: "count messages",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: false,
      subnest: "general"
    });
    room.timeline.push({
      id: "msg-1",
      timestamp: new Date().toISOString(),
      phase: "open_room",
      envelope: {
        message_type: "chat",
        from_agent: "Aya-9X",
        to_agent: "room",
        scope: "room",
        triggered_by: null,
        task_id: room.id,
        intent: "test",
        artifacts: [],
        status: "ok",
        confidence: 0.8,
        assumptions: [],
        risks: [],
        need_human: false,
        explanation: "hello"
      }
    });
    await store.saveRoom(room);

    const res = await request(app)
      .post("/api/a2a")
      .send({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.result.type).toBe("message");
    expect(res.body.result.metadata.availableRooms).toBeInstanceOf(Array);
    expect(res.body.result.metadata.availableRooms[0].messages).toBeGreaterThan(0);
  });

  it("message/send with unknown roomId returns -32602 error", async () => {
    const res = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { roomId: "no-such-room", text: "hello" } },
    });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32602);
    expect(res.body.result).toBeUndefined();
  });

  it("message/send posts a message and returns completed status", async () => {
    const room = await store.createRoom({
      name: "Test Room",
      task: "debate something",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: false,
      subnest: "general",
    });

    const res = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: 2,
      method: "message/send",
      params: {
        message: {
          roomId: room.id,
          agentName: "TestBot",
          text: "Hello room!",
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe("completed");
    expect(res.body.result.metadata.roomId).toBe(room.id);
    expect(res.body.result.metadata.agentName).toBe("TestBot");
  });

  it("message/send without text joins room instead of posting", async () => {
    const room = await store.createRoom({
      name: "Join Room",
      task: "debate something",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: false,
      subnest: "general",
    });

    const res = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: 3,
      method: "message/send",
      params: {
        message: {
          roomId: room.id,
          agentName: "Lurker",
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe("completed");
    expect(res.body.result.metadata.agentName).toBe("Lurker");
  });

  it("message/send reuses identity by agentId and does not create duplicates", async () => {
    const room = await store.createRoom({
      name: "Identity Room",
      task: "check identity",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: false,
      subnest: "general"
    });

    const first = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: "join-1",
      method: "message/send",
      params: {
        message: {
          roomId: room.id,
          agentId: "agent-007",
          agentName: "Aya",
          text: "hello"
        }
      }
    });

    expect(first.status).toBe(200);
    expect(first.body.result.metadata.agentId).toBe("agent-007");

    const second = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: "join-2",
      method: "message/send",
      params: {
        message: {
          roomId: room.id,
          agentId: "agent-007",
          agentName: "Aya-Renamed",
          text: "second"
        }
      }
    });

    expect(second.status).toBe(200);
    expect(second.body.result.metadata.agentId).toBe("agent-007");

    const roomState = await store.getRoom(room.id);
    expect(roomState?.connectedAgents).toHaveLength(1);
    expect(roomState?.connectedAgents[0].id).toBe("agent-007");
  });

  it("message/send applies direct routing fields", async () => {
    const room = await store.createRoom({
      name: "Direct Room",
      task: "direct route",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: false,
      subnest: "general"
    });

    room.connectedAgents.push({
      id: "target-1",
      name: "TargetAgent",
      owner: "test",
      endpointUrl: "",
      note: "",
      joinedAt: new Date().toISOString()
    });
    await store.saveRoom(room);

    const res = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: "direct-1",
      method: "message/send",
      params: {
        message: {
          roomId: room.id,
          agentId: "sender-1",
          agentName: "Sender",
          scope: "direct",
          toAgentName: "TargetAgent",
          text: "private ping"
        }
      }
    });

    expect(res.status).toBe(200);
    expect(res.body.result.metadata.scope).toBe("direct");
    expect(res.body.result.metadata.toAgent).toBe("TargetAgent");

    const roomState = await store.getRoom(room.id);
    const chat = roomState?.timeline.find((event) => event.envelope.explanation === "private ping");
    expect(chat?.envelope.scope).toBe("direct");
    expect(chat?.envelope.to_agent).toBe("TargetAgent");
  });

  // ── tasks/send ──

  it("tasks/send without description returns -32602 error", async () => {
    const res = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: 4,
      method: "tasks/send",
      params: { task: { name: "Test" } },
    });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32602);
  });

  it("tasks/send with unknown subnest returns -32602 error", async () => {
    const res = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: 5,
      method: "tasks/send",
      params: {
        task: {
          description: "Debate topic",
          subnest: "nonexistent-subnest",
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32602);
  });

  it("tasks/send rejects string booleans", async () => {
    const res = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: 55,
      method: "tasks/send",
      params: {
        task: {
          description: "strict booleans",
          pythonShellEnabled: "true"
        }
      }
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32602);
  });

  it("tasks/send creates a room and returns completed status", async () => {
    const res = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: 6,
      method: "tasks/send",
      params: {
        task: {
          name: "New Debate",
          description: "Topic for debate goes here",
          subnest: "ai",
        },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe("completed");
    expect(res.body.result.metadata.roomId).toBeTruthy();
    expect(res.body.result.metadata.roomName).toBeTruthy();
    expect(res.body.result.metadata.task).toBeDefined();
  });

  // ── tasks/get ──

  it("tasks/get with unknown roomId returns -32602 error", async () => {
    const res = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: 7,
      method: "tasks/get",
      params: { id: "no-such-room" },
    });

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32602);
  });

  it("tasks/get returns room state for a known room", async () => {
    const room = await store.createRoom({
      name: "Known Room",
      task: "a task",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: false,
      subnest: "general",
    });

    const res = await request(app).post("/api/a2a").send({
      jsonrpc: "2.0",
      id: 8,
      method: "tasks/get",
      params: { id: room.id },
    });

    expect(res.status).toBe(200);
    expect(res.body.result.id).toBe(room.id);
    expect(res.body.result.status).toBeDefined();
  });
});
