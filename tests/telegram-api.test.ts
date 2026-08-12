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

test("sendMessage forwards the MarkdownV2 parse mode", async () => {
  const api = new TelegramAPI("token");
  let payload: Record<string, unknown> = {};
  api.call = async (method, input) => {
    assert.equal(method, "sendMessage");
    payload = input;
    return { message_id: 17 };
  };

  try {
    assert.equal(
      await api.sendMessage(42, "*Помощь*", { parseMode: "MarkdownV2" }),
      17,
    );
    assert.equal(payload.parse_mode, "MarkdownV2");
  } finally {
    await api.close();
  }
});

test("getUpdates subscribes to messages and bot membership changes", async () => {
  const api = new TelegramAPI("token");
  let payload: Record<string, unknown> = {};
  api.call = async (method, input) => {
    assert.equal(method, "getUpdates");
    payload = input;
    return [];
  };

  try {
    assert.deepEqual(await api.getUpdates(25), []);
    assert.deepEqual(payload.allowed_updates, ["message", "my_chat_member"]);
    assert.equal(payload.offset, 25);
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
