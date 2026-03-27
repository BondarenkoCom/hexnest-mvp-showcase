import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";
import { createRoomsRouter } from "../routes/rooms";
import { createShareRouter } from "../routes/share";
import { tempDbPath } from "./helpers";

function buildApp(store: SQLiteRoomStore): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api", createRoomsRouter(store));
  app.use(createShareRouter(store));
  return app;
}

describe("admin room deletion API", () => {
  const adminSecret = "test-admin-secret";
  const originalAdminSecret = process.env.HEXNEST_ADMIN_SECRET;

  let store: SQLiteRoomStore;
  let app: express.Application;
  let roomId: string;
  let firstMessageId: string;
  let secondMessageId: string;
  let shortCode: string;

  beforeEach(async () => {
    process.env.HEXNEST_ADMIN_SECRET = adminSecret;
    store = new SQLiteRoomStore(tempDbPath());
    app = buildApp(store);

    const room = await store.createRoom({
      name: "Admin Room",
      task: "admin controls",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: false,
      subnest: "general"
    });
    roomId = room.id;

    const agentRes = await request(app)
      .post(`/api/rooms/${roomId}/agents`)
      .send({ name: "ModeratorBot" });

    const firstMessage = await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ agentId: agentRes.body.joinedAgent.id, text: "First message" });

    const secondMessage = await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ agentId: agentRes.body.joinedAgent.id, text: "Second message" });

    firstMessageId = firstMessage.body.id;
    secondMessageId = secondMessage.body.id;

    const shareRes = await request(app).post(`/api/rooms/${roomId}/messages/${firstMessageId}/share`);
    shortCode = shareRes.body.shortCode;
  });

  afterEach(() => {
    if (originalAdminSecret === undefined) {
      delete process.env.HEXNEST_ADMIN_SECRET;
      return;
    }
    process.env.HEXNEST_ADMIN_SECRET = originalAdminSecret;
  });

  it("deletes a room and removes its short links", async () => {
    const res = await request(app)
      .delete(`/api/rooms/${roomId}`)
      .set("x-admin-secret", adminSecret);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      deleted: "room",
      roomId
    });
    expect(await store.getRoom(roomId)).toBeUndefined();

    const shareRedirect = await request(app).get(`/s/${shortCode}`);
    expect(shareRedirect.status).toBe(404);
  });

  it("deletes a single message and leaves the rest of the timeline intact", async () => {
    const res = await request(app)
      .delete(`/api/rooms/${roomId}/messages/${firstMessageId}`)
      .set("x-admin-secret", adminSecret);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      deleted: "message",
      messageId: firstMessageId,
      roomId
    });

    const room = await store.getRoom(roomId);
    expect(room).toBeDefined();
    expect(room?.timeline.some((event: { id: string }) => event.id === firstMessageId)).toBe(false);
    expect(room?.timeline.some((event: { id: string }) => event.id === secondMessageId)).toBe(true);

    const shareRedirect = await request(app).get(`/s/${shortCode}`);
    expect(shareRedirect.status).toBe(404);
  });

  it("clears the timeline but keeps the room", async () => {
    const initialCount = (await store.getRoom(roomId))?.timeline.length || 0;

    const res = await request(app)
      .delete(`/api/rooms/${roomId}/messages`)
      .set("x-admin-secret", adminSecret);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      deleted: "all_messages",
      roomId,
      count: initialCount
    });

    const room = await store.getRoom(roomId);
    expect(room).toBeDefined();
    expect(room?.timeline).toEqual([]);

    const shareRedirect = await request(app).get(`/s/${shortCode}`);
    expect(shareRedirect.status).toBe(404);
  });

  it("returns 401 when the admin secret is missing or wrong", async () => {
    const missing = await request(app).delete(`/api/rooms/${roomId}`);
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe("unauthorized");

    const wrong = await request(app)
      .delete(`/api/rooms/${roomId}`)
      .set("x-admin-secret", "wrong-secret");
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("unauthorized");
  });

  it("returns 404 for a non-existent room", async () => {
    const res = await request(app)
      .delete("/api/rooms/not-a-room")
      .set("x-admin-secret", adminSecret);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("room not found");
  });
});
