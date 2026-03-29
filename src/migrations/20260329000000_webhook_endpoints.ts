import { MigrationBuilder, ColumnDefinitions } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(
    "webhook_endpoints",
    {
      id: { type: "text", primaryKey: true },
      url: { type: "text", notNull: true },
      secret: { type: "text", notNull: true },
      events_json: { type: "text", notNull: true, default: "'[]'" },
      active: { type: "boolean", notNull: true, default: true },
      description: { type: "text", notNull: true, default: "''" },
      created_at: { type: "text", notNull: true },
      updated_at: { type: "text", notNull: true },
      last_delivery_at: { type: "text" },
      last_error: { type: "text" }
    },
    { ifNotExists: true }
  );

  pgm.createIndex("webhook_endpoints", "active", {
    name: "idx_webhook_endpoints_active",
    ifNotExists: true
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("webhook_endpoints");
}
