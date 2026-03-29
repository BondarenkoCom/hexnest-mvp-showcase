import { MigrationBuilder, ColumnDefinitions } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Step 1: Add new columns to rooms
  pgm.sql(`
    ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS subnest TEXT NOT NULL DEFAULT 'general',
      ADD COLUMN IF NOT EXISTS settings_json JSONB NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS final_output TEXT,
      ADD COLUMN IF NOT EXISTS connected_agents_json JSONB NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS search_jobs_json JSONB NOT NULL DEFAULT '[]'
  `);

  // Step 2: Back-fill new columns from snapshot_json
  pgm.sql(`
    UPDATE rooms SET
      name = CASE
        WHEN TRIM(COALESCE(snapshot_json::jsonb->>'name', '')) = ''
        THEN 'Room ' || LEFT(id, 8)
        ELSE snapshot_json::jsonb->>'name'
      END,
      subnest = COALESCE(NULLIF(snapshot_json::jsonb->>'subnest', ''), 'general'),
      settings_json = COALESCE(snapshot_json::jsonb->'settings', '{}'),
      final_output = NULLIF(snapshot_json::jsonb->>'finalOutput', ''),
      connected_agents_json = COALESCE(snapshot_json::jsonb->'connectedAgents', '[]'),
      search_jobs_json = COALESCE(snapshot_json::jsonb->'searchJobs', '[]')
    WHERE snapshot_json IS NOT NULL
  `);

  // Step 3: Create room_artifacts
  pgm.createTable(
    "room_artifacts",
    {
      id: { type: "text", primaryKey: true },
      room_id: { type: "text", notNull: true },
      task_id: { type: "text", notNull: true },
      type: { type: "text", notNull: true },
      label: { type: "text", notNull: true },
      content: { type: "text", notNull: true },
      producer: { type: "text", notNull: true },
      timestamp: { type: "timestamptz", notNull: true }
    },
    { ifNotExists: true }
  );
  pgm.createIndex("room_artifacts", "room_id", { name: "idx_room_artifacts_room_id", ifNotExists: true });

  // Step 4: Back-fill room_artifacts from snapshot_json
  pgm.sql(`
    INSERT INTO room_artifacts (id, room_id, task_id, type, label, content, producer, timestamp)
    SELECT
      artifact->>'id',
      r.id,
      COALESCE(artifact->>'taskId', ''),
      COALESCE(artifact->>'type', 'note'),
      COALESCE(artifact->>'label', ''),
      COALESCE(artifact->>'content', ''),
      COALESCE(artifact->>'producer', ''),
      (artifact->>'timestamp')::timestamptz
    FROM rooms r,
         jsonb_array_elements((r.snapshot_json::jsonb)->'artifacts') AS artifact
    WHERE jsonb_typeof((r.snapshot_json::jsonb)->'artifacts') = 'array'
      AND artifact->>'id' IS NOT NULL
      AND artifact->>'timestamp' IS NOT NULL
    ON CONFLICT (id) DO NOTHING
  `);

  // Step 5: Create room_python_jobs
  pgm.createTable(
    "room_python_jobs",
    {
      id: { type: "text", primaryKey: true },
      room_id: { type: "text", notNull: true },
      agent_id: { type: "text", notNull: true },
      agent_name: { type: "text", notNull: true },
      status: { type: "text", notNull: true },
      code: { type: "text", notNull: true },
      created_at: { type: "timestamptz", notNull: true },
      started_at: { type: "timestamptz" },
      finished_at: { type: "timestamptz" },
      timeout_sec: { type: "integer", notNull: true, default: 35 },
      exit_code: { type: "integer" },
      stdout: { type: "text" },
      stderr: { type: "text" },
      error: { type: "text" },
      output_truncated: { type: "boolean", notNull: true, default: false }
    },
    { ifNotExists: true }
  );
  pgm.createIndex("room_python_jobs", "room_id", { name: "idx_room_python_jobs_room_id", ifNotExists: true });

  // Step 6: Back-fill room_python_jobs from snapshot_json
  pgm.sql(`
    INSERT INTO room_python_jobs (
      id, room_id, agent_id, agent_name, status, code, created_at,
      started_at, finished_at, timeout_sec, exit_code, stdout, stderr, error, output_truncated
    )
    SELECT
      job->>'id',
      r.id,
      COALESCE(job->>'agentId', ''),
      COALESCE(job->>'agentName', ''),
      COALESCE(job->>'status', 'queued'),
      COALESCE(job->>'code', ''),
      (job->>'createdAt')::timestamptz,
      NULLIF(job->>'startedAt', '')::timestamptz,
      NULLIF(job->>'finishedAt', '')::timestamptz,
      COALESCE((job->>'timeoutSec')::integer, 35),
      (job->>'exitCode')::integer,
      NULLIF(job->>'stdout', ''),
      NULLIF(job->>'stderr', ''),
      NULLIF(job->>'error', ''),
      COALESCE((job->>'outputTruncated')::boolean, false)
    FROM rooms r,
         jsonb_array_elements((r.snapshot_json::jsonb)->'pythonJobs') AS job
    WHERE jsonb_typeof((r.snapshot_json::jsonb)->'pythonJobs') = 'array'
      AND job->>'id' IS NOT NULL
      AND job->>'createdAt' IS NOT NULL
    ON CONFLICT (id) DO NOTHING
  `);

  // Step 7: Drop snapshot_json — data is now in normalized columns and tables
  pgm.dropColumns("rooms", ["snapshot_json"]);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("room_python_jobs");
  pgm.dropTable("room_artifacts");
  pgm.sql(`
    ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS snapshot_json TEXT NOT NULL DEFAULT '{}',
      DROP COLUMN IF EXISTS name,
      DROP COLUMN IF EXISTS subnest,
      DROP COLUMN IF EXISTS settings_json,
      DROP COLUMN IF EXISTS final_output,
      DROP COLUMN IF EXISTS connected_agents_json,
      DROP COLUMN IF EXISTS search_jobs_json
  `);
}
