import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ProjectPortalBinding } from "./state-store.js";

const OUTBOX_ID = /^[a-f0-9]{64}$/;
const MAXIMUM_ATTEMPTS = 5;

export type ProjectPortalMessageKind = "text" | "document";
export type ProjectPortalDeliveryStatus = "pending" | "sending" | "sent" | "failed";

export interface ProjectPortalOutboxAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface ProjectPortalOutboxRecord {
  schemaVersion: 1;
  id: string;
  projectId: string;
  workspaceId: string;
  portalId: string;
  chatId: number;
  topicId: number;
  sourceId: string | null;
  kind: ProjectPortalMessageKind;
  text: string;
  replyToEventId: number | null;
  replyToMessageId: number | null;
  attachment: ProjectPortalOutboxAttachment | null;
  payloadDigest: string;
  idempotencyKey: string;
  status: ProjectPortalDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  telegramMessageId: number | null;
  lastError: string;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export class ProjectPortalOutboxError extends Error {}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeFileName(value: string): string {
  const cleaned = basename(value.normalize("NFKC"))
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 180);
  return cleaned || "document";
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function iso(date: Date): string {
  return date.toISOString();
}

export class ProjectPortalOutboxStore {
  readonly root: string;

  constructor(
    dataDir: string,
    readonly maximumAttachmentBytes: number,
    readonly now: () => Date = () => new Date(),
  ) {
    this.root = resolve(dataDir, "project-portal-outbox");
    this.ensureDirectory(this.root);
    this.recoverSending();
  }

