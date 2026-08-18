import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type NodeRecoveryJobKind = "export" | "restore";
export type NodeRecoveryJobState =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "succeeded"
  | "failed";

export interface NodeRecoveryJobRecord {
  id: string;
  kind: NodeRecoveryJobKind;
  state: NodeRecoveryJobState;
  bundleKey: string;
  request: Record<string, unknown>;
  result: Record<string, unknown>;
  attempts: number;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

type Row = Record<string, unknown>;

function parseRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export class NodeRecoveryStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS node_recovery_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('export', 'restore')),
        state TEXT NOT NULL CHECK(state IN (
          'queued', 'running', 'awaiting_confirmation', 'succeeded', 'failed'
        )),
        bundle_key TEXT NOT NULL DEFAULT '',
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        finished_at REAL
      );
      CREATE INDEX IF NOT EXISTS node_recovery_jobs_state
        ON node_recovery_jobs(state, created_at, id);
      UPDATE node_recovery_jobs
      SET state = 'queued', updated_at = unixepoch()
      WHERE state = 'running';
    `);
  }

  close(): void {
    this.db.close();
  }

  create(input: {
    id: string;
    kind: NodeRecoveryJobKind;
    bundleKey?: string;
    request: Record<string, unknown>;
  }): NodeRecoveryJobRecord {
    const now = Date.now() / 1_000;
    this.db.prepare(`
      INSERT INTO node_recovery_jobs
        (id, kind, state, bundle_key, request_json, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?, ?)
    `).run(
      input.id,
      input.kind,
      input.bundleKey ?? "",
      JSON.stringify(input.request),
      now,
      now,
    );
    return this.get(input.id)!;
  }

  get(id: string): NodeRecoveryJobRecord | null {
    const row = this.db.prepare("SELECT * FROM node_recovery_jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.record(row) : null;
  }

  list(limit = 30): NodeRecoveryJobRecord[] {
    return (this.db.prepare(`
      SELECT * FROM node_recovery_jobs ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => this.record(row));
  }

  claimNext(): NodeRecoveryJobRecord | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT id FROM node_recovery_jobs WHERE state = 'queued'
        ORDER BY created_at, id LIMIT 1
      `).get() as { id?: unknown } | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const now = Date.now() / 1_000;
      this.db.prepare(`
        UPDATE node_recovery_jobs
        SET state = 'running', attempts = attempts + 1, last_error = '', updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(now, String(row.id));
      this.db.exec("COMMIT");
      return this.get(String(row.id));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  awaitConfirmation(id: string, result: Record<string, unknown>, bundleKey: string): void {
    const updated = this.db.prepare(`
      UPDATE node_recovery_jobs
      SET state = 'awaiting_confirmation', result_json = ?, bundle_key = ?, updated_at = ?
      WHERE id = ? AND state = 'running'
    `).run(JSON.stringify(result), bundleKey, Date.now() / 1_000, id);
    if (Number(updated.changes) !== 1) throw new Error("node recovery job is not running");
  }

  confirmRestore(id: string): NodeRecoveryJobRecord {
    const current = this.get(id);
    if (!current || current.kind !== "restore") throw new Error("node recovery restore job does not exist");
    if (current.state !== "awaiting_confirmation") {
      throw new Error("node recovery restore is not awaiting confirmation");
    }
    const updated = this.db.prepare(`
      UPDATE node_recovery_jobs
      SET state = 'queued', request_json = ?, updated_at = ?
      WHERE id = ? AND state = 'awaiting_confirmation'
    `).run(JSON.stringify({ ...current.request, confirmed: true }), Date.now() / 1_000, id);
    if (Number(updated.changes) !== 1) throw new Error("node recovery restore confirmation raced");
    return this.get(id)!;
  }

  succeed(id: string, result: Record<string, unknown>, bundleKey = ""): void {
    const now = Date.now() / 1_000;
    const updated = this.db.prepare(`
      UPDATE node_recovery_jobs
      SET state = 'succeeded', result_json = ?,
        bundle_key = CASE WHEN ? <> '' THEN ? ELSE bundle_key END,
        updated_at = ?, finished_at = ?
      WHERE id = ? AND state = 'running'
    `).run(JSON.stringify(result), bundleKey, bundleKey, now, now, id);
    if (Number(updated.changes) !== 1) throw new Error("node recovery job is not running");
  }

  fail(id: string, error: unknown): void {
    const now = Date.now() / 1_000;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    this.db.prepare(`
      UPDATE node_recovery_jobs
      SET state = 'failed', last_error = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND state = 'running'
    `).run(message, now, now, id);
  }

  private record(row: Row): NodeRecoveryJobRecord {
    const kind = String(row.kind);
    const state = String(row.state);
    if (kind !== "export" && kind !== "restore") throw new Error("invalid node recovery job kind");
    if (![
      "queued",
      "running",
      "awaiting_confirmation",
      "succeeded",
      "failed",
    ].includes(state)) throw new Error("invalid node recovery job state");
    return {
      id: String(row.id),
      kind,
      state: state as NodeRecoveryJobState,
      bundleKey: String(row.bundle_key ?? ""),
      request: parseRecord(row.request_json),
      result: parseRecord(row.result_json),
      attempts: Number(row.attempts ?? 0),
      lastError: String(row.last_error ?? ""),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    };
  }
}
