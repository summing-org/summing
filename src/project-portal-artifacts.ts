import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const ARTIFACT_ID = /^[0-9a-f-]{36}$/;
const KEY_BYTES = 32;

export interface ProjectPortalArtifactRecord {
  schemaVersion: 1;
  id: string;
  projectId: string;
  workspaceId: string;
  portalId: string;
  portalKey: string;
  eventId: number;
  telegramMessageId: number;
  providerFileId: string;
  kind: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  iv: string;
  authTag: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface ProjectPortalArtifact extends ProjectPortalArtifactRecord {
  data: Uint8Array;
}

export class ProjectPortalArtifactError extends Error {}

function safeFileName(value: string): string {
  const cleaned = basename(value.normalize("NFKC"))
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 180);
  return cleaned || "telegram-file";
}

function atomicWrite(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(descriptor, data);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, path);
    const directoryDescriptor = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export class ProjectPortalArtifactStore {
  readonly root: string;
  readonly keyPath: string;
  private readonly key: Buffer;

  constructor(
    dataDir: string,
    readonly maximumBytes: number,
    readonly retentionDays: number,
    readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(dataDir, "project-portal-artifacts");
    this.keyPath = resolve(dataDir, "project-portal-artifacts.key");
    this.ensurePrivateDirectory(this.root);
    this.key = this.loadOrCreateKey();
    this.prune();
  }

  store(input: {
    projectId: string;
    workspaceId: string;
    portalId: string;
    portalKey: string;
    eventId: number;
    telegramMessageId: number;
    providerFileId?: string;
    kind: string;
    fileName: string;
    mimeType: string;
    data: Uint8Array;
  }): ProjectPortalArtifactRecord {
    const data = Uint8Array.from(input.data);
    if (data.byteLength <= 0 || data.byteLength > this.maximumBytes) {
      throw new ProjectPortalArtifactError(
        `portal artifact must contain 1-${this.maximumBytes} bytes`,
      );
    }
    if (!Number.isSafeInteger(input.eventId) || input.eventId <= 0) {
      throw new ProjectPortalArtifactError("portal artifact event id is invalid");
    }
    const id = randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const createdAt = this.now();
    const record: ProjectPortalArtifactRecord = {
      schemaVersion: 1,
      id,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      portalId: input.portalId,
      portalKey: input.portalKey,
      eventId: input.eventId,
      telegramMessageId: input.telegramMessageId,
      providerFileId: String(input.providerFileId ?? "").slice(0, 512),
      kind: String(input.kind).slice(0, 40),
      fileName: safeFileName(input.fileName),
      mimeType: String(input.mimeType || "application/octet-stream").slice(0, 160),
      size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      createdAt: createdAt.toISOString(),
      expiresAt: this.retentionDays > 0
        ? new Date(createdAt.getTime() + this.retentionDays * 86_400_000).toISOString()
        : null,
    };
    atomicWrite(this.blobPath(id), encrypted);
    try {
      atomicWrite(this.recordPath(id), `${JSON.stringify(record, null, 2)}\n`);
    } catch (error) {
      rmSync(this.blobPath(id), { force: true });
      throw error;
    }
    return record;
  }

  metadata(id: string): ProjectPortalArtifactRecord | null {
    this.assertId(id);
    const path = this.recordPath(id);
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64_000) {
      throw new ProjectPortalArtifactError("unsafe portal artifact metadata");
    }
    const record = JSON.parse(readFileSync(path, "utf8")) as ProjectPortalArtifactRecord;
    if (
      record.schemaVersion !== 1 ||
      record.id !== id ||
      !/^[a-f0-9]{64}$/.test(String(record.sha256 ?? "")) ||
      !Number.isSafeInteger(record.size) ||
      record.size <= 0 ||
      record.size > this.maximumBytes
    ) {
      throw new ProjectPortalArtifactError("invalid portal artifact metadata");
    }
    return record;
  }

  read(id: string): ProjectPortalArtifact {
    const record = this.metadata(id);
    if (!record) throw new ProjectPortalArtifactError("portal artifact was not found");
    if (record.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime()) {
      this.remove(id);
      throw new ProjectPortalArtifactError("portal artifact retention period has expired");
    }
    const path = this.blobPath(id);
    if (!existsSync(path)) throw new ProjectPortalArtifactError("portal artifact data is missing");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > this.maximumBytes + 32) {
      throw new ProjectPortalArtifactError("unsafe portal artifact data");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(record.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
      const data = Buffer.concat([decipher.update(readFileSync(path)), decipher.final()]);
      if (
        data.byteLength !== record.size ||
        createHash("sha256").update(data).digest("hex") !== record.sha256
      ) {
        throw new Error("digest mismatch");
      }
      return { ...record, data: Uint8Array.from(data) };
    } catch {
      throw new ProjectPortalArtifactError("portal artifact integrity check failed");
    }
  }

  remove(id: string): void {
    this.assertId(id);
    rmSync(this.recordPath(id), { force: true });
    rmSync(this.blobPath(id), { force: true });
  }

  prune(): number {
    let removed = 0;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".bin")) {
        const id = entry.name.slice(0, -4);
        if (ARTIFACT_ID.test(id) && !existsSync(this.recordPath(id))) {
          rmSync(this.blobPath(id), { force: true });
          removed += 1;
        }
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!ARTIFACT_ID.test(id)) continue;
      try {
        const record = this.metadata(id);
        if (record?.expiresAt && Date.parse(record.expiresAt) <= this.now().getTime()) {
          this.remove(id);
          removed += 1;
        }
      } catch {
        // Corrupt records remain available for administrator recovery instead of silent deletion.
      }
    }
    return removed;
  }

  private loadOrCreateKey(): Buffer {
    if (!existsSync(this.keyPath)) atomicWrite(this.keyPath, randomBytes(KEY_BYTES));
    const stat = lstatSync(this.keyPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== KEY_BYTES) {
      throw new ProjectPortalArtifactError("unsafe project portal artifact key");
    }
    chmodSync(this.keyPath, 0o600);
    return readFileSync(this.keyPath);
  }

  private assertId(id: string): void {
    if (!ARTIFACT_ID.test(id)) throw new ProjectPortalArtifactError("invalid portal artifact id");
  }

  private recordPath(id: string): string {
    return resolve(this.root, `${id}.json`);
  }

  private blobPath(id: string): string {
    return resolve(this.root, `${id}.bin`);
  }

  private ensurePrivateDirectory(path: string): void {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ProjectPortalArtifactError(`unsafe portal artifact directory: ${path}`);
      }
    } else {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    chmodSync(path, 0o700);
  }
}
