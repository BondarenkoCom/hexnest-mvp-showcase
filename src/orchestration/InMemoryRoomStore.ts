import { RoomSnapshot } from "../types/protocol";
import { newId, nowIso } from "../utils/ids";
import { RoomStore } from "./RoomStore";
import { CreateRoomInput } from "./RoomStore";

export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, RoomSnapshot>();

  public createRoom(input: CreateRoomInput): RoomSnapshot {
    const id = newId();
    const now = nowIso();

    const room: RoomSnapshot = {
      id,
      name: input.name,
      task: input.task,
      subnest: input.subnest || "general",
      settings: {
        pythonShellEnabled: input.pythonShellEnabled,
        webSearchEnabled: input.webSearchEnabled,
        isPublic: true
      },
      status: "open",
      phase: "open_room",
      createdAt: now,
      updatedAt: now,
      agentIds: [...input.agentIds],
      connectedAgents: [],
      pythonJobs: [],
      timeline: [],
      artifacts: []
    };

    this.rooms.set(id, room);
    return room;
  }

  public getRoom(roomId: string): RoomSnapshot | undefined {
    return this.rooms.get(roomId);
  }

  public listRooms(): RoomSnapshot[] {
    return Array.from(this.rooms.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  public saveRoom(room: RoomSnapshot): RoomSnapshot {
    room.updatedAt = nowIso();
    this.rooms.set(room.id, room);
    return room;
  }
}
