import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StateStore } from "../src/state-store.js";

function tempStore(): { root: string; path: string; store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "summing-state-"));
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
    assert.deepEqual(store.counts(), {
      conversations: 1,
      active: 1,
      pending: 3,
      team_spaces: 0,
      team_events: 0,
      team_events_pending: 0,
      team_knowledge: 0,
    });
    store.setTelegramOffset(123);
    assert.equal(store.telegramOffset(), 123);
    store.consume([steerId, followId, viewerId]);
    store.clearActive(conversation.id);
    assert.deepEqual(store.counts(), {
      conversations: 1,
      active: 0,
      pending: 0,
      team_spaces: 0,
      team_events: 0,
      team_events_pending: 0,
      team_knowledge: 0,
    });
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

test("aggregates observed Telegram users by chat and topic with stable IDs", () => {
  const { root, store } = tempStore();
  try {
    store.recordTelegramChat({
      chatId: -100700,
      type: "supergroup",
      title: "Product",
      isForum: true,
      observedAt: 1_700_001_000,
    });
    store.recordTelegramTopic(-100700, 17, "Design", 1_700_001_000);
    store.recordTelegramTopic(-100700, 18, "Research", 1_700_001_000);
    store.recordTelegramTopicUser(-100700, 17, {
      userId: 42,
      username: "maria",
      firstName: "Маша",
      languageCode: "ru",
      observedAt: 1_700_001_100,
    });
    store.recordTelegramTopicUser(-100700, 17, {
      userId: 42,
      firstName: "Мария",
      isPremium: true,
      observedAt: 1_700_001_120,
    });
    store.recordTelegramTopicUser(-100700, 18, {
      userId: 42,
      observedAt: 1_700_001_130,
    });
    store.recordTelegramTopicUser(-100700, 17, {
      userId: 77,
      username: "helper_bot",
      firstName: "Helper",
      isBot: true,
      observedAt: 1_700_001_125,
    });

    assert.equal(store.telegramUserCount(), 2);
    assert.equal(store.telegramChatUserCount(-100700), 2);
    assert.equal(store.telegramTopicUserCount(-100700, 17), 2);
    assert.equal(store.telegramTopicUserCount(-100700, 18), 1);
    assert.deepEqual(store.listTelegramChatUsers(-100700), [
      {
        userId: 42,
        username: "maria",
        firstName: "Мария",
        lastName: "",
        isBot: false,
        languageCode: "ru",
        isPremium: true,
        messageCount: 3,
        topicCount: 2,
        firstSeenAt: 1_700_001_100,
        lastSeenAt: 1_700_001_130,
      },
      {
        userId: 77,
        username: "helper_bot",
        firstName: "Helper",
        lastName: "",
        isBot: true,
        languageCode: "",
        isPremium: false,
        messageCount: 1,
        topicCount: 1,
        firstSeenAt: 1_700_001_125,
        lastSeenAt: 1_700_001_125,
      },
    ]);
    assert.equal(store.listTelegramTopicUsers(-100700, 17)[0]?.messageCount, 2);
    assert.equal(store.listTelegramTopicUsers(-100700, 18)[0]?.userId, 42);
    assert.equal(store.forgetTelegramChatUser(-100700, 42), 2);
    assert.equal(store.telegramUserCount(), 1);
    assert.deepEqual(store.listTelegramChatUsers(-100700).map((user) => user.userId), [77]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Team Space journals evidence, preserves provenance, and honors erasure", () => {
  const { root, path, store } = tempStore();
  try {
    const first = store.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "17",
      spaceName: "Engineering",
      sourceTitle: "Backend",
      externalEventId: "101",
      eventKind: "message",
      senderExternalId: "42",
      senderDisplayName: "Маша",
      text: "Релиз переносим на пятницу из-за миграции.",
      occurredAt: 1_700_000_100,
      observedAt: 1_700_000_101,
      administratorUserId: 1,
    })!;
    const second = store.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "17",
      spaceName: "Engineering",
      sourceTitle: "Backend",
      externalEventId: "102",
      eventKind: "message",
      senderExternalId: "77",
      senderDisplayName: "Иван",
      text: "Я закончу миграцию к четвергу.",
      replyToExternalEventId: "101",
      attachments: [{
        kind: "document",
        fileName: "plan.txt",
        mimeType: "text/plain",
        size: 12,
        providerFileId: "file-1",
      }],
      occurredAt: 1_700_000_110,
      observedAt: 1_700_000_111,
      administratorUserId: 1,
    })!;
    const duplicate = store.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "17",
      spaceName: "Engineering",
      sourceTitle: "Backend",
      externalEventId: "102",
      eventKind: "message",
      senderExternalId: "77",
      senderDisplayName: "Иван",
      text: "duplicate delivery",
      occurredAt: 1_700_000_110,
      administratorUserId: 1,
    })!;
    assert.equal(duplicate.id, second.id);
    const space = store.teamSpaceForProvider("telegram", "-100500")!;
    assert.equal(store.teamEventCount(space.id), 2);
    assert.equal(
      store.teamEventByExternalId(second.sourceId, "101")?.id,
      first.id,
    );
    assert.deepEqual(
      store.pendingTeamEvents(space.id).map((event) => [
        event.id,
        event.senderDisplayName,
        event.text,
        event.replyToExternalEventId,
      ]),
      [
        [first.id, "Маша", "Релиз переносим на пятницу из-за миграции.", ""],
        [second.id, "Иван", "Я закончу миграцию к четвергу.", "101"],
      ],
    );
    store.applyTeamSynthesis(space.id, [first.id, second.id], {
      summary: "Команда готовит миграцию перед релизом.",
      knowledge: [{
        kind: "decision",
        subject: "релиз",
        statement: "Релиз перенесён на пятницу.",
        confidence: 0.98,
        status: "active",
        visibility: "space",
        visibilityRef: "",
        evidenceEventIds: [first.id],
        supersedesKnowledgeIds: [],
        validFrom: 1_700_000_100,
        validTo: null,
      }, {
        kind: "task",
        subject: "Иван",
        statement: "Завершить миграцию к четвергу.",
        confidence: 0.95,
        status: "active",
        visibility: "space",
        visibilityRef: "",
        evidenceEventIds: [second.id],
        supersedesKnowledgeIds: [],
        validFrom: 1_700_000_110,
        validTo: null,
      }],
      orientationReady: false,
      orientationMessage: "",
      clarificationQuestions: [],
      proactiveReplyEventId: null,
      proactiveMessage: "",
    }, 1_700_000_120);
    assert.equal(store.pendingTeamEventCount(space.id), 0);
    assert.equal(store.teamSpace(space.id)?.summary, "Команда готовит миграцию перед релизом.");
    assert.deepEqual(
      store.teamKnowledge(space.id).map((item) => [
        item.kind,
        item.statement,
        item.evidenceEventIds,
      ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      [
        ["decision", "Релиз перенесён на пятницу.", [first.id]],
        ["task", "Завершить миграцию к четвергу.", [second.id]],
      ],
    );
    assert.equal(
      store.teamKnowledgeForIdentity(space.id, "telegram", "42")[0]?.kind,
      "decision",
    );
    assert.equal(store.forgetTeamIdentity(space.id, "telegram", "42"), 1);
    assert.equal(store.teamIdentityObservationEnabled(space.id, "telegram", "42"), false);
    assert.equal(store.teamEvent(first.id)?.synthesisState, "redacted");
    assert.equal(store.teamEvent(first.id)?.text, "");
    assert.equal(store.teamEvent(first.id)?.senderDisplayName, "");
    assert.equal(store.teamKnowledge(space.id).some((item) => item.kind === "decision"), false);
    assert.equal(store.teamKnowledge(space.id).some((item) => item.kind === "task"), true);
    assert.equal(store.teamSpace(space.id)?.summaryStatus, "needs-review");
    assert.equal(store.pendingTeamEventCount(space.id), 1);
    assert.equal(store.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "17",
      spaceName: "Engineering",
      sourceTitle: "Backend",
      externalEventId: "103",
      eventKind: "message",
      senderExternalId: "42",
      senderDisplayName: "Маша",
      text: "Это больше не должно сохраняться.",
      occurredAt: 1_700_000_130,
      administratorUserId: 1,
    }), null);
    store.close();
    const reopened = new StateStore(path);
    try {
      assert.equal(reopened.teamEventCount(space.id), 1);
      assert.equal(reopened.teamKnowledge(space.id).length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // The persistence assertion already closed this handle.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("repairs legacy forum-root reply edges", () => {
  const { root, path, store } = tempStore();
  try {
    const event = store.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "17",
      spaceName: "Engineering",
      sourceTitle: "Backend",
      externalEventId: "101",
      eventKind: "message",
      senderExternalId: "42",
      senderDisplayName: "Маша",
      text: "Обычное сообщение внутри forum topic",
      replyToExternalEventId: "17",
      occurredAt: 1_700_000_100,
      administratorUserId: 1,
    })!;
    assert.equal(store.teamEvent(event.id)?.replyToExternalEventId, "17");
    store.applyTeamSynthesis(event.spaceId, [event.id], {
      summary: "Legacy summary built from a transport-only edge.",
      knowledge: [{
        kind: "fact",
        subject: "forum reply",
        statement: "Сообщение якобы отвечало корню топика.",
        confidence: 0.8,
        status: "active",
        visibility: "space",
        visibilityRef: "",
        evidenceEventIds: [event.id],
        supersedesKnowledgeIds: [],
        validFrom: 1_700_000_100,
        validTo: null,
      }],
      orientationReady: false,
      orientationMessage: "",
      clarificationQuestions: [],
      proactiveReplyEventId: null,
      proactiveMessage: "",
    }, 1_700_000_110);
    assert.equal(store.teamEvent(event.id)?.synthesisState, "synthesized");
    store.close();

    const reopened = new StateStore(path);
    try {
      assert.equal(reopened.teamEvent(event.id)?.replyToExternalEventId, "");
      assert.equal(reopened.teamEvent(event.id)?.synthesisState, "pending");
      assert.equal(reopened.teamKnowledge(event.spaceId)[0]?.status, "needs-review");
      assert.equal(reopened.teamSpace(event.spaceId)?.summaryStatus, "needs-review");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Team Space pause and retention prevent covert indefinite collection", () => {
  const { root, store } = tempStore();
  try {
    const event = store.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-900",
      externalThreadId: "0",
      spaceName: "Privacy",
      sourceTitle: "general",
      externalEventId: "1",
      eventKind: "message",
      senderExternalId: "42",
      senderDisplayName: "User",
      text: "old evidence",
      occurredAt: 1_000,
      administratorUserId: 1,
    })!;
    const space = store.teamSpaceForProvider("telegram", "-900")!;
    assert.equal(store.purgeExpiredTeamEvidence(30, 1_000 + 31 * 86_400), 1);
    assert.equal(store.teamEvent(event.id)?.synthesisState, "redacted");
    store.setTeamSpacePhase(space.id, "paused");
    assert.equal(store.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-900",
      externalThreadId: "0",
      spaceName: "Privacy",
      sourceTitle: "general",
      externalEventId: "2",
      eventKind: "message",
      senderExternalId: "42",
      senderDisplayName: "User",
      text: "must not persist",
      occurredAt: 2_000,
      administratorUserId: 1,
    }), null);
    assert.equal(store.teamEventCount(space.id), 0);
  } finally {
    store.close();
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
  const root = mkdtempSync(join(tmpdir(), "summing-state-migration-"));
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

test("migrates the pre-egress Team Space intervention schema", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-team-egress-migration-"));
  const path = join(root, "state.sqlite3");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE team_spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      administrator_user_id INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'observing',
      summary TEXT NOT NULL DEFAULT '',
      announced_at REAL,
      oriented_at REAL,
      last_intervention_at REAL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE team_interventions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      space_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('admission', 'orientation', 'proactive')),
      reason TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to_external_event_id TEXT NOT NULL DEFAULT '',
      provider_message_id TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      sent_at REAL
    );
  `);
  legacy.close();

  const migrated = new StateStore(path);
  try {
    const { space, source } = migrated.ensureTeamSource({
      provider: "telegram",
      externalSpaceId: "-100700",
      externalThreadId: "4",
      spaceName: "Migration",
      sourceTitle: "General",
      administratorUserId: 1,
    });
    const interventionId = migrated.recordTeamIntervention({
      spaceId: space.id,
      sourceId: source.id,
      kind: "egress-notice",
      reason: "explicit consent",
      text: "Model egress enabled",
      replyToExternalEventId: "",
      providerMessageId: "",
    });
    migrated.markTeamInterventionSent(interventionId, "900");
    migrated.markTeamSpaceModelEgressAnnounced(space.id);
    assert.equal(migrated.teamSpace(space.id)?.modelEgressAnnouncedAt !== null, true);
    assert.equal(migrated.teamSpace(space.id)?.summaryStatus, "active");
  } finally {
    migrated.close();
    rmSync(root, { recursive: true, force: true });
  }
});
