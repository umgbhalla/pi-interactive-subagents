/**
 * Global lineage ledger for mapreduce depth enforcement.
 *
 * Stores one row per pi session (root + every mapreduce-spawned child) in a
 * single SQLite database at `~/.pi/subagents/lineage.db`.
 *
 * The depth budget is:
 *   - root session: unlimited (no row required; treated as Infinity).
 *   - child session: `remaining_depth` from its row; must be > 0 to register
 *     the `mapreduce` tool; must be > 0 at execute-time to actually spawn.
 *   - each track a child spawns receives `min(track.depth ?? 0, parent.remaining_depth - 1, HARD_CAP)`.
 *
 * Uses `node:sqlite` (bundled since Node 22.5). If the module cannot be loaded,
 * all functions fail closed: `get` returns `null` and `insert`/`mark*` throw.
 * The caller (`index.ts`) treats that as "no mapreduce available".
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Type-only import so we don't blow up at module load time on environments
// that lack `node:sqlite`. Runtime import is lazy inside `open()`.
type DatabaseSyncInstance = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
  };
  close(): void;
};

export interface LineageRow {
  lineage_id: string;
  parent_lineage_id: string | null;
  root_lineage_id: string;
  session_file: string;
  track_name: string | null;
  remaining_depth: number;
  granted_depth: number;
  created_at: number;
  finished_at: number | null;
  status: "running" | "finished" | "aborted";
}

let db: DatabaseSyncInstance | null = null;
let initError: Error | null = null;
let attempted = false;

export function dbPath(): string {
  return join(homedir(), ".pi", "subagents", "lineage.db");
}

function open(): DatabaseSyncInstance | null {
  if (db) return db;
  if (attempted) return null;
  attempted = true;

  try {
    // Lazy require so module load never fails on environments without node:sqlite.
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSyncInstance };
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    const instance = new DatabaseSync(path);
    instance.exec(`
      CREATE TABLE IF NOT EXISTS lineage (
        lineage_id         TEXT PRIMARY KEY,
        parent_lineage_id  TEXT,
        root_lineage_id    TEXT NOT NULL,
        session_file       TEXT NOT NULL,
        track_name         TEXT,
        remaining_depth    INTEGER NOT NULL,
        granted_depth      INTEGER NOT NULL,
        created_at         INTEGER NOT NULL,
        finished_at        INTEGER,
        status             TEXT NOT NULL DEFAULT 'running'
      );
      CREATE INDEX IF NOT EXISTS lineage_parent ON lineage(parent_lineage_id);
      CREATE INDEX IF NOT EXISTS lineage_root   ON lineage(root_lineage_id);
      CREATE INDEX IF NOT EXISTS lineage_status ON lineage(status);
    `);
    db = instance;
    return db;
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    return null;
  }
}

export function isAvailable(): boolean {
  return open() !== null;
}

export function getInitError(): Error | null {
  return initError;
}

export function get(id: string): LineageRow | null {
  const d = open();
  if (!d) return null;
  try {
    const row = d.prepare("SELECT * FROM lineage WHERE lineage_id = ?").get(id) as LineageRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export function insert(row: LineageRow): void {
  const d = open();
  if (!d) throw new Error(`Lineage DB unavailable: ${initError?.message ?? "unknown"}`);
  d.prepare(
    `INSERT OR REPLACE INTO lineage
       (lineage_id, parent_lineage_id, root_lineage_id, session_file, track_name,
        remaining_depth, granted_depth, created_at, finished_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.lineage_id,
    row.parent_lineage_id,
    row.root_lineage_id,
    row.session_file,
    row.track_name,
    row.remaining_depth,
    row.granted_depth,
    row.created_at,
    row.finished_at,
    row.status,
  );
}

export function markFinished(id: string | undefined): void {
  if (!id) return;
  const d = open();
  if (!d) return;
  try {
    d.prepare(
      "UPDATE lineage SET status = 'finished', finished_at = ? WHERE lineage_id = ? AND status = 'running'",
    ).run(Date.now(), id);
  } catch {
    /* best-effort */
  }
}

export function markAborted(id: string | undefined): void {
  if (!id) return;
  const d = open();
  if (!d) return;
  try {
    d.prepare(
      "UPDATE lineage SET status = 'aborted', finished_at = ? WHERE lineage_id = ? AND status = 'running'",
    ).run(Date.now(), id);
  } catch {
    /* best-effort */
  }
}
