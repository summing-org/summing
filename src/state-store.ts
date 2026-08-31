import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { StoredAttachment } from "./attachment-service.js";

export interface Conversation {
  id: string;
  chatId: number;
  topicId: number;
  projectId: string;
  workspaceId: string;
  role: ConversationRole;
  codexThreadId: string | null;
  codexThreadCapability: string;
  previousCodexThreadId: string | null;
  readOnlyCodexThreadId: string | null;
  activeTurnId: string | null;
  streamMessageId: number | null;
  worktreePath: string | null;
}

export type ConversationRole = "primary" | "observer";
type StoredConversationBindingMode = "project" | "external-readonly";
export type RunAccess = "write" | "read-only";
export type ResponseMode = "direct" | "ambient";

export type RunDeliveryKind = "response" | "document" | "notice";
export type RunDeliveryStatus =
  | "streaming"
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "dead-letter"
  | "cancelled";

export interface RunDelivery {
  id: number;
  runId: number;
  conversationId: string;
  kind: RunDeliveryKind;
  ordinal: number;
  status: RunDeliveryStatus;
  chatId: number;
  topicId: number;
  replyToMessageId: number | null;
  text: string;
  parseMode: "HTML" | "";
  attachmentPath: string;
  fileName: string;
  mimeType: string;
  attachmentSize: number;
  attachmentSha256: string;
  payloadDigest: string;
  telegramMessageId: number | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

export interface RunDeliveryInput {
  kind: RunDeliveryKind;
  ordinal: number;
  chatId: number;
  topicId: number;
  replyToMessageId?: number | null;
  text?: string;
  parseMode?: "HTML" | "";
  attachmentPath?: string;
  fileName?: string;
  mimeType?: string;
  attachmentSize?: number;
  attachmentSha256?: string;
  telegramMessageId?: number | null;
}

export type RunEvidenceFreshness = "current" | "stale" | "unknown";

export interface RunEvidence {
  id: number;
  runId: number;
  itemId: string;
  kind: "command";
  sequence: number;
  command: string;
  commandDigest: string;
  cwd: string;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  outputDigest: string;
  outputExcerpt: string;
  redactionKinds: string[];
  freshness: RunEvidenceFreshness;
  freshnessReason: string;
  scope: "unknown";
  createdAt: number;
  updatedAt: number;
}

export interface RunCommandEvidenceInput {
  itemId: string;
  command: string;
  commandDigest: string;
  cwd: string;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  outputDigest: string;
  outputExcerpt: string;
  redactionKinds: string[];
}

export interface RunReview {
  id: number;
  runId: number;
  conversationId: string;
  sourceThreadId: string;
  reviewThreadId: string;
  turnId: string;
  targetType: "uncommittedChanges";
  delivery: "detached";
  status: string;
  findings: string;
  beforeRevision: string;
  afterRevision: string;
  workspaceChanged: boolean;
  error: string;
  startedAt: number;
  completedAt: number | null;
}

export interface ProjectRunHistory {
  id: number;
  conversationId: string;
  projectId: string;
  workspaceId: string;
  actorUserId: number;
  turnId: string | null;
  status: string;
  access: RunAccess;
  responseMode: ResponseMode;
  requestText: string;
  response: string;
  error: string;
  retryOfRunId: number | null;
  startedAt: number;
  completedAt: number | null;
}

export type ProjectMemoryKind = "fact" | "decision" | "preference" | "constraint" | "note";
export type ProjectMemoryStatus = "active" | "superseded" | "archived";

export interface ProjectMemoryItem {
  id: number;
  projectId: string;
  kind: ProjectMemoryKind;
  status: ProjectMemoryStatus;
  text: string;
  contentDigest: string;
  source: "user" | "codex" | "legacy";
  sourceRunId: number | null;
  createdBy: number;
  supersedesId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectPortalOptions {
  portalKey?: string;
  isDefault?: boolean;
}

export interface AudioTranscript {
  fileName: string;
  text: string;
}

export interface PendingInput {
  id: number;
  conversationId: string;
  telegramMessageId: number;
  text: string;
  mode: "steer" | "followup";
  access: RunAccess;
  senderId: number;
  responseMode: ResponseMode;
  attachments: StoredAttachment[];
  audioTranscript: AudioTranscript | null;
  retryOfRunId: number | null;
  createdAt: number;
}

export interface ManagedProject {
  id: string;
  name: string;
  primaryOwnerId: number;
  ownerIds: number[];
  defaultWorkspaceId: string;
  workspaces: Array<{ id: string; path: string }>;
  createdAt: number;
}

export interface TelegramChatRecord {
  chatId: number;
  type: string;
  title: string;
  username: string;
  isForum: boolean;
  botStatus: string;
  addedByUserId: number | null;
  joinedAt: number | null;
  lastEventJson: string;
  firstSeenAt: number;
  updatedAt: number;
}

export interface TelegramChatObservation {
  chatId: number;
  type: string;
  title: string;
  username?: string;
  isForum?: boolean;
  botStatus?: string;
  addedByUserId?: number;
  joinedAt?: number;
  lastEventJson?: string;
  observedAt?: number;
}

export interface TelegramTopicRecord {
  chatId: number;
  topicId: number;
  name: string;
  firstSeenAt: number;
  updatedAt: number;
}

export interface TelegramReportDestinationMark extends TelegramTopicRecord {
  markedByUserId: number;
  markedAt: number;
}

export interface CustomerChannel {
  id: string;
  chatId: number;
  topicId: number;
  title: string;
  legacyConversationId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResultPublication {
  id: string;
  channelId: string;
  projectId: string;
  workspaceId: string;
  jobId: string;
  scheduleId: string | null;
  outboxId: string;
  reportText: string;
  artifactName: string | null;
  telegramMessageId: number;
  createdAt: number;
}

export type ResultMessageAuthor = "publication" | "customer" | "agent";

export interface ResultDiscussionMessage {
  publicationId: string;
  chatId: number;
  topicId: number;
  telegramMessageId: number;
  author: ResultMessageAuthor;
  senderId: number;
  text: string;
  createdAt: number;
}

export interface ProjectFeedback {
  id: number;
  publicationId: string;
  channelId: string;
  projectId: string;
  workspaceId: string;
  teamEventId: number | null;
  telegramMessageId: number;
  senderId: number;
  text: string;
  status: "new" | "promoted" | "resolved" | "dismissed";
  createdAt: number;
}

export interface TelegramUserObservation {
  userId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  isBot?: boolean;
  languageCode?: string;
  isPremium?: boolean;
  observedAt?: number;
}

export interface TelegramObservedUserRecord {
  userId: number;
  username: string;
  firstName: string;
  lastName: string;
  isBot: boolean;
  languageCode: string;
  isPremium: boolean;
  messageCount: number;
  topicCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export type TeamSpacePhase = "observing" | "orienting" | "active" | "paused";
export type TeamKnowledgeKind =
  | "episode"
  | "fact"
  | "decision"
  | "task"
  | "question"
  | "risk"
  | "term"
  | "person"
  | "hypothesis";
export type TeamKnowledgeStatus = "active" | "resolved" | "superseded" | "needs-review";
export type TeamKnowledgeVisibility = "space" | "source" | "person";

export interface TeamSpace {
  id: string;
  name: string;
  administratorUserId: number;
  phase: TeamSpacePhase;
  summary: string;
  summaryStatus: "active" | "needs-review";
  announcedAt: number | null;
  modelEgressAnnouncedAt: number | null;
  orientedAt: number | null;
  lastInterventionAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TeamSource {
  id: string;
  spaceId: string;
  provider: string;
  externalSpaceId: string;
  externalThreadId: string;
  title: string;
  joinedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectPortalBinding {
  portalId: string;
  portalKey: string;
  isDefault: boolean;
  transport: string;
  projectId: string;
  workspaceId: string;
  chatId: number;
  topicId: number;
  sourceId: string | null;
  title: string;
}

export interface TeamEventAttachment {
  kind: string;
  fileName: string;
  mimeType: string;
  size: number;
  providerFileId?: string;
  artifactId?: string;
  sha256?: string;
}

export interface TeamEventInput {
  provider: string;
  externalSpaceId: string;
  externalThreadId: string;
  spaceName: string;
  sourceTitle: string;
  externalEventId: string;
  eventKind: string;
  senderExternalId: string;
  senderDisplayName: string;
  text: string;
  replyToExternalEventId?: string;
  attachments?: TeamEventAttachment[];
  occurredAt: number;
  observedAt?: number;
  administratorUserId: number;
}

export interface TeamEvent {
  id: number;
  spaceId: string;
  sourceId: string;
  personId: string;
  provider: string;
  externalEventId: string;
  eventKind: string;
  senderExternalId: string;
  senderDisplayName: string;
  text: string;
  replyToExternalEventId: string;
  attachments: TeamEventAttachment[];
  occurredAt: number;
  observedAt: number;
  directClaimedAt: number | null;
  synthesisState: "pending" | "synthesized" | "redacted";
  redactedAt: number | null;
}

export interface TeamKnowledgeInput {
  kind: TeamKnowledgeKind;
  subject: string;
  statement: string;
  confidence: number;
  status: TeamKnowledgeStatus;
  visibility: TeamKnowledgeVisibility;
  visibilityRef: string;
  evidenceEventIds: number[];
  supersedesKnowledgeIds: number[];
  validFrom?: number | null;
  validTo?: number | null;
}

export interface TeamKnowledgeItem extends TeamKnowledgeInput {
  id: number;
  spaceId: string;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamEpisodeParticipant {
  personId: string;
  role: "speaker" | "addressee" | "mentioned";
  intent: string;
  confidence: number;
  evidenceEventIds: number[];
}

export interface TeamConversationEpisode {
  sourceId: string;
  subject: string;
  synopsis: string;
  confidence: number;
  eventIds: number[];
  participants: TeamEpisodeParticipant[];
}

export interface TeamInterventionDecision {
  action: "silent" | "reply";
  replyToEventId: number | null;
  message: string;
  reason: string;
}

export interface TeamUnderstandingResult {
  episode: TeamConversationEpisode;
  summary: string;
  knowledge: TeamKnowledgeInput[];
  orientationReady: boolean;
  orientationMessage: string;
  clarificationQuestions: string[];
  intervention: TeamInterventionDecision;
}

export interface TeamModelEgressUsage {
  weeklyResetsAt: number | null;
  turns: number;
  measuredTurns: number;
  estimatedCreditsMicros: number;
  observedWeeklyPercent: number;
  updatedAt: number;
}

export interface TeamIntervention {
  id: number;
  spaceId: string;
  sourceId: string;
  kind: "admission" | "egress-notice" | "orientation" | "proactive";
  reason: string;
  text: string;
  replyToExternalEventId: string;
  providerMessageId: string;
  createdAt: number;
  sentAt: number | null;
}

export interface SecurityEvent {
  eventType: string;
  chatId: number;
  topicId: number;
  messageId: number;
  senderId: number;
  projectId: string;
  detectors: string[];
  createdAt?: number;
}

type Row = Record<string, string | number | bigint | null>;
const PROJECT_PORTAL_KEY = /^[a-z][a-z0-9_-]{0,47}$/;

export function projectPortalKey(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!PROJECT_PORTAL_KEY.test(normalized)) {
    throw new Error(
      "portalKey must start with a letter and contain 1-48 lowercase letters, digits, _ or -",
    );
  }
  return normalized;
}

function storedAttachments(value: unknown): StoredAttachment[] {
  if (!Array.isArray(value)) return [];
  const attachments: StoredAttachment[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (
      (candidate.kind !== "document" &&
        candidate.kind !== "audio" &&
        candidate.kind !== "image") ||
      typeof candidate.fileName !== "string" ||
      typeof candidate.mimeType !== "string" ||
      typeof candidate.filePath !== "string" ||
      !candidate.fileName ||
      !candidate.filePath ||
      typeof candidate.size !== "number" ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size < 0
    ) {
      continue;
    }
    attachments.push({
      kind: candidate.kind,
      fileName: candidate.fileName,
      mimeType: candidate.mimeType,
      filePath: candidate.filePath,
      size: candidate.size,
    });
  }
  return attachments;
}

function runDeliveryDigest(input: RunDeliveryInput): string {
  return createHash("sha256").update(JSON.stringify({
    kind: input.kind,
    ordinal: input.ordinal,
    chatId: input.chatId,
    topicId: input.topicId,
    replyToMessageId: input.replyToMessageId ?? null,
    text: input.text ?? "",
    parseMode: input.parseMode ?? "",
    attachmentPath: input.attachmentPath ?? "",
    fileName: input.fileName ?? "",
    mimeType: input.mimeType ?? "",
    attachmentSize: input.attachmentSize ?? 0,
    attachmentSha256: input.attachmentSha256 ?? "",
  })).digest("hex");
}

function runDelivery(row: Row): RunDelivery {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    conversationId: String(row.conversation_id),
    kind: String(row.kind) as RunDeliveryKind,
    ordinal: Number(row.ordinal),
    status: String(row.status) as RunDeliveryStatus,
    chatId: Number(row.chat_id),
    topicId: Number(row.topic_id),
    replyToMessageId:
      row.reply_to_message_id === null ? null : Number(row.reply_to_message_id),
    text: String(row.text),
    parseMode: String(row.parse_mode) as RunDelivery["parseMode"],
    attachmentPath: String(row.attachment_path),
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    attachmentSize: Number(row.attachment_size),
    attachmentSha256: String(row.attachment_sha256),
    payloadDigest: String(row.payload_digest),
    telegramMessageId:
      row.telegram_message_id === null ? null : Number(row.telegram_message_id),
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: String(row.last_error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    sentAt: row.sent_at === null ? null : Number(row.sent_at),
  };
}

function runEvidence(row: Row): RunEvidence {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    itemId: String(row.item_id),
    kind: "command",
    sequence: Number(row.sequence),
    command: String(row.command),
    commandDigest: String(row.command_digest),
    cwd: String(row.cwd),
    status: String(row.status),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    outputDigest: String(row.output_digest),
    outputExcerpt: String(row.output_excerpt),
    redactionKinds: JSON.parse(String(row.redaction_kinds_json)) as string[],
    freshness: String(row.freshness) as RunEvidenceFreshness,
    freshnessReason: String(row.freshness_reason),
    scope: "unknown",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function runReview(row: Row): RunReview {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    conversationId: String(row.conversation_id),
    sourceThreadId: String(row.source_thread_id),
    reviewThreadId: String(row.review_thread_id),
    turnId: String(row.turn_id),
    targetType: "uncommittedChanges",
    delivery: "detached",
    status: String(row.status),
    findings: String(row.findings),
    beforeRevision: String(row.before_revision),
    afterRevision: String(row.after_revision),
    workspaceChanged: Number(row.workspace_changed) === 1,
    error: String(row.error),
    startedAt: Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

function projectRunHistory(row: Row): ProjectRunHistory {
  return {
    id: Number(row.id),
    conversationId: String(row.conversation_id),
    projectId: String(row.project_id),
    workspaceId: String(row.workspace_id),
    actorUserId: Number(row.actor_user_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    status: String(row.status),
    access: String(row.access_mode) as RunAccess,
    responseMode: String(row.response_mode) as ResponseMode,
    requestText: String(row.request_text),
    response: String(row.response),
    error: row.error === null ? "" : String(row.error),
    retryOfRunId: row.retry_of_run_id === null ? null : Number(row.retry_of_run_id),
    startedAt: Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

function projectMemoryItem(row: Row): ProjectMemoryItem {
  return {
    id: Number(row.id),
    projectId: String(row.project_id),
    kind: String(row.kind) as ProjectMemoryKind,
    status: String(row.status) as ProjectMemoryStatus,
    text: String(row.text),
    contentDigest: String(row.content_digest),
    source: String(row.source) as ProjectMemoryItem["source"],
    sourceRunId: row.source_run_id === null ? null : Number(row.source_run_id),
    createdBy: Number(row.created_by),
    supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function normalizedProjectMemoryText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized || Array.from(normalized).length > 2_000) {
    throw new Error("project memory text must contain from 1 to 2000 characters");
  }
  return normalized;
}

function legacyProjectMemoryItems(markdown: string): string[] {
  const bullets = markdown.split(/\r?\n/u)
    .map((line) => line.match(/^\s*-\s+(.+)$/u)?.[1]?.trim() ?? "")
    .filter(Boolean)
    .map((line) => line.replace(/^\[(?:memory:)?\d+\]\s*/iu, "").trim())
    .filter(Boolean);
  if (bullets.length > 0) return [...new Set(bullets)];
  return [...new Set(markdown
    .replace(/^# Project memory:[^\n]*$/gimu, "")
    .replace(/<!--[^]*?-->/gu, "")
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.replace(/^#+\s+.*$/gmu, "").trim())
    .filter(Boolean))];
}

function validateRunDeliveryInput(input: RunDeliveryInput): void {
  if (
    !["response", "document", "notice"].includes(input.kind) ||
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 0 ||
    !Number.isSafeInteger(input.chatId) ||
    !Number.isSafeInteger(input.topicId) ||
    (input.replyToMessageId !== undefined &&
      input.replyToMessageId !== null &&
      (!Number.isSafeInteger(input.replyToMessageId) || input.replyToMessageId <= 0)) ||
    (input.telegramMessageId !== undefined &&
      input.telegramMessageId !== null &&
      (!Number.isSafeInteger(input.telegramMessageId) || input.telegramMessageId <= 0))
  ) {
    throw new Error("invalid run delivery destination");
  }
  if (input.kind === "document") {
    if (
      !input.attachmentPath ||
      !input.fileName ||
      !Number.isSafeInteger(input.attachmentSize) ||
      (input.attachmentSize ?? 0) <= 0 ||
      !/^[a-f0-9]{64}$/.test(input.attachmentSha256 ?? "")
    ) {
      throw new Error("invalid run delivery attachment");
    }
  } else if (!(input.text ?? "").trim()) {
    throw new Error("run delivery text is empty");
  }
}

export class StateStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.createSchema();
    this.recoverAfterRestart();
  }

  close(): void {
    this.db.close();
  }

  async backupTo(path: string): Promise<void> {
    await backup(this.db, path);
  }

  analyzeKnowledgeCatalog(catalogPath: string): {
    sourceConflicts: number;
    eventConflicts: number;
    knowledgeConflicts: number;
    existingEvents: number;
    existingKnowledge: number;
  } {
    this.db.prepare("ATTACH DATABASE ? AS kb_import").run(catalogPath);
    try {
      const sourceConflicts = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM kb_import.kb_team_sources incoming
        JOIN team_sources current ON current.id = incoming.id
          OR (current.provider = incoming.provider
            AND current.external_space_id = incoming.external_space_id
            AND current.external_thread_id = incoming.external_thread_id)
        WHERE current.id <> incoming.id OR current.space_id <> incoming.space_id
          OR current.provider <> incoming.provider
          OR current.external_space_id <> incoming.external_space_id
          OR current.external_thread_id <> incoming.external_thread_id
      `).get() as Row;
      const eventConflicts = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM kb_import.kb_team_events incoming
        JOIN team_events current ON current.source_id = incoming.source_id
          AND current.event_kind = incoming.event_kind
          AND current.external_event_id = incoming.external_event_id
        WHERE current.space_id <> incoming.space_id
          OR current.person_id <> incoming.person_id
          OR current.provider <> incoming.provider
          OR current.sender_external_id <> incoming.sender_external_id
          OR current.text <> incoming.text
          OR current.reply_to_external_event_id <> incoming.reply_to_external_event_id
          OR current.attachments_json <> incoming.attachments_json
          OR current.occurred_at <> incoming.occurred_at
          OR current.synthesis_state <> incoming.synthesis_state
          OR COALESCE(current.redacted_at, -1) <> COALESCE(incoming.redacted_at, -1)
      `).get() as Row;
      const existingEvents = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM kb_import.kb_team_events incoming
        JOIN team_events current ON current.source_id = incoming.source_id
          AND current.event_kind = incoming.event_kind
          AND current.external_event_id = incoming.external_event_id
      `).get() as Row;
      const knowledgeConflicts = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM kb_import.kb_team_knowledge incoming
        JOIN team_knowledge current ON current.space_id = incoming.space_id
          AND current.fingerprint = incoming.fingerprint
        WHERE current.kind <> incoming.kind
          OR current.subject <> incoming.subject
          OR current.statement <> incoming.statement
          OR current.visibility <> incoming.visibility
          OR current.visibility_ref <> incoming.visibility_ref
      `).get() as Row;
      const existingKnowledge = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM kb_import.kb_team_knowledge incoming
        JOIN team_knowledge current ON current.space_id = incoming.space_id
          AND current.fingerprint = incoming.fingerprint
      `).get() as Row;
      return {
        sourceConflicts: Number(sourceConflicts.count),
        eventConflicts: Number(eventConflicts.count),
        knowledgeConflicts: Number(knowledgeConflicts.count),
        existingEvents: Number(existingEvents.count),
        existingKnowledge: Number(existingKnowledge.count),
      };
    } finally {
      this.db.exec("DETACH DATABASE kb_import");
    }
  }

  importKnowledgeCatalog(
    catalogPath: string,
    administratorUserId: number,
  ): {
    events: number;
    knowledge: number;
    synthesisRuns: number;
    interventions: number;
    projectLinks: number;
  } {
    this.db.prepare("ATTACH DATABASE ? AS kb_import").run(catalogPath);
    try {
      return this.transaction(() => {
        const importedSpace = this.db.prepare(`
          SELECT * FROM kb_import.kb_team_spaces
        `).get() as Row | undefined;
        if (!importedSpace) throw new Error("Team Space catalog has no space record");
        this.db.prepare(`
          INSERT INTO team_spaces
            (id, name, administrator_user_id, phase, summary, summary_status,
             announced_at, model_egress_announced_at, oriented_at,
             last_intervention_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            administrator_user_id = excluded.administrator_user_id,
            name = CASE WHEN team_spaces.name = '' THEN excluded.name ELSE team_spaces.name END,
            phase = CASE
              WHEN team_spaces.phase = 'observing' THEN excluded.phase
              ELSE team_spaces.phase
            END,
            summary = CASE
              WHEN team_spaces.summary = '' THEN excluded.summary
              ELSE team_spaces.summary
            END,
            summary_status = CASE
              WHEN team_spaces.summary = '' THEN excluded.summary_status
              ELSE team_spaces.summary_status
            END,
            announced_at = COALESCE(team_spaces.announced_at, excluded.announced_at),
            model_egress_announced_at = COALESCE(
              team_spaces.model_egress_announced_at,
              excluded.model_egress_announced_at
            ),
            oriented_at = COALESCE(team_spaces.oriented_at, excluded.oriented_at),
            last_intervention_at = CASE
              WHEN team_spaces.last_intervention_at IS NULL THEN excluded.last_intervention_at
              WHEN excluded.last_intervention_at IS NULL THEN team_spaces.last_intervention_at
              ELSE MAX(team_spaces.last_intervention_at, excluded.last_intervention_at)
            END,
            updated_at = MAX(team_spaces.updated_at, excluded.updated_at)
        `).run(
          importedSpace.id ?? null,
          importedSpace.name ?? null,
          administratorUserId,
          importedSpace.phase ?? null,
          importedSpace.summary ?? null,
          importedSpace.summary_status ?? null,
          importedSpace.announced_at ?? null,
          importedSpace.model_egress_announced_at ?? null,
          importedSpace.oriented_at ?? null,
          importedSpace.last_intervention_at ?? null,
          importedSpace.created_at ?? null,
          importedSpace.updated_at ?? null,
        );
        this.db.exec(`
          INSERT OR IGNORE INTO team_sources
            (id, space_id, provider, external_space_id, external_thread_id, title,
             joined_at, created_at, updated_at)
          SELECT id, space_id, provider, external_space_id, external_thread_id, title,
            joined_at, created_at, updated_at
          FROM kb_import.kb_team_sources;
          INSERT OR IGNORE INTO team_people
            (id, space_id, display_name, created_at, updated_at)
          SELECT id, space_id, display_name, created_at, updated_at
          FROM kb_import.kb_team_people;
          INSERT OR IGNORE INTO team_identities
            (space_id, provider, external_user_id, person_id, display_name,
             observation_enabled, first_seen_at, last_seen_at)
          SELECT space_id, provider, external_user_id, person_id, display_name,
            observation_enabled, first_seen_at, last_seen_at
          FROM kb_import.kb_team_identities;
          INSERT OR IGNORE INTO team_events
            (space_id, source_id, person_id, provider, external_event_id, event_kind,
             sender_external_id, sender_display_name, text, reply_to_external_event_id,
             attachments_json, occurred_at, observed_at, synthesis_state, redacted_at)
          SELECT space_id, source_id, person_id, provider, external_event_id, event_kind,
             sender_external_id, sender_display_name, text, reply_to_external_event_id,
             attachments_json, occurred_at, observed_at, synthesis_state, redacted_at
          FROM kb_import.kb_team_events ORDER BY export_event_id;
          UPDATE kb_import.kb_team_events
          SET target_event_id = (
            SELECT current.id FROM team_events current
            WHERE current.source_id = kb_import.kb_team_events.source_id
              AND current.event_kind = kb_import.kb_team_events.event_kind
              AND current.external_event_id = kb_import.kb_team_events.external_event_id
          );
          INSERT OR IGNORE INTO team_knowledge
            (space_id, fingerprint, kind, subject, statement, confidence, status,
             visibility, visibility_ref, valid_from, valid_to, created_at, updated_at)
          SELECT space_id, fingerprint, kind, subject, statement, confidence, status,
             visibility, visibility_ref, valid_from, valid_to, created_at, updated_at
          FROM kb_import.kb_team_knowledge ORDER BY export_knowledge_id;
          UPDATE kb_import.kb_team_knowledge
          SET target_knowledge_id = (
            SELECT current.id FROM team_knowledge current
            WHERE current.space_id = kb_import.kb_team_knowledge.space_id
              AND current.fingerprint = kb_import.kb_team_knowledge.fingerprint
          );
          INSERT OR IGNORE INTO team_knowledge_evidence (knowledge_id, event_id)
          SELECT knowledge.target_knowledge_id, event.target_event_id
          FROM kb_import.kb_team_knowledge_evidence evidence
          JOIN kb_import.kb_team_knowledge knowledge
            ON knowledge.export_knowledge_id = evidence.knowledge_id
          JOIN kb_import.kb_team_events event
            ON event.export_event_id = evidence.event_id
          WHERE knowledge.target_knowledge_id IS NOT NULL
            AND event.target_event_id IS NOT NULL;
          INSERT OR IGNORE INTO team_knowledge_supersessions
            (old_knowledge_id, new_knowledge_id)
          SELECT old_knowledge.target_knowledge_id, new_knowledge.target_knowledge_id
          FROM kb_import.kb_team_knowledge_supersessions supersession
          JOIN kb_import.kb_team_knowledge old_knowledge
            ON old_knowledge.export_knowledge_id = supersession.old_knowledge_id
          JOIN kb_import.kb_team_knowledge new_knowledge
            ON new_knowledge.export_knowledge_id = supersession.new_knowledge_id
          WHERE old_knowledge.target_knowledge_id IS NOT NULL
            AND new_knowledge.target_knowledge_id IS NOT NULL;
        `);
        const hasPortableState = Boolean(this.db.prepare(`
          SELECT 1 FROM kb_import.sqlite_master
          WHERE type = 'table' AND name = 'kb_team_synthesis_runs'
        `).get());
        let synthesisRunCount = 0;
        let interventionCount = 0;
        let projectLinkCount = 0;
        if (hasPortableState) {
          const eventMap = new Map((this.db.prepare(`
            SELECT export_event_id, target_event_id FROM kb_import.kb_team_events
            WHERE target_event_id IS NOT NULL
          `).all() as Row[]).map((row) => [Number(row.export_event_id), Number(row.target_event_id)]));
          const synthesisRuns = this.db.prepare(`
            SELECT * FROM kb_import.kb_team_synthesis_runs ORDER BY export_synthesis_id
          `).all() as Row[];
          const insertSynthesis = this.db.prepare(`
            INSERT INTO team_synthesis_runs
              (space_id, status, event_ids_json, response_json, error, started_at, completed_at)
            SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM team_synthesis_runs current
              WHERE current.space_id = ? AND current.status = ?
                AND current.started_at = ? AND current.completed_at = ?
            )
          `);
          for (const run of synthesisRuns) {
            let exportedEventIds: unknown = [];
            try { exportedEventIds = JSON.parse(String(run.event_ids_json)); } catch { /* invalid audit input */ }
            const mappedEventIds = Array.isArray(exportedEventIds)
              ? exportedEventIds.map(Number).map((id) => eventMap.get(id)).filter((id) => id !== undefined)
              : [];
            insertSynthesis.run(
              String(run.space_id), String(run.status), JSON.stringify(mappedEventIds),
              String(run.response_json ?? ""), run.error ?? null,
              Number(run.started_at), Number(run.completed_at),
              String(run.space_id), String(run.status),
              Number(run.started_at), Number(run.completed_at),
            );
          }
          this.db.exec(`
            INSERT INTO team_interventions
              (space_id, source_id, kind, reason, text, reply_to_external_event_id,
               provider_message_id, created_at, sent_at)
            SELECT incoming.space_id, incoming.source_id, incoming.kind, incoming.reason,
              incoming.text, incoming.reply_to_external_event_id,
              incoming.provider_message_id, incoming.created_at, incoming.sent_at
            FROM kb_import.kb_team_interventions incoming
            WHERE NOT EXISTS (
              SELECT 1 FROM team_interventions current
              WHERE current.space_id = incoming.space_id
                AND current.source_id = incoming.source_id
                AND current.kind = incoming.kind
                AND current.created_at = incoming.created_at
            );
            INSERT OR IGNORE INTO team_space_projects (space_id, project_id, linked_at)
            SELECT space_id, project_id, linked_at
            FROM kb_import.kb_team_space_projects;
          `);
          synthesisRunCount = synthesisRuns.length;
          interventionCount = Number((this.db.prepare(`
            SELECT COUNT(*) AS count FROM kb_import.kb_team_interventions
          `).get() as Row).count);
          projectLinkCount = Number((this.db.prepare(`
            SELECT COUNT(*) AS count FROM kb_import.kb_team_space_projects
          `).get() as Row).count);
        }
        const events = this.db.prepare(`
          SELECT COUNT(*) AS count FROM kb_import.kb_team_events
          WHERE target_event_id IS NOT NULL
        `).get() as Row;
        const knowledge = this.db.prepare(`
          SELECT COUNT(*) AS count FROM kb_import.kb_team_knowledge
          WHERE target_knowledge_id IS NOT NULL
        `).get() as Row;
        return {
          events: Number(events.count),
          knowledge: Number(knowledge.count),
          synthesisRuns: synthesisRunCount,
          interventions: interventionCount,
          projectLinks: projectLinkCount,
        };
      });
    } finally {
      this.db.exec("DETACH DATABASE kb_import");
    }
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
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          topic_id INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          binding_mode TEXT NOT NULL DEFAULT 'project'
            CHECK(binding_mode IN ('project', 'external-readonly')),
          codex_thread_id TEXT,
          codex_thread_capability TEXT NOT NULL DEFAULT '',
          previous_codex_thread_id TEXT,
          readonly_codex_thread_id TEXT,
          active_turn_id TEXT,
          stream_message_id INTEGER,
          worktree_path TEXT,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          UNIQUE(chat_id, topic_id)
        );
        CREATE TABLE IF NOT EXISTS pending_inputs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          telegram_message_id INTEGER NOT NULL,
          text TEXT NOT NULL,
          mode TEXT NOT NULL CHECK(mode IN ('steer', 'followup')),
          access_mode TEXT NOT NULL DEFAULT 'write' CHECK(access_mode IN ('write', 'read-only')),
          telegram_user_id INTEGER NOT NULL DEFAULT 0,
          response_mode TEXT NOT NULL DEFAULT 'direct'
            CHECK(response_mode IN ('direct', 'ambient')),
          attachments_json TEXT NOT NULL DEFAULT '[]',
          audio_transcript_json TEXT NOT NULL DEFAULT '',
          retry_of_run_id INTEGER REFERENCES runs(id),
          run_id INTEGER,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'consumed')),
          created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pending_inputs_lookup
          ON pending_inputs(conversation_id, mode, state, id);
        CREATE TABLE IF NOT EXISTS project_portal_bindings (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          portal_key TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
          transport TEXT NOT NULL,
          conversation_id TEXT UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
          destination_json TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          UNIQUE(project_id, workspace_id, portal_key)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS project_portal_bindings_default
          ON project_portal_bindings(project_id, workspace_id)
          WHERE is_default = 1;
        CREATE INDEX IF NOT EXISTS project_portal_bindings_project
          ON project_portal_bindings(project_id, workspace_id, portal_key);
        CREATE TABLE IF NOT EXISTS customer_channels (
          id TEXT PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          topic_id INTEGER NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          legacy_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          UNIQUE(chat_id, topic_id)
        );
        CREATE TABLE IF NOT EXISTS result_publications (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES customer_channels(id),
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          schedule_id TEXT,
          outbox_id TEXT NOT NULL UNIQUE,
          report_text TEXT NOT NULL DEFAULT '',
          artifact_name TEXT,
          telegram_message_id INTEGER NOT NULL,
          created_at REAL NOT NULL,
          UNIQUE(channel_id, telegram_message_id)
        );
        CREATE INDEX IF NOT EXISTS result_publications_project
          ON result_publications(project_id, workspace_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS result_discussion_messages (
          publication_id TEXT NOT NULL REFERENCES result_publications(id) ON DELETE CASCADE,
          chat_id INTEGER NOT NULL,
          topic_id INTEGER NOT NULL,
          telegram_message_id INTEGER NOT NULL,
          author TEXT NOT NULL CHECK(author IN ('publication', 'customer', 'agent')),
          sender_id INTEGER NOT NULL DEFAULT 0,
          text TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL,
          PRIMARY KEY(chat_id, topic_id, telegram_message_id)
        );
        CREATE INDEX IF NOT EXISTS result_discussion_publication
          ON result_discussion_messages(publication_id, created_at, telegram_message_id);
        CREATE TABLE IF NOT EXISTS project_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          publication_id TEXT NOT NULL REFERENCES result_publications(id) ON DELETE CASCADE,
          team_event_id INTEGER REFERENCES team_events(id) ON DELETE SET NULL,
          telegram_message_id INTEGER NOT NULL,
          sender_id INTEGER NOT NULL,
          text TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'new'
            CHECK(status IN ('new', 'promoted', 'resolved', 'dismissed')),
          created_at REAL NOT NULL,
          UNIQUE(publication_id, telegram_message_id)
        );
        CREATE INDEX IF NOT EXISTS project_feedback_publication
          ON project_feedback(publication_id, created_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL DEFAULT '',
          workspace_id TEXT NOT NULL DEFAULT '',
          actor_user_id INTEGER NOT NULL DEFAULT 0,
          turn_id TEXT,
          status TEXT NOT NULL,
          access_mode TEXT NOT NULL DEFAULT 'write' CHECK(access_mode IN ('write', 'read-only')),
          response_mode TEXT NOT NULL DEFAULT 'direct'
            CHECK(response_mode IN ('direct', 'ambient')),
          request_text TEXT NOT NULL DEFAULT '',
          prompt TEXT NOT NULL,
          response TEXT NOT NULL DEFAULT '',
          error TEXT,
          retry_of_run_id INTEGER REFERENCES runs(id),
          started_at REAL NOT NULL,
          completed_at REAL
        );
        CREATE TABLE IF NOT EXISTS run_deliveries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('response', 'document', 'notice')),
          ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
          status TEXT NOT NULL CHECK(status IN
            ('streaming', 'pending', 'sending', 'sent', 'failed', 'uncertain',
             'dead-letter', 'cancelled')),
          chat_id INTEGER NOT NULL,
          topic_id INTEGER NOT NULL,
          reply_to_message_id INTEGER,
          text TEXT NOT NULL DEFAULT '',
          parse_mode TEXT NOT NULL DEFAULT '' CHECK(parse_mode IN ('', 'HTML')),
          attachment_path TEXT NOT NULL DEFAULT '',
          file_name TEXT NOT NULL DEFAULT '',
          mime_type TEXT NOT NULL DEFAULT '',
          attachment_size INTEGER NOT NULL DEFAULT 0 CHECK(attachment_size >= 0),
          attachment_sha256 TEXT NOT NULL DEFAULT '',
          payload_digest TEXT NOT NULL,
          telegram_message_id INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
          next_attempt_at REAL NOT NULL,
          last_error TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          sent_at REAL,
          UNIQUE(run_id, kind, ordinal)
        );
        CREATE INDEX IF NOT EXISTS run_deliveries_due
          ON run_deliveries(status, next_attempt_at, id);
        CREATE INDEX IF NOT EXISTS run_deliveries_run
          ON run_deliveries(run_id, ordinal, id);
        CREATE TABLE IF NOT EXISTS run_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          item_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'command' CHECK(kind = 'command'),
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          command TEXT NOT NULL,
          command_digest TEXT NOT NULL,
          cwd TEXT NOT NULL,
          status TEXT NOT NULL,
          exit_code INTEGER,
          duration_ms REAL,
          output_digest TEXT NOT NULL,
          output_excerpt TEXT NOT NULL,
          redaction_kinds_json TEXT NOT NULL DEFAULT '[]',
          freshness TEXT NOT NULL CHECK(freshness IN ('current', 'stale', 'unknown')),
          freshness_reason TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'unknown' CHECK(scope = 'unknown'),
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          UNIQUE(run_id, item_id),
          UNIQUE(run_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS run_evidence_run
          ON run_evidence(run_id, sequence, id);
        CREATE TABLE IF NOT EXISTS run_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          source_thread_id TEXT NOT NULL,
          review_thread_id TEXT NOT NULL UNIQUE,
          turn_id TEXT NOT NULL UNIQUE,
          target_type TEXT NOT NULL DEFAULT 'uncommittedChanges'
            CHECK(target_type = 'uncommittedChanges'),
          delivery TEXT NOT NULL DEFAULT 'detached' CHECK(delivery = 'detached'),
          status TEXT NOT NULL,
          findings TEXT NOT NULL DEFAULT '',
          before_revision TEXT NOT NULL,
          after_revision TEXT NOT NULL DEFAULT '',
          workspace_changed INTEGER NOT NULL DEFAULT 0 CHECK(workspace_changed IN (0, 1)),
          error TEXT NOT NULL DEFAULT '',
          started_at REAL NOT NULL,
          completed_at REAL
        );
        CREATE INDEX IF NOT EXISTS run_reviews_conversation
          ON run_reviews(conversation_id, started_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS runtime_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_memory_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('fact', 'decision', 'preference', 'constraint', 'note')),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active', 'superseded', 'archived')),
          text TEXT NOT NULL,
          content_digest TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('user', 'codex', 'legacy')),
          source_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
          created_by INTEGER NOT NULL DEFAULT 0,
          supersedes_id INTEGER REFERENCES project_memory_items(id),
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS project_memory_active_digest
          ON project_memory_items(project_id, content_digest) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS project_memory_project
          ON project_memory_items(project_id, status, kind, id);
        CREATE TABLE IF NOT EXISTS project_memory_migrations (
          project_id TEXT PRIMARY KEY,
          legacy_digest TEXT NOT NULL,
          imported_items INTEGER NOT NULL,
          migrated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS managed_projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          owner_id INTEGER NOT NULL,
          default_workspace_id TEXT NOT NULL,
          created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS managed_workspaces (
          project_id TEXT NOT NULL REFERENCES managed_projects(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          path TEXT NOT NULL,
          created_at REAL NOT NULL,
          PRIMARY KEY(project_id, id)
        );
        CREATE INDEX IF NOT EXISTS managed_projects_owner
          ON managed_projects(owner_id, id);
        CREATE TABLE IF NOT EXISTS managed_project_owners (
          project_id TEXT NOT NULL REFERENCES managed_projects(id) ON DELETE CASCADE,
          telegram_user_id INTEGER NOT NULL,
          added_at REAL NOT NULL,
          PRIMARY KEY(project_id, telegram_user_id)
        );
        CREATE INDEX IF NOT EXISTS managed_project_owners_user
          ON managed_project_owners(telegram_user_id, project_id);
        INSERT OR IGNORE INTO managed_project_owners
          (project_id, telegram_user_id, added_at)
        SELECT id, owner_id, created_at FROM managed_projects;
        CREATE TABLE IF NOT EXISTS telegram_chats (
          chat_id INTEGER PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          username TEXT NOT NULL DEFAULT '',
          is_forum INTEGER NOT NULL DEFAULT 0 CHECK(is_forum IN (0, 1)),
          bot_status TEXT NOT NULL DEFAULT 'unknown',
          added_by_user_id INTEGER,
          joined_at REAL,
          last_event_json TEXT NOT NULL DEFAULT '',
          first_seen_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS telegram_topics (
          chat_id INTEGER NOT NULL REFERENCES telegram_chats(chat_id) ON DELETE CASCADE,
          topic_id INTEGER NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          first_seen_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          PRIMARY KEY(chat_id, topic_id)
        );
        CREATE INDEX IF NOT EXISTS telegram_chats_updated
          ON telegram_chats(updated_at DESC, chat_id);
        CREATE INDEX IF NOT EXISTS telegram_topics_updated
          ON telegram_topics(chat_id, updated_at DESC, topic_id);
        CREATE TABLE IF NOT EXISTS telegram_users (
          user_id INTEGER PRIMARY KEY,
          username TEXT NOT NULL DEFAULT '',
          first_name TEXT NOT NULL DEFAULT '',
          last_name TEXT NOT NULL DEFAULT '',
          is_bot INTEGER NOT NULL DEFAULT 0 CHECK(is_bot IN (0, 1)),
          language_code TEXT NOT NULL DEFAULT '',
          is_premium INTEGER NOT NULL DEFAULT 0 CHECK(is_premium IN (0, 1)),
          first_seen_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS telegram_topic_users (
          chat_id INTEGER NOT NULL,
          topic_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL REFERENCES telegram_users(user_id) ON DELETE CASCADE,
          message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count >= 0),
          first_seen_at REAL NOT NULL,
          last_seen_at REAL NOT NULL,
          PRIMARY KEY(chat_id, topic_id, user_id),
          FOREIGN KEY(chat_id, topic_id)
            REFERENCES telegram_topics(chat_id, topic_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS telegram_topic_users_chat
          ON telegram_topic_users(chat_id, last_seen_at DESC, user_id);
        CREATE INDEX IF NOT EXISTS telegram_topic_users_topic
          ON telegram_topic_users(chat_id, topic_id, last_seen_at DESC, user_id);
        CREATE TABLE IF NOT EXISTS telegram_report_destination_marks (
          user_id INTEGER PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          topic_id INTEGER NOT NULL,
          marked_at REAL NOT NULL,
          FOREIGN KEY(chat_id, topic_id)
            REFERENCES telegram_topics(chat_id, topic_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS telegram_report_destination_marks_recent
          ON telegram_report_destination_marks(marked_at DESC, user_id);
        CREATE TABLE IF NOT EXISTS team_spaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          administrator_user_id INTEGER NOT NULL,
          phase TEXT NOT NULL DEFAULT 'observing'
            CHECK(phase IN ('observing', 'orienting', 'active', 'paused')),
          summary TEXT NOT NULL DEFAULT '',
          summary_status TEXT NOT NULL DEFAULT 'active'
            CHECK(summary_status IN ('active', 'needs-review')),
          announced_at REAL,
          model_egress_announced_at REAL,
          oriented_at REAL,
          last_intervention_at REAL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_sources (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          external_space_id TEXT NOT NULL,
          external_thread_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          joined_at REAL NOT NULL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          UNIQUE(provider, external_space_id, external_thread_id)
        );
        CREATE INDEX IF NOT EXISTS team_sources_space
          ON team_sources(space_id, provider, external_thread_id);
        CREATE TABLE IF NOT EXISTS team_people (
          id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
          display_name TEXT NOT NULL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS team_identities (
          space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          external_user_id TEXT NOT NULL,
          person_id TEXT NOT NULL REFERENCES team_people(id) ON DELETE CASCADE,
          display_name TEXT NOT NULL,
          observation_enabled INTEGER NOT NULL DEFAULT 1
            CHECK(observation_enabled IN (0, 1)),
          first_seen_at REAL NOT NULL,
          last_seen_at REAL NOT NULL,
          PRIMARY KEY(space_id, provider, external_user_id)
        );
        CREATE TABLE IF NOT EXISTS team_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL REFERENCES team_sources(id) ON DELETE CASCADE,
          person_id TEXT NOT NULL REFERENCES team_people(id),
          provider TEXT NOT NULL,
          external_event_id TEXT NOT NULL,
          event_kind TEXT NOT NULL,
          sender_external_id TEXT NOT NULL,
          sender_display_name TEXT NOT NULL,
          text TEXT NOT NULL,
          reply_to_external_event_id TEXT NOT NULL DEFAULT '',
          attachments_json TEXT NOT NULL DEFAULT '[]',
          occurred_at REAL NOT NULL,
          observed_at REAL NOT NULL,
          direct_claimed_at REAL,
          synthesis_state TEXT NOT NULL DEFAULT 'pending'
            CHECK(synthesis_state IN ('pending', 'synthesized', 'redacted')),
          redacted_at REAL,
          UNIQUE(source_id, event_kind, external_event_id)
        );
        CREATE INDEX IF NOT EXISTS team_events_synthesis
          ON team_events(space_id, synthesis_state, occurred_at, id);
        CREATE INDEX IF NOT EXISTS team_events_person
          ON team_events(space_id, person_id, occurred_at, id);
        CREATE TABLE IF NOT EXISTS team_knowledge (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
          fingerprint TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN
            ('episode', 'fact', 'decision', 'task', 'question', 'risk', 'term', 'person',
             'hypothesis')),
          subject TEXT NOT NULL DEFAULT '',
          statement TEXT NOT NULL,
          confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active', 'resolved', 'superseded', 'needs-review')),
          visibility TEXT NOT NULL DEFAULT 'space'
            CHECK(visibility IN ('space', 'source', 'person')),
          visibility_ref TEXT NOT NULL DEFAULT '',
          valid_from REAL,
          valid_to REAL,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL,
          UNIQUE(space_id, fingerprint)
        );
        CREATE INDEX IF NOT EXISTS team_knowledge_space
          ON team_knowledge(space_id, status, kind, updated_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS team_knowledge_evidence (
          knowledge_id INTEGER NOT NULL REFERENCES team_knowledge(id) ON DELETE CASCADE,
          event_id INTEGER NOT NULL REFERENCES team_events(id),
          PRIMARY KEY(knowledge_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS team_knowledge_supersessions (
          old_knowledge_id INTEGER NOT NULL REFERENCES team_knowledge(id) ON DELETE CASCADE,
          new_knowledge_id INTEGER NOT NULL REFERENCES team_knowledge(id) ON DELETE CASCADE,
          PRIMARY KEY(old_knowledge_id, new_knowledge_id)
        );
        CREATE TABLE IF NOT EXISTS team_synthesis_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('completed', 'failed')),
          event_ids_json TEXT NOT NULL,
          response_json TEXT NOT NULL DEFAULT '',
          error TEXT,
          started_at REAL NOT NULL,
          completed_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS team_synthesis_runs_space
          ON team_synthesis_runs(space_id, completed_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS team_interventions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL REFERENCES team_sources(id),
          kind TEXT NOT NULL CHECK(kind IN
            ('admission', 'egress-notice', 'orientation', 'proactive')),
          reason TEXT NOT NULL,
          text TEXT NOT NULL,
          reply_to_external_event_id TEXT NOT NULL DEFAULT '',
          provider_message_id TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL,
          sent_at REAL
        );
        CREATE INDEX IF NOT EXISTS team_interventions_space
          ON team_interventions(space_id, created_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS team_space_projects (
          space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL,
          linked_at REAL NOT NULL,
          PRIMARY KEY(space_id, project_id)
        );
        CREATE TABLE IF NOT EXISTS security_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          chat_id INTEGER NOT NULL,
          topic_id INTEGER NOT NULL,
          message_id INTEGER NOT NULL,
          sender_id INTEGER NOT NULL,
          project_id TEXT NOT NULL DEFAULT '',
          detectors_json TEXT NOT NULL,
          created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS security_events_created
          ON security_events(created_at DESC, id DESC);
      `);
      const teamSpaceColumns = this.db.prepare("PRAGMA table_info(team_spaces)").all() as Row[];
      if (!teamSpaceColumns.some((column) => column.name === "summary_status")) {
        this.db.exec(
          "ALTER TABLE team_spaces ADD COLUMN summary_status TEXT NOT NULL DEFAULT 'active' " +
            "CHECK(summary_status IN ('active', 'needs-review'))",
        );
      }
      if (!teamSpaceColumns.some((column) => column.name === "model_egress_announced_at")) {
        this.db.exec("ALTER TABLE team_spaces ADD COLUMN model_egress_announced_at REAL");
      }
      const teamEventColumns = this.db.prepare("PRAGMA table_info(team_events)").all() as Row[];
      if (!teamEventColumns.some((column) => column.name === "direct_claimed_at")) {
        this.db.exec("ALTER TABLE team_events ADD COLUMN direct_claimed_at REAL");
      }
      const interventionSchema = this.db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'team_interventions'
      `).get() as Row | undefined;
      if (!String(interventionSchema?.sql ?? "").includes("egress-notice")) {
        this.db.exec(`
          ALTER TABLE team_interventions RENAME TO team_interventions_legacy;
          CREATE TABLE team_interventions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            space_id TEXT NOT NULL REFERENCES team_spaces(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL REFERENCES team_sources(id),
            kind TEXT NOT NULL CHECK(kind IN
              ('admission', 'egress-notice', 'orientation', 'proactive')),
            reason TEXT NOT NULL,
            text TEXT NOT NULL,
            reply_to_external_event_id TEXT NOT NULL DEFAULT '',
            provider_message_id TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            sent_at REAL
          );
          INSERT INTO team_interventions
            (id, space_id, source_id, kind, reason, text, reply_to_external_event_id,
             provider_message_id, created_at, sent_at)
          SELECT id, space_id, source_id, kind, reason, text, reply_to_external_event_id,
                 provider_message_id, created_at, sent_at
          FROM team_interventions_legacy;
          DROP TABLE team_interventions_legacy;
          CREATE INDEX team_interventions_space
            ON team_interventions(space_id, created_at DESC, id DESC);
        `);
      }
      const conversationColumns = this.db.prepare("PRAGMA table_info(conversations)").all() as Row[];
      if (!conversationColumns.some((column) => column.name === "readonly_codex_thread_id")) {
        this.db.exec("ALTER TABLE conversations ADD COLUMN readonly_codex_thread_id TEXT");
      }
      if (!conversationColumns.some((column) => column.name === "codex_thread_capability")) {
        this.db.exec(
          "ALTER TABLE conversations ADD COLUMN codex_thread_capability TEXT NOT NULL DEFAULT ''",
        );
      }
      if (!conversationColumns.some((column) => column.name === "previous_codex_thread_id")) {
        this.db.exec("ALTER TABLE conversations ADD COLUMN previous_codex_thread_id TEXT");
      }
      if (!conversationColumns.some((column) => column.name === "binding_mode")) {
        this.db.exec(
          "ALTER TABLE conversations ADD COLUMN binding_mode TEXT NOT NULL DEFAULT 'project' " +
            "CHECK(binding_mode IN ('project', 'external-readonly'))",
        );
      }
      this.migrateProjectPortalBindings();
      this.migrateObserverCustomerChannels();
      const pendingColumns = this.db.prepare("PRAGMA table_info(pending_inputs)").all() as Row[];
      if (!pendingColumns.some((column) => column.name === "access_mode")) {
        this.db.exec(
          "ALTER TABLE pending_inputs ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'write' " +
            "CHECK(access_mode IN ('write', 'read-only'))",
        );
      }
      if (!pendingColumns.some((column) => column.name === "telegram_user_id")) {
        this.db.exec(
          "ALTER TABLE pending_inputs ADD COLUMN telegram_user_id INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!pendingColumns.some((column) => column.name === "response_mode")) {
        this.db.exec(
          "ALTER TABLE pending_inputs ADD COLUMN response_mode TEXT NOT NULL DEFAULT 'direct' " +
            "CHECK(response_mode IN ('direct', 'ambient'))",
        );
      }
      if (!pendingColumns.some((column) => column.name === "attachments_json")) {
        this.db.exec(
          "ALTER TABLE pending_inputs ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      if (!pendingColumns.some((column) => column.name === "audio_transcript_json")) {
        this.db.exec(
          "ALTER TABLE pending_inputs ADD COLUMN audio_transcript_json TEXT NOT NULL DEFAULT ''",
        );
      }
      if (!pendingColumns.some((column) => column.name === "run_id")) {
        this.db.exec("ALTER TABLE pending_inputs ADD COLUMN run_id INTEGER");
      }
      if (!pendingColumns.some((column) => column.name === "retry_of_run_id")) {
        this.db.exec(
          "ALTER TABLE pending_inputs ADD COLUMN retry_of_run_id INTEGER REFERENCES runs(id)",
        );
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS pending_inputs_access_lookup
        ON pending_inputs(conversation_id, access_mode, state, id)
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS pending_inputs_response_lookup
        ON pending_inputs(conversation_id, response_mode, state, id)
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS pending_inputs_run_lookup
        ON pending_inputs(run_id, id)
      `);
      // Older Telegram ingestion treated the implicit forum-topic root link as
      // a reply. Repair those transport-only edges before synthesis sees them.
      this.db.exec(`
        UPDATE team_knowledge
        SET status = 'needs-review', updated_at = unixepoch('subsec')
        WHERE id IN (
          SELECT team_knowledge_evidence.knowledge_id
          FROM team_knowledge_evidence
          JOIN team_events ON team_events.id = team_knowledge_evidence.event_id
          JOIN team_sources ON team_sources.id = team_events.source_id
          WHERE team_sources.external_thread_id <> '0'
            AND team_sources.external_thread_id = team_events.reply_to_external_event_id
        );
        UPDATE team_spaces
        SET summary_status = 'needs-review', updated_at = unixepoch('subsec')
        WHERE summary <> '' AND id IN (
          SELECT team_events.space_id
          FROM team_events
          JOIN team_sources ON team_sources.id = team_events.source_id
          WHERE team_sources.external_thread_id <> '0'
            AND team_sources.external_thread_id = team_events.reply_to_external_event_id
        );
        UPDATE team_events
        SET reply_to_external_event_id = '',
            synthesis_state = CASE
              WHEN synthesis_state = 'redacted' THEN 'redacted'
              ELSE 'pending'
            END
        WHERE reply_to_external_event_id <> ''
          AND EXISTS (
            SELECT 1 FROM team_sources
            WHERE team_sources.id = team_events.source_id
              AND team_sources.external_thread_id <> '0'
              AND team_sources.external_thread_id = team_events.reply_to_external_event_id
          )
      `);
      const runColumns = this.db.prepare("PRAGMA table_info(runs)").all() as Row[];
      if (!runColumns.some((column) => column.name === "project_id")) {
        this.db.exec("ALTER TABLE runs ADD COLUMN project_id TEXT NOT NULL DEFAULT ''");
      }
      if (!runColumns.some((column) => column.name === "workspace_id")) {
        this.db.exec("ALTER TABLE runs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''");
      }
      if (!runColumns.some((column) => column.name === "actor_user_id")) {
        this.db.exec("ALTER TABLE runs ADD COLUMN actor_user_id INTEGER NOT NULL DEFAULT 0");
      }
      if (!runColumns.some((column) => column.name === "request_text")) {
        this.db.exec("ALTER TABLE runs ADD COLUMN request_text TEXT NOT NULL DEFAULT ''");
      }
      if (!runColumns.some((column) => column.name === "retry_of_run_id")) {
        this.db.exec("ALTER TABLE runs ADD COLUMN retry_of_run_id INTEGER REFERENCES runs(id)");
      }
      if (!runColumns.some((column) => column.name === "access_mode")) {
        this.db.exec(
          "ALTER TABLE runs ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'write' " +
            "CHECK(access_mode IN ('write', 'read-only'))",
        );
      }
      if (!runColumns.some((column) => column.name === "response_mode")) {
        this.db.exec(
          "ALTER TABLE runs ADD COLUMN response_mode TEXT NOT NULL DEFAULT 'direct' " +
            "CHECK(response_mode IN ('direct', 'ambient'))",
        );
      }
      this.db.exec(`
        UPDATE runs
        SET project_id = COALESCE(
              NULLIF(project_id, ''),
              (SELECT project_id FROM conversations WHERE conversations.id = runs.conversation_id),
              ''
            ),
            workspace_id = COALESCE(
              NULLIF(workspace_id, ''),
              (SELECT workspace_id FROM conversations WHERE conversations.id = runs.conversation_id),
              ''
            ),
            request_text = CASE WHEN request_text = '' THEN prompt ELSE request_text END
        WHERE project_id = '' OR workspace_id = '' OR request_text = ''
      `);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS run_history_fts USING fts5(
          run_id UNINDEXED,
          project_id UNINDEXED,
          workspace_id UNINDEXED,
          request_text,
          response,
          tokenize = 'unicode61'
        );
        CREATE TRIGGER IF NOT EXISTS runs_history_insert AFTER INSERT ON runs BEGIN
          INSERT INTO run_history_fts
            (run_id, project_id, workspace_id, request_text, response)
          VALUES (new.id, new.project_id, new.workspace_id, new.request_text, new.response);
        END;
        CREATE TRIGGER IF NOT EXISTS runs_history_update
          AFTER UPDATE OF project_id, workspace_id, request_text, response ON runs BEGIN
          DELETE FROM run_history_fts WHERE run_id = old.id;
          INSERT INTO run_history_fts
            (run_id, project_id, workspace_id, request_text, response)
          VALUES (new.id, new.project_id, new.workspace_id, new.request_text, new.response);
        END;
        CREATE TRIGGER IF NOT EXISTS runs_history_delete AFTER DELETE ON runs BEGIN
          DELETE FROM run_history_fts WHERE run_id = old.id;
        END;
        INSERT INTO run_history_fts (run_id, project_id, workspace_id, request_text, response)
        SELECT runs.id, runs.project_id, runs.workspace_id, runs.request_text, runs.response
        FROM runs
        WHERE NOT EXISTS (
          SELECT 1 FROM run_history_fts WHERE run_history_fts.run_id = runs.id
        );
      `);
      this.db.exec(`
        INSERT OR IGNORE INTO telegram_chats
          (chat_id, type, title, username, is_forum, bot_status, first_seen_at, updated_at)
        SELECT
          chat_id,
          'supergroup',
          '',
          '',
          MAX(CASE WHEN topic_id != 0 THEN 1 ELSE 0 END),
          'unknown',
          MIN(created_at),
          MAX(updated_at)
        FROM conversations
        WHERE chat_id < 0
        GROUP BY chat_id;
        INSERT OR IGNORE INTO telegram_topics
          (chat_id, topic_id, name, first_seen_at, updated_at)
        SELECT chat_id, topic_id, '', MIN(created_at), MAX(updated_at)
        FROM conversations
        WHERE chat_id < 0
        GROUP BY chat_id, topic_id;
      `);
    });
  }

  createManagedProject(project: ManagedProject): void {
    const ownerIds = [...new Set(project.ownerIds)];
    if (
      !Number.isSafeInteger(project.primaryOwnerId) ||
      project.primaryOwnerId <= 0 ||
      ownerIds.length === 0 ||
      !ownerIds.includes(project.primaryOwnerId) ||
      ownerIds.some((ownerId) => !Number.isSafeInteger(ownerId) || ownerId <= 0)
    ) {
      throw new Error("managed project owners must include one valid primary owner");
    }
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO managed_projects
          (id, name, owner_id, default_workspace_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        project.id,
        project.name,
        project.primaryOwnerId,
        project.defaultWorkspaceId,
        project.createdAt,
      );
      const insertOwner = this.db.prepare(`
        INSERT INTO managed_project_owners (project_id, telegram_user_id, added_at)
        VALUES (?, ?, ?)
      `);
      for (const ownerId of ownerIds) {
        insertOwner.run(project.id, ownerId, project.createdAt);
      }
      const insertWorkspace = this.db.prepare(`
        INSERT INTO managed_workspaces (project_id, id, path, created_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const workspace of project.workspaces) {
        insertWorkspace.run(project.id, workspace.id, workspace.path, project.createdAt);
      }
    });
  }

  listManagedProjects(): ManagedProject[] {
    const projects = this.db.prepare(`
      SELECT id, name, owner_id, default_workspace_id, created_at
      FROM managed_projects
      ORDER BY id
    `).all() as Row[];
    const workspaceQuery = this.db.prepare(`
      SELECT id, path FROM managed_workspaces WHERE project_id = ? ORDER BY id
    `);
    const ownerQuery = this.db.prepare(`
      SELECT telegram_user_id
      FROM managed_project_owners
      WHERE project_id = ?
      ORDER BY telegram_user_id
    `);
    return projects.map((project) => {
      const primaryOwnerId = Number(project.owner_id);
      const storedOwners = (ownerQuery.all(project.id as SQLInputValue) as Row[])
        .map((owner) => Number(owner.telegram_user_id));
      const ownerIds = [primaryOwnerId, ...storedOwners.filter((ownerId) =>
        ownerId !== primaryOwnerId
      )];
      return {
        id: String(project.id),
        name: String(project.name),
        primaryOwnerId,
        ownerIds,
        defaultWorkspaceId: String(project.default_workspace_id),
        workspaces: (workspaceQuery.all(project.id as SQLInputValue) as Row[]).map((workspace) => ({
          id: String(workspace.id),
          path: String(workspace.path),
        })),
        createdAt: Number(project.created_at),
      };
    });
  }

  replaceManagedProjectOwners(
    projectId: string,
    primaryOwnerId: number,
    ownerIds: readonly number[],
  ): void {
    const uniqueOwners = [...new Set(ownerIds)];
    if (
      !Number.isSafeInteger(primaryOwnerId) ||
      primaryOwnerId <= 0 ||
      uniqueOwners.length === 0 ||
      !uniqueOwners.includes(primaryOwnerId) ||
      uniqueOwners.some((ownerId) => !Number.isSafeInteger(ownerId) || ownerId <= 0)
    ) {
      throw new Error("managed project owners must include one valid primary owner");
    }
    this.transaction(() => {
      const project = this.db.prepare(
        "SELECT id FROM managed_projects WHERE id = ?",
      ).get(projectId) as Row | undefined;
      if (!project) throw new Error(`unknown managed project '${projectId}'`);
      this.db.prepare(
        "UPDATE managed_projects SET owner_id = ? WHERE id = ?",
      ).run(primaryOwnerId, projectId);
      this.db.prepare(
        "DELETE FROM managed_project_owners WHERE project_id = ?",
      ).run(projectId);
      const insertOwner = this.db.prepare(`
        INSERT INTO managed_project_owners (project_id, telegram_user_id, added_at)
        VALUES (?, ?, ?)
      `);
      const addedAt = Date.now() / 1_000;
      for (const ownerId of uniqueOwners) insertOwner.run(projectId, ownerId, addedAt);
    });
  }

  recordTelegramChat(observation: TelegramChatObservation): TelegramChatRecord {
    const observedAt = observation.observedAt ?? Date.now() / 1000;
    return this.transaction(() => {
      const current = this.db.prepare(
        "SELECT * FROM telegram_chats WHERE chat_id = ?",
      ).get(observation.chatId) as Row | undefined;
      const botStatus = observation.botStatus ??
        (current ? String(current.bot_status) : "unknown");
      const addedByUserId = observation.addedByUserId ??
        (current?.added_by_user_id === null || current === undefined
          ? null
          : Number(current.added_by_user_id));
      const joinedAt = observation.joinedAt ??
        (current?.joined_at === null || current === undefined
          ? null
          : Number(current.joined_at));
      const lastEventJson = observation.lastEventJson ??
        (current ? String(current.last_event_json) : "");
      const firstSeenAt = current ? Number(current.first_seen_at) : observedAt;
      const username = observation.username ?? (current ? String(current.username) : "");
      const isForum = observation.isForum ??
        (current ? Number(current.is_forum) === 1 : false);
      const title = observation.title || (current ? String(current.title) : "");
      this.db.prepare(`
        INSERT INTO telegram_chats
          (chat_id, type, title, username, is_forum, bot_status, added_by_user_id,
           joined_at, last_event_json, first_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          type = excluded.type,
          title = excluded.title,
          username = excluded.username,
          is_forum = excluded.is_forum,
          bot_status = excluded.bot_status,
          added_by_user_id = excluded.added_by_user_id,
          joined_at = excluded.joined_at,
          last_event_json = excluded.last_event_json,
          updated_at = excluded.updated_at
      `).run(
        observation.chatId,
        observation.type,
        title,
        username,
        isForum ? 1 : 0,
        botStatus,
        addedByUserId,
        joinedAt,
        lastEventJson,
        firstSeenAt,
        observedAt,
      );
      return this.telegramChat(observation.chatId)!;
    });
  }

  recordTelegramTopic(
    chatId: number,
    topicId: number,
    name = "",
    observedAt = Date.now() / 1000,
  ): TelegramTopicRecord {
    return this.transaction(() => {
      const current = this.db.prepare(
        "SELECT * FROM telegram_topics WHERE chat_id = ? AND topic_id = ?",
      ).get(chatId, topicId) as Row | undefined;
      const topicName = name || (current ? String(current.name) : "");
      const firstSeenAt = current ? Number(current.first_seen_at) : observedAt;
      this.db.prepare(`
        INSERT INTO telegram_topics (chat_id, topic_id, name, first_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, topic_id) DO UPDATE SET
          name = excluded.name,
          updated_at = excluded.updated_at
      `).run(chatId, topicId, topicName, firstSeenAt, observedAt);
      return this.telegramTopic(chatId, topicId)!;
    });
  }

  telegramChat(chatId: number): TelegramChatRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM telegram_chats WHERE chat_id = ?",
    ).get(chatId) as Row | undefined;
    return row ? this.toTelegramChat(row) : null;
  }

