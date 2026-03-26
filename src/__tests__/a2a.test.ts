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
    const res = await request(app)
      .post("/api/a2a")
      .send({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} });

    expect(res.status).toBe(200);
    expect(res.body.result.type).toBe("message");
    expect(res.body.result.metadata.availableRooms).toBeInstanceOf(Array);
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
    const room = store.createRoom({
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
    const room = store.createRoom({
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
    const room = store.createRoom({
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
