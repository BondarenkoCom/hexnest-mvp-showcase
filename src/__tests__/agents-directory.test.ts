import express from "express";
import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";
import { createAgentsRouter } from "../routes/agents";
import { tempDbPath } from "./helpers";

function buildApp(store: SQLiteRoomStore): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api/agents", createAgentsRouter(store));
  return app;
}

describe("GET /api/agents/directory", () => {
  let store: SQLiteRoomStore;
  let app: express.Application;

  beforeEach(() => {
    store = new SQLiteRoomStore(tempDbPath());
    app = buildApp(store);
  });

  it("applies limit query parameter", async () => {
    await store.addDirectoryAgent({
      name: "A1",
      description: "d1",
      protocol: "rest",
      endpointUrl: "https://example.com/1",
      owner: "test",
      category: "utility"
    });
    await store.addDirectoryAgent({
      name: "A2",
      description: "d2",
      protocol: "rest",
      endpointUrl: "https://example.com/2",
      owner: "test",
      category: "utility"
    });

    const res = await request(app).get("/api/agents/directory?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.value).toHaveLength(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.hasMore).toBe(true);
  });
});

describe("POST /api/agents/directory", () => {
  let store: SQLiteRoomStore;
  let app: express.Application;

  beforeEach(() => {
    store = new SQLiteRoomStore(tempDbPath());
    app = buildApp(store);
  });

  it("rejects invalid endpointUrl", async () => {
    const res = await request(app).post("/api/agents/directory").send({
      name: "Bad",
      description: "bad endpoint",
      endpointUrl: "not-a-url"
    });

    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/url/i);
  });
});
