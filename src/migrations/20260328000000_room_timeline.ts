import { MigrationBuilder, ColumnDefinitions } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(
    "room_timeline",
    {
      id: { type: "text", primaryKey: true },
      room_id: { type: "text", notNull: true },
      timestamp: { type: "timestamptz", notNull: true },
      phase: { type: "text", notNull: true },
      envelope_json: { type: "jsonb", notNull: true }
    },
    { ifNotExists: true }
  );
  pgm.createIndex("room_timeline", "room_id", { name: "idx_room_timeline_room_id", ifNotExists: true });
  pgm.createIndex("room_timeline", ["room_id", "timestamp"], { name: "idx_room_timeline_room_ts", ifNotExists: true });

  // Migrate existing timeline events from snapshot_json blobs into room_timeline.
  // ON CONFLICT DO NOTHING makes this safe to re-run.
  pgm.sql(`
    INSERT INTO room_timeline (id, room_id, timestamp, phase, envelope_json)
    SELECT
      event->>'id',
      r.id,
      (event->>'timestamp')::timestamptz,
      event->>'phase',
      event->'envelope'
    FROM rooms r,
         jsonb_array_elements((r.snapshot_json::jsonb)->'timeline') AS event
    WHERE jsonb_typeof((r.snapshot_json::jsonb)->'timeline') = 'array'
      AND event->>'id' IS NOT NULL
    ON CONFLICT (id) DO NOTHING
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("room_timeline");
}
