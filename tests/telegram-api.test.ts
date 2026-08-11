import assert from "node:assert/strict";
import test from "node:test";
import { splitMessage } from "../src/telegram-api.js";

test("splitMessage preserves content", () => {
  const text = "alpha ".repeat(1_000);
  const chunks = splitMessage(text, 200);
  assert.ok(chunks.every((chunk) => chunk.length <= 200));
  assert.equal(chunks.join(" ").replaceAll(/\s+/g, " ").trim(), text.replaceAll(/\s+/g, " ").trim());
});

test("short message stays single", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
});
