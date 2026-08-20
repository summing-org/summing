import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

const PLAN_ID = /^[A-Za-z0-9._-]{1,120}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CALLBACK_TOKEN = /^[A-Za-z0-9_-]{20,48}$/;
const MAXIMUM_REQUEST_BYTES = 64_000;
const MAXIMUM_CAPTION_CHARACTERS = 900;
const MAXIMUM_FEEDBACK_CHARACTERS = 4_000;
const MAXIMUM_AUTHORIZED_USERS = 20;

export type RunnerApprovalDecision = "approved" | "rejected";
export type RunnerApprovalStatus =
  | "pending"
  | "awaiting_feedback"
  | "changes_requested"
  | RunnerApprovalDecision;

export interface RunnerApprovalDelivery {
  chatId: number;
  topicId: number;
  authorizedUserIds: number[];
}

export interface RunnerApprovalRequestDocument {
  schemaVersion: 1;
  planId: string;
  digest: string;
  statePath: string;
  reportArtifact: "report.html";
  message: string;
}

export interface RunnerApprovalView {
  projectId: string;
  workspaceId: string;
  jobId: string;
  planId: string;
  digest: string;
  reportArtifact: "report.html";
  message: string;
  callbackToken: string;
  status: RunnerApprovalStatus;
  chatId: number | null;
  topicId: number | null;
  messageId: number | null;
  authorizedUserId: number | null;
  authorizedUserIds: number[];
  decidedBy: number | null;
  decidedAt: string | null;
  feedbackRequestedBy: number | null;
  feedbackRequestedAt: string | null;
  feedbackPromptMessageId: number | null;
  feedbackMessageId: number | null;
  feedbackText: string | null;
  feedbackBy: number | null;
  feedbackAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RunnerApprovalRecord extends RunnerApprovalView {
  schemaVersion: 1;
  statePath: string;
}

interface ApprovalState {
  planId: string;
  digest: string;
  status: string;
  requestMessageId: number | null;
  approvedBy: number | null;
  approvedAt: string | null;
  approvalMessageId: number | null;
  updatedAt: string;
  rejectedBy?: number | null;
  rejectedAt?: string | null;
}

export interface RunnerApprovalEvent {
  planId: string;
  digest: string;
  status: RunnerApprovalDecision | "changes_requested";
  approvedBy: number | null;
  approvedAt: string | null;
  rejectedBy: number | null;
  rejectedAt: string | null;
  changesRequestedBy: number | null;
  changesRequestedAt: string | null;
  feedbackMessageId: number | null;
  feedback: string | null;
  approvalMessageId: number;
}

export class RunnerApprovalError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function positiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new RunnerApprovalError(400, `${field} must be a positive safe integer`);
  }
  return number;
}

function telegramChatId(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number === 0) {
    throw new RunnerApprovalError(400, "chatId must be a non-zero safe integer");
  }
  return number;
}

function telegramTopicId(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new RunnerApprovalError(400, "topicId must be a non-negative safe integer");
  }
  return number;
}

function telegramUserIds(value: unknown, field = "authorizedUserIds"): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_AUTHORIZED_USERS) {
    throw new RunnerApprovalError(400, `${field} must contain 1-${MAXIMUM_AUTHORIZED_USERS} users`);
  }
  const users = value.map((item) => positiveInteger(item, field));
  const unique = [...new Set(users)].sort((left, right) => left - right);
  if (unique.length !== users.length) {
    throw new RunnerApprovalError(400, `${field} must not contain duplicates`);
  }
  return unique;
}

function sameUsers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function jsonObject(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new RunnerApprovalError(409, "approval JSON is malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RunnerApprovalError(409, "approval JSON must contain an object");
  }
  return value as Record<string, unknown>;
}

