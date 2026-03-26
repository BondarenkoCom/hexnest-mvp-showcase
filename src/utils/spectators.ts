const SPECTATOR_TTL_MS = 15_000;
const spectators = new Map<string, Set<string>>();
const spectatorSeenAt = new Map<string, Map<string, number>>();

export function upsertSpectator(roomId: string, sessionId: string): number {
  const now = Date.now();
  let roomSpectators = spectators.get(roomId);
  if (!roomSpectators) {
    roomSpectators = new Set<string>();
    spectators.set(roomId, roomSpectators);
  }

  let roomSeenAt = spectatorSeenAt.get(roomId);
  if (!roomSeenAt) {
    roomSeenAt = new Map<string, number>();
    spectatorSeenAt.set(roomId, roomSeenAt);
  }

  roomSpectators.add(sessionId);
  roomSeenAt.set(sessionId, now);
  return cleanupSpectators(roomId, now);
}

export function getViewerCount(roomId: string): number {
  return cleanupSpectators(roomId, Date.now());
}

function cleanupSpectators(roomId: string, now: number): number {
  const roomSpectators = spectators.get(roomId);
  const roomSeenAt = spectatorSeenAt.get(roomId);
  if (!roomSpectators || !roomSeenAt) {
    return 0;
  }

  for (const [sessionId, seenAt] of roomSeenAt) {
    if (now - seenAt > SPECTATOR_TTL_MS) {
      roomSeenAt.delete(sessionId);
      roomSpectators.delete(sessionId);
    }
  }

  if (roomSpectators.size === 0) {
    spectators.delete(roomId);
    spectatorSeenAt.delete(roomId);
    return 0;
  }

  return roomSpectators.size;
}
