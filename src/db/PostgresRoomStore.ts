import { createHash, randomBytes } from "crypto";
import { Pool } from "pg";
import {
  AgentEnvelope,
  Artifact,
  CreateWebhookEndpointInput,
  ConnectedAgent,
  DirectoryAgent,
  PlatformAgent,
  PythonJob,
  PythonJobStatus,
  RegisterAgentInput,
  RoomEvent,
  RoomPhase,
  RoomSnapshot,
  RoomStatus,
  SharedLink,
  UpdateWebhookEndpointInput,
  WebhookEndpoint,
  WebhookEventType,
  WebSearchJob
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
    const [roomResult, timelineResult, artifactsResult, jobsResult] = await Promise.all([
      this.pool.query<RoomsRow>(
        `SELECT id, task, name, subnest, status, phase, created_at, updated_at,
                agent_ids_json, settings_json, final_output, connected_agents_json, search_jobs_json
         FROM rooms WHERE id = $1 LIMIT 1`,
        [roomId]
      ),
      this.pool.query<TimelineRow>(
        `SELECT id, timestamp, phase, message_type, envelope_json FROM room_timeline
         WHERE room_id = $1 ORDER BY timestamp ASC`,
        [roomId]
      ),
      this.pool.query<ArtifactRow>(
        `SELECT id, room_id, task_id, type, label, content, producer, timestamp
         FROM room_artifacts WHERE room_id = $1 ORDER BY timestamp ASC`,
        [roomId]
      ),
      this.pool.query<PythonJobRow>(
        `SELECT id, room_id, agent_id, agent_name, status, code, created_at,
                started_at, finished_at, timeout_sec, exit_code, stdout, stderr, error, output_truncated
         FROM room_python_jobs WHERE room_id = $1 ORDER BY created_at ASC`,
        [roomId]
      )
    ]);
    if (roomResult.rows.length === 0) return undefined;
    return this.buildSnapshot(
      roomResult.rows[0],
      timelineResult.rows.map(r => this.parseEvent(r)),
      artifactsResult.rows.map(r => this.mapArtifactRow(r)),
      jobsResult.rows.map(r => this.mapPythonJobRow(r))
    );
  }

  async listRooms(): Promise<RoomSnapshot[]> {
    const result = await this.pool.query<RoomsRow>(
      `SELECT r.id, r.task, r.name, r.subnest, r.status, r.phase, r.created_at, r.updated_at,
              r.agent_ids_json, r.settings_json, r.final_output, r.connected_agents_json, r.search_jobs_json,
              (SELECT COUNT(*) FROM room_timeline rt WHERE rt.room_id = r.id AND rt.message_type != 'system')::int AS message_count,
              (SELECT COUNT(*) FROM room_python_jobs pj WHERE pj.room_id = r.id)::int AS python_jobs_count
       FROM rooms r ORDER BY r.updated_at DESC`
    );
    return result.rows.map(row => this.buildSnapshot(row, [], [], []));
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
      await client.query(`DELETE FROM room_artifacts WHERE room_id = $1`, [roomId]);
      await client.query(`DELETE FROM room_python_jobs WHERE room_id = $1`, [roomId]);
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

  async createWebhookEndpoint(input: CreateWebhookEndpointInput): Promise<WebhookEndpoint> {
    const now = nowIso();
    const result = await this.pool.query<WebhookEndpointRow>(
      `INSERT INTO webhook_endpoints (
         id, url, secret, events_json, active, description, created_at, updated_at, last_delivery_at, last_error
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL)
       RETURNING
         id, url, secret, events_json, active, description, created_at, updated_at, last_delivery_at, last_error`,
      [
        newId(),
        String(input.url || "").trim(),
        String(input.secret || "").trim(),
        JSON.stringify(Array.isArray(input.events) ? input.events : []),
        input.active !== false,
        String(input.description || "").trim(),
        now,
        now
      ]
    );
    return this.mapWebhookEndpoint(result.rows[0]);
  }

  async listWebhookEndpoints(): Promise<WebhookEndpoint[]> {
    const result = await this.pool.query<WebhookEndpointRow>(
      `SELECT
         id, url, secret, events_json, active, description, created_at, updated_at, last_delivery_at, last_error
       FROM webhook_endpoints
       ORDER BY created_at ASC`
    );
    return result.rows.map((row) => this.mapWebhookEndpoint(row));
  }

  async getWebhookEndpoint(endpointId: string): Promise<WebhookEndpoint | null> {
    const result = await this.pool.query<WebhookEndpointRow>(
      `SELECT
         id, url, secret, events_json, active, description, created_at, updated_at, last_delivery_at, last_error
       FROM webhook_endpoints
       WHERE id = $1
       LIMIT 1`,
      [endpointId]
    );
    if (result.rows.length === 0) return null;
    return this.mapWebhookEndpoint(result.rows[0]);
  }

  async updateWebhookEndpoint(
    endpointId: string,
    patch: UpdateWebhookEndpointInput
  ): Promise<WebhookEndpoint | null> {
    const current = await this.getWebhookEndpoint(endpointId);
    if (!current) {
      return null;
    }

    const updated = {
      url: typeof patch.url === "string" ? patch.url.trim() : current.url,
      secret: typeof patch.secret === "string" ? patch.secret.trim() : current.secret,
      events: Array.isArray(patch.events) ? patch.events : current.events,
      active: typeof patch.active === "boolean" ? patch.active : current.active,
      description: typeof patch.description === "string" ? patch.description.trim() : current.description,
      updatedAt: nowIso()
    };

    const result = await this.pool.query<WebhookEndpointRow>(
      `UPDATE webhook_endpoints
       SET
         url = $2,
         secret = $3,
         events_json = $4,
         active = $5,
         description = $6,
         updated_at = $7
       WHERE id = $1
       RETURNING
         id, url, secret, events_json, active, description, created_at, updated_at, last_delivery_at, last_error`,
      [
        endpointId,
        updated.url,
        updated.secret,
        JSON.stringify(updated.events),
        updated.active,
        updated.description,
        updated.updatedAt
      ]
    );

    if (result.rows.length === 0) return null;
    return this.mapWebhookEndpoint(result.rows[0]);
  }

  async deleteWebhookEndpoint(endpointId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM webhook_endpoints WHERE id = $1`,
      [endpointId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markWebhookDelivery(
    endpointId: string,
    deliveredAt: string,
    error: string | null = null
  ): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_endpoints
       SET
         last_delivery_at = $2,
         last_error = $3,
         updated_at = $4
       WHERE id = $1`,
      [endpointId, deliveredAt, error, nowIso()]
    );
  }

  private async persist(room: RoomSnapshot): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO rooms (
           id, task, name, subnest, status, phase, created_at, updated_at,
           agent_ids_json, settings_json, final_output, connected_agents_json, search_jobs_json
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           task = EXCLUDED.task,
           name = EXCLUDED.name,
           subnest = EXCLUDED.subnest,
           status = EXCLUDED.status,
           phase = EXCLUDED.phase,
           updated_at = EXCLUDED.updated_at,
           agent_ids_json = EXCLUDED.agent_ids_json,
           settings_json = EXCLUDED.settings_json,
           final_output = EXCLUDED.final_output,
           connected_agents_json = EXCLUDED.connected_agents_json,
           search_jobs_json = EXCLUDED.search_jobs_json`,
        [
          room.id,
          room.task,
          room.name,
          room.subnest,
          room.status,
          room.phase,
          room.createdAt,
          room.updatedAt,
          JSON.stringify(room.agentIds),
          JSON.stringify(room.settings),
          room.finalOutput || null,
          JSON.stringify(room.connectedAgents),
          JSON.stringify(room.searchJobs || [])
        ]
      );
      for (const event of room.timeline) {
        await client.query(
          `INSERT INTO room_timeline (id, room_id, timestamp, phase, message_type, envelope_json)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [event.id, room.id, event.timestamp, event.phase, event.envelope.message_type, JSON.stringify(event.envelope)]
        );
      }
      for (const artifact of room.artifacts) {
        await client.query(
          `INSERT INTO room_artifacts (id, room_id, task_id, type, label, content, producer, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             label = EXCLUDED.label,
             content = EXCLUDED.content`,
          [artifact.id, room.id, artifact.taskId, artifact.type, artifact.label,
           artifact.content, artifact.producer, artifact.timestamp]
        );
      }
      for (const job of room.pythonJobs) {
        await client.query(
          `INSERT INTO room_python_jobs (
             id, room_id, agent_id, agent_name, status, code, created_at,
             started_at, finished_at, timeout_sec, exit_code, stdout, stderr, error, output_truncated
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             started_at = EXCLUDED.started_at,
             finished_at = EXCLUDED.finished_at,
             exit_code = EXCLUDED.exit_code,
             stdout = EXCLUDED.stdout,
             stderr = EXCLUDED.stderr,
             error = EXCLUDED.error,
             output_truncated = EXCLUDED.output_truncated`,
          [
            job.id, job.roomId, job.agentId, job.agentName, job.status, job.code,
            job.createdAt,
            job.startedAt || null,
            job.finishedAt || null,
            job.timeoutSec,
            job.exitCode ?? null,
            job.stdout || null,
            job.stderr || null,
            job.error || null,
            job.outputTruncated || false
          ]
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

  private buildSnapshot(
    row: RoomsRow,
    timeline: RoomEvent[],
    artifacts: Artifact[],
    pythonJobs: PythonJob[]
  ): RoomSnapshot {
    const settings = (row.settings_json || {}) as { pythonShellEnabled?: boolean; webSearchEnabled?: boolean; isPublic?: boolean };
    if (typeof settings.pythonShellEnabled !== "boolean") settings.pythonShellEnabled = false;
    if (typeof settings.isPublic !== "boolean") settings.isPublic = true;
    if (typeof settings.webSearchEnabled !== "boolean") settings.webSearchEnabled = false;
    return {
      id: row.id,
      name: row.name || `Room ${row.id.slice(0, 8)}`,
      task: row.task,
      subnest: row.subnest || "general",
      status: row.status as RoomStatus,
      phase: row.phase as RoomPhase,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      agentIds: this.parseJsonArray(row.agent_ids_json),
      settings: settings as RoomSnapshot["settings"],
      finalOutput: row.final_output || undefined,
      connectedAgents: Array.isArray(row.connected_agents_json) ? row.connected_agents_json : [],
      searchJobs: Array.isArray(row.search_jobs_json) ? row.search_jobs_json : [],
      timeline,
      artifacts,
      pythonJobs,
      messageCount: row.message_count ?? timeline.length,
      pythonJobsCount: row.python_jobs_count ?? pythonJobs.length
    };
  }

  private mapArtifactRow(row: ArtifactRow): Artifact {
    return {
      id: row.id,
      taskId: row.task_id,
      type: row.type as Artifact["type"],
      label: row.label,
      content: row.content,
      producer: row.producer,
      timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp
    };
  }

  private mapPythonJobRow(row: PythonJobRow): PythonJob {
    const toIso = (v: Date | null): string | undefined =>
      v instanceof Date ? v.toISOString() : (v || undefined);
    return {
      id: row.id,
      roomId: row.room_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      status: row.status as PythonJobStatus,
      code: row.code,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      startedAt: toIso(row.started_at),
      finishedAt: toIso(row.finished_at),
      timeoutSec: row.timeout_sec,
      exitCode: row.exit_code ?? null,
      stdout: row.stdout || undefined,
      stderr: row.stderr || undefined,
      error: row.error || undefined,
      outputTruncated: row.output_truncated || false
    };
  }

  private parseEvent(row: TimelineRow): RoomEvent {
    const envelope = row.envelope_json as AgentEnvelope;
    if (envelope.scope !== "room" && envelope.scope !== "direct") {
      envelope.scope = envelope.to_agent === "room" ? "room" : "direct";
    }
    if (typeof envelope.triggered_by !== "string" || envelope.triggered_by.length === 0) {
      envelope.triggered_by = null;
    }
    return {
      id: row.id,
      timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
      phase: row.phase as RoomPhase,
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

  private mapWebhookEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
    return {
      id: row.id,
      url: row.url,
      secret: row.secret,
      events: this.parseWebhookEvents(row.events_json),
      active: row.active,
      description: row.description || "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastDeliveryAt: row.last_delivery_at || undefined,
      lastError: row.last_error || undefined
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

  private parseWebhookEvents(raw: string): WebhookEventType[] {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => String(item || "").trim())
        .filter(Boolean) as WebhookEventType[];
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface RoomsRow {
  id: string;
  task: string;
  name: string;
  subnest: string;
  status: string;
  phase: string;
  created_at: string;
  updated_at: string;
  agent_ids_json: string;
  settings_json: Record<string, unknown>;
  final_output: string | null;
  connected_agents_json: ConnectedAgent[];
  search_jobs_json: WebSearchJob[];
  message_count?: number;
  python_jobs_count?: number;
}

interface TimelineRow {
  id: string;
  timestamp: Date;
  phase: string;
  message_type: string;
  envelope_json: AgentEnvelope;
}

interface ArtifactRow {
  id: string;
  room_id: string;
  task_id: string;
  type: string;
  label: string;
  content: string;
  producer: string;
  timestamp: Date;
}

interface PythonJobRow {
  id: string;
  room_id: string;
  agent_id: string;
  agent_name: string;
  status: string;
  code: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  timeout_sec: number;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  output_truncated: boolean;
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

interface WebhookEndpointRow {
  id: string;
  url: string;
  secret: string;
  events_json: string;
  active: boolean;
  description: string;
  created_at: string;
  updated_at: string;
  last_delivery_at: string | null;
  last_error: string | null;
}
