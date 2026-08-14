import assert from "node:assert/strict";
import test from "node:test";
import { telegramEventAttachments, telegramTeamEventInput } from "../src/team-memory.js";

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
