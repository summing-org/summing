import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeSyncStore } from "../src/knowledge-sync-store.js";

test("knowledge sync persists checkpoints, consent, stages, jobs and one completion outbox item", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-sync-store-"));
  const path = join(root, "core.sqlite");
  let store = new KnowledgeSyncStore(path);
  try {
    store.createConnector({
      id: "11111111-1111-4111-8111-111111111111",
      apiId: 123,
      encryptedApiHash: "encrypted",
      phoneMask: "+79***1234",
      databaseDirectory: join(root, "tdlib"),
      now: 100,
    });
    store.updateConnector("11111111-1111-4111-8111-111111111111", "ready");
    store.bindSource({
      sourceId: "source-1",
      connectorId: "11111111-1111-4111-8111-111111111111",
      telegramChatId: -1001,
      title: "Engineering",
      now: 101,
    });
    store.grantConsent({
      sourceId: "source-1",
      telegramUserId: 42,
      proof: "contract-42",
      grantedAt: 102,
      historicalFrom: 50,
    });
    assert.equal(store.consentGranted("source-1", 42, 60), true);
    assert.equal(store.consentGranted("source-1", 42, 40), false);
    assert.equal(store.recordUnknownAuthor("source-1", 77, 103), true);
    assert.equal(store.recordUnknownAuthor("source-1", 77, 104), false);

    const runId = store.startSync(
      "source-1",
      "11111111-1111-4111-8111-111111111111",
      105,
    );
    assert.deepEqual(store.consentedRetainedSourceIds(), ["source-1"]);
    store.incrementProgress("source-1", {
      discovered: 10,
      accepted: 8,
      skipped: 2,
      consentedAuthors: 1,
      unknownAuthors: 1,
      mediaDiscovered: 3,
      mediaPending: 3,
    }, 80, 106);
    store.updateCheckpoint("source-1", 555, { fromMessageId: 555 }, 107);
    assert.equal(store.checkpoint("source-1")?.runId, runId);
    assert.equal(store.checkpoint("source-1")?.fromMessageId, 555);

    assert.equal(store.enqueueJob("source-1", "media", "file-1", { fileId: 1 }, 108), true);
    assert.equal(store.enqueueJob("source-1", "media", "file-1", { fileId: 1 }, 108), false);
    const job = store.claimJobs(1, 109)[0]!;
    assert.equal(job.kind, "media");
    store.retryJob(job.id, "S3 unavailable", job.attempts);
    assert.equal(store.jobStats("source-1", "media").pending, 1);

    store.markCollected("source-1", 110);
    store.markCollected("source-1", 111);
    const status = store.syncStatus("source-1")!;
    assert.equal(status.collector.state, "tailing");
    assert.equal(status.collector.initialCollectedAt, 110);
    assert.deepEqual(status.counters, {
      discovered: 10,
      accepted: 8,
      skipped: 2,
      consentedAuthors: 1,
      unknownAuthors: 1,
      mediaDiscovered: 3,
      mediaUploaded: 0,
      mediaPending: 3,
      mediaFailed: 0,
    });
    const outbox = store.claimOutbox(10, 112);
    assert.equal(outbox.length, 1);
    store.finishOutbox(outbox[0]!.id);

    store.close();
    store = new KnowledgeSyncStore(path);
    assert.equal(store.checkpoint("source-1")?.fromMessageId, 555);
    assert.equal(store.claimOutbox(10, 200).length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("connector cannot be revoked while a group is still bound", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-sync-revoke-"));
  const store = new KnowledgeSyncStore(join(root, "core.sqlite"));
  try {
    const id = "22222222-2222-4222-8222-222222222222";
    store.createConnector({
      id,
      apiId: 1,
      encryptedApiHash: "secret",
      phoneMask: "***",
      databaseDirectory: join(root, "tdlib"),
    });
    store.bindSource({ sourceId: "source", connectorId: id, telegramChatId: -1, title: "T" });
    assert.throws(() => store.deleteRevokedConnector(id), /still has bound/);
    store.unbindSource("source");
    store.deleteRevokedConnector(id);
    assert.equal(store.connector(id)?.state, "revoked");
    assert.equal(store.connector(id)?.encryptedApiHash, "");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("author revocation preserves shared objects and removes the last physical reference", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-sync-consent-revoke-"));
  const store = new KnowledgeSyncStore(join(root, "core.sqlite"));
  try {
    const connectorId = "33333333-3333-4333-8333-333333333333";
    store.createConnector({
      id: connectorId,
      apiId: 1,
      encryptedApiHash: "secret",
      phoneMask: "***",
      databaseDirectory: join(root, "tdlib"),
    });
    store.bindSource({ sourceId: "source", connectorId, telegramChatId: -100, title: "T" });
    store.startSync("source", connectorId);
    for (const telegramUserId of [42, 43]) {
      store.grantConsent({ sourceId: "source", telegramUserId, proof: `proof-${telegramUserId}` });
      store.recordContentObject({
        sha256: "a".repeat(64),
        objectKey: `summing/sha256/aa/${"a".repeat(64)}`,
        size: 12,
        mimeType: "application/pdf",
        fileName: "shared.pdf",
        backend: "s3",
        sourceId: "source",
        refType: "telegram_attachment",
        refId: `-100:${telegramUserId}:1`,
        telegramUserId,
      });
    }
    assert.equal(store.contentObjectModelEgressAllowed("a".repeat(64)), true);
    store.revokeConsent("source", 42);
    const first = store.revokeAuthorContent("source", 42);
    assert.equal(first.removed.length, 0);
    assert.ok(store.contentObject("a".repeat(64)));
    store.revokeConsent("source", 43);
    const last = store.revokeAuthorContent("source", 43);
    assert.equal(last.removed.length, 1);
    assert.equal(store.contentObject("a".repeat(64)), null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("message tombstone cancels media jobs and cascades orphaned document chunks", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-sync-tombstone-"));
  const store = new KnowledgeSyncStore(join(root, "core.sqlite"));
  try {
    const connectorId = "44444444-4444-4444-8444-444444444444";
    const hash = "b".repeat(64);
    store.createConnector({
      id: connectorId,
      apiId: 1,
      encryptedApiHash: "secret",
      phoneMask: "***",
      databaseDirectory: join(root, "tdlib"),
    });
    store.bindSource({ sourceId: "source", connectorId, telegramChatId: -100, title: "T" });
    store.startSync("source", connectorId);
    store.enqueueJob("source", "media", "99:7", {
      telegramMessageId: 99,
      telegramUserId: 42,
    });
    store.recordContentObject({
      sha256: hash,
      objectKey: `summing/sha256/bb/${hash}`,
      size: 12,
      mimeType: "application/pdf",
      fileName: "deleted.pdf",
      backend: "s3",
      sourceId: "source",
      refType: "telegram_attachment",
      refId: "-100:99:7",
      telegramUserId: 42,
    });
    store.replaceDocumentBlocks([{
      objectHash: hash,
      sourceId: "source",
      blockKind: "pdf-page",
      ordinal: 0,
      text: "deleted text",
      locator: { page: 1 },
      structure: {},
    }]);
    const chunkId = store.upsertSearchChunk({
      sourceId: "source",
      normalizedHash: "hash",
      text: "deleted text",
      blockIds: [1],
      metadata: { objectHash: hash },
    });
    store.recordRevision({
      sourceId: "source",
      telegramMessageId: 99,
      revision: 1,
      eventKind: "deletion",
      teamEventId: null,
      occurredAt: 100,
    });
    assert.equal(store.messageDeleted("source", 99), true);
    const result = store.removeMessageContent("source", -100, 99);
    assert.equal(result.cancelledMedia, 1);
    assert.deepEqual(result.removed[0]?.chunkIds, [chunkId]);
    assert.equal(store.searchChunk(chunkId), null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalized chunks deduplicate text while retaining every canonical block link", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-sync-chunk-manifest-"));
  const store = new KnowledgeSyncStore(join(root, "core.sqlite"));
  try {
    const connectorId = "55555555-5555-4555-8555-555555555555";
    store.createConnector({
      id: connectorId,
      apiId: 1,
      encryptedApiHash: "secret",
      phoneMask: "***",
      databaseDirectory: join(root, "tdlib"),
    });
    store.bindSource({ sourceId: "source", connectorId, telegramChatId: -100, title: "T" });
    store.startSync("source", connectorId);
    const hashes = ["c".repeat(64), "d".repeat(64)];
    hashes.forEach((hash, index) => store.recordContentObject({
      sha256: hash,
      objectKey: `summing/sha256/${hash.slice(0, 2)}/${hash}`,
      size: 10,
      mimeType: "text/plain",
      fileName: `${index}.txt`,
      backend: "s3",
      sourceId: "source",
      refType: "telegram_attachment",
      refId: `-100:${index + 10}:1`,
      telegramUserId: 42,
    }));
    const firstBlock = store.replaceDocumentBlocks([{
      objectHash: hashes[0]!, sourceId: "source", blockKind: "text", ordinal: 0,
      text: "same", locator: {}, structure: {},
    }])[0]!;
    const secondBlock = store.replaceDocumentBlocks([{
      objectHash: hashes[1]!, sourceId: "source", blockKind: "text", ordinal: 0,
      text: "same", locator: {}, structure: {},
    }])[0]!;
    const firstChunk = store.upsertSearchChunk({
      sourceId: "source", normalizedHash: "same-hash", text: "same",
      blockIds: [firstBlock], metadata: { objectHash: hashes[0] },
    });
    const secondChunk = store.upsertSearchChunk({
      sourceId: "source", normalizedHash: "same-hash", text: "same",
      blockIds: [secondBlock], metadata: { objectHash: hashes[1] },
    });
    assert.equal(firstChunk, secondChunk);
    assert.deepEqual(store.searchChunk(firstChunk)?.blockIds, [firstBlock, secondBlock]);
    assert.deepEqual(store.removeMessageContent("source", -100, 10).removed[0]?.chunkIds, []);
    assert.deepEqual(store.searchChunk(firstChunk)?.blockIds, [secondBlock]);
    assert.deepEqual(store.removeMessageContent("source", -100, 11).removed[0]?.chunkIds, [firstChunk]);
    assert.equal(store.searchChunk(firstChunk), null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
