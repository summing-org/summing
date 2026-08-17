import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { KnowledgeSyncConfig } from "./config.js";
import { OpenAIDocumentEnricher } from "./document-enricher.js";
import { buildSearchChunks, extractDocument } from "./document-extractor.js";
import {
  KnowledgeSearchIndex,
  OpenAIEmbeddingClient,
  type SearchHit,
} from "./knowledge-search.js";
import {
  KnowledgeSyncStore,
  type IngestionJob,
  type KnowledgeTransferMode,
  type KnowledgeTransferRecord,
  type SyncStageName,
  type SyncStatus,
} from "./knowledge-sync-store.js";
import { KnowledgeTransferManager } from "./knowledge-transfer.js";
import {
  MtprotoConnectorManager,
  type MtprotoAuthorizationStatus,
} from "./mtproto-connector.js";
import {
  ContentAddressedObjects,
  LocalObjectStore,
  createObjectStore,
  type ObjectStore,
} from "./object-store.js";
import { StateStore, type TeamEventAttachment } from "./state-store.js";

interface TdAttachment {
  fileId: number;
  fileName: string;
  mimeType: string;
  size: number;
  kind: string;
}

interface AdminStartInput {
  connectorId: string;
  chatId: number;
  title?: string;
}

interface EmbeddingWork {
  job: IngestionJob;
  evidenceType: "document_block" | "knowledge";
  evidenceRef: string;
  sourceId: string;
  text: string;
  normalizedHash: string;
  chunkId: number | null;
}

export interface KnowledgeSyncAdmin {
  overview(): Record<string, unknown>;
  beginAuthorization(input: { apiId: number; apiHash: string; phone: string }): MtprotoAuthorizationStatus;
  submitAuthorization(
    connectorId: string,
    input: { code?: string; password?: string },
  ): MtprotoAuthorizationStatus;
  grantConsent(input: {
    chatId: number;
    telegramUserId: number;
    proof: string;
    historicalFrom?: number | null;
  }): Record<string, unknown>;
  revokeConsent(chatId: number, telegramUserId: number): Promise<void>;
  startSource(input: AdminStartInput): Promise<SyncStatus>;
  pauseSource(chatId: number): SyncStatus;
  resumeSource(chatId: number): Promise<SyncStatus>;
  unbindSource(chatId: number): void;
  revokeConnector(connectorId: string): Promise<void>;
  startKnowledgeExport(input: {
    chatId: number;
    mode: KnowledgeTransferMode;
    includeEmbeddings?: boolean;
  }): KnowledgeTransferRecord;
  startKnowledgeImport(input: { bundleKey: string }): KnowledgeTransferRecord;
  confirmKnowledgeImport(id: string, acceptConsents: boolean): KnowledgeTransferRecord;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectRecord).filter((item) => Object.keys(item).length > 0) : [];
}

function formattedText(value: unknown): string {
  return String(objectRecord(value).text ?? "").trim();
}

function tdMessageText(message: Record<string, unknown>): string {
  const content = objectRecord(message.content);
  const type = String(content._ ?? "");
  if (type === "messageText") return formattedText(content.text);
  if (type === "messagePhoto") return formattedText(content.caption);
  if (type === "messageDocument") return formattedText(content.caption);
  if (type === "messageVideo") return formattedText(content.caption);
  if (type === "messageAnimation") return formattedText(content.caption);
  if (type === "messageAudio") return formattedText(content.caption);
  if (type === "messageVoiceNote") return formattedText(content.caption);
  if (type === "messagePoll") return String(objectRecord(content.poll).question ?? "[Опрос]");
  if (type) return `[${type}]`;
  return "[Сообщение Telegram]";
}

function tdFile(value: unknown): { id: number; size: number } | null {
  const file = objectRecord(value);
  const id = Number(file.id ?? 0);
  if (!id) return null;
  return { id, size: Number(file.size ?? file.expected_size ?? 0) };
}

function tdAttachments(message: Record<string, unknown>): TdAttachment[] {
  const content = objectRecord(message.content);
  const type = String(content._ ?? "");
  const result: TdAttachment[] = [];
  const add = (
    fileValue: unknown,
    kind: string,
    fileName: unknown,
    mimeType: unknown,
  ): void => {
    const file = tdFile(fileValue);
    if (!file) return;
    result.push({
      fileId: file.id,
      kind,
      fileName: String(fileName || `${kind}-${file.id}`),
      mimeType: String(mimeType || "application/octet-stream"),
      size: file.size,
    });
  };
  if (type === "messageDocument") {
    const document = objectRecord(content.document);
    add(document.document, "document", document.file_name, document.mime_type);
  } else if (type === "messageVideo") {
    const video = objectRecord(content.video);
    add(video.video, "video", video.file_name, video.mime_type);
  } else if (type === "messageAnimation") {
    const animation = objectRecord(content.animation);
    add(animation.animation, "animation", animation.file_name, animation.mime_type);
  } else if (type === "messageAudio") {
    const audio = objectRecord(content.audio);
    add(audio.audio, "audio", audio.file_name, audio.mime_type);
  } else if (type === "messageVoiceNote") {
    const voice = objectRecord(content.voice_note);
    add(voice.voice, "voice", `voice-${String(message.id)}.ogg`, voice.mime_type || "audio/ogg");
  } else if (type === "messagePhoto") {
    const sizes = arrayRecords(objectRecord(content.photo).sizes);
    const largest = sizes.sort((left, right) => {
      const a = objectRecord(left.photo);
      const b = objectRecord(right.photo);
      return Number(b.size ?? b.expected_size ?? 0) - Number(a.size ?? a.expected_size ?? 0);
    })[0];
    if (largest) add(largest.photo, "image", `photo-${String(message.id)}.jpg`, "image/jpeg");
  }
  return result;
}

function tdSenderId(message: Record<string, unknown>): number {
  const sender = objectRecord(message.sender_id);
  return Number(sender.user_id ?? sender.chat_id ?? 0);
}

function tdReplyId(message: Record<string, unknown>): string {
  const reply = objectRecord(message.reply_to);
  return String(reply.message_id ?? "");
}

function stableTextHash(text: string): string {
  return createHash("sha256")
    .update(text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase())
    .digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function directoryBytes(path: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) {
      try { total += statSync(child).size; } catch { /* file disappeared while measuring */ }
    }
  }
  return total;
}

function stageFromStats(stats: { pending: number; running: number; done: number; failed: number }): {
  state: "pending" | "running" | "ready" | "degraded";
  completed: number;
  total: number;
  failed: number;
} {
  const total = stats.pending + stats.running + stats.done + stats.failed;
  return {
    state: stats.failed > 0
      ? "degraded"
      : stats.pending + stats.running > 0
        ? "running"
        : total > 0
          ? "ready"
          : "pending",
    completed: stats.done,
    total,
    failed: stats.failed,
  };
}

export class KnowledgeSyncService implements KnowledgeSyncAdmin {
  readonly store: KnowledgeSyncStore;
  readonly searchIndex: KnowledgeSearchIndex;
  readonly objectStore: ObjectStore;
  readonly objects: ContentAddressedObjects;
  readonly embeddings: OpenAIEmbeddingClient;
  readonly documentEnricher: OpenAIDocumentEnricher;
  readonly transfers: KnowledgeTransferManager;
  readonly mtproto: MtprotoConnectorManager | null;
  private readonly backfills = new Map<string, Promise<void>>();
  private jobsTimer: NodeJS.Timeout | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private transfersTimer: NodeJS.Timeout | null = null;
  private jobsRunning = false;
  private outboxRunning = false;
  private transfersRunning = false;
  private transfersTask: Promise<void> | null = null;
  private searchMaintenance = false;
  private stopped = false;
  private searchRebuild: Promise<void> | null = null;

