import { MessageScope, RoomSnapshot } from "../types/protocol";

export function normalizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().slice(0, maxLen);
}

export function normalizeConfidence(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

export function normalizeMessageScope(raw: unknown): MessageScope | null {
  if (raw === undefined || raw === null || raw === "") {
    return "room";
  }
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "room" || value === "direct") {
    return value;
  }
  return null;
}

export function normalizeTriggeredBy(room: RoomSnapshot, raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const eventId = raw.trim().slice(0, 100);
  if (!eventId) {
    return null;
  }
  const exists = room.timeline.some((item) => item.id === eventId);
  if (!exists) {
    return undefined;
  }
  return eventId;
}

export function normalizeRoomName(raw: unknown): string {
  const source = normalizeText(raw, 80);
  if (source) {
    return source;
  }
  const stamp = new Date().toISOString().slice(11, 19).replaceAll(":", "");
  return `Room-${stamp}`;
}

export function normalizeSessionId(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().slice(0, 120);
}
