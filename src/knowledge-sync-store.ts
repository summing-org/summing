import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";

export type ConnectorState = "authorizing" | "ready" | "degraded" | "revoked";
export type CollectorState =
  | "not_started"
  | "backfilling"
  | "collected"
  | "tailing"
  | "paused"
  | "failed";
export type SyncStageName = "media" | "extraction" | "fts" | "embeddings" | "knowledge";
export type SyncStageState = "pending" | "running" | "ready" | "degraded" | "failed";
export type ConsentStatus = "granted" | "revoked";
export const GROUP_CONSENT_TELEGRAM_USER_ID = 0;
export type KnowledgeTransferKind = "export" | "import";
export type KnowledgeTransferMode = "manifest" | "portable";
export type KnowledgeTransferState =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "succeeded"
  | "failed";
export type HistoryRecoveryState = "queued" | "running" | "succeeded" | "failed";

export interface KnowledgeTransferRecord {
  id: string;
  kind: KnowledgeTransferKind;
  mode: KnowledgeTransferMode;
  state: KnowledgeTransferState;
  sourceId: string | null;
  bundleKey: string;
  request: Record<string, unknown>;
  result: Record<string, unknown>;
  attempts: number;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ImportedKnowledgeSource {
  sourceId: string;
  telegramChatId: number;
  title: string;
  checkpoint: Record<string, unknown>;
  importedAt: number;
}

export interface MtprotoConnectorRecord {
  id: string;
  state: ConnectorState;
  apiId: number;
  encryptedApiHash: string;
  phoneMask: string;
  databaseDirectory: string;
  lastUpdateAt: number | null;
  lastError: string;
  createdAt: number;
  updatedAt: number;
}

export interface SourceConnectorBinding {
  sourceId: string;
  connectorId: string;
  telegramChatId: number;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamConsentRecord {
  sourceId: string;
  telegramUserId: number;
  status: ConsentStatus;
  scope: string[];
  grantedAt: number;
  historicalFrom: number | null;
  proof: string;
  revokedAt: number | null;
  updatedAt: number;
}

export interface SyncStageStatus {
  name: SyncStageName;
  state: SyncStageState;
  completed: number;
  total: number;
  failed: number;
  lastError: string;
  nextRetryAt: number | null;
  updatedAt: number;
}

export interface SyncCounters {
  discovered: number;
  accepted: number;
  skipped: number;
  consentedAuthors: number;
  unknownAuthors: number;
  mediaDiscovered: number;
  mediaUploaded: number;
  mediaPending: number;
  mediaFailed: number;
}

export interface SkippedAuthorStatus {
  telegramUserId: number;
  messageCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface SkippedAuthorBreakdown {
  totalAuthors: number;
  attributedMessages: number;
  unattributedMessages: number;
  truncated: boolean;
  items: SkippedAuthorStatus[];
}

export interface HistoryRecoveryStatus {
  sourceId: string;
  state: HistoryRecoveryState;
  fromMessageId: number;
  recoveredMessages: number;
  lastError: string;
  requestedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface SyncStatus {
  sourceId: string;
  connectorId: string;
  telegramChatId: number;
  title: string;
  connector: {
    state: ConnectorState;
    phoneMask: string;
    lastUpdateAt: number | null;
    lastError: string;
  };
  collector: {
    state: CollectorState;
    generation: number;
    startedAt: number | null;
    initialCollectedAt: number | null;
    lastEventAt: number | null;
    lastLiveEventAt: number | null;
    firstMessageAt: number | null;
    lastMessageAt: number | null;
    checkpoint: string;
    lagSeconds: number | null;
  };
  counters: SyncCounters;
  groupConsent: {
    granted: boolean;
    scope: string[];
    historicalFrom: number | null;
  };
  historyRecovery: HistoryRecoveryStatus | null;
  unknownAuthorIds: number[];
  skippedByAuthor: SkippedAuthorBreakdown;
  stages: Record<SyncStageName, SyncStageStatus>;
  warning: string;
  lastError: string;
  nextRetryAt: number | null;
}

export interface SyncCheckpoint {
  sourceId: string;
  runId: number;
  fromMessageId: number;
  cursor: Record<string, unknown>;
  updatedAt: number;
}

export interface IngestionJob {
  id: number;
  sourceId: string;
  kind: SyncStageName;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: number;
}

export interface SyncOutboxItem {
  id: number;
  sourceId: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface CanonicalBlockInput {
  objectHash: string;
  sourceId: string;
  blockKind: string;
  ordinal: number;
  text: string;
  locator: Record<string, unknown>;
  structure: Record<string, unknown>;
}

type Row = Record<string, SQLInputValue>;

const STAGES: SyncStageName[] = ["media", "extraction", "fts", "embeddings", "knowledge"];

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

function parseStrings(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function sqlValue(value: SQLInputValue | undefined): SQLInputValue {
  return value ?? null;
}

export class KnowledgeSyncStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
    this.createSchema();
  }

  close(): void {
    this.db.close();
  }

