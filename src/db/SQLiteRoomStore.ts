import fs from "fs";
import path from "path";
import { DirectoryAgent, RoomSnapshot, SharedLink } from "../types/protocol";
import { newId, nowIso } from "../utils/ids";
import { IAppStore, CreateRoomInput } from "../orchestration/RoomStore";

export type { DirectoryAgent, SharedLink };

const sqlite = require("node:sqlite");

interface RoomRow {
  snapshot_json: string;
}

interface SharedLinkRow {
  id: string;
  room_id: string;
  message_id: string;
  short_code: string;
  created_at: string;
}

interface CountRow {
  count: number;
}

export class SQLiteRoomStore implements IAppStore {
  private readonly db: any;
  private readonly getRoomStmt: any;
  private readonly listRoomsStmt: any;
  private readonly upsertRoomStmt: any;
  private readonly insertAgentDirStmt: any;
  private readonly listAgentDirStmt: any;
  private readonly getAgentDirStmt: any;
  private readonly updateAgentDirStatusStmt: any;
  private readonly getSharedLinkByMessageStmt: any;
  private readonly getSharedLinkByShortCodeStmt: any;
  private readonly insertSharedLinkStmt: any;
  private readonly countSharedLinksByRoomStmt: any;
  private readonly deleteRoomStmt: any;
  private readonly deleteSharedLinksByRoomStmt: any;
  private readonly deleteSharedLinksByMessageStmt: any;

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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_directory (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        protocol TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        owner TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'utility',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_dir_status ON agent_directory(status);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shared_links (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        short_code TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_links_room_message
      ON shared_links(room_id, message_id);
      CREATE INDEX IF NOT EXISTS idx_shared_links_room_id ON shared_links(room_id);
    `);

    // Migration: add category column if missing (existing DBs)
    try {
      this.db.exec(`ALTER TABLE agent_directory ADD COLUMN category TEXT NOT NULL DEFAULT 'utility'`);
    } catch {
      // column already exists — ignore
    }

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

    this.insertAgentDirStmt = this.db.prepare(`
      INSERT INTO agent_directory (id, name, description, protocol, endpoint_url, owner, category, status, created_at)
      VALUES (@id, @name, @description, @protocol, @endpointUrl, @owner, @category, @status, @createdAt)
    `);

    this.listAgentDirStmt = this.db.prepare(`
      SELECT id, name, description, protocol, endpoint_url, owner, category, status, created_at
      FROM agent_directory
      ORDER BY category, created_at DESC
    `);

    this.getAgentDirStmt = this.db.prepare(`
      SELECT id, name, description, protocol, endpoint_url, owner, category, status, created_at
      FROM agent_directory
      WHERE id = @id
      LIMIT 1
    `);

    this.updateAgentDirStatusStmt = this.db.prepare(`
      UPDATE agent_directory SET status = @status WHERE id = @id
    `);

    this.getSharedLinkByMessageStmt = this.db.prepare(`
      SELECT id, room_id, message_id, short_code, created_at
      FROM shared_links
      WHERE room_id = @roomId AND message_id = @messageId
      LIMIT 1
    `);

    this.getSharedLinkByShortCodeStmt = this.db.prepare(`
      SELECT id, room_id, message_id, short_code, created_at
      FROM shared_links
      WHERE short_code = @shortCode
      LIMIT 1
    `);

    this.insertSharedLinkStmt = this.db.prepare(`
      INSERT INTO shared_links (id, room_id, message_id, short_code, created_at)
      VALUES (@id, @roomId, @messageId, @shortCode, @createdAt)
    `);

    this.countSharedLinksByRoomStmt = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM shared_links
      WHERE room_id = @roomId
    `);

    this.deleteRoomStmt = this.db.prepare(`
      DELETE FROM rooms
      WHERE id = @id
    `);

    this.deleteSharedLinksByRoomStmt = this.db.prepare(`
      DELETE FROM shared_links
      WHERE room_id = @roomId
    `);

    this.deleteSharedLinksByMessageStmt = this.db.prepare(`
      DELETE FROM shared_links
      WHERE room_id = @roomId AND message_id = @messageId
    `);
  }