function safeRelativePath(value: unknown): string {
  const path = String(value ?? "");
  if (!path || path.startsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(path)) {
    throw new RunnerApprovalError(409, "approval statePath must be a safe relative path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RunnerApprovalError(409, "approval statePath must not traverse directories");
  }
  if (segments.at(-1) !== "approval.json") {
    throw new RunnerApprovalError(409, "approval statePath must target approval.json");
  }
  return path;
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

function publicView(record: RunnerApprovalRecord): RunnerApprovalView {
  const { schemaVersion: _schemaVersion, statePath: _statePath, ...view } = record;
  return view;
}

export class RunnerApprovalStore {
  private readonly root: string;

  constructor(dataRoot: string, readonly now: () => Date = () => new Date()) {
    this.root = resolve(dataRoot, "approval-events");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  capture(input: {
    projectId: string;
    workspaceId: string;
    jobId: string;
    projectDataPath: string;
    artifactDirectory: string;
    delivery?: RunnerApprovalDelivery | null;
  }): RunnerApprovalView | null {
    const requestPath = resolve(input.artifactDirectory, "approval-request.json");
    if (!existsSync(requestPath)) return null;
    const requestMetadata = lstatSync(requestPath);
    if (
      !requestMetadata.isFile() ||
      requestMetadata.isSymbolicLink() ||
      requestMetadata.size <= 0 ||
      requestMetadata.size > MAXIMUM_REQUEST_BYTES
    ) {
      throw new RunnerApprovalError(409, "approval-request.json is not a bounded regular file");
    }

    const existing = this.byJob(input.projectId, input.workspaceId, input.jobId);
    if (existing) return existing;

    const raw = jsonObject(requestPath);
    const allowedKeys = new Set([
      "schemaVersion",
      "planId",
      "digest",
      "statePath",
      "reportArtifact",
      "message",
    ]);
    if (raw.schemaVersion !== 1 || Object.keys(raw).some((key) => !allowedKeys.has(key))) {
      throw new RunnerApprovalError(409, "approval request schema is invalid");
    }
    const planId = String(raw.planId ?? "");
    const digest = String(raw.digest ?? "");
    const stateRelativePath = safeRelativePath(raw.statePath);
    const message = String(raw.message ?? "").trim();
    if (!PLAN_ID.test(planId)) throw new RunnerApprovalError(409, "approval planId is invalid");
    if (!DIGEST.test(digest)) throw new RunnerApprovalError(409, "approval digest is invalid");
    if (raw.reportArtifact !== "report.html") {
      throw new RunnerApprovalError(409, "approval reportArtifact must be report.html");
    }
    if (!message || Array.from(message).length > MAXIMUM_CAPTION_CHARACTERS) {
      throw new RunnerApprovalError(409, "approval message must contain 1-900 characters");
    }
    const reportPath = resolve(input.artifactDirectory, "report.html");
    if (!existsSync(reportPath) || !lstatSync(reportPath).isFile() || lstatSync(reportPath).isSymbolicLink()) {
      throw new RunnerApprovalError(409, "approval report.html artifact is missing or unsafe");
    }

    const projectRoot = realpathSync(resolve(input.projectDataPath));
    const stateCandidate = resolve(projectRoot, stateRelativePath);
    if (!stateCandidate.startsWith(`${projectRoot}${sep}`) || !existsSync(stateCandidate)) {
      throw new RunnerApprovalError(409, "approval statePath is outside project data or missing");
    }
    const stateMetadata = lstatSync(stateCandidate);
    if (!stateMetadata.isFile() || stateMetadata.isSymbolicLink()) {
      throw new RunnerApprovalError(409, "approval statePath must be a regular file");
    }
    const statePath = realpathSync(stateCandidate);
    if (!statePath.startsWith(`${projectRoot}${sep}`)) {
      throw new RunnerApprovalError(409, "approval statePath resolves outside project data");
    }
    const state = this.readState(statePath, planId, digest);
    if (state.status !== "pending") {
      throw new RunnerApprovalError(409, "approval request state is not pending");
    }

    const delivery = input.delivery
      ? {
          chatId: telegramChatId(input.delivery.chatId),
          topicId: telegramTopicId(input.delivery.topicId),
          authorizedUserIds: telegramUserIds(input.delivery.authorizedUserIds),
        }
      : null;

    const createdAt = this.now().toISOString();
    const record: RunnerApprovalRecord = {
      schemaVersion: 1,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      planId,
      digest,
      statePath,
      reportArtifact: "report.html",
      message,
      callbackToken: randomBytes(18).toString("base64url"),
      status: "pending",
      chatId: delivery?.chatId ?? null,
      topicId: delivery?.topicId ?? null,
      messageId: null,
      authorizedUserId: delivery?.authorizedUserIds[0] ?? null,
      authorizedUserIds: delivery?.authorizedUserIds ?? [],
      decidedBy: null,
      decidedAt: null,
      feedbackRequestedBy: null,
      feedbackRequestedAt: null,
      feedbackPromptMessageId: null,
      feedbackMessageId: null,
      feedbackText: null,
      feedbackBy: null,
      feedbackAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    atomicJson(this.path(record.callbackToken), record);
    return publicView(record);
  }

  byJob(projectId: string, workspaceId: string, jobId: string): RunnerApprovalView | null {
    for (const entry of readdirSync(this.root)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const record = this.readRecord(resolve(this.root, entry));
        if (
          record.projectId === projectId &&
          record.workspaceId === workspaceId &&
          record.jobId === jobId
        ) return publicView(record);
      } catch {
        // Corrupt evidence remains on disk for operator recovery and is not selected.
      }
    }
    return null;
  }

  bind(
    callbackToken: string,
    input: { chatId: unknown; topicId: unknown; messageId: unknown; authorizedUserIds: unknown },
  ): RunnerApprovalView {
    const record = this.record(callbackToken);
    const chatId = telegramChatId(input.chatId);
    const topicId = telegramTopicId(input.topicId);
    const messageId = positiveInteger(input.messageId, "messageId");
    const authorizedUserIds = telegramUserIds(input.authorizedUserIds);
    if (
      (record.chatId !== null && record.chatId !== chatId) ||
      (record.topicId !== null && record.topicId !== topicId) ||
      (record.authorizedUserIds.length > 0 && !sameUsers(record.authorizedUserIds, authorizedUserIds))
    ) {
      throw new RunnerApprovalError(403, "approval delivery does not match the configured project route");
    }
    if (record.messageId !== null) {
      if (
        record.chatId === chatId &&
        record.topicId === topicId &&
        record.messageId === messageId &&
        sameUsers(record.authorizedUserIds, authorizedUserIds)
      ) return publicView(record);
      throw new RunnerApprovalError(409, "approval request is already bound to another message");
    }
    if (record.status !== "pending") {
      throw new RunnerApprovalError(409, "approval request is no longer pending");
    }
    const state = this.readState(record.statePath, record.planId, record.digest);
    if (state.status !== "pending") {
      throw new RunnerApprovalError(409, "project approval state is no longer pending");
    }
    const updatedAt = this.now().toISOString();
    atomicJson(record.statePath, { ...state, requestMessageId: messageId, updatedAt });
    const bound: RunnerApprovalRecord = {
      ...record,
      chatId,
      topicId,
      messageId,
      authorizedUserId: authorizedUserIds[0]!,
      authorizedUserIds,
      updatedAt,
    };
    atomicJson(this.path(callbackToken), bound);
    return publicView(bound);
  }

  decide(
    callbackToken: string,
    decision: RunnerApprovalDecision,
    input: { chatId: unknown; topicId: unknown; messageId: unknown; userId: unknown },
  ): RunnerApprovalView {
    if (decision !== "approved" && decision !== "rejected") {
      throw new RunnerApprovalError(400, "approval decision is invalid");
    }
    const record = this.record(callbackToken);
    const chatId = telegramChatId(input.chatId);
    const topicId = telegramTopicId(input.topicId);
    const messageId = positiveInteger(input.messageId, "messageId");
    const userId = positiveInteger(input.userId, "userId");
    if (
      record.chatId !== chatId ||
      record.topicId !== topicId ||
      record.messageId !== messageId
    ) {
      throw new RunnerApprovalError(403, "approval callback is not attached to the bound report message");
    }
    if (!record.authorizedUserIds.includes(userId)) {
      throw new RunnerApprovalError(403, "Telegram user is not authorized to decide this plan");
    }
    if (record.status !== "pending") {
      if (record.status === decision && record.decidedBy === userId) {
        this.writeEvent(record);
        return publicView(record);
      }
      throw new RunnerApprovalError(409, `approval request is already ${record.status}`);
    }

    const state = this.readState(record.statePath, record.planId, record.digest);
    const decidedAt = this.now().toISOString();
    if (state.status !== "pending" && state.status !== decision) {
      throw new RunnerApprovalError(409, `project approval state is already ${state.status}`);
    }
    const decided: RunnerApprovalRecord = {
      ...record,
      status: decision,
      decidedBy: userId,
      decidedAt,
      updatedAt: decidedAt,
    };
    this.writeEvent(decided);
    atomicJson(this.path(callbackToken), decided);
    return publicView(decided);
  }

  requestFeedback(
    callbackToken: string,
    input: { chatId: unknown; topicId: unknown; messageId: unknown; userId: unknown },
  ): RunnerApprovalView {
    const record = this.record(callbackToken);
    const userId = this.assertCallbackScope(record, input);
    if (record.status === "awaiting_feedback") {
      if (record.feedbackRequestedBy === userId) return publicView(record);
      throw new RunnerApprovalError(409, "another authorized user is already preparing feedback");
    }
    if (record.status !== "pending") {
      throw new RunnerApprovalError(409, `approval request is already ${record.status}`);
    }
    const state = this.readState(record.statePath, record.planId, record.digest);
    if (state.status !== "pending") {
      throw new RunnerApprovalError(409, `project approval state is already ${state.status}`);
    }
    const requestedAt = this.now().toISOString();
    const awaiting: RunnerApprovalRecord = {
      ...record,
      status: "awaiting_feedback",
      feedbackRequestedBy: userId,
      feedbackRequestedAt: requestedAt,
      updatedAt: requestedAt,
    };
    atomicJson(this.path(callbackToken), awaiting);
    return publicView(awaiting);
  }

  bindFeedbackPrompt(
    callbackToken: string,
    input: {
      chatId: unknown;
      topicId: unknown;
      messageId: unknown;
      userId: unknown;
      promptMessageId: unknown;
    },
  ): RunnerApprovalView {
    const record = this.record(callbackToken);
    const userId = this.assertCallbackScope(record, input);
    const promptMessageId = positiveInteger(input.promptMessageId, "promptMessageId");
    if (record.status !== "awaiting_feedback" || record.feedbackRequestedBy !== userId) {
      throw new RunnerApprovalError(409, "approval request is not waiting for this user's feedback");
    }
    if (record.feedbackPromptMessageId !== null) {
      if (record.feedbackPromptMessageId === promptMessageId) return publicView(record);
      throw new RunnerApprovalError(409, "approval feedback prompt is already bound");
    }
    const updated: RunnerApprovalRecord = {
      ...record,
      feedbackPromptMessageId: promptMessageId,
      updatedAt: this.now().toISOString(),
    };
    atomicJson(this.path(callbackToken), updated);
    return publicView(updated);
  }

  recordFeedback(input: {
    chatId: unknown;
    topicId: unknown;
    replyToMessageId: unknown;
    messageId: unknown;
    userId: unknown;
    text: unknown;
  }): RunnerApprovalView | null {
    const chatId = telegramChatId(input.chatId);
    const topicId = telegramTopicId(input.topicId);
    const replyToMessageId = positiveInteger(input.replyToMessageId, "replyToMessageId");
    const messageId = positiveInteger(input.messageId, "messageId");
    const userId = positiveInteger(input.userId, "userId");
    for (const entry of readdirSync(this.root)) {
      if (!entry.endsWith(".json")) continue;
      let record: RunnerApprovalRecord;
      try {
        record = this.readRecord(resolve(this.root, entry));
      } catch {
        continue;
      }
      if (
        record.chatId !== chatId ||
        record.topicId !== topicId ||
        (record.messageId !== replyToMessageId &&
          record.feedbackPromptMessageId !== replyToMessageId)
      ) continue;
      if (!record.authorizedUserIds.includes(userId)) {
        throw new RunnerApprovalError(403, "Telegram user is not authorized to request changes");
      }
      const text = String(input.text ?? "").trim();
      if (!text || Array.from(text).length > MAXIMUM_FEEDBACK_CHARACTERS) {
        throw new RunnerApprovalError(400, "approval feedback must contain 1-4000 characters");
      }
      if (record.status === "changes_requested") {
        if (record.feedbackMessageId === messageId && record.feedbackBy === userId) {
          this.writeEvent(record);
          return publicView(record);
        }
        throw new RunnerApprovalError(409, "changes were already requested for this plan");
      }
      if (record.status !== "pending" && record.status !== "awaiting_feedback") {
        throw new RunnerApprovalError(409, `approval request is already ${record.status}`);
      }
      const state = this.readState(record.statePath, record.planId, record.digest);
      if (state.status !== "pending") {
        throw new RunnerApprovalError(409, `project approval state is already ${state.status}`);
      }
      const feedbackAt = this.now().toISOString();
      const changed: RunnerApprovalRecord = {
        ...record,
        status: "changes_requested",
        feedbackMessageId: messageId,
        feedbackText: text,
        feedbackBy: userId,
        feedbackAt,
        updatedAt: feedbackAt,
      };
      this.writeEvent(changed);
      atomicJson(this.path(record.callbackToken), changed);
      return publicView(changed);
    }
    return null;
  }

  eventPath(projectId: string, workspaceId: string): string | null {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(projectId) ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(workspaceId)) {
      throw new RunnerApprovalError(400, "approval event scope is invalid");
    }
    const path = resolve(this.root, "delivery", `${projectId}--${workspaceId}.json`);
    return existsSync(path) ? path : null;
  }

  private path(callbackToken: string): string {
    if (!CALLBACK_TOKEN.test(callbackToken)) {
      throw new RunnerApprovalError(400, "approval callback token is invalid");
    }
    return resolve(this.root, `${callbackToken}.json`);
  }

  private record(callbackToken: string): RunnerApprovalRecord {
    const path = this.path(callbackToken);
    if (!existsSync(path)) throw new RunnerApprovalError(404, "approval request was not found");
    return this.readRecord(path);
  }

  private assertCallbackScope(
    record: RunnerApprovalRecord,
    input: { chatId: unknown; topicId: unknown; messageId: unknown; userId: unknown },
  ): number {
    const chatId = telegramChatId(input.chatId);
    const topicId = telegramTopicId(input.topicId);
    const messageId = positiveInteger(input.messageId, "messageId");
    const userId = positiveInteger(input.userId, "userId");
    if (record.chatId !== chatId || record.topicId !== topicId || record.messageId !== messageId) {
      throw new RunnerApprovalError(403, "approval callback is not attached to the bound report message");
    }
    if (!record.authorizedUserIds.includes(userId)) {
      throw new RunnerApprovalError(403, "Telegram user is not authorized to decide this plan");
    }
    return userId;
  }

  private readRecord(path: string): RunnerApprovalRecord {
    const raw = jsonObject(path);
    const statuses = new Set<RunnerApprovalStatus>([
      "pending",
      "awaiting_feedback",
      "changes_requested",
      "approved",
      "rejected",
    ]);
    if (
      raw.schemaVersion !== 1 ||
      !PLAN_ID.test(String(raw.planId ?? "")) ||
      !DIGEST.test(String(raw.digest ?? "")) ||
      !CALLBACK_TOKEN.test(String(raw.callbackToken ?? "")) ||
      !statuses.has(String(raw.status ?? "") as RunnerApprovalStatus)
    ) {
      throw new RunnerApprovalError(409, "stored approval event is malformed");
    }
    const legacyUserId = Number(raw.authorizedUserId ?? 0);
    const authorizedUserIds = Array.isArray(raw.authorizedUserIds) && raw.authorizedUserIds.length > 0
      ? telegramUserIds(raw.authorizedUserIds)
      : Number.isSafeInteger(legacyUserId) && legacyUserId > 0
        ? [legacyUserId]
        : [];
    return {
      ...(raw as unknown as RunnerApprovalRecord),
      authorizedUserId: authorizedUserIds[0] ?? null,
      authorizedUserIds,
      feedbackRequestedBy: Number(raw.feedbackRequestedBy ?? 0) || null,
      feedbackRequestedAt: typeof raw.feedbackRequestedAt === "string" ? raw.feedbackRequestedAt : null,
      feedbackPromptMessageId: Number(raw.feedbackPromptMessageId ?? 0) || null,
      feedbackMessageId: Number(raw.feedbackMessageId ?? 0) || null,
      feedbackText: typeof raw.feedbackText === "string" ? raw.feedbackText : null,
      feedbackBy: Number(raw.feedbackBy ?? 0) || null,
      feedbackAt: typeof raw.feedbackAt === "string" ? raw.feedbackAt : null,
    };
  }

  private readState(path: string, planId: string, digest: string): ApprovalState {
    const raw = jsonObject(path);
    if (
      raw.planId !== planId ||
      raw.digest !== digest ||
      typeof raw.status !== "string" ||
      typeof raw.updatedAt !== "string"
    ) {
      throw new RunnerApprovalError(409, "project approval state does not match planId and digest");
    }
    return raw as unknown as ApprovalState;
  }

  private writeEvent(record: RunnerApprovalRecord): void {
    if (
      record.status !== "approved" &&
      record.status !== "rejected" &&
      record.status !== "changes_requested"
    ) return;
    if (record.messageId === null) {
      throw new RunnerApprovalError(409, "decided approval event is incomplete");
    }
    if (
      (record.status === "approved" || record.status === "rejected") &&
      (record.decidedBy === null || record.decidedAt === null)
    ) {
      throw new RunnerApprovalError(409, "decided approval event is incomplete");
    }
    if (
      record.status === "changes_requested" &&
      (record.feedbackBy === null || record.feedbackAt === null ||
        record.feedbackMessageId === null || record.feedbackText === null)
    ) {
      throw new RunnerApprovalError(409, "approval feedback event is incomplete");
    }
    const event: RunnerApprovalEvent = {
      planId: record.planId,
      digest: record.digest,
      status: record.status,
      approvedBy: record.status === "approved" ? record.decidedBy : null,
      approvedAt: record.status === "approved" ? record.decidedAt : null,
      rejectedBy: record.status === "rejected" ? record.decidedBy : null,
      rejectedAt: record.status === "rejected" ? record.decidedAt : null,
      changesRequestedBy: record.status === "changes_requested" ? record.feedbackBy : null,
      changesRequestedAt: record.status === "changes_requested" ? record.feedbackAt : null,
      feedbackMessageId: record.status === "changes_requested" ? record.feedbackMessageId : null,
      feedback: record.status === "changes_requested" ? record.feedbackText : null,
      approvalMessageId: record.messageId,
    };
    atomicJson(
      resolve(this.root, "delivery", `${record.projectId}--${record.workspaceId}.json`),
      event,
    );
  }
}
