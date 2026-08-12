import assert from "node:assert/strict";
import test from "node:test";
import { helpMessage } from "../src/help-message.js";

test("help describes everyday commands with examples", () => {
  const help = helpMessage(false);

  assert.match(help, /^\*Помощь по Summate\*/);
  assert.match(help, /Пример: `\/bind shop backend`/);
  assert.match(help, /Пример: `\/steer Не меняй публичный API`/);
  assert.match(help, /Пример: `\/remember Все даты в API передаём в UTC`/);
  assert.doesNotMatch(help, /Только для администратора|project_create/);
  assert.ok(help.length <= 4_096);
});

test("administrator help includes project management examples", () => {
  const help = helpMessage(true);

  assert.match(help, /\*Только для администратора\*/);
  assert.match(help, /`\/project_create shop 123456789 backend`/);
  assert.match(
    help,
    /`\/project_clone shop 123456789 backend https:\/\/github\.com\/acme\/backend\.git`/,
  );
  assert.ok(help.length <= 4_096);
});
