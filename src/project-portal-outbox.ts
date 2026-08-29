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
import {
  isProjectPortalAttachmentKind,
  isProjectPortalMessageKind,
  projectPortalMaximumArtifactBytes,
  projectPortalMimeTypeAllowed,
  type ProjectPortalMessageKind,
} from "./project-portal-message.js";
import type { ProjectPortalBinding } from "./state-store.js";

export type { ProjectPortalMessageKind } from "./project-portal-message.js";

const OUTBOX_ID = /^[a-f0-9]{64}$/;
const MAXIMUM_ATTEMPTS = 5;
const DEFAULT_MAXIMUM_RECORDS = 1_000;
const DEFAULT_MAXIMUM_QUEUED_ATTACHMENT_BYTES = 250 * 1024 * 1024;
const SENT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const FAILED_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1_000;

export type ProjectPortalDeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "dead-letter"
  | "cancelled";

export interface ProjectPortalOutboxAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface ProjectTopicDestination {
  id: string;
  chatId: number;
  topicId: number;
  sourceId?: string | null;
}

export type ProjectPortalOutboxContext = {
  kind: "runner-report";
  jobId: string;
  scheduleId?: string | null;
} | {
  kind: "result-reply";
  resultId: string;
};

export interface ProjectPortalOutboxRecord {
  schemaVersion: 1;
  id: string;
  projectId: string;
  workspaceId: string;
  portalId: string;
  portalKey?: string;
  transport?: string;
  destinationType?: "binding" | "topic";
  chatId: number;
  topicId: number;
  sourceId: string | null;
  originConversationId?: string | null;
  context?: ProjectPortalOutboxContext | null;
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
  terminalNotifiedAt?: string | null;
  terminalNotificationAttempts?: number;
  terminalNotificationNextAttemptAt?: string | null;
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
    readonly limits: {
      maximumRecords?: number;
      maximumQueuedAttachmentBytes?: number;
    } = {},
  ) {
    this.root = resolve(dataDir, "project-portal-outbox");
    this.ensureDirectory(this.root);
    this.recoverSending();
    this.prune();
  }

  enqueue(input: {
    projectId: string;
    workspaceId: string;
    portal?: ProjectPortalBinding;
    destination?: ProjectTopicDestination;
    text?: string;
    kind?: ProjectPortalMessageKind;
    replyToEventId?: number | null;
    replyToMessageId?: number | null;
    attachment?: { fileName: string; mimeType: string; data: Uint8Array } | null;
    idempotencyKey: string;
    createdBy: number;
    originConversationId?: string | null;
    context?: ProjectPortalOutboxContext | null;
  }): ProjectPortalOutboxRecord {
    const text = String(input.text ?? "").trim();
    const attachment = input.attachment ?? null;
    const kind = input.kind ?? (attachment ? "document" : "text");
    if (!isProjectPortalMessageKind(kind)) {
      throw new ProjectPortalOutboxError("portal message kind is invalid");
    }
    if (!text && !attachment) throw new ProjectPortalOutboxError("portal message is empty");
    if (attachment && Array.from(text).length > 900) {
      throw new ProjectPortalOutboxError("attachment caption is limited to 900 characters");
    }
    if (!attachment && Array.from(text).length > 3_500) {
      throw new ProjectPortalOutboxError("portal text is limited to 3500 characters");
    }
    if (kind === "text" && attachment) {
      throw new ProjectPortalOutboxError("portal text cannot contain an attachment");
    }
    if (isProjectPortalAttachmentKind(kind) && !attachment) {
      throw new ProjectPortalOutboxError("portal attachment message is missing its attachment");
    }
    if (
      isProjectPortalAttachmentKind(kind) &&
      attachment &&
      !projectPortalMimeTypeAllowed(kind, attachment.mimeType)
    ) {
      throw new ProjectPortalOutboxError(`portal ${kind} attachment MIME type is not supported`);
    }
    if (
      !input.idempotencyKey ||
      input.idempotencyKey.length > 200 ||
      !Number.isSafeInteger(input.createdBy) ||
      input.createdBy < 0
    ) {
      throw new ProjectPortalOutboxError("portal message idempotency scope is invalid");
    }
    if (Boolean(input.portal) === Boolean(input.destination)) {
      throw new ProjectPortalOutboxError("exactly one portal or topic destination is required");
    }
    if (
      input.portal && (
        input.portal.projectId !== input.projectId ||
        input.portal.workspaceId !== input.workspaceId
      )
    ) {
      throw new ProjectPortalOutboxError("portal is outside the active Project workspace");
    }
    const route = input.portal
      ? {
          id: input.portal.portalId,
          type: "binding" as const,
          portalKey: input.portal.portalKey,
          transport: input.portal.transport,
          chatId: input.portal.chatId,
          topicId: input.portal.topicId,
          sourceId: input.portal.sourceId,
        }
      : {
          id: String(input.destination!.id),
          type: "topic" as const,
          portalKey: undefined,
          transport: "telegram",
          chatId: input.destination!.chatId,
          topicId: input.destination!.topicId,
          sourceId: input.destination!.sourceId ?? null,
        };
    if (
      !route.id ||
      !Number.isSafeInteger(route.chatId) ||
      route.chatId === 0 ||
      !Number.isSafeInteger(route.topicId) ||
      route.topicId < 0
    ) {
      throw new ProjectPortalOutboxError("topic destination is invalid");
    }
    const attachmentData = attachment ? Uint8Array.from(attachment.data) : null;
    const attachmentLimit = isProjectPortalAttachmentKind(kind)
      ? Math.min(this.maximumAttachmentBytes, projectPortalMaximumArtifactBytes(kind))
      : this.maximumAttachmentBytes;
    if (
      attachmentData &&
      (attachmentData.byteLength <= 0 || attachmentData.byteLength > attachmentLimit)
    ) {
      throw new ProjectPortalOutboxError(
        `portal attachment must contain 1-${attachmentLimit} bytes`,
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
      portalId: route.id,
      chatId: route.chatId,
      topicId: route.topicId,
      sourceId: route.sourceId,
      kind,
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
      route.id,
      input.idempotencyKey,
    ]);
    const existing = this.get(id);
    if (existing) {
      if (existing.payloadDigest !== payloadDigest) {
        throw new ProjectPortalOutboxError("idempotency key was reused for another portal message");
      }
      return existing;
    }
    this.assertCapacity(attachmentData?.byteLength ?? 0);
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
      ...(route.portalKey ? { portalKey: route.portalKey } : {}),
      transport: route.transport,
      destinationType: route.type,
      originConversationId: input.originConversationId ?? null,
      context: input.context ?? null,
      payloadDigest,
      status: "pending",
      attempts: 0,
      nextAttemptAt: timestamp,
      telegramMessageId: null,
      lastError: "",
      createdAt: timestamp,
      updatedAt: timestamp,
      sentAt: null,
      terminalNotifiedAt: null,
      terminalNotificationAttempts: 0,
      terminalNotificationNextAttemptAt: null,
    };
    atomicJson(this.recordPath(id), record);
    return record;
  }

  enqueueTopic(input: {
    projectId: string;
    workspaceId: string;
    destination: ProjectTopicDestination;
    text?: string;
    kind?: ProjectPortalMessageKind;
    replyToEventId?: number | null;
    replyToMessageId?: number | null;
    attachment?: { fileName: string; mimeType: string; data: Uint8Array } | null;
    idempotencyKey: string;
    createdBy: number;
    originConversationId?: string | null;
    context?: ProjectPortalOutboxContext | null;
  }): ProjectPortalOutboxRecord {
    return this.enqueue(input);
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
    if (
      record.schemaVersion !== 1 ||
      record.id !== id ||
      !OUTBOX_ID.test(String(record.payloadDigest ?? "")) ||
      !isProjectPortalMessageKind(String(record.kind ?? "")) ||
      !this.validStatus(record.status)
    ) {
      throw new ProjectPortalOutboxError("invalid portal outbox record");
    }
    const destinationType = record.destinationType || "binding";
    return {
      ...record,
      ...(destinationType === "binding" ? { portalKey: record.portalKey || "main" } : {}),
      transport: record.transport || "telegram",
      destinationType,
      originConversationId: record.originConversationId ?? null,
      context: record.context ?? null,
      terminalNotifiedAt: record.terminalNotifiedAt ?? null,
      terminalNotificationAttempts: record.terminalNotificationAttempts ?? 0,
      terminalNotificationNextAttemptAt: record.terminalNotificationNextAttemptAt ?? null,
    };
  }

  list(input: {
    projectId?: string;
    workspaceId?: string;
    statuses?: ProjectPortalDeliveryStatus[];
    limit?: number;
  } = {}): ProjectPortalOutboxRecord[] {
    const statuses = input.statuses?.length ? new Set(input.statuses) : null;
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
    return this.records()
      .filter((record) => !input.projectId || record.projectId === input.projectId)
      .filter((record) => !input.workspaceId || record.workspaceId === input.workspaceId)
      .filter((record) => !statuses || statuses.has(record.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  sentToTelegramMessage(
    chatId: number,
    topicId: number,
    telegramMessageId: number,
  ): ProjectPortalOutboxRecord | null {
    return this.records().find((record) =>
      record.status === "sent" &&
      record.chatId === chatId &&
      record.topicId === topicId &&
      record.telegramMessageId === telegramMessageId
    ) ?? null;
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

  markFailed(
    id: string,
    error: string,
    options: { permanent?: boolean } = {},
  ): ProjectPortalOutboxRecord {
    const record = this.required(id);
    const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, record.attempts - 1)));
    const nextAttempt = new Date(this.now().getTime() + delaySeconds * 1_000);
    const failed: ProjectPortalOutboxRecord = {
      ...record,
      status: options.permanent || record.attempts >= MAXIMUM_ATTEMPTS
        ? "dead-letter"
        : "failed",
      lastError: error.trim().slice(0, 500) || "portal delivery failed",
      nextAttemptAt: iso(nextAttempt),
      updatedAt: iso(this.now()),
      ...(options.permanent || record.attempts >= MAXIMUM_ATTEMPTS
        ? { terminalNotificationNextAttemptAt: iso(this.now()) }
        : {}),
    };
    atomicJson(this.recordPath(id), failed);
    return failed;
  }

  markUncertain(id: string, error: string): ProjectPortalOutboxRecord {
    const record = this.required(id);
    const uncertain: ProjectPortalOutboxRecord = {
      ...record,
      status: "uncertain",
      lastError: error.trim().slice(0, 500) || "portal delivery outcome is uncertain",
      updatedAt: iso(this.now()),
      terminalNotificationNextAttemptAt: iso(this.now()),
    };
    atomicJson(this.recordPath(id), uncertain);
    return uncertain;
  }

  retry(id: string): ProjectPortalOutboxRecord {
    const record = this.required(id);
    if (!["failed", "uncertain", "dead-letter"].includes(record.status)) {
      throw new ProjectPortalOutboxError(`portal delivery in ${record.status} state cannot be retried`);
    }
    if (record.attachment && !existsSync(this.attachmentPath(id))) {
      throw new ProjectPortalOutboxError("portal attachment is no longer available for retry");
    }
    const timestamp = iso(this.now());
    const pending: ProjectPortalOutboxRecord = {
      ...record,
      status: "pending",
      attempts: 0,
      nextAttemptAt: timestamp,
      lastError: "",
      updatedAt: timestamp,
      terminalNotifiedAt: null,
      terminalNotificationAttempts: 0,
      terminalNotificationNextAttemptAt: null,
    };
    atomicJson(this.recordPath(id), pending);
    return pending;
  }

  cancel(id: string): ProjectPortalOutboxRecord {
    const record = this.required(id);
    if (["sent", "cancelled"].includes(record.status)) return record;
    if (record.status === "sending") {
      throw new ProjectPortalOutboxError("a sending portal delivery cannot be cancelled safely");
    }
    const cancelled: ProjectPortalOutboxRecord = {
      ...record,
      status: "cancelled",
      lastError: "cancelled by administrator",
      updatedAt: iso(this.now()),
    };
    atomicJson(this.recordPath(id), cancelled);
    this.removeAttachment(id);
    return cancelled;
  }

  notificationDue(limit = 20): ProjectPortalOutboxRecord[] {
    return this.records()
      .filter((record) =>
        ["uncertain", "dead-letter"].includes(record.status) &&
        !record.terminalNotifiedAt &&
        Boolean(record.originConversationId) &&
        Date.parse(record.terminalNotificationNextAttemptAt ?? record.updatedAt) <= this.now().getTime()
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, Math.max(1, Math.min(50, limit)));
  }

  markNotified(id: string): ProjectPortalOutboxRecord {
    const record = this.required(id);
    const notified = {
      ...record,
      terminalNotifiedAt: iso(this.now()),
      terminalNotificationNextAttemptAt: null,
      updatedAt: iso(this.now()),
    };
    atomicJson(this.recordPath(id), notified);
    return notified;
  }

  markNotificationFailed(id: string): ProjectPortalOutboxRecord {
    const record = this.required(id);
    const attempts = (record.terminalNotificationAttempts ?? 0) + 1;
    const delaySeconds = Math.min(3_600, 15 * (2 ** Math.min(8, attempts - 1)));
    const failed = {
      ...record,
      terminalNotificationAttempts: attempts,
      terminalNotificationNextAttemptAt: iso(
        new Date(this.now().getTime() + delaySeconds * 1_000),
      ),
      updatedAt: iso(this.now()),
    };
    atomicJson(this.recordPath(id), failed);
    return failed;
  }

  prune(): number {
    const now = this.now().getTime();
    let removed = 0;
    for (const id of this.ids()) {
      let record: ProjectPortalOutboxRecord | null;
      try {
        record = this.get(id);
      } catch {
        continue;
      }
      if (!record) {
        rmSync(this.directory(id), { recursive: true, force: true });
        removed += 1;
        continue;
      }
      const age = now - Date.parse(record.sentAt ?? record.createdAt);
      const expired =
        (["sent", "cancelled"].includes(record.status) && age >= SENT_RETENTION_MILLISECONDS) ||
        (["dead-letter", "uncertain"].includes(record.status) && age >= FAILED_RETENTION_MILLISECONDS);
      if (!expired) continue;
      rmSync(this.directory(id), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  nextRetryDelayMilliseconds(): number | null {
    const records = this.records();
    const dates = records
      .filter((record) =>
        ["pending", "failed"].includes(record.status) && record.attempts < MAXIMUM_ATTEMPTS
      )
      .map((record) => Date.parse(record.nextAttemptAt))
      .filter(Number.isFinite);
    dates.push(...records
      .filter((record) =>
        ["uncertain", "dead-letter"].includes(record.status) &&
        !record.terminalNotifiedAt &&
        Boolean(record.originConversationId) &&
        Boolean(record.terminalNotificationNextAttemptAt)
      )
      .map((record) => Date.parse(record.terminalNotificationNextAttemptAt!))
      .filter(Number.isFinite));
    if (dates.length === 0) return null;
    return Math.max(0, Math.min(...dates) - this.now().getTime());
  }

  private recoverSending(): void {
    for (const id of this.ids()) {
      const record = this.get(id);
      if (!record || record.status !== "sending") continue;
      atomicJson(this.recordPath(id), {
        ...record,
        status: "uncertain",
        lastError: "SUMMING restarted while Telegram delivery was in flight; manual review required",
        updatedAt: iso(this.now()),
        terminalNotificationNextAttemptAt: iso(this.now()),
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

  private records(): ProjectPortalOutboxRecord[] {
    const records: ProjectPortalOutboxRecord[] = [];
    for (const id of this.ids()) {
      try {
        const record = this.get(id);
        if (record) records.push(record);
      } catch {
        // One corrupt entry must not disable delivery or the administrator control plane.
      }
    }
    return records;
  }

  private assertCapacity(incomingAttachmentBytes: number): void {
    const records = this.records();
    const active = records.filter((record) =>
      ["pending", "sending", "failed", "uncertain", "dead-letter"].includes(record.status)
    );
    const maximumRecords = Math.max(1, this.limits.maximumRecords ?? DEFAULT_MAXIMUM_RECORDS);
    if (active.length >= maximumRecords) {
      throw new ProjectPortalOutboxError(`portal outbox is full (${maximumRecords} records)`);
    }
    const queuedAttachmentBytes = active.reduce((sum, record) => {
      return sum + (record.attachment && existsSync(this.attachmentPath(record.id))
        ? record.attachment.size
        : 0);
    }, 0);
    const maximumBytes = Math.max(
      this.maximumAttachmentBytes,
      this.limits.maximumQueuedAttachmentBytes ?? DEFAULT_MAXIMUM_QUEUED_ATTACHMENT_BYTES,
    );
    if (queuedAttachmentBytes + incomingAttachmentBytes > maximumBytes) {
      throw new ProjectPortalOutboxError(`portal outbox attachment quota is ${maximumBytes} bytes`);
    }
  }

  private removeAttachment(id: string): void {
    const path = this.attachmentPath(id);
    if (!existsSync(path)) return;
    try {
      unlinkSync(path);
    } catch {
      // Retention and quota checks remain conservative if best-effort cleanup fails.
    }
  }

  private validStatus(value: unknown): value is ProjectPortalDeliveryStatus {
    return [
      "pending",
      "sending",
      "sent",
      "failed",
      "uncertain",
      "dead-letter",
      "cancelled",
    ].includes(String(value));
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