  async backupTo(path: string): Promise<void> {
    await backup(this.db, path);
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mtproto_connectors (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('authorizing','ready','degraded','revoked')),
        api_id INTEGER NOT NULL,
        encrypted_api_hash TEXT NOT NULL,
        phone_mask TEXT NOT NULL,
        database_directory TEXT NOT NULL,
        last_update_at REAL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_source_connectors (
        source_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL REFERENCES mtproto_connectors(id),
        telegram_chat_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        UNIQUE(connector_id, telegram_chat_id)
      );
      CREATE INDEX IF NOT EXISTS team_source_connectors_chat
        ON team_source_connectors(telegram_chat_id, connector_id);
      CREATE TABLE IF NOT EXISTS team_consents (
        source_id TEXT NOT NULL,
        telegram_user_id INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('granted','revoked')),
        scope_json TEXT NOT NULL,
        granted_at REAL NOT NULL,
        historical_from REAL,
        proof TEXT NOT NULL DEFAULT '',
        revoked_at REAL,
        updated_at REAL NOT NULL,
        PRIMARY KEY(source_id, telegram_user_id)
      );
      CREATE TABLE IF NOT EXISTS team_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        connector_id TEXT NOT NULL REFERENCES mtproto_connectors(id),
        generation INTEGER NOT NULL,
        collector_state TEXT NOT NULL CHECK(collector_state IN
          ('not_started','backfilling','collected','tailing','paused','failed')),
        discovered_count INTEGER NOT NULL DEFAULT 0,
        accepted_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        consented_authors INTEGER NOT NULL DEFAULT 0,
        unknown_authors INTEGER NOT NULL DEFAULT 0,
        media_discovered INTEGER NOT NULL DEFAULT 0,
        media_uploaded INTEGER NOT NULL DEFAULT 0,
        media_pending INTEGER NOT NULL DEFAULT 0,
        media_failed INTEGER NOT NULL DEFAULT 0,
        first_message_at REAL,
        last_message_at REAL,
        last_event_at REAL,
        last_live_event_at REAL,
        initial_collected_at REAL,
        warning TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        next_retry_at REAL,
        started_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        UNIQUE(source_id, generation)
      );
      CREATE INDEX IF NOT EXISTS team_sync_runs_source
        ON team_sync_runs(source_id, generation DESC);
      CREATE TABLE IF NOT EXISTS team_sync_checkpoints (
        source_id TEXT PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES team_sync_runs(id) ON DELETE CASCADE,
        from_message_id INTEGER NOT NULL DEFAULT 0,
        cursor_json TEXT NOT NULL DEFAULT '{}',
        updated_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_sync_stages (
        source_id TEXT NOT NULL,
        stage TEXT NOT NULL CHECK(stage IN ('media','extraction','fts','embeddings','knowledge')),
        state TEXT NOT NULL CHECK(state IN ('pending','running','ready','degraded','failed')),
        completed_count INTEGER NOT NULL DEFAULT 0,
        total_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        next_retry_at REAL,
        updated_at REAL NOT NULL,
        PRIMARY KEY(source_id, stage)
      );
      CREATE TABLE IF NOT EXISTS team_sync_unknown_authors (
        source_id TEXT NOT NULL,
        telegram_user_id INTEGER NOT NULL,
        first_seen_at REAL NOT NULL,
        last_seen_at REAL NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 1,
        recovered_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source_id, telegram_user_id)
      );
      CREATE TABLE IF NOT EXISTS team_sync_history_recovery (
        source_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
        from_message_id INTEGER NOT NULL DEFAULT 0,
        recovered_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        requested_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        completed_at REAL
      );
      CREATE TABLE IF NOT EXISTS team_event_revisions (
        source_id TEXT NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        event_kind TEXT NOT NULL CHECK(event_kind IN ('message','edit','deletion')),
        team_event_id INTEGER,
        occurred_at REAL NOT NULL,
        PRIMARY KEY(source_id, telegram_message_id, revision, event_kind)
      );
      CREATE TABLE IF NOT EXISTS team_ingestion_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('media','extraction','fts','embeddings','knowledge')),
        dedupe_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at REAL NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        UNIQUE(source_id, kind, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS team_ingestion_jobs_pending
        ON team_ingestion_jobs(state, next_attempt_at, kind, id);
      CREATE TABLE IF NOT EXISTS team_sync_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at REAL NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        sent_at REAL
      );
      CREATE INDEX IF NOT EXISTS team_sync_outbox_pending
        ON team_sync_outbox(state, next_attempt_at, id);
      CREATE TABLE IF NOT EXISTS content_objects (
        sha256 TEXT PRIMARY KEY,
        object_key TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL DEFAULT '',
        backend TEXT NOT NULL CHECK(backend IN ('local','s3')),
        stored_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS content_object_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL REFERENCES content_objects(sha256),
        source_id TEXT NOT NULL,
        telegram_user_id INTEGER,
        ref_type TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at REAL NOT NULL,
        UNIQUE(source_id, ref_type, ref_id, sha256)
      );
      CREATE TABLE IF NOT EXISTS document_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_hash TEXT NOT NULL REFERENCES content_objects(sha256),
        source_id TEXT NOT NULL,
        block_kind TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        locator_json TEXT NOT NULL DEFAULT '{}',
        structure_json TEXT NOT NULL DEFAULT '{}',
        created_at REAL NOT NULL,
        UNIQUE(object_hash, ordinal, block_kind)
      );
      CREATE INDEX IF NOT EXISTS document_blocks_source
        ON document_blocks(source_id, object_hash, ordinal);
      CREATE TABLE IF NOT EXISTS search_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        normalized_hash TEXT NOT NULL,
        text TEXT NOT NULL,
        block_ids_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at REAL NOT NULL,
        UNIQUE(source_id, normalized_hash)
      );
      CREATE TABLE IF NOT EXISTS search_chunk_blocks (
        chunk_id INTEGER NOT NULL REFERENCES search_chunks(id) ON DELETE CASCADE,
        block_id INTEGER NOT NULL REFERENCES document_blocks(id) ON DELETE CASCADE,
        PRIMARY KEY(chunk_id, block_id)
      );
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id INTEGER PRIMARY KEY REFERENCES search_chunks(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        normalized_hash TEXT NOT NULL,
        created_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS semantic_embeddings (
        evidence_type TEXT NOT NULL CHECK(evidence_type IN ('document_block','knowledge')),
        evidence_ref TEXT NOT NULL,
        source_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        normalized_hash TEXT NOT NULL,
        indexer_version INTEGER NOT NULL,
        created_at REAL NOT NULL,
        PRIMARY KEY(evidence_type, evidence_ref)
      );
      CREATE TABLE IF NOT EXISTS team_knowledge_evidence_refs (
        knowledge_id INTEGER NOT NULL,
        evidence_type TEXT NOT NULL CHECK(evidence_type IN ('event','document_block','object_region')),
        evidence_ref TEXT NOT NULL,
        locator_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(knowledge_id, evidence_type, evidence_ref)
      );
      CREATE TABLE IF NOT EXISTS knowledge_transfers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('export','import')),
        mode TEXT NOT NULL CHECK(mode IN ('manifest','portable')),
        state TEXT NOT NULL CHECK(state IN
          ('queued','running','awaiting_confirmation','succeeded','failed')),
        source_id TEXT,
        bundle_key TEXT NOT NULL DEFAULT '',
        request_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        completed_at REAL
      );
      CREATE INDEX IF NOT EXISTS knowledge_transfers_state
        ON knowledge_transfers(state, created_at, id);
      CREATE TABLE IF NOT EXISTS imported_knowledge_sources (
        source_id TEXT PRIMARY KEY,
        telegram_chat_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        imported_at REAL NOT NULL
      );
    `);
    const objectRefColumns = this.db.prepare("PRAGMA table_info(content_object_refs)").all() as Row[];
    if (!objectRefColumns.some((column) => column.name === "telegram_user_id")) {
      this.db.exec("ALTER TABLE content_object_refs ADD COLUMN telegram_user_id INTEGER");
    }
    if (!objectRefColumns.some((column) => column.name === "metadata_json")) {
      this.db.exec("ALTER TABLE content_object_refs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
    const stageColumns = this.db.prepare("PRAGMA table_info(team_sync_stages)").all() as Row[];
    if (!stageColumns.some((column) => column.name === "next_retry_at")) {
      this.db.exec("ALTER TABLE team_sync_stages ADD COLUMN next_retry_at REAL");
    }
    const runColumns = this.db.prepare("PRAGMA table_info(team_sync_runs)").all() as Row[];
    if (!runColumns.some((column) => column.name === "last_live_event_at")) {
      this.db.exec("ALTER TABLE team_sync_runs ADD COLUMN last_live_event_at REAL");
    }
    const unknownAuthorColumns = this.db.prepare(
      "PRAGMA table_info(team_sync_unknown_authors)",
    ).all() as Row[];
    if (!unknownAuthorColumns.some((column) => column.name === "recovered_count")) {
      this.db.exec(`
        ALTER TABLE team_sync_unknown_authors
        ADD COLUMN recovered_count INTEGER NOT NULL DEFAULT 0
      `);
    }
    this.db.exec(`
      UPDATE team_ingestion_jobs SET state = 'pending' WHERE state = 'running';
      UPDATE team_sync_outbox SET state = 'pending' WHERE state = 'sending';
      UPDATE team_sync_history_recovery SET state = 'queued',
        last_error = 'resuming after process restart', updated_at = unixepoch('subsec')
      WHERE state = 'running';
      UPDATE knowledge_transfers
      SET state = 'queued', last_error = 'resuming after process restart',
          completed_at = NULL, updated_at = unixepoch('subsec')
      WHERE state = 'running';
    `);
  }

  createKnowledgeTransfer(input: {
    id: string;
    kind: KnowledgeTransferKind;
    mode: KnowledgeTransferMode;
    sourceId?: string | null;
    bundleKey?: string;
    request?: Record<string, unknown>;
    now?: number;
  }): KnowledgeTransferRecord {
    const now = input.now ?? Date.now() / 1_000;
    this.db.prepare(`
      INSERT INTO knowledge_transfers
        (id, kind, mode, state, source_id, bundle_key, request_json, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.kind,
      input.mode,
      input.sourceId ?? null,
      input.bundleKey ?? "",
      JSON.stringify(input.request ?? {}),
      now,
      now,
    );
    return this.knowledgeTransfer(input.id)!;
  }

  knowledgeTransfer(id: string): KnowledgeTransferRecord | null {
    const row = this.db.prepare("SELECT * FROM knowledge_transfers WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? this.toKnowledgeTransfer(row) : null;
  }

  listKnowledgeTransfers(limit = 50): KnowledgeTransferRecord[] {
    return (this.db.prepare(`
      SELECT * FROM knowledge_transfers ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, limit))) as Row[])
      .map((row) => this.toKnowledgeTransfer(row));
  }

  claimKnowledgeTransfer(): KnowledgeTransferRecord | null {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT id FROM knowledge_transfers WHERE state = 'queued'
        ORDER BY created_at, id LIMIT 1
      `).get() as Row | undefined;
      if (!row) return null;
      const now = Date.now() / 1_000;
      const updated = this.db.prepare(`
        UPDATE knowledge_transfers SET state = 'running', attempts = attempts + 1,
          last_error = '', updated_at = ? WHERE id = ? AND state = 'queued'
      `).run(now, String(row.id));
      return Number(updated.changes) > 0 ? this.knowledgeTransfer(String(row.id)) : null;
    });
  }

  awaitKnowledgeImportConfirmation(
    id: string,
    result: Record<string, unknown>,
    bundleKey: string,
  ): void {
    const mode = result.mode === "manifest" ? "manifest" : "portable";
    const sourceId = typeof result.sourceId === "string" && result.sourceId ? result.sourceId : null;
    this.db.prepare(`
      UPDATE knowledge_transfers SET state = 'awaiting_confirmation', result_json = ?,
        bundle_key = ?, mode = ?, source_id = ?, updated_at = ?
      WHERE id = ? AND state = 'running' AND kind = 'import'
    `).run(JSON.stringify(result), bundleKey, mode, sourceId, Date.now() / 1_000, id);
  }

  confirmKnowledgeImport(id: string, acceptConsents: boolean): KnowledgeTransferRecord {
    return this.transaction(() => {
      const current = this.knowledgeTransfer(id);
      if (!current || current.kind !== "import" || current.state !== "awaiting_confirmation") {
        throw new Error("knowledge import is not awaiting confirmation");
      }
      if (Number(current.result.grantedConsents ?? 0) > 0 && !acceptConsents) {
        throw new Error("imported consent records require explicit acceptance");
      }
      this.db.prepare(`
        UPDATE knowledge_transfers SET state = 'queued', request_json = ?, updated_at = ?
        WHERE id = ? AND state = 'awaiting_confirmation'
      `).run(
        JSON.stringify({ ...current.request, confirmed: true, acceptConsents }),
        Date.now() / 1_000,
        id,
      );
      return this.knowledgeTransfer(id)!;
    });
  }

  finishKnowledgeTransfer(
    id: string,
    result: Record<string, unknown>,
    bundleKey = "",
  ): void {
    const now = Date.now() / 1_000;
    this.db.prepare(`
      UPDATE knowledge_transfers SET state = 'succeeded', result_json = ?,
        bundle_key = CASE WHEN ? <> '' THEN ? ELSE bundle_key END,
        last_error = '', updated_at = ?, completed_at = ?
      WHERE id = ? AND state = 'running'
    `).run(JSON.stringify(result), bundleKey, bundleKey, now, now, id);
  }

  failKnowledgeTransfer(id: string, error: string): void {
    const now = Date.now() / 1_000;
    this.db.prepare(`
      UPDATE knowledge_transfers SET state = 'failed', last_error = ?,
        updated_at = ?, completed_at = ? WHERE id = ? AND state = 'running'
    `).run(error.slice(0, 2_000), now, now, id);
  }

  recordImportedKnowledgeSource(input: {
    sourceId: string;
    telegramChatId: number;
    title: string;
    checkpoint: Record<string, unknown>;
    importedAt?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO imported_knowledge_sources
        (source_id, telegram_chat_id, title, checkpoint_json, imported_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET telegram_chat_id = excluded.telegram_chat_id,
        title = excluded.title, checkpoint_json = excluded.checkpoint_json,
        imported_at = excluded.imported_at
    `).run(
      input.sourceId,
      input.telegramChatId,
      input.title,
      JSON.stringify(input.checkpoint),
      input.importedAt ?? Date.now() / 1_000,
    );
  }

  listImportedKnowledgeSources(): ImportedKnowledgeSource[] {
    return (this.db.prepare(`
      SELECT * FROM imported_knowledge_sources ORDER BY imported_at DESC, source_id
    `).all() as Row[]).map((row) => ({
      sourceId: String(row.source_id),
      telegramChatId: Number(row.telegram_chat_id),
      title: String(row.title),
      checkpoint: parseRecord(row.checkpoint_json),
      importedAt: Number(row.imported_at),
    }));
  }

  analyzeKnowledgeCatalog(catalogPath: string): {
    consentOverrides: number;
    objectConflicts: number;
    existingObjects: number;
  } {
    this.db.prepare("ATTACH DATABASE ? AS kb_import").run(catalogPath);
    try {
      const consentOverrides = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM kb_import.kb_team_consents incoming
        JOIN team_consents current
          ON current.source_id = incoming.source_id
         AND current.telegram_user_id = incoming.telegram_user_id
        WHERE current.status = 'revoked' AND incoming.status = 'granted'
      `).get() as Row;
      const objectConflicts = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM kb_import.kb_content_objects incoming
        JOIN content_objects current ON current.sha256 = incoming.sha256
        WHERE current.size_bytes <> incoming.size_bytes
      `).get() as Row;
      const existingObjects = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM kb_import.kb_content_objects incoming
        JOIN content_objects current ON current.sha256 = incoming.sha256
      `).get() as Row;
      return {
        consentOverrides: Number(consentOverrides.count),
        objectConflicts: Number(objectConflicts.count),
        existingObjects: Number(existingObjects.count),
      };
    } finally {
      this.db.exec("DETACH DATABASE kb_import");
    }
  }

  importKnowledgeCatalog(
    catalogPath: string,
    input: {
      acceptConsents: boolean;
      objectStoreBackend: "local" | "s3";
      objectPrefix: string;
      embeddingModel: string;
      embeddingDimensions: number;
    },
  ): {
    consents: number;
    unknownAuthors: number;
    objects: number;
    blocks: number;
    chunks: number;
  } {
    this.db.prepare("ATTACH DATABASE ? AS kb_import").run(catalogPath);
    try {
      return this.transaction(() => {
        const consents = this.db.prepare(`
          SELECT * FROM kb_import.kb_team_consents ORDER BY telegram_user_id
        `).all() as Row[];
        for (const consent of consents) {
          const current = this.db.prepare(`
            SELECT status FROM team_consents WHERE source_id = ? AND telegram_user_id = ?
          `).get(String(consent.source_id), Number(consent.telegram_user_id)) as Row | undefined;
          if (current?.status === "revoked" && consent.status === "granted") continue;
          if (consent.status === "granted" && !input.acceptConsents) {
            throw new Error("imported consent records require explicit acceptance");
          }
          this.db.prepare(`
            INSERT INTO team_consents
              (source_id, telegram_user_id, status, scope_json, granted_at,
               historical_from, proof, revoked_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, telegram_user_id) DO UPDATE SET
              status = excluded.status, scope_json = excluded.scope_json,
              granted_at = excluded.granted_at, historical_from = excluded.historical_from,
              proof = excluded.proof, revoked_at = excluded.revoked_at,
              updated_at = MAX(team_consents.updated_at, excluded.updated_at)
          `).run(
            sqlValue(consent.source_id), sqlValue(consent.telegram_user_id),
            sqlValue(consent.status), sqlValue(consent.scope_json), sqlValue(consent.granted_at),
            sqlValue(consent.historical_from), sqlValue(consent.proof),
            sqlValue(consent.revoked_at), sqlValue(consent.updated_at),
          );
        }

        const unknownAuthors = this.db.prepare(`
          SELECT * FROM kb_import.kb_team_sync_unknown_authors
          ORDER BY source_id, telegram_user_id
        `).all() as Row[];
        for (const author of unknownAuthors) {
          this.db.prepare(`
            INSERT INTO team_sync_unknown_authors
              (source_id, telegram_user_id, first_seen_at, last_seen_at,
               message_count, recovered_count)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id, telegram_user_id) DO UPDATE SET
              first_seen_at = MIN(team_sync_unknown_authors.first_seen_at, excluded.first_seen_at),
              last_seen_at = MAX(team_sync_unknown_authors.last_seen_at, excluded.last_seen_at),
              message_count = MAX(team_sync_unknown_authors.message_count, excluded.message_count),
              recovered_count = MAX(
                team_sync_unknown_authors.recovered_count,
                excluded.recovered_count
              )
          `).run(
            sqlValue(author.source_id), sqlValue(author.telegram_user_id),
            sqlValue(author.first_seen_at), sqlValue(author.last_seen_at),
            sqlValue(author.message_count), Number(author.recovered_count ?? 0),
          );
        }

        const prefix = input.objectPrefix.replace(/^\/+|\/+$/g, "");
        const objects = this.db.prepare(`
          SELECT * FROM kb_import.kb_content_objects ORDER BY sha256
        `).all() as Row[];
        for (const object of objects) {
          const sha256 = String(object.sha256);
          const objectKey = [prefix, "sha256", sha256.slice(0, 2), sha256]
            .filter(Boolean).join("/");
          this.db.prepare(`
            INSERT OR IGNORE INTO content_objects
              (sha256, object_key, size_bytes, mime_type, file_name, backend, stored_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            sha256, objectKey, sqlValue(object.size_bytes), sqlValue(object.mime_type),
            sqlValue(object.file_name), input.objectStoreBackend, sqlValue(object.stored_at),
          );
        }
        this.db.exec(`
          INSERT OR IGNORE INTO content_object_refs
            (sha256, source_id, telegram_user_id, ref_type, ref_id, metadata_json, created_at)
          SELECT sha256, source_id, telegram_user_id, ref_type, ref_id, metadata_json, created_at
          FROM kb_import.kb_content_object_refs;
        `);

        const blocks = this.db.prepare(`
          SELECT * FROM kb_import.kb_document_blocks ORDER BY export_block_id
        `).all() as Row[];
        const insertBlock = this.db.prepare(`
          INSERT OR IGNORE INTO document_blocks
            (object_hash, source_id, block_kind, ordinal, text, locator_json,
             structure_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const findBlock = this.db.prepare(`
          SELECT id FROM document_blocks
          WHERE object_hash = ? AND ordinal = ? AND block_kind = ?
        `);
        const updateBlock = this.db.prepare(`
          UPDATE kb_import.kb_document_blocks SET target_block_id = ?
          WHERE export_block_id = ?
        `);
        for (const block of blocks) {
          insertBlock.run(
            sqlValue(block.object_hash), sqlValue(block.source_id), sqlValue(block.block_kind),
            sqlValue(block.ordinal), sqlValue(block.text), sqlValue(block.locator_json),
            sqlValue(block.structure_json), sqlValue(block.created_at),
          );
          const target = findBlock.get(
            sqlValue(block.object_hash), sqlValue(block.ordinal), sqlValue(block.block_kind),
          ) as Row;
          updateBlock.run(sqlValue(target.id), sqlValue(block.export_block_id));
        }

        const chunks = this.db.prepare(`
          SELECT * FROM kb_import.kb_search_chunks ORDER BY export_chunk_id
        `).all() as Row[];
        const insertChunk = this.db.prepare(`
          INSERT OR IGNORE INTO search_chunks
            (source_id, normalized_hash, text, block_ids_json, metadata_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const findChunk = this.db.prepare(`
          SELECT id FROM search_chunks WHERE source_id = ? AND normalized_hash = ?
        `);
        const updateChunk = this.db.prepare(`
          UPDATE kb_import.kb_search_chunks SET target_chunk_id = ?
          WHERE export_chunk_id = ?
        `);
        for (const chunk of chunks) {
          const mappedBlocks = (this.db.prepare(`
            SELECT blocks.target_block_id AS id
            FROM kb_import.kb_search_chunk_blocks links
            JOIN kb_import.kb_document_blocks blocks
              ON blocks.export_block_id = links.block_id
            WHERE links.chunk_id = ? AND blocks.target_block_id IS NOT NULL
            ORDER BY links.rowid
          `).all(sqlValue(chunk.export_chunk_id)) as Row[]).map((row) => Number(row.id));
          let metadata = parseRecord(chunk.metadata_json);
          metadata = { ...metadata, blockIds: mappedBlocks };
          insertChunk.run(
            sqlValue(chunk.source_id), sqlValue(chunk.normalized_hash), sqlValue(chunk.text),
            JSON.stringify(mappedBlocks), JSON.stringify(metadata), sqlValue(chunk.created_at),
          );
          const target = findChunk.get(
            sqlValue(chunk.source_id), sqlValue(chunk.normalized_hash),
          ) as Row;
          updateChunk.run(sqlValue(target.id), sqlValue(chunk.export_chunk_id));
        }
        this.db.exec(`
          INSERT OR IGNORE INTO search_chunk_blocks (chunk_id, block_id)
          SELECT chunks.target_chunk_id, blocks.target_block_id
          FROM kb_import.kb_search_chunk_blocks links
          JOIN kb_import.kb_search_chunks chunks ON chunks.export_chunk_id = links.chunk_id
          JOIN kb_import.kb_document_blocks blocks ON blocks.export_block_id = links.block_id
          WHERE chunks.target_chunk_id IS NOT NULL AND blocks.target_block_id IS NOT NULL;
        `);

        const eventMap = new Map((this.db.prepare(`
          SELECT export_event_id, target_event_id FROM kb_import.kb_team_events
          WHERE target_event_id IS NOT NULL
        `).all() as Row[]).map((row) => [Number(row.export_event_id), Number(row.target_event_id)]));
        const knowledgeMap = new Map((this.db.prepare(`
          SELECT export_knowledge_id, target_knowledge_id FROM kb_import.kb_team_knowledge
          WHERE target_knowledge_id IS NOT NULL
        `).all() as Row[]).map((row) => [Number(row.export_knowledge_id), Number(row.target_knowledge_id)]));
        const blockMap = new Map((this.db.prepare(`
          SELECT export_block_id, target_block_id FROM kb_import.kb_document_blocks
          WHERE target_block_id IS NOT NULL
        `).all() as Row[]).map((row) => [Number(row.export_block_id), Number(row.target_block_id)]));
        const chunkMap = new Map((this.db.prepare(`
          SELECT export_chunk_id, target_chunk_id FROM kb_import.kb_search_chunks
          WHERE target_chunk_id IS NOT NULL
        `).all() as Row[]).map((row) => [Number(row.export_chunk_id), Number(row.target_chunk_id)]));

        const revisions = this.db.prepare(`SELECT * FROM kb_import.kb_team_event_revisions`)
          .all() as Row[];
        for (const revision of revisions) {
          const mapped = revision.team_event_id === null
            ? null : eventMap.get(Number(revision.team_event_id)) ?? null;
          this.db.prepare(`
            INSERT OR IGNORE INTO team_event_revisions
              (source_id, telegram_message_id, revision, event_kind, team_event_id, occurred_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            sqlValue(revision.source_id), sqlValue(revision.telegram_message_id),
            sqlValue(revision.revision), sqlValue(revision.event_kind), mapped,
            sqlValue(revision.occurred_at),
          );
        }

        const chunkEmbeddings = this.db.prepare(`
          SELECT * FROM kb_import.kb_chunk_embeddings
          WHERE model = ? AND dimensions = ?
        `).all(input.embeddingModel, input.embeddingDimensions) as Row[];
        for (const embedding of chunkEmbeddings) {
          const chunkId = chunkMap.get(Number(embedding.chunk_id));
          if (!chunkId) continue;
          this.db.prepare(`
            INSERT OR REPLACE INTO chunk_embeddings
              (chunk_id, model, dimensions, vector, normalized_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            chunkId, sqlValue(embedding.model), sqlValue(embedding.dimensions),
            sqlValue(embedding.vector), sqlValue(embedding.normalized_hash),
            sqlValue(embedding.created_at),
          );
        }

        const semantic = this.db.prepare(`
          SELECT * FROM kb_import.kb_semantic_embeddings
          WHERE model = ? AND dimensions = ?
        `).all(input.embeddingModel, input.embeddingDimensions) as Row[];
        for (const embedding of semantic) {
          let evidenceRef = String(embedding.evidence_ref);
          const documentMatch = evidenceRef.match(/^chunk:(\d+)$/);
          const knowledgeMatch = evidenceRef.match(/^knowledge:(\d+)$/);
          if (documentMatch) {
            const mapped = chunkMap.get(Number(documentMatch[1]));
            if (!mapped) continue;
            evidenceRef = `chunk:${mapped}`;
          } else if (knowledgeMatch) {
            const mapped = knowledgeMap.get(Number(knowledgeMatch[1]));
            if (!mapped) continue;
            evidenceRef = `knowledge:${mapped}`;
          }
          this.db.prepare(`
            INSERT OR REPLACE INTO semantic_embeddings
              (evidence_type, evidence_ref, source_id, model, dimensions, vector,
               normalized_hash, indexer_version, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            sqlValue(embedding.evidence_type), evidenceRef, sqlValue(embedding.source_id),
            sqlValue(embedding.model), sqlValue(embedding.dimensions), sqlValue(embedding.vector),
            sqlValue(embedding.normalized_hash), sqlValue(embedding.indexer_version),
            sqlValue(embedding.created_at),
          );
        }

        const evidenceRows = this.db.prepare(`
          SELECT * FROM kb_import.kb_team_knowledge_evidence_refs
        `).all() as Row[];
        for (const evidence of evidenceRows) {
          const knowledgeId = knowledgeMap.get(Number(evidence.knowledge_id));
          if (!knowledgeId) continue;
          let ref = String(evidence.evidence_ref);
          if (evidence.evidence_type === "event") {
            const mapped = eventMap.get(Number(ref));
            if (!mapped) continue;
            ref = String(mapped);
          } else if (evidence.evidence_type === "document_block") {
            const match = ref.match(/^(?:block:)?(\d+)$/);
            const mapped = match ? blockMap.get(Number(match[1])) : undefined;
            if (!mapped) continue;
            ref = `block:${mapped}`;
          }
          this.db.prepare(`
            INSERT OR IGNORE INTO team_knowledge_evidence_refs
              (knowledge_id, evidence_type, evidence_ref, locator_json)
            VALUES (?, ?, ?, ?)
          `).run(
            knowledgeId, sqlValue(evidence.evidence_type), ref, sqlValue(evidence.locator_json),
          );
        }
        return {
          consents: consents.length,
          unknownAuthors: unknownAuthors.length,
          objects: objects.length,
          blocks: blocks.length,
          chunks: chunks.length,
        };
      });
    } finally {
      this.db.exec("DETACH DATABASE kb_import");
    }
  }

  private toKnowledgeTransfer(row: Row): KnowledgeTransferRecord {
    return {
      id: String(row.id),
      kind: String(row.kind) as KnowledgeTransferKind,
      mode: String(row.mode) as KnowledgeTransferMode,
      state: String(row.state) as KnowledgeTransferState,
      sourceId: row.source_id === null ? null : String(row.source_id),
      bundleKey: String(row.bundle_key),
      request: parseRecord(row.request_json),
      result: parseRecord(row.result_json),
      attempts: Number(row.attempts),
      lastError: String(row.last_error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    };
  }

  createConnector(input: {
    id: string;
    apiId: number;
    encryptedApiHash: string;
    phoneMask: string;
    databaseDirectory: string;
    now?: number;
  }): MtprotoConnectorRecord {
    const now = input.now ?? Date.now() / 1_000;
    this.db.prepare(`
      INSERT INTO mtproto_connectors
        (id, state, api_id, encrypted_api_hash, phone_mask, database_directory, created_at, updated_at)
      VALUES (?, 'authorizing', ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.apiId,
      input.encryptedApiHash,
      input.phoneMask,
      input.databaseDirectory,
      now,
      now,
    );
    return this.connector(input.id)!;
  }

  connector(id: string): MtprotoConnectorRecord | null {
    const row = this.db.prepare("SELECT * FROM mtproto_connectors WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toConnector(row) : null;
  }

  listConnectors(): MtprotoConnectorRecord[] {
    return (this.db.prepare("SELECT * FROM mtproto_connectors ORDER BY created_at, id").all() as Row[])
      .map((row) => this.toConnector(row));
  }

  updateConnector(
    id: string,
    state: ConnectorState,
    options: { error?: string; lastUpdateAt?: number | null } = {},
  ): void {
    const now = Date.now() / 1_000;
    this.db.prepare(`
      UPDATE mtproto_connectors SET state = ?, last_error = ?,
        last_update_at = COALESCE(?, last_update_at), updated_at = ? WHERE id = ?
    `).run(state, options.error ?? "", options.lastUpdateAt ?? null, now, id);
  }

  deleteRevokedConnector(id: string): void {
    const mappings = Number((this.db.prepare(
      "SELECT COUNT(*) AS count FROM team_source_connectors WHERE connector_id = ?",
    ).get(id) as Row).count ?? 0);
    if (mappings > 0) throw new Error("connector still has bound Telegram groups");
    this.db.prepare(`
      UPDATE mtproto_connectors SET state = 'revoked', api_id = 0,
        encrypted_api_hash = '', phone_mask = '***', database_directory = '',
        last_error = '', updated_at = ? WHERE id = ?
    `).run(Date.now() / 1_000, id);
  }

  bindSource(input: {
    sourceId: string;
    connectorId: string;
    telegramChatId: number;
    title: string;
    now?: number;
  }): SourceConnectorBinding {
    const now = input.now ?? Date.now() / 1_000;
    this.db.prepare(`
      INSERT INTO team_source_connectors
        (source_id, connector_id, telegram_chat_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET connector_id = excluded.connector_id,
        telegram_chat_id = excluded.telegram_chat_id, title = excluded.title,
        updated_at = excluded.updated_at
    `).run(input.sourceId, input.connectorId, input.telegramChatId, input.title, now, now);
    return this.binding(input.sourceId)!;
  }

  unbindSource(sourceId: string): void {
    this.db.prepare("DELETE FROM team_source_connectors WHERE source_id = ?").run(sourceId);
  }

  binding(sourceId: string): SourceConnectorBinding | null {
    const row = this.db.prepare("SELECT * FROM team_source_connectors WHERE source_id = ?")
      .get(sourceId) as Row | undefined;
    return row ? this.toBinding(row) : null;
  }

  bindingForChat(connectorId: string, chatId: number): SourceConnectorBinding | null {
    const row = this.db.prepare(`
      SELECT * FROM team_source_connectors WHERE connector_id = ? AND telegram_chat_id = ?
    `).get(connectorId, chatId) as Row | undefined;
    return row ? this.toBinding(row) : null;
  }

  listBindings(connectorId?: string): SourceConnectorBinding[] {
    const rows = connectorId
      ? this.db.prepare("SELECT * FROM team_source_connectors WHERE connector_id = ? ORDER BY title")
          .all(connectorId) as Row[]
      : this.db.prepare("SELECT * FROM team_source_connectors ORDER BY title").all() as Row[];
    return rows.map((row) => this.toBinding(row));
  }

  grantConsent(input: {
    sourceId: string;
    telegramUserId: number;
    scope?: string[];
    grantedAt?: number;
    historicalFrom?: number | null;
    proof: string;
  }): TeamConsentRecord {
    const now = Date.now() / 1_000;
    const grantedAt = input.grantedAt ?? now;
    const scope = input.scope ?? ["history", "future", "model_egress"];
    this.db.prepare(`
      INSERT INTO team_consents
        (source_id, telegram_user_id, status, scope_json, granted_at, historical_from,
         proof, revoked_at, updated_at)
      VALUES (?, ?, 'granted', ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(source_id, telegram_user_id) DO UPDATE SET status = 'granted',
        scope_json = excluded.scope_json, granted_at = excluded.granted_at,
        historical_from = excluded.historical_from, proof = excluded.proof,
        revoked_at = NULL, updated_at = excluded.updated_at
    `).run(
      input.sourceId,
      input.telegramUserId,
      JSON.stringify(scope),
      grantedAt,
      input.historicalFrom ?? null,
      input.proof.trim(),
      now,
    );
    return this.consent(input.sourceId, input.telegramUserId)!;
  }

  revokeConsent(sourceId: string, telegramUserId: number, now = Date.now() / 1_000): void {
    this.db.prepare(`
      INSERT INTO team_consents
        (source_id, telegram_user_id, status, scope_json, granted_at, historical_from,
         proof, revoked_at, updated_at)
      VALUES (?, ?, 'revoked', '[]', ?, NULL, '', ?, ?)
      ON CONFLICT(source_id, telegram_user_id) DO UPDATE SET status = 'revoked',
        revoked_at = excluded.revoked_at, updated_at = excluded.updated_at
    `).run(sourceId, telegramUserId, now, now, now);
  }

  consent(sourceId: string, telegramUserId: number): TeamConsentRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM team_consents WHERE source_id = ? AND telegram_user_id = ?
    `).get(sourceId, telegramUserId) as Row | undefined;
    return row ? this.toConsent(row) : null;
  }

  groupConsent(sourceId: string): TeamConsentRecord | null {
    return this.consent(sourceId, GROUP_CONSENT_TELEGRAM_USER_ID);
  }

  private consentAllows(
    item: TeamConsentRecord | null,
    scopes: string[],
    occurredAt?: number,
  ): boolean {
    return Boolean(
      item &&
      item.status === "granted" &&
      scopes.every((scope) => item.scope.includes(scope)) &&
      (item.historicalFrom === null || occurredAt === undefined || occurredAt >= item.historicalFrom),
    );
  }

  groupConsentGranted(sourceId: string, occurredAt?: number): boolean {
    return this.consentAllows(
      this.groupConsent(sourceId),
      ["history", "future", "model_egress"],
      occurredAt,
    );
  }

  consentGranted(sourceId: string, telegramUserId: number, occurredAt?: number): boolean {
    const individual = this.consent(sourceId, telegramUserId);
    if (individual?.status === "revoked") return false;
    const scopes = ["history", "future", "model_egress"];
    return this.consentAllows(individual, scopes, occurredAt) ||
      this.consentAllows(this.groupConsent(sourceId), scopes, occurredAt);
  }

  consentScopeGranted(
    sourceId: string,
    telegramUserId: number,
    scope: "history" | "future" | "model_egress",
    occurredAt?: number,
  ): boolean {
    const individual = this.consent(sourceId, telegramUserId);
    if (individual?.status === "revoked") return false;
    return this.consentAllows(individual, [scope], occurredAt) ||
      this.consentAllows(this.groupConsent(sourceId), [scope], occurredAt);
  }

  listConsents(sourceId: string): TeamConsentRecord[] {
    return (this.db.prepare(
      "SELECT * FROM team_consents WHERE source_id = ? ORDER BY telegram_user_id",
    ).all(sourceId) as Row[]).map((row) => this.toConsent(row));
  }

  consentSummary(): { granted: number; revoked: number; sources: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'granted' THEN 1 ELSE 0 END) AS granted,
        SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked,
        COUNT(DISTINCT CASE WHEN status = 'granted' THEN source_id END) AS sources
      FROM team_consents
    `).get() as Row;
    return {
      granted: Number(row.granted ?? 0),
      revoked: Number(row.revoked ?? 0),
      sources: Number(row.sources ?? 0),
    };
  }

  recordUnknownAuthor(sourceId: string, telegramUserId: number, occurredAt: number): boolean {
    const existing = this.db.prepare(`
      SELECT 1 AS found FROM team_sync_unknown_authors
      WHERE source_id = ? AND telegram_user_id = ? AND message_count > recovered_count
    `).get(sourceId, telegramUserId);
    const result = this.db.prepare(`
      INSERT INTO team_sync_unknown_authors
        (source_id, telegram_user_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id, telegram_user_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at, message_count = message_count + 1
    `).run(sourceId, telegramUserId, occurredAt, occurredAt);
    return !existing && Number(result.changes) > 0;
  }

  requestHistoryRecovery(sourceId: string, now = Date.now() / 1_000): HistoryRecoveryStatus {
    const existing = this.historyRecovery(sourceId);
    if (existing?.state === "queued" || existing?.state === "running") return existing;
    this.db.prepare(`
      INSERT INTO team_sync_history_recovery
        (source_id, state, from_message_id, recovered_count, requested_at, updated_at)
      VALUES (?, 'queued', 0, 0, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET state = 'queued', from_message_id = 0,
        recovered_count = 0, last_error = '', requested_at = excluded.requested_at,
        updated_at = excluded.updated_at, completed_at = NULL
    `).run(sourceId, now, now);
    return this.historyRecovery(sourceId)!;
  }

  historyRecovery(sourceId: string): HistoryRecoveryStatus | null {
    const row = this.db.prepare(`
      SELECT * FROM team_sync_history_recovery WHERE source_id = ?
    `).get(sourceId) as Row | undefined;
    return row ? {
      sourceId: String(row.source_id),
      state: String(row.state) as HistoryRecoveryState,
      fromMessageId: Number(row.from_message_id),
      recoveredMessages: Number(row.recovered_count),
      lastError: String(row.last_error),
      requestedAt: Number(row.requested_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    } : null;
  }

  pendingHistoryRecoveries(): HistoryRecoveryStatus[] {
    return (this.db.prepare(`
      SELECT source_id FROM team_sync_history_recovery
      WHERE state IN ('queued','running') ORDER BY requested_at, source_id
    `).all() as Row[]).flatMap((row) => {
      const recovery = this.historyRecovery(String(row.source_id));
      return recovery ? [recovery] : [];
    });
  }

  startHistoryRecovery(sourceId: string, now = Date.now() / 1_000): void {
    this.db.prepare(`
      UPDATE team_sync_history_recovery SET state = 'running', last_error = '', updated_at = ?
      WHERE source_id = ?
    `).run(now, sourceId);
  }

  deferHistoryRecovery(sourceId: string, now = Date.now() / 1_000): void {
    this.db.prepare(`
      UPDATE team_sync_history_recovery SET state = 'queued', updated_at = ?
      WHERE source_id = ? AND state = 'running'
    `).run(now, sourceId);
  }

  updateHistoryRecoveryCheckpoint(
    sourceId: string,
    fromMessageId: number,
    now = Date.now() / 1_000,
  ): void {
    this.db.prepare(`
      UPDATE team_sync_history_recovery SET from_message_id = ?, updated_at = ?
      WHERE source_id = ?
    `).run(fromMessageId, now, sourceId);
  }

  finishHistoryRecovery(sourceId: string, now = Date.now() / 1_000): void {
    this.db.prepare(`
      UPDATE team_sync_history_recovery SET state = 'succeeded', last_error = '',
        completed_at = ?, updated_at = ? WHERE source_id = ?
    `).run(now, now, sourceId);
  }

  failHistoryRecovery(sourceId: string, error: string, now = Date.now() / 1_000): void {
    this.db.prepare(`
      UPDATE team_sync_history_recovery SET state = 'failed', last_error = ?, updated_at = ?
      WHERE source_id = ?
    `).run(error.slice(0, 1_000), now, sourceId);
  }

  recordRecoveredMessage(
    sourceId: string,
    telegramUserId: number | null,
    now = Date.now() / 1_000,
  ): void {
    this.transaction(() => {
      const run = this.latestRun(sourceId);
      if (!run) throw new Error(`sync run is missing for ${sourceId}`);
      const author = telegramUserId === null ? undefined : this.db.prepare(`
        SELECT message_count, recovered_count FROM team_sync_unknown_authors
        WHERE source_id = ? AND telegram_user_id = ?
      `).get(sourceId, telegramUserId) as Row | undefined;
      const authorWasSkipped = Boolean(
        author && Number(author.recovered_count) < Number(author.message_count),
      );
      const unresolved = this.db.prepare(`
        SELECT COALESCE(SUM(message_count - recovered_count), 0) AS count
        FROM team_sync_unknown_authors
        WHERE source_id = ? AND message_count > recovered_count
      `).get(sourceId) as Row;
      const unattributed = Math.max(
        0,
        Number(run.skipped_count ?? 0) - Number(unresolved.count ?? 0),
      );
      const wasSkipped = authorWasSkipped || unattributed > 0;
      this.db.prepare(`
        UPDATE team_sync_runs SET accepted_count = accepted_count + 1,
          discovered_count = discovered_count + ?,
          skipped_count = MAX(0, skipped_count - ?), updated_at = ? WHERE id = ?
      `).run(wasSkipped ? 0 : 1, wasSkipped ? 1 : 0, now, Number(run.id));
      if (telegramUserId !== null) {
        if (author && Number(author.recovered_count) < Number(author.message_count)) {
          const remaining = Number(author.message_count) - Number(author.recovered_count);
          this.db.prepare(`
            UPDATE team_sync_unknown_authors SET recovered_count = recovered_count + 1
            WHERE source_id = ? AND telegram_user_id = ?
          `).run(sourceId, telegramUserId);
          if (remaining === 1) {
            this.db.prepare(`
              UPDATE team_sync_runs SET unknown_authors = MAX(0, unknown_authors - 1)
              WHERE id = ?
            `).run(Number(run.id));
          }
        }
      }
      this.db.prepare(`
        UPDATE team_sync_history_recovery SET recovered_count = recovered_count + 1,
          updated_at = ? WHERE source_id = ?
      `).run(now, sourceId);
    });
  }

  recordRevision(input: {
    sourceId: string;
    telegramMessageId: number;
    revision: number;
    eventKind: "message" | "edit" | "deletion";
    teamEventId: number | null;
    occurredAt: number;
  }): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO team_event_revisions
        (source_id, telegram_message_id, revision, event_kind, team_event_id, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.sourceId,
      input.telegramMessageId,
      input.revision,
      input.eventKind,
      input.teamEventId,
      input.occurredAt,
    );
    return Number(result.changes) > 0;
  }

  revisionEventIds(sourceId: string, telegramMessageId: number): number[] {
    return (this.db.prepare(`
      SELECT DISTINCT team_event_id FROM team_event_revisions
      WHERE source_id = ? AND telegram_message_id = ? AND team_event_id IS NOT NULL
      ORDER BY occurred_at, revision
    `).all(sourceId, telegramMessageId) as Row[]).map((row) => Number(row.team_event_id));
  }

  eventRevisionIsSearchable(sourceId: string, teamEventId: number): boolean {
    const own = this.db.prepare(`
      SELECT telegram_message_id FROM team_event_revisions
      WHERE source_id = ? AND team_event_id = ? LIMIT 1
    `).get(sourceId, teamEventId) as Row | undefined;
    if (!own) return true;
    const latest = this.db.prepare(`
      SELECT event_kind, team_event_id FROM team_event_revisions
      WHERE source_id = ? AND telegram_message_id = ?
      ORDER BY occurred_at DESC, revision DESC,
        CASE event_kind WHEN 'deletion' THEN 2 WHEN 'edit' THEN 1 ELSE 0 END DESC
      LIMIT 1
    `).get(sourceId, Number(own.telegram_message_id)) as Row;
    return latest.event_kind !== "deletion" && Number(latest.team_event_id) === teamEventId;
  }

  messageDeleted(sourceId: string, telegramMessageId: number): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM team_event_revisions
      WHERE source_id = ? AND telegram_message_id = ? AND event_kind = 'deletion'
      LIMIT 1
    `).get(sourceId, telegramMessageId));
  }

  startSync(sourceId: string, connectorId: string, now = Date.now() / 1_000): number {
    return this.transaction(() => {
      const active = this.db.prepare(`
        SELECT id FROM team_sync_runs WHERE source_id = ?
          AND collector_state IN ('backfilling','tailing','paused')
        ORDER BY generation DESC LIMIT 1
      `).get(sourceId) as Row | undefined;
      if (active) return Number(active.id);
      const generation = Number((this.db.prepare(`
        SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM team_sync_runs WHERE source_id = ?
      `).get(sourceId) as Row).generation);
      const result = this.db.prepare(`
        INSERT INTO team_sync_runs
          (source_id, connector_id, generation, collector_state, started_at, updated_at)
        VALUES (?, ?, ?, 'backfilling', ?, ?)
      `).run(sourceId, connectorId, generation, now, now);
      const runId = Number(result.lastInsertRowid);
      this.db.prepare(`
        INSERT INTO team_sync_checkpoints (source_id, run_id, from_message_id, cursor_json, updated_at)
        VALUES (?, ?, 0, '{}', ?)
        ON CONFLICT(source_id) DO UPDATE SET run_id = excluded.run_id,
          from_message_id = 0, cursor_json = '{}', updated_at = excluded.updated_at
      `).run(sourceId, runId, now);
      for (const stage of STAGES) {
        this.db.prepare(`
          INSERT INTO team_sync_stages
            (source_id, stage, state, completed_count, total_count, failed_count, last_error, updated_at)
          VALUES (?, ?, 'pending', 0, 0, 0, '', ?)
          ON CONFLICT(source_id, stage) DO UPDATE SET state = 'pending',
            completed_count = 0, total_count = 0, failed_count = 0,
            last_error = '', updated_at = excluded.updated_at
        `).run(sourceId, stage, now);
      }
      return runId;
    });
  }

  hasSyncRun(sourceId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM team_sync_runs WHERE source_id = ? LIMIT 1
    `).get(sourceId));
  }

  checkpoint(sourceId: string): SyncCheckpoint | null {
    const row = this.db.prepare("SELECT * FROM team_sync_checkpoints WHERE source_id = ?")
      .get(sourceId) as Row | undefined;
    return row ? {
      sourceId: String(row.source_id),
      runId: Number(row.run_id),
      fromMessageId: Number(row.from_message_id),
      cursor: parseRecord(row.cursor_json),
      updatedAt: Number(row.updated_at),
    } : null;
  }

  updateCheckpoint(
    sourceId: string,
    fromMessageId: number,
    cursor: Record<string, unknown>,
    now = Date.now() / 1_000,
  ): void {
    this.db.prepare(`
      UPDATE team_sync_checkpoints SET from_message_id = ?, cursor_json = ?, updated_at = ?
      WHERE source_id = ?
    `).run(fromMessageId, JSON.stringify(cursor), now, sourceId);
  }

  incrementProgress(
    sourceId: string,
    counts: Partial<SyncCounters>,
    messageAt?: number,
    now = Date.now() / 1_000,
  ): void {
    const run = this.latestRun(sourceId);
    if (!run) throw new Error(`sync run is missing for ${sourceId}`);
    const columns: Array<[string, number]> = [
      ["discovered_count", counts.discovered ?? 0],
      ["accepted_count", counts.accepted ?? 0],
      ["skipped_count", counts.skipped ?? 0],
      ["consented_authors", counts.consentedAuthors ?? 0],
      ["unknown_authors", counts.unknownAuthors ?? 0],
      ["media_discovered", counts.mediaDiscovered ?? 0],
      ["media_uploaded", counts.mediaUploaded ?? 0],
      ["media_pending", counts.mediaPending ?? 0],
      ["media_failed", counts.mediaFailed ?? 0],
    ];
    const assignments = columns.map(([column]) => `${column} = MAX(0, ${column} + ?)`).join(", ");
    this.db.prepare(`
      UPDATE team_sync_runs SET ${assignments},
        first_message_at = CASE WHEN ? IS NULL THEN first_message_at
          WHEN first_message_at IS NULL THEN ? ELSE MIN(first_message_at, ?) END,
        last_message_at = CASE WHEN ? IS NULL THEN last_message_at
          WHEN last_message_at IS NULL THEN ? ELSE MAX(last_message_at, ?) END,
        last_event_at = COALESCE(?, last_event_at), updated_at = ? WHERE id = ?
    `).run(
      ...columns.map(([, value]) => value),
      messageAt ?? null, messageAt ?? null, messageAt ?? null,
      messageAt ?? null, messageAt ?? null, messageAt ?? null,
      messageAt ?? null, now, Number(run.id),
    );
  }

  recordLiveEvent(sourceId: string, occurredAt: number, now = Date.now() / 1_000): void {
    const run = this.latestRun(sourceId);
    if (!run) return;
    this.db.prepare(`
      UPDATE team_sync_runs SET last_live_event_at = ?, last_event_at = ?, updated_at = ?
      WHERE id = ?
    `).run(occurredAt, occurredAt, now, Number(run.id));
  }

  setCollectorState(
    sourceId: string,
    state: CollectorState,
    options: { error?: string; warning?: string; nextRetryAt?: number | null } = {},
  ): void {
    const run = this.latestRun(sourceId);
    if (!run) throw new Error(`sync run is missing for ${sourceId}`);
    this.db.prepare(`
      UPDATE team_sync_runs SET collector_state = ?, last_error = ?, warning = ?,
        next_retry_at = ?, updated_at = ? WHERE id = ?
    `).run(
      state,
      options.error ?? "",
      options.warning ?? "",
      options.nextRetryAt ?? null,
      Date.now() / 1_000,
      Number(run.id),
    );
  }

  markCollected(sourceId: string, now = Date.now() / 1_000): void {
    this.transaction(() => {
      const run = this.latestRun(sourceId);
      if (!run) throw new Error(`sync run is missing for ${sourceId}`);
      this.db.prepare(`
        UPDATE team_sync_runs SET collector_state = 'collected',
          initial_collected_at = COALESCE(initial_collected_at, ?), updated_at = ? WHERE id = ?
      `).run(now, now, Number(run.id));
      const status = this.syncStatus(sourceId);
      if (!status) return;
      this.db.prepare(`
        INSERT OR IGNORE INTO team_sync_outbox
          (idempotency_key, source_id, kind, payload_json, next_attempt_at, created_at)
        VALUES (?, ?, 'initial-collected', ?, ?, ?)
      `).run(
        `initial-collected:${sourceId}`,
        sourceId,
        JSON.stringify(status),
        now,
        now,
      );
      this.db.prepare(`
        UPDATE team_sync_runs SET collector_state = 'tailing', updated_at = ? WHERE id = ?
      `).run(now, Number(run.id));
    });
  }

  updateStage(
    sourceId: string,
    stage: SyncStageName,
    state: SyncStageState,
    options: {
      completed?: number;
      total?: number;
      failed?: number;
      error?: string;
      nextRetryAt?: number | null;
    } = {},
  ): void {
    const now = Date.now() / 1_000;
    this.db.prepare(`
      INSERT INTO team_sync_stages
        (source_id, stage, state, completed_count, total_count, failed_count,
         last_error, next_retry_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, stage) DO UPDATE SET state = excluded.state,
        completed_count = excluded.completed_count, total_count = excluded.total_count,
        failed_count = excluded.failed_count, last_error = excluded.last_error,
        next_retry_at = excluded.next_retry_at,
        updated_at = excluded.updated_at
    `).run(
      sourceId,
      stage,
      state,
      options.completed ?? 0,
      options.total ?? 0,
      options.failed ?? 0,
      options.error ?? "",
      options.nextRetryAt ?? null,
      now,
    );
  }

  enqueueJob(
    sourceId: string,
    kind: SyncStageName,
    dedupeKey: string,
    payload: Record<string, unknown>,
    now = Date.now() / 1_000,
  ): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO team_ingestion_jobs
        (source_id, kind, dedupe_key, payload_json, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sourceId, kind, dedupeKey, JSON.stringify(payload), now, now, now);
    return Number(result.changes) > 0;
  }

  claimJobs(limit = 8, now = Date.now() / 1_000): IngestionJob[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM team_ingestion_jobs
        WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?
      `).all(now, limit) as Row[];
      const update = this.db.prepare(`
        UPDATE team_ingestion_jobs SET state = 'running', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND state = 'pending'
      `);
      const claimed: IngestionJob[] = [];
      for (const row of rows) {
        if (Number(update.run(now, Number(row.id)).changes) === 0) continue;
        claimed.push({
          id: Number(row.id),
          sourceId: String(row.source_id),
          kind: String(row.kind) as SyncStageName,
          dedupeKey: String(row.dedupe_key),
          payload: parseRecord(row.payload_json),
          attempts: Number(row.attempts) + 1,
          nextAttemptAt: Number(row.next_attempt_at),
        });
      }
      return claimed;
    });
  }

  finishJob(id: number): boolean {
    const result = this.db.prepare(`
      UPDATE team_ingestion_jobs SET state = 'done', updated_at = ?
      WHERE id = ? AND state = 'running'
    `).run(Date.now() / 1_000, id);
    return Number(result.changes) > 0;
  }

  updateRunningJobPayload(id: number, payload: Record<string, unknown>): boolean {
    const result = this.db.prepare(`
      UPDATE team_ingestion_jobs SET payload_json = ?, updated_at = ?
      WHERE id = ? AND state = 'running'
    `).run(JSON.stringify(payload), Date.now() / 1_000, id);
    return Number(result.changes) > 0;
  }

  retryJob(id: number, error: string, attempts: number): boolean {
    const terminal = attempts >= 10;
    const delay = Math.min(86_400, 2 ** Math.min(attempts, 12) * 5);
    const result = this.db.prepare(`
      UPDATE team_ingestion_jobs SET state = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND state = 'running'
    `).run(
      terminal ? "failed" : "pending",
      Date.now() / 1_000 + delay,
      error.slice(0, 1_000),
      Date.now() / 1_000,
      id,
    );
    return terminal && Number(result.changes) > 0;
  }

  requeueFailedJobs(sourceId: string, kind?: SyncStageName): number {
    const now = Date.now() / 1_000;
    return this.transaction(() => {
      const filter = kind ? " AND kind = ?" : "";
      const parameters = kind ? [sourceId, kind] : [sourceId];
      const media = this.db.prepare(`
        SELECT COUNT(*) AS count FROM team_ingestion_jobs
        WHERE source_id = ? AND state = 'failed' AND kind = 'media'${kind ? " AND kind = ?" : ""}
      `).get(...parameters) as Row;
      const result = this.db.prepare(`
        UPDATE team_ingestion_jobs SET state = 'pending', attempts = 0,
          next_attempt_at = ?, last_error = '', updated_at = ?
        WHERE source_id = ? AND state = 'failed'${filter}
      `).run(now, now, ...parameters);
      const mediaCount = Number(media.count ?? 0);
      if (mediaCount > 0) {
        this.db.prepare(`
          UPDATE team_sync_runs
          SET media_pending = media_pending + ?,
              media_failed = MAX(0, media_failed - ?), updated_at = ?
          WHERE id = (
            SELECT id FROM team_sync_runs WHERE source_id = ?
            ORDER BY generation DESC LIMIT 1
          )
        `).run(mediaCount, mediaCount, now, sourceId);
      }
      return Number(result.changes);
    });
  }

  requeueLegacyMediaJobs(sourceId: string): number {
    const now = Date.now() / 1_000;
    return this.transaction(() => {
      const legacy = this.db.prepare(`
        SELECT COUNT(*) AS count FROM team_ingestion_jobs
        WHERE source_id = ? AND kind = 'media' AND state = 'failed'
          AND COALESCE(CAST(json_extract(payload_json, '$.mediaSchemaVersion') AS INTEGER), 0) < 2
          AND COALESCE(CAST(json_extract(payload_json, '$.telegramMessageId') AS INTEGER), 0) > 0
      `).get(sourceId) as Row;
      const count = Number(legacy.count ?? 0);
      if (count === 0) return 0;
      const result = this.db.prepare(`
        UPDATE team_ingestion_jobs
        SET state = 'pending', attempts = 0, next_attempt_at = ?, last_error = '',
            payload_json = json_set(payload_json, '$.mediaSchemaVersion', 2), updated_at = ?
        WHERE source_id = ? AND kind = 'media' AND state = 'failed'
          AND COALESCE(CAST(json_extract(payload_json, '$.mediaSchemaVersion') AS INTEGER), 0) < 2
          AND COALESCE(CAST(json_extract(payload_json, '$.telegramMessageId') AS INTEGER), 0) > 0
      `).run(now, now, sourceId);
      this.db.prepare(`
        UPDATE team_sync_runs
        SET media_pending = media_pending + ?,
            media_failed = MAX(0, media_failed - ?), updated_at = ?
        WHERE id = (
          SELECT id FROM team_sync_runs WHERE source_id = ?
          ORDER BY generation DESC LIMIT 1
        )
      `).run(count, count, now, sourceId);
      return Number(result.changes);
    });
  }

  claimOutbox(limit = 10, now = Date.now() / 1_000): SyncOutboxItem[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM team_sync_outbox
        WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?
      `).all(now, limit) as Row[];
      const update = this.db.prepare(`
        UPDATE team_sync_outbox SET state = 'sending', attempts = attempts + 1 WHERE id = ?
      `);
      return rows.filter((row) => Number(update.run(Number(row.id)).changes) > 0).map((row) => ({
        id: Number(row.id),
        sourceId: String(row.source_id),
        kind: String(row.kind),
        payload: parseRecord(row.payload_json),
        attempts: Number(row.attempts) + 1,
      }));
    });
  }

  finishOutbox(id: number): void {
    this.db.prepare(`UPDATE team_sync_outbox SET state = 'sent', sent_at = ? WHERE id = ?`)
      .run(Date.now() / 1_000, id);
  }

  retryOutbox(id: number, error: string, attempts: number): void {
    const delay = Math.min(86_400, 2 ** Math.min(attempts, 12) * 10);
    this.db.prepare(`
      UPDATE team_sync_outbox SET state = 'pending', next_attempt_at = ?, last_error = ? WHERE id = ?
    `).run(Date.now() / 1_000 + delay, error.slice(0, 1_000), id);
  }

  outboxFailures(): Array<{
    sourceId: string;
    kind: string;
    attempts: number;
    nextRetryAt: number;
    lastError: string;
  }> {
    return (this.db.prepare(`
      SELECT source_id, kind, attempts, next_attempt_at, last_error
      FROM team_sync_outbox WHERE state = 'pending' AND last_error <> ''
      ORDER BY next_attempt_at, id
    `).all() as Row[]).map((row) => ({
      sourceId: String(row.source_id),
      kind: String(row.kind),
      attempts: Number(row.attempts),
      nextRetryAt: Number(row.next_attempt_at),
      lastError: String(row.last_error).slice(0, 1_000),
    }));
  }

  recordContentObject(input: {
    sha256: string;
    objectKey: string;
    size: number;
    mimeType: string;
    fileName: string;
    backend: "local" | "s3";
    sourceId: string;
    refType: string;
    refId: string;
    telegramUserId?: number;
    now?: number;
  }): void {
    const now = input.now ?? Date.now() / 1_000;
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO content_objects
          (sha256, object_key, size_bytes, mime_type, file_name, backend, stored_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sha256, input.objectKey, input.size, input.mimeType,
        input.fileName, input.backend, now,
      );
      this.db.prepare(`
        INSERT INTO content_object_refs
          (sha256, source_id, telegram_user_id, ref_type, ref_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, ref_type, ref_id, sha256) DO UPDATE SET
          telegram_user_id = excluded.telegram_user_id,
          metadata_json = excluded.metadata_json
      `).run(
        input.sha256,
        input.sourceId,
        input.telegramUserId ?? null,
        input.refType,
        input.refId,
        JSON.stringify({ fileName: input.fileName, mimeType: input.mimeType, size: input.size }),
        now,
      );
    });
  }

  revokeAuthorContent(sourceId: string, telegramUserId: number): {
    removed: Array<{ sha256: string; objectKey: string; chunkIds: number[] }>;
    cancelledMedia: number;
  } {
    return this.transaction(() => {
      const cancelledMedia = Number(this.db.prepare(`
        UPDATE team_ingestion_jobs SET state = 'done', updated_at = ?
        WHERE source_id = ? AND kind = 'media' AND state IN ('pending','running')
          AND json_extract(payload_json, '$.telegramUserId') = ?
      `).run(Date.now() / 1_000, sourceId, telegramUserId).changes);
      const candidates = this.db.prepare(`
        SELECT DISTINCT content_objects.sha256, content_objects.object_key
        FROM content_object_refs JOIN content_objects
          ON content_objects.sha256 = content_object_refs.sha256
        WHERE content_object_refs.source_id = ? AND content_object_refs.telegram_user_id = ?
      `).all(sourceId, telegramUserId) as Row[];
      this.db.prepare(`
        DELETE FROM content_object_refs WHERE source_id = ? AND telegram_user_id = ?
      `).run(sourceId, telegramUserId);
      const removed = this.removeUnreferencedObjects(sourceId, candidates);
      return { removed, cancelledMedia };
    });
  }

  removeMessageContent(
    sourceId: string,
    telegramChatId: number,
    telegramMessageId: number,
  ): { removed: Array<{ sha256: string; objectKey: string; chunkIds: number[] }>; cancelledMedia: number } {
    return this.transaction(() => {
      const refPrefix = `${telegramChatId}:${telegramMessageId}:%`;
      const candidates = this.db.prepare(`
        SELECT DISTINCT content_objects.sha256, content_objects.object_key
        FROM content_object_refs JOIN content_objects
          ON content_objects.sha256 = content_object_refs.sha256
        WHERE content_object_refs.source_id = ? AND content_object_refs.ref_id LIKE ?
      `).all(sourceId, refPrefix) as Row[];
      this.db.prepare(`
        DELETE FROM content_object_refs WHERE source_id = ? AND ref_id LIKE ?
      `).run(sourceId, refPrefix);
      const cancelledMedia = Number(this.db.prepare(`
        UPDATE team_ingestion_jobs SET state = 'done', updated_at = ?
        WHERE source_id = ? AND kind = 'media' AND state IN ('pending','running')
          AND dedupe_key LIKE ?
      `).run(Date.now() / 1_000, sourceId, `${telegramMessageId}:%`).changes);
      const removed = this.removeUnreferencedObjects(sourceId, candidates);
      return { removed, cancelledMedia };
    });
  }

  private removeUnreferencedObjects(
    sourceId: string,
    candidates: Row[],
  ): Array<{ sha256: string; objectKey: string; chunkIds: number[] }> {
    const removed: Array<{ sha256: string; objectKey: string; chunkIds: number[] }> = [];
    for (const candidate of candidates) {
      const sha256 = String(candidate.sha256);
      const remaining = Number((this.db.prepare(`
        SELECT COUNT(*) AS count FROM content_object_refs WHERE sha256 = ?
      `).get(sha256) as Row).count ?? 0);
      if (remaining > 0) continue;
      this.db.prepare(`
        UPDATE team_ingestion_jobs SET state = 'done', updated_at = ?
        WHERE source_id = ? AND kind = 'extraction' AND state IN ('pending','running')
          AND json_extract(payload_json, '$.sha256') = ?
      `).run(Date.now() / 1_000, sourceId, sha256);
      const chunks = this.db.prepare(`
        SELECT DISTINCT search_chunk_blocks.chunk_id AS id
        FROM search_chunk_blocks JOIN document_blocks
          ON document_blocks.id = search_chunk_blocks.block_id
        WHERE document_blocks.object_hash = ?
      `).all(sha256) as Row[];
      const chunkIds: number[] = [];
      for (const chunk of chunks) {
        const chunkId = Number(chunk.id);
        this.db.prepare(`
          DELETE FROM search_chunk_blocks WHERE chunk_id = ? AND block_id IN (
            SELECT id FROM document_blocks WHERE object_hash = ?
          )
        `).run(chunkId, sha256);
        const survivingBlocks = (this.db.prepare(`
          SELECT block_id FROM search_chunk_blocks WHERE chunk_id = ? ORDER BY block_id
        `).all(chunkId) as Row[]).map((row) => Number(row.block_id));
        if (survivingBlocks.length > 0) {
          const survivor = this.db.prepare(`
            SELECT document_blocks.object_hash, document_blocks.locator_json,
              content_objects.file_name, content_objects.mime_type
            FROM search_chunk_blocks JOIN document_blocks
              ON document_blocks.id = search_chunk_blocks.block_id
            JOIN content_objects ON content_objects.sha256 = document_blocks.object_hash
            WHERE search_chunk_blocks.chunk_id = ? ORDER BY search_chunk_blocks.block_id LIMIT 1
          `).get(chunkId) as Row;
          const current = this.db.prepare("SELECT metadata_json FROM search_chunks WHERE id = ?")
            .get(chunkId) as Row;
          const metadata = {
            ...parseRecord(current.metadata_json),
            ...parseRecord(survivor.locator_json),
            objectHash: String(survivor.object_hash),
            fileName: String(survivor.file_name),
            documentType: String(survivor.mime_type),
          };
          this.db.prepare(`
            UPDATE search_chunks SET block_ids_json = ?, metadata_json = ? WHERE id = ?
          `).run(JSON.stringify(survivingBlocks), JSON.stringify(metadata), chunkId);
          continue;
        }
        this.db.prepare(`
          UPDATE team_ingestion_jobs SET state = 'done', updated_at = ?
          WHERE source_id = ? AND kind = 'embeddings' AND state IN ('pending','running')
            AND json_extract(payload_json, '$.chunkId') = ?
        `).run(Date.now() / 1_000, sourceId, chunkId);
        this.db.prepare(`
          DELETE FROM semantic_embeddings
          WHERE evidence_type = 'document_block' AND evidence_ref = ?
        `).run(`chunk:${chunkId}`);
        this.db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ?").run(chunkId);
        this.db.prepare("DELETE FROM search_chunks WHERE id = ?").run(chunkId);
        chunkIds.push(chunkId);
      }
      this.db.prepare("DELETE FROM document_blocks WHERE object_hash = ?").run(sha256);
      this.db.prepare("DELETE FROM content_objects WHERE sha256 = ?").run(sha256);
      removed.push({ sha256, objectKey: String(candidate.object_key), chunkIds });
    }
    return removed;
  }

  contentObject(sha256: string): { objectKey: string; size: number; backend: string } | null {
    const row = this.db.prepare("SELECT * FROM content_objects WHERE sha256 = ?").get(sha256) as Row | undefined;
    return row ? {
      objectKey: String(row.object_key),
      size: Number(row.size_bytes),
      backend: String(row.backend),
    } : null;
  }

  contentObjectRefsAllowedForModelEgress(sha256: string): Array<{
    sourceId: string;
    telegramUserId: number | null;
    refType: string;
    refId: string;
    metadata: Record<string, unknown>;
  }> {
    return (this.db.prepare(`
      SELECT r.source_id, r.telegram_user_id, r.ref_type, r.ref_id, r.metadata_json
      FROM content_object_refs r
      WHERE r.sha256 = ?
        AND NOT EXISTS (
          SELECT 1 FROM team_consents denied
          WHERE denied.source_id = r.source_id
            AND denied.telegram_user_id = r.telegram_user_id
            AND denied.status = 'revoked'
        )
        AND EXISTS (
          SELECT 1 FROM team_consents c, json_each(c.scope_json) scope
          WHERE c.source_id = r.source_id
            AND c.telegram_user_id IN (r.telegram_user_id, 0)
            AND c.status = 'granted'
            AND scope.value = 'model_egress'
        )
      ORDER BY r.id
    `).all(sha256) as Row[]).map((row) => ({
      sourceId: String(row.source_id),
      telegramUserId: row.telegram_user_id === null ? null : Number(row.telegram_user_id),
      refType: String(row.ref_type),
      refId: String(row.ref_id),
      metadata: parseRecord(row.metadata_json),
    }));
  }

  contentObjectModelEgressAllowed(sha256: string): boolean {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS ref_count,
        SUM(CASE WHEN NOT EXISTS (
          SELECT 1 FROM team_consents denied
          WHERE denied.source_id = r.source_id
            AND denied.telegram_user_id = r.telegram_user_id
            AND denied.status = 'revoked'
        ) AND EXISTS (
          SELECT 1 FROM team_consents c, json_each(c.scope_json) scope
          WHERE c.source_id = r.source_id
            AND c.telegram_user_id IN (r.telegram_user_id, 0)
            AND c.status = 'granted'
            AND scope.value = 'model_egress'
        ) THEN 0 ELSE 1 END) AS denied_count
      FROM content_object_refs r WHERE r.sha256 = ?
    `).get(sha256) as Row;
    return Number(row.ref_count ?? 0) > 0 && Number(row.denied_count ?? 0) === 0;
  }

  replaceDocumentBlocks(blocks: CanonicalBlockInput[]): number[] {
    if (blocks.length === 0) return [];
    return this.transaction(() => {
      const objectHash = blocks[0]!.objectHash;
      this.db.prepare("DELETE FROM document_blocks WHERE object_hash = ?").run(objectHash);
      const insert = this.db.prepare(`
        INSERT INTO document_blocks
          (object_hash, source_id, block_kind, ordinal, text, locator_json, structure_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const ids: number[] = [];
      for (const block of blocks) {
        const result = insert.run(
          block.objectHash, block.sourceId, block.blockKind, block.ordinal, block.text,
          JSON.stringify(block.locator), JSON.stringify(block.structure), Date.now() / 1_000,
        );
        ids.push(Number(result.lastInsertRowid));
      }
      return ids;
    });
  }

  documentBlocks(ids: number[]): Array<{
    id: number;
    blockKind: string;
    ordinal: number;
    locator: Record<string, unknown>;
  }> {
    const unique = [...new Set(ids)].filter(Number.isSafeInteger);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => "?").join(",");
    return (this.db.prepare(`
      SELECT id, block_kind, ordinal, locator_json FROM document_blocks
      WHERE id IN (${placeholders}) ORDER BY ordinal, id
    `).all(...unique) as Row[]).map((row) => ({
      id: Number(row.id),
      blockKind: String(row.block_kind),
      ordinal: Number(row.ordinal),
      locator: parseRecord(row.locator_json),
    }));
  }

  upsertSearchChunk(input: {
    sourceId: string;
    normalizedHash: string;
    text: string;
    blockIds: number[];
    metadata: Record<string, unknown>;
  }): number {
    this.db.prepare(`
      INSERT INTO search_chunks
        (source_id, normalized_hash, text, block_ids_json, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, normalized_hash) DO UPDATE SET text = excluded.text,
        metadata_json = excluded.metadata_json
    `).run(
      input.sourceId, input.normalizedHash, input.text, JSON.stringify(input.blockIds),
      JSON.stringify(input.metadata), Date.now() / 1_000,
    );
    const row = this.db.prepare(`
      SELECT id FROM search_chunks WHERE source_id = ? AND normalized_hash = ?
    `).get(input.sourceId, input.normalizedHash) as Row;
    const chunkId = Number(row.id);
    const insertLink = this.db.prepare(`
      INSERT OR IGNORE INTO search_chunk_blocks (chunk_id, block_id) VALUES (?, ?)
    `);
    input.blockIds.forEach((blockId) => insertLink.run(chunkId, blockId));
    const blockIds = (this.db.prepare(`
      SELECT block_id FROM search_chunk_blocks WHERE chunk_id = ? ORDER BY block_id
    `).all(chunkId) as Row[]).map((entry) => Number(entry.block_id));
    this.db.prepare("UPDATE search_chunks SET block_ids_json = ? WHERE id = ?")
      .run(JSON.stringify(blockIds), chunkId);
    return chunkId;
  }

  setChunkEmbedding(
    chunkId: number,
    model: string,
    vector: Float32Array,
    normalizedHash: string,
  ): void {
    this.db.prepare(`
      INSERT INTO chunk_embeddings
        (chunk_id, model, dimensions, vector, normalized_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET model = excluded.model,
        dimensions = excluded.dimensions, vector = excluded.vector,
        normalized_hash = excluded.normalized_hash, created_at = excluded.created_at
    `).run(
      chunkId, model, vector.length, new Uint8Array(vector.buffer), normalizedHash,
      Date.now() / 1_000,
    );
  }

  setSemanticEmbedding(input: {
    evidenceType: "document_block" | "knowledge";
    evidenceRef: string;
    sourceId: string;
    model: string;
    vector: Float32Array;
    normalizedHash: string;
    indexerVersion?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO semantic_embeddings
        (evidence_type, evidence_ref, source_id, model, dimensions, vector,
         normalized_hash, indexer_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(evidence_type, evidence_ref) DO UPDATE SET
        source_id = excluded.source_id, model = excluded.model,
        dimensions = excluded.dimensions, vector = excluded.vector,
        normalized_hash = excluded.normalized_hash,
        indexer_version = excluded.indexer_version, created_at = excluded.created_at
    `).run(
      input.evidenceType,
      input.evidenceRef,
      input.sourceId,
      input.model,
      input.vector.length,
      new Uint8Array(input.vector.buffer, input.vector.byteOffset, input.vector.byteLength),
      input.normalizedHash,
      input.indexerVersion ?? 1,
      Date.now() / 1_000,
    );
  }

  replaceKnowledgeEvidence(knowledgeId: number, eventIds: number[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM team_knowledge_evidence_refs WHERE knowledge_id = ?")
        .run(knowledgeId);
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO team_knowledge_evidence_refs
          (knowledge_id, evidence_type, evidence_ref, locator_json)
        VALUES (?, 'event', ?, '{}')
      `);
      [...new Set(eventIds)].forEach((eventId) => insert.run(knowledgeId, String(eventId)));
    });
  }

  removeKnowledgeIndex(knowledgeId: number): void {
    const evidenceRef = `knowledge:${knowledgeId}`;
    this.transaction(() => {
      this.db.prepare(`
        DELETE FROM semantic_embeddings WHERE evidence_type = 'knowledge' AND evidence_ref = ?
      `).run(evidenceRef);
      this.db.prepare("DELETE FROM team_knowledge_evidence_refs WHERE knowledge_id = ?")
        .run(knowledgeId);
    });
  }

  searchChunksMissingEmbeddings(limit: number): Array<{
    id: number;
    sourceId: string;
    normalizedHash: string;
    text: string;
  }> {
    return (this.db.prepare(`
      SELECT search_chunks.id, search_chunks.source_id, search_chunks.normalized_hash,
             search_chunks.text
      FROM search_chunks LEFT JOIN chunk_embeddings ON chunk_embeddings.chunk_id = search_chunks.id
      WHERE chunk_embeddings.chunk_id IS NULL ORDER BY search_chunks.id LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      id: Number(row.id),
      sourceId: String(row.source_id),
      normalizedHash: String(row.normalized_hash),
      text: String(row.text),
    }));
  }

  searchChunk(id: number): {
    id: number;
    sourceId: string;
    normalizedHash: string;
    text: string;
    blockIds: number[];
    metadata: Record<string, unknown>;
  } | null {
    const row = this.db.prepare("SELECT * FROM search_chunks WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    let blockIds = (this.db.prepare(`
      SELECT block_id FROM search_chunk_blocks WHERE chunk_id = ? ORDER BY block_id
    `).all(id) as Row[]).map((entry) => Number(entry.block_id));
    try {
      if (blockIds.length === 0) {
        const parsed = JSON.parse(String(row.block_ids_json));
        if (Array.isArray(parsed)) blockIds = parsed.map(Number).filter(Number.isSafeInteger);
      }
    } catch {
      blockIds = [];
    }
    return {
      id: Number(row.id),
      sourceId: String(row.source_id),
      normalizedHash: String(row.normalized_hash),
      text: String(row.text),
      blockIds,
      metadata: parseRecord(row.metadata_json),
    };
  }

  searchChunksAfter(afterId: number, limit = 500): Array<{
    id: number;
    sourceId: string;
    normalizedHash: string;
    text: string;
    blockIds: number[];
    metadata: Record<string, unknown>;
  }> {
    const rows = this.db.prepare(`
      SELECT id FROM search_chunks WHERE id > ? ORDER BY id LIMIT ?
    `).all(afterId, limit) as Row[];
    return rows.flatMap((row) => {
      const chunk = this.searchChunk(Number(row.id));
      return chunk ? [chunk] : [];
    });
  }

  semanticEmbeddingsAfter(
    afterRowId: number,
    model: string,
    dimensions: number,
    limit = 500,
  ): Array<{
    rowId: number;
    evidenceType: "document_block" | "knowledge";
    evidenceRef: string;
    vector: Float32Array;
  }> {
    return (this.db.prepare(`
      SELECT rowid, evidence_type, evidence_ref, vector, dimensions
      FROM semantic_embeddings
      WHERE rowid > ? AND model = ? AND dimensions = ? ORDER BY rowid LIMIT ?
    `).all(afterRowId, model, dimensions, limit) as Row[]).map((row) => {
      const bytes = row.vector as Uint8Array;
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return {
        rowId: Number(row.rowid),
        evidenceType: String(row.evidence_type) as "document_block" | "knowledge",
        evidenceRef: String(row.evidence_ref),
        vector: new Float32Array(copy.buffer, 0, Number(row.dimensions)),
      };
    });
  }

  semanticEmbeddingMatches(
    evidenceType: "document_block" | "knowledge",
    evidenceRef: string,
    model: string,
    dimensions: number,
  ): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM semantic_embeddings
      WHERE evidence_type = ? AND evidence_ref = ? AND model = ? AND dimensions = ?
      LIMIT 1
    `).get(evidenceType, evidenceRef, model, dimensions));
  }

  semanticEmbedding(
    evidenceType: "document_block" | "knowledge",
    evidenceRef: string,
    model: string,
    dimensions: number,
  ): Float32Array | null {
    const row = this.db.prepare(`
      SELECT vector, dimensions FROM semantic_embeddings
      WHERE evidence_type = ? AND evidence_ref = ? AND model = ? AND dimensions = ?
    `).get(evidenceType, evidenceRef, model, dimensions) as Row | undefined;
    if (!row) return null;
    const bytes = row.vector as Uint8Array;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Float32Array(copy.buffer, 0, Number(row.dimensions));
  }

  jobStats(sourceId: string, kind: SyncStageName): {
    pending: number;
    running: number;
    done: number;
    failed: number;
    lastError: string;
    nextRetryAt: number | null;
  } {
    const rows = this.db.prepare(`
      SELECT state, COUNT(*) AS count FROM team_ingestion_jobs
      WHERE source_id = ? AND kind = ? GROUP BY state
    `).all(sourceId, kind) as Row[];
    const counts = new Map(rows.map((row) => [String(row.state), Number(row.count)]));
    const error = this.db.prepare(`
      SELECT last_error FROM team_ingestion_jobs
      WHERE source_id = ? AND kind = ? AND last_error <> ''
      ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(sourceId, kind) as Row | undefined;
    const retry = this.db.prepare(`
      SELECT MIN(next_attempt_at) AS next_retry_at FROM team_ingestion_jobs
      WHERE source_id = ? AND kind = ? AND state = 'pending' AND last_error <> ''
    `).get(sourceId, kind) as Row;
    return {
      pending: counts.get("pending") ?? 0,
      running: counts.get("running") ?? 0,
      done: counts.get("done") ?? 0,
      failed: counts.get("failed") ?? 0,
      lastError: String(error?.last_error ?? "").slice(0, 1_000),
      nextRetryAt: retry.next_retry_at === null ? null : Number(retry.next_retry_at),
    };
  }

  syncStatus(sourceId: string): SyncStatus | null {
    const row = this.db.prepare(`
      SELECT b.*, c.state AS connector_state, c.phone_mask, c.last_update_at,
        c.last_error AS connector_error,
        r.id AS run_id, r.generation, r.collector_state, r.discovered_count,
        r.accepted_count, r.skipped_count, r.consented_authors, r.unknown_authors,
        r.media_discovered, r.media_uploaded, r.media_pending, r.media_failed,
        r.first_message_at, r.last_message_at, r.last_event_at, r.last_live_event_at,
        r.initial_collected_at,
        r.warning, r.last_error, r.next_retry_at, r.started_at,
        cp.from_message_id, cp.cursor_json
      FROM team_source_connectors b
      JOIN mtproto_connectors c ON c.id = b.connector_id
      LEFT JOIN team_sync_runs r ON r.id = (
        SELECT id FROM team_sync_runs WHERE source_id = b.source_id ORDER BY generation DESC LIMIT 1
      )
      LEFT JOIN team_sync_checkpoints cp ON cp.source_id = b.source_id
      WHERE b.source_id = ?
    `).get(sourceId) as Row | undefined;
    if (!row) return null;
    const stageRows = this.db.prepare(
      "SELECT * FROM team_sync_stages WHERE source_id = ?",
    ).all(sourceId) as Row[];
    const stages = {} as Record<SyncStageName, SyncStageStatus>;
    for (const name of STAGES) {
      const stage = stageRows.find((candidate) => candidate.stage === name);
      stages[name] = {
        name,
        state: String(stage?.state ?? "pending") as SyncStageState,
        completed: Number(stage?.completed_count ?? 0),
        total: Number(stage?.total_count ?? 0),
        failed: Number(stage?.failed_count ?? 0),
        lastError: String(stage?.last_error ?? ""),
        nextRetryAt: stage?.next_retry_at === null || stage?.next_retry_at === undefined
          ? null : Number(stage.next_retry_at),
        updatedAt: Number(stage?.updated_at ?? row.updated_at),
      };
    }
    const lastEventAt = row.last_event_at === null ? null : Number(row.last_event_at);
    const skippedMessages = Number(row.skipped_count ?? 0);
    const skippedAuthorTotals = this.db.prepare(`
      SELECT COUNT(*) AS author_count,
        COALESCE(SUM(message_count - recovered_count), 0) AS message_count
      FROM team_sync_unknown_authors
      WHERE source_id = ? AND message_count > recovered_count
    `).get(sourceId) as Row;
    const skippedAuthorRows = this.db.prepare(`
      SELECT telegram_user_id, message_count - recovered_count AS message_count,
        first_seen_at, last_seen_at
      FROM team_sync_unknown_authors
      WHERE source_id = ? AND message_count > recovered_count
      ORDER BY message_count - recovered_count DESC, last_seen_at DESC, telegram_user_id
      LIMIT 100
    `).all(sourceId) as Row[];
    const skippedAuthorCount = Number(skippedAuthorTotals.author_count ?? 0);
    const attributedSkippedMessages = Number(skippedAuthorTotals.message_count ?? 0);
    return {
      sourceId: String(row.source_id),
      connectorId: String(row.connector_id),
      telegramChatId: Number(row.telegram_chat_id),
      title: String(row.title),
      connector: {
        state: String(row.connector_state) as ConnectorState,
        phoneMask: String(row.phone_mask),
        lastUpdateAt: row.last_update_at === null ? null : Number(row.last_update_at),
        lastError: String(row.connector_error ?? "").slice(0, 1_000),
      },
      collector: {
        state: String(row.collector_state ?? "not_started") as CollectorState,
        generation: Number(row.generation ?? 0),
        startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
        initialCollectedAt: row.initial_collected_at === null || row.initial_collected_at === undefined
          ? null : Number(row.initial_collected_at),
        lastEventAt,
        lastLiveEventAt: row.last_live_event_at === null || row.last_live_event_at === undefined
          ? null : Number(row.last_live_event_at),
        firstMessageAt: row.first_message_at === null || row.first_message_at === undefined
          ? null : Number(row.first_message_at),
        lastMessageAt: row.last_message_at === null || row.last_message_at === undefined
          ? null : Number(row.last_message_at),
        checkpoint: row.cursor_json ? JSON.stringify(parseRecord(row.cursor_json)) : "",
        lagSeconds: lastEventAt === null ? null : Math.max(0, Date.now() / 1_000 - lastEventAt),
      },
      counters: {
        discovered: Number(row.discovered_count ?? 0),
        accepted: Number(row.accepted_count ?? 0),
        skipped: skippedMessages,
        consentedAuthors: Number(row.consented_authors ?? 0),
        unknownAuthors: Number(row.unknown_authors ?? 0),
        mediaDiscovered: Number(row.media_discovered ?? 0),
        mediaUploaded: Number(row.media_uploaded ?? 0),
        mediaPending: Number(row.media_pending ?? 0),
        mediaFailed: Number(row.media_failed ?? 0),
      },
      groupConsent: (() => {
        const consent = this.groupConsent(sourceId);
        return {
          granted: this.groupConsentGranted(sourceId),
          scope: consent?.scope ?? [],
          historicalFrom: consent?.historicalFrom ?? null,
        };
      })(),
      historyRecovery: this.historyRecovery(sourceId),
      unknownAuthorIds: (this.db.prepare(`
        SELECT telegram_user_id FROM team_sync_unknown_authors
        WHERE source_id = ? AND message_count > recovered_count
        ORDER BY telegram_user_id LIMIT 500
      `).all(sourceId) as Row[]).map((author) => Number(author.telegram_user_id)),
      skippedByAuthor: {
        totalAuthors: skippedAuthorCount,
        attributedMessages: attributedSkippedMessages,
        unattributedMessages: Math.max(0, skippedMessages - attributedSkippedMessages),
        truncated: skippedAuthorCount > skippedAuthorRows.length,
        items: skippedAuthorRows.map((author) => ({
          telegramUserId: Number(author.telegram_user_id),
          messageCount: Number(author.message_count),
          firstSeenAt: Number(author.first_seen_at),
          lastSeenAt: Number(author.last_seen_at),
        })),
      },
      stages,
      warning: String(row.warning ?? ""),
      lastError: String(row.last_error ?? ""),
      nextRetryAt: row.next_retry_at === null || row.next_retry_at === undefined
        ? null : Number(row.next_retry_at),
    };
  }

  listSyncStatuses(): SyncStatus[] {
    return this.listBindings().map((binding) => this.syncStatus(binding.sourceId)!).filter(Boolean);
  }

  consentedRetainedSourceIds(): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT r.source_id
      FROM team_sync_runs r JOIN team_consents c ON c.source_id = r.source_id
      WHERE c.status = 'granted' AND EXISTS (
        SELECT 1 FROM json_each(c.scope_json) scope WHERE scope.value = 'history'
      )
      ORDER BY r.source_id
    `).all() as Row[]).map((row) => String(row.source_id));
  }

  private latestRun(sourceId: string): Row | null {
    return (this.db.prepare(`
      SELECT * FROM team_sync_runs WHERE source_id = ? ORDER BY generation DESC LIMIT 1
    `).get(sourceId) as Row | undefined) ?? null;
  }

  private toConnector(row: Row): MtprotoConnectorRecord {
    return {
      id: String(row.id),
      state: String(row.state) as ConnectorState,
      apiId: Number(row.api_id),
      encryptedApiHash: String(row.encrypted_api_hash),
      phoneMask: String(row.phone_mask),
      databaseDirectory: String(row.database_directory),
      lastUpdateAt: row.last_update_at === null ? null : Number(row.last_update_at),
      lastError: String(row.last_error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private toBinding(row: Row): SourceConnectorBinding {
    return {
      sourceId: String(row.source_id),
      connectorId: String(row.connector_id),
      telegramChatId: Number(row.telegram_chat_id),
      title: String(row.title),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private toConsent(row: Row): TeamConsentRecord {
    return {
      sourceId: String(row.source_id),
      telegramUserId: Number(row.telegram_user_id),
      status: String(row.status) as ConsentStatus,
      scope: parseStrings(row.scope_json),
      grantedAt: Number(row.granted_at),
      historicalFrom: row.historical_from === null ? null : Number(row.historical_from),
      proof: String(row.proof),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
