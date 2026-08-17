import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

export interface SearchFilters {
  sourceId?: string;
  evidenceType?: "event" | "document_block" | "knowledge";
  authorId?: string;
  topicId?: string;
  dateFrom?: number;
  dateTo?: number;
  documentType?: string;
  limit?: number;
}

export interface SearchHit {
  sourceId: string;
  evidenceType: string;
  evidenceRef: string;
  locator: Record<string, unknown>;
  score: number;
  lexicalRank: number | null;
  vectorRank: number | null;
}

export interface VectorIndex {
  readonly available: boolean;
  upsert(entryId: number, sourceId: string, evidenceType: string, vector: Float32Array): void;
  remove(entryId: number): void;
  search(vector: Float32Array, filters: SearchFilters, limit: number): Array<{ id: number }>;
}

type Row = Record<string, SQLInputValue>;

function vectorBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function parseLocator(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function ftsQuery(query: string): string {
  const terms = query.normalize("NFKC").match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return terms.slice(0, 20).map((term) => {
    const escaped = term.replace(/"/g, '""');
    if (term.length < 5) return `"${escaped}"`;
    const prefix = term.slice(0, -1).replace(/"/g, '""');
    return `("${escaped}" OR "${prefix}"*)`;
  }).join(" OR ");
}

class SqliteVecVectorIndex implements VectorIndex {
  readonly available = true;

  constructor(
    private readonly db: DatabaseSync,
    private readonly dimensions: number,
  ) {}

  upsert(entryId: number, sourceId: string, evidenceType: string, vector: Float32Array): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`embedding dimensions ${vector.length} do not match index ${this.dimensions}`);
    }
    this.db.prepare("DELETE FROM search_vectors WHERE rowid = ?").run(BigInt(entryId));
    this.db.prepare(`
      INSERT INTO search_vectors(rowid, embedding, source_id, evidence_type)
      VALUES (?, ?, ?, ?)
    `).run(BigInt(entryId), vectorBlob(vector), sourceId, evidenceType);
  }

  remove(entryId: number): void {
    this.db.prepare("DELETE FROM search_vectors WHERE rowid = ?").run(BigInt(entryId));
  }

  search(vector: Float32Array, filters: SearchFilters, limit: number): Array<{ id: number }> {
    if (vector.length !== this.dimensions) return [];
    const clauses = ["v.embedding MATCH ?", "v.k = ?"];
    const values: SQLInputValue[] = [vectorBlob(vector), limit];
    if (filters.sourceId) {
      clauses.push("v.source_id = ?");
      values.push(filters.sourceId);
    }
    if (filters.evidenceType) {
      clauses.push("v.evidence_type = ?");
      values.push(filters.evidenceType);
    }
    appendEntryFilters(clauses, values, filters, "e");
    return (this.db.prepare(`
      SELECT v.rowid AS id, v.distance FROM search_vectors v
      JOIN search_entries e ON e.id = v.rowid
      WHERE ${clauses.join(" AND ")} ORDER BY distance
    `).all(...values) as Row[]).map((row) => ({ id: Number(row.id) }));
  }
}

class DisabledVectorIndex implements VectorIndex {
  readonly available = false;
  upsert(): void {}
  remove(): void {}
  search(): Array<{ id: number }> { return []; }
}

function appendEntryFilters(
  clauses: string[],
  values: SQLInputValue[],
  filters: SearchFilters,
  alias: string,
): void {
  if (filters.authorId) {
    clauses.push(`json_extract(${alias}.locator_json, '$.authorId') = ?`);
    values.push(filters.authorId);
  }
  if (filters.topicId) {
    clauses.push(`json_extract(${alias}.locator_json, '$.topicId') = ?`);
    values.push(filters.topicId);
  }
  if (filters.dateFrom !== undefined) {
    clauses.push(`json_extract(${alias}.locator_json, '$.occurredAt') >= ?`);
    values.push(filters.dateFrom);
  }
  if (filters.dateTo !== undefined) {
    clauses.push(`json_extract(${alias}.locator_json, '$.occurredAt') <= ?`);
    values.push(filters.dateTo);
  }
  if (filters.documentType) {
    clauses.push(`json_extract(${alias}.locator_json, '$.documentType') = ?`);
    values.push(filters.documentType);
  }
}

export class KnowledgeSearchIndex {
  private readonly db: DatabaseSync;
  private readonly vectorIndex: VectorIndex;
  readonly vectorAvailable: boolean;

