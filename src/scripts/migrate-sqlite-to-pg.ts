/**
 * One-time migration script: SQLite → PostgreSQL
 *
 * Usage:
 *   npx ts-node src/scripts/migrate-sqlite-to-pg.ts
 *
 * Required env vars:
 *   HEXNEST_DB_PATH  — path to the existing SQLite file
 *   DATABASE_URL     — target PostgreSQL connection string
 */

import path from "path";
import fs from "fs";
import { Pool } from "pg";

const sqlite = require("node:sqlite");

// ── helpers ──────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function runMigration(dbPath: string, databaseUrl: string): Promise<void> {

  const sqlitePath = path.resolve(dbPath);

  if (!fs.existsSync(sqlitePath)) {
    console.log(`SQLite file not found at ${sqlitePath} — skipping migration.`);
    return;
  }

  console.log(`Opening SQLite: ${sqlitePath}`);
  const db = new sqlite.DatabaseSync(sqlitePath, { readonly: true });

  const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false });
  console.log(`Connected to Postgres: ${databaseUrl.replace(/:\/\/.*@/, "://<credentials>@")}`);

  // ── ensure target tables exist ────────────────────────────────────────────
  await pool.query(`
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

    CREATE TABLE IF NOT EXISTS shared_links (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      short_code TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // ── migrate rooms ─────────────────────────────────────────────────────────
  console.log("\nMigrating rooms...");
  const rooms = db.prepare(`
    SELECT id, task, status, phase, created_at, updated_at, agent_ids_json, snapshot_json
    FROM rooms
    ORDER BY created_at ASC
  `).all() as Array<{
    id: string;
    task: string;
    status: string;
    phase: string;
    created_at: string;
    updated_at: string;
    agent_ids_json: string;
    snapshot_json: string;
  }>;

  let roomsInserted = 0;
  let roomsSkipped = 0;

  for (const row of rooms) {
    const result = await pool.query(
      `INSERT INTO rooms (id, task, status, phase, created_at, updated_at, agent_ids_json, snapshot_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.task, row.status, row.phase, row.created_at, row.updated_at, row.agent_ids_json, row.snapshot_json]
    );
    if (result.rowCount && result.rowCount > 0) {
      roomsInserted++;
    } else {
      roomsSkipped++;
    }
  }
  console.log(`  Inserted: ${roomsInserted}, skipped (already exist): ${roomsSkipped}`);

  // ── migrate agent_directory ───────────────────────────────────────────────
  console.log("\nMigrating agent_directory...");
  const agents = db.prepare(`
    SELECT id, name, description, protocol, endpoint_url, owner, category, status, created_at
    FROM agent_directory
    ORDER BY created_at ASC
  `).all() as Array<{
    id: string;
    name: string;
    description: string;
    protocol: string;
    endpoint_url: string;
    owner: string;
    category: string;
    status: string;
    created_at: string;
  }>;

  let agentsInserted = 0;
  let agentsSkipped = 0;

  for (const row of agents) {
    const result = await pool.query(
      `INSERT INTO agent_directory (id, name, description, protocol, endpoint_url, owner, category, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.name, row.description, row.protocol, row.endpoint_url, row.owner, row.category ?? "utility", row.status, row.created_at]
    );
    if (result.rowCount && result.rowCount > 0) {
      agentsInserted++;
    } else {
      agentsSkipped++;
    }
  }
  console.log(`  Inserted: ${agentsInserted}, skipped (already exist): ${agentsSkipped}`);

  // ── migrate shared_links ──────────────────────────────────────────────────
  console.log("\nMigrating shared_links...");

  let hasSharedLinks = true;
  try {
    db.prepare(`SELECT 1 FROM shared_links LIMIT 1`).all();
  } catch {
    hasSharedLinks = false;
  }

  if (hasSharedLinks) {
    const links = db.prepare(`
      SELECT id, room_id, message_id, short_code, created_at
      FROM shared_links
      ORDER BY created_at ASC
    `).all() as Array<{
      id: string;
      room_id: string;
      message_id: string;
      short_code: string;
      created_at: string;
    }>;

    let linksInserted = 0;
    let linksSkipped = 0;

    for (const row of links) {
      const result = await pool.query(
        `INSERT INTO shared_links (id, room_id, message_id, short_code, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.room_id, row.message_id, row.short_code, row.created_at]
      );
      if (result.rowCount && result.rowCount > 0) {
        linksInserted++;
      } else {
        linksSkipped++;
      }
    }
    console.log(`  Inserted: ${linksInserted}, skipped (already exist): ${linksSkipped}`);
  } else {
    console.log("  Table shared_links not found in SQLite — skipping.");
  }

  await pool.end();
  db.close();

  console.log("\nMigration complete.");
}

if (require.main === module) {
  const dbPath = requireEnv("HEXNEST_DB_PATH");
  const databaseUrl = requireEnv("DATABASE_URL");
  runMigration(dbPath, databaseUrl).catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
