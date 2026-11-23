export interface SqliteStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
}

export const HISTORY_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS dictations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    service_id TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_sec REAL,
    elapsed_ms INTEGER NOT NULL,
    audio_bytes INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    parts INTEGER NOT NULL DEFAULT 1,
    raw_text TEXT NOT NULL DEFAULT '',
    edited_text TEXT NOT NULL DEFAULT '',
    edit_model TEXT,
    error_message TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dictations_created_at ON dictations(created_at DESC)`,
] as const;

export interface DictationRecord {
  id: number;
  createdAt: string;
  serviceId: string;
  status: "ok" | "failed";
  durationSec: number | null;
  elapsedMs: number;
  audioBytes: number;
  mimeType: string;
  parts: number;
  rawText: string;
  editedText: string;
  editModel: string | null;
  errorMessage: string | null;
}

export interface DictationStats {
  total: number;
  ok: number;
  failed: number;
  totalDurationSec: number;
  totalChars: number;
}

interface RawRow {
  id: number;
  created_at: string;
  service_id: string;
  status: string;
  duration_sec: number | null;
  elapsed_ms: number;
  audio_bytes: number;
  mime_type: string;
  parts: number;
  raw_text: string;
  edited_text: string;
  edit_model: string | null;
  error_message: string | null;
}

function mapRow(row: RawRow): DictationRecord {
  return {
    id: Number(row.id),
    createdAt: row.created_at,
    serviceId: row.service_id,
    status: row.status === "failed" ? "failed" : "ok",
    durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
    elapsedMs: Number(row.elapsed_ms),
    audioBytes: Number(row.audio_bytes),
    mimeType: row.mime_type,
    parts: Number(row.parts),
    rawText: row.raw_text,
    editedText: row.edited_text,
    editModel: row.edit_model,
    errorMessage: row.error_message,
  };
}

export function createDictationHistory(openDb: () => SqliteDatabase) {
  let db: SqliteDatabase | undefined;
  const getDb = () => {
    if (!db) db = openDb();
    return db;
  };

  return {
    recordTranscribed(input: {
      serviceId: string;
      durationSec: number | null;
      elapsedMs: number;
      audioBytes: number;
      mimeType: string;
      parts: number;
      rawText: string;
      createdAt?: string;
    }): number {
      const result = getDb()
        .prepare(
          `INSERT INTO dictations (
            created_at, service_id, status, duration_sec, elapsed_ms,
            audio_bytes, mime_type, parts, raw_text, edited_text
          ) VALUES (?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.createdAt ?? new Date().toISOString(),
          input.serviceId,
          input.durationSec,
          Math.max(0, Math.round(input.elapsedMs)),
          input.audioBytes,
          input.mimeType,
          input.parts,
          input.rawText,
          input.rawText,
        );
      return Number(result.lastInsertRowid);
    },

    updateEdited(input: {
      id: number;
      editedText: string;
      editModel: string | null;
      elapsedMs: number;
    }): void {
      getDb()
        .prepare(
          `UPDATE dictations
           SET edited_text = ?, edit_model = ?, elapsed_ms = ?
           WHERE id = ?`,
        )
        .run(
          input.editedText,
          input.editModel,
          Math.max(0, Math.round(input.elapsedMs)),
          input.id,
        );
    },

    recordFailure(input: {
      serviceId: string;
      elapsedMs: number;
      audioBytes: number;
      mimeType: string;
      errorMessage: string;
      createdAt?: string;
    }): number {
      const result = getDb()
        .prepare(
          `INSERT INTO dictations (
            created_at, service_id, status, duration_sec, elapsed_ms,
            audio_bytes, mime_type, parts, raw_text, edited_text, error_message
          ) VALUES (?, ?, 'failed', NULL, ?, ?, ?, 0, '', '', ?)`,
        )
        .run(
          input.createdAt ?? new Date().toISOString(),
          input.serviceId,
          Math.max(0, Math.round(input.elapsedMs)),
          input.audioBytes,
          input.mimeType,
          input.errorMessage,
        );
      return Number(result.lastInsertRowid);
    },

    get(id: number): DictationRecord | null {
      const row = getDb()
        .prepare(`SELECT * FROM dictations WHERE id = ?`)
        .get(id) as RawRow | undefined;
      return row ? mapRow(row) : null;
    },

    list(opts: {
      limit?: number;
      since?: string;
      serviceId?: string;
      includeFailed?: boolean;
    } = {}): DictationRecord[] {
      const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (!opts.includeFailed) {
        clauses.push(`status = 'ok'`);
      }
      if (opts.since) {
        clauses.push(`created_at >= ?`);
        params.push(opts.since);
      }
      if (opts.serviceId) {
        clauses.push(`service_id = ?`);
        params.push(opts.serviceId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = getDb()
        .prepare(
          `SELECT * FROM dictations ${where} ORDER BY id DESC LIMIT ?`,
        )
        .all(...params, limit) as RawRow[];
      return rows.map(mapRow);
    },

    search(query: string, opts: { limit?: number } = {}): DictationRecord[] {
      const needle = query.trim().toLocaleLowerCase();
      if (!needle) return [];
      const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
      // Unicode-aware case-insensitive search (SQLite LIKE is ASCII-only for Cyrillic).
      const rows = getDb()
        .prepare(`SELECT * FROM dictations WHERE status = 'ok' ORDER BY id DESC`)
        .all() as RawRow[];
      const matches: DictationRecord[] = [];
      for (const row of rows) {
        if (
          row.edited_text.toLocaleLowerCase().includes(needle) ||
          row.raw_text.toLocaleLowerCase().includes(needle)
        ) {
          matches.push(mapRow(row));
          if (matches.length >= limit) break;
        }
      }
      return matches;
    },

    stats(): DictationStats {
      const row = getDb()
        .prepare(
          `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS ok,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN status = 'ok' THEN COALESCE(duration_sec, 0) ELSE 0 END), 0) AS total_duration_sec,
            COALESCE(SUM(CASE WHEN status = 'ok' THEN LENGTH(edited_text) ELSE 0 END), 0) AS total_chars
          FROM dictations`,
        )
        .get() as {
        total: number;
        ok: number;
        failed: number;
        total_duration_sec: number;
        total_chars: number;
      };
      return {
        total: Number(row.total),
        ok: Number(row.ok),
        failed: Number(row.failed),
        totalDurationSec: Number(row.total_duration_sec),
        totalChars: Number(row.total_chars),
      };
    },
  };
}

export type DictationHistory = ReturnType<typeof createDictationHistory>;
