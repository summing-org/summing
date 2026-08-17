import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeSyncStore } from "../src/knowledge-sync-store.js";
import { ContentAddressedObjects, LocalObjectStore } from "../src/object-store.js";

test("content addressed object storage keeps one physical copy with multiple references", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-objects-"));
  const store = new KnowledgeSyncStore(join(root, "core.sqlite"));
  try {
    const original = join(root, "document.txt");
    writeFileSync(original, "same bytes", { mode: 0o600 });
    const objects = new ContentAddressedObjects(
      new LocalObjectStore(join(root, "objects")),
      store,
      "team",
    );
    const first = await objects.ingest({
      sourceId: "source-a",
      refType: "telegram_attachment",
      refId: "1",
      filePath: original,
      fileName: "a.txt",
      mimeType: "text/plain",
    });
    const second = await objects.ingest({
      sourceId: "source-b",
      refType: "telegram_attachment",
      refId: "2",
      filePath: original,
      fileName: "b.txt",
      mimeType: "text/plain",
    });
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.objectKey, second.objectKey);
    const stored = join(root, "objects", first.objectKey);
    assert.equal(readFileSync(stored, "utf8"), "same bytes");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