  public async createRoom(input: CreateRoomInput): Promise<RoomSnapshot> {
    const now = nowIso();
    const room: RoomSnapshot = {
      id: newId(),
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

    this.persist(room);
    return Promise.resolve(room);
  }

  public async getRoom(roomId: string): Promise<RoomSnapshot | undefined> {
    const row = this.getRoomStmt.get({ id: roomId }) as RoomRow | undefined;
    if (!row) return Promise.resolve(undefined);
    return Promise.resolve(this.parseSnapshot(row.snapshot_json));
  }

  public async listRooms(): Promise<RoomSnapshot[]> {
    const rows = this.listRoomsStmt.all() as RoomRow[];
    return Promise.resolve(rows.map((row) => this.parseSnapshot(row.snapshot_json)));
  }

  public async saveRoom(room: RoomSnapshot): Promise<RoomSnapshot> {
    room.updatedAt = nowIso();
    this.persist(room);
    return Promise.resolve(room);
  }

  // ── Agent Directory ──

  public async addDirectoryAgent(input: {
    name: string;
    description: string;
    protocol: string;
    endpointUrl: string;
    owner: string;
    category?: string;
  }): Promise<DirectoryAgent> {
    const agent: DirectoryAgent = {
      id: newId(),
      name: input.name,
      description: input.description,
      protocol: input.protocol,
      endpointUrl: input.endpointUrl,
      owner: input.owner,
      category: input.category || "utility",
      status: "pending",
      createdAt: nowIso()
    };
    this.insertAgentDirStmt.run({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      protocol: agent.protocol,
      endpointUrl: agent.endpointUrl,
      owner: agent.owner,
      category: agent.category,
      status: agent.status,
      createdAt: agent.createdAt
    });
    return Promise.resolve(agent);
  }

  public async listDirectoryAgents(): Promise<DirectoryAgent[]> {
    const rows = this.listAgentDirStmt.all() as Array<{
      id: string; name: string; description: string; protocol: string;
      endpoint_url: string; owner: string; category: string; status: string; created_at: string;
    }>;
    return Promise.resolve(rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      protocol: r.protocol,
      endpointUrl: r.endpoint_url,
      owner: r.owner,
      category: r.category || "utility",
      status: r.status as DirectoryAgent["status"],
      createdAt: r.created_at
    })));
  }

  public async updateDirectoryAgentStatus(id: string, status: DirectoryAgent["status"]): Promise<void> {
    this.updateAgentDirStatusStmt.run({ id, status });
  }

  public async updateDirectoryAgentCategory(id: string, category: string): Promise<void> {
    this.db.prepare(`UPDATE agent_directory SET category = @category WHERE id = @id`).run({ id, category });
  }

  public async getSharedLinkForMessage(roomId: string, messageId: string): Promise<SharedLink | undefined> {
    const row = this.getSharedLinkByMessageStmt.get({ roomId, messageId }) as SharedLinkRow | undefined;
    return Promise.resolve(row ? this.mapSharedLink(row) : undefined);
  }

  public async getSharedLinkByShortCode(shortCode: string): Promise<SharedLink | undefined> {
    const row = this.getSharedLinkByShortCodeStmt.get({ shortCode }) as SharedLinkRow | undefined;
    return Promise.resolve(row ? this.mapSharedLink(row) : undefined);
  }

  public async getOrCreateSharedLink(roomId: string, messageId: string, shortCode: string): Promise<SharedLink> {
    const existing = await this.getSharedLinkForMessage(roomId, messageId);
    if (existing) {
      return existing;
    }

    const link: SharedLink = {
      id: newId(),
      roomId,
      messageId,
      shortCode,
      createdAt: nowIso()
    };

    try {
      this.insertSharedLinkStmt.run({
        id: link.id,
        roomId: link.roomId,
        messageId: link.messageId,
        shortCode: link.shortCode,
        createdAt: link.createdAt
      });
      return link;
    } catch (error) {
      const byMessage = await this.getSharedLinkForMessage(roomId, messageId);
      if (byMessage) {
        return byMessage;
      }

      const byShortCode = await this.getSharedLinkByShortCode(shortCode);
      if (byShortCode && (byShortCode.roomId !== roomId || byShortCode.messageId !== messageId)) {
        throw new Error(`shared short code collision: ${shortCode}`);
      }

      throw error;
    }
  }

  public async countSharedLinksByRoom(roomId: string): Promise<number> {
    const row = this.countSharedLinksByRoomStmt.get({ roomId }) as CountRow | undefined;
    return Promise.resolve(Number(row?.count || 0));
  }

  public async deleteRoom(roomId: string): Promise<boolean> {
    const result = this.deleteRoomStmt.run({ id: roomId }) as { changes?: number } | undefined;
    const deleted = Number(result?.changes || 0) > 0;
    if (deleted) {
      this.deleteSharedLinksByRoomStmt.run({ roomId });
    }
    return Promise.resolve(deleted);
  }

  public async deleteMessage(roomId: string, messageId: string): Promise<boolean> {
    const room = await this.getRoom(roomId);
    if (!room) return Promise.resolve(false);

    const nextTimeline = room.timeline.filter((event) => event.id !== messageId);
    if (nextTimeline.length === room.timeline.length) return Promise.resolve(false);

    room.timeline = nextTimeline;
    this.deleteSharedLinksByMessageStmt.run({ roomId, messageId });
    await this.saveRoom(room);
    return Promise.resolve(true);
  }

  public async clearTimeline(roomId: string): Promise<boolean> {
    const room = await this.getRoom(roomId);
    if (!room) return Promise.resolve(false);

    room.timeline = [];
    this.deleteSharedLinksByRoomStmt.run({ roomId });
    await this.saveRoom(room);
    return Promise.resolve(true);
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
    if (typeof room.settings.webSearchEnabled !== "boolean") {
      room.settings.webSearchEnabled = false;
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

  private mapSharedLink(row: SharedLinkRow): SharedLink {
    return {
      id: row.id,
      roomId: row.room_id,
      messageId: row.message_id,
      shortCode: row.short_code,
      createdAt: row.created_at
    };
  }
}
