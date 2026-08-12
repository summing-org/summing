import assert from "node:assert/strict";
import test from "node:test";
import { TelegramStream } from "../src/runtime.js";
import { TelegramAPI } from "../src/telegram-api.js";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("direct stream stays silent and keeps the native typing action alive", async () => {
  const api = new TelegramAPI("token");
  const messages: string[] = [];
  const messageOptions: Array<{ topicId?: number; replyTo?: number }> = [];
  const actions: Array<{ chatId: number; topicId: number }> = [];
  api.sendMessage = async (_chatId, text, options) => {
    messages.push(text);
    messageOptions.push(options ?? {});
    return 101;
  };
  api.sendChatAction = async (chatId, action, topicId = 0) => {
    assert.equal(action, "typing");
    actions.push({ chatId, topicId });
  };
  api.editMessage = async (_chatId, _messageId, text) => {
    messages.push(text);
  };
  const stream = new TelegramStream(api, -10042, 17, 0.01, 5);
  try {
    stream.start(9);
    await wait(18);
    assert.deepEqual(messages, []);
    assert.ok(actions.length >= 2);
    assert.deepEqual(actions[0], { chatId: -10042, topicId: 17 });

    stream.append("Готовый ответ");
    await stream.flush();
    const stoppedAt = actions.length;
    await wait(18);
    assert.equal(actions.length, stoppedAt);
    assert.equal(messages.at(-1), "Готовый ответ");
    assert.deepEqual(messageOptions[0], { topicId: 17, replyTo: 9 });
  } finally {
    stream.stopTyping();
    await api.close();
  }
});
