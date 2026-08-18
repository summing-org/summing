import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { KnowledgeSyncConfig } from "./config.js";
import type { KnowledgeSyncStore, KnowledgeTransferMode } from "./knowledge-sync-store.js";
import type { ObjectStore } from "./object-store.js";
import { sha256File } from "./object-store.js";
import type { StateStore } from "./state-store.js";

const FORMAT = "summing-team-space-transfer";
const FORMAT_VERSION = 2;
const CIPHER = "aes-256-gcm";

type Row = Record<string, SQLInputValue>;

interface TransferManifest {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  exportId: string;
  mode: KnowledgeTransferMode;
  createdAt: string;
  space: { id: string; title: string };
  sources: Array<{
    id: string;
    provider: string;
    telegramChatId: number;
    externalThreadId: string;
    title: string;
    checkpoint: Record<string, unknown>;
  }>;
  catalog: { key: string; sha256: string; size: number; iv: string; tag: string };
  counts: Record<string, number>;
  hmac: string;
}

export interface KnowledgeExportResult {
  exportId: string;
  mode: KnowledgeTransferMode;
  bundleKey: string;
  counts: Record<string, number>;
  catalogBytes: number;
}

export interface KnowledgeImportInspection {
  exportId: string;
  mode: KnowledgeTransferMode;
  bundleKey: string;
  spaceId: string;
  sourceId: string;
  telegramChatId: number;
  title: string;
  sources: TransferManifest["sources"];
  linkedProjectIds: string[];
  counts: Record<string, number>;
  grantedConsents: number;
  missingObjects: number;
  sourceConflicts: number;
  eventConflicts: number;
  knowledgeConflicts: number;
  objectConflicts: number;
  consentOverrides: number;
  existingEvents: number;
  existingKnowledge: number;
  existingObjects: number;
  ready: boolean;
  warnings: string[];
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function parseTransferKey(path: string): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("knowledge transfer key must be a regular file, not a symlink");
  }
  const raw = readFileSync(path);
  const text = raw.toString("utf8").trim();
  const key = /^[a-f0-9]{64}$/i.test(text) ? Buffer.from(text, "hex") : raw;
  if (key.length !== 32) throw new Error("knowledge transfer key must contain exactly 32 bytes");
  return key;
}

function deriveKey(master: Buffer, exportId: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(exportId), Buffer.from(purpose), 32));
}

export function parsePortableTransferKey(value: string): Buffer {
  const normalized = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64url");
  if (key.length !== 32) throw new Error("Team Space recovery key must contain exactly 32 bytes");
  return key;
}

export function wrapPortableTransferKey(
  localKeyPath: string,
  transferId: string,
  portableKey: Buffer,
): string {
  if (portableKey.length !== 32) throw new Error("Team Space recovery key must contain exactly 32 bytes");
  const local = parseTransferKey(localKeyPath);
  const key = deriveKey(local, transferId, "summing-team-space-key-wrap-v1");
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(portableKey), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

export function unwrapPortableTransferKey(
  localKeyPath: string,
  transferId: string,
  wrapped: string,
): Buffer {
  let envelope: { version?: unknown; iv?: unknown; tag?: unknown; ciphertext?: unknown };
  try {
    envelope = JSON.parse(wrapped) as typeof envelope;
  } catch {
    throw new Error("Team Space recovery key envelope is invalid");
  }
  if (envelope.version !== 1) throw new Error("Team Space recovery key envelope is unsupported");
  const local = parseTransferKey(localKeyPath);
  const key = deriveKey(local, transferId, "summing-team-space-key-wrap-v1");
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(String(envelope.iv), "base64"));
  decipher.setAuthTag(Buffer.from(String(envelope.tag), "base64"));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext), "base64")),
    decipher.final(),
  ]);
  if (clear.length !== 32) throw new Error("Team Space recovery key envelope is invalid");
  return clear;
}

function safeObjectKey(key: string): string {
  if (!key || key.startsWith("/") || key.includes("\\")) throw new Error("invalid bundle object key");
  const parts = key.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid bundle object key");
  }
  return parts.join("/");
}

function transferRoot(prefix: string, exportId: string): string {
  return [prefix.replace(/^\/+|\/+$/g, ""), "exports", exportId].filter(Boolean).join("/");
}

function directoryBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directoryBytes(child) : entry.isFile() ? statSync(child).size : 0;
  }
  return total;
}

