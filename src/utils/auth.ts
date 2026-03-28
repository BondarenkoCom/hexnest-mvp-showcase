import { NextFunction, Request, Response } from "express";
import { PlatformAgent } from "../types/protocol";

function getConfiguredAdminSecret(): string {
  const fromEnv = process.env.HEXNEST_ADMIN_SECRET?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return process.env.NODE_ENV === "production" ? "" : "hexnest-admin-local";
}

function resolveSecretCandidate(req: Request): string {
  const headerValue = req.headers["x-admin-secret"];
  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    return headerValue.trim();
  }
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    const candidate = String(headerValue[0] || "").trim();
    if (candidate) {
      return candidate;
    }
  }

  const queryValue = req.query.secret;
  if (typeof queryValue === "string" && queryValue.trim().length > 0) {
    return queryValue.trim();
  }
  if (Array.isArray(queryValue) && queryValue.length > 0) {
    return String(queryValue[0] || "").trim();
  }

  return "";
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as Request & { agent?: PlatformAgent; agentScopes?: string };
  if (authReq.agent) {
    if (authReq.agentScopes === "admin") {
      next();
      return;
    }
    res.status(403).json({ error: "admin scope required" });
    return;
  }

  const configuredSecret = getConfiguredAdminSecret();
  const providedSecret = resolveSecretCandidate(req);

  if (!configuredSecret || !providedSecret || providedSecret !== configuredSecret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}