  enqueue(input: {
    projectId: string;
    workspaceId: string;
    portal: ProjectPortalBinding;
    text?: string;
    replyToEventId?: number | null;
    replyToMessageId?: number | null;
    attachment?: { fileName: string; mimeType: string; data: Uint8Array } | null;
    idempotencyKey: string;
    createdBy: number;
  }): ProjectPortalOutboxRecord {
    const text = String(input.text ?? "").trim();
    const attachment = input.attachment ?? null;
    if (!text && !attachment) throw new ProjectPortalOutboxError("portal message is empty");
    if (attachment && Array.from(text).length > 900) {
      throw new ProjectPortalOutboxError("document caption is limited to 900 characters");
    }
    if (!attachment && Array.from(text).length > 3_500) {
      throw new ProjectPortalOutboxError("portal text is limited to 3500 characters");
    }
    if (
      !input.idempotencyKey ||
      input.idempotencyKey.length > 200 ||
      !Number.isSafeInteger(input.createdBy) ||
      input.createdBy < 0
    ) {
      throw new ProjectPortalOutboxError("portal message idempotency scope is invalid");
    }
    if (
      input.portal.projectId !== input.projectId ||
      input.portal.workspaceId !== input.workspaceId
    ) {
      throw new ProjectPortalOutboxError("portal is outside the active Project workspace");
    }
    const attachmentData = attachment ? Uint8Array.from(attachment.data) : null;
    if (
      attachmentData &&
      (attachmentData.byteLength <= 0 || attachmentData.byteLength > this.maximumAttachmentBytes)
    ) {
      throw new ProjectPortalOutboxError(
        `portal attachment must contain 1-${this.maximumAttachmentBytes} bytes`,
      );
    }
    const attachmentMetadata: ProjectPortalOutboxAttachment | null = attachmentData && attachment
      ? {
          fileName: safeFileName(attachment.fileName),
          mimeType: String(attachment.mimeType || "application/octet-stream").slice(0, 160),
          size: attachmentData.byteLength,
          sha256: createHash("sha256").update(attachmentData).digest("hex"),
        }
      : null;
    const immutablePayload = {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      portalId: input.portal.portalId,
      chatId: input.portal.chatId,
      topicId: input.portal.topicId,
      sourceId: input.portal.sourceId,
      kind: attachmentMetadata ? "document" as const : "text" as const,
      text,
      replyToEventId: input.replyToEventId ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      attachment: attachmentMetadata,
      idempotencyKey: input.idempotencyKey,
      createdBy: input.createdBy,
    };
    const payloadDigest = digest(immutablePayload);
    const id = digest([
      input.projectId,
      input.workspaceId,
      input.portal.portalId,
      input.idempotencyKey,
    ]);
    const existing = this.get(id);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest) {
        throw new ProjectPortalOutboxError("idempotency key was reused for another portal message");
      }
      return existing;
    }
    const directory = this.directory(id);
    this.ensureDirectory(directory);
    if (attachmentData && attachmentMetadata) {
      writeFileSync(this.attachmentPath(id), attachmentData, {
        flag: "wx",
        mode: 0o600,
      });
    }
    const timestamp = iso(this.now());
    const record: ProjectPortalOutboxRecord = {
      schemaVersion: 1,
      id,
      ...immutablePayload,
      payloadDigest,
      status: "pending",
      attempts: 0,
      nextAttemptAt: timestamp,
      telegramMessageId: null,
      lastError: "",
      createdAt: timestamp,
      updatedAt: timestamp,
      sentAt: null,
    };
    atomicJson(this.recordPath(id), record);
    return record;
  }

  get(id: string): ProjectPortalOutboxRecord | null {
    if (!OUTBOX_ID.test(id)) throw new ProjectPortalOutboxError("invalid portal outbox id");
    const path = this.recordPath(id);
    if (!existsSync(path)) return null;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 64_000) {
      throw new ProjectPortalOutboxError("unsafe portal outbox record");
    }
    const record = JSON.parse(readFileSync(path, "utf8")) as ProjectPortalOutboxRecord;
    if (record.schemaVersion !== 1 || record.id !== id || record.payloadDigest.length !== 64) {
      throw new ProjectPortalOutboxError("invalid portal outbox record");
    }
    return record;
  }

  claimDue(limit = 10): ProjectPortalOutboxRecord[] {
    const now = this.now().getTime();
    const records = this.ids()
      .map((id) => this.get(id))
      .filter((record): record is ProjectPortalOutboxRecord => Boolean(record))
      .filter((record) =>
        ["pending", "failed"].includes(record.status) &&
        record.attempts < MAXIMUM_ATTEMPTS &&
        Date.parse(record.nextAttemptAt) <= now
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, Math.max(1, Math.min(50, limit)));
    return records.map((record) => {
      const claimed: ProjectPortalOutboxRecord = {
        ...record,
        status: "sending",
        attempts: record.attempts + 1,
        updatedAt: iso(this.now()),
      };
      atomicJson(this.recordPath(record.id), claimed);
      return claimed;
    });
  }

  attachmentData(record: ProjectPortalOutboxRecord): Uint8Array | null {
    if (!record.attachment) return null;
    const path = this.attachmentPath(record.id);
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== record.attachment.size) {
        throw new ProjectPortalOutboxError("portal attachment metadata changed before delivery");
      }
      const data = readFileSync(descriptor);
      const actualDigest = createHash("sha256").update(data).digest("hex");
      if (actualDigest !== record.attachment.sha256) {
        throw new ProjectPortalOutboxError("portal attachment integrity check failed");
      }
      return Uint8Array.from(data);
    } finally {
      closeSync(descriptor);
    }
  }

  markSent(id: string, telegramMessageId: number): ProjectPortalOutboxRecord {
    const record = this.required(id);
    if (!Number.isSafeInteger(telegramMessageId) || telegramMessageId <= 0) {
      throw new ProjectPortalOutboxError("invalid Telegram message id");
    }
    const timestamp = iso(this.now());
    const sent: ProjectPortalOutboxRecord = {
      ...record,
      status: "sent",
      telegramMessageId,
      lastError: "",
      updatedAt: timestamp,
      sentAt: timestamp,
    };
    atomicJson(this.recordPath(id), sent);
    const attachmentPath = this.attachmentPath(id);
    if (existsSync(attachmentPath)) {
      try {
        unlinkSync(attachmentPath);
      } catch {
        // The durable sent state must win over best-effort payload cleanup to avoid duplicates.
      }
    }
    return sent;
  }

  markFailed(id: string, error: string): ProjectPortalOutboxRecord {
    const record = this.required(id);
    const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, record.attempts - 1)));
    const nextAttempt = new Date(this.now().getTime() + delaySeconds * 1_000);
    const failed: ProjectPortalOutboxRecord = {
      ...record,
      status: "failed",
      lastError: error.trim().slice(0, 500) || "portal delivery failed",
      nextAttemptAt: iso(nextAttempt),
      updatedAt: iso(this.now()),
    };
    atomicJson(this.recordPath(id), failed);
    return failed;
  }

  nextRetryDelayMilliseconds(): number | null {
    const dates = this.ids()
      .map((id) => this.get(id))
      .filter((record): record is ProjectPortalOutboxRecord => Boolean(record))
      .filter((record) =>
        ["pending", "failed"].includes(record.status) && record.attempts < MAXIMUM_ATTEMPTS
      )
      .map((record) => Date.parse(record.nextAttemptAt))
      .filter(Number.isFinite);
    if (dates.length === 0) return null;
    return Math.max(0, Math.min(...dates) - this.now().getTime());
  }

  private recoverSending(): void {
    for (const id of this.ids()) {
      const record = this.get(id);
      if (!record || record.status !== "sending") continue;
      atomicJson(this.recordPath(id), {
        ...record,
        status: "failed",
        lastError: "SUMMING restarted during portal delivery",
        nextAttemptAt: iso(this.now()),
        updatedAt: iso(this.now()),
      });
    }
  }

  private required(id: string): ProjectPortalOutboxRecord {
    const record = this.get(id);
    if (!record) throw new ProjectPortalOutboxError("portal outbox record was not found");
    return record;
  }

  private ids(): string[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && OUTBOX_ID.test(entry.name))
      .map((entry) => entry.name);
  }

  private directory(id: string): string {
    if (!OUTBOX_ID.test(id)) throw new ProjectPortalOutboxError("invalid portal outbox id");
    return resolve(this.root, id);
  }

  private recordPath(id: string): string {
    return resolve(this.directory(id), "record.json");
  }

  private attachmentPath(id: string): string {
    return resolve(this.directory(id), "attachment.bin");
  }

  private ensureDirectory(path: string): void {
    if (existsSync(path)) {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new ProjectPortalOutboxError(`unsafe portal outbox directory: ${path}`);
      }
      return;
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}
