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
