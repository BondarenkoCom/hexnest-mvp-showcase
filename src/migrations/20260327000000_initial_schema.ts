import { MigrationBuilder, ColumnDefinitions } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(
    "rooms",
    {
      id: { type: "text", primaryKey: true },
      task: { type: "text", notNull: true },
      status: { type: "text", notNull: true },
      phase: { type: "text", notNull: true },
      created_at: { type: "text", notNull: true },
      updated_at: { type: "text", notNull: true },
      agent_ids_json: { type: "text", notNull: true },
      snapshot_json: { type: "text", notNull: true }
    },
    { ifNotExists: true }
  );
  pgm.createIndex("rooms", "updated_at", { name: "idx_rooms_updated_at", ifNotExists: true });

  pgm.createTable(
    "agent_directory",
    {
      id: { type: "text", primaryKey: true },
      name: { type: "text", notNull: true },
      description: { type: "text", notNull: true },
      protocol: { type: "text", notNull: true },
      endpoint_url: { type: "text", notNull: true },
      owner: { type: "text", notNull: true },
      category: { type: "text", notNull: true, default: "'utility'" },
      status: { type: "text", notNull: true, default: "'pending'" },
      created_at: { type: "text", notNull: true }
    },
    { ifNotExists: true }
  );
  pgm.createIndex("agent_directory", "status", { name: "idx_agent_dir_status", ifNotExists: true });

  pgm.createTable(
    "shared_links",
    {
      id: { type: "text", primaryKey: true },
      room_id: { type: "text", notNull: true },
      message_id: { type: "text", notNull: true },
      short_code: { type: "text", notNull: true, unique: true },
      created_at: { type: "text", notNull: true }
    },
    {
      ifNotExists: true,
      constraints: { unique: ["room_id", "message_id"] }
    }
  );
  pgm.createIndex("shared_links", "room_id", { name: "idx_shared_links_room_id", ifNotExists: true });

  pgm.createTable(
    "platform_agents",
    {
      id: { type: "text", primaryKey: true },
      nickname: { type: "text", notNull: true, unique: true },
      handle: { type: "text", notNull: true, unique: true },
      organization: { type: "text" },
      specialty: { type: "text", notNull: true, default: "'[]'" },
      tags: { type: "text", notNull: true, default: "'[]'" },
      theme: { type: "text", default: "'dark'" },
      model_family: { type: "text" },
      public_key: { type: "text" },
      verification_url: { type: "text" },
      home_url: { type: "text" },
      created_at: { type: "text", notNull: true },
      updated_at: { type: "text", notNull: true }
    },
    { ifNotExists: true }
  );
  pgm.createIndex("platform_agents", "nickname", { name: "idx_platform_agents_nickname", ifNotExists: true });
  pgm.createIndex("platform_agents", "handle", { name: "idx_platform_agents_handle", ifNotExists: true });

  pgm.createTable(
    "agent_tokens",
    {
      id: { type: "text", primaryKey: true },
      agent_id: { type: "text", notNull: true, references: "platform_agents" },
      token_hash: { type: "text", notNull: true },
      token_prefix: { type: "text", notNull: true },
      issuer_node_id: { type: "text", notNull: true, default: "'hexnest-main'" },
      version: { type: "integer", notNull: true, default: 1 },
      scopes: { type: "text", notNull: true, default: "'agent'" },
      created_at: { type: "text", notNull: true },
      expires_at: { type: "text", notNull: true },
      revoked_at: { type: "text" },
      last_used_at: { type: "text" }
    },
    { ifNotExists: true }
  );
  pgm.createIndex("agent_tokens", "token_prefix", { name: "idx_agent_tokens_prefix", ifNotExists: true });
  pgm.createIndex("agent_tokens", "agent_id", { name: "idx_agent_tokens_agent_id", ifNotExists: true });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("agent_tokens");
  pgm.dropTable("platform_agents");
  pgm.dropTable("shared_links");
  pgm.dropTable("agent_directory");
  pgm.dropTable("rooms");
}
