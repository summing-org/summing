import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";
import type { TelegramObject } from "../src/telegram-api.js";

test("deletes credential-like Telegram input before state or Codex queues see it", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-ingress-runtime-"));
  const workspacePath = join(root, "repo");
  mkdirSync(workspacePath);
  const project = new ProjectConfig(
    "demo",
    "Demo",
    "repo",
    new Map([["repo", { id: "repo", path: workspacePath }]]),
  );
  const runtime = new SummingRuntime(new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "token",
    42,
    "codex",
    8_765,
    1,
    1,
    "",
    "medium",
    false,
    new Map([["demo", project]]),
  ));
  const deleted: Array<[number, number]> = [];
  const replies: string[] = [];
  runtime.telegram.deleteMessage = async (chatId, messageId) => {
    deleted.push([chatId, messageId]);
  };
  runtime.telegram.sendMessage = async (_chatId, text) => {
    replies.push(text);
    return 100;
  };
  const handleMessage = (
    runtime as unknown as { handleMessage(message: TelegramObject): Promise<void> }
  ).handleMessage.bind(runtime);
  try {
    await handleMessage({
      message_id: 17,
      text: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      from: { id: 42 },
      chat: { id: 42, type: "private" },
    });
    assert.deepEqual(deleted, [[42, 17]]);
    assert.match(replies[0] ?? "", /удалено до сохранения/);
    assert.equal(runtime.state.listConversations().length, 0);
    assert.equal(runtime.state.counts().pending, 0);
    assert.equal(runtime.state.securityEventCount(), 1);
  } finally {
    runtime.state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
