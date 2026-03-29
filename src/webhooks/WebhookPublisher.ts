import { WebhookEventType } from "../types/protocol";

export interface WebhookPublisher {
  publish(
    type: WebhookEventType,
    data: Record<string, unknown>,
    links?: Record<string, string>
  ): void;
}

export const NoopWebhookPublisher: WebhookPublisher = {
  publish(): void {}
};
