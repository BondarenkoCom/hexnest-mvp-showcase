import express from "express";
import { createHmac } from "crypto";
import { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { SQLiteRoomStore } from "../db/SQLiteRoomStore";
import { createRoomsRouter } from "../routes/rooms";
import { createWebhooksRouter } from "../routes/webhooks";
import { tempDbPath } from "./helpers";
import { WebhookDispatcher } from "../webhooks/WebhookDispatcher";

describe("webhooks", () => {
  const adminSecret = "test-admin-secret";
  const originalAdminSecret = process.env.HEXNEST_ADMIN_SECRET;
  let store: SQLiteRoomStore;
  let app: express.Application;

  const receivedBodies: Array<Record<string, unknown>> = [];
  const receivedHeaders: Array<Record<string, string>> = [];
  let receiverServer: ReturnType<express.Application["listen"]> | null = null;
  let receiverUrl = "";

  beforeEach(async () => {
    process.env.HEXNEST_ADMIN_SECRET = adminSecret;
    store = new SQLiteRoomStore(tempDbPath());

    const receiver = express();
    receiver.use(express.json());
    receiver.post("/hook", (req, res) => {
      receivedBodies.push(req.body as Record<string, unknown>);
      receivedHeaders.push(req.headers as Record<string, string>);
      res.status(200).json({ ok: true });
    });

    receiverServer = await new Promise<ReturnType<express.Application["listen"]>>((resolve) => {
      const srv = receiver.listen(0, "127.0.0.1", () => resolve(srv));
    });
    const port = (receiverServer.address() as AddressInfo).port;
    receiverUrl = `http://127.0.0.1:${port}/hook`;

    const webhooks = new WebhookDispatcher(store, {
      source: "hexnest-test",
      maxAttempts: 2,
      timeoutMs: 1500,
      retryBaseMs: 80
    });

    app = express();
    app.use(express.json());
    app.use("/api", createWebhooksRouter(store, webhooks));
    app.use("/api", createRoomsRouter(store, webhooks));
  });

  afterEach(async () => {
    receivedBodies.length = 0;
    receivedHeaders.length = 0;
    if (receiverServer) {
      await new Promise<void>((resolve, reject) => {
        receiverServer?.close((err) => (err ? reject(err) : resolve()));
      });
      receiverServer = null;
    }
    if (originalAdminSecret === undefined) {
      delete process.env.HEXNEST_ADMIN_SECRET;
    } else {
      process.env.HEXNEST_ADMIN_SECRET = originalAdminSecret;
    }
  });

  it("creates webhook endpoint and dispatches room.message_posted with signature", async () => {
    const createHook = await request(app)
      .post("/api/webhooks")
      .set("x-admin-secret", adminSecret)
      .send({
        url: receiverUrl,
        secret: "local-webhook-secret",
        events: ["room.message_posted"]
      });

    expect(createHook.status).toBe(201);
    expect(createHook.body.url).toBe(receiverUrl);
    expect(createHook.body.events).toContain("room.message_posted");

    const roomRes = await request(app).post("/api/rooms").send({
      name: "Webhook Room",
      task: "test webhook",
      subnest: "general",
      pythonShellEnabled: false,
      webSearchEnabled: false
    });
    expect(roomRes.status).toBe(201);

    const joinRes = await request(app)
      .post(`/api/rooms/${roomRes.body.id}/agents`)
      .send({ name: "WebhookAgent" });
    expect(joinRes.status).toBe(201);

    const messageRes = await request(app)
      .post(`/api/rooms/${roomRes.body.id}/messages`)
      .send({ agentId: joinRes.body.joinedAgent.id, text: "Webhook payload test" });
    expect(messageRes.status).toBe(201);

    await waitFor(() => receivedBodies.length > 0, 3000);
    const payload = receivedBodies[0];
    const headers = receivedHeaders[0];
    expect(payload.type).toBe("room.message_posted");
    expect(payload.source).toBe("hexnest-test");
    expect(payload.data).toBeTruthy();

    const timestamp = headers["x-hexnest-timestamp"];
    const signature = headers["x-hexnest-signature"];
    expect(typeof timestamp).toBe("string");
    expect(typeof signature).toBe("string");

    const expected = `sha256=${createHmac("sha256", "local-webhook-secret")
      .update(`${timestamp}.${JSON.stringify(payload)}`)
      .digest("hex")}`;
    expect(signature).toBe(expected);
  });

  it("requires admin secret for webhook management endpoints", async () => {
    const withoutSecret = await request(app)
      .post("/api/webhooks")
      .send({ url: receiverUrl, events: ["room.created"] });
    expect(withoutSecret.status).toBe(401);

    const wrongSecret = await request(app)
      .post("/api/webhooks")
      .set("x-admin-secret", "wrong")
      .send({ url: receiverUrl, events: ["room.created"] });
    expect(wrongSecret.status).toBe(401);
  });
});

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