  constructor(path: string, readonly dimensions = 1_536) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
    let vectorAvailable = false;
    try {
      sqliteVec.load(this.db);
      vectorAvailable = true;
    } catch (error) {
      console.warn("sqlite-vec could not be loaded; lexical search remains available", error);
    } finally {
      this.db.enableLoadExtension(false);
    }
    this.vectorAvailable = vectorAvailable;
    this.createSchema();
    this.vectorIndex = vectorAvailable
      ? new SqliteVecVectorIndex(this.db, this.dimensions)
      : new DisabledVectorIndex();
  }

  close(): void {
    this.db.close();
  }

  entryCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM search_entries").get() as Row;
    return Number(row.count ?? 0);
  }

  rebuildRequired(signature: string): boolean {
    const row = this.db.prepare(`
      SELECT value FROM search_meta WHERE key = 'complete_rebuild_version'
    `).get() as Row | undefined;
    return String(row?.value ?? "") !== signature;
  }

  markRebuilt(signature: string): void {
    this.db.prepare(`
      INSERT INTO search_meta (key, value) VALUES ('complete_rebuild_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(signature);
  }

  reset(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("INSERT INTO search_fts(search_fts) VALUES('delete-all')");
      if (this.vectorAvailable) this.db.exec("DELETE FROM search_vectors");
      this.db.exec("DELETE FROM search_entries; DELETE FROM search_meta");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        evidence_ref TEXT NOT NULL,
        locator_json TEXT NOT NULL DEFAULT '{}',
        normalized_hash TEXT NOT NULL,
        updated_at REAL NOT NULL,
        UNIQUE(evidence_type, evidence_ref)
      );
      CREATE INDEX IF NOT EXISTS search_entries_source
        ON search_entries(source_id, evidence_type, id);
      CREATE TABLE IF NOT EXISTS search_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        text,
        content='',
        contentless_delete=1,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    if (this.vectorAvailable) {
      const existing = this.db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'search_vectors'
      `).get() as Row | undefined;
      if (existing && !String(existing.sql).includes(`FLOAT[${this.dimensions}]`)) {
        this.db.exec("DROP TABLE search_vectors");
        this.db.prepare("DELETE FROM search_meta WHERE key = 'complete_rebuild_version'").run();
      }
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_vectors USING vec0(
          embedding FLOAT[${this.dimensions}] distance_metric=cosine,
          source_id TEXT,
          evidence_type TEXT
        );
      `);
    }
  }

  indexText(input: {
    sourceId: string;
    evidenceType: "event" | "document_block" | "knowledge";
    evidenceRef: string;
    text: string;
    normalizedHash: string;
    locator?: Record<string, unknown>;
    embedding?: Float32Array;
  }): number {
    const now = Date.now() / 1_000;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(`
        SELECT id, normalized_hash FROM search_entries WHERE evidence_type = ? AND evidence_ref = ?
      `).get(input.evidenceType, input.evidenceRef) as Row | undefined;
      const changed = !existing || String(existing.normalized_hash) !== input.normalizedHash;
      this.db.prepare(`
        INSERT INTO search_entries
          (source_id, evidence_type, evidence_ref, locator_json, normalized_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(evidence_type, evidence_ref) DO UPDATE SET
          source_id = excluded.source_id, locator_json = excluded.locator_json,
          normalized_hash = excluded.normalized_hash, updated_at = excluded.updated_at
      `).run(
        input.sourceId,
        input.evidenceType,
        input.evidenceRef,
        JSON.stringify(input.locator ?? {}),
        input.normalizedHash,
        now,
      );
      const row = this.db.prepare(`
        SELECT id FROM search_entries WHERE evidence_type = ? AND evidence_ref = ?
      `).get(input.evidenceType, input.evidenceRef) as Row;
      const entryId = Number(row.id);
      if (changed && existing) this.db.prepare("DELETE FROM search_fts WHERE rowid = ?").run(entryId);
      if (changed || !existing) {
        this.db.prepare("INSERT INTO search_fts(rowid, text) VALUES (?, ?)").run(entryId, input.text);
      }
      if (input.embedding) this.upsertVector(entryId, input, input.embedding);
      this.db.exec("COMMIT");
      return entryId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertVector(
    entryId: number,
    input: { sourceId: string; evidenceType: string },
    embedding: Float32Array,
  ): void {
    this.vectorIndex.upsert(entryId, input.sourceId, input.evidenceType, embedding);
  }

  setEmbedding(
    evidenceType: "event" | "document_block" | "knowledge",
    evidenceRef: string,
    vector: Float32Array,
  ): void {
    const row = this.db.prepare(`
      SELECT id, source_id FROM search_entries WHERE evidence_type = ? AND evidence_ref = ?
    `).get(evidenceType, evidenceRef) as Row | undefined;
    if (!row) throw new Error(`search entry ${evidenceType}:${evidenceRef} is missing`);
    this.upsertVector(Number(row.id), {
      sourceId: String(row.source_id),
      evidenceType,
    }, vector);
  }

  remove(evidenceType: string, evidenceRef: string): void {
    const row = this.db.prepare(`
      SELECT id FROM search_entries WHERE evidence_type = ? AND evidence_ref = ?
    `).get(evidenceType, evidenceRef) as Row | undefined;
    if (!row) return;
    const id = Number(row.id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM search_fts WHERE rowid = ?").run(id);
      this.vectorIndex.remove(id);
      this.db.prepare("DELETE FROM search_entries WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  search(query: string, vector: Float32Array | null, filters: SearchFilters = {}): SearchHit[] {
    const limit = Math.max(1, Math.min(100, filters.limit ?? 20));
    const lexical = this.lexicalSearch(query, filters, 40);
    const semantic = vector && this.vectorIndex.available
      ? this.vectorIndex.search(vector, filters, 40)
      : [];
    const combined = new Map<number, { lexicalRank: number | null; vectorRank: number | null; score: number }>();
    lexical.forEach((item, index) => combined.set(item.id, {
      lexicalRank: index + 1,
      vectorRank: null,
      score: 1 / (60 + index + 1),
    }));
    semantic.forEach((item, index) => {
      const existing = combined.get(item.id) ?? { lexicalRank: null, vectorRank: null, score: 0 };
      existing.vectorRank = index + 1;
      existing.score += 1 / (60 + index + 1);
      combined.set(item.id, existing);
    });
    const ids = [...combined.entries()]
      .sort((left, right) => right[1].score - left[1].score)
      .slice(0, limit);
    const queryEntry = this.db.prepare(`
      SELECT source_id, evidence_type, evidence_ref, locator_json FROM search_entries WHERE id = ?
    `);
    return ids.flatMap(([id, rank]) => {
      const row = queryEntry.get(id) as Row | undefined;
      return row ? [{
        sourceId: String(row.source_id),
        evidenceType: String(row.evidence_type),
        evidenceRef: String(row.evidence_ref),
        locator: parseLocator(row.locator_json),
        score: rank.score,
        lexicalRank: rank.lexicalRank,
        vectorRank: rank.vectorRank,
      }] : [];
    });
  }

  private lexicalSearch(query: string, filters: SearchFilters, limit: number): Array<{ id: number }> {
    const match = ftsQuery(query);
    if (!match) return [];
    const clauses = ["search_fts MATCH ?"];
    const values: SQLInputValue[] = [match];
    if (filters.sourceId) {
      clauses.push("e.source_id = ?");
      values.push(filters.sourceId);
    }
    if (filters.evidenceType) {
      clauses.push("e.evidence_type = ?");
      values.push(filters.evidenceType);
    }
    appendEntryFilters(clauses, values, filters, "e");
    values.push(limit);
    return (this.db.prepare(`
      SELECT e.id FROM search_fts JOIN search_entries e ON e.id = search_fts.rowid
      WHERE ${clauses.join(" AND ")} ORDER BY bm25(search_fts) LIMIT ?
    `).all(...values) as Row[]).map((row) => ({ id: Number(row.id) }));
  }

}

export class OpenAIEmbeddingClient {
  constructor(
    readonly apiKey: string,
    readonly model = "text-embedding-3-small",
    readonly dimensions = 1_536,
  ) {}

  async embed(inputs: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for embeddings");
    if (inputs.length === 0) return [];
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: inputs, dimensions: this.dimensions }),
      ...(signal ? { signal } : {}),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`OpenAI embeddings failed (${response.status}): ${body.slice(0, 500)}`);
    const parsed = JSON.parse(body) as { data?: Array<{ index: number; embedding: number[] }> };
    const ordered = [...(parsed.data ?? [])].sort((left, right) => left.index - right.index);
    if (ordered.length !== inputs.length) throw new Error("OpenAI embeddings response is incomplete");
    return ordered.map((item) => new Float32Array(item.embedding));
  }
}
