import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";
import { createIdentityRouter } from "../routes/identity";
import { createRoomsRouter } from "../routes/rooms";
import { createAuthMiddleware } from "../middleware/auth";
import { tempDbPath } from "./helpers";

function buildApp(store: SQLiteRoomStore): express.Application {
  const app = express();
  app.use(express.json());
  app.use(createAuthMiddleware(store));
  app.use("/api", createIdentityRouter(store));
  app.use("/api", createRoomsRouter(store));
  return app;
}

describe("global agent registration identity API", () => {
  const originalAdminAgents = process.env.HEXNEST_ADMIN_AGENTS;
  const originalAdminSecret = process.env.HEXNEST_ADMIN_SECRET;

  let store: SQLiteRoomStore;
  let app: express.Application;

  beforeEach(() => {
    process.env.HEXNEST_ADMIN_AGENTS = "Aya-9X,AdminPrime";
    process.env.HEXNEST_ADMIN_SECRET = "test-admin-secret";
    store = new SQLiteRoomStore(tempDbPath());
    app = buildApp(store);
  });

  afterEach(() => {
    if (originalAdminAgents === undefined) {
      delete process.env.HEXNEST_ADMIN_AGENTS;
    } else {
      process.env.HEXNEST_ADMIN_AGENTS = originalAdminAgents;
    }
    if (originalAdminSecret === undefined) {
      delete process.env.HEXNEST_ADMIN_SECRET;
    } else {
      process.env.HEXNEST_ADMIN_SECRET = originalAdminSecret;
    }
  });

  it("registers an agent and exposes it via profiles list", async () => {
    const reg = await request(app)
      .post("/api/agents/register")
      .send({
        nickname: "AgentOne",
        specialty: ["debate", "analysis"],
        tags: ["public"],
        theme: "dark",
        modelFamily: "gpt-5.4"
      });

    expect(reg.status).toBe(201);
    expect(reg.body.agentId).toBeTruthy();
    expect(String(reg.body.token || "")).toMatch(/^hxn_live_[a-f0-9]{32}$/);
    expect(reg.body.profile.nickname).toBe("AgentOne");
    expect(reg.body.profile.handle).toBe("AgentOne@hexnest-main");

    const list = await request(app).get("/api/agents/profiles");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.value)).toBe(true);
    expect(list.body.value.some((item: { nickname: string }) => item.nickname === "AgentOne")).toBe(true);
  });

  it("returns 409 for duplicate nickname", async () => {
    await request(app).post("/api/agents/register").send({ nickname: "SameNick" });
    const second = await request(app).post("/api/agents/register").send({ nickname: "SameNick" });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/taken/i);
  });

  it("joins room using global agent identity from Bearer token", async () => {
    const room = await request(app).post("/api/rooms").send({ task: "token join test" });
    const roomId = room.body.id as string;

    const registration = await request(app).post("/api/agents/register").send({
      nickname: "TokenPilot",
      organization: "HexNest"
    });

    const res = await request(app)
      .post(`/api/rooms/${roomId}/agents`)
      .set("Authorization", `Bearer ${registration.body.token}`)
      .send({ name: "IGNORED-NAME" });

    expect(res.status).toBe(201);
    expect(res.body.joinedAgent.id).toBe(registration.body.agentId);
    expect(res.body.joinedAgent.name).toBe("TokenPilot");
  });

  it("keeps legacy room join mode when no token is provided", async () => {
    const room = await request(app).post("/api/rooms").send({ task: "legacy join test" });
    const roomId = room.body.id as string;

    const res = await request(app)
      .post(`/api/rooms/${roomId}/agents`)
      .send({ name: "LegacyBot" });

    expect(res.status).toBe(201);
    expect(res.body.joinedAgent.name).toBe("LegacyBot");
    expect(res.body.joinedAgent.id).toBeTruthy();
  });

  it("returns 401 when token is invalid", async () => {
    const room = await request(app).post("/api/rooms").send({ task: "invalid token test" });
    const roomId = room.body.id as string;

    const res = await request(app)
      .post(`/api/rooms/${roomId}/agents`)
      .set("Authorization", "Bearer hxn_live_badtoken000000000000000000000000")
      .send({ name: "ShouldFail" });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or expired token/i);
  });

  it("assigns admin scope by HEXNEST_ADMIN_AGENTS and enforces admin-only delete", async () => {
    const admin = await request(app).post("/api/agents/register").send({ nickname: "Aya-9X" });
    const user = await request(app).post("/api/agents/register").send({ nickname: "UserBot" });
    const room = await request(app).post("/api/rooms").send({ task: "admin scope test" });
    const roomId = room.body.id as string;

    const forbidden = await request(app)
      .delete(`/api/rooms/${roomId}`)
      .set("Authorization", `Bearer ${user.body.token}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatch(/admin scope required/i);

    const allowed = await request(app)
      .delete(`/api/rooms/${roomId}`)
      .set("Authorization", `Bearer ${admin.body.token}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.deleted).toBe("room");
  });

  it("supports batch registration with mixed success and errors", async () => {
    await request(app).post("/api/agents/register").send({ nickname: "TakenNick" });

    const batch = await request(app)
      .post("/api/agents/register/batch")
      .send({
        agents: [
          { nickname: "BatchOne", specialty: ["tooling"] },
          { nickname: "TakenNick", specialty: ["duplicate"] },
          { organization: "Missing Nick" }
        ]
      });

    expect(batch.status).toBe(200);
    expect(batch.body.registered).toHaveLength(1);
    expect(batch.body.registered[0].profile.nickname).toBe("BatchOne");
    expect(Array.isArray(batch.body.errors)).toBe(true);
    expect(batch.body.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("returns profile by agentId", async () => {
    const reg = await request(app).post("/api/agents/register").send({ nickname: "LookupBot" });
    const profile = await request(app).get(`/api/agents/profile/${reg.body.agentId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.nickname).toBe("LookupBot");
    expect(profile.body.handle).toBe("LookupBot@hexnest-main");

    const missing = await request(app).get("/api/agents/profile/not-found-id");
    expect(missing.status).toBe(404);
  });
});
