import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeSyncConfig } from "../src/config.js";
import { KnowledgeSyncStore } from "../src/knowledge-sync-store.js";
import {
  KnowledgeTransferManager,
  unwrapPortableTransferKey,
  wrapPortableTransferKey,
} from "../src/knowledge-transfer.js";
import { ContentAddressedObjects, LocalObjectStore } from "../src/object-store.js";
import { StateStore } from "../src/state-store.js";

function transferConfig(root: string, prefix: string, keyPath: string): KnowledgeSyncConfig {
  return {
    enabled: true,
    telegramTermsReviewed: true,
    objectStoreBackend: "local",
    localObjectRoot: join(root, "objects"),
    spoolRoot: join(root, `spool-${prefix}`),
    spoolMaximumBytes: 100_000_000,
    s3Endpoint: "",
    s3Region: "us-east-1",
    s3Bucket: "",
    s3Prefix: prefix,
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3ForcePathStyle: false,
    s3Sse: "AES256",
    s3KmsKeyId: "",
    mtprotoMasterKeyPath: join(root, "unused-mtproto.key"),
    knowledgeTransferKeyPath: keyPath,
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: 4,
    embeddingBatchSize: 8,
    documentVisionModel: "gpt-test",
  };
}

test("portable recovery keys are stored only as node-local encrypted envelopes", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-transfer-key-"));
  const keyPath = join(root, "transfer.key");
  const localKey = randomBytes(32);
  const portableKey = randomBytes(32);
  try {
    writeFileSync(keyPath, localKey, { mode: 0o600 });
    const transferId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const wrapped = wrapPortableTransferKey(keyPath, transferId, portableKey);
    assert.equal(wrapped.includes(portableKey.toString("hex")), false);
    assert.deepEqual(unwrapPortableTransferKey(keyPath, transferId, wrapped), portableKey);
    assert.throws(
      () => unwrapPortableTransferKey(
        keyPath,
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        wrapped,
      ),
    );
  } finally {
    localKey.fill(0);
    portableKey.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable knowledge bundle round-trips into clean databases and reimports idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-kb-transfer-"));
  const sourceKeyPath = join(root, "source-transfer.key");
  const targetKeyPath = join(root, "target-transfer.key");
  const portableKey = randomBytes(32);
  writeFileSync(sourceKeyPath, randomBytes(32), { mode: 0o600 });
  writeFileSync(targetKeyPath, randomBytes(32), { mode: 0o600 });
  const objects = new LocalObjectStore(join(root, "objects"));
  const sourceState = new StateStore(join(root, "source-state.sqlite3"));
  const sourceCore = new KnowledgeSyncStore(join(root, "source-core.sqlite"));
  const targetState = new StateStore(join(root, "target-state.sqlite3"));
  const targetCore = new KnowledgeSyncStore(join(root, "target-core.sqlite"));
  try {
    const event = sourceState.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100555",
      externalThreadId: "0",
      spaceName: "Engineering",
      sourceTitle: "Engineering",
      externalEventId: "101",
      eventKind: "message",
      senderExternalId: "42",
      senderDisplayName: "Ada",
      text: "The launch decision is Friday.",
      occurredAt: 100,
      observedAt: 101,
      administratorUserId: 42,
    })!;
    const secondEvent = sourceState.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100555",
      externalThreadId: "77",
      spaceName: "Engineering",
      sourceTitle: "Engineering / Architecture",
      externalEventId: "202",
      eventKind: "message",
      senderExternalId: "43",
      senderDisplayName: "Grace",
      text: "The architecture topic belongs to the same Team Space.",
      occurredAt: 102,
      observedAt: 103,
      administratorUserId: 42,
    })!;
    const connectorId = "11111111-1111-4111-8111-111111111111";
    sourceCore.createConnector({
      id: connectorId,
      apiId: 1,
      encryptedApiHash: "must-not-be-exported",
      phoneMask: "+7***",
      databaseDirectory: join(root, "tdlib"),
    });
    sourceCore.bindSource({
      sourceId: event.sourceId,
      connectorId,
      telegramChatId: -100555,
      title: "Engineering",
    });
    sourceCore.grantConsent({
      sourceId: event.sourceId,
      telegramUserId: 42,
      proof: "contract-42",
      grantedAt: 90,
      historicalFrom: 0,
    });
    sourceCore.grantConsent({
      sourceId: secondEvent.sourceId,
      telegramUserId: 43,
      proof: "contract-43",
      grantedAt: 91,
      historicalFrom: 0,
    });
    sourceCore.recordUnknownAuthor(secondEvent.sourceId, 99, 102);
    sourceCore.recordRevision({
      sourceId: event.sourceId,
      telegramMessageId: 101,
      revision: 0,
      eventKind: "message",
      teamEventId: event.id,
      occurredAt: 100,
    });
    sourceCore.recordRevision({
      sourceId: secondEvent.sourceId,
      telegramMessageId: 202,
      revision: 0,
      eventKind: "message",
      teamEventId: secondEvent.id,
      occurredAt: 102,
    });
    sourceState.recordTeamUnderstandingFailure(
      event.spaceId,
      [event.id, secondEvent.id],
      "fixture failure",
      104,
    );
    sourceState.recordTeamIntervention({
      spaceId: event.spaceId,
      sourceId: secondEvent.sourceId,
      kind: "proactive",
      reason: "fixture",
      text: "Review architecture",
      replyToExternalEventId: "202",
      providerMessageId: "",
    });
    sourceState.linkTeamProject(event.spaceId, "architecture-project");

    const originalPath = join(root, "architecture.txt");
    writeFileSync(originalPath, "Architecture evidence", { mode: 0o600 });
    const sourceObjects = new ContentAddressedObjects(objects, sourceCore, "source-prefix");
    const stored = await sourceObjects.ingest({
      sourceId: event.sourceId,
      refType: "telegram_attachment",
      refId: "-100555:101:1",
      filePath: originalPath,
      fileName: "architecture.txt",
      mimeType: "text/plain",
      telegramUserId: 42,
    });
    const blockId = sourceCore.replaceDocumentBlocks([{
      objectHash: stored.sha256,
      sourceId: event.sourceId,
      blockKind: "paragraph",
      ordinal: 0,
      text: "Architecture evidence",
      locator: { page: 1 },
      structure: { heading: "Architecture" },
    }])[0]!;
    const chunkId = sourceCore.upsertSearchChunk({
      sourceId: event.sourceId,
      normalizedHash: "chunk-hash",
      text: "Architecture evidence",
      blockIds: [blockId],
      metadata: { objectHash: stored.sha256, page: 1 },
    });
    sourceCore.setSemanticEmbedding({
      evidenceType: "document_block",
      evidenceRef: `chunk:${chunkId}`,
      sourceId: event.sourceId,
      model: "text-embedding-3-small",
      vector: new Float32Array([1, 0, 0, 0]),
      normalizedHash: "chunk-hash",
    });

    const exportId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sourceManager = new KnowledgeTransferManager(
      transferConfig(root, "source-prefix", sourceKeyPath),
      sourceState,
      sourceCore,
      objects,
      42,
    );
    const exported = await sourceManager.export({
      exportId,
      spaceId: event.spaceId,
      mode: "portable",
      includeEmbeddings: true,
      transferKey: portableKey,
    });
    assert.equal(exported.counts.sources, 2);
    assert.equal(exported.counts.events, 2);
    assert.equal(exported.counts.consents, 2);
    assert.equal(exported.counts.unknownAuthors, 1);
    assert.equal(exported.counts.synthesisRuns, 1);
    assert.equal(exported.counts.interventions, 1);
    assert.equal(exported.counts.projectLinks, 1);
    assert.equal(exported.counts.objects, 1);
    assert.equal(await objects.exists(exported.bundleKey), true);

    const targetManager = new KnowledgeTransferManager(
      transferConfig(root, "target-prefix", targetKeyPath),
      targetState,
      targetCore,
      objects,
      9001,
    );
    const dummyHash = "d".repeat(64);
    targetCore.recordContentObject({
      sha256: dummyHash,
      objectKey: `target-prefix/sha256/dd/${dummyHash}`,
      size: 1,
      mimeType: "text/plain",
      fileName: "existing.txt",
      backend: "local",
      sourceId: "existing-source",
      refType: "fixture",
      refId: "existing",
    });
    const dummyBlockId = targetCore.replaceDocumentBlocks([{
      objectHash: dummyHash,
      sourceId: "existing-source",
      blockKind: "paragraph",
      ordinal: 0,
      text: "existing",
      locator: {},
      structure: {},
    }])[0]!;
    targetCore.upsertSearchChunk({
      sourceId: "existing-source",
      normalizedHash: "existing-hash",
      text: "existing",
      blockIds: [dummyBlockId],
      metadata: { objectHash: dummyHash },
    });
    await assert.rejects(targetManager.inspect(exported.bundleKey), /signature is invalid/);
    const dryRun = await targetManager.inspect(exported.bundleKey, portableKey);
    assert.equal(dryRun.ready, true);
    assert.equal(dryRun.sources.length, 2);
    assert.equal(dryRun.grantedConsents, 2);
    assert.deepEqual(dryRun.linkedProjectIds, ["architecture-project"]);
    assert.equal(dryRun.missingObjects, 0);
    assert.equal(dryRun.consentOverrides, 0);
    assert.equal(dryRun.knowledgeConflicts, 0);
    await assert.rejects(
      targetManager.import(exported.bundleKey, false, portableKey),
      /explicit acceptance/,
    );

    const imported = await targetManager.import(exported.bundleKey, true, portableKey);
    assert.deepEqual(imported.imported, {
      events: 2,
      knowledge: 0,
      synthesisRuns: 1,
      interventions: 1,
      projectLinks: 1,
      consents: 2,
      unknownAuthors: 1,
      objects: 1,
      blocks: 1,
      chunks: 1,
    });
    const targetSource = targetState.teamSource(event.sourceId)!;
    assert.equal(targetState.teamEventCount(targetSource.spaceId), 2);
    assert.equal(targetState.teamSpace(targetSource.spaceId)?.administratorUserId, 9001);
    assert.equal(targetCore.consent(event.sourceId, 42)?.proof, "contract-42");
    assert.equal(targetCore.consent(secondEvent.sourceId, 43)?.proof, "contract-43");
    const targetChunks = targetCore.searchChunksAfter(0);
    assert.equal(targetChunks.length, 2);
    const importedChunk = targetChunks.find((chunk) => chunk.sourceId === event.sourceId)!;
    assert.deepEqual(importedChunk.blockIds, [2]);
    assert.deepEqual(
      [...targetCore.semanticEmbedding(
        "document_block",
        `chunk:${importedChunk.id}`,
        "text-embedding-3-small",
        4,
      )!],
      [1, 0, 0, 0],
    );
    assert.equal(targetCore.listImportedKnowledgeSources().length, 2);
    assert.ok(targetCore.listImportedKnowledgeSources().every((source) =>
      source.telegramChatId === -100555
    ));
    assert.equal(
      await objects.exists(`target-prefix/sha256/${stored.sha256.slice(0, 2)}/${stored.sha256}`),
      true,
    );

    await targetManager.import(exported.bundleKey, true, portableKey);
    assert.equal(targetState.teamEventCount(targetSource.spaceId), 2);
    assert.equal(targetCore.searchChunksAfter(0).length, 2);

    const manifestExport = await sourceManager.export({
      exportId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      spaceId: event.spaceId,
      mode: "manifest",
      includeEmbeddings: false,
      transferKey: portableKey,
    });
    const manifestDryRun = await targetManager.inspect(manifestExport.bundleKey, portableKey);
    assert.equal(manifestDryRun.mode, "manifest");
    assert.equal(manifestDryRun.ready, true);
    assert.equal(manifestDryRun.counts.embeddings, 0);

    const revokedState = new StateStore(join(root, "revoked-state.sqlite3"));
    const revokedCore = new KnowledgeSyncStore(join(root, "revoked-core.sqlite"));
    try {
      revokedCore.grantConsent({
        sourceId: event.sourceId,
        telegramUserId: 42,
        proof: "locally-revoked",
      });
      revokedCore.revokeConsent(event.sourceId, 42);
      const revokedManager = new KnowledgeTransferManager(
        transferConfig(root, "revoked-prefix", targetKeyPath),
        revokedState,
        revokedCore,
        objects,
        9002,
      );
      const revokedDryRun = await revokedManager.inspect(exported.bundleKey, portableKey);
      assert.equal(revokedDryRun.consentOverrides, 1);
      await revokedManager.import(exported.bundleKey, true, portableKey);
      const revokedSource = revokedState.teamSource(event.sourceId)!;
      assert.equal(revokedState.teamEventCount(revokedSource.spaceId), 1);
      assert.equal(revokedCore.consent(event.sourceId, 42)?.status, "revoked");
      assert.equal(revokedCore.contentObject(stored.sha256), null);
    } finally {
      revokedState.close();
      revokedCore.close();
    }

    const manifestPath = join(root, "objects", ...exported.bundleKey.split("/"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.hmac = "00".repeat(32);
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    await assert.rejects(
      targetManager.inspect(exported.bundleKey, portableKey),
      /signature is invalid/,
    );
  } finally {
    portableKey.fill(0);
    sourceState.close();
    sourceCore.close();
    targetState.close();
    targetCore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge import requires explicit consent confirmation before it is requeued", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-kb-consent-import-"));
  const path = join(root, "core.sqlite");
  let store = new KnowledgeSyncStore(path);
  try {
    const transfer = store.createKnowledgeTransfer({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      kind: "import",
      mode: "portable",
      bundleKey: "bundle/manifest.json",
    });
    assert.equal(transfer.state, "queued");
    assert.equal(store.claimKnowledgeTransfer()?.state, "running");
    store.close();
    store = new KnowledgeSyncStore(path);
    assert.equal(store.knowledgeTransfer(transfer.id)?.state, "queued");
    assert.equal(store.claimKnowledgeTransfer()?.state, "running");
    store.awaitKnowledgeImportConfirmation(transfer.id, { grantedConsents: 1 }, transfer.bundleKey);
    assert.throws(() => store.confirmKnowledgeImport(transfer.id, false), /explicit acceptance/);
    assert.equal(store.confirmKnowledgeImport(transfer.id, true).state, "queued");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