  telegramTopic(chatId: number, topicId: number): TelegramTopicRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM telegram_topics WHERE chat_id = ? AND topic_id = ?",
    ).get(chatId, topicId) as Row | undefined;
    return row ? this.toTelegramTopic(row) : null;
  }

  listTelegramChats(): TelegramChatRecord[] {
    return (this.db.prepare(
      "SELECT * FROM telegram_chats ORDER BY updated_at DESC, chat_id",
    ).all() as Row[]).map((row) => this.toTelegramChat(row));
  }

  listTelegramTopics(chatId?: number): TelegramTopicRecord[] {
    const rows = chatId === undefined
      ? this.db.prepare(
        "SELECT * FROM telegram_topics ORDER BY chat_id, updated_at DESC, topic_id",
      ).all()
      : this.db.prepare(
        "SELECT * FROM telegram_topics WHERE chat_id = ? " +
          "ORDER BY updated_at DESC, topic_id",
      ).all(chatId);
    return (rows as Row[]).map((row) => this.toTelegramTopic(row));
  }

  markTelegramReportDestination(
    userId: number,
    chatId: number,
    topicId: number,
    markedAt = Date.now() / 1_000,
  ): TelegramReportDestinationMark {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new Error("report destination marker requires a Telegram user");
    }
    const topic = this.telegramTopic(chatId, topicId);
    if (!topic) throw new Error("report destination marker requires an observed Telegram topic");
    this.db.prepare(`
      INSERT INTO telegram_report_destination_marks (user_id, chat_id, topic_id, marked_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        topic_id = excluded.topic_id,
        marked_at = excluded.marked_at
    `).run(userId, chatId, topicId, markedAt);
    return { ...topic, markedByUserId: userId, markedAt };
  }

