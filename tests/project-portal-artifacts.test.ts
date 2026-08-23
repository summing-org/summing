import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectPortalArtifactStore } from "../src/project-portal-artifacts.js";

test("portal artifacts are encrypted, scoped, integrity checked and retained", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-project-portal-artifact-"));
  let clock = new Date("2026-08-23T08:00:00.000Z");
  try {
    const store = new ProjectPortalArtifactStore(root, 10_000, 2, () => clock);
    const plaintext = new TextEncoder().encode("private customer brief");
    const record = store.store({
      projectId: "demo",
      workspaceId: "repo",
      portalId: "portal-id",
      portalKey: "main",
      eventId: 42,
      telegramMessageId: 78061,
      providerFileId: "telegram-file-id",
      kind: "document",
      fileName: "brief.txt",
      mimeType: "text/plain",
      data: plaintext,
    });
    assert.equal(record.portalKey, "main");
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      readFileSync(join(store.root, `${record.id}.bin`)).includes(Buffer.from(plaintext)),
      false,
    );
    assert.equal(Buffer.from(store.read(record.id).data).toString("utf8"), "private customer brief");
    assert.equal(readFileSync(store.keyPath).byteLength, 32);

    clock = new Date("2026-08-26T08:00:00.000Z");
    assert.equal(store.prune(), 1);
    assert.equal(existsSync(join(store.root, `${record.id}.json`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
