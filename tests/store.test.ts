import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { PgStore } from "../src/lib/store/pgStore";
import { emptyState } from "../src/lib/store/appStore";

/**
 * Minimal in-process stand-in for the three statements PgStore uses (DDL, select, insert/update with version check).
 * It verifies the store's versioning logic; the real SQL runs against PostgreSQL in deployment (see docs/DEPLOYMENT.md).
 */
function fakePool(): Pool {
  let row: { version: number; data: unknown } | null = null;
  const history: unknown[] = [];
  return {
    async query(sql: string, params: unknown[] = []) {
      const q = sql.trim();
      if (q.startsWith("CREATE TABLE")) return { rowCount: 0, rows: [] };
      if (q.startsWith("SELECT version, data")) return row ? { rowCount: 1, rows: [{ version: String(row.version), data: row.data }] } : { rowCount: 0, rows: [] };
      if (q.startsWith("INSERT INTO fridge_ops_state (")) {
        if (row) return { rowCount: 0, rows: [] };
        row = { version: Number(params[0]), data: JSON.parse(String(params[1])) };
        return { rowCount: 1, rows: [] };
      }
      if (q.startsWith("UPDATE fridge_ops_state")) {
        if (!row || row.version !== Number(params[2])) return { rowCount: 0, rows: [] };
        row = { version: Number(params[0]), data: JSON.parse(String(params[1])) };
        return { rowCount: 1, rows: [] };
      }
      if (q.startsWith("INSERT INTO fridge_ops_state_history")) {
        history.push(params[1]);
        return { rowCount: 1, rows: [] };
      }
      if (q.startsWith("DELETE FROM fridge_ops_state_history")) return { rowCount: 0, rows: [] };
      throw new Error(`unexpected SQL: ${q.slice(0, 60)}`);
    },
  } as unknown as Pool;
}

test("PostgreSQL store: first load is empty, save/load round-trips", async () => {
  const pool = fakePool();
  const a = new PgStore("", pool);
  const s0 = await a.load();
  assert.equal(s0.schema, 3);
  assert.equal(s0.missions.length, 0);
  s0.missionSeq = 7;
  s0.users.push({ id: "U-1", login: "anna", name: "Анна", role: "EMPLOYEE", pinHash: "x", active: true, createdAt: 1, pinUpdatedAt: 1 });
  await a.save(s0);
  s0.missionSeq = 8;
  await a.save(s0);
  const s1 = await new PgStore("", pool).load();
  assert.equal(s1.missionSeq, 8);
  assert.equal(s1.users[0].login, "anna");
});

test("PostgreSQL store refuses to overwrite a newer version from another instance", async () => {
  const pool = fakePool();
  const a = new PgStore("", pool);
  const b = new PgStore("", pool);
  await a.load();
  await a.save(emptyState());
  await b.load();
  await b.save(emptyState()); // b is now ahead
  await assert.rejects(() => a.save(emptyState()), /another server instance/);
});
