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

test("group consent grants every observed human and applies to every Telegram topic", async () => {
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
      granted: 2,
      newlyGranted: 2,
      alreadyGranted: 0,
      telegramUserIds: [42, 43],
    });
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
      false,
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
