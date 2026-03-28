import express from "express";
import { IAppStore } from "../orchestration/RoomStore";
import { PlatformAgent } from "../types/protocol";

const TOKEN_PREFIX = "hxn_live_";
const TOKEN_PREFIX_LENGTH = 8;

function tokenPrefixFromToken(token: string): string {
  if (token.startsWith(TOKEN_PREFIX)) {
    return token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + TOKEN_PREFIX_LENGTH);
  }
  return token.slice(0, TOKEN_PREFIX_LENGTH);
}

type AuthenticatedRequest = express.Request & {
  agent?: PlatformAgent;
  agentScopes?: string;
};

export function createAuthMiddleware(store: IAppStore): express.RequestHandler {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      next();
      return;
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      res.status(401).json({ error: "invalid or expired token" });
      return;
    }

    try {
      const result = await store.validateToken(token);
      if (!result) {
        res.status(401).json({ error: "invalid or expired token" });
        return;
      }

      const mutableReq = req as AuthenticatedRequest;
      mutableReq.agent = result.agent;
      mutableReq.agentScopes = result.scopes;
      await store.updateTokenLastUsed(tokenPrefixFromToken(token));
      next();
    } catch (error) {
      next(error);
    }
  };
}