  constructor(
    readonly config: KnowledgeSyncConfig,
    readonly state: StateStore,
    openaiApiKey: string,
    readonly sendOwnerMessage: (message: string) => Promise<void>,
    dataDir: string,
    readonly administratorUserId: number,
    readonly onAdmittedTeamEvent: (sourceId: string) => void = () => {},
  ) {
    if (config.enabled && !config.telegramTermsReviewed) {
      throw new Error(
        "knowledge sync requires an explicit Telegram API/content-terms review gate",
      );
    }
    if (config.enabled && process.env.NODE_ENV === "production" && config.objectStoreBackend !== "s3") {
      throw new Error("knowledge sync requires SUMMING_OBJECT_STORE=s3 in production");
    }
    this.store = new KnowledgeSyncStore(resolve(dataDir, "core.sqlite"));
    this.searchIndex = new KnowledgeSearchIndex(
      resolve(dataDir, "search.sqlite"),
      config.embeddingDimensions,
    );
    // Disabled mode must stay side-effect free with respect to production S3
    // credentials.  The production template intentionally describes S3 even
    // before the feature is enabled, so constructing the runtime must not
    // validate or connect to that backend yet.
    this.objectStore = config.enabled
      ? createObjectStore(config)
      : new LocalObjectStore(config.localObjectRoot);
    this.objects = new ContentAddressedObjects(this.objectStore, this.store, config.s3Prefix);
    this.embeddings = new OpenAIEmbeddingClient(
      openaiApiKey,
      config.embeddingModel,
      config.embeddingDimensions,
    );
    this.documentEnricher = new OpenAIDocumentEnricher(
      openaiApiKey,
      config.documentVisionModel,
    );
    this.transfers = new KnowledgeTransferManager(
      config,
      state,
      this.store,
      this.objectStore,
      administratorUserId,
    );
    this.mtproto = config.enabled ? new MtprotoConnectorManager(config, this.store) : null;
    this.mtproto?.onUpdate((connectorId, update) => this.handleUpdate(connectorId, update));
  }

