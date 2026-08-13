import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IntegrationAuthType } from "./integration-manifest.js";

type Row = Record<string, string | number | bigint | null>;

export type SecretCredentials = Record<string, string | number>;
export type ConnectionStatus = "connected" | "revoked";
export type RawGrant = "once" | "project";

export interface ConnectionSummary {
  id: string;
  projectId: string;
  integrationId: string;
  environment: string;
  provider: string;
  auth: IntegrationAuthType;
  scopes: string[];
  status: ConnectionStatus;
  version: number;
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  fingerprint: string;
  rawGrant: RawGrant | null;
}

export interface StoredConnection {
  summary: ConnectionSummary;
  credentials: SecretCredentials;
}

export interface PutConnectionInput {
  projectId: string;
  integrationId: string;
  environment: string;
  provider: string;
  auth: IntegrationAuthType;
  scopes: string[];
  createdBy: number;
  expiresAt?: number | null;
  fingerprint?: string;
  rawGrant?: RawGrant | null;
}

interface Envelope {
  version: 1;
  wrappedKey: { iv: string; tag: string; ciphertext: string };
  payload: { iv: string; tag: string; ciphertext: string };
}

export class SecretVaultError extends Error {}

function aesEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): {
  iv: string;
  tag: string;
  ciphertext: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function aesDecrypt(
  key: Buffer,
  value: { iv: string; tag: string; ciphertext: string },
  aad: Buffer,
): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64url")),
      decipher.final(),
    ]);
  } catch {
    throw new SecretVaultError("stored credential authentication failed");
  }
}

function validateCredentials(value: unknown): SecretCredentials {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SecretVaultError("credentials must be an object");
  }
  const result: SecretCredentials = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
      throw new SecretVaultError(`credential name '${name}' is invalid`);
    }
    if (typeof raw === "string") {
      if (!raw || raw.length > 262_144) throw new SecretVaultError(`credential '${name}' is empty or too large`);
      result[name] = raw;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      result[name] = raw;
    } else {
      throw new SecretVaultError(`credential '${name}' must be a string or number`);
    }
  }
  return result;
}

export function decodeMasterKey(value: string | Buffer): Buffer {
  const raw = Buffer.isBuffer(value) ? value.toString("utf8").trim() : value.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else {
    try {
      key = Buffer.from(raw, "base64url");
    } catch {
      throw new SecretVaultError("master key must be 32 bytes encoded as base64url or hex");
    }
  }
  if (key.length !== 32) {
    key.fill(0);
    throw new SecretVaultError("master key must decode to exactly 32 bytes");
  }
  return key;
}

export function readMasterKey(path: string): Buffer {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 4_096 ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new SecretVaultError("master key must be a private regular file no larger than 4 KB");
  }
  return decodeMasterKey(readFileSync(path));
}

export class SecretVault {
  private readonly db: DatabaseSync;
  private readonly masterKey: Buffer;

