import { createHash, randomBytes } from "crypto";
import { Pool } from "pg";
import {
  DirectoryAgent,
  PlatformAgent,
  RegisterAgentInput,
  RoomSnapshot,
  SharedLink
} from "../types/protocol";
import { IAppStore, CreateRoomInput } from "../orchestration/RoomStore";
import { newId, nowIso } from "../utils/ids";

export class PostgresRoomStore implements IAppStore {
  private static readonly NODE_ID = "hexnest-main";
  private static readonly TOKEN_PREFIX_LENGTH = 8;
  private static readonly TOKEN_PREFIX = "hxn_live_";
  private readonly pool: Pool;

  private static toOptionalText(value: string | undefined): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private static toStringArray(value: string[] | undefined): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  private static tokenPrefixFromToken(token: string): string {
    if (token.startsWith(PostgresRoomStore.TOKEN_PREFIX)) {
      return token.slice(
        PostgresRoomStore.TOKEN_PREFIX.length,
        PostgresRoomStore.TOKEN_PREFIX.length + PostgresRoomStore.TOKEN_PREFIX_LENGTH
      );
    }
    return token.slice(0, PostgresRoomStore.TOKEN_PREFIX_LENGTH);
  }

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: process.env.PG_SSL !== "false" ? { rejectUnauthorized: false } : false,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    });
    this.pool.on("error", (err) => {
      console.error("[pg] idle client error:", err);
    });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT 1");
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
    const [roomResult, timelineResult] = await Promise.all([
      this.pool.query<{ snapshot_json: string }>(
        `SELECT snapshot_json FROM rooms WHERE id = $1 LIMIT 1`,
        [roomId]
      ),
      this.pool.query<{ id: string; timestamp: Date; phase: string; envelope_json: import("../types/protocol").AgentEnvelope }>(
        `SELECT id, timestamp, phase, envelope_json FROM room_timeline
         WHERE room_id = $1 ORDER BY timestamp ASC`,
        [roomId]
      )
    ]);
    if (roomResult.rows.length === 0) return undefined;
    const room = this.parseSnapshot(roomResult.rows[0].snapshot_json);
    room.timeline = timelineResult.rows.map(r => this.parseEvent(r));
    return room;
  }

  async listRooms(): Promise<RoomSnapshot[]> {
    const result = await this.pool.query<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM rooms ORDER BY updated_at DESC`
    );
    return result.rows.map(r => {
      const room = this.parseSnapshot(r.snapshot_json);
      room.timeline = [];
      return room;
    });
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
      await client.query(`DELETE FROM room_timeline WHERE room_id = $1`, [roomId]);
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `DELETE FROM room_timeline WHERE room_id = $1 AND id = $2`,
        [roomId, messageId]
      );
      if ((result.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `DELETE FROM shared_links WHERE room_id = $1 AND message_id = $2`,
        [roomId, messageId]
      );
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async clearTimeline(roomId: string): Promise<boolean> {
    const exists = await this.pool.query<{ id: string }>(
      `SELECT id FROM rooms WHERE id = $1 LIMIT 1`,
      [roomId]
    );
    if (exists.rows.length === 0) return false;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM room_timeline WHERE room_id = $1`, [roomId]);
      await client.query(`DELETE FROM shared_links WHERE room_id = $1`, [roomId]);
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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

  async registerAgent(input: RegisterAgentInput): Promise<PlatformAgent> {
    const nickname = String(input.nickname || "").trim();
    const now = nowIso();
    const handle = `${nickname}@${PostgresRoomStore.NODE_ID}`;
    const specialty = PostgresRoomStore.toStringArray(input.specialty);
    const tags = PostgresRoomStore.toStringArray(input.tags);

    const agent: PlatformAgent = {
      id: newId(),
      nickname,
      handle,
      organization: PostgresRoomStore.toOptionalText(input.organization) || undefined,
      specialty,
      tags,
      theme: PostgresRoomStore.toOptionalText(input.theme) || "dark",
      modelFamily: PostgresRoomStore.toOptionalText(input.modelFamily) || undefined,
      publicKey: PostgresRoomStore.toOptionalText(input.publicKey) || undefined,
      verificationUrl: PostgresRoomStore.toOptionalText(input.verificationUrl) || undefined,
      homeUrl: PostgresRoomStore.toOptionalText(input.homeUrl) || undefined,
      createdAt: now,
      updatedAt: now
    };

    await this.pool.query(
      `INSERT INTO platform_agents (
         id, nickname, handle, organization, specialty, tags, theme,
         model_family, public_key, verification_url, home_url, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        agent.id,
        agent.nickname,
        agent.handle,
        agent.organization || null,
        JSON.stringify(agent.specialty),
        JSON.stringify(agent.tags),
        agent.theme,
        agent.modelFamily || null,
        agent.publicKey || null,
        agent.verificationUrl || null,
        agent.homeUrl || null,
        agent.createdAt,
        agent.updatedAt
      ]
    );

    return agent;
  }

  async getAgentById(agentId: string): Promise<PlatformAgent | null> {
    const result = await this.pool.query<PlatformAgentRow>(
      `SELECT
         id, nickname, handle, organization, specialty, tags, theme,
         model_family, public_key, verification_url, home_url, created_at, updated_at
       FROM platform_agents
       WHERE id = $1
       LIMIT 1`,
      [agentId]
    );
    if (result.rows.length === 0) return null;
    return this.mapPlatformAgent(result.rows[0]);
  }

  async getAgentByNickname(nickname: string): Promise<PlatformAgent | null> {
    const result = await this.pool.query<PlatformAgentRow>(
      `SELECT
         id, nickname, handle, organization, specialty, tags, theme,
         model_family, public_key, verification_url, home_url, created_at, updated_at
       FROM platform_agents
       WHERE LOWER(nickname) = LOWER($1)
       LIMIT 1`,
      [nickname]
    );
    if (result.rows.length === 0) return null;
    return this.mapPlatformAgent(result.rows[0]);
  }

  async getAgentByHandle(handle: string): Promise<PlatformAgent | null> {
    const result = await this.pool.query<PlatformAgentRow>(
      `SELECT
         id, nickname, handle, organization, specialty, tags, theme,
         model_family, public_key, verification_url, home_url, created_at, updated_at
       FROM platform_agents
       WHERE LOWER(handle) = LOWER($1)
       LIMIT 1`,
      [handle]
    );
    if (result.rows.length === 0) return null;
    return this.mapPlatformAgent(result.rows[0]);
  }

  async listPlatformAgents(): Promise<PlatformAgent[]> {
    const result = await this.pool.query<PlatformAgentRow>(
      `SELECT
         id, nickname, handle, organization, specialty, tags, theme,
         model_family, public_key, verification_url, home_url, created_at, updated_at
       FROM platform_agents
       ORDER BY created_at DESC`
    );
    return result.rows.map((row) => this.mapPlatformAgent(row));
  }

  async createToken(agentId: string, scopes: string): Promise<{ token: string; expiresAt: string }> {
    const token = `${PostgresRoomStore.TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const tokenPrefix = PostgresRoomStore.tokenPrefixFromToken(token);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    await this.pool.query(
      `INSERT INTO agent_tokens (
         id, agent_id, token_hash, token_prefix, issuer_node_id, version, scopes, created_at, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        newId(),
        agentId,
        tokenHash,
        tokenPrefix,
        PostgresRoomStore.NODE_ID,
        1,
        scopes || "agent",
        createdAt,
        expiresAt
      ]
    );
    return { token, expiresAt };
  }

  async validateToken(token: string): Promise<{ agent: PlatformAgent; scopes: string } | null> {
    const trimmed = String(token || "").trim();
    if (!trimmed) {
      return null;
    }
    const tokenHash = createHash("sha256").update(trimmed).digest("hex");
    const tokenPrefix = PostgresRoomStore.tokenPrefixFromToken(trimmed);
    const now = nowIso();
    const result = await this.pool.query<TokenValidationRow>(
      `SELECT
         t.token_hash, t.scopes, t.expires_at, t.revoked_at,
         a.id, a.nickname, a.handle, a.organization, a.specialty, a.tags, a.theme,
         a.model_family, a.public_key, a.verification_url, a.home_url, a.created_at, a.updated_at
       FROM agent_tokens t
       JOIN platform_agents a ON a.id = t.agent_id
       WHERE t.token_prefix = $1
         AND t.token_hash = $2
         AND t.revoked_at IS NULL
         AND t.expires_at > $3
       LIMIT 1`,
      [tokenPrefix, tokenHash, now]
    );
    if (result.rows.length === 0) {
      return null;
    }
    const matched = result.rows[0];
    return {
      agent: this.mapPlatformAgent(matched),
      scopes: matched.scopes || "agent"
    };
  }

  async updateTokenLastUsed(tokenPrefix: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_tokens
       SET last_used_at = $2
       WHERE token_prefix = $1
         AND revoked_at IS NULL`,
      [tokenPrefix, nowIso()]
    );
  }

  private async persist(room: RoomSnapshot): Promise<void> {
    const { timeline, ...roomWithoutTimeline } = room;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
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
          JSON.stringify(roomWithoutTimeline)
        ]
      );
      for (const event of timeline) {
        await client.query(
          `INSERT INTO room_timeline (id, room_id, timestamp, phase, envelope_json)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [event.id, room.id, event.timestamp, event.phase, JSON.stringify(event.envelope)]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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
    if (!room.artifacts) room.artifacts = [];
    if (!room.agentIds) room.agentIds = [];
    if (!room.connectedAgents) room.connectedAgents = [];
    if (!room.pythonJobs) room.pythonJobs = [];
    return room;
  }

  private parseEvent(row: { id: string; timestamp: Date; phase: string; envelope_json: import("../types/protocol").AgentEnvelope }): import("../types/protocol").RoomEvent {
    const envelope = row.envelope_json as import("../types/protocol").AgentEnvelope;
    if (envelope.scope !== "room" && envelope.scope !== "direct") {
      envelope.scope = envelope.to_agent === "room" ? "room" : "direct";
    }
    if (typeof envelope.triggered_by !== "string" || envelope.triggered_by.length === 0) {
      envelope.triggered_by = null;
    }
    return {
      id: row.id,
      timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
      phase: row.phase as import("../types/protocol").RoomPhase,
      envelope
    };
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

  private mapPlatformAgent(row: PlatformAgentRow | TokenValidationRow): PlatformAgent {
    return {
      id: row.id,
      nickname: row.nickname,
      handle: row.handle,
      organization: row.organization || undefined,
      specialty: this.parseJsonArray(row.specialty),
      tags: this.parseJsonArray(row.tags),
      theme: row.theme || "dark",
      modelFamily: row.model_family || undefined,
      publicKey: row.public_key || undefined,
      verificationUrl: row.verification_url || undefined,
      homeUrl: row.home_url || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private parseJsonArray(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => String(item || "").trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface PlatformAgentRow {
  id: string;
  nickname: string;
  handle: string;
  organization: string | null;
  specialty: string;
  tags: string;
  theme: string | null;
  model_family: string | null;
  public_key: string | null;
  verification_url: string | null;
  home_url: string | null;
  created_at: string;
  updated_at: string;
}

interface TokenValidationRow extends PlatformAgentRow {
  token_hash: string;
  scopes: string;
  expires_at: string;
  revoked_at: string | null;
}
