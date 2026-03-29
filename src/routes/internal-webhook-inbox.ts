import { createHmac, timingSafeEqual } from "crypto";
import express from "express";
import { nowIso, newId } from "../utils/ids";
import { requireAdmin } from "../utils/auth";

interface InboundWebhookRecord {
  id: string;
  receivedAt: string;
  eventId: string;
  eventType: string;
  timestamp: string;
  source: string;
  payload: Record<string, unknown>;
}

const buffer: InboundWebhookRecord[] = [];
const DEFAULT_BUFFER_LIMIT = 200;

export function resetInternalWebhookInboxForTests(): void {
  buffer.length = 0;
}

export function createInternalWebhookInboxRouter(): express.Router {
  const router = express.Router();

  router.post("/internal/webhook-inbox", (req, res) => {
    const secret = resolveSecret();
    if (!secret) {
      res.status(503).json({ error: "internal webhook secret is not configured" });
      return;
    }

    const timestamp = normalizeHeader(req.headers["x-hexnest-timestamp"]);
    const signature = normalizeHeader(req.headers["x-hexnest-signature"]);
    if (!timestamp || !signature) {
      res.status(400).json({ error: "missing signature headers" });
      return;
    }

    const payload = normalizePayload(req.body);
    const rawBody = JSON.stringify(payload);
    if (!isValidSignature(secret, timestamp, rawBody, signature)) {
      res.status(401).json({ error: "invalid webhook signature" });
      return;
    }

    const eventId =
      normalizeHeader(req.headers["x-hexnest-event-id"]) ||
      normalizeText(payload.id) ||
      "";
    const eventType =
      normalizeHeader(req.headers["x-hexnest-event"]) ||
      normalizeText(payload.type) ||
      "unknown";

    const record: InboundWebhookRecord = {
      id: newId(),
      receivedAt: nowIso(),
      eventId,
      eventType,
      timestamp,
      source: normalizeText(payload.source) || "",
      payload
    };

    buffer.unshift(record);
    const max = resolveBufferLimit();
    if (buffer.length > max) {
      buffer.length = max;
    }

    res.status(202).json({
      ok: true,
      received: {
        id: record.id,
        eventId: record.eventId,
        eventType: record.eventType,
        receivedAt: record.receivedAt
      }
    });
  });

  router.get("/internal/webhook-inbox", requireAdmin, (req, res) => {
    const requested = Number.parseInt(String(req.query.limit || "50"), 10);
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(200, requested))
      : 50;
    res.json({
      total: buffer.length,
      value: buffer.slice(0, limit)
    });
  });

  return router;
}

function resolveSecret(): string {
  const internalSecret = String(process.env.HEXNEST_INTERNAL_WEBHOOK_SECRET || "").trim();
  if (internalSecret) return internalSecret;
  return String(process.env.HEXNEST_ADMIN_SECRET || "").trim();
}

function resolveBufferLimit(): number {
  const parsed = Number.parseInt(String(process.env.HEXNEST_INTERNAL_WEBHOOK_BUFFER || ""), 10);
  if (!Number.isFinite(parsed) || parsed < 10) {
    return DEFAULT_BUFFER_LIMIT;
  }
  return parsed;
}

function normalizeHeader(value: string | string[] | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && value.length > 0) {
    return String(value[0] || "").trim();
  }
  return "";
}

function normalizePayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function isValidSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(signature, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}