async function encryptFile(inputPath: string, outputPath: string, key: Buffer): Promise<{
  iv: string;
  tag: string;
}> {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  await pipeline(createReadStream(inputPath), cipher, createWriteStream(outputPath, { mode: 0o600 }));
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

async function decryptFile(
  inputPath: string,
  outputPath: string,
  key: Buffer,
  iv: string,
  tag: string,
): Promise<void> {
  const decipher = createDecipheriv(CIPHER, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  await pipeline(createReadStream(inputPath), decipher, createWriteStream(outputPath, { mode: 0o600 }));
}

function numberCell(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  const row = db.prepare(sql).get(...params) as Row;
  return Number(row.count ?? 0);
}

function manifestBody(manifest: TransferManifest): Omit<TransferManifest, "hmac"> {
  const { hmac: _hmac, ...body } = manifest;
  return body;
}

function signManifest(manifest: TransferManifest, signingKey: Buffer): string {
  return createHmac("sha256", signingKey).update(stableJson(manifestBody(manifest))).digest("hex");
}

function verifyManifest(manifest: TransferManifest, signingKey: Buffer): void {
  if (manifest.format !== FORMAT || manifest.version !== FORMAT_VERSION) {
    throw new Error("unsupported Team Space bundle format");
  }
  if (!/^[a-f0-9-]{20,80}$/i.test(manifest.exportId)) throw new Error("invalid export id");
  if (!manifest.space?.id || !manifest.space.title || !Array.isArray(manifest.sources) ||
    manifest.sources.length === 0 || manifest.sources.length > 10_000) {
    throw new Error("Team Space bundle manifest is incomplete");
  }
  if (new Set(manifest.sources.map((source) => source.id)).size !== manifest.sources.length ||
    manifest.sources.some((source) =>
      !source.id || !source.provider || !Number.isSafeInteger(source.telegramChatId) ||
      !source.externalThreadId || !source.checkpoint || typeof source.checkpoint !== "object"
    )) {
    throw new Error("Team Space bundle sources are invalid");
  }
  const expected = Buffer.from(signManifest(manifest, signingKey), "hex");
  const actual = Buffer.from(String(manifest.hmac), "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("knowledge bundle signature is invalid");
  }
}

export class KnowledgeTransferManager {
  constructor(
    readonly config: KnowledgeSyncConfig,
    readonly state: StateStore,
    readonly core: KnowledgeSyncStore,
    readonly objectStore: ObjectStore,
    readonly administratorUserId: number,
  ) {}

  async export(input: {
    exportId: string;
    spaceId: string;
    mode: KnowledgeTransferMode;
    includeEmbeddings?: boolean;
    transferKey?: Buffer;
  }): Promise<KnowledgeExportResult> {
    const space = this.state.teamSpace(input.spaceId);
    if (!space) throw new Error("team space does not exist");
    const teamSources = this.state.listTeamSources(space.id);
    if (teamSources.length === 0) throw new Error("team space has no sources");
    const sources: TransferManifest["sources"] = teamSources.map((source) => {
      const binding = this.core.binding(source.id);
      const telegramChatId = binding?.telegramChatId ?? Number(source.externalSpaceId);
      if (source.provider === "telegram" && !Number.isSafeInteger(telegramChatId)) {
        throw new Error(`Telegram source ${source.id} has no portable chat id`);
      }
      return {
        id: source.id,
        provider: source.provider,
        telegramChatId,
        externalThreadId: source.externalThreadId,
        title: binding?.title || source.title || space.name,
        checkpoint: this.core.checkpoint(source.id)?.cursor ?? {},
      };
    });
    const work = this.createWorkDirectory(input.exportId);
    try {
      const stateBackup = join(work, "state.sqlite3");
      const coreBackup = join(work, "core.sqlite");
      const catalogPath = join(work, "catalog.sqlite");
      await Promise.all([this.state.backupTo(stateBackup), this.core.backupTo(coreBackup)]);
      chmodSync(stateBackup, 0o600);
      chmodSync(coreBackup, 0o600);
      this.assertSpoolBudget([stateBackup, coreBackup]);
      this.buildCatalog({
        catalogPath,
        stateBackup,
        coreBackup,
        spaceId: space.id,
        exportId: input.exportId,
        mode: input.mode,
        sources,
        includeEmbeddings: input.includeEmbeddings !== false,
      });
      rmSync(stateBackup, { force: true });
      rmSync(coreBackup, { force: true });
      this.assertWorkBudget(work);

      const master = input.transferKey ?? parseTransferKey(this.config.knowledgeTransferKeyPath);
      const objectKey = deriveKey(master, input.exportId, "summing-team-space-object-v2");
      if (input.mode === "portable") {
        await this.exportPortableObjects(catalogPath, input.exportId, objectKey, work);
      } else {
        await this.verifyManifestObjects(catalogPath);
      }
      const db = new DatabaseSync(catalogPath);
      db.exec("VACUUM");
      const counts = this.catalogCounts(db);
      db.close();
      chmodSync(catalogPath, 0o600);
      this.assertSpoolBudget([catalogPath]);

      const compressed = join(work, "catalog.sqlite.gz");
      await pipeline(
        createReadStream(catalogPath),
        createGzip({ level: 9 }),
        createWriteStream(compressed, { mode: 0o600 }),
      );
      this.assertWorkBudget(work);
      rmSync(catalogPath, { force: true });
      const encrypted = join(work, "catalog.sqlite.gz.enc");
      const catalogKey = deriveKey(master, input.exportId, "summing-team-space-catalog-v2");
      const encryption = await encryptFile(compressed, encrypted, catalogKey);
      this.assertWorkBudget(work);
      rmSync(compressed, { force: true });
      const digest = await sha256File(encrypted);
      const root = transferRoot(this.config.s3Prefix, input.exportId);
      const catalogObjectKey = `${root}/catalog.sqlite.gz.enc`;
      await this.objectStore.delete(catalogObjectKey);
      await this.objectStore.putFile(catalogObjectKey, encrypted, {
        format: FORMAT,
        version: String(FORMAT_VERSION),
        "export-id": input.exportId,
      });
      const bundleKey = `${root}/manifest.json`;
      const manifest: TransferManifest = {
        format: FORMAT,
        version: FORMAT_VERSION,
        exportId: input.exportId,
        mode: input.mode,
        createdAt: new Date().toISOString(),
        space: { id: space.id, title: space.name },
        sources,
        catalog: {
          key: catalogObjectKey,
          sha256: digest.sha256,
          size: digest.size,
          ...encryption,
        },
        counts,
        hmac: "",
      };
      manifest.hmac = signManifest(
        manifest,
        deriveKey(master, input.exportId, "summing-team-space-manifest-v2"),
      );
      const manifestPath = join(work, "manifest.json");
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      // The manifest is uploaded last and is therefore the bundle commit marker.
      await this.objectStore.delete(bundleKey);
      await this.objectStore.putFile(bundleKey, manifestPath, {
        format: FORMAT,
        version: String(FORMAT_VERSION),
        "export-id": input.exportId,
      });
      return {
        exportId: input.exportId,
        mode: input.mode,
        bundleKey,
        counts,
        catalogBytes: digest.size,
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  async inspect(bundleKey: string, transferKey?: Buffer): Promise<KnowledgeImportInspection> {
    return this.withVerifiedCatalog(bundleKey, transferKey, async ({ manifest, catalogPath }) => {
      return this.inspectCatalog(bundleKey, manifest, catalogPath);
    });
  }

  async import(
    bundleKey: string,
    acceptConsents: boolean,
    transferKey?: Buffer,
  ): Promise<KnowledgeImportInspection & {
    imported: {
      events: number;
      knowledge: number;
      synthesisRuns: number;
      interventions: number;
      projectLinks: number;
      consents: number;
      unknownAuthors: number;
      objects: number;
      blocks: number;
      chunks: number;
    };
  }> {
    return this.withVerifiedCatalog(bundleKey, transferKey, async ({ manifest, catalogPath, work }) => {
      const inspection = await this.inspectCatalog(bundleKey, manifest, catalogPath);
      if (!inspection.ready) throw new Error("knowledge bundle dry-run has blocking conflicts or missing objects");
      if (inspection.grantedConsents > 0 && !acceptConsents) {
        throw new Error("imported consent records require explicit acceptance");
      }
      const master = transferKey ?? parseTransferKey(this.config.knowledgeTransferKeyPath);
      const objectKey = deriveKey(master, manifest.exportId, "summing-team-space-object-v2");
      await this.importObjects(catalogPath, manifest.mode, objectKey, work);
      const locallyRevoked = manifest.sources.flatMap((source) =>
        this.core.listConsents(source.id)
          .filter((consent) => consent.status === "revoked")
          .map((consent) => ({ sourceId: source.id, telegramUserId: consent.telegramUserId }))
      );
      const stateResult = this.state.importKnowledgeCatalog(catalogPath, this.administratorUserId);
      const coreResult = this.core.importKnowledgeCatalog(catalogPath, {
        acceptConsents,
        objectStoreBackend: this.objectStore.backend,
        objectPrefix: this.config.s3Prefix,
        embeddingModel: this.config.embeddingModel,
        embeddingDimensions: this.config.embeddingDimensions,
      });
      const spaceId = manifest.space.id;
      for (const revoked of locallyRevoked) {
        const affectedKnowledge = this.state.teamKnowledgeForIdentity(
          spaceId,
          "telegram",
          String(revoked.telegramUserId),
          10_000,
        );
        this.state.forgetTeamIdentity(spaceId, "telegram", String(revoked.telegramUserId));
        for (const knowledge of affectedKnowledge) this.core.removeKnowledgeIndex(knowledge.id);
        const removal = this.core.revokeAuthorContent(revoked.sourceId, revoked.telegramUserId);
        for (const object of removal.removed) await this.objectStore.delete(object.objectKey);
      }
      for (const source of manifest.sources) {
        this.core.recordImportedKnowledgeSource({
          sourceId: source.id,
          telegramChatId: source.telegramChatId,
          title: source.title,
          checkpoint: source.checkpoint,
        });
      }
      return {
        ...inspection,
        imported: { ...stateResult, ...coreResult },
      };
    });
  }

  private createWorkDirectory(exportId: string): string {
    const root = resolve(this.config.spoolRoot, "transfers");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return mkdtempSync(join(root, `${basename(exportId)}-`));
  }

  private assertSpoolBudget(paths: string[]): void {
    const bytes = paths.reduce((total, path) => total + statSync(path).size, 0);
    if (bytes > this.config.spoolMaximumBytes) {
      throw new Error(`knowledge transfer needs ${bytes} bytes, exceeding spool limit`);
    }
  }

  private assertWorkBudget(work: string, additionalBytes = 0): void {
    const bytes = directoryBytes(work) + additionalBytes;
    if (bytes > this.config.spoolMaximumBytes) {
      throw new Error(`knowledge transfer needs ${bytes} bytes, exceeding spool limit`);
    }
  }

  private buildCatalog(input: {
    catalogPath: string;
    stateBackup: string;
    coreBackup: string;
    spaceId: string;
    exportId: string;
    mode: KnowledgeTransferMode;
    sources: TransferManifest["sources"];
    includeEmbeddings: boolean;
  }): void {
    const db = new DatabaseSync(input.catalogPath);
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL");
    db.prepare("ATTACH DATABASE ? AS state_snapshot").run(input.stateBackup);
    db.prepare("ATTACH DATABASE ? AS core_snapshot").run(input.coreBackup);
    const create = (sql: string, ...values: SQLInputValue[]): void => {
      db.prepare(sql).run(...values);
    };
    try {
      db.exec(`CREATE TABLE kb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      const meta = db.prepare("INSERT INTO kb_meta(key, value) VALUES (?, ?)");
      for (const [key, value] of Object.entries({
        format: FORMAT,
        version: String(FORMAT_VERSION),
        export_id: input.exportId,
        mode: input.mode,
        space_id: input.spaceId,
        source_ids: JSON.stringify(input.sources.map((source) => source.id)),
        embedding_model: this.config.embeddingModel,
        embedding_dimensions: String(this.config.embeddingDimensions),
      })) meta.run(key, value);

      db.exec(`CREATE TABLE kb_source_descriptors (
        source_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        telegram_chat_id INTEGER NOT NULL,
        external_thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL
      )`);
      const insertSourceDescriptor = db.prepare(`
        INSERT INTO kb_source_descriptors
          (source_id, provider, telegram_chat_id, external_thread_id, title, checkpoint_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const source of input.sources) {
        insertSourceDescriptor.run(
          source.id,
          source.provider,
          source.telegramChatId,
          source.externalThreadId,
          source.title,
          JSON.stringify(source.checkpoint),
        );
      }

      create(`CREATE TABLE kb_team_spaces AS
        SELECT * FROM state_snapshot.team_spaces WHERE id = ?`, input.spaceId);
      create(`CREATE TABLE kb_team_sources AS
        SELECT * FROM state_snapshot.team_sources WHERE space_id = ?`, input.spaceId);
      create(`CREATE TABLE kb_team_people AS
        SELECT * FROM state_snapshot.team_people WHERE space_id = ?`, input.spaceId);
      create(`CREATE TABLE kb_team_identities AS
        SELECT * FROM state_snapshot.team_identities WHERE space_id = ?`, input.spaceId);
      create(`CREATE TABLE kb_team_events AS
        SELECT id AS export_event_id, CAST(NULL AS INTEGER) AS target_event_id,
          space_id, source_id, person_id, provider, external_event_id, event_kind,
          sender_external_id, sender_display_name, text, reply_to_external_event_id,
          attachments_json, occurred_at, observed_at, synthesis_state, redacted_at
        FROM state_snapshot.team_events WHERE space_id = ?`, input.spaceId);
      create(`CREATE TABLE kb_team_knowledge AS
        SELECT id AS export_knowledge_id, CAST(NULL AS INTEGER) AS target_knowledge_id,
          space_id, fingerprint, kind, subject, statement, confidence, status,
          visibility, visibility_ref, valid_from, valid_to, created_at, updated_at
        FROM state_snapshot.team_knowledge WHERE space_id = ?`, input.spaceId);
      create(`CREATE TABLE kb_team_knowledge_evidence AS
        SELECT evidence.* FROM state_snapshot.team_knowledge_evidence evidence
        JOIN state_snapshot.team_knowledge knowledge ON knowledge.id = evidence.knowledge_id
        WHERE knowledge.space_id = ?`, input.spaceId);
      create(`CREATE TABLE kb_team_knowledge_supersessions AS
        SELECT links.* FROM state_snapshot.team_knowledge_supersessions links
        JOIN state_snapshot.team_knowledge knowledge ON knowledge.id = links.old_knowledge_id
        WHERE knowledge.space_id = ?`, input.spaceId);
      create(`CREATE TABLE kb_team_synthesis_runs AS
        SELECT runs.id AS export_synthesis_id, runs.space_id, runs.status,
          runs.event_ids_json, runs.response_json, runs.error,
          runs.started_at, runs.completed_at
        FROM state_snapshot.team_synthesis_runs runs WHERE runs.space_id = ?`, input.spaceId);
      create(`CREATE TABLE kb_team_interventions AS
        SELECT interventions.* FROM state_snapshot.team_interventions interventions
        WHERE interventions.space_id = ?`, input.spaceId);
      create(`CREATE TABLE kb_team_space_projects AS
        SELECT links.* FROM state_snapshot.team_space_projects links
        WHERE links.space_id = ?`, input.spaceId);

      create(`CREATE TABLE kb_team_consents AS
        SELECT consents.* FROM core_snapshot.team_consents consents
        JOIN kb_team_sources sources ON sources.id = consents.source_id`);
      create(`CREATE TABLE kb_team_event_revisions AS
        SELECT revisions.* FROM core_snapshot.team_event_revisions revisions
        JOIN kb_team_sources sources ON sources.id = revisions.source_id`);
      create(`CREATE TABLE kb_content_object_refs AS
        SELECT refs.* FROM core_snapshot.content_object_refs refs
        JOIN kb_team_sources sources ON sources.id = refs.source_id`);
      create(`CREATE TABLE kb_content_objects AS
        SELECT objects.*, objects.object_key AS original_object_key,
          '' AS transfer_object_key, '' AS transfer_iv, '' AS transfer_tag,
          '' AS transfer_sha256
        FROM core_snapshot.content_objects objects
        WHERE EXISTS (SELECT 1 FROM core_snapshot.content_object_refs refs
          JOIN kb_team_sources sources ON sources.id = refs.source_id
          WHERE refs.sha256 = objects.sha256)`);
      create(`CREATE TABLE kb_document_blocks AS
        SELECT blocks.id AS export_block_id, CAST(NULL AS INTEGER) AS target_block_id,
          blocks.object_hash, blocks.source_id, blocks.block_kind, blocks.ordinal,
          blocks.text, blocks.locator_json, blocks.structure_json, blocks.created_at
        FROM core_snapshot.document_blocks blocks
        JOIN kb_team_sources sources ON sources.id = blocks.source_id
        WHERE EXISTS (SELECT 1 FROM kb_content_objects objects
          WHERE objects.sha256 = blocks.object_hash)`);
      create(`CREATE TABLE kb_search_chunks AS
        SELECT chunks.id AS export_chunk_id, CAST(NULL AS INTEGER) AS target_chunk_id,
          chunks.source_id, chunks.normalized_hash, chunks.text, chunks.block_ids_json,
          chunks.metadata_json, chunks.created_at
        FROM core_snapshot.search_chunks chunks
        JOIN kb_team_sources sources ON sources.id = chunks.source_id`);
      create(`CREATE TABLE kb_search_chunk_blocks AS
        SELECT links.* FROM core_snapshot.search_chunk_blocks links
        JOIN kb_search_chunks chunks ON chunks.export_chunk_id = links.chunk_id
        JOIN kb_document_blocks blocks ON blocks.export_block_id = links.block_id`);
      create(`CREATE TABLE kb_chunk_embeddings AS
        SELECT embeddings.* FROM core_snapshot.chunk_embeddings embeddings
        JOIN kb_search_chunks chunks ON chunks.export_chunk_id = embeddings.chunk_id
        WHERE ? = 1`, input.includeEmbeddings ? 1 : 0);
      create(`CREATE TABLE kb_semantic_embeddings AS
        SELECT embeddings.* FROM core_snapshot.semantic_embeddings embeddings
        JOIN kb_team_sources sources ON sources.id = embeddings.source_id
        WHERE ? = 1`, input.includeEmbeddings ? 1 : 0);
      create(`CREATE TABLE kb_team_knowledge_evidence_refs AS
        SELECT refs.* FROM core_snapshot.team_knowledge_evidence_refs refs
        JOIN kb_team_knowledge knowledge ON knowledge.export_knowledge_id = refs.knowledge_id`);
      create(`CREATE TABLE kb_team_sync_unknown_authors AS
        SELECT authors.* FROM core_snapshot.team_sync_unknown_authors authors
        JOIN kb_team_sources sources ON sources.id = authors.source_id`);
      db.exec(`
        CREATE INDEX kb_events_identity
          ON kb_team_events(source_id, event_kind, external_event_id);
        CREATE INDEX kb_objects_hash ON kb_content_objects(sha256);
      `);
    } finally {
      db.exec("DETACH DATABASE state_snapshot; DETACH DATABASE core_snapshot");
      db.close();
    }
    chmodSync(input.catalogPath, 0o600);
  }

  private async exportPortableObjects(
    catalogPath: string,
    exportId: string,
    key: Buffer,
    work: string,
  ): Promise<void> {
    const db = new DatabaseSync(catalogPath);
    try {
      const rows = db.prepare(`
        SELECT sha256, original_object_key, size_bytes FROM kb_content_objects ORDER BY sha256
      `).all() as Row[];
      for (const row of rows) {
        const sha256 = String(row.sha256);
        if (Number(row.size_bytes) * 2 > this.config.spoolMaximumBytes) {
          throw new Error(`object ${sha256} exceeds the configured transfer spool limit`);
        }
        this.assertWorkBudget(work, Number(row.size_bytes) * 2);
        const clear = join(work, `${sha256}.clear`);
        const encrypted = join(work, `${sha256}.enc`);
        await this.objectStore.getFile(safeObjectKey(String(row.original_object_key)), clear);
        const clearDigest = await sha256File(clear);
        if (clearDigest.sha256 !== sha256 || clearDigest.size !== Number(row.size_bytes)) {
          throw new Error(`canonical object ${sha256} failed checksum verification`);
        }
        const encryption = await encryptFile(clear, encrypted, key);
        const encryptedDigest = await sha256File(encrypted);
        const objectKey = `${transferRoot(this.config.s3Prefix, exportId)}/objects/${sha256}.enc`;
        await this.objectStore.delete(objectKey);
        await this.objectStore.putFile(objectKey, encrypted, { sha256, format: FORMAT });
        db.prepare(`
          UPDATE kb_content_objects SET transfer_object_key = ?, transfer_iv = ?,
            transfer_tag = ?, transfer_sha256 = ? WHERE sha256 = ?
        `).run(objectKey, encryption.iv, encryption.tag, encryptedDigest.sha256, sha256);
        rmSync(clear, { force: true });
        rmSync(encrypted, { force: true });
      }
    } finally {
      db.close();
    }
  }

  private async verifyManifestObjects(catalogPath: string): Promise<void> {
    const db = new DatabaseSync(catalogPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT original_object_key FROM kb_content_objects").all() as Row[];
      for (const row of rows) {
        if (!await this.objectStore.exists(safeObjectKey(String(row.original_object_key)))) {
          throw new Error(`canonical object ${String(row.original_object_key)} is missing`);
        }
      }
    } finally {
      db.close();
    }
  }

  private catalogCounts(db: DatabaseSync): Record<string, number> {
    return {
      spaces: numberCell(db, "SELECT COUNT(*) AS count FROM kb_team_spaces"),
      sources: numberCell(db, "SELECT COUNT(*) AS count FROM kb_team_sources"),
      people: numberCell(db, "SELECT COUNT(*) AS count FROM kb_team_people"),
      events: numberCell(db, "SELECT COUNT(*) AS count FROM kb_team_events"),
      knowledge: numberCell(db, "SELECT COUNT(*) AS count FROM kb_team_knowledge"),
      synthesisRuns: numberCell(db, "SELECT COUNT(*) AS count FROM kb_team_synthesis_runs"),
      interventions: numberCell(db, "SELECT COUNT(*) AS count FROM kb_team_interventions"),
      projectLinks: numberCell(db, "SELECT COUNT(*) AS count FROM kb_team_space_projects"),
      consents: numberCell(db, "SELECT COUNT(*) AS count FROM kb_team_consents"),
      unknownAuthors: numberCell(db, "SELECT COUNT(*) AS count FROM kb_team_sync_unknown_authors"),
      objects: numberCell(db, "SELECT COUNT(*) AS count FROM kb_content_objects"),
      blocks: numberCell(db, "SELECT COUNT(*) AS count FROM kb_document_blocks"),
      chunks: numberCell(db, "SELECT COUNT(*) AS count FROM kb_search_chunks"),
      embeddings: numberCell(db, "SELECT COUNT(*) AS count FROM kb_semantic_embeddings"),
    };
  }

  private async withVerifiedCatalog<T>(
    bundleKey: string,
    transferKey: Buffer | undefined,
    action: (context: {
      manifest: TransferManifest;
      catalogPath: string;
      work: string;
    }) => Promise<T>,
  ): Promise<T> {
    const safeBundleKey = safeObjectKey(bundleKey);
    const work = this.createWorkDirectory("import");
    try {
      const manifestPath = join(work, "manifest.json");
      await this.objectStore.getFile(safeBundleKey, manifestPath);
      if (statSync(manifestPath).size > 1_000_000) {
        throw new Error("Team Space bundle manifest exceeds 1 MB");
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TransferManifest;
      const master = transferKey ?? parseTransferKey(this.config.knowledgeTransferKeyPath);
      verifyManifest(
        manifest,
        deriveKey(master, manifest.exportId, "summing-team-space-manifest-v2"),
      );
      safeObjectKey(manifest.catalog.key);
      if (!Number.isSafeInteger(manifest.catalog.size) || manifest.catalog.size <= 0 ||
        manifest.catalog.size > this.config.spoolMaximumBytes) {
        throw new Error("knowledge catalog exceeds the configured transfer spool limit");
      }
      const encrypted = join(work, "catalog.sqlite.gz.enc");
      await this.objectStore.getFile(manifest.catalog.key, encrypted);
      this.assertWorkBudget(work);
      const digest = await sha256File(encrypted);
      if (digest.sha256 !== manifest.catalog.sha256 || digest.size !== manifest.catalog.size) {
        throw new Error("knowledge catalog checksum is invalid");
      }
      const compressed = join(work, "catalog.sqlite.gz");
      await decryptFile(
        encrypted,
        compressed,
        deriveKey(master, manifest.exportId, "summing-team-space-catalog-v2"),
        manifest.catalog.iv,
        manifest.catalog.tag,
      );
      this.assertWorkBudget(work);
      const catalogPath = join(work, "catalog.sqlite");
      await pipeline(createReadStream(compressed), createGunzip(), createWriteStream(catalogPath, { mode: 0o600 }));
      this.assertWorkBudget(work);
      const db = new DatabaseSync(catalogPath, { readOnly: true });
      try {
        const check = db.prepare("PRAGMA quick_check").get() as Row;
        if (String(check.quick_check ?? Object.values(check)[0]) !== "ok") {
          throw new Error("knowledge catalog integrity check failed");
        }
        const meta = this.catalogMetaFromDb(db);
        if (
          meta.format !== FORMAT || meta.version !== String(FORMAT_VERSION) ||
          meta.export_id !== manifest.exportId || meta.space_id !== manifest.space.id ||
          meta.source_ids !== JSON.stringify(manifest.sources.map((source) => source.id)) ||
          meta.mode !== manifest.mode
        ) throw new Error("knowledge catalog metadata does not match its manifest");
        const descriptors = new Map((db.prepare(`
          SELECT * FROM kb_source_descriptors
        `).all() as Row[]).map((row) => [String(row.source_id), row]));
        for (const source of manifest.sources) {
          const descriptor = descriptors.get(source.id);
          if (!descriptor || String(descriptor.provider) !== source.provider ||
            Number(descriptor.telegram_chat_id) !== source.telegramChatId ||
            String(descriptor.external_thread_id) !== source.externalThreadId ||
            String(descriptor.title) !== source.title ||
            String(descriptor.checkpoint_json) !== JSON.stringify(source.checkpoint)) {
            throw new Error("Team Space source catalog does not match its manifest");
          }
        }
      } finally {
        db.close();
      }
      return await action({ manifest, catalogPath, work });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  private async inspectCatalog(
    bundleKey: string,
    manifest: TransferManifest,
    catalogPath: string,
  ): Promise<KnowledgeImportInspection> {
    const state = this.state.analyzeKnowledgeCatalog(catalogPath);
    const core = this.core.analyzeKnowledgeCatalog(catalogPath);
    const db = new DatabaseSync(catalogPath, { readOnly: true });
    let missingObjects = 0;
    let grantedConsents = 0;
    let linkedProjectIds: string[] = [];
    let counts: Record<string, number>;
    try {
      counts = this.catalogCounts(db);
      grantedConsents = numberCell(
        db,
        "SELECT COUNT(*) AS count FROM kb_team_consents WHERE status = 'granted'",
      );
      linkedProjectIds = (db.prepare(`
        SELECT project_id FROM kb_team_space_projects ORDER BY project_id
      `).all() as Row[]).map((row) => String(row.project_id));
      const objectColumn = manifest.mode === "portable" ? "transfer_object_key" : "original_object_key";
      const rows = db.prepare(`SELECT ${objectColumn} AS object_key FROM kb_content_objects`).all() as Row[];
      for (const row of rows) {
        const key = safeObjectKey(String(row.object_key));
        if (!await this.objectStore.exists(key)) missingObjects += 1;
      }
    } finally {
      db.close();
    }
    const warnings: string[] = [];
    if (core.consentOverrides > 0) {
      warnings.push(`${core.consentOverrides} imported grants are superseded by local revocations`);
    }
    if (state.existingEvents > 0 || state.existingKnowledge > 0 || core.existingObjects > 0) {
      warnings.push("existing matching records will be reused idempotently");
    }
    if (manifest.mode === "manifest") {
      warnings.push("manifest import depends on source object keys remaining accessible");
    }
    if (linkedProjectIds.length > 0) {
      warnings.push(
        `${linkedProjectIds.length} linked projects must be mapped or provisioned on the target node`,
      );
    }
    const primarySource = manifest.sources[0]!;
    return {
      exportId: manifest.exportId,
      mode: manifest.mode,
      bundleKey,
      spaceId: manifest.space.id,
      sourceId: primarySource.id,
      telegramChatId: primarySource.telegramChatId,
      title: manifest.space.title,
      sources: manifest.sources,
      linkedProjectIds,
      counts,
      grantedConsents,
      missingObjects,
      sourceConflicts: state.sourceConflicts,
      eventConflicts: state.eventConflicts,
      knowledgeConflicts: state.knowledgeConflicts,
      objectConflicts: core.objectConflicts,
      consentOverrides: core.consentOverrides,
      existingEvents: state.existingEvents,
      existingKnowledge: state.existingKnowledge,
      existingObjects: core.existingObjects,
      ready: missingObjects === 0 && state.sourceConflicts === 0 &&
        state.eventConflicts === 0 && state.knowledgeConflicts === 0 &&
        core.objectConflicts === 0,
      warnings,
    };
  }

  private async importObjects(
    catalogPath: string,
    mode: KnowledgeTransferMode,
    key: Buffer,
    work: string,
  ): Promise<void> {
    const db = new DatabaseSync(catalogPath, { readOnly: true });
    try {
      const rows = db.prepare(`
        SELECT sha256, size_bytes, original_object_key, transfer_object_key,
          transfer_iv, transfer_tag, transfer_sha256
        FROM kb_content_objects ORDER BY sha256
      `).all() as Row[];
      for (const row of rows) {
        const sha256 = String(row.sha256);
        const configuredDestinationKey = [
          this.config.s3Prefix.replace(/^\/+|\/+$/g, ""),
          "sha256", sha256.slice(0, 2), sha256,
        ].filter(Boolean).join("/");
        const destinationKey = this.core.contentObject(sha256)?.objectKey ?? configuredDestinationKey;
        const clear = join(work, `${sha256}.import`);
        this.assertWorkBudget(work, Number(row.size_bytes) * 2);
        if (mode === "portable") {
          const encrypted = join(work, `${sha256}.enc`);
          await this.objectStore.getFile(safeObjectKey(String(row.transfer_object_key)), encrypted);
          const encryptedDigest = await sha256File(encrypted);
          if (encryptedDigest.sha256 !== String(row.transfer_sha256)) {
            throw new Error(`portable object ${sha256} failed encrypted checksum verification`);
          }
          await decryptFile(
            encrypted, clear, key, String(row.transfer_iv), String(row.transfer_tag),
          );
          rmSync(encrypted, { force: true });
        } else {
          await this.objectStore.getFile(safeObjectKey(String(row.original_object_key)), clear);
        }
        const clearDigest = await sha256File(clear);
        if (clearDigest.sha256 !== sha256 || clearDigest.size !== Number(row.size_bytes)) {
          throw new Error(`imported object ${sha256} failed checksum verification`);
        }
        if (await this.objectStore.exists(destinationKey)) {
          const existing = join(work, `${sha256}.existing`);
          await this.objectStore.getFile(destinationKey, existing);
          const existingDigest = await sha256File(existing);
          rmSync(existing, { force: true });
          if (existingDigest.sha256 !== sha256 || existingDigest.size !== Number(row.size_bytes)) {
            throw new Error(`destination object ${sha256} is corrupt`);
          }
        } else {
          await this.objectStore.putFile(destinationKey, clear, { sha256, format: FORMAT });
        }
        rmSync(clear, { force: true });
      }
    } finally {
      db.close();
    }
  }

  private catalogMeta(catalogPath: string): Record<string, string> {
    const db = new DatabaseSync(catalogPath, { readOnly: true });
    try { return this.catalogMetaFromDb(db); } finally { db.close(); }
  }

  private catalogMetaFromDb(db: DatabaseSync): Record<string, string> {
    return Object.fromEntries((db.prepare("SELECT key, value FROM kb_meta").all() as Row[])
      .map((row) => [String(row.key), String(row.value)]));
  }

}
