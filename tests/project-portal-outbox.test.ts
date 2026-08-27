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
      context: { kind: "runner-report", jobId: "legacy-retry" },
    }).id, queued.id, "new reply metadata must not invalidate an already durable payload");
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

test("Project portal outbox persists a native video delivery kind", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-project-portal-video-"));
  const store = new ProjectPortalOutboxStore(root, 20_000_000);
  const portal: ProjectPortalBinding = {
    portalId: "tg-video",
    portalKey: "main",
    isDefault: true,
    transport: "telegram",
    projectId: "ash-shorts",
    workspaceId: "repo",
    chatId: -100500,
    topicId: 9,
    sourceId: null,
    title: "Videos",
  };
  try {
    const queued = store.enqueue({
      projectId: "ash-shorts",
      workspaceId: "repo",
      portal,
      kind: "video",
      text: "Нативное видео готово.",
      attachment: {
        fileName: "video-01.mp4",
        mimeType: "video/mp4",
        data: Uint8Array.from([0, 1, 2, 3]),
      },
      idempotencyKey: "runner:job:video-01",
      createdBy: 42,
    });
    assert.equal(queued.kind, "video");
    assert.deepEqual([...store.attachmentData(store.claimDue()[0]!)!], [0, 1, 2, 3]);
    assert.throws(() => store.enqueue({
      projectId: "ash-shorts",
      workspaceId: "repo",
      portal,
      kind: "video",
      attachment: {
        fileName: "wrong.bin",
        mimeType: "application/octet-stream",
        data: Uint8Array.from([1]),
      },
      idempotencyKey: "runner:job:wrong-video",
      createdBy: 42,
    }), /must be video\/mp4/);
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

test("direct topic reports retain reply-scoped project context without a portal binding", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-project-topic-outbox-"));
  const store = new ProjectPortalOutboxStore(root, 1_000);
  try {
    const queued = store.enqueueTopic({
      projectId: "demo",
      workspaceId: "repo",
      destination: {
        id: "telegram:-100500:67800",
        chatId: -100500,
        topicId: 67800,
      },
      text: "Утренний отчёт готов.",
      idempotencyKey: "runner:job-1:report",
      createdBy: 42,
      context: { kind: "runner-report", jobId: "job-1", scheduleId: "schedule-1" },
    });
    assert.equal(queued.destinationType, "topic");
    assert.equal(queued.portalKey, undefined);
    const sent = store.markSent(store.claimDue()[0]!.id, 245);
    assert.deepEqual(store.sentToTelegramMessage(-100500, 67800, 245), sent);
    assert.deepEqual(sent.context, {
      kind: "runner-report",
      jobId: "job-1",
      scheduleId: "schedule-1",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
