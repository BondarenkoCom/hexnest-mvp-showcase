import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";
import { createRoomsRouter } from "../routes/rooms";
import { createMarketDataRouter } from "../routes/market-data";
import { tempDbPath } from "./helpers";

function buildApp(store: SQLiteRoomStore, client: any): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api", createRoomsRouter(store));
  app.use("/api", createMarketDataRouter(store, client));
  return app;
}

describe("market-data routes", () => {
  it("returns 403 when market mode is disabled for room", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const room = await store.createRoom({
      name: "No market room",
      task: "ai",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: true,
      marketDataEnabled: false,
      subnest: "general"
    });
    const client = {
      hasApiKey: () => true,
      listMarkets: async () => []
    };

    const res = await request(buildApp(store, client))
      .get(`/api/rooms/${room.id}/market-data/markets`);

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/disabled/i);
  });

  it("returns 503 when market mode is enabled but API key is unavailable", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const room = await store.createRoom({
      name: "Market room",
      task: "ai regulation",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: true,
      marketDataEnabled: true,
      subnest: "general"
    });
    const client = {
      hasApiKey: () => false,
      listMarkets: async () => []
    };

    const res = await request(buildApp(store, client))
      .get(`/api/rooms/${room.id}/market-data/markets`);

    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/MANIFOLD_API_KEY/i);
  });

  it("returns ranked market cards for enabled room", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const room = await store.createRoom({
      name: "AI market room",
      task: "debate ai regulation and policy outcomes",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: true,
      marketDataEnabled: true,
      subnest: "general"
    });
    const client = {
      hasApiKey: () => true,
      listMarkets: async () => [
        {
          id: "m1",
          question: "Will AI regulation pass in 2026?",
          url: "https://manifold.markets/market/1",
          probability: 0.64,
          volume24Hours: 123,
          totalLiquidity: 456,
          lastCommentTime: Date.now()
        },
        {
          id: "m2",
          question: "Will Company X ship product Y?",
          url: "https://manifold.markets/market/2",
          probability: 0.42,
          volume24Hours: 70,
          totalLiquidity: 310,
          lastCommentTime: Date.now() - 5000
        }
      ]
    };

    const res = await request(buildApp(store, client))
      .get(`/api/rooms/${room.id}/market-data/markets?limit=1`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.value[0].id).toBe("m1");
    expect(res.body.value[0].probabilityPercent).toBe(64);
  });

  it("returns market comments and removes empty text rows", async () => {
    const store = new SQLiteRoomStore(tempDbPath());
    const room = await store.createRoom({
      name: "Comment room",
      task: "ai policy",
      agentIds: [],
      pythonShellEnabled: false,
      webSearchEnabled: true,
      marketDataEnabled: true,
      subnest: "general"
    });
    const client = {
      hasApiKey: () => true,
      getComments: async () => [
        { id: "c1", userName: "Aya", text: "Strong evidence in latest poll.", createdTime: Date.now() },
        { id: "c2", userName: "Blank", text: "   ", createdTime: Date.now() }
      ]
    };

    const res = await request(buildApp(store, client))
      .get(`/api/rooms/${room.id}/market-data/markets/m1/comments?limit=10`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.value[0].id).toBe("c1");
  });
});
