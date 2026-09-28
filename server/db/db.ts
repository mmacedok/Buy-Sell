import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Silencia apenas o aviso "SQLite is experimental" do Node.
const origEmit = process.emitWarning;
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  const msg = typeof w === "string" ? w : w.message;
  if (msg.includes("SQLite is an experimental feature")) return;
  return (origEmit as (...a: unknown[]) => void).call(process, w, ...rest);
}) as typeof process.emitWarning;

const here = dirname(fileURLToPath(import.meta.url));

export type Row = Record<string, any>;
export type Param = SQLInputValue;

export class DB {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.raw.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: Param[]) {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  /** Transação reentrante (savepoints). Tudo ou nada — essencial para contabilidade. */
  tx<T>(fn: () => T): T {
    const name = `sp${this.depth++}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      this.raw.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }

  getSetting<T>(key: string, fallback: T): T {
    const r = this.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = ?", key);
    return r ? (JSON.parse(r.value_json) as T) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.run(
      "INSERT INTO settings(key, value_json) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      key,
      JSON.stringify(value),
    );
  }

  close() {
    this.raw.close();
  }
}

export const iso = (d: Date) => d.toISOString();
