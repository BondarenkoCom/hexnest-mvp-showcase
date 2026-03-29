import express from "express";
import { randomBytes } from "crypto";
import { IAppStore } from "../orchestration/RoomStore";
import {
  CreateWebhookEndpointInput,
  UpdateWebhookEndpointInput,
  WEBHOOK_EVENT_TYPES,
  WebhookEventType
} from "../types/protocol";
import { normalizeText } from "../utils/normalize";
import { requireAdmin } from "../utils/auth";
import { WebhookDispatcher } from "../webhooks/WebhookDispatcher";

const DEFAULT_EVENTS = WEBHOOK_EVENT_TYPES.filter((eventType) => eventType !== "webhook.test");
const EVENT_DESCRIPTIONS: Record<WebhookEventType, string> = {
  "room.created": "A new room is created",
  "room.deleted": "A room is deleted by admin",
  "room.agent_joined": "An agent joins a room",
  "room.message_posted": "A message is posted into a room timeline",
  "room.message_flagged": "A message is marked as requiring human attention",
  "room.artifact_created": "A new artifact is added to a room",
  "python_job.finished": "A Python job completes with final status",
  "search_job.finished": "A web search job completes with final status",
  "share.created": "A short share link is generated for a room message",
  "webhook.test": "Manual test event triggered via /api/webhooks/:id/test"
};

export function createWebhooksRouter(
  store: IAppStore,
  webhooks: WebhookDispatcher
): express.Router {
  const router = express.Router();

  router.get("/webhooks/events", (_req, res) => {
    res.json({
      value: WEBHOOK_EVENT_TYPES.map((eventType) => ({
        type: eventType,
        description: EVENT_DESCRIPTIONS[eventType],
        testOnly: eventType === "webhook.test"
      }))
    });
  });

  router.get("/webhooks", requireAdmin, async (_req, res) => {
    const endpoints = await store.listWebhookEndpoints();
    res.json({ value: endpoints });
  });

  router.post("/webhooks", requireAdmin, async (req, res) => {
    const url = normalizeText(req.body?.url, 1000);
    if (!url || !isValidWebhookUrl(url)) {
      res.status(400).json({ error: "valid http/https url is required" });
      return;
    }

    const events = normalizeEvents(req.body?.events);
    if ("error" in events) {
      res.status(400).json({ error: events.error });
      return;
    }

    const input: CreateWebhookEndpointInput = {
      url,
      secret: normalizeText(req.body?.secret, 200) || randomBytes(16).toString("hex"),
      events: events.value,
      active: req.body?.active !== false,
      description: normalizeText(req.body?.description, 200) || ""
    };

    const endpoint = await store.createWebhookEndpoint(input);
    res.status(201).json(endpoint);
  });

  router.patch("/webhooks/:id", requireAdmin, async (req, res) => {
    const patch: UpdateWebhookEndpointInput = {};

    if (req.body?.url !== undefined) {
      const url = normalizeText(req.body?.url, 1000);
      if (!url || !isValidWebhookUrl(url)) {
        res.status(400).json({ error: "valid http/https url is required" });
        return;
      }
      patch.url = url;
    }

    if (req.body?.secret !== undefined) {
      const secret = normalizeText(req.body?.secret, 200);
      if (!secret) {
        res.status(400).json({ error: "secret cannot be empty" });
        return;
      }
      patch.secret = secret;
    }

    if (req.body?.events !== undefined) {
      const events = normalizeEvents(req.body?.events);
      if ("error" in events) {
        res.status(400).json({ error: events.error });
        return;
      }
      patch.events = events.value;
    }

    if (req.body?.active !== undefined) {
      patch.active = Boolean(req.body?.active);
    }

    if (req.body?.description !== undefined) {
      patch.description = normalizeText(req.body?.description, 200) || "";
    }

    const updated = await store.updateWebhookEndpoint(req.params.id, patch);
    if (!updated) {
      res.status(404).json({ error: "webhook endpoint not found" });
      return;
    }
    res.json(updated);
  });

  router.delete("/webhooks/:id", requireAdmin, async (req, res) => {
    const deleted = await store.deleteWebhookEndpoint(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "webhook endpoint not found" });
      return;
    }
    res.json({ ok: true, deleted: "webhook", id: req.params.id });
  });

  router.post("/webhooks/:id/test", requireAdmin, async (req, res) => {
    const endpoint = await store.getWebhookEndpoint(req.params.id);
    if (!endpoint) {
      res.status(404).json({ error: "webhook endpoint not found" });
      return;
    }
    const result = await webhooks.triggerTest(endpoint.id);
    if (!result.ok) {
      res.status(502).json({
        ok: false,
        endpointId: endpoint.id,
        eventId: result.eventId,
        error: result.error || "delivery failed"
      });
      return;
    }
    res.json({
      ok: true,
      endpointId: endpoint.id,
      eventId: result.eventId
    });
  });

  return router;
}

function isValidWebhookUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeEvents(raw: unknown): { value: WebhookEventType[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { value: [...DEFAULT_EVENTS] };
  }
  const normalized = Array.from(
    new Set(
      raw
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );
  const invalid = normalized.filter((eventType) => !WEBHOOK_EVENT_TYPES.includes(eventType as WebhookEventType));
  if (invalid.length > 0) {
    return { error: `unsupported events: ${invalid.join(", ")}` };
  }
  return { value: normalized as WebhookEventType[] };
}
