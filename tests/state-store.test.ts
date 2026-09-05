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

test("historical runs and retry payloads cannot follow a rebound topic", () => {
  const { root, store } = tempStore();
  try {
    const old = store.bind(-100, 5, "alpha", "repo");
    const id = store.startRun(old.id, "ALPHA_PRIVATE", []);
    store.finishRun(id, "interrupted", "", "restart");
    assert.equal(store.conversationRun(old, id)?.requestText, "ALPHA_PRIVATE");
    const current = store.bind(-100, 5, "beta", "repo");
    assert.equal(store.conversationRun(old, id), null, "reject a stale authorization snapshot");
    assert.equal(store.conversationRun(current, id), null);
    assert.throws(() => store.retryInterruptedRun(current.id, id, 90, 2), /not found/);
    assert.deepEqual(store.pendingAll(current.id), []);
    const workspace = store.bind(-100, 5, "alpha", "different");
    assert.equal(store.conversationRun(workspace, id), null);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("durable Telegram intake survives reopen and is atomically consumed with its agent input", () => {
  const { root, path, store } = tempStore();
  const topic = store.bind(-100, 1, "alpha", "repo");
  store.enqueueTelegramIntake(10, -100, 1, "scope", JSON.stringify({ voice: { file_id: "file" } }));
  assert.equal(store.telegramOffset(), 11, "intake admission and provider offset must share one commit");
  store.enqueueTelegramIntake(10, -100, 1, "scope", "duplicate");
  store.checkpointTelegramIntake(10, { kind: "audio", fileName: "voice.ogg", mimeType: "audio/ogg", filePath: "/synthetic/voice.ogg", size: 10 });
  store.close();
  const reopened = new StateStore(path);
  try {
    assert.equal(reopened.telegramIntakes().length, 1);
    assert.equal(reopened.telegramIntake(10)?.attachment?.fileName, "voice.ogg");
    assert.equal(reopened.telegramOffset(), 11);
    reopened.enqueueInput(topic.id, 10, "transcript", "followup", "write", 1, "direct", [], null, null, 10);
    assert.equal(reopened.telegramIntakes().length, 0);
    assert.equal(reopened.pendingAll(topic.id).length, 1);
    assert.throws(() => reopened.enqueueInput(topic.id, 10, "duplicate", "followup", "write", 1, "direct", [], null, null, 10), /consumed/);
    reopened.enqueueTelegramIntake(12, -100, 1, "scope", "{}");
    reopened.bind(-100, 1, "beta", "repo");
    reopened.bind(-100, 1, "alpha", "repo");
    assert.equal(reopened.telegramIntake(12)?.cancelled, true, "ABA rebind must invalidate intake too");
    assert.throws(() => reopened.enqueueInput(topic.id, 12, "old", "followup", "write", 1, "direct", [], null, null, 12), /cancelled/);
    for (let id = 13; id < 44; id++) reopened.enqueueTelegramIntake(id, -100, 1, "scope", "{}");
    assert.throws(() => reopened.enqueueTelegramIntake(44, -100, 1, "scope", "{}"), /заполнена/);
  } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});

test("binding, input queues, and Telegram offset", () => {
  const { root, store } = tempStore();
  try {
    const conversation = store.bind(-1001, 17, "secret-cloud", "web");
    assert.deepEqual(store.byTopic(-1001, 17), conversation);
    store.setThread(conversation.id, "thr_1");
    store.setThread(conversation.id, "thr_readonly", "read-only");
    assert.equal(store.get(conversation.id).codexThreadId, "thr_1");
    assert.equal(store.get(conversation.id).readOnlyCodexThreadId, "thr_readonly");
    assert.equal(store.get(conversation.id).modelOverride, "");
    assert.equal(store.get(conversation.id).effortOverride, "");
    store.setConversationModel(conversation.id, "gpt-5.6-luna", "high");
    assert.equal(store.get(conversation.id).modelOverride, "gpt-5.6-luna");
    assert.equal(store.get(conversation.id).effortOverride, "high");
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
        kind: "image",
        fileName: "owner-photo.jpg",
        mimeType: "image/jpeg",
        filePath: "/private/spool/owner-photo.jpg",
        size: 27,
      }],
      { fileName: "voice.ogg", text: "Проверить транскрипцию" },
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
        item.audioTranscript?.fileName ?? null,
      ]),
      [
        [steerId, "write", 0, "direct", [], null],
        [followId, "write", 0, "direct", [], null],
        [viewerId, "read-only", 55, "ambient", ["owner-photo.jpg"], "voice.ogg"],
      ],
    );
    assert.deepEqual(store.pendingAll(conversation.id)[2]?.audioTranscript, {
      fileName: "voice.ogg",
      text: "Проверить транскрипцию",
    });
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

test("portal bindings stay outside primary Q&A while retaining scoped history", () => {
  const { root, store } = tempStore();
  try {
    const conversation = store.bind(
      -100500,
      9,
      "ash-telegrams",
      "repo",
      "observer",
    );
    assert.equal(conversation.role, "observer");
    assert.equal(store.byTopic(-100500, 9), null);
    assert.equal(store.topicConversation(-100500, 9)?.id, conversation.id);
    assert.deepEqual(store.customerChannel(-100500, 9), {
      id: StateStore.customerChannelId(-100500, 9),
      chatId: -100500,
      topicId: 9,
      title: "topic 9",
      legacyConversationId: conversation.id,
      createdAt: store.customerChannel(-100500, 9)?.createdAt,
      updatedAt: store.customerChannel(-100500, 9)?.updatedAt,
    });
    const event = store.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "9",
      spaceName: "Customer group",
      sourceTitle: "Customer topic",
      externalEventId: "78061",
      eventKind: "message",
      senderExternalId: "123456789",
      senderDisplayName: "Customer",
      text: "Нужен лёгкий контент без отраслевой аналитики.",
      replyToExternalEventId: "78032",
      occurredAt: 1_776_000_000,
      administratorUserId: 1,
    });
    assert.ok(event);
    assert.equal(store.observerProjectSources("ash-telegrams")[0]?.id, event.sourceId);
    assert.deepEqual(
      store.observerProjectEvents({ projectId: "ash-telegrams", query: "аналитики" })
        .map((item) => [item.externalEventId, item.replyToExternalEventId, item.text]),
      [["78061", "78032", "Нужен лёгкий контент без отраслевой аналитики."]],
    );
    const portal = store.projectPortals("ash-telegrams", "repo")[0]!;
    assert.equal(portal.portalId, conversation.id);
    assert.equal(portal.sourceId, event.sourceId);
    assert.equal(store.projectPortalReplyMessageId(portal, event.id), 78061);

    const rebound = store.bind(-100500, 9, "ash-telegrams", "repo");
    assert.equal(rebound.role, "primary");
    assert.deepEqual(store.observerProjectSources("ash-telegrams"), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("result publications isolate customer discussion and Project feedback", () => {
  const { root, store } = tempStore();
  try {
    const publication = store.recordResultPublication({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "dry-run",
      scheduleId: "daily",
      outboxId: "outbox-result-1",
      reportText: "Отчёт готов.",
      artifactName: "report.html",
      chatId: -100500,
      topicId: 9,
      channelTitle: "Отчёты заказчику",
      telegramMessageId: 78032,
      createdAt: 100,
    });
    assert.equal(store.byTopic(-100500, 9), null);
    assert.equal(store.customerChannelsForProject("ash-telegrams", "repo")[0]?.id,
      publication.channelId);
    assert.equal(store.resultPublicationForMessage(-100500, 9, 78032)?.id, publication.id);

    store.recordResultMessage({
      publicationId: publication.id,
      chatId: -100500,
      topicId: 9,
      telegramMessageId: 78040,
      author: "agent",
      senderId: 500,
      text: "Цифра рассчитана по 56 публикациям.",
      createdAt: 110,
    });
    const feedback = store.recordProjectFeedback({
      publicationId: publication.id,
      telegramMessageId: 78041,
      senderId: 42,
      text: "Покажите также отклонённые каналы.",
      createdAt: 120,
    });
    assert.equal(store.resultPublicationForMessage(-100500, 9, 78040)?.id, publication.id);
    assert.deepEqual(
      store.resultDiscussion(publication.id).map((message) => message.author),
      ["publication", "agent", "customer"],
    );
    assert.deepEqual(store.projectFeedback({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      query: "отклонённые",
    }).map((item) => [item.id, item.publicationId, item.status]), [
      [feedback.id, publication.id, "new"],
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Project portals resolve stable logical keys and exactly one default", () => {
  const { root, store } = tempStore();
  try {
    const main = store.bind(-100500, 9, "ash-telegrams", "repo", "observer", {
      portalKey: "main",
      isDefault: true,
    });
    const reports = store.bind(-100500, 10, "ash-telegrams", "repo", "observer", {
      portalKey: "reports",
      isDefault: false,
    });
    assert.equal(store.resolveProjectPortal("ash-telegrams", "repo")?.portalId, main.id);
    assert.equal(
      store.resolveProjectPortal("ash-telegrams", "repo", "reports")?.portalId,
      reports.id,
    );
    store.bind(-100500, 10, "ash-telegrams", "repo", "observer", {
      portalKey: "reports",
      isDefault: true,
    });
    const portals = store.projectPortals("ash-telegrams", "repo");
    assert.deepEqual(
      portals.map((portal) => [portal.portalKey, portal.isDefault]),
      [["reports", true], ["main", false]],
    );
    assert.equal(store.resolveProjectPortal("ash-telegrams", "repo")?.portalKey, "reports");
    assert.throws(
      () => store.bind(-100500, 11, "ash-telegrams", "repo", "observer", {
        portalKey: "Reports!",
      }),
      /portalKey/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact Telegram destinations support multiple groups and many-to-many Project scopes", () => {
  const { root, store } = tempStore();
  try {
    const customer = store.bindProjectTopicDestination({
      projectId: "seo-dashboard",
      workspaceId: "repo",
      chatId: -100500,
      topicId: 9,
      title: "Customer releases",
      createdBy: 1,
    });
    store.bindProjectTopicDestination({
      projectId: "seo-dashboard",
      workspaceId: "repo",
      chatId: -100900,
      topicId: 0,
      title: "Owner statistics",
      createdBy: 1,
    });
    store.bindProjectTopicDestination({
      projectId: "other-project",
      workspaceId: "repo",
      chatId: -100500,
      topicId: 9,
      title: "Shared customer topic",
      createdBy: 2,
    });
    assert.deepEqual(
      store.projectTopicDestinations("seo-dashboard", "repo")
        .map((destination) => [destination.chatId, destination.topicId]),
      [[-100900, 0], [-100500, 9]],
    );
    assert.deepEqual(
      store.projectTopicDestinationsForTopic(-100500, 9)
        .map((destination) => destination.projectId).sort(),
      ["other-project", "seo-dashboard"],
    );
    assert.equal(
      store.projectTopicDestination("seo-dashboard", "repo", -100500, 9)?.id,
      customer.id,
    );
    assert.equal(
      store.unbindProjectTopicDestination("seo-dashboard", "repo", -100500, 9)?.id,
      customer.id,
    );
    assert.equal(
      store.projectTopicDestination("other-project", "repo", -100500, 9)?.projectId,
      "other-project",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one Project workspace has multiple workers and one stable main topic", () => {
  const { root, store } = tempStore();
  try {
    const primary = store.bind(-100500, 9, "demo", "repo", "primary");
    const observer = store.bind(-100501, 10, "demo", "repo", "observer");
    assert.equal(primary.role, "primary");
    assert.equal(observer.role, "observer");
    const parallel = store.bind(-100502, 11, "demo", "repo");
    assert.equal(primary.isPrimary, true);
    assert.equal(observer.isPrimary, false);
    assert.equal(parallel.isPrimary, false);
    assert.equal(store.primaryConversation("demo", "repo")?.id, primary.id);
    assert.equal(store.bind(-100502, 11, "demo", "repo").isPrimary, false);
    assert.equal(store.byTopic(-100502, 11)?.id, parallel.id);
    store.unbind(primary.chatId, primary.topicId);
    assert.equal(store.primaryConversation("demo", "repo")?.id, parallel.id);
    store.bind(parallel.chatId, parallel.topicId, "other", "repo");
    assert.equal(store.primaryConversation("demo", "repo"), null);
    assert.equal(store.primaryConversation("other", "repo")?.id, parallel.id);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the model-egress switch and rolls usage into the active weekly window", () => {
  const { root, path, store } = tempStore();
  try {
    assert.equal(store.teamModelEgressEnabledOverride(), null);
    assert.equal(store.teamProactiveRepliesEnabledOverride(), null);
    store.setTeamModelEgressEnabled(false);
    store.setTeamProactiveRepliesEnabled(true);
    assert.equal(store.teamModelEgressEnabledOverride(), false);
    assert.equal(store.teamProactiveRepliesEnabledOverride(), true);
    assert.deepEqual(store.recordTeamModelEgressUsage({
      weeklyResetsAt: 200,
      measured: true,
      estimatedCreditsMicros: 1_250_000,
      observedWeeklyPercent: 2,
      updatedAt: 100,
    }), {
      weeklyResetsAt: 200,
      turns: 1,
      measuredTurns: 1,
      estimatedCreditsMicros: 1_250_000,
      observedWeeklyPercent: 2,
      updatedAt: 100,
    });
    store.recordTeamModelEgressUsage({
      weeklyResetsAt: 200,
      measured: false,
      estimatedCreditsMicros: 250_000,
      observedWeeklyPercent: 0,
      updatedAt: 110,
    });
    assert.equal(store.teamModelEgressUsage()?.turns, 2);
    assert.equal(store.teamModelEgressUsage()?.measuredTurns, 1);
    assert.equal(store.teamModelEgressUsage()?.estimatedCreditsMicros, 1_500_000);
    store.recordTeamModelEgressUsage({
      weeklyResetsAt: 300,
      measured: true,
      estimatedCreditsMicros: 100_000,
      observedWeeklyPercent: 1,
      updatedAt: 120,
    });
    assert.equal(store.teamModelEgressUsage()?.turns, 1);
    store.close();
    const reopened = new StateStore(path);
    try {
      assert.equal(reopened.teamModelEgressEnabledOverride(), false);
      assert.equal(reopened.teamProactiveRepliesEnabledOverride(), true);
      assert.equal(reopened.teamModelEgressUsage()?.weeklyResetsAt, 300);
    } finally {
      reopened.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // It was closed before reopening the same database.
    }
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

test("unbinding removes local routing history but preserves the discovered Telegram topic", () => {
  const { root, path, store } = tempStore();
  try {
    store.recordTelegramChat({
      chatId: -1005,
      type: "supergroup",
      title: "Engineering",
      isForum: true,
      botStatus: "administrator",
    });
    store.recordTelegramTopic(-1005, 23, "Backend");
    const conversation = store.bind(-1005, 23, "one", "app");
    store.setThread(conversation.id, "thr_old");
    const inputId = store.enqueueInput(conversation.id, 7, "completed work", "followup");
    const runId = store.startRun(conversation.id, "completed work", [inputId]);
    store.finishRun(runId, "completed", "done");

    const removed = store.unbind(-1005, 23);
    assert.equal(removed?.id, conversation.id);
    assert.equal(removed?.codexThreadId, "thr_old");
    assert.equal(store.byTopic(-1005, 23), null);
    assert.equal(store.telegramTopic(-1005, 23)?.name, "Backend");
    assert.deepEqual(store.pendingAll(conversation.id), []);
    assert.equal(store.counts().conversations, 0);

    const raw = new DatabaseSync(path);
    try {
      const row = raw.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number };
      assert.equal(Number(row.count), 0);
    } finally {
      raw.close();
    }
    assert.equal(store.unbind(-1005, 23), null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("write threads migrate once when host capabilities change and preserve the previous id", () => {
  const { root, store } = tempStore();
  try {
    const conversation = store.bind(5, 10, "one", "app");
    store.setThread(conversation.id, "thr_old", "write", "legacy-v1");
    assert.equal(
      store.archiveWriteThreadForCapability(conversation.id, "runner-control-v1"),
      "thr_old",
    );
    const archived = store.get(conversation.id);
    assert.equal(archived.codexThreadId, null);
    assert.equal(archived.codexThreadCapability, "");
    assert.equal(archived.previousCodexThreadId, "thr_old");

    store.setThread(conversation.id, "thr_new", "write", "runner-control-v1");
    assert.equal(
      store.archiveWriteThreadForCapability(conversation.id, "runner-control-v1"),
      null,
    );
    const current = store.get(conversation.id);
    assert.equal(current.codexThreadId, "thr_new");
    assert.equal(current.codexThreadCapability, "runner-control-v1");
    assert.equal(current.previousCodexThreadId, "thr_old");
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
    assert.equal(first.directClaimedAt, null);
    assert.equal(store.claimTeamEventForDirectResponse(first.id, 1_700_000_105)?.directClaimedAt,
      1_700_000_105);
    assert.equal(store.claimTeamEventForDirectResponse(first.id, 1_700_000_109)?.directClaimedAt,
      1_700_000_105);
    assert.equal(store.teamEvent(second.id)?.directClaimedAt, null);
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
    store.applyTeamUnderstanding(space.id, [first.id, second.id], {
      episode: {
        sourceId: first.sourceId,
        subject: "Перенос релиза и миграция",
        synopsis: "Маша перенесла релиз, Иван взял завершение миграции.",
        confidence: 0.95,
        eventIds: [first.id, second.id],
        participants: [{
          personId: first.personId,
          role: "speaker",
          intent: "Зафиксировать перенос релиза",
          confidence: 0.9,
          evidenceEventIds: [first.id],
        }, {
          personId: second.personId,
          role: "speaker",
          intent: "Взять обязательство по миграции",
          confidence: 0.9,
          evidenceEventIds: [second.id],
        }],
      },
      summary: "Команда готовит миграцию перед релизом.",
      knowledge: [{
        kind: "episode",
        subject: "Перенос релиза и миграция",
        statement: "Маша перенесла релиз, Иван взял завершение миграции.",
        confidence: 0.95,
        status: "resolved",
        visibility: "source",
        visibilityRef: first.sourceId,
        evidenceEventIds: [first.id, second.id],
        supersedesKnowledgeIds: [],
        validFrom: 1_700_000_100,
        validTo: 1_700_000_110,
      }, {
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
      intervention: {
        action: "silent",
        replyToEventId: null,
        message: "",
        reason: "Команда уже согласовала следующие действия.",
      },
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
        ["episode", "Маша перенесла релиз, Иван взял завершение миграции.", [first.id, second.id]],
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
    store.applyTeamUnderstanding(event.spaceId, [event.id], {
      episode: {
        sourceId: event.sourceId,
        subject: "Legacy forum reply",
        synopsis: "Сообщение было ошибочно связано с корнем forum topic.",
        confidence: 0.8,
        eventIds: [event.id],
        participants: [{
          personId: event.personId,
          role: "speaker",
          intent: "",
          confidence: 1,
          evidenceEventIds: [event.id],
        }],
      },
      summary: "Legacy summary built from a transport-only edge.",
      knowledge: [{
        kind: "episode",
        subject: "Legacy forum reply",
        statement: "Сообщение было ошибочно связано с корнем forum topic.",
        confidence: 0.8,
        status: "resolved",
        visibility: "source",
        visibilityRef: event.sourceId,
        evidenceEventIds: [event.id],
        supersedesKnowledgeIds: [],
        validFrom: 1_700_000_100,
        validTo: 1_700_000_100,
      }, {
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
      intervention: {
        action: "silent",
        replyToEventId: null,
        message: "",
        reason: "Нет основания вмешиваться.",
      },
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
    const retainedEvent = store.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-901",
      externalThreadId: "0",
      spaceName: "Permanent library",
      sourceTitle: "general",
      externalEventId: "1",
      eventKind: "message",
      senderExternalId: "43",
      senderDisplayName: "User 2",
      text: "retained evidence",
      occurredAt: 1_000,
      administratorUserId: 1,
    })!;
    const retainedSpace = store.teamSpaceForProvider("telegram", "-901")!;
    assert.equal(
      store.purgeExpiredTeamEvidence(30, 1_000 + 31 * 86_400, [retainedSpace.id]),
      1,
    );
    assert.equal(store.teamEvent(event.id)?.synthesisState, "redacted");
    assert.equal(store.teamEvent(retainedEvent.id)?.synthesisState, "pending");
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

test("restart interrupts write work without replay and preserves an explicit retry path", () => {
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
      ["continue safely"],
    );
    const delivery = recovered.runDeliveries(runId).find((item) => item.kind === "notice");
    assert.equal(delivery?.status, "uncertain");
    assert.match(delivery?.text ?? "", new RegExp(`/retry ${runId}`));
    recovered.retryInterruptedRun(conversation.id, runId, 11, 42);
    const retry = recovered.pending(conversation.id, "followup")
      .find((item) => item.retryOfRunId === runId);
    assert.equal(retry?.text, "work");
    assert.equal(retry?.senderId, 42);
  } finally {
    recovered.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("run delivery finalization is durable and restart never resends stored payloads", () => {
  const { root, path, store } = tempStore();
  const conversation = store.bind(1, 3, "demo", "app");
  const runId = store.startRun(conversation.id, "prepare answer", [], "write", "direct", 42);
  const deliveries = store.finishRunWithDeliveries(runId, "completed", "done", null, [{
    kind: "response",
    ordinal: 0,
    chatId: conversation.chatId,
    topicId: conversation.topicId,
    replyToMessageId: 15,
    text: "<b>done</b>",
    parseMode: "HTML",
  }]);
  assert.equal(deliveries[0]?.status, "pending");
  const claimed = store.claimRunDeliveries(runId);
  assert.equal(claimed[0]?.status, "sending");
  store.close();

  const recovered = new StateStore(path);
  try {
    const uncertain = recovered.runDeliveries(runId)[0]!;
    assert.equal(uncertain.status, "uncertain");
    assert.match(uncertain.lastError, /will not be resent/);
    assert.deepEqual(recovered.claimRunDeliveries(runId), []);
  } finally {
    recovered.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("project run history is full-text searchable without indexing effective prompts or crossing scope", () => {
  const { root, store } = tempStore();
  try {
    const demo = store.bind(1, 1, "demo", "app");
    const otherWorkspace = store.bind(1, 2, "demo", "worker");
    const otherProject = store.bind(1, 3, "other", "app");
    const first = store.startRun(demo.id, "prepare migration checklist", [], "write", "direct", 7);
    store.setRunPrompt(first, "effective prompt with private-observer-only-marker");
    store.finishRun(first, "completed", "migration completed safely");
    const second = store.startRun(demo.id, "write release notes", [], "write", "direct", 7);
    store.finishRun(second, "completed", "release notes ready");
    const workspaceRun = store.startRun(
      otherWorkspace.id,
      "migration in worker",
      [],
      "write",
      "direct",
      7,
    );
    store.finishRun(workspaceRun, "completed", "worker migration");
    const projectRun = store.startRun(
      otherProject.id,
      "migration in other project",
      [],
      "write",
      "direct",
      7,
    );
    store.finishRun(projectRun, "completed", "other migration");

    assert.deepEqual(
      store.searchProjectRuns("demo", "app", "migration").map((run) => run.id),
      [first],
    );
    assert.deepEqual(
      store.searchProjectRuns("demo", "app", "private-observer-only-marker"),
      [],
    );
    assert.deepEqual(
      store.recentProjectRuns("demo", "app").map((run) => run.id),
      [second, first],
    );
    assert.equal(store.projectRun("demo", "app", workspaceRun), null);
    assert.equal(store.projectRun("demo", "app", projectRun), null);
    assert.equal(store.projectRun("demo", "app", first)?.requestText, "prepare migration checklist");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("structured project memory migrates legacy notes and preserves lifecycle provenance", () => {
  const { root, store } = tempStore();
  try {
    assert.equal(store.initializeProjectMemory(
      "demo",
      "# Project memory: Demo\n\n- Legacy fact\n- Legacy decision\n",
    ), 2);
    assert.equal(store.initializeProjectMemory("demo", "- ignored second migration\n"), 0);
    const constraint = store.rememberProjectMemory(
      "demo",
      "constraint",
      "All API timestamps use UTC",
      "user",
      42,
    );
    assert.equal(
      store.rememberProjectMemory(
        "demo",
        "constraint",
        "All API timestamps use UTC",
        "user",
        42,
      ).id,
      constraint.id,
    );
    const replacement = store.supersedeProjectMemory(
      "demo",
      constraint.id,
      "constraint",
      "All external timestamps use RFC 3339 UTC",
      "user",
      42,
    );
    assert.equal(replacement.supersedesId, constraint.id);
    assert.equal(
      store.projectMemoryItems("demo", true).find((item) => item.id === constraint.id)?.status,
      "superseded",
    );
    store.archiveProjectMemory("demo", replacement.id);
    assert.equal(
      store.projectMemoryItems("demo", true).find((item) => item.id === replacement.id)?.status,
      "archived",
    );
    assert.deepEqual(
      store.projectMemoryItems("demo").map((item) => item.text),
      ["Legacy fact", "Legacy decision"],
    );
    assert.match(store.projectMemoryProjection("demo", "Demo"), /memory:\d+.*Legacy fact/);
    assert.doesNotMatch(store.projectMemoryProjection("demo", "Demo"), /RFC 3339/);
    assert.deepEqual(store.projectMemoryItems("other"), []);
  } finally {
    store.close();
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
    INSERT INTO runs
      (id, conversation_id, status, prompt, response, started_at, completed_at)
    VALUES (4, 'legacy', 'completed', 'legacy migration request',
            'legacy migration response', 1, 2);
  `);
  legacy.close();

  const migrated = new StateStore(path);
  try {
    assert.equal(migrated.get("legacy").codexThreadId, "thr_write");
    assert.equal(migrated.get("legacy").readOnlyCodexThreadId, null);
    assert.equal(migrated.get("legacy").modelOverride, "");
    assert.equal(migrated.get("legacy").effortOverride, "");
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
    assert.equal(migrated.projectRun("demo", "app", 4)?.requestText, "legacy migration request");
    assert.deepEqual(
      migrated.searchProjectRuns("demo", "app", "migration").map((run) => run.id),
      [4],
    );
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
    primaryOwnerId: 42,
    ownerIds: [42, 77],
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
        primaryOwnerId: 42,
        ownerIds: [42, 77],
        defaultWorkspaceId: "repo",
        workspaces: [{ id: "repo", path: join(root, "repositories", "client", "repo") }],
        createdAt: 123,
      },
    ]);
    reopened.replaceManagedProjectOwners("client", 77, [42, 77, 99]);
    assert.deepEqual(reopened.listManagedProjects()[0]?.ownerIds, [77, 42, 99]);
    assert.equal(reopened.listManagedProjects()[0]?.primaryOwnerId, 77);
    assert.throws(
      () => reopened.replaceManagedProjectOwners("client", 77, []),
      /must include one valid primary owner/,
    );
    assert.throws(() =>
      reopened.createManagedProject({
        id: "client",
        name: "duplicate",
        primaryOwnerId: 99,
        ownerIds: [99],
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

test("legacy managed project owners migrate to the primary-owner membership", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-project-owner-migration-"));
  const path = join(root, "state.sqlite3");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE managed_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      default_workspace_id TEXT NOT NULL,
      created_at REAL NOT NULL
    );
    CREATE TABLE managed_workspaces (
      project_id TEXT NOT NULL REFERENCES managed_projects(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at REAL NOT NULL,
      PRIMARY KEY(project_id, id)
    );
    INSERT INTO managed_projects VALUES ('legacy', 'Legacy', 42, 'repo', 123);
    INSERT INTO managed_workspaces VALUES ('legacy', 'repo', '${root}/repo', 123);
  `);
  legacy.close();

  const migrated = new StateStore(path);
  try {
    const [project] = migrated.listManagedProjects();
    assert.equal(project?.primaryOwnerId, 42);
    assert.deepEqual(project?.ownerIds, [42]);
  } finally {
    migrated.close();
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

test("a user can briefly mark an observed Telegram topic as a report destination", () => {
  const { root, store } = tempStore();
  try {
    store.recordTelegramChat({
      chatId: -100500,
      type: "supergroup",
      title: "Customer",
      isForum: true,
      observedAt: 1_000,
    });
    store.recordTelegramTopic(-100500, 67800, "Reports", 1_000);
    const marked = store.markTelegramReportDestination(42, -100500, 67800, 1_100);
    assert.equal(marked.name, "Reports");
    assert.equal(store.telegramReportDestinationMark(42, 900, 1_999)?.topicId, 67800);
    assert.equal(store.telegramReportDestinationMark(42, 900, 2_001), null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("main topic migration preserves existing sessions and persists selection across restart", () => {
  const { root, path, store } = tempStore();
  const first = store.bind(-100, 1, "demo", "repo");
  store.close();
  const db = new DatabaseSync(path);
  db.exec("DROP INDEX conversations_one_primary; ALTER TABLE conversations DROP COLUMN is_primary;");
  db.prepare("UPDATE conversations SET codex_thread_id = ? WHERE id = ?").run("existing-thread", first.id);
  db.close();
  let reopened = new StateStore(path);
  try {
    assert.equal(reopened.primaryConversation("demo", "repo")?.id, first.id);
    assert.equal(reopened.get(first.id).codexThreadId, "existing-thread");
    const second = reopened.bind(-100, 2, "demo", "repo");
    reopened.bind(-100, 1, "other", "repo");
    assert.equal(reopened.primaryConversation("demo", "repo")?.id, second.id);
    reopened.close();
    reopened = new StateStore(path);
    assert.equal(reopened.primaryConversation("demo", "repo")?.id, second.id);
    assert.equal(reopened.primaryConversation("other", "repo")?.id, first.id);
  } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});