  async start(): Promise<void> {
    if (!this.config.enabled || !this.mtproto) return;
    mkdirSync(this.config.spoolRoot, { recursive: true, mode: 0o700 });
    await this.mtproto.restore();
    for (const status of this.store.listSyncStatuses()) {
      if (status.collector.state === "backfilling") this.startBackfill(status.sourceId);
    }
    if (this.searchIndex.rebuildRequired(this.searchIndexSignature())) {
      this.searchRebuild = this.rebuildDerivedSearch().catch((error) => {
        console.error("knowledge search rebuild failed", error);
      });
    }
    this.scheduleJobs(0);
    this.scheduleOutbox(0);
    this.scheduleTransfers(0);
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.jobsTimer) clearTimeout(this.jobsTimer);
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    if (this.transfersTimer) clearTimeout(this.transfersTimer);
    await this.mtproto?.close();
    await Promise.allSettled(this.backfills.values());
    if (this.transfersTask) await this.transfersTask;
    if (this.searchRebuild) await this.searchRebuild;
    this.searchIndex.close();
    this.store.close();
  }

  overview(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      objectStore: this.config.objectStoreBackend,
      embeddings: {
        model: this.config.embeddingModel,
        dimensions: this.config.embeddingDimensions,
        configured: Boolean(this.embeddings.apiKey),
      },
      connectors: this.store.listConnectors().map((connector) => ({
        id: connector.id,
        state: connector.state,
        phoneMask: connector.phoneMask,
        lastUpdateAt: connector.lastUpdateAt,
        lastError: connector.lastError,
        bindings: this.store.listBindings(connector.id),
        authorization: this.mtproto?.authorizationStatus(connector.id) ?? null,
      })),
      statuses: this.store.listSyncStatuses(),
      notifications: this.store.outboxFailures(),
      transfers: this.store.listKnowledgeTransfers(),
      importedSources: this.store.listImportedKnowledgeSources(),
    };
  }

  startKnowledgeExport(input: {
    chatId: number;
    mode: KnowledgeTransferMode;
    includeEmbeddings?: boolean;
  }): KnowledgeTransferRecord {
    if (!this.config.enabled) throw new Error("knowledge sync is disabled");
    const binding = this.store.listBindings().find((item) => item.telegramChatId === input.chatId);
    if (!binding) throw new Error("Telegram group is not bound to knowledge sync");
    if (input.mode !== "manifest" && input.mode !== "portable") {
      throw new Error("knowledge export mode must be manifest or portable");
    }
    const transfer = this.store.createKnowledgeTransfer({
      id: randomUUID(),
      kind: "export",
      mode: input.mode,
      sourceId: binding.sourceId,
      request: { includeEmbeddings: input.includeEmbeddings !== false },
    });
    this.scheduleTransfers(0);
    return transfer;
  }

  startKnowledgeImport(input: { bundleKey: string }): KnowledgeTransferRecord {
    if (!this.config.enabled) throw new Error("knowledge sync is disabled");
    const bundleKey = input.bundleKey.trim();
    if (!bundleKey) throw new Error("knowledge bundle key is required");
    const transfer = this.store.createKnowledgeTransfer({
      id: randomUUID(),
      kind: "import",
      mode: "portable",
      bundleKey,
      request: { bundleKey, confirmed: false },
    });
    this.scheduleTransfers(0);
    return transfer;
  }

  confirmKnowledgeImport(id: string, acceptConsents: boolean): KnowledgeTransferRecord {
    const transfer = this.store.confirmKnowledgeImport(id, acceptConsents);
    this.scheduleTransfers(0);
    return transfer;
  }

  beginAuthorization(input: {
    apiId: number;
    apiHash: string;
    phone: string;
  }): MtprotoAuthorizationStatus {
    if (!this.mtproto) throw new Error("knowledge sync is disabled");
    return this.mtproto.beginAuthorization(input);
  }

  submitAuthorization(
    connectorId: string,
    input: { code?: string; password?: string },
  ): MtprotoAuthorizationStatus {
    if (!this.mtproto) throw new Error("knowledge sync is disabled");
    return this.mtproto.submitAuthorization(connectorId, input);
  }

  private rootSource(chatId: number, title?: string): { sourceId: string; title: string } {
    const chat = this.state.telegramChat(chatId);
    if (!chat && !title) throw new Error("Telegram group is not known to the Bot API");
    const name = title?.trim() || chat?.title || chat?.username || String(chatId);
    const ensured = this.state.ensureTeamSource({
      provider: "telegram",
      externalSpaceId: String(chatId),
      externalThreadId: "0",
      spaceName: name,
      sourceTitle: "general",
      administratorUserId: this.administratorUserId,
      joinedAt: Date.now() / 1_000,
    });
    return { sourceId: ensured.source.id, title: name };
  }

  grantConsent(input: {
    chatId: number;
    telegramUserId: number;
    proof: string;
    historicalFrom?: number | null;
  }): Record<string, unknown> {
    if (!Number.isSafeInteger(input.telegramUserId) || input.telegramUserId <= 0) {
      throw new Error("telegramUserId must be positive");
    }
    if (!input.proof.trim()) throw new Error("consent proof is required");
    const source = this.rootSource(input.chatId);
    const wasGranted = this.store.consentGranted(source.sourceId, input.telegramUserId);
    const consent = this.store.grantConsent({
      sourceId: source.sourceId,
      telegramUserId: input.telegramUserId,
      proof: input.proof,
      historicalFrom: input.historicalFrom ?? null,
    });
    if (!wasGranted && this.store.hasSyncRun(source.sourceId)) {
      this.store.incrementProgress(source.sourceId, { consentedAuthors: 1 });
    }
    if (this.store.resolveUnknownAuthor(source.sourceId, input.telegramUserId)) {
      this.store.incrementProgress(source.sourceId, { unknownAuthors: -1 });
    }
    const space = this.state.teamSpaceForProvider("telegram", String(input.chatId));
    if (space) {
      this.state.setTeamIdentityObservation(
        space.id,
        "telegram",
        String(input.telegramUserId),
        true,
      );
    }
    return { ...consent };
  }

  async revokeConsent(chatId: number, telegramUserId: number): Promise<void> {
    const source = this.rootSource(chatId);
    const wasGranted = this.store.consentGranted(source.sourceId, telegramUserId);
    this.store.revokeConsent(source.sourceId, telegramUserId);
    if (wasGranted && this.store.hasSyncRun(source.sourceId)) {
      this.store.incrementProgress(source.sourceId, { consentedAuthors: -1 });
    }
    const space = this.state.teamSpaceForProvider("telegram", String(chatId));
    if (space) {
      const affectedKnowledge = this.state.teamKnowledgeForIdentity(
        space.id,
        "telegram",
        String(telegramUserId),
        10_000,
      );
      const eventIds = this.state.teamEventIdsForIdentity(
        space.id,
        "telegram",
        String(telegramUserId),
      );
      this.state.forgetTeamIdentity(space.id, "telegram", String(telegramUserId));
      eventIds.forEach((eventId) => this.searchIndex.remove("event", String(eventId)));
      affectedKnowledge.forEach((item) => {
        this.searchIndex.remove("knowledge", `knowledge:${item.id}`);
        this.store.removeKnowledgeIndex(item.id);
      });
    }
    const removal = this.store.revokeAuthorContent(source.sourceId, telegramUserId);
    if (removal.cancelledMedia > 0) {
      this.store.incrementProgress(source.sourceId, { mediaPending: -removal.cancelledMedia });
    }
    for (const object of removal.removed) {
      object.chunkIds.forEach((chunkId) =>
        this.searchIndex.remove("document_block", `chunk:${chunkId}`));
      await this.deleteStoredObject(source.sourceId, object.sha256, object.objectKey);
    }
  }

  async startSource(input: AdminStartInput): Promise<SyncStatus> {
    if (!this.mtproto) throw new Error("knowledge sync is disabled");
    const connector = this.store.connector(input.connectorId);
    if (!connector || connector.state !== "ready") throw new Error("MTProto connector is not ready");
    const source = this.rootSource(input.chatId, input.title);
    const existing = this.store.binding(source.sourceId);
    if (existing) {
      if (
        existing.connectorId !== input.connectorId ||
        existing.telegramChatId !== input.chatId
      ) {
        throw new Error("Team Source is already bound to another MTProto connector");
      }
      return this.store.syncStatus(source.sourceId)!;
    }
    const knownUsers = this.state.listTelegramChatUsers(input.chatId).filter((user) => !user.isBot);
    const missing = knownUsers.filter((user) => !this.store.consentGranted(source.sourceId, user.userId));
    if (missing.length > 0) {
      throw new Error(`consent is missing for Telegram users: ${missing.map((user) => user.userId).join(", ")}`);
    }
    if (this.store.listConsents(source.sourceId).filter((item) => item.status === "granted").length === 0) {
      throw new Error("at least one explicit author consent is required before history sync");
    }
    const chat = await this.mtproto.invoke(input.connectorId, { _: "getChat", chat_id: input.chatId });
    if (chat.has_protected_content === true) throw new Error("content-protected Telegram groups cannot be synchronized");
    const resumingUnboundSource = this.store.hasSyncRun(source.sourceId);
    this.store.bindSource({
      sourceId: source.sourceId,
      connectorId: input.connectorId,
      telegramChatId: input.chatId,
      title: source.title,
    });
    if (resumingUnboundSource) {
      const status = this.store.syncStatus(source.sourceId)!;
      if (status.collector.initialCollectedAt === null) {
        this.store.setCollectorState(source.sourceId, "backfilling");
        this.startBackfill(source.sourceId);
      } else {
        this.store.setCollectorState(source.sourceId, "tailing");
      }
      return this.store.syncStatus(source.sourceId)!;
    }
    this.store.startSync(source.sourceId, input.connectorId);
    this.store.incrementProgress(source.sourceId, {
      consentedAuthors: this.store.listConsents(source.sourceId).filter((item) => item.status === "granted").length,
    });
    this.startBackfill(source.sourceId);
    return this.store.syncStatus(source.sourceId)!;
  }

  pauseSource(chatId: number): SyncStatus {
    const binding = this.bindingForChat(chatId);
    this.store.setCollectorState(binding.sourceId, "paused");
    return this.store.syncStatus(binding.sourceId)!;
  }

  async resumeSource(chatId: number): Promise<SyncStatus> {
    const binding = this.bindingForChat(chatId);
    this.store.requeueFailedJobs(binding.sourceId);
    this.refreshStages(binding.sourceId);
    this.scheduleJobs(0);
    const status = this.store.syncStatus(binding.sourceId)!;
    if (status.collector.initialCollectedAt === null) {
      this.store.setCollectorState(binding.sourceId, "backfilling");
      this.startBackfill(binding.sourceId);
    } else {
      this.store.setCollectorState(binding.sourceId, "tailing");
    }
    return this.store.syncStatus(binding.sourceId)!;
  }

  unbindSource(chatId: number): void {
    const binding = this.bindingForChat(chatId);
    this.store.setCollectorState(binding.sourceId, "paused");
    this.store.unbindSource(binding.sourceId);
  }

  async revokeConnector(connectorId: string): Promise<void> {
    if (!this.mtproto) throw new Error("knowledge sync is disabled");
    await this.mtproto.revoke(connectorId);
  }

  private bindingForChat(chatId: number) {
    const binding = this.store.listBindings().find((item) => item.telegramChatId === chatId);
    if (!binding) throw new Error(`Telegram group ${chatId} is not bound to MTProto`);
    return binding;
  }

  private startBackfill(sourceId: string): void {
    if (this.backfills.has(sourceId) || this.stopped) return;
    const task = this.backfill(sourceId)
      .catch((error) => {
        const delay = Date.now() / 1_000 + 60;
        this.store.setCollectorState(sourceId, "failed", {
          error: errorText(error),
          nextRetryAt: delay,
        });
        console.error(`Telegram history sync failed for ${sourceId}`, error);
      })
      .finally(() => this.backfills.delete(sourceId));
    this.backfills.set(sourceId, task);
  }

  private async backfill(sourceId: string): Promise<void> {
    if (!this.mtproto) return;
    const binding = this.store.binding(sourceId);
    if (!binding) return;
    let fromMessageId = this.store.checkpoint(sourceId)?.fromMessageId ?? 0;
    while (!this.stopped) {
      const current = this.store.syncStatus(sourceId);
      if (!current || current.collector.state === "paused") return;
      const result = await this.mtproto.invoke(binding.connectorId, {
        _: "getChatHistory",
        chat_id: binding.telegramChatId,
        from_message_id: fromMessageId,
        offset: 0,
        limit: 100,
        only_local: false,
      });
      const messages = arrayRecords(result.messages);
      if (messages.length === 0) {
        this.scheduleKnowledgeRefresh(binding.telegramChatId);
        this.refreshStages(sourceId, true);
        this.store.markCollected(sourceId);
        this.scheduleJobs(0);
        this.scheduleOutbox(0);
        return;
      }
      for (const message of messages) await this.processMessage(binding, message, "message");
      const next = Number(messages.at(-1)?.id ?? 0);
      if (!next || next === fromMessageId) throw new Error("Telegram history checkpoint did not advance");
      fromMessageId = next;
      this.store.updateCheckpoint(sourceId, fromMessageId, { fromMessageId });
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
  }

  private async processMessage(
    binding: { sourceId: string; connectorId: string; telegramChatId: number; title: string },
    message: Record<string, unknown>,
    eventKind: "message" | "edit",
  ): Promise<void> {
    const chatId = Number(message.chat_id ?? 0);
    if (chatId !== binding.telegramChatId) return;
    const messageId = Number(message.id ?? 0);
    const senderId = tdSenderId(message);
    const occurredAt = Number(message.edit_date ?? message.date ?? 0) || Date.now() / 1_000;
    this.store.incrementProgress(binding.sourceId, { discovered: 1 }, occurredAt);
    if (!senderId || !this.store.consentGranted(binding.sourceId, senderId, occurredAt)) {
      const firstUnknown = senderId
        ? this.store.recordUnknownAuthor(binding.sourceId, senderId, occurredAt)
        : false;
      this.store.incrementProgress(binding.sourceId, {
        skipped: 1,
        unknownAuthors: firstUnknown ? 1 : 0,
      }, occurredAt);
      return;
    }
    const attachments = tdAttachments(message);
    const threadId = String(Number(message.message_thread_id ?? 0));
    const externalEventId = eventKind === "edit"
      ? `${messageId}:${Number(message.edit_date ?? occurredAt)}`
      : String(messageId);
    const teamAttachments: TeamEventAttachment[] = attachments.map((attachment) => ({
      kind: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      providerFileId: String(attachment.fileId),
    }));
    const event = this.state.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: String(chatId),
      externalThreadId: threadId,
      spaceName: binding.title,
      sourceTitle: threadId === "0" ? "general" : `topic ${threadId}`,
      externalEventId,
      eventKind,
      senderExternalId: String(senderId),
      senderDisplayName: `Telegram user ${senderId}`,
      text: tdMessageText(message),
      replyToExternalEventId: tdReplyId(message),
      attachments: teamAttachments,
      occurredAt,
      administratorUserId: this.state.teamSpaceForProvider("telegram", String(chatId))?.administratorUserId ?? 0,
    });
    if (!event) return;
    const revision = eventKind === "edit" ? Number(message.edit_date ?? occurredAt) : 0;
    const supersededEventIds = eventKind === "edit"
      ? this.store.revisionEventIds(binding.sourceId, messageId)
      : [];
    const inserted = this.store.recordRevision({
      sourceId: binding.sourceId,
      telegramMessageId: messageId,
      revision,
      eventKind,
      teamEventId: event.id,
      occurredAt,
    });
    if (!inserted) return;
    this.onAdmittedTeamEvent(event.sourceId);
    supersededEventIds.forEach((eventId) => this.searchIndex.remove("event", String(eventId)));
    if (eventKind === "edit") {
      const removal = this.store.removeMessageContent(binding.sourceId, chatId, messageId);
      if (removal.cancelledMedia > 0) {
        this.store.incrementProgress(binding.sourceId, { mediaPending: -removal.cancelledMedia });
      }
      for (const object of removal.removed) {
        object.chunkIds.forEach((chunkId) =>
          this.searchIndex.remove("document_block", `chunk:${chunkId}`));
        await this.deleteStoredObject(binding.sourceId, object.sha256, object.objectKey);
      }
      this.scheduleKnowledgeRefresh(chatId);
    }
    this.store.incrementProgress(binding.sourceId, {
      accepted: 1,
      mediaDiscovered: attachments.length,
      mediaPending: attachments.length,
    }, occurredAt);
    this.store.enqueueJob(binding.sourceId, "fts", `event:${event.id}`, {
      evidenceType: "event",
      evidenceRef: String(event.id),
      text: event.text,
      hash: stableTextHash(event.text),
      locator: {
        chatId,
        messageId,
        threadId,
        topicId: threadId,
        authorId: String(senderId),
        occurredAt,
      },
    });
    for (const attachment of attachments) {
      this.store.enqueueJob(
        binding.sourceId,
        "media",
        `${messageId}:${attachment.fileId}:${revision}`,
        {
        connectorId: binding.connectorId,
        fileId: attachment.fileId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        refId: `${chatId}:${messageId}:${attachment.fileId}`,
        telegramMessageId: messageId,
        telegramUserId: senderId,
        occurredAt,
        },
      );
    }
    this.scheduleJobs(0);
  }

  private async handleUpdate(connectorId: string, update: Record<string, unknown>): Promise<void> {
    const type = String(update._ ?? "");
    if (type === "updateNewMessage") {
      const message = objectRecord(update.message);
      const binding = this.store.bindingForChat(connectorId, Number(message.chat_id ?? 0));
      if (!binding || this.store.syncStatus(binding.sourceId)?.collector.state === "paused") return;
      await this.processMessage(binding, message, "message");
      this.store.recordLiveEvent(
        binding.sourceId,
        Number(message.date ?? 0) || Date.now() / 1_000,
      );
      return;
    }
    if (type === "updateMessageContent") {
      const chatId = Number(update.chat_id ?? 0);
      const binding = this.store.bindingForChat(connectorId, chatId);
      if (!binding || !this.mtproto) return;
      const message = await this.mtproto.invoke(connectorId, {
        _: "getMessage",
        chat_id: chatId,
        message_id: Number(update.message_id ?? 0),
      });
      await this.processMessage(binding, message, "edit");
      this.store.recordLiveEvent(
        binding.sourceId,
        Number(message.edit_date ?? message.date ?? 0) || Date.now() / 1_000,
      );
      return;
    }
    if (type === "updateDeleteMessages") {
      const chatId = Number(update.chat_id ?? 0);
      const binding = this.store.bindingForChat(connectorId, chatId);
      if (!binding) return;
      for (const rawId of Array.isArray(update.message_ids) ? update.message_ids : []) {
        const messageId = Number(rawId);
        const ids = this.state.redactTeamEventsForProvider("telegram", String(chatId), String(messageId));
        ids.forEach((id) => this.searchIndex.remove("event", String(id)));
        this.store.recordRevision({
          sourceId: binding.sourceId,
          telegramMessageId: messageId,
          revision: Math.floor(Date.now() / 1_000),
          eventKind: "deletion",
          teamEventId: null,
          occurredAt: Date.now() / 1_000,
        });
        const removal = this.store.removeMessageContent(binding.sourceId, chatId, messageId);
        if (removal.cancelledMedia > 0) {
          this.store.incrementProgress(binding.sourceId, { mediaPending: -removal.cancelledMedia });
        }
        for (const object of removal.removed) {
          object.chunkIds.forEach((chunkId) =>
            this.searchIndex.remove("document_block", `chunk:${chunkId}`));
          await this.deleteStoredObject(binding.sourceId, object.sha256, object.objectKey);
        }
        this.scheduleKnowledgeRefresh(chatId);
      }
      this.store.recordLiveEvent(binding.sourceId, Date.now() / 1_000);
    }
  }

  private scheduleJobs(delay = 1_000): void {
    if (this.stopped || !this.config.enabled || this.jobsTimer) return;
    this.jobsTimer = setTimeout(() => {
      this.jobsTimer = null;
      void this.processJobs().finally(() => this.scheduleJobs(1_000));
    }, delay);
    this.jobsTimer.unref();
  }

  private async processJobs(): Promise<void> {
    if (this.jobsRunning || this.stopped || this.searchMaintenance) return;
    this.jobsRunning = true;
    try {
      this.resumeFailedBackfills();
      const jobs = this.store.claimJobs(Math.max(16, this.config.embeddingBatchSize));
      const embeddings = jobs.filter((job) => job.kind === "embeddings");
      const others = jobs.filter((job) => job.kind !== "embeddings");
      for (const job of others) await this.processJob(job);
      if (embeddings.length > 0) await this.processEmbeddingJobs(embeddings);
    } finally {
      this.jobsRunning = false;
    }
  }

  private resumeFailedBackfills(): void {
    const now = Date.now() / 1_000;
    for (const status of this.store.listSyncStatuses()) {
      if (
        status.collector.state !== "failed" ||
        status.nextRetryAt === null ||
        status.nextRetryAt > now ||
        status.connector.state !== "ready"
      ) continue;
      this.store.setCollectorState(status.sourceId, "backfilling");
      this.startBackfill(status.sourceId);
    }
  }

  private async rebuildDerivedSearch(): Promise<void> {
    const rebuiltSpaces = new Set<string>();
    for (const knowledgeSource of this.searchableKnowledgeSources()) {
      const source = this.state.teamSource(knowledgeSource.sourceId);
      if (!source || rebuiltSpaces.has(source.spaceId)) continue;
      rebuiltSpaces.add(source.spaceId);
      let cursor = 0;
      while (!this.stopped) {
        const events = this.state.teamEventsAfter(source.spaceId, cursor, 500);
        if (events.length === 0) break;
        for (const event of events) {
          cursor = Math.max(cursor, event.id);
          if (!event.text || !this.store.eventRevisionIsSearchable(knowledgeSource.sourceId, event.id)) continue;
          const eventSource = this.state.teamSource(event.sourceId);
          this.searchIndex.indexText({
            sourceId: knowledgeSource.sourceId,
            evidenceType: "event",
            evidenceRef: String(event.id),
            text: event.text,
            normalizedHash: stableTextHash(event.text),
            locator: {
              chatId: knowledgeSource.telegramChatId,
              messageId: Number(event.externalEventId.split(":", 1)[0] ?? 0),
              threadId: eventSource?.externalThreadId ?? "0",
              topicId: eventSource?.externalThreadId ?? "0",
              authorId: event.senderExternalId,
              occurredAt: event.occurredAt,
            },
          });
        }
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
      }
      this.scheduleKnowledgeRefreshSource(knowledgeSource.sourceId);
    }
    let chunkCursor = 0;
    while (!this.stopped) {
      const chunks = this.store.searchChunksAfter(chunkCursor, 500);
      if (chunks.length === 0) break;
      for (const chunk of chunks) {
        chunkCursor = Math.max(chunkCursor, chunk.id);
        this.searchIndex.indexText({
          sourceId: chunk.sourceId,
          evidenceType: "document_block",
          evidenceRef: `chunk:${chunk.id}`,
          text: chunk.text,
          normalizedHash: chunk.normalizedHash,
          locator: { ...chunk.metadata, blockIds: chunk.blockIds },
        });
        if (!this.store.semanticEmbeddingMatches(
          "document_block",
          `chunk:${chunk.id}`,
          this.config.embeddingModel,
          this.config.embeddingDimensions,
        )) {
          this.store.enqueueJob(
            chunk.sourceId,
            "embeddings",
            `chunk:${chunk.id}:${this.config.embeddingModel}:${this.config.embeddingDimensions}`,
            { chunkId: chunk.id },
          );
        }
      }
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
    let embeddingCursor = 0;
    while (!this.stopped) {
      const embeddings = this.store.semanticEmbeddingsAfter(
        embeddingCursor,
        this.config.embeddingModel,
        this.config.embeddingDimensions,
        500,
      );
      if (embeddings.length === 0) break;
      for (const embedding of embeddings) {
        embeddingCursor = Math.max(embeddingCursor, embedding.rowId);
        try {
          this.searchIndex.setEmbedding(
            embedding.evidenceType,
            embedding.evidenceRef,
            embedding.vector,
          );
        } catch {
          // A knowledge entry can be queued for FTS reconstruction in the same pass.
        }
      }
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
    if (!this.stopped) this.searchIndex.markRebuilt(this.searchIndexSignature());
  }

  private searchableKnowledgeSources(): Array<{
    sourceId: string;
    telegramChatId: number;
    title: string;
  }> {
    const sources = new Map<string, { sourceId: string; telegramChatId: number; title: string }>();
    for (const source of this.store.listImportedKnowledgeSources()) sources.set(source.sourceId, source);
    for (const source of this.store.listBindings()) sources.set(source.sourceId, source);
    return [...sources.values()];
  }

  private searchIndexSignature(): string {
    return `v1:${this.config.embeddingModel}:${this.config.embeddingDimensions}`;
  }

  private async processJob(job: IngestionJob): Promise<void> {
    try {
      if (job.kind === "media") await this.processMediaJob(job);
      else if (job.kind === "extraction") await this.processExtractionJob(job);
      else if (job.kind === "fts") this.processFtsJob(job);
      else if (job.kind === "knowledge") this.processKnowledgeJob(job);
      else {
        this.store.finishJob(job.id);
        return;
      }
      this.store.finishJob(job.id);
    } catch (error) {
      const terminal = this.store.retryJob(job.id, errorText(error), job.attempts);
      if (terminal && job.kind === "media" && job.payload.action !== "delete-object") {
        this.store.incrementProgress(job.sourceId, { mediaPending: -1, mediaFailed: 1 });
      }
    } finally {
      this.refreshStages(job.sourceId);
    }
  }

  private async processMediaJob(job: IngestionJob): Promise<void> {
    if (job.payload.action === "delete-object") {
      await this.objectStore.delete(String(job.payload.objectKey));
      return;
    }
    if (!this.mtproto) throw new Error("MTProto is disabled");
    const telegramMessageId = Number(job.payload.telegramMessageId ?? 0);
    const telegramUserId = Number(job.payload.telegramUserId ?? 0);
    if (
      (telegramMessageId && this.store.messageDeleted(job.sourceId, telegramMessageId)) ||
      (telegramUserId && !this.store.consentGranted(job.sourceId, telegramUserId))
    ) {
      if (this.store.finishJob(job.id)) {
        this.store.incrementProgress(job.sourceId, { mediaPending: -1 });
      }
      return;
    }
    const path = await this.mtproto.downloadFile(
      String(job.payload.connectorId),
      Number(job.payload.fileId),
    );
    try {
      const spoolBytes = directoryBytes(this.config.spoolRoot);
      if (spoolBytes > this.config.spoolMaximumBytes) {
        throw new Error(
          `knowledge spool limit exceeded: ${spoolBytes} > ${this.config.spoolMaximumBytes}`,
        );
      }
      if (
        (telegramMessageId && this.store.messageDeleted(job.sourceId, telegramMessageId)) ||
        (telegramUserId && !this.store.consentGranted(job.sourceId, telegramUserId))
      ) {
        if (this.store.finishJob(job.id)) {
          this.store.incrementProgress(job.sourceId, { mediaPending: -1 });
        }
        return;
      }
      const stored = await this.objects.ingest({
        sourceId: job.sourceId,
        refType: "telegram_attachment",
        refId: String(job.payload.refId),
        filePath: path,
        fileName: String(job.payload.fileName),
        mimeType: String(job.payload.mimeType),
        ...(Number(job.payload.telegramUserId ?? 0)
          ? { telegramUserId: Number(job.payload.telegramUserId) }
          : {}),
      });
      if (
        (telegramMessageId && this.store.messageDeleted(job.sourceId, telegramMessageId)) ||
        (telegramUserId && !this.store.consentGranted(job.sourceId, telegramUserId))
      ) {
        const chatId = Number(String(job.payload.refId).split(":", 1)[0] ?? 0);
        const removal = this.store.removeMessageContent(job.sourceId, chatId, telegramMessageId);
        for (const object of removal.removed) {
          await this.deleteStoredObject(job.sourceId, object.sha256, object.objectKey);
        }
        return;
      }
      this.store.enqueueJob(job.sourceId, "extraction", stored.sha256, {
        sha256: stored.sha256,
        objectKey: stored.objectKey,
        fileName: String(job.payload.fileName),
        mimeType: String(job.payload.mimeType),
        refId: String(job.payload.refId),
        telegramUserId,
        occurredAt: Number(job.payload.occurredAt ?? 0),
        size: stored.size,
      });
      this.store.incrementProgress(job.sourceId, { mediaUploaded: 1, mediaPending: -1 });
    } finally {
      try { unlinkSync(path); } catch { /* TDLib may already have cleaned its temporary file */ }
    }
  }

  private async deleteStoredObject(sourceId: string, sha256: string, objectKey: string): Promise<void> {
    try {
      await this.objectStore.delete(objectKey);
    } catch (error) {
      this.store.enqueueJob(sourceId, "media", `delete:${sha256}`, {
        action: "delete-object",
        objectKey,
      });
      console.warn(`object deletion queued after backend failure for ${sha256}`, error);
    }
  }

  private async processExtractionJob(job: IngestionJob): Promise<void> {
    const temporary = join(
      this.config.spoolRoot,
      "extract",
      `${String(job.payload.sha256)}-${process.pid}-${Date.now()}`,
    );
    mkdirSync(resolve(temporary, ".."), { recursive: true, mode: 0o700 });
    await this.objectStore.getFile(String(job.payload.objectKey), temporary);
    try {
      const extracted = await extractDocument(
        temporary,
        String(job.payload.fileName),
        String(job.payload.mimeType),
      );
      const requiresModelEgress = extracted.some((block) =>
        block.structure.requiresOcr === true ||
        block.structure.requiresTranscription === true);
      if (
        requiresModelEgress &&
        !this.store.contentObjectModelEgressAllowed(String(job.payload.sha256))
      ) {
        throw new Error("document model egress is not covered by active author consent");
      }
      const blocks = requiresModelEgress
        ? await this.documentEnricher.enrich(
            temporary,
            String(job.payload.fileName),
            String(job.payload.mimeType),
            extracted,
          )
        : extracted;
      const sourceReference = String(job.payload.refId ?? "");
      const [chatId, messageId] = sourceReference.split(":").map(Number);
      const documentType = String(job.payload.mimeType || job.payload.fileName);
      const occurredAt = Number(job.payload.occurredAt ?? 0);
      const authorId = String(job.payload.telegramUserId ?? "");
      const ids = this.store.replaceDocumentBlocks(blocks.map((block) => ({
        objectHash: String(job.payload.sha256),
        sourceId: job.sourceId,
        blockKind: block.blockKind,
        ordinal: block.ordinal,
        text: block.text,
        locator: {
          ...block.locator,
          chatId,
          messageId,
          authorId,
          occurredAt,
          documentType,
          sourceReference,
        },
        structure: {
          ...block.structure,
          original: {
            fileName: job.payload.fileName,
            mimeType: job.payload.mimeType,
            size: Number(job.payload.size ?? 0),
          },
        },
      })));
      const idByOrdinal = new Map(blocks.map((block, index) => [block.ordinal, ids[index]!]));
      for (const chunk of buildSearchChunks(blocks)) {
        const blockIds = chunk.blockOrdinals.flatMap((ordinal) => {
          const id = idByOrdinal.get(ordinal);
          return id === undefined ? [] : [id];
        });
        const chunkId = this.store.upsertSearchChunk({
          sourceId: job.sourceId,
          normalizedHash: chunk.normalizedHash,
          text: chunk.text,
          blockIds,
          metadata: {
            ...chunk.metadata,
            objectHash: job.payload.sha256,
            fileName: job.payload.fileName,
            chatId,
            messageId,
            authorId,
            occurredAt,
            documentType,
            sourceReference,
          },
        });
        this.searchIndex.indexText({
          sourceId: job.sourceId,
          evidenceType: "document_block",
          evidenceRef: `chunk:${chunkId}`,
          text: chunk.text,
          normalizedHash: chunk.normalizedHash,
          locator: {
            blockIds,
            objectHash: job.payload.sha256,
            fileName: job.payload.fileName,
            chatId,
            messageId,
            authorId,
            occurredAt,
            documentType,
            sourceReference,
          },
        });
        this.store.enqueueJob(
          job.sourceId,
          "embeddings",
          `chunk:${chunkId}:${this.config.embeddingModel}:${this.config.embeddingDimensions}`,
          { chunkId },
        );
      }
    } finally {
      try { unlinkSync(temporary); } catch { /* ignore */ }
    }
  }

  private processFtsJob(job: IngestionJob): void {
    this.searchIndex.indexText({
      sourceId: job.sourceId,
      evidenceType: String(job.payload.evidenceType) as "event",
      evidenceRef: String(job.payload.evidenceRef),
      text: String(job.payload.text),
      normalizedHash: String(job.payload.hash),
      locator: objectRecord(job.payload.locator),
    });
  }

  private processKnowledgeJob(job: IngestionJob): void {
    const knowledgeId = Number(job.payload.knowledgeId ?? 0);
    const space = this.state.teamSource(job.sourceId)?.spaceId;
    const item = space
      ? this.state.teamKnowledge(space, 10_000).find((candidate) => candidate.id === knowledgeId)
      : null;
    const evidenceRef = `knowledge:${knowledgeId}`;
    if (!item || item.status !== "active") {
      this.searchIndex.remove("knowledge", evidenceRef);
      this.store.removeKnowledgeIndex(knowledgeId);
      return;
    }
    const text = `${item.subject}\n${item.statement}`.trim();
    const hash = stableTextHash(text);
    this.store.replaceKnowledgeEvidence(item.id, item.evidenceEventIds);
    this.searchIndex.indexText({
      sourceId: job.sourceId,
      evidenceType: "knowledge",
      evidenceRef,
      text,
      normalizedHash: hash,
      locator: {
        knowledgeId: item.id,
        kind: item.kind,
        subject: item.subject,
        evidenceEventIds: item.evidenceEventIds,
      },
    });
    const existingEmbedding = this.store.semanticEmbedding(
      "knowledge",
      evidenceRef,
      this.config.embeddingModel,
      this.config.embeddingDimensions,
    );
    if (existingEmbedding) {
      this.searchIndex.setEmbedding("knowledge", evidenceRef, existingEmbedding);
      return;
    }
    this.store.enqueueJob(
      job.sourceId,
      "embeddings",
      `${evidenceRef}:${hash}:${this.config.embeddingModel}:${this.config.embeddingDimensions}`,
      {
      evidenceType: "knowledge",
      evidenceRef,
      text,
      hash,
      evidenceEventIds: item.evidenceEventIds,
      },
    );
  }

  private async processEmbeddingJobs(jobs: IngestionJob[]): Promise<void> {
    const valid: EmbeddingWork[] = [];
    for (const job of jobs) {
      const chunkId = Number(job.payload.chunkId ?? 0);
      if (chunkId) {
        const chunk = this.store.searchChunk(chunkId);
        const objectHash = String(chunk?.metadata.objectHash ?? "");
        if (chunk && objectHash && this.store.contentObjectModelEgressAllowed(objectHash)) valid.push({
          job,
          evidenceType: "document_block",
          evidenceRef: `chunk:${chunk.id}`,
          sourceId: chunk.sourceId,
          text: chunk.text,
          normalizedHash: chunk.normalizedHash,
          chunkId: chunk.id,
        });
        else if (chunk) this.store.retryJob(
          job.id,
          "embedding model egress is not covered by active author consent",
          job.attempts,
        );
        continue;
      }
      const evidenceType = String(job.payload.evidenceType ?? "");
      const evidenceRef = String(job.payload.evidenceRef ?? "");
      const text = String(job.payload.text ?? "").trim();
      const normalizedHash = String(job.payload.hash ?? "");
      const evidenceEventIds = Array.isArray(job.payload.evidenceEventIds)
        ? job.payload.evidenceEventIds.map(Number).filter(Number.isSafeInteger)
        : [];
      const egressAllowed = evidenceEventIds.length > 0 && evidenceEventIds.every((eventId) => {
        const event = this.state.teamEvent(eventId);
        return Boolean(
          event &&
          this.store.consentScopeGranted(
            job.sourceId,
            Number(event.senderExternalId),
            "model_egress",
            event.occurredAt,
          )
        );
      });
      if (evidenceType === "knowledge" && evidenceRef && text && normalizedHash && egressAllowed) {
        valid.push({
          job,
          evidenceType: "knowledge",
          evidenceRef,
          sourceId: job.sourceId,
          text,
          normalizedHash,
          chunkId: null,
        });
      } else if (evidenceType === "knowledge" && evidenceRef && text && normalizedHash) {
        this.store.retryJob(
          job.id,
          "knowledge embedding egress is not covered by active evidence author consent",
          job.attempts,
        );
      }
    }
    const validIds = new Set(valid.map((item) => item.job.id));
    jobs.filter((job) => !validIds.has(job.id)).forEach((job) => this.store.finishJob(job.id));
    if (valid.length === 0) {
      return;
    }
    try {
      const vectors = await this.embeddings.embed(valid.map((item) => item.text));
      valid.forEach((item, index) => {
        const vector = vectors[index]!;
        if (item.chunkId !== null) {
          this.store.setChunkEmbedding(
            item.chunkId,
            this.config.embeddingModel,
            vector,
            item.normalizedHash,
          );
        }
        this.store.setSemanticEmbedding({
          evidenceType: item.evidenceType,
          evidenceRef: item.evidenceRef,
          sourceId: item.sourceId,
          model: this.config.embeddingModel,
          vector,
          normalizedHash: item.normalizedHash,
        });
        this.searchIndex.setEmbedding(item.evidenceType, item.evidenceRef, vector);
        this.store.finishJob(item.job.id);
      });
    } catch (error) {
      valid.forEach((item) => this.store.retryJob(
        item.job.id,
        errorText(error),
        item.job.attempts,
      ));
    } finally {
      new Set(jobs.map((item) => item.sourceId)).forEach((sourceId) => this.refreshStages(sourceId));
    }
  }

  private refreshStages(sourceId: string, collectionComplete = false): void {
    const collected = collectionComplete ||
      this.store.syncStatus(sourceId)?.collector.initialCollectedAt != null;
    for (const stage of ["media", "extraction", "fts", "embeddings", "knowledge"] as SyncStageName[]) {
      const stats = this.store.jobStats(sourceId, stage);
      const summary = stageFromStats(stats);
      if (summary.total === 0 && collected) {
        summary.state = "ready";
      }
      this.store.updateStage(sourceId, stage, summary.state, {
        ...summary,
        error: stats.lastError,
        nextRetryAt: stats.nextRetryAt,
      });
    }
  }

  private scheduleOutbox(delay = 2_000): void {
    if (this.stopped || !this.config.enabled || this.outboxTimer) return;
    this.outboxTimer = setTimeout(() => {
      this.outboxTimer = null;
      void this.processOutbox().finally(() => this.scheduleOutbox(2_000));
    }, delay);
    this.outboxTimer.unref();
  }

  private async processOutbox(): Promise<void> {
    if (this.outboxRunning || this.stopped) return;
    this.outboxRunning = true;
    try {
      for (const item of this.store.claimOutbox()) {
        try {
          if (item.kind === "initial-collected") {
            await this.sendOwnerMessage(this.initialCollectedMessage(item.payload as unknown as SyncStatus));
          }
          this.store.finishOutbox(item.id);
        } catch (error) {
          this.store.retryOutbox(item.id, errorText(error), item.attempts);
        }
      }
    } finally {
      this.outboxRunning = false;
    }
  }

  private scheduleTransfers(delay = 2_000): void {
    if (this.stopped || !this.config.enabled || this.transfersTimer || this.transfersRunning) return;
    this.transfersTimer = setTimeout(() => {
      this.transfersTimer = null;
      this.transfersTask = this.processTransfers().finally(() => {
        this.transfersTask = null;
        this.scheduleTransfers(2_000);
      });
    }, delay);
    this.transfersTimer.unref();
  }

  private async processTransfers(): Promise<void> {
    if (this.transfersRunning || this.stopped) return;
    this.transfersRunning = true;
    try {
      const transfer = this.store.claimKnowledgeTransfer();
      if (!transfer) return;
      try {
        if (transfer.kind === "export") {
          if (!transfer.sourceId) throw new Error("knowledge export source is missing");
          const result = await this.transfers.export({
            exportId: transfer.id,
            sourceId: transfer.sourceId,
            mode: transfer.mode,
            includeEmbeddings: transfer.request.includeEmbeddings !== false,
          });
          this.store.finishKnowledgeTransfer(transfer.id, { ...result }, result.bundleKey);
          return;
        }
        const bundleKey = String(transfer.request.bundleKey ?? transfer.bundleKey).trim();
        if (!bundleKey) throw new Error("knowledge import bundle key is missing");
        if (transfer.request.confirmed !== true) {
          const inspection = await this.transfers.inspect(bundleKey);
          this.store.awaitKnowledgeImportConfirmation(transfer.id, { ...inspection }, bundleKey);
          return;
        }
        const result = await this.transfers.import(
          bundleKey,
          transfer.request.acceptConsents === true,
        );
        await this.rebuildSearchAfterImport();
        this.store.finishKnowledgeTransfer(transfer.id, { ...result }, bundleKey);
      } catch (error) {
        this.store.failKnowledgeTransfer(transfer.id, errorText(error));
      }
    } finally {
      this.transfersRunning = false;
    }
  }

  private async rebuildSearchAfterImport(): Promise<void> {
    this.searchMaintenance = true;
    try {
      while (this.jobsRunning && !this.stopped) {
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
      }
      if (this.searchRebuild) await this.searchRebuild;
      this.searchIndex.reset();
      this.searchRebuild = this.rebuildDerivedSearch();
      await this.searchRebuild;
    } finally {
      this.searchRebuild = null;
      this.searchMaintenance = false;
      this.scheduleJobs(0);
    }
  }

  private initialCollectedMessage(status: SyncStatus): string {
    const dates = [status.collector.firstMessageAt, status.collector.lastMessageAt]
      .map((value) => value ? new Date(value * 1_000).toISOString().slice(0, 10) : "—")
      .join(" — ");
    const duration = status.collector.startedAt && status.collector.initialCollectedAt
      ? Math.round(status.collector.initialCollectedAt - status.collector.startedAt)
      : 0;
    return [
      `✅ Первичный сбор завершён: ${status.title}`,
      `chat_id: ${status.telegramChatId}`,
      `Период: ${dates}`,
      `Сообщения: ${status.counters.accepted} сохранено, ${status.counters.skipped} пропущено`,
      `Авторы: ${status.counters.consentedAuthors} согласовано, ${status.counters.unknownAuthors} неизвестно`,
      `Медиа: ${status.counters.mediaDiscovered} найдено, ${status.counters.mediaUploaded} загружено, ` +
        `${status.counters.mediaPending} в очереди, ${status.counters.mediaFailed} ошибок`,
      `Стадии: extraction=${status.stages.extraction.state}, fts=${status.stages.fts.state}, ` +
        `embeddings=${status.stages.embeddings.state}, knowledge=${status.stages.knowledge.state}`,
      `Длительность сбора: ${duration} сек.`,
      `/sync_status ${status.telegramChatId}`,
    ].join("\n");
  }

  statusText(chatId?: number): string {
    const statuses = chatId === undefined
      ? this.store.listSyncStatuses()
      : this.store.listSyncStatuses().filter((status) => status.telegramChatId === chatId);
    if (statuses.length === 0) return chatId === undefined
      ? "Синхронизируемые Telegram-группы ещё не настроены."
      : `Синхронизация для chat_id ${chatId} не найдена.`;
    if (chatId === undefined) {
      return statuses.map((status) => {
        const queues = Object.values(status.stages)
          .map((stage) => `${stage.name}:${Math.max(0, stage.total - stage.completed)}`)
          .join(",");
        const last = status.collector.lastEventAt
          ? new Date(status.collector.lastEventAt * 1_000).toISOString()
          : "—";
        const lag = status.collector.lagSeconds === null
          ? "—"
          : `${Math.round(status.collector.lagSeconds)}s`;
        return `${status.title} (${status.telegramChatId}): collector=${status.collector.state}; ` +
          `connector=${status.connector.state}/${status.connectorId}; checkpoint=${status.collector.checkpoint || "—"}; ` +
          `last=${last}; lag=${lag}; messages=${status.counters.accepted}/${status.counters.discovered}; ` +
          `files=${status.counters.mediaUploaded}/${status.counters.mediaDiscovered}; queues=[${queues}]`;
      }).join("\n");
    }
    const status = statuses[0]!;
    return [
      `${status.title} (${status.telegramChatId})`,
      `Collector: ${status.collector.state}; connector: ${status.connector.state}/${status.connectorId}`,
      `Checkpoint: ${status.collector.checkpoint || "—"}`,
      `Available range: ${status.collector.firstMessageAt
        ? new Date(status.collector.firstMessageAt * 1_000).toISOString()
        : "—"} — ${status.collector.lastMessageAt
        ? new Date(status.collector.lastMessageAt * 1_000).toISOString()
        : "—"}`,
      `Last event: ${status.collector.lastEventAt ? new Date(status.collector.lastEventAt * 1_000).toISOString() : "—"}`,
      `Last successful live event: ${status.collector.lastLiveEventAt
        ? new Date(status.collector.lastLiveEventAt * 1_000).toISOString()
        : "—"}`,
      `Lag: ${status.collector.lagSeconds === null ? "—" : `${Math.round(status.collector.lagSeconds)}s`}`,
      `Messages: discovered=${status.counters.discovered}, accepted=${status.counters.accepted}, skipped=${status.counters.skipped}`,
      `Authors: consented=${status.counters.consentedAuthors}, unknown=${status.counters.unknownAuthors}`,
      ...(status.unknownAuthorIds.length > 0
        ? [`Unknown author IDs: ${status.unknownAuthorIds.join(", ")}`]
        : []),
      `Media: uploaded=${status.counters.mediaUploaded}, pending=${status.counters.mediaPending}, failed=${status.counters.mediaFailed}`,
      `Object store: ${this.objectStore.backend}; S3/media backlog=${Math.max(
        0,
        status.stages.media.total - status.stages.media.completed,
      )}`,
      ...Object.values(status.stages).map((stage) =>
        `${stage.name}: ${stage.state} ${stage.completed}/${stage.total}` +
          `${stage.failed ? ` failed=${stage.failed}` : ""}` +
          `${stage.lastError ? ` error=${stage.lastError.slice(0, 300)}` : ""}` +
          `${stage.nextRetryAt ? ` retry=${new Date(stage.nextRetryAt * 1_000).toISOString()}` : ""}`,
      ),
      ...(status.warning ? [`Warning: ${status.warning}`] : []),
      ...(status.connector.lastError
        ? [`Connector error: ${status.connector.lastError.slice(0, 500)}`]
        : []),
      ...(status.lastError ? [`Error: ${status.lastError.slice(0, 500)}`] : []),
      ...(status.nextRetryAt ? [`Next retry: ${new Date(status.nextRetryAt * 1_000).toISOString()}`] : []),
    ].join("\n");
  }

  async search(query: string, sourceId?: string): Promise<SearchHit[]> {
    let vector: Float32Array | null = null;
    if (this.embeddings.apiKey) {
      try { vector = (await this.embeddings.embed([query]))[0] ?? null; } catch { vector = null; }
    }
    return this.searchIndex.search(query, vector, {
      ...(sourceId ? { sourceId } : {}),
      limit: 20,
    });
  }

  scheduleKnowledgeRefresh(chatId: number): void {
    const source = this.searchableKnowledgeSources().find((item) => item.telegramChatId === chatId);
    if (!source) return;
    this.scheduleKnowledgeRefreshSource(source.sourceId);
  }

  private scheduleKnowledgeRefreshSource(sourceId: string): void {
    const source = this.state.teamSource(sourceId);
    if (!source) return;
    for (const item of this.state.teamKnowledge(source.spaceId, 10_000)) {
      const evidenceRef = `knowledge:${item.id}`;
      if (item.status !== "active") {
        this.searchIndex.remove("knowledge", evidenceRef);
        this.store.removeKnowledgeIndex(item.id);
        continue;
      }
      this.store.enqueueJob(
        sourceId,
        "knowledge",
        `${item.id}:${item.updatedAt}`,
        { knowledgeId: item.id },
      );
    }
    this.refreshStages(sourceId);
    this.scheduleJobs(0);
  }

  admitLiveTelegramEvent(chatId: number, telegramUserId: number, occurredAt: number): boolean {
    const binding = this.store.listBindings().find((item) => item.telegramChatId === chatId);
    if (!binding) return true;
    const status = this.store.syncStatus(binding.sourceId);
    if (status?.collector.state === "paused") return false;
    const admitted = this.store.consentGranted(binding.sourceId, telegramUserId, occurredAt);
    if (!admitted && telegramUserId) this.store.recordUnknownAuthor(
      binding.sourceId,
      telegramUserId,
      occurredAt,
    );
    if (admitted) this.store.recordLiveEvent(binding.sourceId, occurredAt);
    return admitted;
  }

  async contextForQuestion(query: string, chatId: number): Promise<Array<Record<string, unknown>>> {
    const binding = this.store.listBindings().find((item) => item.telegramChatId === chatId);
    if (!binding) return [];
    const hits = await this.search(query, binding.sourceId);
    return hits.flatMap<Record<string, unknown>>((hit) => {
      if (hit.evidenceType === "event") {
        const event = this.state.teamEvent(Number(hit.evidenceRef));
        const allowed = event && this.store.consentScopeGranted(
          binding.sourceId,
          Number(event.senderExternalId),
          "model_egress",
          event.occurredAt,
        );
        return event && event.text && allowed ? [{
          evidence: `telegram-event:${event.id}`,
          author: event.senderDisplayName,
          occurredAt: event.occurredAt,
          text: event.text,
          locator: hit.locator,
        }] : [];
      }
      const match = hit.evidenceRef.match(/^chunk:(\d+)$/);
      const chunk = match ? this.store.searchChunk(Number(match[1])) : null;
      const objectHash = String(chunk?.metadata.objectHash ?? "");
      if (chunk && this.store.contentObjectModelEgressAllowed(objectHash)) return [{
          evidence: `document-chunk:${chunk.id}`,
          text: chunk.text,
          blockIds: chunk.blockIds,
          blocks: this.store.documentBlocks(chunk.blockIds),
          objectReferences: this.store.contentObjectRefsAllowedForModelEgress(objectHash),
          locator: { ...chunk.metadata, blockIds: chunk.blockIds },
        }];
      const knowledgeMatch = hit.evidenceRef.match(/^knowledge:(\d+)$/);
      const knowledgeId = knowledgeMatch ? Number(knowledgeMatch[1]) : 0;
      const spaceId = this.state.teamSource(binding.sourceId)?.spaceId;
      const item = knowledgeId && spaceId
        ? this.state.teamKnowledge(spaceId, 10_000).find((candidate) => candidate.id === knowledgeId)
        : null;
      const allowed = item && item.evidenceEventIds.length > 0 &&
        item.evidenceEventIds.every((eventId) => {
          const event = this.state.teamEvent(eventId);
          return Boolean(event && this.store.consentScopeGranted(
            binding.sourceId,
            Number(event.senderExternalId),
            "model_egress",
            event.occurredAt,
          ));
        });
      return item && item.status === "active" && allowed ? [{
        evidence: `team-knowledge:${item.id}`,
        kind: item.kind,
        subject: item.subject,
        text: item.statement,
        evidenceEventIds: item.evidenceEventIds,
        locator: hit.locator,
      }] : [];
    });
  }
}
