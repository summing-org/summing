import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";

test("administrator model-egress and proactive-reply overrides survive a runtime restart", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-team-egress-toggle-"));
  const config = new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "token",
    1,
    "codex",
    8_765,
    1,
    1,
    "",
    "medium",
    false,
    new Map(),
  );
  Object.assign(config, {
    teamModelEgressEnabled: true,
    teamProactiveRepliesEnabled: true,
  });
  const first = new SummingRuntime(config);
  try {
    assert.equal(
      (first.status().team_memory as Record<string, unknown>).model_egress_enabled,
      true,
    );
    assert.equal(
      (first.status().team_memory as Record<string, unknown>).proactive_replies_enabled,
      true,
    );
    (first as unknown as { setTeamModelEgressEnabled(enabled: boolean): void })
      .setTeamModelEgressEnabled(false);
    assert.equal(
      (first.status().team_memory as Record<string, unknown>).model_egress_enabled,
      false,
    );
    (first as unknown as { setTeamProactiveRepliesEnabled(enabled: boolean): void })
      .setTeamProactiveRepliesEnabled(false);
    assert.equal(
      (first.status().team_memory as Record<string, unknown>).proactive_replies_enabled,
      false,
    );
  } finally {
    first.state.close();
  }
  const reopened = new SummingRuntime(config);
  try {
    assert.equal(
      (reopened.status().team_memory as Record<string, unknown>).model_egress_enabled,
      false,
    );
    assert.equal(
      (reopened.status().team_memory as Record<string, unknown>).proactive_replies_enabled,
      false,
    );
  } finally {
    reopened.state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one background understanding loop creates an episode, memory, and optional intervention", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-team-synthesis-"));
  const config = new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "token",
    1,
    "codex",
    8_765,
    1,
    1,
    "",
    "medium",
    false,
    new Map(),
  );
  Object.assign(config, {
    teamModelEgressEnabled: true,
    teamProactiveRepliesEnabled: false,
    teamUnderstandingModel: "gpt-5.6-luna",
    teamUnderstandingEffort: "low",
    teamUnderstandingMaxEvents: 20,
    teamOrientationEventThreshold: 2,
    teamInterventionCooldownSeconds: 0,
  });
  const runtime = new SummingRuntime(config);
  const sent: Array<{
    chatId: number;
    text: string;
    options: {
      topicId?: number;
      replyTo?: number;
      parseMode?: "HTML" | "MarkdownV2";
    } | undefined;
  }> = [];
  const threadOptions: Array<Record<string, unknown>> = [];
  const threadModels: Array<string | undefined> = [];
  const turnOptions: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const unsubscribed: string[] = [];
  let response = "";
  let sequence = 0;
  runtime.telegram.sendMessage = async (chatId, text, options) => {
    sent.push({ chatId, text, options });
    return 900 + sent.length;
  };
  runtime.telegram.setMyShortDescription = async () => {};
  runtime.codex.account = async () => ({ account: { type: "chatgpt" } });
  let rateLimitRead = 0;
  runtime.codex.rateLimits = async () => {
    const usedPercent = [10, 11, 11, 13][rateLimitRead++] ?? 13;
    return {
      rateLimits: {
        secondary: {
          usedPercent,
          windowDurationMins: 10_080,
          resetsAt: 1_800_000_000,
        },
      },
    };
  };
  runtime.codex.usage = async (threadId) => ({
    threadUsage: { threadId, estimatedUsageCreditsMicros: 250_000 },
  });
  runtime.codex.startThread = async (_cwd, model, options) => {
    threadModels.push(model);
    threadOptions.push(options as Record<string, unknown>);
    sequence += 1;
    return `thr-team-${sequence}`;
  };
  Object.defineProperty(runtime.codex, "running", { configurable: true, get: () => true });
  runtime.codex.unsubscribeThread = async (threadId) => {
    unsubscribed.push(threadId);
  };
  const routeCodexEvent = (
    runtime as unknown as {
      routeCodexEvent(event: {
        method: string;
        params: Record<string, unknown>;
      }): Promise<void>;
    }
  ).routeCodexEvent.bind(runtime);
  runtime.codex.startTurn = async (threadId, prompt, _cwd, options) => {
    prompts.push(prompt);
    turnOptions.push(options as Record<string, unknown>);
    const turnId = `turn-team-${sequence}`;
    setImmediate(() => {
      void (async () => {
        await routeCodexEvent({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: { type: "agentMessage", phase: "final_answer", text: response },
          },
        });
        await routeCodexEvent({
          method: "turn/completed",
          params: {
            threadId,
            turnId,
            turn: { id: turnId, status: "completed" },
          },
        });
      })();
    });
    return turnId;
  };
  const understandTeamConversation = (
    runtime as unknown as { understandTeamConversation(sourceId: string): Promise<void> }
  ).understandTeamConversation.bind(runtime);

  try {
    const first = runtime.state.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "9",
      spaceName: "Engineering",
      sourceTitle: "Release",
      externalEventId: "101",
      eventKind: "message",
      senderExternalId: "42",
      senderDisplayName: "Маша",
      text: "Релиз хотим сделать в пятницу.",
      occurredAt: 1_700_000_000,
      administratorUserId: 1,
    })!;
    const second = runtime.state.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "9",
      spaceName: "Engineering",
      sourceTitle: "Release",
      externalEventId: "102",
      eventKind: "message",
      senderExternalId: "77",
      senderDisplayName: "Иван",
      text: "Миграция пока блокирует релиз.",
      occurredAt: 1_700_000_010,
      administratorUserId: 1,
    })!;
    const otherSource = runtime.state.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "10",
      spaceName: "Engineering",
      sourceTitle: "Random",
      externalEventId: "201",
      eventKind: "message",
      senderExternalId: "99",
      senderDisplayName: "Лена",
      text: "Сообщение из другого топика не относится к этому эпизоду.",
      occurredAt: 1_700_000_005,
      administratorUserId: 1,
    })!;
    response = JSON.stringify({
      episode: {
        source_id: first.sourceId,
        subject: "Пятничный релиз",
        synopsis: "Маша назвала пятницу, Иван обозначил миграцию как blocker.",
        confidence: 0.95,
        event_ids: [first.id, second.id],
        participants: [{
          person_id: first.personId,
          role: "speaker",
          intent: "Зафиксировать желаемую дату релиза",
          confidence: 0.8,
          evidence_event_ids: [first.id],
        }, {
          person_id: second.personId,
          role: "speaker",
          intent: "Обозначить blocker",
          confidence: 0.9,
          evidence_event_ids: [second.id],
        }],
      },
      summary: "Команда готовит пятничный релиз, заблокированный миграцией.",
      knowledge: [{
        kind: "risk",
        subject: "релиз",
        statement: "Незавершённая миграция блокирует пятничный релиз.",
        confidence: 0.98,
        status: "active",
        visibility: "space",
        visibility_ref: "",
        evidence_event_ids: [first.id, second.id],
        supersedes_knowledge_ids: [],
        valid_from: 1_700_000_010,
        valid_to: null,
      }],
      orientation_ready: true,
      orientation_message: "Я понял, что сейчас центр обсуждения — пятничный релиз и миграция.",
      clarification_questions: ["Кто принимает финальное решение о готовности миграции?"],
      intervention: {
        action: "silent",
        reply_to_event_id: null,
        message: "",
        reason: "Сначала нужен warm-up; отдельная реплика сейчас не поможет.",
      },
    });
    await understandTeamConversation(first.sourceId);

    assert.equal(runtime.state.pendingTeamEventCountForSource(first.sourceId), 0);
    assert.equal(runtime.state.pendingTeamEventCountForSource(otherSource.sourceId), 1);
    assert.equal(runtime.state.teamKnowledge(first.spaceId).some((item) => item.kind === "episode"), true);
    assert.equal(runtime.state.teamKnowledge(first.spaceId).some((item) => item.kind === "risk"), true);
    assert.equal(runtime.state.teamSpace(first.spaceId)?.phase, "orienting");
    assert.equal(runtime.state.teamSpace(first.spaceId)?.orientedAt, null);
    assert.equal(runtime.state.teamSpace(first.spaceId)?.modelEgressAnnouncedAt !== null, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", /Администратор включил фоновое осмысление/);
    assert.doesNotMatch(sent[0]?.text ?? "", /Что мне важно уточнить/);
    assert.equal(
      (runtime.status().team_memory as Record<string, unknown>).proactive_replies_enabled,
      false,
    );

    (runtime as unknown as { setTeamProactiveRepliesEnabled(enabled: boolean): void })
      .setTeamProactiveRepliesEnabled(true);

    runtime.state.bind(-100500, 9, "summing", "repo");
    const bindingEvent = runtime.state.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "9",
      spaceName: "Engineering",
      sourceTitle: "Release",
      externalEventId: "103",
      eventKind: "message",
      senderExternalId: "42",
      senderDisplayName: "Маша",
      text: "Топик теперь связан с проектом.",
      occurredAt: 1_700_000_020,
      administratorUserId: 1,
    })!;
    response = JSON.stringify({
      episode: {
        source_id: bindingEvent.sourceId,
        subject: "Привязка топика",
        synopsis: "Маша сообщила, что топик связан с проектом.",
        confidence: 0.98,
        event_ids: [bindingEvent.id],
        participants: [{
          person_id: bindingEvent.personId,
          role: "speaker",
          intent: "Сообщить о привязке",
          confidence: 0.95,
          evidence_event_ids: [bindingEvent.id],
        }],
      },
      summary: "Топик связан с проектом; команда готовит релиз.",
      knowledge: [],
      orientation_ready: true,
      orientation_message: "Я понял, что сейчас центр обсуждения — пятничный релиз и миграция.",
      clarification_questions: ["Кто принимает финальное решение о готовности миграции?"],
      intervention: {
        action: "silent",
        reply_to_event_id: null,
        message: "",
        reason: "Сначала нужна ориентация в уже привязанном топике.",
      },
    });
    await understandTeamConversation(first.sourceId);

    assert.equal(runtime.state.teamSpace(first.spaceId)?.phase, "active");
    assert.equal(runtime.state.teamSpace(first.spaceId)?.orientedAt !== null, true);
    assert.deepEqual(sent[1]?.options, { topicId: 9, parseMode: "HTML" });
    assert.match(sent[1]?.text ?? "", /Что мне важно уточнить/);

    const third = runtime.state.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "9",
      spaceName: "Engineering",
      sourceTitle: "Release",
      externalEventId: "104",
      eventKind: "message",
      senderExternalId: "88",
      senderDisplayName: "Олег",
      text: "Кто-нибудь проверил rollback?",
      replyToExternalEventId: "102",
      occurredAt: 1_700_000_030,
      administratorUserId: 1,
    })!;
    response = JSON.stringify({
      episode: {
        source_id: third.sourceId,
        subject: "Проверка rollback",
        synopsis: "Олег спросил, проверен ли rollback для релиза.",
        confidence: 0.98,
        event_ids: [third.id],
        participants: [{
          person_id: third.personId,
          role: "speaker",
          intent: "Уточнить готовность rollback",
          confidence: 0.9,
          evidence_event_ids: [third.id],
        }, {
          person_id: second.personId,
          role: "addressee",
          intent: "",
          confidence: 1,
          evidence_event_ids: [third.id],
        }],
      },
      summary: "Команда готовит релиз и уточняет проверку rollback.",
      knowledge: [{
        kind: "question",
        subject: "rollback",
        statement: "Проверка rollback пока не подтверждена.",
        confidence: 0.9,
        status: "active",
        visibility: "source",
        visibility_ref: third.sourceId,
        evidence_event_ids: [third.id],
        supersedes_knowledge_ids: [],
        valid_from: 1_700_000_030,
        valid_to: null,
      }],
      orientation_ready: false,
      orientation_message: "",
      clarification_questions: [],
      intervention: {
        action: "reply",
        reply_to_event_id: third.id,
        message: "**Это пока открытый вопрос.** Кто владеет проверкой rollback?",
        reason: "Вопрос о критичной проверке остался без владельца.",
      },
    });
    await understandTeamConversation(first.sourceId);

    assert.equal(
      sent[2]?.text,
      "<b>Это пока открытый вопрос.</b> Кто владеет проверкой rollback?",
    );
    assert.deepEqual(sent[2]?.options, { topicId: 9, replyTo: 104, parseMode: "HTML" });

    const claimed = runtime.state.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "9",
      spaceName: "Engineering",
      sourceTitle: "Release",
      externalEventId: "105",
      eventKind: "message",
      senderExternalId: "42",
      senderDisplayName: "Маша",
      text: "Выкатывай новый релиз",
      occurredAt: 1_700_000_040,
      administratorUserId: 1,
    })!;
    runtime.state.claimTeamEventForDirectResponse(claimed.id, 1_700_000_041);
    response = JSON.stringify({
      episode: {
        source_id: claimed.sourceId,
        subject: "Запуск релиза",
        synopsis: "Маша поручила Project-turn развернуть новый релиз.",
        confidence: 0.98,
        event_ids: [claimed.id],
        participants: [{
          person_id: claimed.personId,
          role: "speaker",
          intent: "Запустить релиз",
          confidence: 0.95,
          evidence_event_ids: [claimed.id],
        }],
      },
      summary: "Команда запускает новый релиз.",
      knowledge: [],
      orientation_ready: false,
      orientation_message: "",
      clarification_questions: [],
      intervention: {
        action: "reply",
        reply_to_event_id: claimed.id,
        message: "Какой релиз и в какое окружение развернуть?",
        reason: "Модель сочла запрос неоднозначным.",
      },
    });
    await understandTeamConversation(claimed.sourceId);

    assert.equal(runtime.state.pendingTeamEventCountForSource(claimed.sourceId), 0);
    assert.equal(sent.length, 3);
    assert.match(prompts[3] ?? "", /"direct_route_claimed": true/);

    response = JSON.stringify({
      episode: {
        source_id: otherSource.sourceId,
        subject: "Непривязанный топик",
        synopsis: "Лена написала сообщение в непривязанном топике.",
        confidence: 0.98,
        event_ids: [otherSource.id],
        participants: [{
          person_id: otherSource.personId,
          role: "speaker",
          intent: "Поделиться сообщением",
          confidence: 0.8,
          evidence_event_ids: [otherSource.id],
        }],
      },
      summary: "Память учитывает сообщения из непривязанного топика без права отвечать там.",
      knowledge: [{
        kind: "fact",
        subject: "Непривязанный топик",
        statement: "Лена оставила сообщение в отдельном непривязанном топике.",
        confidence: 0.95,
        status: "active",
        visibility: "source",
        visibility_ref: otherSource.sourceId,
        evidence_event_ids: [otherSource.id],
        supersedes_knowledge_ids: [],
        valid_from: 1_700_000_005,
        valid_to: null,
      }],
      orientation_ready: false,
      orientation_message: "",
      clarification_questions: [],
      intervention: {
        action: "reply",
        reply_to_event_id: otherSource.id,
        message: "Я сам решил вмешаться в непривязанный топик.",
        reason: "Модель сочла реплику полезной.",
      },
    });
    await understandTeamConversation(otherSource.sourceId);

    assert.equal(runtime.state.pendingTeamEventCountForSource(otherSource.sourceId), 0);
    assert.equal(
      runtime.state.teamKnowledge(first.spaceId)
        .some((item) => item.subject === "Непривязанный топик"),
      true,
    );
    assert.equal(sent.length, 3);
    assert.equal(sent.some((item) => item.text.includes("сам решил вмешаться")), false);
    assert.deepEqual(threadModels, [
      "gpt-5.6-luna",
      "gpt-5.6-luna",
      "gpt-5.6-luna",
      "gpt-5.6-luna",
      "gpt-5.6-luna",
    ]);
    assert.equal(threadOptions.every((item) => item.readOnly === true), true);
    assert.equal(threadOptions.every((item) => item.networkAccess === false), true);
    assert.equal(threadOptions.every((item) => item.ephemeral === true), true);
    assert.equal(threadOptions.every((item) => item.workspaceAccess === false), true);
    assert.equal(threadOptions.every((item) => !Object.hasOwn(item, "readableRoots")), true);
    assert.equal(turnOptions.every((item) => item.readOnly === true), true);
    assert.equal(turnOptions.every((item) => item.networkAccess === false), true);
    assert.equal(turnOptions.every((item) => item.workspaceAccess === false), true);
    assert.equal(turnOptions.every((item) => !Object.hasOwn(item, "readableRoots")), true);
    assert.equal(turnOptions.every((item) => item.model === "gpt-5.6-luna"), true);
    assert.equal(turnOptions.every((item) => item.effort === "low"), true);
    assert.equal(turnOptions.every((item) => typeof item.outputSchema === "object"), true);
    const teamMemoryStatus = runtime.status().team_memory as Record<string, unknown>;
    assert.equal(teamMemoryStatus.model, "gpt-5.6-luna");
    assert.equal(teamMemoryStatus.effort, "low");
    assert.match(prompts[0] ?? "", /single background Conversation Understanding Loop/);
    assert.match(prompts[0] ?? "", /Silence is the default/);
    assert.match(prompts[0] ?? "", /Релиз хотим сделать в пятницу/);
    assert.doesNotMatch(prompts[0] ?? "", /другого топика/);
    assert.match(prompts[2] ?? "", /"reply_to_external_event_id": "102"/);
    assert.match(prompts[2] ?? "", /"reply_target": \{/);
    assert.match(prompts[2] ?? "", /Миграция пока блокирует релиз/);
    assert.deepEqual(unsubscribed, [
      "thr-team-1",
      "thr-team-2",
      "thr-team-3",
      "thr-team-4",
      "thr-team-5",
    ]);
    assert.deepEqual(runtime.state.teamModelEgressUsage(), {
      weeklyResetsAt: 1_800_000_000,
      turns: 5,
      measuredTurns: 5,
      estimatedCreditsMicros: 1_250_000,
      observedWeeklyPercent: 3,
      updatedAt: runtime.state.teamModelEgressUsage()?.updatedAt,
    });
  } finally {
    runtime.state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("understanding scheduler uses trailing quiet, event cap, and a hard deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-understanding-scheduler-"));
  const config = new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "token",
    1,
    "codex",
    8_765,
    1,
    1,
    "",
    "medium",
    false,
    new Map(),
  );
  Object.assign(config, {
    teamModelEgressEnabled: true,
    teamUnderstandingQuietSeconds: 0.04,
    teamUnderstandingMaxWaitSeconds: 0.2,
    teamUnderstandingMaxEvents: 2,
  });
  const runtime = new SummingRuntime(config);
  const calls: string[] = [];
  Object.assign(runtime, {
    understandTeamConversation: async (sourceId: string): Promise<void> => {
      calls.push(sourceId);
      for (const event of runtime.state.pendingTeamEventsForSource(sourceId)) {
        runtime.state.redactTeamEvent(event.id);
      }
    },
  });
  const schedule = (
    runtime as unknown as { scheduleTeamUnderstanding(sourceId: string): void }
  ).scheduleTeamUnderstanding.bind(runtime);
  const recordEvent = (externalEventId: string, text: string) => runtime.state.recordTeamEvent({
    provider: "telegram",
    externalSpaceId: "-100600",
    externalThreadId: "12",
    spaceName: "Engineering",
    sourceTitle: "Deploy",
    externalEventId,
    eventKind: "message",
    senderExternalId: "42",
    senderDisplayName: "Маша",
    text,
    occurredAt: Date.now() / 1_000,
    administratorUserId: 1,
  })!;

  try {
    const first = recordEvent("1", "Первое сообщение");
    schedule(first.sourceId);
    await delay(10);
    const second = recordEvent("2", "Второе сообщение заполняет batch");
    schedule(second.sourceId);
    await delay(20);
    assert.deepEqual(calls, [first.sourceId]);

    Object.assign(config, {
      teamUnderstandingQuietSeconds: 0.08,
      teamUnderstandingMaxWaitSeconds: 0.04,
      teamUnderstandingMaxEvents: 10,
    });
    const third = recordEvent("3", "Начало непрерывного разговора");
    schedule(third.sourceId);
    await delay(25);
    const fourth = recordEvent("4", "Новое сообщение сбрасывает quiet timer");
    schedule(fourth.sourceId);
    await delay(30);
    assert.deepEqual(calls, [first.sourceId, third.sourceId]);
  } finally {
    (
      runtime as unknown as { clearTeamUnderstandingTimers(): void }
    ).clearTeamUnderstandingTimers();
    runtime.state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
