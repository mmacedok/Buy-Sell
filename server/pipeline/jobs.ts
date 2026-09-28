import type { DB } from "../db/db.js";
import { iso } from "../db/db.js";

/** Estado persistido de rotinas (sobrevive a reinícios). */
export function jobState(db: DB, name: string) {
  return db.get<{ name: string; last_run_at: string | null; last_ok_at: string | null; last_error: string | null; info_json: string | null }>(
    "SELECT * FROM job_state WHERE name = ?", name,
  );
}

export function markJob(db: DB, name: string, now: Date, ok: boolean, info?: unknown, error?: string) {
  db.run(
    `INSERT INTO job_state(name, last_run_at, last_ok_at, last_error, info_json) VALUES(?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at,
       last_ok_at = COALESCE(excluded.last_ok_at, job_state.last_ok_at),
       last_error = excluded.last_error, info_json = COALESCE(excluded.info_json, job_state.info_json)`,
    name, iso(now), ok ? iso(now) : null, ok ? null : (error ?? "erro"), info === undefined ? null : JSON.stringify(info),
  );
}
