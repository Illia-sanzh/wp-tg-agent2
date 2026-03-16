import Database from "better-sqlite3";
import * as path from "path";
import { log, DATA_DIR } from "./config";

const AUDIT_DB = path.join(DATA_DIR, "audit.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(AUDIT_DB);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT NOT NULL,
        profile TEXT,
        message TEXT,
        model TEXT,
        result TEXT,
        elapsed_ms INTEGER,
        tokens_in INTEGER,
        tokens_out INTEGER,
        status TEXT NOT NULL DEFAULT 'ok'
      )
    `);
  }
  return db;
}

export interface AuditEntry {
  source: string;
  profile?: string;
  message?: string;
  model?: string;
  result?: string;
  elapsed_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  status?: string;
}

export function logAudit(entry: AuditEntry): void {
  try {
    const d = getDb();
    d.prepare(
      `
      INSERT INTO audit_log (source, profile, message, model, result, elapsed_ms, tokens_in, tokens_out, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      entry.source,
      entry.profile ?? null,
      entry.message ? entry.message.slice(0, 500) : null,
      entry.model ?? null,
      entry.result ? entry.result.slice(0, 2000) : null,
      entry.elapsed_ms ?? null,
      entry.tokens_in ?? null,
      entry.tokens_out ?? null,
      entry.status ?? "ok",
    );
  } catch (e) {
    log.error({ err: e }, "audit log write failed");
  }
}

export interface AuditStats {
  total_tasks: number;
  last_24h: number;
  by_profile: Record<string, number>;
  by_model: Record<string, number>;
  errors_24h: number;
  avg_elapsed_ms: number | null;
}

export function getAuditStats(): AuditStats {
  try {
    const d = getDb();

    const total = (d.prepare("SELECT COUNT(*) as c FROM audit_log").get() as any).c;
    const last24h = (
      d.prepare("SELECT COUNT(*) as c FROM audit_log WHERE timestamp > datetime('now', '-1 day')").get() as any
    ).c;
    const errors24h = (
      d
        .prepare("SELECT COUNT(*) as c FROM audit_log WHERE status != 'ok' AND timestamp > datetime('now', '-1 day')")
        .get() as any
    ).c;
    const avgElapsed = (
      d
        .prepare(
          "SELECT AVG(elapsed_ms) as a FROM audit_log WHERE elapsed_ms IS NOT NULL AND timestamp > datetime('now', '-1 day')",
        )
        .get() as any
    ).a;

    const byProfile: Record<string, number> = {};
    const profileRows = d
      .prepare(
        "SELECT profile, COUNT(*) as c FROM audit_log WHERE profile IS NOT NULL GROUP BY profile ORDER BY c DESC LIMIT 10",
      )
      .all() as any[];
    for (const row of profileRows) byProfile[row.profile] = row.c;

    const byModel: Record<string, number> = {};
    const modelRows = d
      .prepare(
        "SELECT model, COUNT(*) as c FROM audit_log WHERE model IS NOT NULL GROUP BY model ORDER BY c DESC LIMIT 10",
      )
      .all() as any[];
    for (const row of modelRows) byModel[row.model] = row.c;

    return {
      total_tasks: total,
      last_24h: last24h,
      by_profile: byProfile,
      by_model: byModel,
      errors_24h: errors24h,
      avg_elapsed_ms: avgElapsed ? Math.round(avgElapsed) : null,
    };
  } catch (e) {
    log.error({ err: e }, "audit stats query failed");
    return { total_tasks: 0, last_24h: 0, by_profile: {}, by_model: {}, errors_24h: 0, avg_elapsed_ms: null };
  }
}

export function getRecentAuditEntries(limit = 20): any[] {
  try {
    const d = getDb();
    return d.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
  } catch (e) {
    log.error({ err: e }, "audit recent query failed");
    return [];
  }
}