  constructor(readonly path: string, masterKey: Buffer) {
    if (masterKey.length !== 32) throw new SecretVaultError("master key must be 32 bytes");
    this.masterKey = Buffer.from(masterKey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new SecretVaultError("credential vault must be a regular file");
      }
    }
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;");
    this.createSchema();
  }

  close(): void {
    this.masterKey.fill(0);
    this.db.close();
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
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        integration_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        provider TEXT NOT NULL,
        auth_type TEXT NOT NULL CHECK(auth_type IN ('api_key', 'none', 'oauth2')),
        scopes_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('connected', 'revoked')),
        version INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        expires_at REAL,
        last_used_at REAL,
        fingerprint TEXT NOT NULL DEFAULT '',
        raw_grant TEXT CHECK(raw_grant IN ('once', 'project')),
        envelope_json TEXT,
        UNIQUE(project_id, integration_id, environment)
      );
      CREATE INDEX IF NOT EXISTS connections_project
        ON connections(project_id, environment, integration_id);
      CREATE TABLE IF NOT EXISTS used_tickets (
        jti TEXT PRIMARY KEY,
        expires_at REAL NOT NULL,
        used_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS secret_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        project_id TEXT NOT NULL,
        integration_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        actor_id INTEGER,
        job_id TEXT,
        version INTEGER,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS secret_audit_project
        ON secret_audit(project_id, created_at DESC);
    `);
    const columns = this.db.prepare("PRAGMA table_info(connections)").all() as Row[];
    if (!columns.some((column) => String(column.name) === "raw_grant")) {
      this.db.exec("ALTER TABLE connections ADD COLUMN raw_grant TEXT");
    }
  }

  private aad(input: Pick<PutConnectionInput, "projectId" | "integrationId" | "environment" | "provider" | "auth">): Buffer {
    return Buffer.from(
      `summing:v1:${input.projectId}:${input.integrationId}:${input.environment}:${input.provider}:${input.auth}`,
    );
  }

  private encrypt(input: PutConnectionInput, credentials: SecretCredentials): string {
    const normalized = validateCredentials(credentials);
    const plaintext = Buffer.from(JSON.stringify(normalized));
    const dataKey = randomBytes(32);
    const aad = this.aad(input);
    try {
      const envelope: Envelope = {
        version: 1,
        wrappedKey: aesEncrypt(this.masterKey, dataKey, Buffer.concat([aad, Buffer.from(":key")])),
        payload: aesEncrypt(dataKey, plaintext, Buffer.concat([aad, Buffer.from(":payload")])),
      };
      return JSON.stringify(envelope);
    } finally {
      plaintext.fill(0);
      dataKey.fill(0);
    }
  }

  private decrypt(summary: ConnectionSummary, envelopeJson: string): SecretCredentials {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(envelopeJson) as Envelope;
    } catch {
      throw new SecretVaultError("stored credential envelope is malformed");
    }
    if (envelope.version !== 1 || !envelope.wrappedKey || !envelope.payload) {
      throw new SecretVaultError("stored credential envelope version is unsupported");
    }
    const input: PutConnectionInput = {
      projectId: summary.projectId,
      integrationId: summary.integrationId,
      environment: summary.environment,
      provider: summary.provider,
      auth: summary.auth,
      scopes: summary.scopes,
      createdBy: summary.createdBy,
    };
    const aad = this.aad(input);
    const dataKey = aesDecrypt(
      this.masterKey,
      envelope.wrappedKey,
      Buffer.concat([aad, Buffer.from(":key")]),
    );
    let plaintext: Buffer | null = null;
    try {
      plaintext = aesDecrypt(dataKey, envelope.payload, Buffer.concat([aad, Buffer.from(":payload")]));
      return validateCredentials(JSON.parse(plaintext.toString("utf8")));
    } catch (error) {
      if (error instanceof SecretVaultError) throw error;
      throw new SecretVaultError("stored credentials cannot be decoded");
    } finally {
      dataKey.fill(0);
      plaintext?.fill(0);
    }
  }

  put(input: PutConnectionInput, credentials: SecretCredentials, now = Date.now() / 1_000): ConnectionSummary {
    const envelope = this.encrypt(input, credentials);
    return this.transaction(() => {
      const current = this.db.prepare(`
        SELECT id, version, created_at FROM connections
        WHERE project_id = ? AND integration_id = ? AND environment = ?
      `).get(input.projectId, input.integrationId, input.environment) as Row | undefined;
      const id = current ? String(current.id) : randomUUID();
      const version = current ? Number(current.version) + 1 : 1;
      const createdAt = current ? Number(current.created_at) : now;
      this.db.prepare(`
        INSERT INTO connections
          (id, project_id, integration_id, environment, provider, auth_type, scopes_json,
           status, version, created_by, created_at, updated_at, expires_at, fingerprint,
           raw_grant, envelope_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, integration_id, environment) DO UPDATE SET
          provider = excluded.provider,
          auth_type = excluded.auth_type,
          scopes_json = excluded.scopes_json,
          status = 'connected',
          version = excluded.version,
          created_by = excluded.created_by,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at,
          fingerprint = excluded.fingerprint,
          raw_grant = excluded.raw_grant,
          envelope_json = excluded.envelope_json
      `).run(
        id,
        input.projectId,
        input.integrationId,
        input.environment,
        input.provider,
        input.auth,
        JSON.stringify(input.scopes),
        version,
        input.createdBy,
        createdAt,
        now,
        input.expiresAt ?? null,
        input.fingerprint ?? "",
        input.rawGrant ?? null,
        envelope,
      );
      this.audit("connected", input.projectId, input.integrationId, input.environment, {
        actorId: input.createdBy,
        version,
        detail: { rawGrant: input.rawGrant ?? null },
      }, now);
      return this.getSummary(input.projectId, input.integrationId, input.environment)!;
    });
  }

  revoke(
    projectId: string,
    integrationId: string,
    environment: string,
    actorId: number,
    now = Date.now() / 1_000,
  ): ConnectionSummary {
    return this.transaction(() => {
      const current = this.getSummary(projectId, integrationId, environment);
      if (!current) throw new SecretVaultError("connection not found");
      const version = current.version + 1;
      this.db.prepare(`
        UPDATE connections
        SET status = 'revoked', version = ?, updated_at = ?, expires_at = NULL,
            fingerprint = '', raw_grant = NULL, envelope_json = NULL
        WHERE id = ?
      `).run(version, now, current.id);
      this.audit("revoked", projectId, integrationId, environment, { actorId, version }, now);
      return this.getSummary(projectId, integrationId, environment)!;
    });
  }

  list(projectId: string): ConnectionSummary[] {
    return (this.db.prepare(`
      SELECT * FROM connections WHERE project_id = ? ORDER BY environment, integration_id
    `).all(projectId) as Row[]).map((row) => this.summary(row));
  }

  getSummary(projectId: string, integrationId: string, environment: string): ConnectionSummary | null {
    const row = this.db.prepare(`
      SELECT * FROM connections
      WHERE project_id = ? AND integration_id = ? AND environment = ?
    `).get(projectId, integrationId, environment) as Row | undefined;
    return row ? this.summary(row) : null;
  }

  get(projectId: string, integrationId: string, environment: string): StoredConnection {
    const row = this.db.prepare(`
      SELECT * FROM connections
      WHERE project_id = ? AND integration_id = ? AND environment = ?
    `).get(projectId, integrationId, environment) as Row | undefined;
    if (!row) throw new SecretVaultError("connection not found");
    const summary = this.summary(row);
    if (summary.status !== "connected" || !row.envelope_json) {
      throw new SecretVaultError("connection is revoked");
    }
    return { summary, credentials: this.decrypt(summary, String(row.envelope_json)) };
  }

  markUsed(summary: ConnectionSummary, jobId: string, now = Date.now() / 1_000): void {
    this.transaction(() => {
      this.db.prepare("UPDATE connections SET last_used_at = ? WHERE id = ?").run(now, summary.id);
      this.audit(
        "leased",
        summary.projectId,
        summary.integrationId,
        summary.environment,
        { jobId, version: summary.version },
        now,
      );
    });
  }

  authorizeRaw(
    projectId: string,
    integrationId: string,
    environment: string,
    actorId: number,
    grant: RawGrant,
    now = Date.now() / 1_000,
  ): ConnectionSummary {
    if (!(grant === "once" || grant === "project")) throw new SecretVaultError("invalid raw grant");
    return this.transaction(() => {
      const current = this.getSummary(projectId, integrationId, environment);
      if (!current || current.status !== "connected") {
        throw new SecretVaultError("connected credential is required before raw authorization");
      }
      this.db.prepare(`
        UPDATE connections SET raw_grant = ?, updated_at = ? WHERE id = ?
      `).run(grant, now, current.id);
      this.audit("raw_authorized", projectId, integrationId, environment, {
        actorId,
        version: current.version,
        detail: { grant },
      }, now);
      return this.getSummary(projectId, integrationId, environment)!;
    });
  }

  consumeRawGrant(summary: ConnectionSummary, jobId: string, now = Date.now() / 1_000): void {
    this.transaction(() => {
      const current = this.getSummary(summary.projectId, summary.integrationId, summary.environment);
      if (!current || current.id !== summary.id || current.version !== summary.version || !current.rawGrant) {
        throw new SecretVaultError("raw credential access is not authorized");
      }
      this.db.prepare(`
        UPDATE connections
        SET last_used_at = ?, raw_grant = CASE WHEN raw_grant = 'once' THEN NULL ELSE raw_grant END
        WHERE id = ?
      `).run(now, current.id);
      this.audit(
        "raw_leased",
        current.projectId,
        current.integrationId,
        current.environment,
        { jobId, version: current.version, detail: { grant: current.rawGrant } },
        now,
      );
    });
  }

  consumeTicket(jti: string, expiresAt: number, now = Date.now() / 1_000): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM used_tickets WHERE expires_at < ?").run(now);
      try {
        this.db.prepare(
          "INSERT INTO used_tickets (jti, expires_at, used_at) VALUES (?, ?, ?)",
        ).run(jti, expiresAt, now);
      } catch {
        throw new SecretVaultError("connection ticket was already used");
      }
    });
  }

  private audit(
    eventType: string,
    projectId: string,
    integrationId: string,
    environment: string,
    metadata: { actorId?: number; jobId?: string; version?: number; detail?: unknown },
    now: number,
  ): void {
    this.db.prepare(`
      INSERT INTO secret_audit
        (event_type, project_id, integration_id, environment, actor_id, job_id,
         version, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventType,
      projectId,
      integrationId,
      environment,
      metadata.actorId ?? null,
      metadata.jobId ?? null,
      metadata.version ?? null,
      JSON.stringify(metadata.detail ?? {}),
      now,
    );
  }

  private summary(row: Row): ConnectionSummary {
    let scopes: string[] = [];
    try {
      const value = JSON.parse(String(row.scopes_json));
      if (Array.isArray(value) && value.every((scope) => typeof scope === "string")) scopes = value;
    } catch {
      throw new SecretVaultError("stored connection scopes are malformed");
    }
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      integrationId: String(row.integration_id),
      environment: String(row.environment),
      provider: String(row.provider),
      auth: String(row.auth_type) as IntegrationAuthType,
      scopes,
      status: String(row.status) as ConnectionStatus,
      version: Number(row.version),
      createdBy: Number(row.created_by),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
      fingerprint: String(row.fingerprint),
      rawGrant: row.raw_grant === "once" || row.raw_grant === "project"
        ? row.raw_grant
        : null,
    };
  }
}
