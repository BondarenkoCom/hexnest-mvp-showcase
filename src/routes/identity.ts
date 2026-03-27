import express from "express";
import { IAppStore } from "../orchestration/RoomStore";
import { RegisterAgentInput } from "../types/protocol";
import { normalizeText } from "../utils/normalize";

function normalizeArrayField(raw: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .slice(0, maxItems)
    .map((item) => normalizeText(item, maxLen))
    .filter(Boolean);
}

function normalizeRegisterInput(raw: unknown): RegisterAgentInput {
  const body = (raw || {}) as Record<string, unknown>;
  return {
    nickname: normalizeText(body.nickname, 80),
    organization: normalizeText(body.organization, 120) || undefined,
    specialty: normalizeArrayField(body.specialty, 20, 80),
    tags: normalizeArrayField(body.tags, 30, 40),
    theme: normalizeText(body.theme, 30) || undefined,
    modelFamily: normalizeText(body.modelFamily, 80) || undefined,
    publicKey: normalizeText(body.publicKey, 3000) || undefined,
    verificationUrl: normalizeText(body.verificationUrl, 500) || undefined,
    homeUrl: normalizeText(body.homeUrl, 500) || undefined
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || !error) {
    return false;
  }
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === "23505" || candidate.code === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }
  return String(candidate.message || "").toLowerCase().includes("unique");
}

function getAdminNicknames(): Set<string> {
  const raw = String(process.env.HEXNEST_ADMIN_AGENTS || "");
  const values = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return new Set(values);
}

export function createIdentityRouter(store: IAppStore): express.Router {
  const router = express.Router();

  router.post("/agents/register", async (req, res) => {
    const input = normalizeRegisterInput(req.body);
    if (!input.nickname) {
      res.status(400).json({ error: "nickname is required" });
      return;
    }

    const existing = await store.getAgentByNickname(input.nickname);
    if (existing) {
      res.status(409).json({ error: "nickname already taken" });
      return;
    }

    try {
      const profile = await store.registerAgent(input);
      const isAdmin = getAdminNicknames().has(profile.nickname.toLowerCase());
      const { token, expiresAt } = await store.createToken(profile.id, isAdmin ? "admin" : "agent");
      res.status(201).json({
        agentId: profile.id,
        token,
        handle: profile.handle,
        createdAt: profile.createdAt,
        expiresAt,
        profile
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: "nickname already taken" });
        return;
      }
      throw error;
    }
  });

  router.post("/agents/register/batch", async (req, res) => {
    const agents = Array.isArray(req.body?.agents) ? req.body.agents : [];
    if (agents.length === 0) {
      res.status(400).json({ error: "agents array is required" });
      return;
    }

    const registered: Array<{
      agentId: string;
      token: string;
      handle: string;
      createdAt: string;
      expiresAt: string;
      profile: unknown;
    }> = [];
    const errors: Array<{ index: number; nickname: string; error: string }> = [];
    const adminNicknames = getAdminNicknames();

    for (let index = 0; index < agents.length; index += 1) {
      const input = normalizeRegisterInput(agents[index]);
      const nickname = input.nickname;
      if (!nickname) {
        errors.push({ index, nickname: "", error: "nickname is required" });
        continue;
      }

      try {
        const existing = await store.getAgentByNickname(nickname);
        if (existing) {
          errors.push({ index, nickname, error: "nickname already taken" });
          continue;
        }

        const profile = await store.registerAgent(input);
        const isAdmin = adminNicknames.has(profile.nickname.toLowerCase());
        const { token, expiresAt } = await store.createToken(profile.id, isAdmin ? "admin" : "agent");
        registered.push({
          agentId: profile.id,
          token,
          handle: profile.handle,
          createdAt: profile.createdAt,
          expiresAt,
          profile
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          errors.push({ index, nickname, error: "nickname already taken" });
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ index, nickname, error: message });
      }
    }

    res.json({ registered, errors });
  });

  router.get("/agents/profiles", async (_req, res) => {
    const agents = await store.listPlatformAgents();
    res.json({ value: agents });
  });

  router.get("/agents/profile/:agentId", async (req, res) => {
    const agent = await store.getAgentById(normalizeText(req.params.agentId, 120));
    if (!agent) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(agent);
  });

  return router;
}
