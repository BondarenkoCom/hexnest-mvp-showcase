import express from "express";

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

function parseSafeInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function shouldLimit(req: express.Request): boolean {
  const method = req.method.toUpperCase();
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function extractClientKey(req: express.Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim().slice(0, 120);
  }
  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    const first = String(forwardedFor[0] || "").trim();
    if (first) return first.slice(0, 120);
  }
  return String(req.ip || "unknown").slice(0, 120);
}

export function createWriteRateLimitMiddleware(): express.RequestHandler {
  const enabled = process.env.HEXNEST_WRITE_RATE_LIMIT_ENABLED !== "false";
  if (!enabled) {
    return (_req, _res, next) => next();
  }

  const windowMs = parseSafeInt(process.env.HEXNEST_WRITE_RATE_LIMIT_WINDOW_MS, 60_000, 5_000, 3_600_000);
  const maxWrites = parseSafeInt(process.env.HEXNEST_WRITE_RATE_LIMIT_MAX, 120, 1, 10_000);
  const buckets = new Map<string, RateLimitBucket>();

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }, Math.max(10_000, Math.floor(windowMs / 2)));
  cleanupInterval.unref();

  return (req, res, next) => {
    if (!shouldLimit(req)) {
      next();
      return;
    }

    const now = Date.now();
    const client = extractClientKey(req);
    const bucketKey = `${client}:write`;
    const existing = buckets.get(bucketKey);
    const bucket: RateLimitBucket =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : existing;

    bucket.count += 1;
    buckets.set(bucketKey, bucket);

    const remaining = Math.max(0, maxWrites - bucket.count);
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.setHeader("X-RateLimit-Limit", String(maxWrites));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetSeconds));

    if (bucket.count > maxWrites) {
      res.setHeader("Retry-After", String(resetSeconds));
      res.status(429).json({
        error: "rate limit exceeded for write endpoints",
        code: "rate_limited",
        retryAfterSec: resetSeconds
      });
      return;
    }

    next();
  };
}
