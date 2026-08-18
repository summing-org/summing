import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAgentMessageDelta,
  codexWorkLogText,
  formatWorkLogDuration,
  TelegramStream,
} from "../src/runtime.js";
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
  const stream = new TelegramStream(api, -10042, 17, 0, 1_000, {
    firstMessageDelayMilliseconds: 0,
    firstMessageMaxWaitMilliseconds: 0,
    minimumEditIntervalMilliseconds: 0,
  });
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

test("the first stream message waits for a useful fragment but final flush stays immediate", async () => {
  const api = new TelegramAPI("token");
  const sent: string[] = [];
  api.sendChatAction = async () => undefined;
  api.sendMessage = async (_chatId, text) => {
    sent.push(text);
    return 101;
  };
  const stream = new TelegramStream(api, -10042, 17, 0, 1_000, {
    firstMessageDelayMilliseconds: 20,
    firstMessageMaxWaitMilliseconds: 50,
    firstMessageMinCharacters: 24,
    minimumEditIntervalMilliseconds: 40,
  });
  try {
    stream.append("Первое слово ");
    await wait(10);
    assert.deepEqual(sent, []);
    await wait(20);
    assert.deepEqual(sent, ["Первое слово"]);

    const shortApi = new TelegramAPI("token");
    const shortSent: string[] = [];
    shortApi.sendChatAction = async () => undefined;
    shortApi.sendMessage = async (_chatId, text) => {
      shortSent.push(text);
      return 102;
    };
    const shortStream = new TelegramStream(shortApi, -10042, 17, 0, 1_000, {
      firstMessageDelayMilliseconds: 20,
      firstMessageMaxWaitMilliseconds: 50,
      firstMessageMinCharacters: 24,
    });
    try {
      shortStream.append("Да");
      await wait(30);
      assert.deepEqual(shortSent, []);
      await wait(30);
      assert.deepEqual(shortSent, ["Да"]);
    } finally {
      shortStream.stopTyping();
      await shortApi.close();
    }

    const finalApi = new TelegramAPI("token");
    const finalSent: string[] = [];
    finalApi.sendChatAction = async () => undefined;
    finalApi.sendMessage = async (_chatId, text) => {
      finalSent.push(text);
      return 103;
    };
    const finalStream = new TelegramStream(finalApi, -10042, 17, 0, 1_000, {
      firstMessageDelayMilliseconds: 1_000,
      firstMessageMaxWaitMilliseconds: 2_000,
    });
    try {
      finalStream.append("Ок");
      await finalStream.flush();
      assert.deepEqual(finalSent, ["Ок"]);
    } finally {
      finalStream.stopTyping();
      await finalApi.close();
    }
  } finally {
    stream.stopTyping();
    await api.close();
  }
});

test("stream edits respect the configured five-second production floor", async () => {
  const api = new TelegramAPI("token");
  const sent: string[] = [];
  const edited: string[] = [];
  api.sendChatAction = async () => undefined;
  api.sendMessage = async (_chatId, text) => {
    sent.push(text);
    return 101;
  };
  api.editMessage = async (_chatId, _messageId, text) => {
    edited.push(text);
  };
  const stream = new TelegramStream(api, -10042, 17, 0, 1_000, {
    firstMessageDelayMilliseconds: 0,
    firstMessageMaxWaitMilliseconds: 0,
    minimumEditIntervalMilliseconds: 40,
  });
  try {
    stream.append("Первый фрагмент");
    await wait(10);
    assert.deepEqual(sent, ["Первый фрагмент"]);

    stream.append(" продолжается");
    await wait(20);
    assert.deepEqual(edited, []);
    await wait(30);
    assert.deepEqual(edited, ["Первый фрагмент продолжается"]);
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

test("a completed stream keeps the transcript before and work log after the final answer", async () => {
  const api = new TelegramAPI("token");
  const messages: string[] = [];
  api.sendChatAction = async () => undefined;
  api.sendMessage = async (_chatId, text) => {
    messages.push(text);
    return 101;
  };
  const stream = new TelegramStream(api, -10042, 17, 0, 1_000);
  try {
    stream.start(9);
    stream.showAudioTranscript({ fileName: "voice.ogg", text: "Текст аудио" });
    stream.showWorkLog("Проверил код\n\nЗапустил тесты");
    stream.append("**Готово**");
    await stream.flush();

    assert.match(
      messages.at(-1) ?? "",
      /^<blockquote expandable><b>🎙 Транскрипция «voice\.ogg»<\/b>\n/,
    );
    assert.match(messages.at(-1) ?? "", /Проверил код\n\nЗапустил тесты/);
    assert.match(messages.at(-1) ?? "", /Текст аудио\n<\/blockquote>\n\n<b>Готово<\/b>/);
    assert.match(messages.at(-1) ?? "", /<blockquote expandable><b>Ход работы · 1 сек<\/b>\n/);
    assert.match(messages.at(-1) ?? "", /Запустил тесты\n<\/blockquote>$/);
  } finally {
    stream.stopTyping();
    await api.close();
  }
});

test("a final edit removes obsolete messages left by a longer stream", async () => {
  const api = new TelegramAPI("token");
  const sentIds: number[] = [];
  const deletedIds: number[] = [];
  api.sendChatAction = async () => undefined;
  api.sendMessage = async () => {
    const messageId = 100 + sentIds.length;
    sentIds.push(messageId);
    return messageId;
  };
  api.editMessage = async () => undefined;
  api.deleteMessage = async (_chatId, messageId) => {
    deletedIds.push(messageId);
  };
  const stream = new TelegramStream(api, -10042, 17, 0, 1_000);
  try {
    stream.start(9);
    stream.text = "длинный поток ".repeat(1_000);
    await stream.flush();
    assert.ok(sentIds.length > 1);

    stream.text = "Короткий финал";
    await stream.flush();
    assert.deepEqual(deletedIds, sentIds.slice(1).reverse());
    assert.deepEqual(stream.messageIds, [sentIds[0]!]);
  } finally {
    stream.stopTyping();
    await api.close();
  }
});

test("work log duration and retention stay bounded", () => {
  assert.equal(formatWorkLogDuration(0), "1 сек");
  assert.equal(formatWorkLogDuration(125_000), "2 мин 5 сек");
  assert.equal(formatWorkLogDuration(3_723_000), "1 ч 2 мин 3 сек");

  const bounded = codexWorkLogText([
    { text: "старое ".repeat(100) },
    { text: "последнее обновление" },
  ], 128);
  assert.ok(Array.from(bounded).length <= 128);
  assert.match(bounded, /^… более ранние обновления скрыты/);
  assert.match(bounded, /последнее обновление$/);
});

test("separate agent message items get a boundary without splitting streamed words", () => {
  assert.equal(appendAgentMessageDelta("Готов", "item-1", "item-1", "о."), "о.");
  assert.equal(appendAgentMessageDelta("Готово.", "item-1", "item-2", "Дальше"), " Дальше");
  assert.equal(appendAgentMessageDelta("Готово.", "item-1", "item-2", "\nДальше"), "\nДальше");
});
