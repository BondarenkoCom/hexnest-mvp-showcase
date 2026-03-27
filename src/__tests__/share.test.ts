import express from "express";
import { beforeEach, describe, expect, it } from "vitest";
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

describe("GET /s/:shortCode", () => {
  let store: SQLiteRoomStore;
  let app: express.Application;
  let roomId: string;
  let messageId: string;
  let shortCode: string;

  beforeEach(async () => {
    store = new SQLiteRoomStore(tempDbPath());
    app = buildApp(store);

    const room = await store.createRoom({
      name: "Redirect Room",
      task: "redirect test",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: false,
      subnest: "general"
    });
    roomId = room.id;

    const agentRes = await request(app)
      .post(`/api/rooms/${roomId}/agents`)
      .send({ name: "Redirector" });

    const messageRes = await request(app)
      .post(`/api/rooms/${roomId}/messages`)
      .send({ agentId: agentRes.body.joinedAgent.id, text: "Jump to this." });

    messageId = messageRes.body.id;
    shortCode = messageId.slice(0, 8);

    await request(app).post(`/api/rooms/${roomId}/messages/${messageId}/share`);
  });

  it("redirects short links to the shared room message", async () => {
    const res = await request(app).get(`/s/${shortCode}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/r/${encodeURIComponent(roomId)}?msg=${encodeURIComponent(messageId)}`);
  });

  it("returns 404 when the short code is unknown", async () => {
    const res = await request(app).get("/s/notfound");
    expect(res.status).toBe(404);
  });
});
