import assert from "node:assert/strict";
import test from "node:test";
import { helpMessage } from "../src/help-message.js";

function assertSafeMarkdownV2(message: string): void {
  const reservedTextCharacters = new Set("_*[]()~`>#+-=|{}.!".split(""));
  let inCode = false;
  let inBold = false;

  for (let index = 0; index < message.length; index += 1) {
    const character = message.charAt(index);
    if (character === "\\") {
      assert.ok(index + 1 < message.length, "MarkdownV2 message ends with an escape");
      index += 1;
      continue;
    }
    if (character === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (character === "*") {
      inBold = !inBold;
      continue;
    }
    assert.ok(
      !reservedTextCharacters.has(character),
      `unescaped MarkdownV2 character ${JSON.stringify(character)} at index ${index}`,
    );
  }

  assert.equal(inCode, false, "MarkdownV2 message has an unterminated code entity");
  assert.equal(inBold, false, "MarkdownV2 message has an unterminated bold entity");
}

test("help describes everyday commands with examples", () => {
  const help = helpMessage(false);

  assert.match(help, /^\*Помощь по SUMMING\*/);
  assert.match(help, /`\/status` — показать версию SUMMING/);
  assert.match(help, /`\/env` — открыть энвы репозитория/);
  assert.match(help, /Пример: `\/bind shop backend`/);
  assert.match(help, /Пример: `\/steer Не меняй публичный API`/);
  assert.match(help, /Voice и audio транскрибируются через OpenAI gpt\\-transcribe/);
  assert.match(help, /Пример: `\/remember Все даты в API передаём в UTC`/);
  assert.match(help, /`\/memory_me`/);
  assert.match(help, /`\/memory_forget_me`/);
  assert.doesNotMatch(help, /Только для администратора|project_create/);
  assert.ok(help.length <= 4_096);
  assertSafeMarkdownV2(help);
});

test("administrator help includes project management examples", () => {
  const help = helpMessage(true);

  assert.match(help, /\*Только для администратора\*/);
  assert.match(help, /`\/limits`/);
  assert.match(help, /`\/topics`/);
  assert.match(help, /`\/memory_pause`/);
  assert.match(help, /`\/bind_topic -1001234567890 42 summing repo`/);
  assert.match(help, /`\/project_create shop 123456789 backend`/);
  assert.match(
    help,
    /`\/project_clone shop 123456789 backend https:\/\/github\.com\/acme\/backend\.git`/,
  );
  assert.ok(help.length <= 4_096);
  assertSafeMarkdownV2(help);
});
