import { createHmac } from "crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInternalWebhookInboxRouter,
  resetInternalWebhookInboxForTests
} from "../routes/internal-webhook-inbox";

function sign(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

describe("internal webhook inbox", () => {
  const originalInternalSecret = process.env.HEXNEST_INTERNAL_WEBHOOK_SECRET;
  const originalAdminSecret = process.env.HEXNEST_ADMIN_SECRET;

  beforeEach(() => {
    process.env.HEXNEST_INTERNAL_WEBHOOK_SECRET = "internal-hook-test-secret";
    process.env.HEXNEST_ADMIN_SECRET = "admin-hook-test-secret";
    resetInternalWebhookInboxForTests();
  });

  afterEach(() => {
    resetInternalWebhookInboxForTests();
    if (originalInternalSecret === undefined) {
      delete process.env.HEXNEST_INTERNAL_WEBHOOK_SECRET;
    } else {
      process.env.HEXNEST_INTERNAL_WEBHOOK_SECRET = originalInternalSecret;
    }
    if (originalAdminSecret === undefined) {
      delete process.env.HEXNEST_ADMIN_SECRET;
    } else {
      process.env.HEXNEST_ADMIN_SECRET = originalAdminSecret;
    }
  });

  function buildApp(): express.Application {
    const app = express();
    app.use(express.json());
    app.use("/api", createInternalWebhookInboxRouter());
    return app;
  }

  it("accepts valid signed event and returns it via admin list endpoint", async () => {
    const app = buildApp();
    const timestamp = "2026-03-29T06:40:00.000Z";
    const payload = {
      id: "evt-1",
      type: "room.created",
      source: "hexnest-test",
      data: { roomId: "room-123" }
    };
    const body = JSON.stringify(payload);
    const signature = sign("internal-hook-test-secret", timestamp, body);

    const postRes = await request(app)
      .post("/api/internal/webhook-inbox")
      .set("x-hexnest-timestamp", timestamp)
      .set("x-hexnest-signature", signature)
      .set("x-hexnest-event", "room.created")
      .set("x-hexnest-event-id", "evt-1")
      .send(payload);

    expect(postRes.status).toBe(202);
    expect(postRes.body.ok).toBe(true);
    expect(postRes.body.received.eventType).toBe("room.created");

    const listRes = await request(app)
      .get("/api/internal/webhook-inbox")
      .set("x-admin-secret", "admin-hook-test-secret");

    expect(listRes.status).toBe(200);
    expect(listRes.body.total).toBe(1);
    expect(listRes.body.value[0].eventType).toBe("room.created");
    expect(listRes.body.value[0].eventId).toBe("evt-1");
  });

  it("rejects invalid signature", async () => {
    const app = buildApp();
    const timestamp = "2026-03-29T06:41:00.000Z";
    const payload = { id: "evt-bad", type: "room.message_posted" };

    const res = await request(app)
      .post("/api/internal/webhook-inbox")
      .set("x-hexnest-timestamp", timestamp)
      .set("x-hexnest-signature", "sha256=bad")
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid webhook signature/i);
  });

  it("keeps inbox list admin-only", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/internal/webhook-inbox");
    expect(res.status).toBe(401);
  });
});
