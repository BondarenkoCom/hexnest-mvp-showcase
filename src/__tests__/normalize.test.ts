import { describe, it, expect } from "vitest";
import {
  normalizeText,
  normalizeConfidence,
  normalizeMessageScope,
  normalizeTriggeredBy,
  normalizeRoomName,
  normalizeSessionId,
} from "../utils/normalize";
import type { RoomSnapshot } from "../types/protocol";

function stubRoom(eventIds: string[]): RoomSnapshot {
  return {
    id: "r1",
    name: "Test",
    task: "test task",
    subnest: "general",
    status: "open",
    phase: "open_room",
    settings: { pythonShellEnabled: false, isPublic: false },
    connectedAgents: [],
    agentIds: [],
    artifacts: [],
    timeline: eventIds.map((id) => ({
      id,
      timestamp: new Date().toISOString(),
      phase: "open_room" as const,
      envelope: {
        message_type: "chat" as const,
        from_agent: "agent-a",
        to_agent: "room",
        scope: "room" as const,
        triggered_by: null,
        task_id: "r1",
        intent: "test",
        artifacts: [],
        status: "ok" as const,
        confidence: 0.8,
        assumptions: [],
        risks: [],
        need_human: false,
        explanation: "hello",
      },
    })),
    pythonJobs: [],
    searchJobs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("normalizeText", () => {
  it("trims whitespace", () => {
    expect(normalizeText("  hello  ", 100)).toBe("hello");
  });

  it("slices to maxLen", () => {
    expect(normalizeText("abcdef", 3)).toBe("abc");
  });

  it("returns empty string for non-string input", () => {
    expect(normalizeText(42, 100)).toBe("");
    expect(normalizeText(null, 100)).toBe("");
    expect(normalizeText(undefined, 100)).toBe("");
    expect(normalizeText({}, 100)).toBe("");
  });

  it("handles empty string", () => {
    expect(normalizeText("", 100)).toBe("");
  });
});

describe("normalizeConfidence", () => {
  it("clamps to [0, 1]", () => {
    expect(normalizeConfidence(-5)).toBe(0);
    expect(normalizeConfidence(5)).toBe(1);
    expect(normalizeConfidence(0)).toBe(0);
    expect(normalizeConfidence(1)).toBe(1);
  });

  it("returns value in range as-is", () => {
    expect(normalizeConfidence(0.7)).toBeCloseTo(0.7);
  });

  it("returns 0.5 for non-numeric input", () => {
    // "abc", undefined, NaN, Infinity are non-finite → 0.5
    expect(normalizeConfidence("abc")).toBe(0.5);
    expect(normalizeConfidence(undefined)).toBe(0.5);
    expect(normalizeConfidence(NaN)).toBe(0.5);
    expect(normalizeConfidence(Infinity)).toBe(0.5);
    // null coerces to 0 via Number(null), which is finite → clamped to 0
    expect(normalizeConfidence(null)).toBe(0);
  });

  it("parses string numbers", () => {
    expect(normalizeConfidence("0.9")).toBeCloseTo(0.9);
  });
});

describe("normalizeMessageScope", () => {
  it("returns 'room' for undefined/null/empty", () => {
    expect(normalizeMessageScope(undefined)).toBe("room");
    expect(normalizeMessageScope(null)).toBe("room");
    expect(normalizeMessageScope("")).toBe("room");
  });

  it("returns 'room' or 'direct' for valid values", () => {
    expect(normalizeMessageScope("room")).toBe("room");
    expect(normalizeMessageScope("direct")).toBe("direct");
    expect(normalizeMessageScope("ROOM")).toBe("room");
    expect(normalizeMessageScope("DIRECT")).toBe("direct");
  });

  it("returns null for invalid string", () => {
    expect(normalizeMessageScope("broadcast")).toBeNull();
    expect(normalizeMessageScope("global")).toBeNull();
  });

  it("returns null for non-string non-empty value", () => {
    expect(normalizeMessageScope(42)).toBeNull();
    expect(normalizeMessageScope({})).toBeNull();
  });
});

describe("normalizeTriggeredBy", () => {
  it("returns null for null/undefined", () => {
    const room = stubRoom(["evt-1"]);
    expect(normalizeTriggeredBy(room, null)).toBeNull();
    expect(normalizeTriggeredBy(room, undefined)).toBeNull();
  });

  it("returns undefined for non-string value", () => {
    const room = stubRoom(["evt-1"]);
    expect(normalizeTriggeredBy(room, 42)).toBeUndefined();
  });

  it("returns undefined for event id that does not exist in timeline", () => {
    const room = stubRoom(["evt-1"]);
    expect(normalizeTriggeredBy(room, "evt-999")).toBeUndefined();
  });

  it("returns the event id when it exists in timeline", () => {
    const room = stubRoom(["evt-1", "evt-2"]);
    expect(normalizeTriggeredBy(room, "evt-1")).toBe("evt-1");
    expect(normalizeTriggeredBy(room, "evt-2")).toBe("evt-2");
  });

  it("returns null for empty string", () => {
    const room = stubRoom(["evt-1"]);
    expect(normalizeTriggeredBy(room, "")).toBeNull();
    expect(normalizeTriggeredBy(room, "   ")).toBeNull();
  });
});

describe("normalizeRoomName", () => {
  it("returns trimmed name when provided", () => {
    expect(normalizeRoomName("  My Room  ")).toBe("My Room");
  });

  it("generates a fallback name starting with Room- when empty", () => {
    const result = normalizeRoomName("");
    expect(result).toMatch(/^Room-\d{6}$/);
  });

  it("generates a fallback for non-string input", () => {
    const result = normalizeRoomName(null);
    expect(result).toMatch(/^Room-\d{6}$/);
  });

  it("slices to 80 chars", () => {
    const long = "x".repeat(100);
    expect(normalizeRoomName(long)).toHaveLength(80);
  });
});

describe("normalizeSessionId", () => {
  it("trims and slices to 120", () => {
    expect(normalizeSessionId("  abc  ")).toBe("abc");
    const long = "x".repeat(200);
    expect(normalizeSessionId(long)).toHaveLength(120);
  });

  it("returns empty string for non-string input", () => {
    expect(normalizeSessionId(null)).toBe("");
    expect(normalizeSessionId(42)).toBe("");
  });
});
