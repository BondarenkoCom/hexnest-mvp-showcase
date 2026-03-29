import { IAppStore } from "../orchestration/RoomStore";
import { RoomSnapshot } from "../types/protocol";
import { getCanonicalPublicBaseUrl } from "./html";
import { WebhookPublisher } from "../webhooks/WebhookPublisher";

export interface InactiveRoomCleanupOptions {
  inactivityMs: number;
  nowMs?: number;
}

export interface InactiveRoomCleanupResult {
  scanned: number;
  deletedRoomIds: string[];
  failedRoomIds: string[];
}

type CleanupStore = Pick<IAppStore, "listRooms" | "getRoom" | "deleteRoom">;

export async function cleanupInactiveRooms(
  store: CleanupStore,
  webhooks: WebhookPublisher | undefined,
  options: InactiveRoomCleanupOptions
): Promise<InactiveRoomCleanupResult> {
  const inactivityMs = Math.max(0, Math.floor(Number(options.inactivityMs) || 0));
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const cutoffMs = nowMs - inactivityMs;

  const rooms = await store.listRooms();
  const deletedRoomIds: string[] = [];
  const failedRoomIds: string[] = [];
  const baseUrl = getCanonicalPublicBaseUrl();

  for (const roomMeta of rooms) {
    try {
      if ((roomMeta.messageCount ?? 0) > 0) {
        // Only purge empty rooms. Any real conversation keeps the room.
        continue;
      }

      const room = await store.getRoom(roomMeta.id);
      if (!room) {
        continue;
      }

      if (hasAnyUserOrAgentMessages(room)) {
        continue;
      }

      const inactivityAnchorMs = safeParseTimestamp(room.createdAt);
      if (inactivityAnchorMs === null || inactivityAnchorMs > cutoffMs) {
        continue;
      }

      const deleted = await store.deleteRoom(room.id);
      if (!deleted) {
        continue;
      }

      deletedRoomIds.push(room.id);

      webhooks?.publish(
        "room.deleted",
        {
          roomId: room.id,
          roomName: room.name,
          reason: "inactive_cleanup",
          inactiveSince: new Date(inactivityAnchorMs).toISOString(),
          inactivityMs
        },
        {
          rooms: `${baseUrl}/api/rooms`
        }
      );
    } catch {
      failedRoomIds.push(roomMeta.id);
    }
  }

  return {
    scanned: rooms.length,
    deletedRoomIds,
    failedRoomIds
  };
}

function hasAnyUserOrAgentMessages(room: RoomSnapshot): boolean {
  if ((room.messageCount ?? 0) > 0) {
    return true;
  }
  for (const event of room.timeline) {
    if (event?.envelope?.message_type && event.envelope.message_type !== "system") {
      return true;
    }
  }
  return false;
}

function safeParseTimestamp(value: string): number | null {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}