  telegramReportDestinationMark(
    userId: number,
    maximumAgeSeconds = 15 * 60,
    now = Date.now() / 1_000,
  ): TelegramReportDestinationMark | null {
    const row = this.db.prepare(`
      SELECT topic.*, mark.user_id, mark.marked_at
      FROM telegram_report_destination_marks mark
      JOIN telegram_topics topic
        ON topic.chat_id = mark.chat_id AND topic.topic_id = mark.topic_id
      WHERE mark.user_id = ? AND mark.marked_at >= ?
    `).get(userId, now - maximumAgeSeconds) as Row | undefined;
    return row
      ? {
          ...this.toTelegramTopic(row),
          markedByUserId: Number(row.user_id),
          markedAt: Number(row.marked_at),
        }
      : null;
  }

  recordTelegramTopicUser(
    chatId: number,
    topicId: number,
    observation: TelegramUserObservation,
  ): void {
    const observedAt = observation.observedAt ?? Date.now() / 1000;
    this.transaction(() => {
      const current = this.db.prepare(
        "SELECT * FROM telegram_users WHERE user_id = ?",
      ).get(observation.userId) as Row | undefined;
      const firstSeenAt = current ? Number(current.first_seen_at) : observedAt;
      const username = observation.username ?? (current ? String(current.username) : "");
      const firstName = observation.firstName ?? (current ? String(current.first_name) : "");
      const lastName = observation.lastName ?? (current ? String(current.last_name) : "");
      const isBot = observation.isBot ?? (current ? Number(current.is_bot) === 1 : false);
      const languageCode = observation.languageCode ??
        (current ? String(current.language_code) : "");
      const isPremium = observation.isPremium ??
        (current ? Number(current.is_premium) === 1 : false);
      this.db.prepare(`
        INSERT INTO telegram_users
          (user_id, username, first_name, last_name, is_bot, language_code,
           is_premium, first_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          is_bot = excluded.is_bot,
          language_code = excluded.language_code,
          is_premium = excluded.is_premium,
          updated_at = excluded.updated_at
      `).run(
        observation.userId,
        username,
        firstName,
        lastName,
        isBot ? 1 : 0,
        languageCode,
        isPremium ? 1 : 0,
        firstSeenAt,
        observedAt,
      );
      this.db.prepare(`
        INSERT INTO telegram_topic_users
          (chat_id, topic_id, user_id, message_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(chat_id, topic_id, user_id) DO UPDATE SET
          message_count = telegram_topic_users.message_count + 1,
          last_seen_at = excluded.last_seen_at
      `).run(chatId, topicId, observation.userId, observedAt, observedAt);
    });
  }

  telegramUserCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM telegram_users",
    ).get() as Row;
    return Number(row.count);
  }

  telegramChatUserCount(chatId: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT user_id) AS count
      FROM telegram_topic_users
      WHERE chat_id = ?
    `).get(chatId) as Row;
    return Number(row.count);
  }

  telegramTopicUserCount(chatId: number, topicId: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM telegram_topic_users
      WHERE chat_id = ? AND topic_id = ?
    `).get(chatId, topicId) as Row;
    return Number(row.count);
  }

  listTelegramChatUsers(chatId: number): TelegramObservedUserRecord[] {
    return (this.db.prepare(`
      SELECT u.*, SUM(a.message_count) AS message_count,
        COUNT(*) AS topic_count, MIN(a.first_seen_at) AS activity_first_seen_at,
        MAX(a.last_seen_at) AS activity_last_seen_at
      FROM telegram_topic_users a
      JOIN telegram_users u ON u.user_id = a.user_id
      WHERE a.chat_id = ?
      GROUP BY u.user_id
      ORDER BY message_count DESC, activity_last_seen_at DESC, u.user_id
    `).all(chatId) as Row[]).map((row) => this.toTelegramObservedUser(row));
  }

  listTelegramTopicUsers(chatId: number, topicId: number): TelegramObservedUserRecord[] {
    return (this.db.prepare(`
      SELECT u.*, a.message_count, 1 AS topic_count,
        a.first_seen_at AS activity_first_seen_at,
        a.last_seen_at AS activity_last_seen_at
      FROM telegram_topic_users a
      JOIN telegram_users u ON u.user_id = a.user_id
      WHERE a.chat_id = ? AND a.topic_id = ?
      ORDER BY a.message_count DESC, a.last_seen_at DESC, u.user_id
    `).all(chatId, topicId) as Row[]).map((row) => this.toTelegramObservedUser(row));
  }

  forgetTelegramChatUser(chatId: number, userId: number): number {
    return this.transaction(() => {
      const result = this.db.prepare(`
        DELETE FROM telegram_topic_users WHERE chat_id = ? AND user_id = ?
      `).run(chatId, userId);
      this.db.prepare(`
        DELETE FROM telegram_users
        WHERE user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM telegram_topic_users WHERE user_id = ?
          )
      `).run(userId, userId);
      return Number(result.changes);
    });
  }

  private toTelegramChat(row: Row): TelegramChatRecord {
    return {
      chatId: Number(row.chat_id),
      type: String(row.type),
      title: String(row.title),
      username: String(row.username),
      isForum: Number(row.is_forum) === 1,
      botStatus: String(row.bot_status),
      addedByUserId: row.added_by_user_id === null ? null : Number(row.added_by_user_id),
      joinedAt: row.joined_at === null ? null : Number(row.joined_at),
      lastEventJson: String(row.last_event_json),
      firstSeenAt: Number(row.first_seen_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private toTelegramTopic(row: Row): TelegramTopicRecord {
    return {
      chatId: Number(row.chat_id),
      topicId: Number(row.topic_id),
      name: String(row.name),
      firstSeenAt: Number(row.first_seen_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private toTelegramObservedUser(row: Row): TelegramObservedUserRecord {
    return {
      userId: Number(row.user_id),
      username: String(row.username),
      firstName: String(row.first_name),
      lastName: String(row.last_name),
      isBot: Number(row.is_bot) === 1,
      languageCode: String(row.language_code),
      isPremium: Number(row.is_premium) === 1,
      messageCount: Number(row.message_count),
      topicCount: Number(row.topic_count),
      firstSeenAt: Number(row.activity_first_seen_at),
      lastSeenAt: Number(row.activity_last_seen_at),
    };
  }

  static teamSpaceId(provider: string, externalSpaceId: string): string {
    const digest = createHash("sha256")
      .update(`${provider}:${externalSpaceId}`)
      .digest("hex")
      .slice(0, 20);
    return `team-${digest}`;
  }

  static teamSourceId(
    provider: string,
    externalSpaceId: string,
    externalThreadId: string,
  ): string {
    const digest = createHash("sha256")
      .update(`${provider}:${externalSpaceId}:${externalThreadId}`)
      .digest("hex")
      .slice(0, 20);
    return `source-${digest}`;
  }

  private static teamPersonId(spaceId: string, provider: string, externalUserId: string): string {
    const digest = createHash("sha256")
      .update(`${spaceId}:${provider}:${externalUserId}`)
      .digest("hex")
      .slice(0, 20);
    return `person-${digest}`;
  }

  ensureTeamSource(input: {
    provider: string;
    externalSpaceId: string;
    externalThreadId: string;
    spaceName: string;
    sourceTitle: string;
    administratorUserId: number;
    joinedAt?: number;
  }): { space: TeamSpace; source: TeamSource; created: boolean } {
    const now = input.joinedAt ?? Date.now() / 1_000;
    const spaceId = StateStore.teamSpaceId(input.provider, input.externalSpaceId);
    const sourceId = StateStore.teamSourceId(
      input.provider,
      input.externalSpaceId,
      input.externalThreadId,
    );
    let created = false;
    this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM team_spaces WHERE id = ?").get(spaceId);
      created = !existing;
      this.db.prepare(`
        INSERT INTO team_spaces
          (id, name, administrator_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
          updated_at = excluded.updated_at
      `).run(
        spaceId,
        input.spaceName || `${input.provider}:${input.externalSpaceId}`,
        input.administratorUserId,
        now,
        now,
      );
      this.db.prepare(`
        INSERT INTO team_sources
          (id, space_id, provider, external_space_id, external_thread_id, title,
           joined_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, external_space_id, external_thread_id) DO UPDATE SET
          title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END,
          updated_at = excluded.updated_at
      `).run(
        sourceId,
        spaceId,
        input.provider,
        input.externalSpaceId,
        input.externalThreadId,
        input.sourceTitle,
        now,
        now,
        now,
      );
    });
    return {
      space: this.teamSpace(spaceId)!,
      source: this.teamSource(sourceId)!,
      created,
    };
  }

  teamSpace(spaceId: string): TeamSpace | null {
    const row = this.db.prepare("SELECT * FROM team_spaces WHERE id = ?").get(spaceId) as
      | Row
      | undefined;
    return row ? this.toTeamSpace(row) : null;
  }

  teamSpaceForProvider(provider: string, externalSpaceId: string): TeamSpace | null {
    return this.teamSpace(StateStore.teamSpaceId(provider, externalSpaceId));
  }

  listTeamSpaces(): TeamSpace[] {
    return (this.db.prepare("SELECT * FROM team_spaces ORDER BY updated_at DESC, id").all() as Row[])
      .map((row) => this.toTeamSpace(row));
  }

  listTeamSources(spaceId?: string): TeamSource[] {
    const rows = spaceId
      ? this.db.prepare(`
          SELECT * FROM team_sources WHERE space_id = ?
          ORDER BY provider, external_space_id, external_thread_id, id
        `).all(spaceId)
      : this.db.prepare(`
          SELECT * FROM team_sources
          ORDER BY space_id, provider, external_space_id, external_thread_id, id
        `).all();
    return (rows as Row[]).map((row) => this.toTeamSource(row));
  }

  private toTeamSpace(row: Row): TeamSpace {
    return {
      id: String(row.id),
      name: String(row.name),
      administratorUserId: Number(row.administrator_user_id),
      phase: String(row.phase) as TeamSpacePhase,
      summary: String(row.summary),
      summaryStatus: String(row.summary_status) as TeamSpace["summaryStatus"],
      announcedAt: row.announced_at === null ? null : Number(row.announced_at),
      modelEgressAnnouncedAt:
        row.model_egress_announced_at === null
          ? null
          : Number(row.model_egress_announced_at),
      orientedAt: row.oriented_at === null ? null : Number(row.oriented_at),
      lastInterventionAt:
        row.last_intervention_at === null ? null : Number(row.last_intervention_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  teamSource(sourceId: string): TeamSource | null {
    const row = this.db.prepare("SELECT * FROM team_sources WHERE id = ?").get(sourceId) as
      | Row
      | undefined;
    return row ? this.toTeamSource(row) : null;
  }

  teamSourceForProvider(
    provider: string,
    externalSpaceId: string,
    externalThreadId: string,
  ): TeamSource | null {
    const row = this.db.prepare(`
      SELECT * FROM team_sources
      WHERE provider = ? AND external_space_id = ? AND external_thread_id = ?
    `).get(provider, externalSpaceId, externalThreadId) as Row | undefined;
    return row ? this.toTeamSource(row) : null;
  }

  private toTeamSource(row: Row): TeamSource {
    return {
      id: String(row.id),
      spaceId: String(row.space_id),
      provider: String(row.provider),
      externalSpaceId: String(row.external_space_id),
      externalThreadId: String(row.external_thread_id),
      title: String(row.title),
      joinedAt: Number(row.joined_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  recordTeamEvent(input: TeamEventInput): TeamEvent | null {
    const observedAt = input.observedAt ?? Date.now() / 1_000;
    const { space, source } = this.ensureTeamSource({
      provider: input.provider,
      externalSpaceId: input.externalSpaceId,
      externalThreadId: input.externalThreadId,
      spaceName: input.spaceName,
      sourceTitle: input.sourceTitle,
      administratorUserId: input.administratorUserId,
      joinedAt: observedAt,
    });
    if (space.phase === "paused") return null;
    const personId = StateStore.teamPersonId(
      space.id,
      input.provider,
      input.senderExternalId,
    );
    let eventId = 0;
    this.transaction(() => {
      const identity = this.db.prepare(`
        SELECT observation_enabled FROM team_identities
        WHERE space_id = ? AND provider = ? AND external_user_id = ?
      `).get(space.id, input.provider, input.senderExternalId) as Row | undefined;
      if (identity && Number(identity.observation_enabled) !== 1) return;
      this.db.prepare(`
        INSERT INTO team_people (id, space_id, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name
            ELSE display_name END,
          updated_at = excluded.updated_at
      `).run(personId, space.id, input.senderDisplayName, observedAt, observedAt);
      this.db.prepare(`
        INSERT INTO team_identities
          (space_id, provider, external_user_id, person_id, display_name,
           first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(space_id, provider, external_user_id) DO UPDATE SET
          display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name
            ELSE display_name END,
          last_seen_at = excluded.last_seen_at
      `).run(
        space.id,
        input.provider,
        input.senderExternalId,
        personId,
        input.senderDisplayName,
        input.occurredAt,
        input.occurredAt,
      );
      this.db.prepare(`
        INSERT OR IGNORE INTO team_events
          (space_id, source_id, person_id, provider, external_event_id, event_kind,
           sender_external_id, sender_display_name, text, reply_to_external_event_id,
           attachments_json, occurred_at, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        space.id,
        source.id,
        personId,
        input.provider,
        input.externalEventId,
        input.eventKind,
        input.senderExternalId,
        input.senderDisplayName,
        input.text,
        input.replyToExternalEventId ?? "",
        JSON.stringify(input.attachments ?? []),
        input.occurredAt,
        observedAt,
      );
      const row = this.db.prepare(`
        SELECT id FROM team_events
        WHERE source_id = ? AND event_kind = ? AND external_event_id = ?
      `).get(source.id, input.eventKind, input.externalEventId) as Row | undefined;
      eventId = row ? Number(row.id) : 0;
      if (eventId && (input.eventKind === "edit" || input.eventKind === "deletion")) {
        const originalExternalId = input.externalEventId.split(":", 1)[0] ?? "";
        const original = this.db.prepare(`
          SELECT id FROM team_events
          WHERE source_id = ? AND event_kind IN ('message', 'command', 'service')
            AND external_event_id = ?
        `).get(source.id, originalExternalId) as Row | undefined;
        if (original) {
          this.db.prepare(`
            UPDATE team_knowledge SET status = 'needs-review', updated_at = ?
            WHERE id IN (
              SELECT knowledge_id FROM team_knowledge_evidence WHERE event_id = ?
            )
          `).run(observedAt, Number(original.id));
        }
      }
    });
    return eventId ? this.teamEvent(eventId) : null;
  }

  teamEvent(eventId: number): TeamEvent | null {
    const row = this.db.prepare("SELECT * FROM team_events WHERE id = ?").get(eventId) as
      | Row
      | undefined;
    return row ? this.toTeamEvent(row) : null;
  }

  teamEventByExternalId(sourceId: string, externalEventId: string): TeamEvent | null {
    if (!sourceId || !externalEventId) return null;
    const row = this.db.prepare(`
      SELECT * FROM team_events
      WHERE source_id = ? AND synthesis_state <> 'redacted'
        AND (
          external_event_id = ?
          OR (
            event_kind = 'edit'
            AND instr(external_event_id, ? || ':') = 1
          )
        )
      ORDER BY CASE WHEN event_kind = 'edit' THEN 1 ELSE 0 END DESC,
               occurred_at DESC, id DESC
      LIMIT 1
    `).get(sourceId, externalEventId, externalEventId) as Row | undefined;
    return row ? this.toTeamEvent(row) : null;
  }

  enrichTeamEvent(eventId: number, text: string): void {
    const addition = text.trim();
    if (!addition) return;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE team_events SET
          text = CASE WHEN text = '' THEN ? ELSE text || '\n\n' || ? END,
          synthesis_state = 'pending'
        WHERE id = ? AND redacted_at IS NULL
      `).run(addition, addition, eventId);
    });
  }

  claimTeamEventForDirectResponse(
    eventId: number,
    claimedAt = Date.now() / 1_000,
  ): TeamEvent | null {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE team_events
        SET direct_claimed_at = COALESCE(direct_claimed_at, ?)
        WHERE id = ? AND synthesis_state <> 'redacted'
      `).run(claimedAt, eventId);
    });
    return this.teamEvent(eventId);
  }

  attachTeamEventArtifact(
    eventId: number,
    input: { providerFileId?: string; artifactId: string; sha256: string },
  ): TeamEvent | null {
    const event = this.teamEvent(eventId);
    if (!event || event.synthesisState === "redacted") return null;
    const providerFileId = String(input.providerFileId ?? "");
    let attached = false;
    const attachments = event.attachments.map((attachment) => {
      if (
        attached ||
        (providerFileId && attachment.providerFileId !== providerFileId) ||
        (!providerFileId && attachment.artifactId)
      ) {
        return attachment;
      }
      attached = true;
      return { ...attachment, artifactId: input.artifactId, sha256: input.sha256 };
    });
    if (!attached) return event;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE team_events SET attachments_json = ?
        WHERE id = ? AND synthesis_state <> 'redacted'
      `).run(JSON.stringify(attachments), eventId);
    });
    return this.teamEvent(eventId);
  }

  redactTeamEvent(eventId: number, redactedAt = Date.now() / 1_000): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE team_knowledge SET status = 'needs-review', updated_at = ?
        WHERE id IN (
          SELECT knowledge_id FROM team_knowledge_evidence WHERE event_id = ?
        )
      `).run(redactedAt, eventId);
      this.db.prepare(`
        UPDATE team_events SET text = '', attachments_json = '[]',
          synthesis_state = 'redacted', redacted_at = ? WHERE id = ?
      `).run(redactedAt, eventId);
    });
  }

  redactTeamEventsForProvider(
    provider: string,
    externalSpaceId: string,
    externalEventId: string,
    redactedAt = Date.now() / 1_000,
  ): number[] {
    const rows = this.db.prepare(`
      SELECT team_events.id
      FROM team_events
      JOIN team_sources ON team_sources.id = team_events.source_id
      WHERE team_sources.provider = ?
        AND team_sources.external_space_id = ?
        AND (
          team_events.external_event_id = ?
          OR instr(team_events.external_event_id, ? || ':') = 1
        )
        AND team_events.synthesis_state <> 'redacted'
    `).all(provider, externalSpaceId, externalEventId, externalEventId) as Row[];
    const ids = rows.map((row) => Number(row.id));
    for (const id of ids) this.redactTeamEvent(id, redactedAt);
    return ids;
  }

  private toTeamEvent(row: Row): TeamEvent {
    let attachments: TeamEventAttachment[] = [];
    try {
      const parsed = JSON.parse(String(row.attachments_json ?? "[]"));
      if (Array.isArray(parsed)) attachments = parsed as TeamEventAttachment[];
    } catch {
      attachments = [];
    }
    return {
      id: Number(row.id),
      spaceId: String(row.space_id),
      sourceId: String(row.source_id),
      personId: String(row.person_id),
      provider: String(row.provider),
      externalEventId: String(row.external_event_id),
      eventKind: String(row.event_kind),
      senderExternalId: String(row.sender_external_id),
      senderDisplayName: String(row.sender_display_name),
      text: String(row.text),
      replyToExternalEventId: String(row.reply_to_external_event_id),
      attachments,
      occurredAt: Number(row.occurred_at),
      observedAt: Number(row.observed_at),
      directClaimedAt:
        row.direct_claimed_at === null || row.direct_claimed_at === undefined
          ? null
          : Number(row.direct_claimed_at),
      synthesisState: String(row.synthesis_state) as TeamEvent["synthesisState"],
      redactedAt: row.redacted_at === null ? null : Number(row.redacted_at),
    };
  }

  pendingTeamEvents(spaceId: string, limit = 100): TeamEvent[] {
    return (this.db.prepare(`
      SELECT * FROM team_events
      WHERE space_id = ? AND synthesis_state = 'pending'
      ORDER BY occurred_at, id LIMIT ?
    `).all(spaceId, limit) as Row[]).map((row) => this.toTeamEvent(row));
  }

  pendingTeamEventsForSource(sourceId: string, limit = 100): TeamEvent[] {
    return (this.db.prepare(`
      SELECT * FROM team_events
      WHERE source_id = ? AND synthesis_state = 'pending'
      ORDER BY occurred_at, id LIMIT ?
    `).all(sourceId, limit) as Row[]).map((row) => this.toTeamEvent(row));
  }

  recentTeamEvents(spaceId: string, sourceId: string, limit = 40): TeamEvent[] {
    return (this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM team_events
        WHERE space_id = ? AND source_id = ? AND synthesis_state <> 'redacted'
        ORDER BY occurred_at DESC, id DESC LIMIT ?
      ) ORDER BY occurred_at, id
    `).all(spaceId, sourceId, limit) as Row[]).map((row) => this.toTeamEvent(row));
  }

  teamEventsAfter(spaceId: string, afterId: number, limit = 500): TeamEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM team_events
      WHERE space_id = ? AND id > ? AND synthesis_state <> 'redacted'
      ORDER BY id LIMIT ?
    `).all(spaceId, afterId, limit) as Row[];
    return rows.map((row) => this.toTeamEvent(row));
  }

  teamEventCount(spaceId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM team_events WHERE space_id = ? AND synthesis_state <> 'redacted'",
    ).get(spaceId) as Row;
    return Number(row.count);
  }

  pendingTeamEventCount(spaceId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM team_events WHERE space_id = ? AND synthesis_state = 'pending'",
    ).get(spaceId) as Row;
    return Number(row.count);
  }

  pendingTeamEventCountForSource(sourceId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM team_events WHERE source_id = ? AND synthesis_state = 'pending'",
    ).get(sourceId) as Row;
    return Number(row.count);
  }

  teamEventCountForIdentity(spaceId: string, provider: string, externalUserId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM team_events
      WHERE space_id = ? AND provider = ? AND sender_external_id = ?
        AND synthesis_state <> 'redacted'
    `).get(spaceId, provider, externalUserId) as Row;
    return Number(row.count);
  }

  teamEventIdsForIdentity(spaceId: string, provider: string, externalUserId: string): number[] {
    return (this.db.prepare(`
      SELECT team_events.id
      FROM team_events
      JOIN team_identities ON team_identities.person_id = team_events.person_id
        AND team_identities.space_id = team_events.space_id
      WHERE team_events.space_id = ? AND team_identities.provider = ?
        AND team_identities.external_user_id = ?
        AND team_events.synthesis_state <> 'redacted'
      ORDER BY team_events.id
    `).all(spaceId, provider, externalUserId) as Row[]).map((row) => Number(row.id));
  }

  teamKnowledgeForIdentity(
    spaceId: string,
    provider: string,
    externalUserId: string,
    limit = 100,
  ): TeamKnowledgeItem[] {
    const rows = this.db.prepare(`
      SELECT k.*, group_concat(all_evidence.event_id) AS evidence_ids,
        (SELECT group_concat(s.old_knowledge_id)
         FROM team_knowledge_supersessions s
         WHERE s.new_knowledge_id = k.id) AS supersedes_ids
      FROM team_knowledge k
      JOIN team_knowledge_evidence own_evidence ON own_evidence.knowledge_id = k.id
      JOIN team_events own_event ON own_event.id = own_evidence.event_id
      LEFT JOIN team_knowledge_evidence all_evidence ON all_evidence.knowledge_id = k.id
      WHERE k.space_id = ? AND own_event.provider = ? AND own_event.sender_external_id = ?
        AND own_event.synthesis_state <> 'redacted'
      GROUP BY k.id
      ORDER BY k.updated_at DESC, k.id DESC LIMIT ?
    `).all(spaceId, provider, externalUserId, limit) as Row[];
    return rows.map((row) => this.toTeamKnowledge(row));
  }

  spacesWithPendingTeamEvents(): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT space_id FROM team_events
      WHERE synthesis_state = 'pending' ORDER BY space_id
    `).all() as Row[]).map((row) => String(row.space_id));
  }

  sourcesWithPendingTeamEvents(): string[] {
    return (this.db.prepare(`
      SELECT DISTINCT source_id FROM team_events
      WHERE synthesis_state = 'pending' ORDER BY source_id
    `).all() as Row[]).map((row) => String(row.source_id));
  }

  teamKnowledge(spaceId: string, limit = 100): TeamKnowledgeItem[] {
    const rows = this.db.prepare(`
      SELECT k.*, group_concat(e.event_id) AS evidence_ids,
        (SELECT group_concat(s.old_knowledge_id)
         FROM team_knowledge_supersessions s
         WHERE s.new_knowledge_id = k.id) AS supersedes_ids
      FROM team_knowledge k
      LEFT JOIN team_knowledge_evidence e ON e.knowledge_id = k.id
      WHERE k.space_id = ?
      GROUP BY k.id
      ORDER BY CASE k.status WHEN 'active' THEN 0 WHEN 'needs-review' THEN 1 ELSE 2 END,
               k.updated_at DESC, k.id DESC
      LIMIT ?
    `).all(spaceId, limit) as Row[];
    return rows.map((row) => this.toTeamKnowledge(row));
  }

  teamPersonIdForIdentity(
    spaceId: string,
    provider: string,
    externalUserId: string,
  ): string | null {
    const row = this.db.prepare(`
      SELECT person_id FROM team_identities
      WHERE space_id = ? AND provider = ? AND external_user_id = ?
    `).get(spaceId, provider, externalUserId) as Row | undefined;
    return row ? String(row.person_id) : null;
  }

  teamKnowledgeVisibleTo(
    spaceId: string,
    sourceId: string,
    personId: string,
    limit = 100,
  ): TeamKnowledgeItem[] {
    const rows = this.db.prepare(`
      SELECT k.*, group_concat(e.event_id) AS evidence_ids,
        (SELECT group_concat(s.old_knowledge_id)
         FROM team_knowledge_supersessions s
         WHERE s.new_knowledge_id = k.id) AS supersedes_ids
      FROM team_knowledge k
      LEFT JOIN team_knowledge_evidence e ON e.knowledge_id = k.id
      WHERE k.space_id = ? AND (
        k.visibility = 'space' OR
        (k.visibility = 'source' AND k.visibility_ref = ?) OR
        (k.visibility = 'person' AND k.visibility_ref = ?)
      )
      GROUP BY k.id
      ORDER BY CASE k.status WHEN 'active' THEN 0 WHEN 'needs-review' THEN 1 ELSE 2 END,
               k.updated_at DESC, k.id DESC
      LIMIT ?
    `).all(spaceId, sourceId, personId, limit) as Row[];
    return rows.map((row) => this.toTeamKnowledge(row));
  }

  private toTeamKnowledge(row: Row): TeamKnowledgeItem {
    const evidenceEventIds = [...new Set(
      String(row.evidence_ids ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number)
        .filter(Number.isSafeInteger),
    )];
    const supersedesKnowledgeIds = [...new Set(
      String(row.supersedes_ids ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number)
        .filter(Number.isSafeInteger),
    )];
    return {
      id: Number(row.id),
      spaceId: String(row.space_id),
      fingerprint: String(row.fingerprint),
      kind: String(row.kind) as TeamKnowledgeKind,
      subject: String(row.subject),
      statement: String(row.statement),
      confidence: Number(row.confidence),
      status: String(row.status) as TeamKnowledgeStatus,
      visibility: String(row.visibility) as TeamKnowledgeVisibility,
      visibilityRef: String(row.visibility_ref),
      evidenceEventIds,
      supersedesKnowledgeIds,
      validFrom: row.valid_from === null ? null : Number(row.valid_from),
      validTo: row.valid_to === null ? null : Number(row.valid_to),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  applyTeamUnderstanding(
    spaceId: string,
    eventIds: number[],
    result: TeamUnderstandingResult,
    startedAt: number,
  ): void {
    if (eventIds.length === 0) return;
    if (new Set(eventIds).size !== eventIds.length) {
      throw new Error("team understanding batch contains duplicate evidence ids");
    }
    const eventSet = new Set(eventIds);
    if (
      result.intervention.replyToEventId !== null &&
      !eventSet.has(result.intervention.replyToEventId)
    ) {
      throw new Error("team intervention cites evidence outside the understanding batch");
    }
    if (
      !result.intervention.reason.trim() ||
      (result.intervention.action === "silent" &&
        (result.intervention.replyToEventId !== null || result.intervention.message !== "")) ||
      (result.intervention.action === "reply" &&
        (result.intervention.replyToEventId === null || !result.intervention.message.trim()))
    ) {
      throw new Error("team intervention decision is internally inconsistent");
    }
    if (
      result.episode.eventIds.length !== eventIds.length ||
      result.episode.eventIds.some((eventId) => !eventSet.has(eventId))
    ) {
      throw new Error("conversation episode must cover the complete understanding batch");
    }
    if (result.episode.participants.length === 0) {
      throw new Error("conversation episode requires at least one participant");
    }
    const episodeKnowledge = result.knowledge.find((item) =>
      item.kind === "episode" &&
      item.visibility === "source" &&
      item.visibilityRef === result.episode.sourceId &&
      item.subject === result.episode.subject &&
      item.statement === result.episode.synopsis &&
      item.confidence === result.episode.confidence &&
      item.evidenceEventIds.length === eventIds.length &&
      item.evidenceEventIds.every((eventId) => eventSet.has(eventId))
    );
    if (!episodeKnowledge) {
      throw new Error("conversation episode must be persisted as evidence-backed knowledge");
    }
    for (const participant of result.episode.participants) {
      if (
        participant.evidenceEventIds.length === 0 ||
        participant.evidenceEventIds.some((eventId) => !eventSet.has(eventId))
      ) {
        throw new Error("episode participant must cite evidence from the understanding batch");
      }
    }
    for (const item of result.knowledge) {
      if (item.evidenceEventIds.length === 0) {
        throw new Error("team knowledge requires evidence");
      }
      if (item.evidenceEventIds.some((eventId) => !eventSet.has(eventId))) {
        throw new Error("team knowledge cites evidence outside the understanding batch");
      }
      if (item.visibility !== "space" && !item.visibilityRef) {
        throw new Error("restricted team knowledge requires a visibility reference");
      }
      if (!item.statement.trim()) throw new Error("team knowledge requires a statement");
    }
    const now = Date.now() / 1_000;
    this.transaction(() => {
      const placeholders = eventIds.map(() => "?").join(",");
      const countRow = this.db.prepare(`
        SELECT COUNT(*) AS count FROM team_events
        WHERE space_id = ? AND id IN (${placeholders}) AND synthesis_state = 'pending'
      `).get(spaceId, ...eventIds) as Row;
      if (Number(countRow.count) !== eventIds.length) {
        throw new Error("team understanding batch no longer matches pending evidence");
      }
      const sourceRows = this.db.prepare(`
        SELECT DISTINCT source_id FROM team_events
        WHERE space_id = ? AND id IN (${placeholders})
      `).all(spaceId, ...eventIds) as Row[];
      if (
        sourceRows.length !== 1 ||
        String(sourceRows[0]?.source_id ?? "") !== result.episode.sourceId
      ) {
        throw new Error("conversation episode must stay inside one Team Source");
      }
      for (const participant of result.episode.participants) {
        const person = this.db.prepare(`
          SELECT id FROM team_people WHERE id = ? AND space_id = ?
        `).get(participant.personId, spaceId);
        if (!person) throw new Error("episode participant crosses its Team Space");
      }
      for (const item of result.knowledge) {
        if (item.visibility === "source") {
          const source = this.db.prepare(`
            SELECT id FROM team_sources WHERE id = ? AND space_id = ?
          `).get(item.visibilityRef, spaceId);
          if (!source) throw new Error("team knowledge source visibility crosses its Team Space");
        }
        if (item.visibility === "person") {
          const person = this.db.prepare(`
            SELECT id FROM team_people WHERE id = ? AND space_id = ?
          `).get(item.visibilityRef, spaceId);
          if (!person) throw new Error("team knowledge person visibility crosses its Team Space");
        }
        for (const supersededId of item.supersedesKnowledgeIds) {
          const existing = this.db.prepare(`
            SELECT id FROM team_knowledge WHERE id = ? AND space_id = ?
          `).get(supersededId, spaceId);
          if (!existing) throw new Error("team knowledge supersession crosses its Team Space");
        }
        const normalized = `${item.kind}\n${item.visibility}\n${item.visibilityRef}\n` +
          `${item.subject.trim().toLowerCase()}\n${item.statement.trim().toLowerCase()}`;
        const fingerprint = createHash("sha256").update(normalized).digest("hex");
        this.db.prepare(`
          INSERT INTO team_knowledge
            (space_id, fingerprint, kind, subject, statement, confidence, status,
             visibility, visibility_ref, valid_from, valid_to, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(space_id, fingerprint) DO UPDATE SET
            confidence = excluded.confidence,
            status = excluded.status,
            visibility = excluded.visibility,
            visibility_ref = excluded.visibility_ref,
            valid_from = COALESCE(excluded.valid_from, valid_from),
            valid_to = excluded.valid_to,
            updated_at = excluded.updated_at
        `).run(
          spaceId,
          fingerprint,
          item.kind,
          item.subject.trim(),
          item.statement.trim(),
          item.confidence,
          item.status,
          item.visibility,
          item.visibilityRef,
          item.validFrom ?? null,
          item.validTo ?? null,
          now,
          now,
        );
        const knowledgeRow = this.db.prepare(`
          SELECT id FROM team_knowledge WHERE space_id = ? AND fingerprint = ?
        `).get(spaceId, fingerprint) as Row;
        const knowledgeId = Number(knowledgeRow.id);
        for (const eventId of item.evidenceEventIds) {
          this.db.prepare(`
            INSERT OR IGNORE INTO team_knowledge_evidence (knowledge_id, event_id)
            VALUES (?, ?)
          `).run(knowledgeId, eventId);
        }
        for (const supersededId of item.supersedesKnowledgeIds) {
          if (supersededId === knowledgeId) continue;
          this.db.prepare(`
            UPDATE team_knowledge SET status = 'superseded', valid_to = COALESCE(valid_to, ?),
              updated_at = ? WHERE id = ? AND space_id = ?
          `).run(now, now, supersededId, spaceId);
          this.db.prepare(`
            INSERT OR IGNORE INTO team_knowledge_supersessions
              (old_knowledge_id, new_knowledge_id) VALUES (?, ?)
          `).run(supersededId, knowledgeId);
        }
      }
      this.db.prepare(`
        UPDATE team_events SET synthesis_state = 'synthesized'
        WHERE space_id = ? AND id IN (${placeholders})
      `).run(spaceId, ...eventIds);
      this.db.prepare(`
        UPDATE team_spaces SET
          summary = ?,
          summary_status = 'active',
          phase = CASE
            WHEN phase = 'paused' THEN phase
            WHEN oriented_at IS NOT NULL THEN 'active'
            WHEN ? THEN 'orienting'
            ELSE 'observing'
          END,
          updated_at = ?
        WHERE id = ?
      `).run(result.summary.trim(), result.orientationReady ? 1 : 0, now, spaceId);
      this.db.prepare(`
        INSERT INTO team_synthesis_runs
          (space_id, status, event_ids_json, response_json, started_at, completed_at)
        VALUES (?, 'completed', ?, ?, ?, ?)
      `).run(spaceId, JSON.stringify(eventIds), JSON.stringify(result), startedAt, now);
    });
  }

  recordTeamUnderstandingFailure(
    spaceId: string,
    eventIds: number[],
    error: string,
    startedAt: number,
  ): void {
    const now = Date.now() / 1_000;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO team_synthesis_runs
          (space_id, status, event_ids_json, error, started_at, completed_at)
        VALUES (?, 'failed', ?, ?, ?, ?)
      `).run(spaceId, JSON.stringify(eventIds), error, startedAt, now);
    });
  }

  linkTeamProject(spaceId: string, projectId: string): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO team_space_projects (space_id, project_id, linked_at)
        VALUES (?, ?, ?)
      `).run(spaceId, projectId, Date.now() / 1_000);
    });
  }

  static customerChannelId(chatId: number, topicId: number): string {
    const digest = createHash("sha256").update(`${chatId}:${topicId}`).digest("hex").slice(0, 20);
    return `customer-${digest}`;
  }

  ensureCustomerChannel(
    chatId: number,
    topicId: number,
    title = "",
    legacyConversationId: string | null = null,
  ): CustomerChannel {
    const now = Date.now() / 1_000;
    const id = StateStore.customerChannelId(chatId, topicId);
    this.db.prepare(`
      INSERT INTO customer_channels
        (id, chat_id, topic_id, title, legacy_conversation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, topic_id) DO UPDATE SET
        title = CASE WHEN excluded.title = '' THEN title ELSE excluded.title END,
        legacy_conversation_id = COALESCE(legacy_conversation_id, excluded.legacy_conversation_id),
        updated_at = excluded.updated_at
    `).run(id, chatId, topicId, title.trim(), legacyConversationId, now, now);
    const row = this.db.prepare("SELECT * FROM customer_channels WHERE id = ?").get(id) as Row;
    return this.toCustomerChannel(row);
  }

  customerChannel(chatId: number, topicId: number): CustomerChannel | null {
    const row = this.db.prepare(`
      SELECT * FROM customer_channels WHERE chat_id = ? AND topic_id = ?
    `).get(chatId, topicId) as Row | undefined;
    return row ? this.toCustomerChannel(row) : null;
  }

  customerChannelById(id: string): CustomerChannel | null {
    const row = this.db.prepare("SELECT * FROM customer_channels WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? this.toCustomerChannel(row) : null;
  }

  customerChannelsForProject(projectId: string, workspaceId = ""): CustomerChannel[] {
    return (this.db.prepare(`
      SELECT DISTINCT channel.*
      FROM customer_channels channel
      JOIN result_publications publication ON publication.channel_id = channel.id
      WHERE publication.project_id = ? AND (? = '' OR publication.workspace_id = ?)
      ORDER BY channel.updated_at DESC, channel.id
    `).all(projectId, workspaceId, workspaceId) as Row[])
      .map((row) => this.toCustomerChannel(row));
  }

  resultPublication(id: string): ResultPublication | null {
    const row = this.db.prepare("SELECT * FROM result_publications WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? this.toResultPublication(row) : null;
  }

  resultPublicationsForProject(
    projectId: string,
    workspaceId: string,
    channelId = "",
    limit = 20,
  ): ResultPublication[] {
    const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
    return (this.db.prepare(`
      SELECT * FROM result_publications
      WHERE project_id = ? AND workspace_id = ? AND (? = '' OR channel_id = ?)
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(projectId, workspaceId, channelId, channelId, bounded) as Row[])
      .map((row) => this.toResultPublication(row));
  }

  recordResultPublication(input: {
    projectId: string;
    workspaceId: string;
    jobId: string;
    scheduleId?: string | null;
    outboxId: string;
    reportText?: string;
    artifactName?: string | null;
    chatId: number;
    topicId: number;
    channelTitle?: string;
    telegramMessageId: number;
    createdAt?: number;
  }): ResultPublication {
    if (!Number.isSafeInteger(input.telegramMessageId) || input.telegramMessageId <= 0) {
      throw new Error("result publication Telegram message id is invalid");
    }
    const channel = this.ensureCustomerChannel(
      input.chatId,
      input.topicId,
      input.channelTitle ?? "",
    );
    const id = `result-${createHash("sha256").update(input.outboxId).digest("hex").slice(0, 24)}`;
    const createdAt = input.createdAt ?? Date.now() / 1_000;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO result_publications
          (id, channel_id, project_id, workspace_id, job_id, schedule_id, outbox_id,
           report_text, artifact_name, telegram_message_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(outbox_id) DO UPDATE SET
          report_text = excluded.report_text,
          artifact_name = excluded.artifact_name,
          telegram_message_id = excluded.telegram_message_id
      `).run(
        id,
        channel.id,
        input.projectId,
        input.workspaceId,
        input.jobId,
        input.scheduleId ?? null,
        input.outboxId,
        input.reportText ?? "",
        input.artifactName ?? null,
        input.telegramMessageId,
        createdAt,
      );
      this.recordResultMessage({
        publicationId: id,
        chatId: input.chatId,
        topicId: input.topicId,
        telegramMessageId: input.telegramMessageId,
        author: "publication",
        senderId: 0,
        text: input.reportText ?? "",
        createdAt,
      });
    });
    const row = this.db.prepare("SELECT * FROM result_publications WHERE outbox_id = ?")
      .get(input.outboxId) as Row;
    return this.toResultPublication(row);
  }

  recordResultMessage(input: {
    publicationId: string;
    chatId: number;
    topicId: number;
    telegramMessageId: number;
    author: ResultMessageAuthor;
    senderId: number;
    text: string;
    createdAt?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO result_discussion_messages
        (publication_id, chat_id, topic_id, telegram_message_id, author, sender_id, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, topic_id, telegram_message_id) DO UPDATE SET
        text = excluded.text,
        sender_id = excluded.sender_id
    `).run(
      input.publicationId,
      input.chatId,
      input.topicId,
      input.telegramMessageId,
      input.author,
      input.senderId,
      input.text,
      input.createdAt ?? Date.now() / 1_000,
    );
  }

  resultPublicationForMessage(
    chatId: number,
    topicId: number,
    telegramMessageId: number,
  ): ResultPublication | null {
    const row = this.db.prepare(`
      SELECT publication.*
      FROM result_discussion_messages message
      JOIN result_publications publication ON publication.id = message.publication_id
      WHERE message.chat_id = ? AND message.topic_id = ? AND message.telegram_message_id = ?
    `).get(chatId, topicId, telegramMessageId) as Row | undefined;
    return row ? this.toResultPublication(row) : null;
  }

  resultDiscussion(publicationId: string, limit = 30): ResultDiscussionMessage[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM result_discussion_messages
        WHERE publication_id = ? ORDER BY created_at DESC, telegram_message_id DESC LIMIT ?
      ) ORDER BY created_at, telegram_message_id
    `).all(publicationId, bounded) as Row[];
    return rows.map((row) => this.toResultDiscussionMessage(row));
  }

  recordProjectFeedback(input: {
    publicationId: string;
    teamEventId?: number | null;
    telegramMessageId: number;
    senderId: number;
    text: string;
    createdAt?: number;
  }): ProjectFeedback {
    const publication = this.db.prepare("SELECT * FROM result_publications WHERE id = ?")
      .get(input.publicationId) as Row | undefined;
    if (!publication) throw new Error("result publication was not found");
    const channel = this.db.prepare("SELECT * FROM customer_channels WHERE id = ?")
      .get(publication.channel_id as SQLInputValue) as Row;
    const createdAt = input.createdAt ?? Date.now() / 1_000;
    this.transaction(() => {
      this.recordResultMessage({
        publicationId: input.publicationId,
        chatId: Number(channel.chat_id),
        topicId: Number(channel.topic_id),
        telegramMessageId: input.telegramMessageId,
        author: "customer",
        senderId: input.senderId,
        text: input.text,
        createdAt,
      });
      this.db.prepare(`
        INSERT INTO project_feedback
          (publication_id, team_event_id, telegram_message_id, sender_id, text, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(publication_id, telegram_message_id) DO UPDATE SET
          team_event_id = COALESCE(excluded.team_event_id, team_event_id),
          text = excluded.text
      `).run(
        input.publicationId,
        input.teamEventId ?? null,
        input.telegramMessageId,
        input.senderId,
        input.text,
        createdAt,
      );
    });
    const row = this.db.prepare(`
      SELECT feedback.*, publication.channel_id, publication.project_id,
        publication.workspace_id
      FROM project_feedback feedback
      JOIN result_publications publication ON publication.id = feedback.publication_id
      WHERE feedback.publication_id = ? AND feedback.telegram_message_id = ?
    `).get(input.publicationId, input.telegramMessageId) as Row;
    return this.toProjectFeedback(row);
  }

  projectFeedbackForMessage(
    publicationId: string,
    telegramMessageId: number,
  ): ProjectFeedback | null {
    const row = this.db.prepare(`
      SELECT feedback.*, publication.channel_id, publication.project_id,
        publication.workspace_id
      FROM project_feedback feedback
      JOIN result_publications publication ON publication.id = feedback.publication_id
      WHERE feedback.publication_id = ? AND feedback.telegram_message_id = ?
    `).get(publicationId, telegramMessageId) as Row | undefined;
    return row ? this.toProjectFeedback(row) : null;
  }

  projectFeedback(input: {
    projectId: string;
    workspaceId?: string;
    channelId?: string;
    query?: string;
    beforeFeedbackId?: number;
    limit?: number;
  }): ProjectFeedback[] {
    const query = String(input.query ?? "").trim().toLowerCase();
    const workspaceId = String(input.workspaceId ?? "").trim();
    const channelId = String(input.channelId ?? "").trim();
    const before = Number.isSafeInteger(input.beforeFeedbackId) && Number(input.beforeFeedbackId) > 0
      ? Number(input.beforeFeedbackId)
      : Number.MAX_SAFE_INTEGER;
    const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
    return (this.db.prepare(`
      SELECT feedback.*, publication.channel_id, publication.project_id,
        publication.workspace_id
      FROM project_feedback feedback
      JOIN result_publications publication ON publication.id = feedback.publication_id
      WHERE publication.project_id = ?
        AND (? = '' OR publication.workspace_id = ?)
        AND (? = '' OR publication.channel_id = ?)
        AND (? = '' OR instr(lower(feedback.text), ?) > 0)
        AND feedback.id < ?
      ORDER BY feedback.id DESC
      LIMIT ?
    `).all(
      input.projectId,
      workspaceId,
      workspaceId,
      channelId,
      channelId,
      query,
      query,
      before,
      limit,
    ) as Row[]).map((row) => this.toProjectFeedback(row));
  }

  observerProjectSources(projectId: string): TeamSource[] {
    return (this.db.prepare(`
      SELECT DISTINCT source.*
      FROM conversations conversation
      JOIN team_sources source
        ON source.provider = 'telegram'
       AND source.external_space_id = CAST(conversation.chat_id AS TEXT)
       AND source.external_thread_id = CAST(conversation.topic_id AS TEXT)
      WHERE conversation.project_id = ?
        AND conversation.binding_mode = 'external-readonly'
      ORDER BY source.updated_at DESC, source.id
    `).all(projectId) as Row[]).map((row) => this.toTeamSource(row));
  }

  projectPortals(projectId: string, workspaceId = ""): ProjectPortalBinding[] {
    return (this.db.prepare(`
      SELECT portal.id AS portal_id, portal.portal_key, portal.is_default,
        portal.transport, portal.project_id, portal.workspace_id,
        conversation.chat_id, conversation.topic_id,
        source.id AS source_id,
        COALESCE(NULLIF(portal.title, ''), NULLIF(topic.name, ''), NULLIF(source.title, ''),
          'topic ' || CAST(conversation.topic_id AS TEXT)) AS title
      FROM project_portal_bindings portal
      JOIN conversations conversation ON conversation.id = portal.conversation_id
      LEFT JOIN team_sources source
        ON source.provider = 'telegram'
       AND source.external_space_id = CAST(conversation.chat_id AS TEXT)
       AND source.external_thread_id = CAST(conversation.topic_id AS TEXT)
      LEFT JOIN telegram_topics topic
        ON topic.chat_id = conversation.chat_id AND topic.topic_id = conversation.topic_id
      WHERE portal.project_id = ? AND (? = '' OR portal.workspace_id = ?)
        AND conversation.binding_mode = 'external-readonly'
      ORDER BY portal.is_default DESC, portal.portal_key, portal.id
    `).all(projectId, workspaceId, workspaceId) as Row[]).map((row) => ({
      portalId: String(row.portal_id),
      portalKey: String(row.portal_key),
      isDefault: Number(row.is_default) === 1,
      transport: String(row.transport),
      projectId: String(row.project_id),
      workspaceId: String(row.workspace_id),
      chatId: Number(row.chat_id),
      topicId: Number(row.topic_id),
      sourceId: row.source_id === null ? null : String(row.source_id),
      title: String(row.title),
    }));
  }

  projectPortal(
    projectId: string,
    workspaceId: string,
    portalId: string,
  ): ProjectPortalBinding | null {
    return this.projectPortals(projectId, workspaceId)
      .find((portal) => portal.portalId === portalId) ?? null;
  }

  resolveProjectPortal(
    projectId: string,
    workspaceId: string,
    requestedPortalKey = "",
  ): ProjectPortalBinding | null {
    const portals = this.projectPortals(projectId, workspaceId);
    if (requestedPortalKey) {
      const key = projectPortalKey(requestedPortalKey);
      return portals.find((portal) => portal.portalKey === key) ?? null;
    }
    return portals.find((portal) => portal.isDefault) ?? null;
  }

  projectPortalReplyMessageId(portal: ProjectPortalBinding, eventId: number): number | null {
    if (!portal.sourceId || !Number.isSafeInteger(eventId) || eventId <= 0) return null;
    const row = this.db.prepare(`
      SELECT external_event_id FROM team_events
      WHERE id = ? AND source_id = ? AND synthesis_state <> 'redacted'
    `).get(eventId, portal.sourceId) as Row | undefined;
    if (!row || !/^\d+$/.test(String(row.external_event_id))) return null;
    const messageId = Number(row.external_event_id);
    return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
  }

  observerProjectEvents(input: {
    projectId: string;
    workspaceId?: string;
    sourceId?: string;
    query?: string;
    beforeEventId?: number;
    afterEventId?: number;
    authorExternalId?: string;
    occurredAfter?: number;
    occurredBefore?: number;
    attachmentsOnly?: boolean;
    limit?: number;
  }): TeamEvent[] {
    const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
    const query = String(input.query ?? "").trim().toLowerCase();
    const workspaceId = String(input.workspaceId ?? "").trim();
    const sourceId = String(input.sourceId ?? "").trim();
    const beforeEventId = Number.isSafeInteger(input.beforeEventId) && Number(input.beforeEventId) > 0
      ? Number(input.beforeEventId)
      : Number.MAX_SAFE_INTEGER;
    const afterEventId = Number.isSafeInteger(input.afterEventId) && Number(input.afterEventId) > 0
      ? Number(input.afterEventId)
      : 0;
    const authorExternalId = String(input.authorExternalId ?? "").trim();
    const occurredAfter = Number.isFinite(input.occurredAfter) ? Number(input.occurredAfter) : 0;
    const occurredBefore = Number.isFinite(input.occurredBefore)
      ? Number(input.occurredBefore)
      : Number.MAX_SAFE_INTEGER;
    const rows = this.db.prepare(`
      SELECT DISTINCT event.*
      FROM conversations conversation
      JOIN team_sources source
        ON source.provider = 'telegram'
       AND source.external_space_id = CAST(conversation.chat_id AS TEXT)
       AND source.external_thread_id = CAST(conversation.topic_id AS TEXT)
      JOIN team_events event ON event.source_id = source.id
      WHERE conversation.project_id = ?
        AND (? = '' OR conversation.workspace_id = ?)
        AND conversation.binding_mode = 'external-readonly'
        AND event.synthesis_state <> 'redacted'
        AND event.id < ?
        AND event.id > ?
        AND (? = '' OR source.id = ?)
        AND (? = '' OR instr(lower(event.text), ?) > 0)
        AND (? = '' OR event.sender_external_id = ?)
        AND event.occurred_at >= ?
        AND event.occurred_at <= ?
        AND (? = 0 OR event.attachments_json <> '[]')
      ORDER BY event.occurred_at DESC, event.id DESC
      LIMIT ?
    `).all(
      input.projectId,
      workspaceId,
      workspaceId,
      beforeEventId,
      afterEventId,
      sourceId,
      sourceId,
      query,
      query,
      authorExternalId,
      authorExternalId,
      occurredAfter,
      occurredBefore,
      input.attachmentsOnly ? 1 : 0,
      limit,
    ) as Row[];
    return rows.map((row) => this.toTeamEvent(row));
  }

  markTeamSpaceAnnounced(spaceId: string, announcedAt = Date.now() / 1_000): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE team_spaces SET announced_at = COALESCE(announced_at, ?), updated_at = ?
        WHERE id = ?
      `).run(announcedAt, announcedAt, spaceId);
    });
  }

  markTeamSpaceModelEgressAnnounced(
    spaceId: string,
    announcedAt = Date.now() / 1_000,
  ): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE team_spaces SET
          model_egress_announced_at = COALESCE(model_egress_announced_at, ?),
          updated_at = ?
        WHERE id = ?
      `).run(announcedAt, announcedAt, spaceId);
    });
  }

  requeueUnderstoodTeamEvents(spaceId: string, eventIds: number[]): void {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => "?").join(",");
    this.transaction(() => {
      this.db.prepare(`
        UPDATE team_events SET synthesis_state = 'pending'
        WHERE space_id = ? AND id IN (${placeholders}) AND synthesis_state = 'synthesized'
      `).run(spaceId, ...eventIds);
    });
  }

  markTeamSpaceOriented(spaceId: string, orientedAt = Date.now() / 1_000): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE team_spaces SET oriented_at = COALESCE(oriented_at, ?), phase = 'active',
          last_intervention_at = ?, updated_at = ?
        WHERE id = ?
      `).run(orientedAt, orientedAt, orientedAt, spaceId);
    });
  }

  setTeamSpacePhase(spaceId: string, phase: TeamSpacePhase): void {
    this.transaction(() => {
      this.db.prepare("UPDATE team_spaces SET phase = ?, updated_at = ? WHERE id = ?")
        .run(phase, Date.now() / 1_000, spaceId);
    });
  }

  recordTeamIntervention(input: Omit<TeamIntervention, "id" | "createdAt" | "sentAt">): number {
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO team_interventions
          (space_id, source_id, kind, reason, text, reply_to_external_event_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.spaceId,
        input.sourceId,
        input.kind,
        input.reason,
        input.text,
        input.replyToExternalEventId,
        Date.now() / 1_000,
      );
      return Number(result.lastInsertRowid);
    });
  }

  markTeamInterventionSent(
    interventionId: number,
    providerMessageId: string,
    sentAt = Date.now() / 1_000,
  ): void {
    this.transaction(() => {
      const row = this.db.prepare(
        "SELECT space_id FROM team_interventions WHERE id = ?",
      ).get(interventionId) as Row | undefined;
      if (!row) throw new Error(`unknown team intervention: ${interventionId}`);
      this.db.prepare(`
        UPDATE team_interventions SET provider_message_id = ?, sent_at = ? WHERE id = ?
      `).run(providerMessageId, sentAt, interventionId);
      this.db.prepare(`
        UPDATE team_spaces SET last_intervention_at = ?, updated_at = ? WHERE id = ?
      `).run(sentAt, sentAt, String(row.space_id));
    });
  }

  setTeamIdentityObservation(
    spaceId: string,
    provider: string,
    externalUserId: string,
    enabled: boolean,
  ): void {
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE team_identities SET observation_enabled = ?, last_seen_at = ?
        WHERE space_id = ? AND provider = ? AND external_user_id = ?
      `).run(enabled ? 1 : 0, Date.now() / 1_000, spaceId, provider, externalUserId);
      if (Number(result.changes) === 0) {
        const personId = StateStore.teamPersonId(spaceId, provider, externalUserId);
        const now = Date.now() / 1_000;
        this.db.prepare(`
          INSERT OR IGNORE INTO team_people (id, space_id, display_name, created_at, updated_at)
          VALUES (?, ?, '', ?, ?)
        `).run(personId, spaceId, now, now);
        this.db.prepare(`
          INSERT INTO team_identities
            (space_id, provider, external_user_id, person_id, display_name,
             observation_enabled, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, '', ?, ?, ?)
        `).run(spaceId, provider, externalUserId, personId, enabled ? 1 : 0, now, now);
      }
    });
  }

  teamIdentityObservationEnabled(
    spaceId: string,
    provider: string,
    externalUserId: string,
  ): boolean {
    const identity = this.db.prepare(`
      SELECT observation_enabled FROM team_identities
      WHERE space_id = ? AND provider = ? AND external_user_id = ?
    `).get(spaceId, provider, externalUserId) as Row | undefined;
    return !identity || Number(identity.observation_enabled) === 1;
  }

  forgetTeamIdentity(spaceId: string, provider: string, externalUserId: string): number {
    const now = Date.now() / 1_000;
    return this.transaction(() => {
      const identity = this.db.prepare(`
        SELECT person_id FROM team_identities
        WHERE space_id = ? AND provider = ? AND external_user_id = ?
      `).get(spaceId, provider, externalUserId) as Row | undefined;
      this.setTeamIdentityObservationInTransaction(spaceId, provider, externalUserId, false, now);
      if (!identity) return 0;
      this.db.prepare(`
        UPDATE team_people SET display_name = '', updated_at = ? WHERE id = ?
      `).run(now, String(identity.person_id));
      this.db.prepare(`
        UPDATE team_identities SET display_name = '', last_seen_at = ?
        WHERE space_id = ? AND provider = ? AND external_user_id = ?
      `).run(now, spaceId, provider, externalUserId);
      this.db.prepare(`
        UPDATE team_events SET sender_display_name = '' WHERE space_id = ? AND person_id = ?
      `).run(spaceId, String(identity.person_id));
      const eventRows = this.db.prepare(`
        SELECT id, source_id, external_event_id, synthesis_state FROM team_events
        WHERE space_id = ? AND person_id = ?
      `).all(spaceId, String(identity.person_id)) as Row[];
      const eventIds = eventRows.map((row) => Number(row.id));
      if (eventIds.length === 0) return 0;
      const newlyRedacted = eventRows.filter((row) => row.synthesis_state !== "redacted").length;
      const placeholders = eventIds.map(() => "?").join(",");
      this.db.prepare(`
        DELETE FROM team_knowledge
        WHERE id IN (
          SELECT knowledge_id FROM team_knowledge_evidence
          WHERE event_id IN (${placeholders})
        )
      `).run(...eventIds);
      const erasedEventIds = new Set(eventIds);
      const synthesisRows = this.db.prepare(`
        SELECT id, event_ids_json FROM team_synthesis_runs WHERE space_id = ?
      `).all(spaceId) as Row[];
      for (const row of synthesisRows) {
        let cited: unknown = [];
        try {
          cited = JSON.parse(String(row.event_ids_json));
        } catch {
          cited = [];
        }
        if (
          Array.isArray(cited) &&
          cited.some((eventId) => Number.isSafeInteger(eventId) && erasedEventIds.has(Number(eventId)))
        ) {
          this.db.prepare(`
            UPDATE team_synthesis_runs SET response_json = '' WHERE id = ?
          `).run(row.id as SQLInputValue);
        }
      }
      for (const row of eventRows) {
        this.db.prepare(`
          UPDATE team_interventions SET text = ''
          WHERE space_id = ? AND source_id = ? AND kind = 'proactive'
            AND reply_to_external_event_id = ?
        `).run(spaceId, row.source_id as SQLInputValue, row.external_event_id as SQLInputValue);
      }
      this.db.prepare(`
        UPDATE team_events SET text = '', sender_display_name = '', attachments_json = '[]',
          synthesis_state = 'redacted', redacted_at = ?
        WHERE id IN (${placeholders})
      `).run(now, ...eventIds);
      this.db.prepare(`
        UPDATE team_spaces SET summary_status = 'needs-review', updated_at = ? WHERE id = ?
      `).run(now, spaceId);
      this.db.prepare(`
        UPDATE team_events SET synthesis_state = 'pending'
        WHERE space_id = ? AND synthesis_state = 'synthesized' AND redacted_at IS NULL
      `).run(spaceId);
      return newlyRedacted;
    });
  }

  private setTeamIdentityObservationInTransaction(
    spaceId: string,
    provider: string,
    externalUserId: string,
    enabled: boolean,
    now: number,
  ): void {
    const result = this.db.prepare(`
      UPDATE team_identities SET observation_enabled = ?, last_seen_at = ?
      WHERE space_id = ? AND provider = ? AND external_user_id = ?
    `).run(enabled ? 1 : 0, now, spaceId, provider, externalUserId);
    if (Number(result.changes) > 0) return;
    const personId = StateStore.teamPersonId(spaceId, provider, externalUserId);
    this.db.prepare(`
      INSERT OR IGNORE INTO team_people (id, space_id, display_name, created_at, updated_at)
      VALUES (?, ?, '', ?, ?)
    `).run(personId, spaceId, now, now);
    this.db.prepare(`
      INSERT INTO team_identities
        (space_id, provider, external_user_id, person_id, display_name,
         observation_enabled, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, '', ?, ?, ?)
    `).run(spaceId, provider, externalUserId, personId, enabled ? 1 : 0, now, now);
  }

  purgeExpiredTeamEvidence(
    retentionDays: number,
    now = Date.now() / 1_000,
    retainedSpaceIds: string[] = [],
  ): number {
    if (retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * 86_400;
    return this.transaction(() => {
      const placeholders = retainedSpaceIds.map(() => "?").join(",");
      const result = this.db.prepare(`
        UPDATE team_events SET text = '', attachments_json = '[]',
          synthesis_state = 'redacted', redacted_at = ?
        WHERE occurred_at < ? AND synthesis_state <> 'redacted' AND redacted_at IS NULL
          ${retainedSpaceIds.length > 0 ? `AND space_id NOT IN (${placeholders})` : ""}
      `).run(now, cutoff, ...retainedSpaceIds);
      return Number(result.changes);
    });
  }

  private recoverAfterRestart(): void {
    const now = Date.now() / 1000;
    this.transaction(() => {
      const abandoned = this.db
        .prepare(
          "SELECT runs.id, runs.conversation_id, runs.request_text, runs.access_mode, " +
            "runs.response_mode, runs.started_at, conversations.chat_id, " +
            "conversations.topic_id " +
            "FROM runs JOIN conversations ON conversations.id = runs.conversation_id " +
            "WHERE runs.status = 'running'",
        )
        .all() as Row[];
      const enqueue = this.db.prepare(`
        INSERT INTO pending_inputs
          (conversation_id, telegram_message_id, text, mode, access_mode, telegram_user_id,
           response_mode, created_at)
        VALUES (?, 0, ?, 'followup', ?, 0, ?, ?)
      `);
      const restoreInputs = this.db.prepare(`
        UPDATE pending_inputs
        SET state = 'pending', mode = 'followup', run_id = NULL
        WHERE run_id = ?
      `);
      for (const row of abandoned) {
        const streamed = this.db.prepare(`
          SELECT COUNT(*) AS count FROM run_deliveries
          WHERE run_id = ? AND telegram_message_id IS NOT NULL
        `).get(row.id as SQLInputValue) as Row;
        const safeReadOnlyReplay = row.access_mode === "read-only" && Number(streamed.count) === 0;
        if (safeReadOnlyReplay) {
          const restored = restoreInputs.run(row.id as SQLInputValue);
          if (Number(restored.changes) === 0) {
            enqueue.run(
              row.conversation_id as SQLInputValue,
              row.request_text as SQLInputValue,
              row.access_mode as SQLInputValue,
              row.response_mode as SQLInputValue,
              Number(row.started_at) - 0.000_001,
            );
          }
        } else {
          const notice: RunDeliveryInput = {
            kind: "notice",
            ordinal: 0,
            chatId: Number(row.chat_id),
            topicId: Number(row.topic_id),
            text: row.access_mode === "write"
              ? `⚠️ Run #${Number(row.id)} прерван перезапуском. ` +
                "SUMMING не повторяет write-run автоматически: в workspace могли остаться " +
                `частичные изменения. После проверки используйте /retry ${Number(row.id)}.`
              : `⚠️ Read-only run #${Number(row.id)} прерван после начала Telegram-доставки. ` +
                `Чтобы не создать дубль ответа, повторите его явно через /retry ${Number(row.id)}.`,
          };
          this.db.prepare(`
            INSERT OR IGNORE INTO run_deliveries
              (run_id, conversation_id, kind, ordinal, status, chat_id, topic_id,
               text, parse_mode, payload_digest, attempts, next_attempt_at, last_error,
               created_at, updated_at)
            VALUES (?, ?, 'notice', 0, 'pending', ?, ?, ?, '', ?, 0, ?, '', ?, ?)
          `).run(
            row.id as SQLInputValue,
            row.conversation_id as SQLInputValue,
            Number(row.chat_id),
            Number(row.topic_id),
            notice.text!,
            runDeliveryDigest(notice),
            now,
            now,
            now,
          );
        }
      }
      this.db.prepare(`
        UPDATE run_deliveries
        SET status = 'uncertain',
            last_error = 'SUMMING restarted before delivery was durably confirmed; stored payload will not be resent',
            updated_at = ?
        WHERE status IN ('streaming', 'pending', 'sending')
      `).run(now);
      this.db.prepare(`
        UPDATE run_evidence
        SET freshness = 'unknown',
            freshness_reason = 'runtime restarted before the final workspace state was confirmed',
            updated_at = ?
        WHERE freshness = 'current'
          AND run_id IN (SELECT id FROM runs WHERE status = 'running')
      `).run(now);
      this.db.prepare(`
        UPDATE runs SET status = 'interrupted', error = 'runtime restarted', completed_at = ?
        WHERE status = 'running'
      `).run(now);
      this.db.prepare(`
        UPDATE run_reviews
        SET status = 'interrupted', error = 'runtime restarted', completed_at = ?
        WHERE status = 'running'
      `).run(now);
      this.db.prepare(`
        UPDATE conversations SET active_turn_id = NULL, stream_message_id = NULL, updated_at = ?
        WHERE active_turn_id IS NOT NULL
      `).run(now);
      this.db.exec(
        "UPDATE pending_inputs SET mode = 'followup' WHERE mode = 'steer' AND state = 'pending'",
      );
    });
  }

  recordSecurityEvent(event: SecurityEvent): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO security_events
          (event_type, chat_id, topic_id, message_id, sender_id, project_id,
           detectors_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventType,
        event.chatId,
        event.topicId,
        event.messageId,
        event.senderId,
        event.projectId,
        JSON.stringify(event.detectors),
        event.createdAt ?? Date.now() / 1_000,
      );
    });
  }

  securityEventCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM security_events").get() as Row;
    return Number(row.count);
  }

  private migrateProjectPortalBindings(): void {
    const existing = new Set((this.db.prepare(
      "SELECT conversation_id FROM project_portal_bindings WHERE conversation_id IS NOT NULL",
    ).all() as Row[]).map((row) => String(row.conversation_id)));
    const rows = this.db.prepare(`
      SELECT conversation.*, COALESCE(NULLIF(topic.name, ''),
        'topic ' || CAST(conversation.topic_id AS TEXT)) AS portal_title
      FROM conversations conversation
      LEFT JOIN telegram_topics topic
        ON topic.chat_id = conversation.chat_id AND topic.topic_id = conversation.topic_id
      WHERE conversation.binding_mode = 'external-readonly'
      ORDER BY conversation.project_id, conversation.workspace_id,
        conversation.created_at, conversation.id
    `).all() as Row[];
    for (const row of rows) {
      const conversationId = String(row.id);
      if (existing.has(conversationId)) continue;
      const projectId = String(row.project_id);
      const workspaceId = String(row.workspace_id);
      const current = this.db.prepare(`
        SELECT portal_key, is_default FROM project_portal_bindings
        WHERE project_id = ? AND workspace_id = ? ORDER BY created_at, id
      `).all(projectId, workspaceId) as Row[];
      const usedKeys = new Set(current.map((item) => String(item.portal_key)));
      const base = usedKeys.size === 0
        ? "main"
        : `topic-${Math.max(0, Number(row.topic_id))}`;
      let portalKey = base;
      for (let suffix = 2; usedKeys.has(portalKey); suffix += 1) {
        portalKey = `${base}-${suffix}`.slice(0, 48);
      }
      const isDefault = current.some((item) => Number(item.is_default) === 1) ? 0 : 1;
      const timestamp = Number(row.updated_at ?? row.created_at ?? Date.now() / 1_000);
      this.db.prepare(`
        INSERT INTO project_portal_bindings
          (id, project_id, workspace_id, portal_key, is_default, transport,
           conversation_id, destination_json, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'telegram', ?, ?, ?, ?, ?)
      `).run(
        conversationId,
        projectId,
        workspaceId,
        portalKey,
        isDefault,
        conversationId,
        JSON.stringify({ chatId: Number(row.chat_id), topicId: Number(row.topic_id) }),
        String(row.portal_title),
        timestamp,
        timestamp,
      );
      existing.add(conversationId);
    }
    const groups = this.db.prepare(`
      SELECT DISTINCT project_id, workspace_id FROM project_portal_bindings
    `).all() as Row[];
    for (const group of groups) {
      this.ensureProjectPortalDefault(String(group.project_id), String(group.workspace_id));
    }
  }

  private migrateObserverCustomerChannels(): void {
    const rows = this.db.prepare(`
      SELECT conversation.id AS conversation_id, conversation.chat_id, conversation.topic_id,
        COALESCE(NULLIF(topic.name, ''), 'topic ' || CAST(conversation.topic_id AS TEXT)) AS title,
        conversation.created_at, conversation.updated_at
      FROM conversations conversation
      LEFT JOIN telegram_topics topic
        ON topic.chat_id = conversation.chat_id AND topic.topic_id = conversation.topic_id
      WHERE conversation.binding_mode = 'external-readonly'
    `).all() as Row[];
    for (const row of rows) {
      this.db.prepare(`
        INSERT INTO customer_channels
          (id, chat_id, topic_id, title, legacy_conversation_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, topic_id) DO UPDATE SET
          title = CASE WHEN excluded.title = '' THEN title ELSE excluded.title END,
          legacy_conversation_id = COALESCE(legacy_conversation_id, excluded.legacy_conversation_id),
          updated_at = MAX(updated_at, excluded.updated_at)
      `).run(
        StateStore.customerChannelId(Number(row.chat_id), Number(row.topic_id)),
        row.chat_id as SQLInputValue,
        row.topic_id as SQLInputValue,
        row.title as SQLInputValue,
        row.conversation_id as SQLInputValue,
        row.created_at as SQLInputValue,
        row.updated_at as SQLInputValue,
      );
    }
  }

  private ensureProjectPortalDefault(projectId: string, workspaceId: string): void {
    const selected = this.db.prepare(`
      SELECT id FROM project_portal_bindings
      WHERE project_id = ? AND workspace_id = ? AND is_default = 1 LIMIT 1
    `).get(projectId, workspaceId) as Row | undefined;
    if (selected) return;
    const fallback = this.db.prepare(`
      SELECT id FROM project_portal_bindings
      WHERE project_id = ? AND workspace_id = ? ORDER BY created_at, id LIMIT 1
    `).get(projectId, workspaceId) as Row | undefined;
    if (fallback) {
      this.db.prepare(`
        UPDATE project_portal_bindings SET is_default = 1, updated_at = ? WHERE id = ?
      `).run(Date.now() / 1_000, fallback.id as SQLInputValue);
    }
  }

  private nextProjectPortalKey(
    projectId: string,
    workspaceId: string,
    topicId: number,
  ): string {
    const rows = this.db.prepare(`
      SELECT portal_key FROM project_portal_bindings
      WHERE project_id = ? AND workspace_id = ?
    `).all(projectId, workspaceId) as Row[];
    const used = new Set(rows.map((row) => String(row.portal_key)));
    if (!used.has("main")) return "main";
    const base = `topic-${Math.max(0, topicId)}`;
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix += 1) {
      candidate = `${base}-${suffix}`.slice(0, 48);
    }
    return candidate;
  }

  static conversationId(chatId: number, topicId: number): string {
    const digest = createHash("sha256").update(`${chatId}:${topicId}`).digest("hex").slice(0, 20);
    return `tg-${digest}`;
  }

  bind(
    chatId: number,
    topicId: number,
    projectId: string,
    workspaceId: string,
    role: ConversationRole = "primary",
    portalOptions: ProjectPortalOptions = {},
  ): Conversation {
    const now = Date.now() / 1000;
    const conversationId = StateStore.conversationId(chatId, topicId);
    const bindingMode: StoredConversationBindingMode = role === "observer"
      ? "external-readonly"
      : "project";
    this.transaction(() => {
      const old = this.db
        .prepare("SELECT project_id, workspace_id, binding_mode FROM conversations WHERE id = ?")
        .get(conversationId) as Row | undefined;
      const oldPortal = this.db.prepare(`
        SELECT * FROM project_portal_bindings WHERE conversation_id = ?
      `).get(conversationId) as Row | undefined;
      const changed = Boolean(
        old && (
          old.project_id !== projectId ||
          old.workspace_id !== workspaceId ||
          String(old.binding_mode ?? "project") !== bindingMode
        ),
      );
      if (role === "primary") {
        const existingPrimary = this.db.prepare(`
          SELECT id FROM conversations
          WHERE project_id = ? AND workspace_id = ? AND binding_mode = 'project' AND id <> ?
          ORDER BY created_at, id LIMIT 1
        `).get(projectId, workspaceId, conversationId) as Row | undefined;
        if (existingPrimary) {
          throw new Error(
            "у Project/Workspace уже есть основной рабочий топик; " +
              "сначала отвяжите или перепривяжите его",
          );
        }
      }
      this.db.prepare(`
        INSERT INTO conversations
          (id, chat_id, topic_id, project_id, workspace_id, binding_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          workspace_id = excluded.workspace_id,
          binding_mode = excluded.binding_mode,
          codex_thread_id = CASE WHEN ? THEN NULL ELSE codex_thread_id END,
          codex_thread_capability = CASE WHEN ? THEN '' ELSE codex_thread_capability END,
          previous_codex_thread_id = CASE WHEN ? THEN NULL ELSE previous_codex_thread_id END,
          readonly_codex_thread_id = CASE WHEN ? THEN NULL ELSE readonly_codex_thread_id END,
          active_turn_id = NULL,
          stream_message_id = NULL,
          worktree_path = CASE WHEN ? THEN NULL ELSE worktree_path END,
          updated_at = excluded.updated_at
      `).run(
        conversationId,
        chatId,
        topicId,
        projectId,
        workspaceId,
        bindingMode,
        now,
        now,
        changed ? 1 : 0,
        changed ? 1 : 0,
        changed ? 1 : 0,
        changed ? 1 : 0,
        changed ? 1 : 0,
      );
      if (changed) {
        this.db.prepare(
          "UPDATE pending_inputs SET state = 'consumed' WHERE conversation_id = ? AND state = 'pending'",
        ).run(conversationId);
      }
      if (oldPortal) {
        this.db.prepare("DELETE FROM project_portal_bindings WHERE id = ?")
          .run(oldPortal.id as SQLInputValue);
      }
      if (role === "observer") {
        const portalKey = portalOptions.portalKey === undefined
          ? oldPortal && oldPortal.project_id === projectId && oldPortal.workspace_id === workspaceId
            ? String(oldPortal.portal_key)
            : this.nextProjectPortalKey(projectId, workspaceId, topicId)
          : projectPortalKey(portalOptions.portalKey);
        const existingDefault = this.db.prepare(`
          SELECT id FROM project_portal_bindings
          WHERE project_id = ? AND workspace_id = ? AND is_default = 1 LIMIT 1
        `).get(projectId, workspaceId) as Row | undefined;
        const isDefault = portalOptions.isDefault === undefined
          ? oldPortal && oldPortal.project_id === projectId && oldPortal.workspace_id === workspaceId
            ? Number(oldPortal.is_default) === 1
            : !existingDefault
          : portalOptions.isDefault;
        if (isDefault) {
          this.db.prepare(`
            UPDATE project_portal_bindings SET is_default = 0, updated_at = ?
            WHERE project_id = ? AND workspace_id = ?
          `).run(now, projectId, workspaceId);
        }
        const topic = this.telegramTopic(chatId, topicId);
        this.db.prepare(`
          INSERT INTO project_portal_bindings
            (id, project_id, workspace_id, portal_key, is_default, transport,
             conversation_id, destination_json, title, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'telegram', ?, ?, ?, ?, ?)
        `).run(
          conversationId,
          projectId,
          workspaceId,
          portalKey,
          isDefault ? 1 : 0,
          conversationId,
          JSON.stringify({ chatId, topicId }),
          topic?.name || `topic ${topicId}`,
          oldPortal?.created_at ?? now,
          now,
        );
        this.ensureProjectPortalDefault(projectId, workspaceId);
        this.ensureCustomerChannel(
          chatId,
          topicId,
          topic?.name || `topic ${topicId}`,
          conversationId,
        );
      }
      if (oldPortal && (
        oldPortal.project_id !== projectId || oldPortal.workspace_id !== workspaceId ||
        role !== "observer"
      )) {
        this.ensureProjectPortalDefault(
          String(oldPortal.project_id),
          String(oldPortal.workspace_id),
        );
      }
      if (role === "primary") {
        this.db.prepare(`
          UPDATE customer_channels SET legacy_conversation_id = NULL, updated_at = ?
          WHERE legacy_conversation_id = ?
        `).run(now, conversationId);
      }
    });
    return this.get(conversationId);
  }

  unbind(chatId: number, topicId: number): Conversation | null {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM conversations WHERE chat_id = ? AND topic_id = ?")
        .get(chatId, topicId) as Row | undefined;
      if (!row) return null;
      const portal = this.db.prepare(`
        SELECT project_id, workspace_id FROM project_portal_bindings WHERE conversation_id = ?
      `).get(row.id as SQLInputValue) as Row | undefined;
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(row.id as SQLInputValue);
      if (portal) {
        this.ensureProjectPortalDefault(String(portal.project_id), String(portal.workspace_id));
      }
      return this.toConversation(row);
    });
  }

  get(conversationId: string): Conversation {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId);
    if (!row) throw new Error(`unknown conversation: ${conversationId}`);
    return this.toConversation(row as Row);
  }

  byTopic(chatId: number, topicId: number): Conversation | null {
    const row = this.db
      .prepare(`
        SELECT * FROM conversations
        WHERE chat_id = ? AND topic_id = ? AND binding_mode = 'project'
      `)
      .get(chatId, topicId);
    return row ? this.toConversation(row as Row) : null;
  }

  topicConversation(chatId: number, topicId: number): Conversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE chat_id = ? AND topic_id = ?")
      .get(chatId, topicId);
    return row ? this.toConversation(row as Row) : null;
  }

  listConversations(): Conversation[] {
    return (this.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all() as Row[])
      .map((row) => this.toConversation(row));
  }

  primaryConversation(projectId: string, workspaceId: string): Conversation | null {
    const row = this.db.prepare(`
      SELECT * FROM conversations
      WHERE project_id = ? AND workspace_id = ? AND binding_mode = 'project'
      ORDER BY created_at, id LIMIT 1
    `).get(projectId, workspaceId) as Row | undefined;
    return row ? this.toConversation(row) : null;
  }

  private toConversation(row: Row): Conversation {
    return {
      id: String(row.id),
      chatId: Number(row.chat_id),
      topicId: Number(row.topic_id),
      projectId: String(row.project_id),
      workspaceId: String(row.workspace_id),
      role: String(row.binding_mode ?? "project") === "external-readonly"
        ? "observer"
        : "primary",
      codexThreadId: row.codex_thread_id === null ? null : String(row.codex_thread_id),
      codexThreadCapability: String(row.codex_thread_capability ?? ""),
      previousCodexThreadId:
        row.previous_codex_thread_id === null ? null : String(row.previous_codex_thread_id),
      readOnlyCodexThreadId:
        row.readonly_codex_thread_id === null ? null : String(row.readonly_codex_thread_id),
      activeTurnId: row.active_turn_id === null ? null : String(row.active_turn_id),
      streamMessageId: row.stream_message_id === null ? null : Number(row.stream_message_id),
      worktreePath: row.worktree_path === null ? null : String(row.worktree_path),
    };
  }

  private toCustomerChannel(row: Row): CustomerChannel {
    return {
      id: String(row.id),
      chatId: Number(row.chat_id),
      topicId: Number(row.topic_id),
      title: String(row.title ?? ""),
      legacyConversationId:
        row.legacy_conversation_id === null ? null : String(row.legacy_conversation_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private toResultPublication(row: Row): ResultPublication {
    return {
      id: String(row.id),
      channelId: String(row.channel_id),
      projectId: String(row.project_id),
      workspaceId: String(row.workspace_id),
      jobId: String(row.job_id),
      scheduleId: row.schedule_id === null ? null : String(row.schedule_id),
      outboxId: String(row.outbox_id),
      reportText: String(row.report_text ?? ""),
      artifactName: row.artifact_name === null ? null : String(row.artifact_name),
      telegramMessageId: Number(row.telegram_message_id),
      createdAt: Number(row.created_at),
    };
  }

  private toResultDiscussionMessage(row: Row): ResultDiscussionMessage {
    return {
      publicationId: String(row.publication_id),
      chatId: Number(row.chat_id),
      topicId: Number(row.topic_id),
      telegramMessageId: Number(row.telegram_message_id),
      author: String(row.author) as ResultMessageAuthor,
      senderId: Number(row.sender_id),
      text: String(row.text ?? ""),
      createdAt: Number(row.created_at),
    };
  }

  private toProjectFeedback(row: Row): ProjectFeedback {
    return {
      id: Number(row.id),
      publicationId: String(row.publication_id),
      channelId: String(row.channel_id),
      projectId: String(row.project_id),
      workspaceId: String(row.workspace_id),
      teamEventId: row.team_event_id === null ? null : Number(row.team_event_id),
      telegramMessageId: Number(row.telegram_message_id),
      senderId: Number(row.sender_id),
      text: String(row.text ?? ""),
      status: String(row.status) as ProjectFeedback["status"],
      createdAt: Number(row.created_at),
    };
  }

  setThread(
    conversationId: string,
    threadId: string | null,
    access: RunAccess = "write",
    capability = "",
  ): void {
    if (access === "read-only") {
      this.updateConversation(conversationId, "readonly_codex_thread_id", threadId);
      return;
    }
    this.transaction(() => {
      this.db.prepare(`
        UPDATE conversations
        SET codex_thread_id = ?, codex_thread_capability = ?, updated_at = ?
        WHERE id = ?
      `).run(threadId, threadId ? capability : "", Date.now() / 1000, conversationId);
    });
  }

  archiveWriteThreadForCapability(conversationId: string, capability: string): string | null {
    if (!capability.trim()) throw new Error("write thread capability must not be empty");
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT codex_thread_id, codex_thread_capability
        FROM conversations WHERE id = ?
      `).get(conversationId) as Row | undefined;
      if (!row) throw new Error(`unknown conversation: ${conversationId}`);
      const threadId = row.codex_thread_id === null ? null : String(row.codex_thread_id);
      if (!threadId || String(row.codex_thread_capability ?? "") === capability) return null;
      this.db.prepare(`
        UPDATE conversations
        SET previous_codex_thread_id = codex_thread_id,
            codex_thread_id = NULL,
            codex_thread_capability = '',
            updated_at = ?
        WHERE id = ?
      `).run(Date.now() / 1000, conversationId);
      return threadId;
    });
  }

  setWorktree(conversationId: string, path: string): void {
    this.updateConversation(conversationId, "worktree_path", path);
  }

  setActive(conversationId: string, turnId: string | null, streamMessageId: number | null): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE conversations SET active_turn_id = ?, stream_message_id = ?, updated_at = ?
        WHERE id = ?
      `).run(turnId, streamMessageId, Date.now() / 1000, conversationId);
    });
  }

  clearActive(conversationId: string): void {
    this.setActive(conversationId, null, null);
  }

  private updateConversation(
    conversationId: string,
    field: "codex_thread_id" | "readonly_codex_thread_id" | "worktree_path",
    value: SQLInputValue,
  ): void {
    this.transaction(() => {
      this.db.prepare(
        `UPDATE conversations SET ${field} = ?, updated_at = ? WHERE id = ?`,
      ).run(value, Date.now() / 1000, conversationId);
    });
  }

  enqueueInput(
    conversationId: string,
    telegramMessageId: number,
    text: string,
    mode: "steer" | "followup",
    access: RunAccess = "write",
    senderId = 0,
    responseMode: ResponseMode = "direct",
    attachments: StoredAttachment[] = [],
    audioTranscript: AudioTranscript | null = null,
    retryOfRunId: number | null = null,
  ): number {
    return this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO pending_inputs
          (conversation_id, telegram_message_id, text, mode, access_mode, telegram_user_id,
           response_mode, attachments_json, audio_transcript_json, retry_of_run_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conversationId,
        telegramMessageId,
        text,
        mode,
        access,
        senderId,
        responseMode,
        JSON.stringify(attachments),
        audioTranscript ? JSON.stringify(audioTranscript) : "",
        retryOfRunId,
        Date.now() / 1000,
      );
      return Number(result.lastInsertRowid);
    });
  }

  retryInterruptedRun(
    conversationId: string,
    runId: number,
    telegramMessageId: number,
    actorUserId: number,
  ): number {
    if (
      !Number.isSafeInteger(runId) ||
      runId <= 0 ||
      !Number.isSafeInteger(telegramMessageId) ||
      telegramMessageId <= 0 ||
      !Number.isSafeInteger(actorUserId) ||
      actorUserId <= 0
    ) {
      throw new Error("retry request is invalid");
    }
    return this.transaction(() => {
      const run = this.db.prepare(`
        SELECT conversation_id, request_text, access_mode, response_mode, status
        FROM runs WHERE id = ?
      `).get(runId) as Row | undefined;
      if (!run || String(run.conversation_id) !== conversationId) {
        throw new Error("interrupted run was not found in this Conversation");
      }
      if (run.status !== "interrupted") {
        throw new Error(`run #${runId} is ${String(run.status)}, not interrupted`);
      }
      const pendingRetry = this.db.prepare(`
        SELECT 1 FROM pending_inputs
        WHERE conversation_id = ? AND retry_of_run_id = ? AND state = 'pending'
        LIMIT 1
      `).get(conversationId, runId);
      const runningRetry = this.db.prepare(`
        SELECT 1 FROM runs WHERE retry_of_run_id = ? AND status = 'running' LIMIT 1
      `).get(runId);
      if (pendingRetry || runningRetry) throw new Error(`run #${runId} is already queued`);
      const originals = this.db.prepare(`
        SELECT attachments_json, audio_transcript_json
        FROM pending_inputs WHERE run_id = ? ORDER BY id
      `).all(runId) as Row[];
      const attachments = originals.flatMap((row) => {
        try {
          return storedAttachments(JSON.parse(String(row.attachments_json ?? "[]")));
        } catch {
          return [];
        }
      });
      const audioTranscript = [...originals].reverse()
        .map((row) => String(row.audio_transcript_json ?? ""))
        .find(Boolean) ?? "";
      const result = this.db.prepare(`
        INSERT INTO pending_inputs
          (conversation_id, telegram_message_id, text, mode, access_mode, telegram_user_id,
           response_mode, attachments_json, audio_transcript_json, retry_of_run_id, created_at)
        VALUES (?, ?, ?, 'followup', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        conversationId,
        telegramMessageId,
        run.request_text as SQLInputValue,
        run.access_mode as SQLInputValue,
        actorUserId,
        run.response_mode as SQLInputValue,
        JSON.stringify(attachments),
        audioTranscript,
        runId,
        Date.now() / 1_000,
      );
      return Number(result.lastInsertRowid);
    });
  }

  pending(
    conversationId: string,
    mode: "steer" | "followup",
    access: RunAccess = "write",
  ): PendingInput[] {
    const rows = this.db.prepare(`
      SELECT id, conversation_id, telegram_message_id, text, mode, access_mode,
             telegram_user_id, response_mode, attachments_json, audio_transcript_json,
             retry_of_run_id, created_at
      FROM pending_inputs
      WHERE conversation_id = ? AND mode = ? AND access_mode = ? AND state = 'pending'
      ORDER BY created_at, id
    `).all(conversationId, mode, access) as Row[];
    return rows.map((row) => this.toPending(row));
  }

  pendingAll(conversationId: string): PendingInput[] {
    const rows = this.db.prepare(`
      SELECT id, conversation_id, telegram_message_id, text, mode, access_mode,
             telegram_user_id, response_mode, attachments_json, audio_transcript_json,
             retry_of_run_id, created_at
      FROM pending_inputs
      WHERE conversation_id = ? AND state = 'pending'
      ORDER BY created_at, id
    `).all(conversationId) as Row[];
    return rows.map((row) => this.toPending(row));
  }

  private toPending(row: Row): PendingInput {
    let attachments: StoredAttachment[] = [];
    let audioTranscript: AudioTranscript | null = null;
    try {
      const value = JSON.parse(String(row.attachments_json ?? "[]"));
      attachments = storedAttachments(value);
    } catch {
      console.warn(`discarding invalid attachment metadata for pending input ${String(row.id)}`);
    }
    try {
      const value = JSON.parse(String(row.audio_transcript_json || "null")) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const candidate = value as Record<string, unknown>;
        if (typeof candidate.fileName === "string" && typeof candidate.text === "string") {
          audioTranscript = { fileName: candidate.fileName, text: candidate.text };
        }
      }
    } catch {
      console.warn(`discarding invalid audio transcript for pending input ${String(row.id)}`);
    }
    return {
      id: Number(row.id),
      conversationId: String(row.conversation_id),
      telegramMessageId: Number(row.telegram_message_id),
      text: String(row.text),
      mode: String(row.mode) as PendingInput["mode"],
      access: String(row.access_mode) as RunAccess,
      senderId: Number(row.telegram_user_id),
      responseMode: String(row.response_mode) as ResponseMode,
      attachments,
      audioTranscript,
      retryOfRunId: row.retry_of_run_id === null ? null : Number(row.retry_of_run_id),
      createdAt: Number(row.created_at),
    };
  }

  consume(inputIds: number[]): void {
    if (inputIds.length === 0) return;
    const placeholders = inputIds.map(() => "?").join(",");
    this.transaction(() => {
      this.db.prepare(
        `UPDATE pending_inputs SET state = 'consumed' WHERE id IN (${placeholders})`,
      ).run(...inputIds);
    });
  }

  startRun(
    conversationId: string,
    prompt: string,
    inputIds: number[] = [],
    access: RunAccess = "write",
    responseMode: ResponseMode = "direct",
    actorUserId = 0,
    retryOfRunId: number | null = null,
  ): number {
    return this.transaction(() => {
      const conversation = this.db.prepare(`
        SELECT project_id, workspace_id FROM conversations WHERE id = ?
      `).get(conversationId) as Row | undefined;
      if (!conversation) throw new Error("run conversation was not found");
      if (!Number.isSafeInteger(actorUserId) || actorUserId < 0) {
        throw new Error("run actor user id is invalid");
      }
      if (
        retryOfRunId !== null &&
        (!Number.isSafeInteger(retryOfRunId) || retryOfRunId <= 0)
      ) {
        throw new Error("retry run id is invalid");
      }
      const result = this.db.prepare(`
        INSERT INTO runs
          (conversation_id, project_id, workspace_id, actor_user_id, status, access_mode,
           response_mode, request_text, prompt, retry_of_run_id, started_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)
      `).run(
        conversationId,
        conversation.project_id as SQLInputValue,
        conversation.workspace_id as SQLInputValue,
        actorUserId,
        access,
        responseMode,
        prompt,
        prompt,
        retryOfRunId,
        Date.now() / 1000,
      );
      if (inputIds.length > 0) {
        const placeholders = inputIds.map(() => "?").join(",");
        this.db.prepare(
          `UPDATE pending_inputs SET state = 'consumed', run_id = ? ` +
            `WHERE id IN (${placeholders})`,
        ).run(Number(result.lastInsertRowid), ...inputIds);
      }
      return Number(result.lastInsertRowid);
    });
  }

  attachTurn(runId: number, turnId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE runs SET turn_id = ? WHERE id = ?").run(turnId, runId);
    });
  }

  setRunPrompt(runId: number, prompt: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE runs SET prompt = ? WHERE id = ?").run(prompt, runId);
    });
  }

  finishRun(runId: number, status: string, response: string, error: string | null = null): void {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE runs SET status = ?, response = ?, error = ?, completed_at = ? WHERE id = ?
      `).run(status, response, error, Date.now() / 1000, runId);
    });
  }

  finishRunWithDeliveries(
    runId: number,
    status: string,
    response: string,
    error: string | null,
    deliveries: RunDeliveryInput[],
  ): RunDelivery[] {
    for (const delivery of deliveries) validateRunDeliveryInput(delivery);
    const now = Date.now() / 1_000;
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT conversation_id, status FROM runs WHERE id = ?
      `).get(runId) as Row | undefined;
      if (!row) throw new Error("run was not found");
      if (String(row.status) !== "running") {
        throw new Error(`run ${runId} is already ${String(row.status)}`);
      }
      this.db.prepare(`
        UPDATE runs SET status = ?, response = ?, error = ?, completed_at = ? WHERE id = ?
      `).run(status, response, error, now, runId);
      const upsert = this.db.prepare(`
        INSERT INTO run_deliveries
          (run_id, conversation_id, kind, ordinal, status, chat_id, topic_id,
           reply_to_message_id, text, parse_mode, attachment_path, file_name, mime_type,
           attachment_size, attachment_sha256, payload_digest, telegram_message_id,
           attempts, next_attempt_at, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '', ?, ?)
        ON CONFLICT(run_id, kind, ordinal) DO UPDATE SET
          status = CASE
            WHEN run_deliveries.status = 'sent' THEN 'sent'
            ELSE 'pending'
          END,
          chat_id = excluded.chat_id,
          topic_id = excluded.topic_id,
          reply_to_message_id = excluded.reply_to_message_id,
          text = excluded.text,
          parse_mode = excluded.parse_mode,
          attachment_path = excluded.attachment_path,
          file_name = excluded.file_name,
          mime_type = excluded.mime_type,
          attachment_size = excluded.attachment_size,
          attachment_sha256 = excluded.attachment_sha256,
          payload_digest = excluded.payload_digest,
          telegram_message_id = COALESCE(
            run_deliveries.telegram_message_id,
            excluded.telegram_message_id
          ),
          next_attempt_at = excluded.next_attempt_at,
          last_error = '',
          updated_at = excluded.updated_at
      `);
      const keys = new Set<string>();
      for (const delivery of deliveries) {
        keys.add(`${delivery.kind}:${delivery.ordinal}`);
        upsert.run(
          runId,
          row.conversation_id as SQLInputValue,
          delivery.kind,
          delivery.ordinal,
          delivery.chatId,
          delivery.topicId,
          delivery.replyToMessageId ?? null,
          delivery.text ?? "",
          delivery.parseMode ?? "",
          delivery.attachmentPath ?? "",
          delivery.fileName ?? "",
          delivery.mimeType ?? "",
          delivery.attachmentSize ?? 0,
          delivery.attachmentSha256 ?? "",
          runDeliveryDigest(delivery),
          delivery.telegramMessageId ?? null,
          now,
          now,
          now,
        );
      }
      const existing = this.db.prepare(`
        SELECT id, kind, ordinal FROM run_deliveries
        WHERE run_id = ? AND status = 'streaming'
      `).all(runId) as Row[];
      const cancel = this.db.prepare(`
        UPDATE run_deliveries SET status = 'cancelled', updated_at = ? WHERE id = ?
      `);
      for (const delivery of existing) {
        if (!keys.has(`${String(delivery.kind)}:${Number(delivery.ordinal)}`)) {
          cancel.run(now, delivery.id as SQLInputValue);
        }
      }
      return this.runDeliveries(runId);
    });
  }

  recordRunStream(
    runId: number,
    destination: {
      chatId: number;
      topicId: number;
      replyToMessageId: number | null;
    },
    chunks: Array<{ text: string; telegramMessageId: number | null }>,
  ): void {
    const now = Date.now() / 1_000;
    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT conversation_id, status FROM runs WHERE id = ?
      `).get(runId) as Row | undefined;
      if (!row || row.status !== "running") return;
      const keep = new Set<number>();
      const upsert = this.db.prepare(`
        INSERT INTO run_deliveries
          (run_id, conversation_id, kind, ordinal, status, chat_id, topic_id,
           reply_to_message_id, text, parse_mode, payload_digest, telegram_message_id,
           attempts, next_attempt_at, last_error, created_at, updated_at)
        VALUES (?, ?, 'response', ?, 'streaming', ?, ?, ?, ?, 'HTML', ?, ?, 0, ?, '', ?, ?)
        ON CONFLICT(run_id, kind, ordinal) DO UPDATE SET
          text = excluded.text,
          payload_digest = excluded.payload_digest,
          telegram_message_id = COALESCE(
            excluded.telegram_message_id,
            run_deliveries.telegram_message_id
          ),
          updated_at = excluded.updated_at
        WHERE run_deliveries.status = 'streaming'
      `);
      for (const [ordinal, chunk] of chunks.entries()) {
        const input: RunDeliveryInput = {
          kind: "response",
          ordinal,
          chatId: destination.chatId,
          topicId: destination.topicId,
          replyToMessageId: destination.replyToMessageId,
          text: chunk.text,
          parseMode: "HTML",
          telegramMessageId: chunk.telegramMessageId,
        };
        validateRunDeliveryInput(input);
        keep.add(ordinal);
        upsert.run(
          runId,
          row.conversation_id as SQLInputValue,
          ordinal,
          destination.chatId,
          destination.topicId,
          destination.replyToMessageId,
          chunk.text,
          runDeliveryDigest(input),
          chunk.telegramMessageId,
          now,
          now,
          now,
        );
      }
      const stale = this.db.prepare(`
        SELECT id, ordinal FROM run_deliveries
        WHERE run_id = ? AND kind = 'response' AND status = 'streaming'
      `).all(runId) as Row[];
      const cancel = this.db.prepare(`
        UPDATE run_deliveries SET status = 'cancelled', updated_at = ? WHERE id = ?
      `);
      for (const delivery of stale) {
        if (!keep.has(Number(delivery.ordinal))) cancel.run(now, delivery.id as SQLInputValue);
      }
    });
  }

  runDeliveries(runId: number): RunDelivery[] {
    return (this.db.prepare(`
      SELECT * FROM run_deliveries WHERE run_id = ? ORDER BY kind, ordinal, id
    `).all(runId) as Row[]).map(runDelivery);
  }

  recordRunCommandEvidence(runId: number, input: RunCommandEvidenceInput): RunEvidence {
    if (
      !Number.isSafeInteger(runId) || runId <= 0 ||
      !input.itemId.trim() ||
      !/^[a-f0-9]{64}$/.test(input.commandDigest) ||
      !/^[a-f0-9]{64}$/.test(input.outputDigest) ||
      (input.exitCode !== null && !Number.isSafeInteger(input.exitCode)) ||
      (input.durationMs !== null && (!Number.isFinite(input.durationMs) || input.durationMs < 0)) ||
      input.outputExcerpt.length > 4_096 ||
      input.redactionKinds.some((kind) => !/^[a-z0-9-]{1,80}$/.test(kind))
    ) {
      throw new Error("invalid run command evidence");
    }
    const now = Date.now() / 1_000;
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM run_evidence WHERE run_id = ? AND item_id = ?
      `).get(runId, input.itemId) as Row | undefined;
      if (existing) return runEvidence(existing);
      const run = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
        | Row
        | undefined;
      if (!run) throw new Error("run was not found");
      if (String(run.status) !== "running") throw new Error("run is not active");
      this.db.prepare(`
        UPDATE run_evidence
        SET freshness = 'stale',
            freshness_reason = 'a later command completed in the same run',
            updated_at = ?
        WHERE run_id = ? AND freshness = 'current'
      `).run(now, runId);
      const sequenceRow = this.db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_evidence WHERE run_id = ?
      `).get(runId) as Row;
      this.db.prepare(`
        INSERT INTO run_evidence
          (run_id, item_id, sequence, command, command_digest, cwd, status, exit_code,
           duration_ms, output_digest, output_excerpt, redaction_kinds_json,
           freshness, freshness_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current',
                'no later observable workspace event in this run', ?, ?)
      `).run(
        runId,
        input.itemId.trim(),
        Number(sequenceRow.sequence),
        input.command,
        input.commandDigest,
        input.cwd,
        input.status,
        input.exitCode,
        input.durationMs,
        input.outputDigest,
        input.outputExcerpt,
        JSON.stringify([...new Set(input.redactionKinds)].sort()),
        now,
        now,
      );
      return runEvidence(this.db.prepare(`
        SELECT * FROM run_evidence WHERE run_id = ? AND item_id = ?
      `).get(runId, input.itemId) as Row);
    });
  }

  markRunEvidenceStale(runId: number, reason: string): void {
    if (!Number.isSafeInteger(runId) || runId <= 0) return;
    const normalized = reason.trim().slice(0, 240) || "a later workspace event was observed";
    const now = Date.now() / 1_000;
    this.db.prepare(`
      UPDATE run_evidence
      SET freshness = 'stale', freshness_reason = ?, updated_at = ?
      WHERE run_id = ? AND freshness = 'current'
    `).run(normalized, now, runId);
  }

  runEvidence(runId: number): RunEvidence[] {
    if (!Number.isSafeInteger(runId) || runId <= 0) return [];
    return (this.db.prepare(`
      SELECT * FROM run_evidence WHERE run_id = ? ORDER BY sequence, id
    `).all(runId) as Row[]).map(runEvidence);
  }

  startRunReview(
    runId: number,
    sourceThreadId: string,
    reviewThreadId: string,
    turnId: string,
    beforeRevision: string,
  ): RunReview {
    if (
      !Number.isSafeInteger(runId) || runId <= 0 ||
      !sourceThreadId.trim() || !reviewThreadId.trim() || !turnId.trim() ||
      !beforeRevision.trim()
    ) {
      throw new Error("invalid run review");
    }
    const now = Date.now() / 1_000;
    return this.transaction(() => {
      const run = this.db.prepare(`
        SELECT conversation_id, status FROM runs WHERE id = ?
      `).get(runId) as Row | undefined;
      if (!run || String(run.status) !== "running") throw new Error("run is not active");
      this.db.prepare(`
        INSERT INTO run_reviews
          (run_id, conversation_id, source_thread_id, review_thread_id, turn_id,
           status, before_revision, started_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(
        runId,
        run.conversation_id as SQLInputValue,
        sourceThreadId,
        reviewThreadId,
        turnId,
        beforeRevision,
        now,
      );
      return this.runReview(runId)!;
    });
  }

  finishRunReview(
    runId: number,
    status: string,
    findings: string,
    afterRevision: string,
    workspaceChanged: boolean,
    error: string | null,
  ): RunReview {
    const now = Date.now() / 1_000;
    this.db.prepare(`
      UPDATE run_reviews
      SET status = ?, findings = ?, after_revision = ?, workspace_changed = ?,
          error = ?, completed_at = ?
      WHERE run_id = ? AND status = 'running'
    `).run(
      status.slice(0, 80),
      findings,
      afterRevision,
      workspaceChanged ? 1 : 0,
      error?.slice(0, 1_000) ?? "",
      now,
      runId,
    );
    const review = this.runReview(runId);
    if (!review) throw new Error("run review was not found");
    return review;
  }

  runReview(runId: number): RunReview | null {
    if (!Number.isSafeInteger(runId) || runId <= 0) return null;
    const row = this.db.prepare("SELECT * FROM run_reviews WHERE run_id = ?").get(runId) as
      | Row
      | undefined;
    return row ? runReview(row) : null;
  }

  conversationRunReviews(conversationId: string, limit = 20): RunReview[] {
    const count = Math.max(1, Math.min(100, Math.trunc(limit)));
    return (this.db.prepare(`
      SELECT * FROM run_reviews WHERE conversation_id = ?
      ORDER BY started_at DESC, id DESC LIMIT ?
    `).all(conversationId, count) as Row[]).map(runReview);
  }

  projectRun(
    projectId: string,
    workspaceId: string,
    runId: number,
  ): ProjectRunHistory | null {
    if (!Number.isSafeInteger(runId) || runId <= 0) return null;
    const row = this.db.prepare(`
      SELECT * FROM runs WHERE id = ? AND project_id = ? AND workspace_id = ?
    `).get(runId, projectId, workspaceId) as Row | undefined;
    return row ? projectRunHistory(row) : null;
  }

  recentProjectRuns(
    projectId: string,
    workspaceId: string,
    limit = 10,
    beforeRunId?: number,
    excludeRunId?: number,
  ): ProjectRunHistory[] {
    const count = Math.max(1, Math.min(50, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT * FROM runs
      WHERE project_id = ? AND workspace_id = ?
        AND (? IS NULL OR id < ?)
        AND (? IS NULL OR id <> ?)
      ORDER BY id DESC LIMIT ?
    `).all(
      projectId,
      workspaceId,
      beforeRunId ?? null,
      beforeRunId ?? null,
      excludeRunId ?? null,
      excludeRunId ?? null,
      count,
    ) as Row[];
    return rows.map(projectRunHistory);
  }

  searchProjectRuns(
    projectId: string,
    workspaceId: string,
    query: string,
    limit = 10,
    excludeRunId?: number,
  ): ProjectRunHistory[] {
    const terms = query.trim().split(/\s+/u).filter(Boolean).slice(0, 20);
    if (terms.length === 0) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    const count = Math.max(1, Math.min(50, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT runs.*
      FROM run_history_fts
      JOIN runs ON runs.id = CAST(run_history_fts.run_id AS INTEGER)
      WHERE run_history_fts MATCH ?
        AND runs.project_id = ? AND runs.workspace_id = ?
        AND (? IS NULL OR runs.id <> ?)
      ORDER BY bm25(run_history_fts), runs.id DESC
      LIMIT ?
    `).all(
      match,
      projectId,
      workspaceId,
      excludeRunId ?? null,
      excludeRunId ?? null,
      count,
    ) as Row[];
    return rows.map(projectRunHistory);
  }

  initializeProjectMemory(projectId: string, legacyMarkdown: string): number {
    if (!projectId.trim()) throw new Error("project id is required");
    const legacyDigest = createHash("sha256").update(legacyMarkdown).digest("hex");
    const now = Date.now() / 1_000;
    return this.transaction(() => {
      const migrated = this.db.prepare(`
        SELECT project_id FROM project_memory_migrations WHERE project_id = ?
      `).get(projectId) as Row | undefined;
      if (migrated) return 0;
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO project_memory_items
          (project_id, kind, status, text, content_digest, source, source_run_id,
           created_by, supersedes_id, created_at, updated_at)
        VALUES (?, 'note', 'active', ?, ?, 'legacy', NULL, 0, NULL, ?, ?)
      `);
      let imported = 0;
      for (const candidate of legacyProjectMemoryItems(legacyMarkdown)) {
        if (Array.from(candidate).length > 2_000) continue;
        const text = normalizedProjectMemoryText(candidate);
        const digest = createHash("sha256").update(text).digest("hex");
        imported += Number(insert.run(projectId, text, digest, now, now).changes);
      }
      this.db.prepare(`
        INSERT INTO project_memory_migrations
          (project_id, legacy_digest, imported_items, migrated_at)
        VALUES (?, ?, ?, ?)
      `).run(projectId, legacyDigest, imported, now);
      return imported;
    });
  }

  rememberProjectMemory(
    projectId: string,
    kind: ProjectMemoryKind,
    textValue: string,
    source: ProjectMemoryItem["source"],
    createdBy: number,
    sourceRunId: number | null = null,
  ): ProjectMemoryItem {
    if (!projectId.trim() || !["fact", "decision", "preference", "constraint", "note"].includes(kind)) {
      throw new Error("invalid project memory scope or kind");
    }
    if (!Number.isSafeInteger(createdBy) || createdBy < 0) {
      throw new Error("invalid project memory actor");
    }
    const text = normalizedProjectMemoryText(textValue);
    const digest = createHash("sha256").update(text).digest("hex");
    const now = Date.now() / 1_000;
    return this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO project_memory_items
          (project_id, kind, status, text, content_digest, source, source_run_id,
           created_by, supersedes_id, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(projectId, kind, text, digest, source, sourceRunId, createdBy, now, now);
      const row = this.db.prepare(`
        SELECT * FROM project_memory_items
        WHERE project_id = ? AND content_digest = ? AND status = 'active'
      `).get(projectId, digest) as Row;
      return projectMemoryItem(row);
    });
  }

  supersedeProjectMemory(
    projectId: string,
    itemId: number,
    kind: ProjectMemoryKind,
    textValue: string,
    source: "user" | "codex",
    createdBy: number,
    sourceRunId: number | null = null,
  ): ProjectMemoryItem {
    if (
      !Number.isSafeInteger(itemId) || itemId <= 0 ||
      !["fact", "decision", "preference", "constraint", "note"].includes(kind) ||
      !Number.isSafeInteger(createdBy) || createdBy < 0
    ) {
      throw new Error("invalid project memory replacement");
    }
    const text = normalizedProjectMemoryText(textValue);
    const digest = createHash("sha256").update(text).digest("hex");
    const now = Date.now() / 1_000;
    return this.transaction(() => {
      const previous = this.db.prepare(`
        SELECT * FROM project_memory_items
        WHERE id = ? AND project_id = ? AND status = 'active'
      `).get(itemId, projectId) as Row | undefined;
      if (!previous) throw new Error("active project memory item was not found");
      this.db.prepare(`
        UPDATE project_memory_items SET status = 'superseded', updated_at = ? WHERE id = ?
      `).run(now, itemId);
      const result = this.db.prepare(`
        INSERT INTO project_memory_items
          (project_id, kind, status, text, content_digest, source, source_run_id,
           created_by, supersedes_id, created_at, updated_at)
        VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        kind,
        text,
        digest,
        source,
        sourceRunId,
        createdBy,
        itemId,
        now,
        now,
      );
      return projectMemoryItem(this.db.prepare(`
        SELECT * FROM project_memory_items WHERE id = ?
      `).get(result.lastInsertRowid) as Row);
    });
  }

  archiveProjectMemory(projectId: string, itemId: number): ProjectMemoryItem {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      throw new Error("invalid project memory item id");
    }
    const now = Date.now() / 1_000;
    const result = this.db.prepare(`
      UPDATE project_memory_items SET status = 'archived', updated_at = ?
      WHERE id = ? AND project_id = ? AND status = 'active'
    `).run(now, itemId, projectId);
    if (Number(result.changes) === 0) throw new Error("active project memory item was not found");
    return projectMemoryItem(this.db.prepare(`
      SELECT * FROM project_memory_items WHERE id = ?
    `).get(itemId) as Row);
  }

  projectMemoryItems(
    projectId: string,
    includeInactive = false,
    limit = 200,
  ): ProjectMemoryItem[] {
    const count = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    return (this.db.prepare(`
      SELECT * FROM project_memory_items
      WHERE project_id = ? AND (? = 1 OR status = 'active')
      ORDER BY CASE kind
        WHEN 'constraint' THEN 1 WHEN 'decision' THEN 2 WHEN 'preference' THEN 3
        WHEN 'fact' THEN 4 ELSE 5 END, id
      LIMIT ?
    `).all(projectId, includeInactive ? 1 : 0, count) as Row[]).map(projectMemoryItem);
  }

  projectMemoryProjection(projectId: string, projectName: string): string {
    const labels: Record<ProjectMemoryKind, string> = {
      constraint: "Constraints",
      decision: "Decisions",
      preference: "Preferences",
      fact: "Facts",
      note: "Notes",
    };
    const items = this.projectMemoryItems(projectId);
    const lines = [
      `# Project memory: ${projectName}`,
      "",
      "<!-- SUMMING structured memory projection; generated from local state. -->",
      "<!-- Use the project_memory host tools; do not edit this file. -->",
    ];
    for (const kind of ["constraint", "decision", "preference", "fact", "note"] as const) {
      const section = items.filter((item) => item.kind === kind);
      if (section.length === 0) continue;
      lines.push("", `## ${labels[kind]}`, "");
      for (const item of section) lines.push(`- [memory:${item.id}] ${item.text}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  runDelivery(id: number): RunDelivery | null {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const row = this.db.prepare("SELECT * FROM run_deliveries WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? runDelivery(row) : null;
  }

  conversationRunDeliveries(conversationId: string, limit = 20): RunDelivery[] {
    const count = Math.max(1, Math.min(100, Math.trunc(limit)));
    return (this.db.prepare(`
      SELECT * FROM run_deliveries
      WHERE conversation_id = ?
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(conversationId, count) as Row[]).map(runDelivery);
  }

  claimRunDeliveries(
    runId: number,
    limit = 20,
    now = Date.now() / 1_000,
  ): RunDelivery[] {
    const count = Math.max(1, Math.min(100, Math.trunc(limit)));
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      throw new Error("run id is invalid");
    }
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id FROM run_deliveries
        WHERE run_id = ? AND status IN ('pending', 'failed') AND next_attempt_at <= ?
        ORDER BY next_attempt_at, id LIMIT ?
      `).all(runId, now, count) as Row[];
      const claim = this.db.prepare(`
        UPDATE run_deliveries
        SET status = 'sending', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'failed')
      `);
      const claimed: RunDelivery[] = [];
      for (const row of rows) {
        const result = claim.run(now, row.id as SQLInputValue);
        if (Number(result.changes) === 0) continue;
        const delivery = this.runDelivery(Number(row.id));
        if (delivery) claimed.push(delivery);
      }
      return claimed;
    });
  }

  markRunDeliverySent(id: number, telegramMessageId: number): RunDelivery {
    if (!Number.isSafeInteger(telegramMessageId) || telegramMessageId <= 0) {
      throw new Error("invalid Telegram message id");
    }
    const now = Date.now() / 1_000;
    this.db.prepare(`
      UPDATE run_deliveries
      SET status = 'sent', telegram_message_id = ?, last_error = '', sent_at = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'
    `).run(telegramMessageId, now, now, id);
    const delivery = this.runDelivery(id);
    if (!delivery) throw new Error("run delivery was not found");
    return delivery;
  }

  markRunDeliveryFailed(id: number, error: string, permanent = false): RunDelivery {
    const delivery = this.runDelivery(id);
    if (!delivery) throw new Error("run delivery was not found");
    const now = Date.now() / 1_000;
    const deadLetter = permanent || delivery.attempts >= 5;
    const delay = Math.min(300, 5 * (2 ** Math.max(0, delivery.attempts - 1)));
    this.db.prepare(`
      UPDATE run_deliveries
      SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'
    `).run(
      deadLetter ? "dead-letter" : "failed",
      error.trim().slice(0, 500) || "Telegram delivery failed",
      now + delay,
      now,
      id,
    );
    return this.runDelivery(id)!;
  }

  markRunDeliveryUncertain(id: number, error: string): RunDelivery {
    const now = Date.now() / 1_000;
    this.db.prepare(`
      UPDATE run_deliveries
      SET status = 'uncertain', last_error = ?, updated_at = ?
      WHERE id = ? AND status IN ('streaming', 'sending')
    `).run(error.trim().slice(0, 500) || "Telegram delivery outcome is uncertain", now, id);
    const delivery = this.runDelivery(id);
    if (!delivery) throw new Error("run delivery was not found");
    return delivery;
  }

  cancelRunDelivery(id: number): RunDelivery {
    const delivery = this.runDelivery(id);
    if (!delivery || !["streaming", "pending", "failed", "uncertain", "dead-letter"].includes(
      delivery.status,
    )) {
      throw new Error("run delivery is not cancellable");
    }
    const now = Date.now() / 1_000;
    this.db.prepare(`
      UPDATE run_deliveries SET status = 'cancelled', updated_at = ? WHERE id = ?
    `).run(now, id);
    return this.runDelivery(id)!;
  }

  telegramOffset(): number | null {
    const row = this.db.prepare(
      "SELECT value FROM runtime_state WHERE key = 'telegram_offset'",
    ).get() as Row | undefined;
    return row ? Number(row.value) : null;
  }

  setTelegramOffset(offset: number): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO runtime_state (key, value) VALUES ('telegram_offset', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(offset));
    });
  }

  teamModelEgressEnabledOverride(): boolean | null {
    const row = this.db.prepare(
      "SELECT value FROM runtime_state WHERE key = 'team_model_egress_enabled'",
    ).get() as Row | undefined;
    if (!row) return null;
    if (row.value === "true") return true;
    if (row.value === "false") return false;
    return null;
  }

  setTeamModelEgressEnabled(enabled: boolean): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO runtime_state (key, value) VALUES ('team_model_egress_enabled', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(enabled));
    });
  }

  teamProactiveRepliesEnabledOverride(): boolean | null {
    const row = this.db.prepare(
      "SELECT value FROM runtime_state WHERE key = 'team_proactive_replies_enabled'",
    ).get() as Row | undefined;
    if (!row) return null;
    if (row.value === "true") return true;
    if (row.value === "false") return false;
    return null;
  }

  setTeamProactiveRepliesEnabled(enabled: boolean): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO runtime_state (key, value) VALUES ('team_proactive_replies_enabled', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(enabled));
    });
  }

  teamModelEgressUsage(): TeamModelEgressUsage | null {
    const row = this.db.prepare(
      "SELECT value FROM runtime_state WHERE key = 'team_model_egress_usage'",
    ).get() as Row | undefined;
    if (!row || typeof row.value !== "string") return null;
    try {
      const value = JSON.parse(row.value) as Record<string, unknown>;
      const weeklyResetsAt = value.weeklyResetsAt === null
        ? null
        : Number(value.weeklyResetsAt);
      const turns = Number(value.turns);
      const measuredTurns = Number(value.measuredTurns);
      const estimatedCreditsMicros = Number(value.estimatedCreditsMicros);
      const observedWeeklyPercent = Number(value.observedWeeklyPercent);
      const updatedAt = Number(value.updatedAt);
      if (
        !(weeklyResetsAt === null || Number.isFinite(weeklyResetsAt)) ||
        !Number.isSafeInteger(turns) || turns < 0 ||
        !Number.isSafeInteger(measuredTurns) || measuredTurns < 0 ||
        !Number.isSafeInteger(estimatedCreditsMicros) || estimatedCreditsMicros < 0 ||
        !Number.isFinite(observedWeeklyPercent) || observedWeeklyPercent < 0 ||
        !Number.isFinite(updatedAt) || updatedAt <= 0
      ) {
        return null;
      }
      return {
        weeklyResetsAt,
        turns,
        measuredTurns,
        estimatedCreditsMicros,
        observedWeeklyPercent: Math.min(100, observedWeeklyPercent),
        updatedAt,
      };
    } catch {
      return null;
    }
  }

  recordTeamModelEgressUsage(input: {
    weeklyResetsAt: number | null;
    measured: boolean;
    estimatedCreditsMicros: number;
    observedWeeklyPercent: number;
    updatedAt?: number;
  }): TeamModelEgressUsage {
    return this.transaction(() => {
      const stored = this.teamModelEgressUsage();
      const sameWindow = stored && (
        input.weeklyResetsAt === null ||
        stored.weeklyResetsAt === null ||
        stored.weeklyResetsAt === input.weeklyResetsAt
      );
      const current = sameWindow
        ? stored
        : null;
      const value: TeamModelEgressUsage = {
        weeklyResetsAt: input.weeklyResetsAt ?? current?.weeklyResetsAt ?? null,
        turns: (current?.turns ?? 0) + 1,
        measuredTurns: (current?.measuredTurns ?? 0) + (input.measured ? 1 : 0),
        estimatedCreditsMicros:
          (current?.estimatedCreditsMicros ?? 0) + Math.max(0, input.estimatedCreditsMicros),
        observedWeeklyPercent: Math.min(
          100,
          (current?.observedWeeklyPercent ?? 0) + Math.max(0, input.observedWeeklyPercent),
        ),
        updatedAt: input.updatedAt ?? Date.now() / 1_000,
      };
      this.db.prepare(`
        INSERT INTO runtime_state (key, value) VALUES ('team_model_egress_usage', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(JSON.stringify(value));
      return value;
    });
  }

  counts(): {
    conversations: number;
    active: number;
    pending: number;
    team_spaces: number;
    team_events: number;
    team_events_pending: number;
    team_knowledge: number;
  } {
    const scalar = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { "COUNT(*)": number };
      return Number(row["COUNT(*)"]);
    };
    return {
      conversations: scalar("SELECT COUNT(*) FROM conversations"),
      active: scalar("SELECT COUNT(*) FROM conversations WHERE active_turn_id IS NOT NULL"),
      pending: scalar("SELECT COUNT(*) FROM pending_inputs WHERE state = 'pending'"),
      team_spaces: scalar("SELECT COUNT(*) FROM team_spaces"),
      team_events: scalar("SELECT COUNT(*) FROM team_events"),
      team_events_pending: scalar(
        "SELECT COUNT(*) FROM team_events WHERE synthesis_state = 'pending'",
      ),
      team_knowledge: scalar("SELECT COUNT(*) FROM team_knowledge"),
    };
  }
}
