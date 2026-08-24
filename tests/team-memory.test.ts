import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTeamUnderstandingResponse,
  TEAM_UNDERSTANDING_OUTPUT_SCHEMA,
  telegramEventAttachments,
  telegramExplicitReply,
  telegramTeamEventInput,
} from "../src/team-memory.js";
import type { TeamEvent } from "../src/state-store.js";

test("normalizes Telegram messages into provider-neutral Team Space evidence", () => {
  const message = {
    message_id: 55,
    message_thread_id: 7,
    date: 1_700_000_000,
    text: "Решили выпускаться в пятницу",
    from: { id: 42, first_name: "Маша", username: "masha" },
    chat: { id: -100500, type: "supergroup", title: "Engineering" },
    reply_to_message: { message_id: 54 },
    document: {
      file_id: "telegram-file",
      file_name: "plan.txt",
      mime_type: "text/plain",
      file_size: 123,
    },
  };
  assert.deepEqual(telegramEventAttachments(message), [{
    kind: "document",
    fileName: "plan.txt",
    mimeType: "text/plain",
    size: 123,
    providerFileId: "telegram-file",
  }]);
  assert.deepEqual(telegramTeamEventInput(message, 1), {
    provider: "telegram",
    externalSpaceId: "-100500",
    externalThreadId: "7",
    spaceName: "Engineering",
    sourceTitle: "topic 7",
    externalEventId: "55",
    eventKind: "message",
    senderExternalId: "42",
    senderDisplayName: "Маша",
    text: "Решили выпускаться в пятницу",
    replyToExternalEventId: "54",
    attachments: [{
      kind: "document",
      fileName: "plan.txt",
      mimeType: "text/plain",
      size: 123,
      providerFileId: "telegram-file",
    }],
    occurredAt: 1_700_000_000,
    administratorUserId: 1,
  });
  const implicitTopicReply = {
    ...message,
    message_id: 56,
    reply_to_message: { message_id: 7, text: "корень forum topic" },
  };
  assert.equal(telegramExplicitReply(implicitTopicReply), null);
  assert.equal(
    telegramTeamEventInput(implicitTopicReply, 1)?.replyToExternalEventId,
    "",
  );
});

test("normalizes service events without inventing participant intent", () => {
  const input = telegramTeamEventInput({
    message_id: 56,
    message_thread_id: 8,
    date: 1_700_000_100,
    from: { id: 77, first_name: "Иван" },
    chat: { id: -100500, type: "supergroup", title: "Engineering" },
    forum_topic_created: { name: "Release" },
  }, 1);
  assert.equal(input?.eventKind, "service");
  assert.equal(input?.sourceTitle, "Release");
  assert.equal(input?.text, "[Создан топик: Release]");
});

test("validates one episode shared by memory and intervention", () => {
  const event: TeamEvent = {
    id: 7,
    spaceId: "team-1",
    sourceId: "source-1",
    personId: "person-1",
    provider: "telegram",
    externalEventId: "55",
    eventKind: "message",
    senderExternalId: "42",
    senderDisplayName: "Маша",
    text: "Кажется, мы рискуем не успеть к пятнице",
    replyToExternalEventId: "",
    attachments: [],
    occurredAt: 1_700_000_000,
    observedAt: 1_700_000_001,
    directClaimedAt: null,
    synthesisState: "pending",
    redactedAt: null,
  };
  const response = {
    episode: {
      source_id: "source-1",
      subject: "Риск пятничного релиза",
      synopsis: "Маша обозначила риск не успеть к пятнице.",
      confidence: 0.9,
      event_ids: [7],
      participants: [{
        person_id: "person-1",
        role: "speaker",
        intent: "Обозначить риск срока",
        confidence: 0.75,
        evidence_event_ids: [7],
      }],
    },
    summary: "Команда обсуждает риск пятничного срока.",
    knowledge: [{
      kind: "risk",
      subject: "релиз",
      statement: "Срок пятницы находится под риском.",
      confidence: 0.75,
      status: "active",
      visibility: "source",
      visibility_ref: "source-1",
      evidence_event_ids: [7],
      supersedes_knowledge_ids: [],
      valid_from: 1_700_000_000,
      valid_to: null,
    }],
    orientation_ready: true,
    orientation_message: "Я начал понимать контекст релиза.",
    clarification_questions: ["Какой критерий определяет готовность?"],
    intervention: {
      action: "reply",
      reply_to_event_id: 7,
      message: "Какой риск сейчас сильнее всего влияет на срок?",
      reason: "Нужно уточнить блокирующий риск.",
    },
  };
  const parsed = parseTeamUnderstandingResponse(JSON.stringify(response), [event]);
  assert.equal(parsed?.episode.participants[0]?.role, "speaker");
  assert.equal(parsed?.knowledge[0]?.kind, "episode");
  assert.equal(parsed?.knowledge[1]?.visibilityRef, "source-1");
  assert.equal(parsed?.intervention.replyToEventId, 7);
  assert.equal(TEAM_UNDERSTANDING_OUTPUT_SCHEMA.additionalProperties, false);
  assert.equal(JSON.stringify(TEAM_UNDERSTANDING_OUTPUT_SCHEMA).includes("uniqueItems"), false);

  assert.equal(
    parseTeamUnderstandingResponse(JSON.stringify({
      ...response,
      knowledge: [{ ...response.knowledge[0], visibility_ref: "source-other" }],
    }), [event]),
    null,
  );
  assert.equal(
    parseTeamUnderstandingResponse(JSON.stringify({
      ...response,
      intervention: { ...response.intervention, reply_to_event_id: 999 },
    }), [event]),
    null,
  );
  assert.equal(
    parseTeamUnderstandingResponse(JSON.stringify({
      ...response,
      orientation_message: "",
    }), [event]),
    null,
  );
  assert.equal(
    parseTeamUnderstandingResponse(JSON.stringify({
      ...response,
      episode: { ...response.episode, event_ids: [] },
    }), [event]),
    null,
  );
});
