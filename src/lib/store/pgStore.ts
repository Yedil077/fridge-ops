import { Pool } from "pg";
import { compact, migrate, type AppState, type StateStore } from "./appStore";

/**
 * PostgreSQL driver — the production source of truth shared by desktop, mobile web and Android.
 *
 * Storage: one versioned JSONB document per application (`fridge_ops_state`). Writes are optimistic
 * (version check), so two server instances can never silently overwrite each other — run ONE app
 * instance per database (see docs/DEPLOYMENT.md). The normalized target model for later growth is
 * described in prisma/schema.prisma.
 */

const DDL = `
CREATE TABLE IF NOT EXISTS fridge_ops_state (
  id          INTEGER PRIMARY KEY,
  version     BIGINT NOT NULL,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fridge_ops_state_history (
  id          BIGSERIAL PRIMARY KEY,
  version     BIGINT NOT NULL,
  data        JSONB NOT NULL,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const HISTORY_EVERY = 50; // keep a snapshot every N writes for recovery

export class PgStore implements StateStore {
  readonly kind = "postgres" as const;
  private pool: Pool;
  private version = 0;
  private ready: Promise<void>;

  /** `pool` can be injected (tests); otherwise created from DATABASE_URL. */
  constructor(url: string, pool?: Pool) {
    if (!url && !pool) throw new Error("DATABASE_URL is required for STORE_DRIVER=postgres");
    this.pool = pool ?? new Pool({
      connectionString: url,
      max: 4,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: process.env.DATABASE_SSL_STRICT !== "false" } : undefined,
    });
    this.ready = this.pool.query(DDL).then(() => undefined);
  }

  async load(): Promise<AppState> {
    await this.ready;
    const r = await this.pool.query<{ version: string; data: Record<string, unknown> }>("SELECT version, data FROM fridge_ops_state WHERE id = 1");
    if (!r.rowCount) {
      this.version = 0;
      return migrate(null);
    }
    this.version = Number(r.rows[0].version);
    return migrate(r.rows[0].data);
  }

  async save(state: AppState): Promise<void> {
    await this.ready;
    const data = JSON.stringify(compact(state));
    const next = this.version + 1;
    const r =
      this.version === 0
        ? await this.pool.query(
            "INSERT INTO fridge_ops_state (id, version, data) VALUES (1, $1, $2::jsonb) ON CONFLICT (id) DO NOTHING",
            [next, data],
          )
        : await this.pool.query("UPDATE fridge_ops_state SET version = $1, data = $2::jsonb, updated_at = now() WHERE id = 1 AND version = $3", [
            next,
            data,
            this.version,
          ]);
    if (r.rowCount !== 1) {
      throw new Error("fridge_ops_state was changed by another server instance — refusing to overwrite. Run a single app instance.");
    }
    this.version = next;
    if (next % HISTORY_EVERY === 0) {
      await this.pool.query("INSERT INTO fridge_ops_state_history (version, data) VALUES ($1, $2::jsonb)", [next, data]);
      await this.pool.query("DELETE FROM fridge_ops_state_history WHERE id NOT IN (SELECT id FROM fridge_ops_state_history ORDER BY id DESC LIMIT 48)");
    }
  }
}
