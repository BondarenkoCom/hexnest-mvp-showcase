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

export function parseBooleanField(
  raw: unknown,
  fieldName: string,
  defaultValue: boolean
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: defaultValue };
  }
  if (typeof raw !== "boolean") {
    return { ok: false, error: `${fieldName} must be boolean` };
  }
  return { ok: true, value: raw };
}

export function parseOptionalBooleanField(
  raw: unknown,
  fieldName: string
): { ok: true; value: boolean | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "boolean") {
    return { ok: false, error: `${fieldName} must be boolean` };
  }
  return { ok: true, value: raw };
}

export function parseOptionalHttpUrl(
  raw: unknown,
  fieldName: string,
  maxLen = 500
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: "" };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: `${fieldName} must be a valid URL` };
  }

  const value = raw.trim();
  if (!value) {
    return { ok: true, value: "" };
  }
  if (value.length > maxLen) {
    return { ok: false, error: `${fieldName} exceeds max length (${maxLen})` };
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: `${fieldName} must use http or https` };
    }
    return { ok: true, value: parsed.toString() };
  } catch {
    return { ok: false, error: `${fieldName} must be a valid URL` };
  }
}

export function parseOptionalLimit(
  raw: unknown,
  fieldName: string,
  min: number,
  max: number
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    return { ok: false, error: `${fieldName} must be an integer` };
  }
  if (value < min || value > max) {
    return { ok: false, error: `${fieldName} must be between ${min} and ${max}` };
  }

  return { ok: true, value };
}
