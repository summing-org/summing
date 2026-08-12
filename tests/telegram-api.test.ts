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
