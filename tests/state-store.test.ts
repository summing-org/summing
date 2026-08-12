import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StateStore } from "../src/state-store.js";

function tempStore(): { root: string; path: string; store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "summate-state-"));
  const path = join(root, "state.sqlite3");
  return { root, path, store: new StateStore(path) };
}

test("binding, input queues, and Telegram offset", () => {
  const { root, store } = tempStore();
  try {
    const conversation = store.bind(-1001, 17, "secret-cloud", "web");
    assert.deepEqual(store.byTopic(-1001, 17), conversation);
    store.setThread(conversation.id, "thr_1");
    store.setThread(conversation.id, "thr_readonly", "read-only");
    assert.equal(store.get(conversation.id).codexThreadId, "thr_1");
    assert.equal(store.get(conversation.id).readOnlyCodexThreadId, "thr_readonly");
    store.setActive(conversation.id, "turn_1", 99);
    const steerId = store.enqueueInput(conversation.id, 10, "stop editing", "steer");
    const followId = store.enqueueInput(conversation.id, 11, "also inspect logout", "followup");
    const viewerId = store.enqueueInput(
      conversation.id,
      12,
      "how does logout work?",
      "followup",
      "read-only",
      55,
      "ambient",
      [{
        kind: "document",
        fileName: "source.zip",
        mimeType: "application/zip",
        filePath: "/private/spool/source.zip",
        size: 27,
      }],
    );
    assert.deepEqual(store.pending(conversation.id, "steer").map((item) => item.id), [steerId]);
    assert.deepEqual(store.pending(conversation.id, "followup").map((item) => item.id), [followId]);
    assert.deepEqual(
      store.pendingAll(conversation.id).map((item) => [
        item.id,
        item.access,
        item.senderId,
        item.responseMode,
        item.attachments.map((attachment) => attachment.fileName),
      ]),
      [
        [steerId, "write", 0, "direct", []],
        [followId, "write", 0, "direct", []],
        [viewerId, "read-only", 55, "ambient", ["source.zip"]],
      ],
    );
    assert.deepEqual(store.counts(), { conversations: 1, active: 1, pending: 3 });
    store.setTelegramOffset(123);
    assert.equal(store.telegramOffset(), 123);
    store.consume([steerId, followId, viewerId]);
    store.clearActive(conversation.id);
    assert.deepEqual(store.counts(), { conversations: 1, active: 0, pending: 0 });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rebinding starts a fresh Codex context", () => {
  const { root, store } = tempStore();
  try {
    const conversation = store.bind(5, 9, "one", "app");
    store.setThread(conversation.id, "thr_old");
    store.setThread(conversation.id, "thr_readonly_old", "read-only");
    const rebound = store.bind(5, 9, "two", "backend");
    assert.equal(rebound.projectId, "two");
    assert.equal(rebound.codexThreadId, null);
    assert.equal(rebound.readOnlyCodexThreadId, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists Telegram memberships and discovered topics", () => {
  const { root, path, store } = tempStore();
  store.recordTelegramChat({
    chatId: -100500,
    type: "supergroup",
    title: "Engineering",
    username: "engineering",
    isForum: true,
    botStatus: "administrator",
    addedByUserId: 42,
    joinedAt: 1_700_000_000,
    lastEventJson: '{"event":"joined"}',
    observedAt: 1_700_000_000,
  });
  store.recordTelegramTopic(-100500, 17, "Backend", 1_700_000_100);
  store.bind(-100600, 23, "legacy", "repo");
  store.close();

  const reopened = new StateStore(path);
  try {
    assert.deepEqual(reopened.telegramChat(-100500), {
      chatId: -100500,
      type: "supergroup",
      title: "Engineering",
      username: "engineering",
      isForum: true,
      botStatus: "administrator",
      addedByUserId: 42,
      joinedAt: 1_700_000_000,
      lastEventJson: '{"event":"joined"}',
      firstSeenAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
    });
    assert.deepEqual(reopened.telegramTopic(-100500, 17), {
      chatId: -100500,
      topicId: 17,
      name: "Backend",
      firstSeenAt: 1_700_000_100,
      updatedAt: 1_700_000_100,
    });
    assert.equal(reopened.telegramChat(-100600)?.botStatus, "unknown");
    assert.equal(reopened.telegramTopic(-100600, 23)?.name, "");
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovers active state and steer", () => {
  const { root, path, store } = tempStore();
  const conversation = store.bind(1, 2, "demo", "app");
  const runId = store.startRun(conversation.id, "work");
  store.attachTurn(runId, "turn-1");
  store.setActive(conversation.id, "turn-1", 9);
  store.enqueueInput(conversation.id, 10, "continue safely", "steer");
  store.close();
  const recovered = new StateStore(path);
  try {
    assert.equal(recovered.counts().active, 0);
    assert.deepEqual(recovered.pending(conversation.id, "steer"), []);
    assert.deepEqual(
      recovered.pending(conversation.id, "followup").map((item) => item.text),
      ["work", "continue safely"],
    );
  } finally {
    recovered.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart restores original ambient batch inputs and reply ids", () => {
  const { root, path, store } = tempStore();
  const conversation = store.bind(-100, 7, "demo", "app");
  const first = store.enqueueInput(
    conversation.id,
    101,
    "Первое сообщение",
    "followup",
    "read-only",
    41,
    "ambient",
  );
  const second = store.enqueueInput(
    conversation.id,
    102,
    "Второе сообщение",
    "followup",
    "read-only",
    42,
    "ambient",
    [{
      kind: "document",
      fileName: "context.txt",
      mimeType: "text/plain",
      filePath: "/private/spool/context.txt",
      size: 12,
    }],
  );
  store.startRun(
    conversation.id,
    "generated ambient prompt",
    [first, second],
    "read-only",
    "ambient",
  );
  store.close();

  const recovered = new StateStore(path);
  try {
    assert.deepEqual(
      recovered.pendingAll(conversation.id).map((item) => [
        item.telegramMessageId,
        item.text,
        item.senderId,
        item.responseMode,
        item.attachments.map((attachment) => attachment.fileName),
      ]),
      [
        [101, "Первое сообщение", 41, "ambient", []],
        [102, "Второе сообщение", 42, "ambient", ["context.txt"]],
      ],
    );
  } finally {
    recovered.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrates existing conversations to separate read-only state", () => {
  const root = mkdtempSync(join(tmpdir(), "summate-state-migration-"));
  const path = join(root, "state.sqlite3");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      topic_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      codex_thread_id TEXT,
      active_turn_id TEXT,
      stream_message_id INTEGER,
      worktree_path TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      UNIQUE(chat_id, topic_id)
    );
    CREATE TABLE pending_inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      telegram_message_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('steer', 'followup')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'consumed')),
      created_at REAL NOT NULL
    );
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      turn_id TEXT,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      response TEXT NOT NULL DEFAULT '',
      error TEXT,
      started_at REAL NOT NULL,
      completed_at REAL
    );
    INSERT INTO conversations
      (id, chat_id, topic_id, project_id, workspace_id, codex_thread_id, created_at, updated_at)
    VALUES ('legacy', -1, 7, 'demo', 'app', 'thr_write', 1, 1);
    INSERT INTO pending_inputs
      (conversation_id, telegram_message_id, text, mode, created_at)
    VALUES ('legacy', 9, 'existing owner input', 'followup', 1);
  `);
  legacy.close();

  const migrated = new StateStore(path);
  try {
    assert.equal(migrated.get("legacy").codexThreadId, "thr_write");
    assert.equal(migrated.get("legacy").readOnlyCodexThreadId, null);
    assert.equal(migrated.pendingAll("legacy")[0]?.access, "write");
    assert.equal(migrated.pendingAll("legacy")[0]?.senderId, 0);
    assert.equal(migrated.pendingAll("legacy")[0]?.responseMode, "direct");
    assert.deepEqual(migrated.pendingAll("legacy")[0]?.attachments, []);
    const viewerId = migrated.enqueueInput(
      "legacy",
      10,
      "viewer question",
      "followup",
      "read-only",
      99,
      "ambient",
    );
    assert.deepEqual(
      migrated.pending("legacy", "followup", "read-only").map((item) => item.id),
      [viewerId],
    );
    assert.equal(migrated.pendingAll("legacy").at(-1)?.senderId, 99);
    assert.equal(migrated.pendingAll("legacy").at(-1)?.responseMode, "ambient");
  } finally {
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed projects and owners persist", () => {
  const { root, path, store } = tempStore();
  store.createManagedProject({
    id: "client",
    name: "client",
    ownerId: 42,
    defaultWorkspaceId: "repo",
    workspaces: [{ id: "repo", path: join(root, "repositories", "client", "repo") }],
    createdAt: 123,
  });
  store.close();

  const reopened = new StateStore(path);
  try {
    assert.deepEqual(reopened.listManagedProjects(), [
      {
        id: "client",
        name: "client",
        ownerId: 42,
        defaultWorkspaceId: "repo",
        workspaces: [{ id: "repo", path: join(root, "repositories", "client", "repo") }],
        createdAt: 123,
      },
    ]);
    assert.throws(() =>
      reopened.createManagedProject({
        id: "client",
        name: "duplicate",
        ownerId: 99,
        defaultWorkspaceId: "repo",
        workspaces: [{ id: "repo", path: join(root, "duplicate") }],
        createdAt: 456,
      }),
    );
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});
