import { createHmac } from "crypto";
import { IAppStore } from "../orchestration/RoomStore";
import { WebhookEndpoint, WebhookEventEnvelope, WebhookEventType } from "../types/protocol";
import { newId, nowIso } from "../utils/ids";
import { WebhookPublisher } from "./WebhookPublisher";

interface WebhookDispatcherOptions {
  source: string;
  maxAttempts: number;
  timeoutMs: number;
  retryBaseMs: number;
}

const DEFAULT_OPTIONS: WebhookDispatcherOptions = {
  source: process.env.PUBLIC_BASE_URL || "hexnest-mvp",
  maxAttempts: Number(process.env.HEXNEST_WEBHOOK_MAX_ATTEMPTS || 3),
  timeoutMs: Number(process.env.HEXNEST_WEBHOOK_TIMEOUT_MS || 10000),
  retryBaseMs: Number(process.env.HEXNEST_WEBHOOK_RETRY_BASE_MS || 1500)
};

export class WebhookDispatcher implements WebhookPublisher {
  private readonly options: WebhookDispatcherOptions;

  constructor(
    private readonly store: IAppStore,
    options: WebhookDispatcherOptions = DEFAULT_OPTIONS
  ) {
    this.options = {
      source: String(options.source || DEFAULT_OPTIONS.source),
      maxAttempts: normalizeNumber(options.maxAttempts, DEFAULT_OPTIONS.maxAttempts, 1),
      timeoutMs: normalizeNumber(options.timeoutMs, DEFAULT_OPTIONS.timeoutMs, 1000),
      retryBaseMs: normalizeNumber(options.retryBaseMs, DEFAULT_OPTIONS.retryBaseMs, 200)
    };
  }

  public publish(
    type: WebhookEventType,
    data: Record<string, unknown>,
    links: Record<string, string> = {}
  ): void {
    const event = this.newEnvelope(type, data, links);
    void this.dispatch(event).catch((err) => {
      console.error("webhook dispatch error:", err);
    });
  }

  public async triggerTest(endpointId: string): Promise<{ ok: boolean; eventId: string; error?: string }> {
    const endpoint = await this.store.getWebhookEndpoint(endpointId);
    if (!endpoint) {
      return { ok: false, eventId: "", error: "webhook endpoint not found" };
    }

    const event = this.newEnvelope(
      "webhook.test",
      { message: "HexNest webhook test event", endpointId: endpoint.id },
      {}
    );
    const result = await this.deliverWithRetry(endpoint, event);
    return {
      ok: result.ok,
      eventId: event.id,
      error: result.error || undefined
    };
  }

  private newEnvelope(
    type: WebhookEventType,
    data: Record<string, unknown>,
    links: Record<string, string>
  ): WebhookEventEnvelope {
    return {
      id: newId(),
      type,
      version: "v1",
      source: this.options.source,
      occurredAt: nowIso(),
      data,
      links: Object.keys(links).length > 0 ? links : undefined
    };
  }

  private async dispatch(event: WebhookEventEnvelope): Promise<void> {
    const endpoints = await this.store.listWebhookEndpoints();
    const targets = endpoints.filter(
      (endpoint) => endpoint.active && endpoint.events.includes(event.type)
    );
    if (targets.length === 0) {
      return;
    }

    await Promise.all(
      targets.map((endpoint) =>
        this.deliverWithRetry(endpoint, event).catch((err) => {
          console.error(`webhook delivery error [${endpoint.id}]`, err);
        })
      )
    );
  }

  private async deliverWithRetry(
    endpoint: WebhookEndpoint,
    event: WebhookEventEnvelope
  ): Promise<{ ok: boolean; error?: string }> {
    let attempt = 1;
    while (attempt <= Math.max(1, this.options.maxAttempts)) {
      const deliveredAt = nowIso();
      const result = await this.deliver(endpoint, event);
      if (result.ok) {
        await this.store.markWebhookDelivery(endpoint.id, deliveredAt, null);
        return { ok: true };
      }

      if (attempt >= this.options.maxAttempts) {
        await this.store.markWebhookDelivery(endpoint.id, deliveredAt, result.error || "delivery failed");
        return { ok: false, error: result.error };
      }

      const sleepMs = this.backoffMs(attempt);
      await sleep(sleepMs);
      attempt += 1;
    }
    return { ok: false, error: "delivery failed" };
  }

  private backoffMs(attempt: number): number {
    const base = Math.max(200, this.options.retryBaseMs);
    const jitter = Math.floor(Math.random() * 150);
    return base * Math.pow(2, Math.max(0, attempt - 1)) + jitter;
  }

  private async deliver(
    endpoint: WebhookEndpoint,
    event: WebhookEventEnvelope
  ): Promise<{ ok: boolean; error?: string }> {
    const body = JSON.stringify(event);
    const timestamp = nowIso();
    const signature = this.sign(endpoint.secret, timestamp, body);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1000, this.options.timeoutMs));

    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "hexnest-webhooks/1.0",
          "X-HexNest-Event": event.type,
          "X-HexNest-Event-Id": event.id,
          "X-HexNest-Timestamp": timestamp,
          "X-HexNest-Signature": signature
        },
        body,
        signal: controller.signal
      });
      if (res.ok) {
        return { ok: true };
      }
      return { ok: false, error: `http_${res.status}` };
    } catch (error) {
      if (isAbortError(error)) {
        return { ok: false, error: "timeout" };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private sign(secret: string, timestamp: string, body: string): string {
    const payload = `${timestamp}.${body}`;
    const hash = createHmac("sha256", secret).update(payload).digest("hex");
    return `sha256=${hash}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError";
}

function normalizeNumber(value: number, fallback: number, min: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min) {
    return fallback;
  }
  return Math.floor(num);
}
