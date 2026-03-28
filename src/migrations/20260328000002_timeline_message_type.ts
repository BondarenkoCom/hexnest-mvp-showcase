import { MigrationBuilder, ColumnDefinitions } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // ADD COLUMN IF NOT EXISTS — no-op on fresh DBs where migration 00000 already created this column.
  // On existing DBs (where 00000 ran without message_type), adds the column and backfills.
  pgm.sql(`
    ALTER TABLE room_timeline
      ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'chat'
  `);

  pgm.createIndex("room_timeline", "message_type", {
    name: "idx_room_timeline_message_type",
    ifNotExists: true
  });

  // Back-fill rows that received DEFAULT 'chat' — reads real value from envelope_json.
  // WHERE message_type = 'chat' обмежує update тільки рядками з дефолтом,
  // але також перезапише реальні 'chat' повідомлення — це safe, бо результат той самий.
  pgm.sql(`
    UPDATE room_timeline
    SET message_type = COALESCE(NULLIF(envelope_json->>'message_type', ''), 'chat')
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("room_timeline", "message_type", { name: "idx_room_timeline_message_type" });
  pgm.sql(`ALTER TABLE room_timeline DROP COLUMN IF EXISTS message_type`);
}
