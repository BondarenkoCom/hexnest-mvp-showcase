import { describe, expect, it } from "vitest";
import { cleanupInactiveRooms } from "../utils/inactive-room-cleanup";
import { RoomSnapshot } from "../types/protocol";

class InMemoryCleanupStore {
  private readonly rooms = new Map<string, RoomSnapshot>();

  constructor(items: RoomSnapshot[]) {
    for (const room of items) {
      this.rooms.set(room.id, cloneRoom(room));
    }
  }

  public async listRooms(): Promise<RoomSnapshot[]> {
    return Array.from(this.rooms.values()).map((room) => ({
      ...cloneRoom(room),
      timeline: [],
      artifacts: [],
      pythonJobs: []
    }));
  }

  public async getRoom(roomId: string): Promise<RoomSnapshot | undefined> {
    const room = this.rooms.get(roomId);
    return room ? cloneRoom(room) : undefined;
  }

  public async deleteRoom(roomId: string): Promise<boolean> {
    return this.rooms.delete(roomId);
  }

  public hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }
}

describe("cleanupInactiveRooms", () => {
  it("deletes only empty rooms older than threshold", async () => {
    const nowMs = Date.parse("2026-03-29T12:00:00.000Z");
    const store = new InMemoryCleanupStore([
      roomFixture({
        id: "old-no-chat",
        createdAt: "2026-03-26T11:00:00.000Z"
      }),
      roomFixture({
        id: "old-chat",
        createdAt: "2026-03-25T11:00:00.000Z",
        chats: ["2026-03-27T11:59:59.000Z"]
      }),
      roomFixture({
        id: "recent-chat",
        createdAt: "2026-03-25T11:00:00.000Z",
        chats: ["2026-03-29T11:20:00.000Z"]
      }),
      roomFixture({
        id: "old-non-chat-message",
        createdAt: "2026-03-25T09:00:00.000Z",
        proposals: ["2026-03-25T09:30:00.000Z"]
      })
    ]);

    const result = await cleanupInactiveRooms(store, undefined, {
      inactivityMs: 24 * 60 * 60 * 1000,
      nowMs
    });

    expect(result.scanned).toBe(4);
    expect(result.deletedRoomIds).toEqual(["old-no-chat"]);
    expect(store.hasRoom("recent-chat")).toBe(true);
    expect(store.hasRoom("old-chat")).toBe(true);
    expect(store.hasRoom("old-non-chat-message")).toBe(true);
    expect(store.hasRoom("old-no-chat")).toBe(false);
  });

  it("ignores system-only events and still treats room as empty", async () => {
    const nowMs = Date.parse("2026-03-29T12:00:00.000Z");
    const room = roomFixture({
      id: "system-active-only",
      createdAt: "2026-03-25T11:00:00.000Z",
      systemEvents: ["2026-03-29T11:50:00.000Z"]
    });
    const store = new InMemoryCleanupStore([room]);

    const result = await cleanupInactiveRooms(store, undefined, {
      inactivityMs: 24 * 60 * 60 * 1000,
      nowMs
    });

    expect(result.deletedRoomIds).toEqual(["system-active-only"]);
    expect(store.hasRoom("system-active-only")).toBe(false);
  });
});

function roomFixture(input: {
  id: string;
  createdAt: string;
  chats?: string[];
  proposals?: string[];
  systemEvents?: string[];
}): RoomSnapshot {
  const timeline = [
    ...(input.systemEvents || []).map((timestamp, index) => ({
      id: `sys-${input.id}-${index}`,
      timestamp,
      phase: "open_room" as const,
      envelope: {
        message_type: "system" as const,
        from_agent: "system",
        to_agent: "room" as const,
        scope: "room" as const,
        triggered_by: null,
        task_id: input.id,
        intent: "system_event",
        artifacts: [],
        status: "ok" as const,
        confidence: 1,
        assumptions: [],
        risks: [],
        need_human: false,
        explanation: "system event"
      }
    })),
    ...(input.chats || []).map((timestamp, index) => ({
      id: `chat-${input.id}-${index}`,
      timestamp,
      phase: "open_room" as const,
      envelope: {
        message_type: "chat" as const,
        from_agent: "agent",
        to_agent: "room" as const,
        scope: "room" as const,
        triggered_by: null,
        task_id: input.id,
        intent: "message",
        artifacts: [],
        status: "ok" as const,
        confidence: 0.7,
        assumptions: [],
        risks: [],
        need_human: false,
        explanation: "hello"
      }
    })),
    ...(input.proposals || []).map((timestamp, index) => ({
      id: `proposal-${input.id}-${index}`,
      timestamp,
      phase: "open_room" as const,
      envelope: {
        message_type: "proposal" as const,
        from_agent: "agent",
        to_agent: "room" as const,
        scope: "room" as const,
        triggered_by: null,
        task_id: input.id,
        intent: "proposal",
        artifacts: [],
        status: "ok" as const,
        confidence: 0.8,
        assumptions: [],
        risks: [],
        need_human: false,
        explanation: "proposal"
      }
    }))
  ];

  return {
    id: input.id,
    name: input.id,
    task: "cleanup test",
    subnest: "general",
    settings: {
      pythonShellEnabled: false,
      webSearchEnabled: false,
      isPublic: true
    },
    status: "open",
    phase: "open_room",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    agentIds: [],
    connectedAgents: [],
    pythonJobs: [],
    timeline,
    artifacts: []
  };
}

function cloneRoom(room: RoomSnapshot): RoomSnapshot {
  return JSON.parse(JSON.stringify(room)) as RoomSnapshot;
}
