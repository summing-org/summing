import assert from "node:assert/strict";
import test from "node:test";
import { splitMessage, TelegramAPI } from "../src/telegram-api.js";

test("splitMessage preserves content", () => {
  const text = "alpha ".repeat(1_000);
  const chunks = splitMessage(text, 200);
  assert.ok(chunks.every((chunk) => chunk.length <= 200));
  assert.equal(chunks.join(" ").replaceAll(/\s+/g, " ").trim(), text.replaceAll(/\s+/g, " ").trim());
});

test("short message stays single", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
});

test("sendMessage forwards parse mode and Mini App markup", async () => {
  const api = new TelegramAPI("token");
  let payload: Record<string, unknown> = {};
  api.call = async (method, input) => {
    assert.equal(method, "sendMessage");
    payload = input;
    return { message_id: 17 };
  };

  try {
    assert.equal(
      await api.sendMessage(42, "*Помощь*", {
        parseMode: "MarkdownV2",
        replyMarkup: { inline_keyboard: [[{ text: "Open", web_app: { url: "https://example.test" } }]] },
      }),
      17,
    );
    assert.equal(payload.parse_mode, "MarkdownV2");
    assert.deepEqual(payload.reply_markup, {
      inline_keyboard: [[{ text: "Open", web_app: { url: "https://example.test" } }]],
    });
  } finally {
    await api.close();
  }
});

test("sendMessage supports HTML mentions in a Telegram topic", async () => {
  const api = new TelegramAPI("token");
  let payload: Record<string, unknown> = {};
  api.call = async (method, input) => {
    assert.equal(method, "sendMessage");
    payload = input;
    return { message_id: 18 };
  };

  try {
    await api.sendMessage(-10042, '<a href="tg://user?id=42">Мария</a>', {
      topicId: 17,
      parseMode: "HTML",
    });
    assert.equal(payload.parse_mode, "HTML");
    assert.equal(payload.message_thread_id, 17);
  } finally {
    await api.close();
  }
});

test("editMessage forwards Telegram HTML parse mode", async () => {
  const api = new TelegramAPI("token");
  let payload: Record<string, unknown> = {};
  api.call = async (method, input) => {
    assert.equal(method, "editMessageText");
    payload = input;
    return true;
  };

  try {
    await api.editMessage(42, 18, "<b>Готово</b>", { parseMode: "HTML" });
    assert.deepEqual(payload, {
      chat_id: 42,
      message_id: 18,
      text: "<b>Готово</b>",
      disable_web_page_preview: true,
      parse_mode: "HTML",
    });
  } finally {
    await api.close();
  }
});

test("sendChatAction targets the active Telegram topic", async () => {
  const api = new TelegramAPI("token");
  let payload: Record<string, unknown> = {};
  api.call = async (method, input) => {
    assert.equal(method, "sendChatAction");
    payload = input;
    return true;
  };
  try {
    await api.sendChatAction(-10042, "typing", 17);
    assert.deepEqual(payload, {
      chat_id: -10042,
      action: "typing",
      message_thread_id: 17,
    });
  } finally {
    await api.close();
  }
});

test("getUpdates subscribes to the complete Team Space event surface", async () => {
  const api = new TelegramAPI("token");
  let payload: Record<string, unknown> = {};
  api.call = async (method, input) => {
    assert.equal(method, "getUpdates");
    payload = input;
    return [];
  };

  try {
    assert.deepEqual(await api.getUpdates(25), []);
    assert.deepEqual(payload.allowed_updates, [
      "message",
      "edited_message",
      "channel_post",
      "edited_channel_post",
      "message_reaction",
      "message_reaction_count",
      "my_chat_member",
      "chat_member",
    ]);
    assert.equal(payload.offset, 25);
  } finally {
    await api.close();
  }
});

test("setMyShortDescription updates the bot profile within Telegram limits", async () => {
  const api = new TelegramAPI("token");
  let payload: Record<string, unknown> = {};
  api.call = async (method, input) => {
    assert.equal(method, "setMyShortDescription");
    payload = input;
    return true;
  };

  try {
    await api.setMyShortDescription("x".repeat(140));
    assert.equal(String(payload.short_description).length, 120);
  } finally {
    await api.close();
  }
});

test("setChatMenuButton installs the administrator Mini App entry point", async () => {
  const api = new TelegramAPI("token");
  let payload: Record<string, unknown> = {};
  api.call = async (method, input) => {
    assert.equal(method, "setChatMenuButton");
    payload = input;
    return true;
  };

  try {
    await api.setChatMenuButton(42, "https://summing.example/admin");
    assert.deepEqual(payload, {
      chat_id: 42,
      menu_button: {
        type: "web_app",
        text: "Управление",
        web_app: { url: "https://summing.example/admin" },
      },
    });
  } finally {
    await api.close();
  }
});

test("deleteMessage removes intercepted incoming credentials", async () => {
  const api = new TelegramAPI("token");
  let payload: Record<string, unknown> = {};
  api.call = async (method, input) => {
    assert.equal(method, "deleteMessage");
    payload = input;
    return true;
  };
  try {
    await api.deleteMessage(42, 17);
    assert.deepEqual(payload, { chat_id: 42, message_id: 17 });
    await assert.rejects(api.deleteMessage(42, 0), /positive message id/);
  } finally {
    await api.close();
  }
});

test("downloadFile resolves Telegram file path and enforces byte limit", async () => {
  const api = new TelegramAPI("secret-token");
  api.call = async (method, input) => {
    assert.equal(method, "getFile");
    assert.equal(input.file_id, "file-1");
    return { file_path: "voice/audio note.ogg", file_size: 4 };
  };
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-length": "4" },
    });
  };
  try {
    const downloaded = await api.downloadFile("file-1", 10);
    assert.deepEqual([...downloaded.data], [1, 2, 3, 4]);
    assert.equal(downloaded.fileSize, 4);
    assert.equal(downloaded.filePath, "voice/audio note.ogg");
    assert.equal(
      requestedUrl,
      "https://api.telegram.org/file/botsecret-token/voice/audio%20note.ogg",
    );
    api.call = async () => ({ file_path: "large.bin", file_size: 11 });
    await assert.rejects(api.downloadFile("large", 10), /download limit/);
  } finally {
    globalThis.fetch = originalFetch;
    await api.close();
  }
});
