import "server-only";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

/**
 * Keeps the last finished "что удалить из KiT Shop" Excel in OUR database, so it survives a sleeping / restarted server
 * (free Render forgets memory after ~15 min without visitors). PostgreSQL table report_files; local dev: .data/.
 */

export interface StoredReport {
  name: string;
  data: Uint8Array;
  summary: unknown;
  /** ms (real time) when the report finished */
  finishedAt: number;
  startedBy: string | null;
}

const KEY = "unused-products";

let pool: Pool | null | undefined;
function db(): Pool | null {
  if (pool !== undefined) return pool;
  const url = process.env.DATABASE_URL;
  const driver = process.env.STORE_DRIVER ?? (url ? "postgres" : "file");
  pool =
    driver === "postgres" && url
      ? new Pool({
          connectionString: url,
          max: 1,
          connectionTimeoutMillis: 15_000,
          ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: process.env.DATABASE_SSL_STRICT !== "false" } : undefined,
        })
      : null;
  return pool;
}

let ready: Promise<void> | null = null;
const ensure = (p: Pool) =>
  (ready ??= p
    .query(
      "CREATE TABLE IF NOT EXISTS report_files (key TEXT PRIMARY KEY, name TEXT NOT NULL, data BYTEA NOT NULL, summary JSONB, finished_at BIGINT NOT NULL, started_by TEXT)",
    )
    .then(() => undefined));

const dir = () => path.join(process.cwd(), process.env.FILE_STORE_DIR || ".data");

export async function saveReport(r: StoredReport): Promise<void> {
  const p = db();
  if (p) {
    await ensure(p);
    await p.query(
      `INSERT INTO report_files (key, name, data, summary, finished_at, started_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, summary = EXCLUDED.summary, finished_at = EXCLUDED.finished_at, started_by = EXCLUDED.started_by`,
      [KEY, r.name, Buffer.from(r.data), JSON.stringify(r.summary ?? null), r.finishedAt, r.startedBy],
    );
    return;
  }
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `${KEY}.xlsx`), r.data);
  fs.writeFileSync(path.join(dir(), `${KEY}.json`), JSON.stringify({ name: r.name, summary: r.summary, finishedAt: r.finishedAt, startedBy: r.startedBy }));
}

export async function loadReport(): Promise<StoredReport | null> {
  try {
    const p = db();
    if (p) {
      await ensure(p);
      const r = await p.query<{ name: string; data: Buffer; summary: unknown; finished_at: string; started_by: string | null }>(
        "SELECT name, data, summary, finished_at, started_by FROM report_files WHERE key = $1",
        [KEY],
      );
      const row = r.rows[0];
      return row ? { name: row.name, data: new Uint8Array(row.data), summary: row.summary, finishedAt: Number(row.finished_at), startedBy: row.started_by } : null;
    }
    const meta = JSON.parse(fs.readFileSync(path.join(dir(), `${KEY}.json`), "utf8"));
    return { ...meta, data: new Uint8Array(fs.readFileSync(path.join(dir(), `${KEY}.xlsx`))) };
  } catch {
    return null;
  }
}
