import express from "express";
import { IAppStore } from "../orchestration/RoomStore";
import { ManifoldClient, ManifoldComment, ManifoldLiteMarket } from "../integrations/manifold/ManifoldClient";
import { RoomSnapshot } from "../types/protocol";

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "from", "will", "this", "what", "when", "where", "which", "into", "about",
  "room", "task", "debate", "discussion", "agent", "agents", "market", "markets", "question", "questions"
]);

export function createMarketDataRouter(
  store: Pick<IAppStore, "getRoom">,
  client = new ManifoldClient()
): express.Router {
  const router = express.Router();

  router.get("/rooms/:roomId/market-data/markets", async (req, res, next) => {
    try {
      const guard = await guardRoomMarketMode(store, client, req.params.roomId, res);
      if (!guard.ok) return;

      const room = guard.room;
      const limit = clampInt(req.query.limit, 12, 1, 30);
      const query = normalizeQuery(String(req.query.query || "")) || deriveQueryFromTask(room.task);
      const pullLimit = Math.max(80, Math.min(300, limit * 10));

      const fetchedAt = new Date().toISOString();
      const markets = await client.listMarkets({
        limit: pullLimit,
        sort: "last-comment-time",
        order: "desc"
      });
      const ranked = rankMarkets(markets, query);
      const value = ranked.slice(0, limit).map((item) => toMarketCard(item.market, item.score));

      res.json({
        roomId: room.id,
        query,
        fetchedAt,
        totalFetched: markets.length,
        count: value.length,
        value
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/rooms/:roomId/market-data/markets/:marketId", async (req, res, next) => {
    try {
      const guard = await guardRoomMarketMode(store, client, req.params.roomId, res);
      if (!guard.ok) return;

      const marketId = String(req.params.marketId || "").trim();
      if (!marketId) {
        res.status(400).json({ error: "marketId is required" });
        return;
      }

      const market = await client.getMarket(marketId);
      res.json({
        roomId: guard.room.id,
        fetchedAt: new Date().toISOString(),
        value: toMarketCard(market, 0)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/rooms/:roomId/market-data/markets/:marketId/comments", async (req, res, next) => {
    try {
      const guard = await guardRoomMarketMode(store, client, req.params.roomId, res);
      if (!guard.ok) return;

      const marketId = String(req.params.marketId || "").trim();
      if (!marketId) {
        res.status(400).json({ error: "marketId is required" });
        return;
      }

      const limit = clampInt(req.query.limit, 20, 1, 50);
      const comments = await client.getComments(marketId, limit);
      const value = comments
        .filter((item) => item.text.trim().length > 0)
        .slice(0, limit)
        .map(toCommentCard);

      res.json({
        roomId: guard.room.id,
        marketId,
        fetchedAt: new Date().toISOString(),
        count: value.length,
        value
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function guardRoomMarketMode(
  store: Pick<IAppStore, "getRoom">,
  client: ManifoldClient,
  roomIdRaw: string,
  res: express.Response
): Promise<{ ok: false } | { ok: true; room: RoomSnapshot }> {
  const roomId = String(roomIdRaw || "").trim();
  if (!roomId) {
    res.status(400).json({ error: "roomId is required" });
    return { ok: false };
  }

  const room = await store.getRoom(roomId);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return { ok: false };
  }

  if (!room.settings.marketDataEnabled) {
    res.status(403).json({ error: "market data mode is disabled for this room" });
    return { ok: false };
  }

  if (!client.hasApiKey()) {
    res.status(503).json({ error: "MANIFOLD_API_KEY is not configured" });
    return { ok: false };
  }

  return { ok: true, room };
}

function normalizeQuery(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function deriveQueryFromTask(task: string): string {
  const tokens = String(task || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return Array.from(new Set(tokens)).slice(0, 6).join(" ");
}

function rankMarkets(markets: ManifoldLiteMarket[], query: string): Array<{ market: ManifoldLiteMarket; score: number }> {
  const normalized = normalizeQuery(query).toLowerCase();
  if (!normalized) {
    return markets.map((market, index) => ({ market, score: Math.max(0, 1000 - index) }));
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  return markets
    .map((market) => {
      const text = `${market.question || ""} ${market.creatorName || ""} ${market.creatorUsername || ""}`.toLowerCase();
      let score = 0;
      if (text.includes(normalized)) score += 20;
      for (const token of tokens) {
        if (text.includes(token)) score += 5;
      }
      if (market.lastCommentTime) score += 2;
      if (market.volume24Hours && market.volume24Hours > 0) score += 1;
      return { market, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.market.lastCommentTime || 0) - (a.market.lastCommentTime || 0);
    });
}

function toMarketCard(market: ManifoldLiteMarket, relevanceScore: number): Record<string, unknown> {
  return {
    id: market.id,
    question: market.question,
    url: market.url,
    creatorName: market.creatorName || market.creatorUsername || "unknown",
    probability: typeof market.probability === "number" ? round4(market.probability) : null,
    probabilityPercent: typeof market.probability === "number" ? Math.round(market.probability * 1000) / 10 : null,
    volume: toSafeNumber(market.volume),
    volume24Hours: toSafeNumber(market.volume24Hours),
    totalLiquidity: toSafeNumber(market.totalLiquidity),
    closeTime: toIsoOrNull(market.closeTime),
    createdTime: toIsoOrNull(market.createdTime),
    lastUpdatedTime: toIsoOrNull(market.lastUpdatedTime),
    lastCommentTime: toIsoOrNull(market.lastCommentTime),
    lastBetTime: toIsoOrNull(market.lastBetTime),
    isResolved: Boolean(market.isResolved),
    resolution: market.resolution || null,
    mechanism: market.mechanism || null,
    outcomeType: market.outcomeType || null,
    relevanceScore
  };
}

function toCommentCard(comment: ManifoldComment): Record<string, unknown> {
  return {
    id: comment.id,
    userName: comment.userName || comment.userUsername || "unknown",
    userUsername: comment.userUsername || null,
    createdTime: toIsoOrNull(comment.createdTime),
    text: comment.text,
    url: comment.url || null
  };
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function toSafeNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toIsoOrNull(value: unknown): string | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return new Date(num).toISOString();
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
