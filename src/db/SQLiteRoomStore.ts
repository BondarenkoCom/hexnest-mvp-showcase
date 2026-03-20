import fs from "fs";
import path from "path";
import { RoomSnapshot } from "../types/protocol";
import { newId, nowIso } from "../utils/ids";
import { RoomStore } from "../orchestration/RoomStore";
import { CreateRoomInput } from "../orchestration/RoomStore";

const sqlite = require("node:sqlite");

interface RoomRow {
  snapshot_json: string;
}

export class SQLiteRoomStore implements RoomStore {
  private readonly db: any;
  private readonly getRoomStmt: any;
  private readonly listRoomsStmt: any;
  private readonly upsertRoomStmt: any;

  constructor(dbPath: string) {
    const normalizedPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });

    this.db = new sqlite.DatabaseSync(normalizedPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        agent_ids_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rooms_updated_at ON rooms(updated_at DESC);
    `);

    this.getRoomStmt = this.db.prepare(`
      SELECT snapshot_json
      FROM rooms
      WHERE id = @id
      LIMIT 1
    `);

    this.listRoomsStmt = this.db.prepare(`
      SELECT snapshot_json
      FROM rooms
      ORDER BY updated_at DESC
    `);

    this.upsertRoomStmt = this.db.prepare(`
      INSERT INTO rooms (
        id,
        task,
        status,
        phase,
        created_at,
        updated_at,
        agent_ids_json,
        snapshot_json
      )
      VALUES (
        @id,
        @task,
        @status,
        @phase,
        @createdAt,
        @updatedAt,
        @agentIdsJson,
        @snapshotJson
      )
      ON CONFLICT(id) DO UPDATE SET
        task = excluded.task,
        status = excluded.status,
        phase = excluded.phase,
        updated_at = excluded.updated_at,
        agent_ids_json = excluded.agent_ids_json,
        snapshot_json = excluded.snapshot_json
    `);
  }

  public createRoom(input: CreateRoomInput): RoomSnapshot {
    const now = nowIso();
    const room: RoomSnapshot = {
      id: newId(),
      name: input.name,
      task: input.task,
      subnest: input.subnest || "general",
      settings: {
        pythonShellEnabled: input.pythonShellEnabled,
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

    this.persist(room);
    return room;
  }

  public getRoom(roomId: string): RoomSnapshot | undefined {
    const row = this.getRoomStmt.get({ id: roomId }) as RoomRow | undefined;
    if (!row) {
      return undefined;
    }
    return this.parseSnapshot(row.snapshot_json);
  }

  public listRooms(): RoomSnapshot[] {
    const rows = this.listRoomsStmt.all() as RoomRow[];
    return rows.map((row) => this.parseSnapshot(row.snapshot_json));
  }

  public saveRoom(room: RoomSnapshot): RoomSnapshot {
    room.updatedAt = nowIso();
    this.persist(room);
    return room;
  }

  private persist(room: RoomSnapshot): void {
    const payload = {
      id: room.id,
      task: room.task,
      status: room.status,
      phase: room.phase,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      agentIdsJson: JSON.stringify(room.agentIds),
      snapshotJson: JSON.stringify(room)
    };

    this.upsertRoomStmt.run(payload);
  }

  private parseSnapshot(raw: string): RoomSnapshot {
    const room = JSON.parse(raw) as RoomSnapshot;
    if (!room.name || room.name.trim().length === 0) {
      room.name = `Room ${room.id.slice(0, 8)}`;
    }
    if (!room.subnest) {
      room.subnest = "general";
    }
    if (!room.settings) {
      room.settings = { pythonShellEnabled: false, isPublic: true };
    }
    if (typeof room.settings.pythonShellEnabled !== "boolean") {
      room.settings.pythonShellEnabled = false;
    }
    if (typeof room.settings.isPublic !== "boolean") {
      room.settings.isPublic = true;
    }
    if (!room.timeline) {
      room.timeline = [];
    }
    for (const event of room.timeline) {
      if (!event?.envelope) {
        continue;
      }
      if (event.envelope.scope !== "room" && event.envelope.scope !== "direct") {
        event.envelope.scope = event.envelope.to_agent === "room" ? "room" : "direct";
      }
      if (typeof event.envelope.triggered_by !== "string" || event.envelope.triggered_by.length === 0) {
        event.envelope.triggered_by = null;
      }
    }
    if (!room.artifacts) {
      room.artifacts = [];
    }
    if (!room.agentIds) {
      room.agentIds = [];
    }
    if (!room.connectedAgents) {
      room.connectedAgents = [];
    }
    if (!room.pythonJobs) {
      room.pythonJobs = [];
    }
    return room;
  }
}
