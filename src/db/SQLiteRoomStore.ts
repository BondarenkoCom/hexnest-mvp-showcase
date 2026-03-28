import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import {
  DirectoryAgent,
  PlatformAgent,
  RegisterAgentInput,
  RoomSnapshot,
  SharedLink
} from "../types/protocol";
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
  private static readonly NODE_ID = "hexnest-main";
  private static readonly TOKEN_PREFIX = "hxn_live_";
  private static readonly TOKEN_PREFIX_LENGTH = 8;
  private readonly db: any;
  private readonly getRoomStmt: any;
  private readonly listRoomsStmt: any;
  private readonly upsertRoomStmt: any;
  private readonly getTimelineStmt: any;
  private readonly insertTimelineEventStmt: any;
  private readonly deleteTimelineByRoomStmt: any;
  private readonly deleteTimelineByEventStmt: any;
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_agents (
        id TEXT PRIMARY KEY,
        nickname TEXT UNIQUE NOT NULL,
        handle TEXT UNIQUE NOT NULL,
        organization TEXT,
        specialty TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        theme TEXT DEFAULT 'dark',
        model_family TEXT,
        public_key TEXT,
        verification_url TEXT,
        home_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_platform_agents_nickname ON platform_agents(nickname);
      CREATE INDEX IF NOT EXISTS idx_platform_agents_handle ON platform_agents(handle);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tokens (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        issuer_node_id TEXT NOT NULL DEFAULT 'hexnest-main',
        version INTEGER NOT NULL DEFAULT 1,
        scopes TEXT NOT NULL DEFAULT 'agent',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT,
        FOREIGN KEY(agent_id) REFERENCES platform_agents(id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tokens_prefix ON agent_tokens(token_prefix);
      CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent_id ON agent_tokens(agent_id);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_timeline (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        phase TEXT NOT NULL,
        envelope_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_room_timeline_room_id ON room_timeline(room_id);
      CREATE INDEX IF NOT EXISTS idx_room_timeline_room_ts ON room_timeline(room_id, timestamp);
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

    this.getTimelineStmt = this.db.prepare(`
      SELECT id, timestamp, phase, envelope_json
      FROM room_timeline
      WHERE room_id = @roomId
      ORDER BY timestamp ASC
    `);

    this.insertTimelineEventStmt = this.db.prepare(`
      INSERT INTO room_timeline (id, room_id, timestamp, phase, envelope_json)
      VALUES (@id, @roomId, @timestamp, @phase, @envelopeJson)
      ON CONFLICT(id) DO NOTHING
    `);

    this.deleteTimelineByRoomStmt = this.db.prepare(`
      DELETE FROM room_timeline WHERE room_id = @roomId
    `);

    this.deleteTimelineByEventStmt = this.db.prepare(`
      DELETE FROM room_timeline WHERE room_id = @roomId AND id = @id
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
    const room = this.parseSnapshot(row.snapshot_json);
    const events = this.getTimelineStmt.all({ roomId }) as Array<{ id: string; timestamp: string; phase: string; envelope_json: string }>;
    room.timeline = events.map(e => this.parseEvent(e));
    return Promise.resolve(room);
  }

  public async listRooms(): Promise<RoomSnapshot[]> {
    const rows = this.listRoomsStmt.all() as RoomRow[];
    return Promise.resolve(rows.map((row) => {
      const room = this.parseSnapshot(row.snapshot_json);
      room.timeline = [];
      return room;
    }));
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

  public async registerAgent(input: RegisterAgentInput): Promise<PlatformAgent> {
    const nickname = String(input.nickname || "").trim();
    const handle = `${nickname}@${SQLiteRoomStore.NODE_ID}`;
    const now = nowIso();
    const specialty = this.toStringArray(input.specialty);
    const tags = this.toStringArray(input.tags);
    const agent: PlatformAgent = {
      id: newId(),
      nickname,
      handle,
      organization: this.toOptionalText(input.organization) || undefined,
      specialty,
      tags,
      theme: this.toOptionalText(input.theme) || "dark",
      modelFamily: this.toOptionalText(input.modelFamily) || undefined,
      publicKey: this.toOptionalText(input.publicKey) || undefined,
      verificationUrl: this.toOptionalText(input.verificationUrl) || undefined,
      homeUrl: this.toOptionalText(input.homeUrl) || undefined,
      createdAt: now,
      updatedAt: now
    };

    this.db.prepare(`
      INSERT INTO platform_agents (
        id, nickname, handle, organization, specialty, tags, theme,
        model_family, public_key, verification_url, home_url, created_at, updated_at
      )
      VALUES (
        @id, @nickname, @handle, @organization, @specialty, @tags, @theme,
        @modelFamily, @publicKey, @verificationUrl, @homeUrl, @createdAt, @updatedAt
      )
    `).run({
      id: agent.id,
      nickname: agent.nickname,
      handle: agent.handle,
      organization: agent.organization || null,
      specialty: JSON.stringify(agent.specialty),
      tags: JSON.stringify(agent.tags),
      theme: agent.theme,
      modelFamily: agent.modelFamily || null,
      publicKey: agent.publicKey || null,
      verificationUrl: agent.verificationUrl || null,
      homeUrl: agent.homeUrl || null,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt
    });

    return Promise.resolve(agent);
  }

  public async getAgentById(agentId: string): Promise<PlatformAgent | null> {
    const row = this.db.prepare(`
      SELECT
        id, nickname, handle, organization, specialty, tags, theme,
        model_family, public_key, verification_url, home_url, created_at, updated_at
      FROM platform_agents
      WHERE id = @id
      LIMIT 1
    `).get({ id: agentId }) as PlatformAgentSqlRow | undefined;
    return Promise.resolve(row ? this.mapPlatformAgent(row) : null);
  }

  public async getAgentByNickname(nickname: string): Promise<PlatformAgent | null> {
    const row = this.db.prepare(`
      SELECT
        id, nickname, handle, organization, specialty, tags, theme,
        model_family, public_key, verification_url, home_url, created_at, updated_at
      FROM platform_agents
      WHERE LOWER(nickname) = LOWER(@nickname)
      LIMIT 1
    `).get({ nickname }) as PlatformAgentSqlRow | undefined;
    return Promise.resolve(row ? this.mapPlatformAgent(row) : null);
  }

  public async getAgentByHandle(handle: string): Promise<PlatformAgent | null> {
    const row = this.db.prepare(`
      SELECT
        id, nickname, handle, organization, specialty, tags, theme,
        model_family, public_key, verification_url, home_url, created_at, updated_at
      FROM platform_agents
      WHERE LOWER(handle) = LOWER(@handle)
      LIMIT 1
    `).get({ handle }) as PlatformAgentSqlRow | undefined;
    return Promise.resolve(row ? this.mapPlatformAgent(row) : null);
  }

  public async listPlatformAgents(): Promise<PlatformAgent[]> {
    const rows = this.db.prepare(`
      SELECT
        id, nickname, handle, organization, specialty, tags, theme,
        model_family, public_key, verification_url, home_url, created_at, updated_at
      FROM platform_agents
      ORDER BY created_at DESC
    `).all() as PlatformAgentSqlRow[];
    return Promise.resolve(rows.map((row) => this.mapPlatformAgent(row)));
  }

  public async createToken(agentId: string, scopes: string): Promise<{ token: string; expiresAt: string }> {
    const token = `${SQLiteRoomStore.TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const tokenPrefix = this.tokenPrefixFromToken(token);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO agent_tokens (
        id, agent_id, token_hash, token_prefix, issuer_node_id, version, scopes, created_at, expires_at
      )
      VALUES (
        @id, @agentId, @tokenHash, @tokenPrefix, @issuerNodeId, @version, @scopes, @createdAt, @expiresAt
      )
    `).run({
      id: newId(),
      agentId,
      tokenHash,
      tokenPrefix,
      issuerNodeId: SQLiteRoomStore.NODE_ID,
      version: 1,
      scopes: scopes || "agent",
      createdAt,
      expiresAt
    });
    return Promise.resolve({ token, expiresAt });
  }

  public async validateToken(token: string): Promise<{ agent: PlatformAgent; scopes: string } | null> {
    const trimmed = String(token || "").trim();
    if (!trimmed) {
      return Promise.resolve(null);
    }
    const tokenHash = createHash("sha256").update(trimmed).digest("hex");
    const tokenPrefix = this.tokenPrefixFromToken(trimmed);
    const now = nowIso();
    const rows = this.db.prepare(`
      SELECT
        t.token_hash, t.scopes, t.expires_at, t.revoked_at,
        a.id, a.nickname, a.handle, a.organization, a.specialty, a.tags, a.theme,
        a.model_family, a.public_key, a.verification_url, a.home_url, a.created_at, a.updated_at
      FROM agent_tokens t
      JOIN platform_agents a ON a.id = t.agent_id
      WHERE t.token_prefix = @tokenPrefix
        AND t.token_hash = @tokenHash
        AND t.revoked_at IS NULL
        AND t.expires_at > @now
      LIMIT 1
    `).all({ tokenPrefix, tokenHash, now }) as TokenValidationSqlRow[];
    const matched = rows[0];
    if (!matched) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      agent: this.mapPlatformAgent(matched),
      scopes: matched.scopes || "agent"
    });
  }

  public async updateTokenLastUsed(tokenPrefix: string): Promise<void> {
    this.db.prepare(`
      UPDATE agent_tokens
      SET last_used_at = @lastUsedAt
      WHERE token_prefix = @tokenPrefix
        AND revoked_at IS NULL
    `).run({
      tokenPrefix,
      lastUsedAt: nowIso()
    });
  }

  public async deleteRoom(roomId: string): Promise<boolean> {
    this.deleteTimelineByRoomStmt.run({ roomId });
    this.deleteSharedLinksByRoomStmt.run({ roomId });
    const result = this.deleteRoomStmt.run({ id: roomId }) as { changes?: number } | undefined;
    return Promise.resolve(Number(result?.changes || 0) > 0);
  }

  public async deleteMessage(roomId: string, messageId: string): Promise<boolean> {
    const result = this.deleteTimelineByEventStmt.run({ roomId, id: messageId }) as { changes?: number } | undefined;
    if (Number(result?.changes || 0) === 0) return Promise.resolve(false);
    this.deleteSharedLinksByMessageStmt.run({ roomId, messageId });
    return Promise.resolve(true);
  }

  public async clearTimeline(roomId: string): Promise<boolean> {
    const row = this.db.prepare(`SELECT id FROM rooms WHERE id = @id LIMIT 1`).get({ id: roomId });
    if (!row) return Promise.resolve(false);
    this.deleteTimelineByRoomStmt.run({ roomId });
    this.deleteSharedLinksByRoomStmt.run({ roomId });
    return Promise.resolve(true);
  }

  private persist(room: RoomSnapshot): void {
    const { timeline, ...roomWithoutTimeline } = room;
    this.upsertRoomStmt.run({
      id: room.id,
      task: room.task,
      status: room.status,
      phase: room.phase,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      agentIdsJson: JSON.stringify(room.agentIds),
      snapshotJson: JSON.stringify(roomWithoutTimeline)
    });
    for (const event of timeline) {
      this.insertTimelineEventStmt.run({
        id: event.id,
        roomId: room.id,
        timestamp: event.timestamp,
        phase: event.phase,
        envelopeJson: JSON.stringify(event.envelope)
      });
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

  private parseEvent(row: { id: string; timestamp: string; phase: string; envelope_json: string }): import("../types/protocol").RoomEvent {
    const envelope = JSON.parse(row.envelope_json) as import("../types/protocol").AgentEnvelope;
    if (envelope.scope !== "room" && envelope.scope !== "direct") {
      envelope.scope = envelope.to_agent === "room" ? "room" : "direct";
    }
    if (typeof envelope.triggered_by !== "string" || envelope.triggered_by.length === 0) {
      envelope.triggered_by = null;
    }
    return {
      id: row.id,
      timestamp: row.timestamp,
      phase: row.phase as import("../types/protocol").RoomPhase,
      envelope
    };
  }

  private mapPlatformAgent(row: PlatformAgentSqlRow | TokenValidationSqlRow): PlatformAgent {
    return {
      id: row.id,
      nickname: row.nickname,
      handle: row.handle,
      organization: row.organization || undefined,
      specialty: this.parseStringArray(row.specialty),
      tags: this.parseStringArray(row.tags),
      theme: row.theme || "dark",
      modelFamily: row.model_family || undefined,
      publicKey: row.public_key || undefined,
      verificationUrl: row.verification_url || undefined,
      homeUrl: row.home_url || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private parseStringArray(raw: string): string[] {
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

  private toOptionalText(value: string | undefined): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private toStringArray(value: string[] | undefined): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  private tokenPrefixFromToken(token: string): string {
    if (token.startsWith(SQLiteRoomStore.TOKEN_PREFIX)) {
      return token.slice(
        SQLiteRoomStore.TOKEN_PREFIX.length,
        SQLiteRoomStore.TOKEN_PREFIX.length + SQLiteRoomStore.TOKEN_PREFIX_LENGTH
      );
    }
    return token.slice(0, SQLiteRoomStore.TOKEN_PREFIX_LENGTH);
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

interface PlatformAgentSqlRow {
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

interface TokenValidationSqlRow extends PlatformAgentSqlRow {
  token_hash: string;
  scopes: string;
  expires_at: string;
  revoked_at: string | null;
}
