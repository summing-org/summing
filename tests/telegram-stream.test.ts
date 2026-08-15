import assert from "node:assert/strict";
import test from "node:test";
import { appendAgentMessageDelta, TelegramStream } from "../src/runtime.js";
import { TelegramAPI } from "../src/telegram-api.js";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("direct stream stays silent and keeps the native typing action alive", async () => {
  const api = new TelegramAPI("token");
  const messages: string[] = [];
  const messageOptions: Array<{
    topicId?: number;
    replyTo?: number;
    parseMode?: "HTML" | "MarkdownV2";
  }> = [];
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

    stream.append("**Готовый ответ**");
    await stream.flush();
    const stoppedAt = actions.length;
    await wait(18);
    assert.equal(actions.length, stoppedAt);
    assert.equal(messages.at(-1), "<b>Готовый ответ</b>");
    assert.deepEqual(messageOptions[0], { topicId: 17, replyTo: 9, parseMode: "HTML" });
  } finally {
    stream.stopTyping();
    await api.close();
  }
});

test("streaming updates and the final edit both use Telegram HTML", async () => {
  const api = new TelegramAPI("token");
  const sent: Array<{ text: string; parseMode: string | undefined }> = [];
  const edited: Array<{ text: string; parseMode: string | undefined }> = [];
  api.sendChatAction = async () => undefined;
  api.sendMessage = async (_chatId, text, options) => {
    sent.push({ text, parseMode: options?.parseMode });
    return 101;
  };
  api.editMessage = async (_chatId, _messageId, text, options) => {
    edited.push({ text, parseMode: options?.parseMode });
  };
  const stream = new TelegramStream(api, -10042, 17, 0, 1_000);
  try {
    stream.start(9);
    stream.append("**Готов");
    await wait(5);
    stream.append("о**");
    await stream.flush();

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.parseMode, "HTML");
    assert.deepEqual(edited.at(-1), {
      text: "<b>Готово</b>",
      parseMode: "HTML",
    });
  } finally {
    stream.stopTyping();
    await api.close();
  }
});

test("a stream keeps an expandable audio transcript before every edit", async () => {
  const api = new TelegramAPI("token");
  const messages: string[] = [];
  api.sendChatAction = async () => undefined;
  api.sendMessage = async (_chatId, text) => {
    messages.push(text);
    return 101;
  };
  api.editMessage = async (_chatId, _messageId, text) => {
    messages.push(text);
  };
  const stream = new TelegramStream(api, -10042, 17, 0, 1_000);
  try {
    stream.showAudioTranscript({ fileName: "voice.ogg", text: "Что было услышано" });
    stream.append("Ответ");
    await stream.flush();
    assert.equal(
      messages.at(-1),
      "<blockquote expandable><b>🎙 Транскрипция «voice.ogg»</b>\n" +
        "Что было услышано\n</blockquote>\n\nОтвет",
    );
  } finally {
    stream.stopTyping();
    await api.close();
  }
});

test("separate agent message items get a boundary without splitting streamed words", () => {
  assert.equal(appendAgentMessageDelta("Готов", "item-1", "item-1", "о."), "о.");
  assert.equal(appendAgentMessageDelta("Готово.", "item-1", "item-2", "Дальше"), " Дальше");
  assert.equal(appendAgentMessageDelta("Готово.", "item-1", "item-2", "\nДальше"), "\nДальше");
});
