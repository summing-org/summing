import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeSearchIndex } from "../src/knowledge-search.js";

test("contentless FTS returns evidence and replaces revised text", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-search-"));
  const index = new KnowledgeSearchIndex(join(root, "search.sqlite"), 4);
  try {
    index.indexText({
      sourceId: "source",
      evidenceType: "event",
      evidenceRef: "1",
      text: "обсуждаем архитектуру платежного сервиса",
      normalizedHash: "v1",
      locator: { messageId: 1 },
    });
    assert.equal(index.search("архитектура", null)[0]?.evidenceRef, "1");
    index.indexText({
      sourceId: "source",
      evidenceType: "event",
      evidenceRef: "1",
      text: "обсуждаем дизайн уведомлений",
      normalizedHash: "v2",
      locator: { messageId: 1 },
    });
    assert.equal(index.search("архитектура", null).length, 0);
    assert.equal(index.search("уведомлений", null)[0]?.evidenceRef, "1");
    index.remove("event", "1");
    assert.equal(index.search("уведомлений", null).length, 0);
  } finally {
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hybrid candidates honor source, author, topic, date and document filters", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-search-filters-"));
  const index = new KnowledgeSearchIndex(join(root, "search.sqlite"), 4);
  try {
    index.indexText({
      sourceId: "source-a",
      evidenceType: "event",
      evidenceRef: "event:1",
      text: "план релиза",
      normalizedHash: "event-1",
      locator: { authorId: "42", topicId: "7", occurredAt: 200 },
      embedding: new Float32Array([1, 0, 0, 0]),
    });
    index.indexText({
      sourceId: "source-a",
      evidenceType: "document_block",
      evidenceRef: "chunk:2",
      text: "план релиза в таблице",
      normalizedHash: "chunk-2",
      locator: { documentType: "application/pdf", occurredAt: 220 },
      embedding: new Float32Array([1, 0, 0, 0]),
    });
    assert.equal(index.search("релиз", null, {
      sourceId: "source-a",
      authorId: "42",
      topicId: "7",
      dateFrom: 100,
      dateTo: 210,
    })[0]?.evidenceRef, "event:1");
    assert.equal(index.search("релиз", null, {
      evidenceType: "document_block",
      documentType: "application/pdf",
    })[0]?.evidenceRef, "chunk:2");
    assert.equal(index.search("релиз", null, { authorId: "99" }).length, 0);
  } finally {
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sqlite-vec contributes semantic candidates when the extension is available", (context) => {
  const root = mkdtempSync(join(tmpdir(), "summing-vectors-"));
  const index = new KnowledgeSearchIndex(join(root, "search.sqlite"), 4);
  try {
    if (!index.vectorAvailable) {
      context.skip("sqlite-vec is unavailable on this platform");
      return;
    }
    index.indexText({
      sourceId: "source",
      evidenceType: "document_block",
      evidenceRef: "chunk:1",
      text: "unrelated lexical text",
      normalizedHash: "chunk",
      embedding: new Float32Array([1, 0, 0, 0]),
    });
    const result = index.search("missing words", new Float32Array([0.99, 0.01, 0, 0]));
    assert.equal(result[0]?.evidenceRef, "chunk:1");
    assert.equal(result[0]?.vectorRank, 1);
  } finally {
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("derived-index rebuild marker is versioned by model and dimensions", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-search-rebuild-"));
  const path = join(root, "search.sqlite");
  let index = new KnowledgeSearchIndex(path, 4);
  try {
    assert.equal(index.rebuildRequired("v1:model-a:4"), true);
    index.markRebuilt("v1:model-a:4");
    assert.equal(index.rebuildRequired("v1:model-a:4"), false);
    assert.equal(index.rebuildRequired("v1:model-b:4"), true);
    index.indexText({
      sourceId: "source",
      evidenceType: "event",
      evidenceRef: "1",
      text: "derived entry",
      normalizedHash: "hash",
    });
    index.reset();
    assert.equal(index.entryCount(), 0);
    assert.equal(index.rebuildRequired("v1:model-a:4"), true);
    index.close();
    index = new KnowledgeSearchIndex(path, 8);
    assert.equal(index.rebuildRequired("v1:model-a:8"), true);
  } finally {
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
});
