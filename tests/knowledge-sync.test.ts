import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeSyncConfig } from "../src/config.js";
import { KnowledgeSyncService } from "../src/knowledge-sync.js";
import { StateStore } from "../src/state-store.js";

function enabledConfig(root: string): KnowledgeSyncConfig {
  return {
    enabled: true,
    telegramTermsReviewed: true,
    objectStoreBackend: "local",
    localObjectRoot: join(root, "objects"),
    spoolRoot: join(root, "spool"),
    spoolMaximumBytes: 100_000_000,
    s3Endpoint: "",
    s3Region: "us-east-1",
    s3Bucket: "",
    s3Prefix: "summing",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3ForcePathStyle: false,
    s3Sse: "AES256",
    s3KmsKeyId: "",
    mtprotoMasterKeyPath: join(root, "mtproto.key"),
    knowledgeTransferKeyPath: join(root, "transfer.key"),
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 4,
    embeddingBatchSize: 8,
    documentVisionModel: "gpt-test",
  };
}

test("Team Space export returns one recovery key and persists only its wrapped envelope", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-team-space-export-"));
  const state = new StateStore(join(root, "state.sqlite3"));
  const config = enabledConfig(root);
  writeFileSync(config.knowledgeTransferKeyPath, randomBytes(32), { mode: 0o600 });
  writeFileSync(config.mtprotoMasterKeyPath, randomBytes(32), { mode: 0o600 });
  const event = state.recordTeamEvent({
    provider: "telegram",
    externalSpaceId: "-100500",
    externalThreadId: "0",
    spaceName: "Portable",
    sourceTitle: "Portable",
    externalEventId: "1",
    eventKind: "message",
    senderExternalId: "42",
    senderDisplayName: "Owner",
    text: "portable state",
    occurredAt: 1,
    observedAt: 1,
    administratorUserId: 42,
  })!;
  const service = new KnowledgeSyncService(config, state, "", async () => {}, root, 42);
  try {
    const started = service.startKnowledgeExport({
      spaceId: event.spaceId,
      mode: "portable",
    });
    assert.match(started.recoveryKey, /^[a-f0-9]{64}$/);
    const persisted = service.store.knowledgeTransfer(started.id)!;
    assert.equal(typeof persisted.request.wrappedTransferKey, "string");
    assert.equal(String(persisted.request.wrappedTransferKey).includes(started.recoveryKey), false);
    const overview = service.overview() as { transfers: Array<{ request: Record<string, unknown> }> };
    assert.equal(overview.transfers[0]?.request.wrappedTransferKey, "[stored]");
  } finally {
    await service.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("signed group consent covers historical and future authors across every Telegram topic", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-group-consent-"));
  const state = new StateStore(join(root, "state.sqlite3"));
  const service = new KnowledgeSyncService(
    { ...enabledConfig(root), enabled: false },
    state,
    "",
    async () => {},
    root,
    1,
  );
  try {
    state.recordTelegramChat({
      chatId: -100500,
      type: "supergroup",
      title: "Customer group",
      isForum: true,
    });
    state.recordTelegramTopic(-100500, 9, "Reports");
    state.recordTelegramTopicUser(-100500, 9, {
      userId: 42,
      firstName: "Customer",
      observedAt: 150,
    });
    state.recordTelegramTopicUser(-100500, 9, {
      userId: 43,
      firstName: "Manager",
      observedAt: 160,
    });
    state.recordTelegramTopicUser(-100500, 9, {
      userId: 123,
      firstName: "Bot",
      isBot: true,
      observedAt: 170,
    });
    const topic = state.ensureTeamSource({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "9",
      spaceName: "Customer group",
      sourceTitle: "Reports",
      administratorUserId: 1,
    }).source;

    assert.deepEqual(service.grantGroupConsent({
      chatId: -100500,
      proof: "customer contracts",
      historicalFrom: 100,
    }), {
      sourceId: StateStore.teamSourceId("telegram", "-100500", "0"),
      chatId: -100500,
      coverage: "all-authors",
      status: "granted",
      historicalFrom: 100,
      newlyGranted: true,
      observedUsers: 2,
      historyRecovery: "not-needed",
    });
    assert.equal(
      service.store.groupConsent(StateStore.teamSourceId("telegram", "-100500", "0"))?.proof,
      "customer contracts",
    );
    assert.equal(service.store.consent(topic.id, 42), null);
    assert.equal(
      service.consentScopeGrantedForSource(topic.id, 42, "model_egress", 150),
      true,
    );
    assert.equal(
      service.consentScopeGrantedForSource(topic.id, 42, "model_egress", 99),
      false,
    );
    assert.equal(
      service.consentScopeGrantedForSource(topic.id, 123, "model_egress", 170),
      true,
    );
    assert.equal(
      service.consentScopeGrantedForSource(topic.id, 999, "model_egress", 170),
      true,
    );
    await service.revokeConsent(-100500, 42);
    assert.equal(
      service.consentScopeGrantedForSource(topic.id, 42, "model_egress", 170),
      false,
    );
  } finally {
    await service.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("group consent admits unknown authors and senderless service history immediately", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-group-backfill-"));
  const state = new StateStore(join(root, "state.sqlite3"));
  const service = new KnowledgeSyncService(
    { ...enabledConfig(root), enabled: false },
    state,
    "",
    async () => {},
    root,
    1,
  );
  const connectorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const chatId = -100800;
  const sourceId = StateStore.teamSourceId("telegram", String(chatId), "0");
  try {
    state.recordTelegramChat({
      chatId,
      type: "supergroup",
      title: "Signed group",
      isForum: false,
    });
    service.grantGroupConsent({ chatId, proof: "signed group appendix" });
    service.store.createConnector({
      id: connectorId,
      apiId: 123,
      encryptedApiHash: "encrypted",
      phoneMask: "+79***1234",
      databaseDirectory: join(root, "tdlib"),
      now: 100,
    });
    service.store.updateConnector(connectorId, "ready");
    const binding = service.store.bindSource({
      sourceId,
      connectorId,
      telegramChatId: chatId,
      title: "Signed group",
      now: 101,
    });
    service.store.startSync(sourceId, connectorId, 102);
    const processMessage = (service as unknown as {
      processMessage: (
        source: typeof binding,
        message: Record<string, unknown>,
        kind: "message" | "edit",
      ) => Promise<void>;
    }).processMessage.bind(service);
    await processMessage(binding, {
      chat_id: chatId,
      id: 10,
      date: 50,
      sender_id: { _: "messageSenderUser", user_id: 999 },
      content: { _: "messageText", text: { text: "Previously unseen author" } },
    }, "message");
    await processMessage(binding, {
      chat_id: chatId,
      id: 9,
      date: 40,
      sender_id: {},
      content: { _: "messageChatAddMembers" },
    }, "message");

    const status = service.store.syncStatus(sourceId)!;
    assert.equal(status.groupConsent.granted, true);
    assert.equal(status.counters.discovered, 2);
    assert.equal(status.counters.accepted, 2);
    assert.equal(status.counters.skipped, 0);
    assert.deepEqual(status.unknownAuthorIds, []);
    const source = state.teamSource(sourceId)!;
    const events = state.teamEventsAfter(source.spaceId, 0, 10);
    assert.deepEqual(events.map((event) => ({
      id: event.externalEventId,
      kind: event.eventKind,
      sender: event.senderExternalId,
    })), [
      { id: "10", kind: "message", sender: "999" },
      { id: "9", kind: "service", sender: String(chatId) },
    ]);
  } finally {
    await service.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("granting signed group consent runs a durable recovery backfill for existing skips", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-group-recovery-"));
  const state = new StateStore(join(root, "state.sqlite3"));
  const config = enabledConfig(root);
  writeFileSync(config.mtprotoMasterKeyPath, randomBytes(32), { mode: 0o600 });
  const service = new KnowledgeSyncService(config, state, "", async () => {}, root, 1);
  const connectorId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const chatId = -100900;
  const sourceId = StateStore.teamSourceId("telegram", String(chatId), "0");
  try {
    state.recordTelegramChat({
      chatId,
      type: "supergroup",
      title: "Recovery group",
      isForum: false,
    });
    service.store.createConnector({
      id: connectorId,
      apiId: 123,
      encryptedApiHash: "encrypted",
      phoneMask: "+79***1234",
      databaseDirectory: join(root, "tdlib"),
      now: 100,
    });
    service.store.updateConnector(connectorId, "ready");
    await assert.rejects(
      service.startSource({ chatId, connectorId }),
      /signed group consent/,
    );
    service.store.bindSource({
      sourceId,
      connectorId,
      telegramChatId: chatId,
      title: "Recovery group",
      now: 101,
    });
    service.store.startSync(sourceId, connectorId, 102);
    service.store.recordUnknownAuthor(sourceId, 777, 50);
    service.store.incrementProgress(sourceId, {
      discovered: 2,
      skipped: 2,
      unknownAuthors: 1,
    }, 50, 103);
    service.store.markCollected(sourceId, 104);
    const pages = new Map<number, Record<string, unknown>[]>([
      [0, [
        {
          chat_id: chatId,
          id: 10,
          date: 50,
          sender_id: { _: "messageSenderUser", user_id: 777 },
          content: { _: "messageText", text: { text: "Recovered author message" } },
        },
        {
          chat_id: chatId,
          id: 9,
          date: 40,
          sender_id: {},
          content: { _: "messageChatSetTheme" },
        },
      ]],
      [9, []],
    ]);
    const mtproto = service.mtproto! as unknown as {
      invokeHistory: (
        connector: string,
        request: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    mtproto.invokeHistory = async (_connector, request) => ({
      messages: pages.get(Number(request.from_message_id ?? 0)) ?? [],
    });

    const consent = service.grantGroupConsent({
      chatId,
      proof: "signed group recovery agreement",
    });
    assert.equal(consent.historyRecovery, "running");
    const internals = service as unknown as {
      historyRecoveries: Map<string, Promise<void>>;
    };
    await Promise.all(internals.historyRecoveries.values());

    const status = service.store.syncStatus(sourceId)!;
    assert.equal(status.counters.discovered, 2);
    assert.equal(status.counters.accepted, 2);
    assert.equal(status.counters.skipped, 0);
    assert.equal(status.counters.unknownAuthors, 0);
    assert.equal(status.historyRecovery?.state, "succeeded");
    assert.equal(status.historyRecovery?.recoveredMessages, 2);
    assert.deepEqual(status.skippedByAuthor.items, []);
  } finally {
    await service.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Telegram media jobs persist stable remote identifiers", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-stable-media-job-"));
  const state = new StateStore(join(root, "state.sqlite3"));
  const config = enabledConfig(root);
  writeFileSync(config.mtprotoMasterKeyPath, randomBytes(32), { mode: 0o600 });
  const service = new KnowledgeSyncService(config, state, "", async () => {}, root, 1);
  config.enabled = false;
  const connectorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const chatId = -100910;
  const sourceId = StateStore.teamSourceId("telegram", String(chatId), "0");
  try {
    state.recordTelegramChat({ chatId, type: "supergroup", title: "Media", isForum: false });
    service.grantGroupConsent({ chatId, proof: "signed media agreement" });
    service.store.createConnector({
      id: connectorId,
      apiId: 123,
      encryptedApiHash: "encrypted",
      phoneMask: "***",
      databaseDirectory: join(root, "tdlib"),
    });
    const binding = service.store.bindSource({
      sourceId,
      connectorId,
      telegramChatId: chatId,
      title: "Media",
    });
    service.store.startSync(sourceId, connectorId);
    const processMessage = (service as unknown as {
      processMessage: (
        source: typeof binding,
        message: Record<string, unknown>,
        kind: "message" | "edit",
      ) => Promise<void>;
    }).processMessage.bind(service);
    await processMessage(binding, {
      chat_id: chatId,
      id: 10,
      date: 100,
      sender_id: { _: "messageSenderUser", user_id: 1 },
      content: {
        _: "messageDocument",
        caption: { text: "document" },
        document: {
          file_name: "report.pdf",
          mime_type: "application/pdf",
          document: {
            id: 7,
            size: 12,
            remote: { id: "remote-file-7", unique_id: "unique-file-7" },
          },
        },
      },
    }, "message");

    const jobs = service.store.claimJobs(10, Number.MAX_SAFE_INTEGER);
    const media = jobs.find((job) => job.kind === "media")!;
    assert.equal(media.dedupeKey, "10:unique-file-7:0");
    assert.deepEqual({
      version: media.payload.mediaSchemaVersion,
      chatId: media.payload.chatId,
      fileId: media.payload.fileId,
      remoteFileId: media.payload.remoteFileId,
      uniqueFileId: media.payload.uniqueFileId,
      refId: media.payload.refId,
    }, {
      version: 2,
      chatId,
      fileId: 7,
      remoteFileId: "remote-file-7",
      uniqueFileId: "unique-file-7",
      refId: `${chatId}:10:unique-file-7`,
    });
    jobs.forEach((job) => service.store.finishJob(job.id));
  } finally {
    await service.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy media jobs refresh their TDLib file id from the original message", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-refresh-media-job-"));
  const state = new StateStore(join(root, "state.sqlite3"));
  const config = enabledConfig(root);
  writeFileSync(config.mtprotoMasterKeyPath, randomBytes(32), { mode: 0o600 });
  const service = new KnowledgeSyncService(config, state, "", async () => {}, root, 1);
  config.enabled = false;
  const connectorId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const chatId = -100920;
  const sourceId = StateStore.teamSourceId("telegram", String(chatId), "0");
  const downloaded = join(root, "downloaded.pdf");
  try {
    writeFileSync(downloaded, "durable media");
    state.recordTelegramChat({ chatId, type: "supergroup", title: "Media", isForum: false });
    service.grantGroupConsent({ chatId, proof: "signed media agreement" });
    service.store.createConnector({
      id: connectorId,
      apiId: 123,
      encryptedApiHash: "encrypted",
      phoneMask: "***",
      databaseDirectory: join(root, "tdlib"),
    });
    service.store.bindSource({ sourceId, connectorId, telegramChatId: chatId, title: "Media" });
    service.store.startSync(sourceId, connectorId);
    service.store.incrementProgress(sourceId, { mediaDiscovered: 1, mediaPending: 1 });
    service.store.enqueueJob(sourceId, "media", "20:old:0", {
      connectorId,
      fileId: 3,
      fileName: "report.pdf",
      mimeType: "application/pdf",
      size: 13,
      refId: `${chatId}:20:old`,
      telegramMessageId: 20,
      telegramUserId: 1,
      occurredAt: 100,
    });
    let downloadedFileId = 0;
    const mtproto = service.mtproto! as unknown as {
      invoke: (connector: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>;
      downloadFile: (connector: string, fileId: number) => Promise<string>;
    };
    mtproto.invoke = async () => ({
      chat_id: chatId,
      id: 20,
      date: 100,
      content: {
        _: "messageDocument",
        document: {
          file_name: "report.pdf",
          mime_type: "application/pdf",
          document: {
            id: 88,
            size: 13,
            remote: { id: "remote-current", unique_id: "unique-current" },
          },
        },
      },
    });
    mtproto.downloadFile = async (_connector, fileId) => {
      downloadedFileId = fileId;
      return downloaded;
    };
    const job = service.store.claimJobs(1, Number.MAX_SAFE_INTEGER)[0]!;
    await (service as unknown as { processJob: (item: typeof job) => Promise<void> }).processJob(job);

    assert.equal(downloadedFileId, 88);
    assert.equal(service.store.jobStats(sourceId, "media").done, 1);
    assert.equal(service.store.jobStats(sourceId, "media").failed, 0);
  } finally {
    await service.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("media failures record the failing pipeline stage", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-media-error-stage-"));
  const state = new StateStore(join(root, "state.sqlite3"));
  const config = enabledConfig(root);
  writeFileSync(config.mtprotoMasterKeyPath, randomBytes(32), { mode: 0o600 });
  const service = new KnowledgeSyncService(config, state, "", async () => {}, root, 1);
  config.enabled = false;
  const connectorId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const chatId = -100930;
  const sourceId = StateStore.teamSourceId("telegram", String(chatId), "0");
  try {
    state.recordTelegramChat({ chatId, type: "supergroup", title: "Media", isForum: false });
    service.grantGroupConsent({ chatId, proof: "signed media agreement" });
    service.store.createConnector({
      id: connectorId,
      apiId: 123,
      encryptedApiHash: "encrypted",
      phoneMask: "***",
      databaseDirectory: join(root, "tdlib"),
    });
    service.store.bindSource({ sourceId, connectorId, telegramChatId: chatId, title: "Media" });
    service.store.startSync(sourceId, connectorId);
    service.store.incrementProgress(sourceId, { mediaDiscovered: 1, mediaPending: 1 });
    service.store.enqueueJob(sourceId, "media", "30:unique:0", {
      mediaSchemaVersion: 2,
      connectorId,
      chatId,
      fileId: 9,
      remoteFileId: "remote-9",
      uniqueFileId: "unique-9",
      fileName: "voice.ogg",
      mimeType: "audio/ogg",
      size: 12,
      refId: `${chatId}:30:unique-9`,
      telegramMessageId: 30,
      telegramUserId: 1,
    });
    const mtproto = service.mtproto! as unknown as {
      resolveRemoteFile: () => Promise<{
        fileId: number;
        remoteFileId: string;
        uniqueFileId: string;
        size: number;
      }>;
      downloadFile: () => Promise<string>;
    };
    mtproto.resolveRemoteFile = async () => ({
      fileId: 99,
      remoteFileId: "remote-9",
      uniqueFileId: "unique-9",
      size: 12,
    });
    mtproto.downloadFile = async () => { throw new Error("Access Denied"); };
    const job = service.store.claimJobs(1, Number.MAX_SAFE_INTEGER)[0]!;
    await (service as unknown as { processJob: (item: typeof job) => Promise<void> }).processJob(job);

    assert.equal(service.store.jobStats(sourceId, "media").pending, 1);
    assert.equal(
      service.store.jobStats(sourceId, "media").lastError,
      "media[telegram-download]: Access Denied",
    );
  } finally {
    await service.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Admin overview explains skipped messages by observed Telegram author", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-skipped-authors-"));
  const state = new StateStore(join(root, "state.sqlite3"));
  const service = new KnowledgeSyncService(
    { ...enabledConfig(root), enabled: false },
    state,
    "",
    async () => {},
    root,
    1,
  );
  const connectorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const chatId = -100700;
  const sourceId = StateStore.teamSourceId("telegram", String(chatId), "0");
  try {
    state.recordTelegramChat({
      chatId,
      type: "supergroup",
      title: "Operations",
      isForum: false,
    });
    state.recordTelegramTopic(chatId, 0, "general");
    state.recordTelegramTopicUser(chatId, 0, {
      userId: 42,
      username: "customer",
      firstName: "Customer",
      lastName: "One",
      observedAt: 100,
    });
    service.store.createConnector({
      id: connectorId,
      apiId: 123,
      encryptedApiHash: "encrypted",
      phoneMask: "+79***1234",
      databaseDirectory: join(root, "tdlib"),
      now: 100,
    });
    service.store.updateConnector(connectorId, "ready");
    service.store.bindSource({
      sourceId,
      connectorId,
      telegramChatId: chatId,
      title: "Operations",
      now: 101,
    });
    service.store.startSync(sourceId, connectorId, 102);
    service.store.recordUnknownAuthor(sourceId, 42, 103);
    service.store.recordUnknownAuthor(sourceId, 42, 104);
    service.store.recordUnknownAuthor(sourceId, 99, 105);
    service.store.incrementProgress(sourceId, {
      discovered: 4,
      skipped: 4,
      unknownAuthors: 2,
    }, 105, 106);

    const overview = service.overview() as {
      statuses: Array<{
        skippedByAuthor: {
          totalAuthors: number;
          attributedMessages: number;
          unattributedMessages: number;
          items: Array<{
            telegramUserId: number;
            displayName: string;
            username: string;
            messageCount: number;
            reason: string;
            profileObserved: boolean;
          }>;
        };
      }>;
    };
    const breakdown = overview.statuses[0]!.skippedByAuthor;
    assert.equal(breakdown.totalAuthors, 2);
    assert.equal(breakdown.attributedMessages, 3);
    assert.equal(breakdown.unattributedMessages, 1);
    assert.deepEqual(breakdown.items.map((item) => ({
      id: item.telegramUserId,
      name: item.displayName,
      username: item.username,
      messages: item.messageCount,
      reason: item.reason,
      observed: item.profileObserved,
    })), [
      {
        id: 42,
        name: "Customer One",
        username: "customer",
        messages: 2,
        reason: "missing-consent",
        observed: true,
      },
      {
        id: 99,
        name: "Telegram user 99",
        username: "",
        messages: 1,
        reason: "missing-consent",
        observed: false,
      },
    ]);
  } finally {
    await service.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disabled knowledge sync does not require production S3 credentials or an MTProto key", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-disabled-knowledge-sync-"));
  const state = new StateStore(join(root, "state.sqlite3"));
  const config: KnowledgeSyncConfig = {
    enabled: false,
    telegramTermsReviewed: false,
    objectStoreBackend: "s3",
    localObjectRoot: join(root, "objects"),
    spoolRoot: join(root, "spool"),
    spoolMaximumBytes: 100_000_000,
    s3Endpoint: "",
    s3Region: "us-east-1",
    s3Bucket: "",
    s3Prefix: "summing",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3ForcePathStyle: false,
    s3Sse: "AES256",
    s3KmsKeyId: "",
    mtprotoMasterKeyPath: join(root, "missing.key"),
    knowledgeTransferKeyPath: join(root, "missing-transfer.key"),
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 4,
    embeddingBatchSize: 8,
    documentVisionModel: "gpt-test",
  };
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  let service: KnowledgeSyncService | null = null;
  try {
    assert.throws(
      () => new KnowledgeSyncService(
        { ...config, enabled: true },
        state,
        "",
        async () => {},
        root,
        42,
      ),
      /terms review gate/,
    );
    service = new KnowledgeSyncService(config, state, "", async () => {}, root, 42);
    assert.equal(service.objectStore.backend, "local");
    assert.equal(service.mtproto, null);
    await service.start();
  } finally {
    if (service) await service.close();
    state.close();
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
