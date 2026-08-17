import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeSyncConfig } from "../src/config.js";
import { KnowledgeSyncService } from "../src/knowledge-sync.js";
import { StateStore } from "../src/state-store.js";

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
