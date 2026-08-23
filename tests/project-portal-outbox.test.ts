import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectPortalOutboxStore } from "../src/project-portal-outbox.js";
import type { ProjectPortalBinding } from "../src/state-store.js";

test("Project portal outbox persists, retries, verifies and deduplicates a document", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-project-portal-outbox-"));
  let clock = new Date("2026-08-22T08:00:00.000Z");
  const store = new ProjectPortalOutboxStore(root, 1_000, () => clock);
  const portal: ProjectPortalBinding = {
    portalId: "tg-portal",
    portalKey: "main",
    isDefault: true,
    transport: "telegram",
    projectId: "demo",
    workspaceId: "repo",
    chatId: -100500,
    topicId: 9,
    sourceId: "telegram-source",
    title: "Customer",
  };
  try {
    const queued = store.enqueue({
      projectId: "demo",
      workspaceId: "repo",
      portal,
      text: "Файл от исполнителя",
      attachment: {
        fileName: "brief.pdf",
        mimeType: "application/pdf",
        data: new TextEncoder().encode("%PDF brief"),
      },
      idempotencyKey: "turn-1-file-1",
      createdBy: 42,
    });
    assert.equal(store.enqueue({
      projectId: "demo",
      workspaceId: "repo",
      portal,
      text: "Файл от исполнителя",
      attachment: {
        fileName: "brief.pdf",
        mimeType: "application/pdf",
        data: new TextEncoder().encode("%PDF brief"),
      },
      idempotencyKey: "turn-1-file-1",
      createdBy: 42,
    }).id, queued.id);
    const first = store.claimDue()[0]!;
    assert.equal(first.status, "sending");
    assert.equal(Buffer.from(store.attachmentData(first)!).toString("utf8"), "%PDF brief");
    const failed = store.markFailed(first.id, "Telegram unavailable");
    assert.equal(failed.status, "failed");
    assert.deepEqual(store.claimDue(), []);
    clock = new Date("2026-08-22T08:00:06.000Z");
    const retry = store.claimDue()[0]!;
    assert.equal(retry.attempts, 2);
    const sent = store.markSent(retry.id, 245);
    assert.equal(sent.status, "sent");
    assert.equal(sent.telegramMessageId, 245);
    assert.equal(existsSync(join(store.root, sent.id, "attachment.bin")), false);
    assert.deepEqual(store.claimDue(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted send becomes uncertain and requires an explicit retry", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-project-portal-uncertain-"));
  let clock = new Date("2026-08-23T08:00:00.000Z");
  const portal: ProjectPortalBinding = {
    portalId: "tg-portal",
    portalKey: "reports",
    isDefault: true,
    transport: "telegram",
    projectId: "demo",
    workspaceId: "repo",
    chatId: -100500,
    topicId: 9,
    sourceId: null,
    title: "Reports",
  };
  try {
    const first = new ProjectPortalOutboxStore(root, 1_000, () => clock);
    const queued = first.enqueue({
      projectId: "demo",
      workspaceId: "repo",
      portal,
      text: "Проверить результат",
      idempotencyKey: "turn-uncertain",
      createdBy: 42,
      originConversationId: "internal-topic",
    });
    assert.equal(first.claimDue()[0]?.status, "sending");
    const reopened = new ProjectPortalOutboxStore(root, 1_000, () => clock);
    assert.equal(reopened.get(queued.id)?.status, "uncertain");
    assert.deepEqual(reopened.claimDue(), []);
    assert.equal(reopened.notificationDue()[0]?.id, queued.id);
    reopened.markNotificationFailed(queued.id);
    assert.deepEqual(reopened.notificationDue(), []);
    clock = new Date("2026-08-23T08:00:16.000Z");
    assert.equal(reopened.notificationDue()[0]?.id, queued.id);
    assert.equal(reopened.retry(queued.id).status, "pending");
    assert.equal(reopened.claimDue()[0]?.attempts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
