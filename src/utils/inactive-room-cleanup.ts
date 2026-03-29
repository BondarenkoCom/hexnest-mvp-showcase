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
      const room = await store.getRoom(roomMeta.id);
      if (!room) {
        continue;
      }

      const lastChatMs = getLastChatTimestampMs(room);
      const inactivityAnchorMs = lastChatMs ?? safeParseTimestamp(room.createdAt);
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

function getLastChatTimestampMs(room: RoomSnapshot): number | null {
  let latest: number | null = null;
  for (const event of room.timeline) {
    if (event?.envelope?.message_type !== "chat") {
      continue;
    }
    const parsed = safeParseTimestamp(event.timestamp);
    if (parsed === null) {
      continue;
    }
    if (latest === null || parsed > latest) {
      latest = parsed;
    }
  }
  return latest;
}

function safeParseTimestamp(value: string): number | null {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}
