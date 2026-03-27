import { Pool, PoolClient } from "pg";
import { DirectoryAgent, RoomSnapshot, SharedLink } from "../types/protocol";
import { IAppStore, CreateRoomInput } from "../orchestration/RoomStore";
import { newId, nowIso } from "../utils/ids";

export class PostgresRoomStore implements IAppStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: process.env.PG_SSL !== "false" ? { rejectUnauthorized: false } : false
    });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
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

        CREATE TABLE IF NOT EXISTS shared_links (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          short_code TEXT UNIQUE NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(room_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_shared_links_room_id ON shared_links(room_id);
      `);
    } finally {
      client.release();
    }
  }

  async createRoom(input: CreateRoomInput): Promise<RoomSnapshot> {
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
    await this.persist(room);
    return room;
  }

  async getRoom(roomId: string): Promise<RoomSnapshot | undefined> {
    const result = await this.pool.query<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM rooms WHERE id = $1 LIMIT 1`,
      [roomId]
    );
    if (result.rows.length === 0) return undefined;
    return this.parseSnapshot(result.rows[0].snapshot_json);
  }

  async listRooms(): Promise<RoomSnapshot[]> {
    const result = await this.pool.query<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM rooms ORDER BY updated_at DESC`
    );
    return result.rows.map(r => this.parseSnapshot(r.snapshot_json));
  }

  async saveRoom(room: RoomSnapshot): Promise<RoomSnapshot> {
    room.updatedAt = nowIso();
    await this.persist(room);
    return room;
  }

  async deleteRoom(roomId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM shared_links WHERE room_id = $1`, [roomId]);
      const result = await client.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
      await client.query("COMMIT");
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteMessage(roomId: string, messageId: string): Promise<boolean> {
    const room = await this.getRoom(roomId);
    if (!room) return false;

    const nextTimeline = room.timeline.filter(e => e.id !== messageId);
    if (nextTimeline.length === room.timeline.length) return false;

    room.timeline = nextTimeline;
    await this.pool.query(
      `DELETE FROM shared_links WHERE room_id = $1 AND message_id = $2`,
      [roomId, messageId]
    );
    await this.saveRoom(room);
    return true;
  }

  async clearTimeline(roomId: string): Promise<boolean> {
    const room = await this.getRoom(roomId);
    if (!room) return false;

    room.timeline = [];
    await this.pool.query(`DELETE FROM shared_links WHERE room_id = $1`, [roomId]);
    await this.saveRoom(room);
    return true;
  }

  async addDirectoryAgent(input: {
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
    await this.pool.query(
      `INSERT INTO agent_directory (id, name, description, protocol, endpoint_url, owner, category, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [agent.id, agent.name, agent.description, agent.protocol, agent.endpointUrl, agent.owner, agent.category, agent.status, agent.createdAt]
    );
    return agent;
  }

  async listDirectoryAgents(): Promise<DirectoryAgent[]> {
    const result = await this.pool.query<{
      id: string; name: string; description: string; protocol: string;
      endpoint_url: string; owner: string; category: string; status: string; created_at: string;
    }>(`SELECT id, name, description, protocol, endpoint_url, owner, category, status, created_at
        FROM agent_directory ORDER BY category, created_at DESC`);
    return result.rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      protocol: r.protocol,
      endpointUrl: r.endpoint_url,
      owner: r.owner,
      category: r.category || "utility",
      status: r.status as DirectoryAgent["status"],
      createdAt: r.created_at
    }));
  }

  async updateDirectoryAgentStatus(id: string, status: DirectoryAgent["status"]): Promise<void> {
    await this.pool.query(`UPDATE agent_directory SET status = $1 WHERE id = $2`, [status, id]);
  }

  async updateDirectoryAgentCategory(id: string, category: string): Promise<void> {
    await this.pool.query(`UPDATE agent_directory SET category = $1 WHERE id = $2`, [category, id]);
  }

  async getSharedLinkForMessage(roomId: string, messageId: string): Promise<SharedLink | undefined> {
    const result = await this.pool.query<{
      id: string; room_id: string; message_id: string; short_code: string; created_at: string;
    }>(
      `SELECT id, room_id, message_id, short_code, created_at FROM shared_links
       WHERE room_id = $1 AND message_id = $2 LIMIT 1`,
      [roomId, messageId]
    );
    if (result.rows.length === 0) return undefined;
    return this.mapSharedLink(result.rows[0]);
  }

  async getSharedLinkByShortCode(shortCode: string): Promise<SharedLink | undefined> {
    const result = await this.pool.query<{
      id: string; room_id: string; message_id: string; short_code: string; created_at: string;
    }>(
      `SELECT id, room_id, message_id, short_code, created_at FROM shared_links
       WHERE short_code = $1 LIMIT 1`,
      [shortCode]
    );
    if (result.rows.length === 0) return undefined;
    return this.mapSharedLink(result.rows[0]);
  }

  async getOrCreateSharedLink(roomId: string, messageId: string, shortCode: string): Promise<SharedLink> {
    const existing = await this.getSharedLinkForMessage(roomId, messageId);
    if (existing) return existing;

    const link: SharedLink = {
      id: newId(),
      roomId,
      messageId,
      shortCode,
      createdAt: nowIso()
    };

    try {
      await this.pool.query(
        `INSERT INTO shared_links (id, room_id, message_id, short_code, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [link.id, link.roomId, link.messageId, link.shortCode, link.createdAt]
      );
      return link;
    } catch (err: unknown) {
      const byMessage = await this.getSharedLinkForMessage(roomId, messageId);
      if (byMessage) return byMessage;

      const byShortCode = await this.getSharedLinkByShortCode(shortCode);
      if (byShortCode && (byShortCode.roomId !== roomId || byShortCode.messageId !== messageId)) {
        throw new Error(`shared short code collision: ${shortCode}`);
      }

      throw err;
    }
  }

  async countSharedLinksByRoom(roomId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM shared_links WHERE room_id = $1`,
      [roomId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async persist(room: RoomSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO rooms (id, task, status, phase, created_at, updated_at, agent_ids_json, snapshot_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         task = EXCLUDED.task,
         status = EXCLUDED.status,
         phase = EXCLUDED.phase,
         updated_at = EXCLUDED.updated_at,
         agent_ids_json = EXCLUDED.agent_ids_json,
         snapshot_json = EXCLUDED.snapshot_json`,
      [
        room.id,
        room.task,
        room.status,
        room.phase,
        room.createdAt,
        room.updatedAt,
        JSON.stringify(room.agentIds),
        JSON.stringify(room)
      ]
    );
  }

  private parseSnapshot(raw: string): RoomSnapshot {
    const room = JSON.parse(raw) as RoomSnapshot;
    if (!room.name || room.name.trim().length === 0) room.name = `Room ${room.id.slice(0, 8)}`;
    if (!room.subnest) room.subnest = "general";
    if (!room.settings) room.settings = { pythonShellEnabled: false, isPublic: true };
    if (typeof room.settings.pythonShellEnabled !== "boolean") room.settings.pythonShellEnabled = false;
    if (typeof room.settings.isPublic !== "boolean") room.settings.isPublic = true;
    if (typeof room.settings.webSearchEnabled !== "boolean") room.settings.webSearchEnabled = false;
    if (!room.timeline) room.timeline = [];
    for (const event of room.timeline) {
      if (!event?.envelope) continue;
      if (event.envelope.scope !== "room" && event.envelope.scope !== "direct") {
        event.envelope.scope = event.envelope.to_agent === "room" ? "room" : "direct";
      }
      if (typeof event.envelope.triggered_by !== "string" || event.envelope.triggered_by.length === 0) {
        event.envelope.triggered_by = null;
      }
    }
    if (!room.artifacts) room.artifacts = [];
    if (!room.agentIds) room.agentIds = [];
    if (!room.connectedAgents) room.connectedAgents = [];
    if (!room.pythonJobs) room.pythonJobs = [];
    return room;
  }

  private mapSharedLink(row: {
    id: string; room_id: string; message_id: string; short_code: string; created_at: string;
  }): SharedLink {
    return {
      id: row.id,
      roomId: row.room_id,
      messageId: row.message_id,
      shortCode: row.short_code,
      createdAt: row.created_at
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
