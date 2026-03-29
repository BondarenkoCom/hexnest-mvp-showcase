import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";
import { createApiJsonParseErrorHandler, createApiResponseMiddleware } from "../middleware/api-response";
import { createWriteRateLimitMiddleware } from "../middleware/rate-limit";
import { createA2ARouter } from "../routes/a2a";
import { createApiDocsRouter } from "../routes/api-docs";
import { createJobsRouter } from "../routes/jobs";
import { createRoomsRouter } from "../routes/rooms";
import { PythonJob } from "../types/protocol";
import { tempDbPath } from "./helpers";

function buildApiApp(store: SQLiteRoomStore, runtimeJobs: PythonJob[] = []): express.Application {
  const app = express();
  app.use(express.json());
  app.use(createApiJsonParseErrorHandler());
  app.use("/api", createApiResponseMiddleware());
  app.use("/api", createWriteRateLimitMiddleware());

  const fakePythonManager = {
    submit: vi.fn(),
    listByRoom: vi.fn((roomId: string) => runtimeJobs.filter((item) => item.roomId === roomId)),
    get: vi.fn((jobId: string) => runtimeJobs.find((item) => item.id === jobId))
  };

  const fakeWebSearchManager = {
    submit: vi.fn(),
    listByRoom: vi.fn(() => []),
    get: vi.fn(() => undefined)
  };

  app.use(createApiDocsRouter());
  app.post("/api/_write_test", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api", createRoomsRouter(store));
  app.use("/api", createJobsRouter(store, fakePythonManager as any, fakeWebSearchManager as any));
  app.use("/api", createA2ARouter(store));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "api endpoint not found" });
  });
  app.get("*", (_req, res) => {
    res.type("html").send("<html><body>fallback</body></html>");
  });

  return app;
}

afterEach(() => {
  delete process.env.HEXNEST_WRITE_RATE_LIMIT_MAX;
  delete process.env.HEXNEST_WRITE_RATE_LIMIT_WINDOW_MS;
  delete process.env.HEXNEST_WRITE_RATE_LIMIT_ENABLED;
});

describe("API docs and fallback behavior", () => {
  it("/openapi.json returns JSON spec and does not fall back to HTML", async () => {
    const app = buildApiApp(new SQLiteRoomStore(tempDbPath()));
    const res = await request(app).get("/openapi.json");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/i);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.paths["/api/a2a"]).toBeDefined();
  });

  it("OpenAPI aliases return JSON spec", async () => {
    const app = buildApiApp(new SQLiteRoomStore(tempDbPath()));

    const apiAlias = await request(app).get("/api/openapi.json");
    expect(apiAlias.status).toBe(200);
    expect(apiAlias.headers["content-type"]).toMatch(/application\/json/i);
    expect(apiAlias.body.openapi).toBe("3.1.0");

    const wellKnownAlias = await request(app).get("/.well-known/openapi.json");
    expect(wellKnownAlias.status).toBe(200);
    expect(wellKnownAlias.headers["content-type"]).toMatch(/application\/json/i);
    expect(wellKnownAlias.body.openapi).toBe("3.1.0");
  });

  it("/api/docs returns machine-readable docs JSON", async () => {
    const app = buildApiApp(new SQLiteRoomStore(tempDbPath()));
    const res = await request(app).get("/api/docs");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/i);
    expect(res.body.openapi).toMatch(/\/openapi\.json$/);
    expect(res.body.jsonrpc.methods["message/send"]).toBeDefined();
  });

  it("unknown /api route returns JSON 404 instead of HTML fallback", async () => {
    const app = buildApiApp(new SQLiteRoomStore(tempDbPath()));
    const res = await request(app).get("/api/not-found");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/i);
    expect(res.body.error).toBe("api endpoint not found");
  });
});

describe("API middleware hardening", () => {
  it("returns structured 400 for invalid JSON payload", async () => {
    const app = buildApiApp(new SQLiteRoomStore(tempDbPath()));
    const res = await request(app)
      .post("/api/rooms")
      .set("Content-Type", "application/json")
      .send('{"task":"bad-json"');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid JSON body");
    expect(res.body.code).toBe("invalid_json");
    expect(typeof res.body.requestId).toBe("string");
  });

  it("adds consistent error envelope metadata on API validation errors", async () => {
    const app = buildApiApp(new SQLiteRoomStore(tempDbPath()));
    const res = await request(app).get("/api/rooms?limit=oops");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/limit/i);
    expect(res.body.code).toBe("validation_error");
    expect(res.body.status).toBe(400);
    expect(typeof res.body.requestId).toBe("string");
  });

  it("rate-limits write endpoints", async () => {
    process.env.HEXNEST_WRITE_RATE_LIMIT_MAX = "2";
    process.env.HEXNEST_WRITE_RATE_LIMIT_WINDOW_MS = "60000";

    const app = buildApiApp(new SQLiteRoomStore(tempDbPath()));
    await request(app).post("/api/_write_test").send({});
    await request(app).post("/api/_write_test").send({});
    const third = await request(app).post("/api/_write_test").send({});

    expect(third.status).toBe(429);
    expect(third.body.code).toBe("rate_limited");
    expect(typeof third.body.retryAfterSec).toBe("number");
  });
});

describe("Python job status reconciliation", () => {
  it("reconciles stale persisted running status with runtime terminal status", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const room = await store.createRoom({
      name: "Recon",
      task: "reconcile",
      agentIds: [],
      pythonShellEnabled: true,
      webSearchEnabled: false,
      subnest: "general"
    });

    room.pythonJobs.push({
      id: "job-stale",
      roomId: room.id,
      agentId: "agent-1",
      agentName: "Agent",
      status: "running",
      code: "print(1)",
      createdAt: "2026-03-29T00:00:00.000Z",
      startedAt: "2026-03-29T00:00:01.000Z",
      timeoutSec: 30
    });
    await store.saveRoom(room);

    const app = buildApiApp(store, [
      {
        id: "job-stale",
        roomId: room.id,
        agentId: "agent-1",
        agentName: "Agent",
        status: "done",
        code: "print(1)",
        createdAt: "2026-03-29T00:00:00.000Z",
        startedAt: "2026-03-29T00:00:01.000Z",
        finishedAt: "2026-03-29T00:00:02.000Z",
        timeoutSec: 30,
        exitCode: 0,
        stdout: "1"
      }
    ]);

    const res = await request(app).get(`/api/rooms/${room.id}/python-jobs`);
    expect(res.status).toBe(200);
    expect(res.body.value[0].status).toBe("done");

    const persisted = await store.getRoom(room.id);
    expect(persisted?.pythonJobs[0].status).toBe("done");
  });
});
