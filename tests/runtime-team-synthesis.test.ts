import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";

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
  runtime.codex.account = async () => ({ account: { type: "chatgpt" } });
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
    assert.equal(runtime.state.teamSpace(first.spaceId)?.phase, "active");
    assert.equal(runtime.state.teamSpace(first.spaceId)?.orientedAt !== null, true);
    assert.equal(runtime.state.teamSpace(first.spaceId)?.modelEgressAnnouncedAt !== null, true);
    assert.match(sent[0]?.text ?? "", /Администратор включил фоновое осмысление/);
    assert.deepEqual(sent[1]?.options, { topicId: 9, parseMode: "HTML" });
    assert.match(sent[1]?.text ?? "", /Что мне важно уточнить/);

    const third = runtime.state.recordTeamEvent({
      provider: "telegram",
      externalSpaceId: "-100500",
      externalThreadId: "9",
      spaceName: "Engineering",
      sourceTitle: "Release",
      externalEventId: "103",
      eventKind: "message",
      senderExternalId: "88",
      senderDisplayName: "Олег",
      text: "Кто-нибудь проверил rollback?",
      replyToExternalEventId: "102",
      occurredAt: 1_700_000_020,
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
        valid_from: 1_700_000_020,
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
    assert.deepEqual(sent[2]?.options, { topicId: 9, replyTo: 103, parseMode: "HTML" });
    assert.deepEqual(threadModels, ["gpt-5.6-luna", "gpt-5.6-luna"]);
    assert.equal(threadOptions.every((item) => item.readOnly === true), true);
    assert.equal(threadOptions.every((item) => item.networkAccess === false), true);
    assert.equal(threadOptions.every((item) => item.ephemeral === true), true);
    assert.equal(turnOptions.every((item) => item.readOnly === true), true);
    assert.equal(turnOptions.every((item) => item.networkAccess === false), true);
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
    assert.match(prompts[1] ?? "", /"reply_to_external_event_id": "102"/);
    assert.match(prompts[1] ?? "", /"reply_target": \{/);
    assert.match(prompts[1] ?? "", /Миграция пока блокирует релиз/);
    assert.deepEqual(unsubscribed, ["thr-team-1", "thr-team-2"]);
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
