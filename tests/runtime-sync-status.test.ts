import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";

test("sync status is restricted to the owner private chat and remains separate from /status", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-sync-status-"));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const workspace: WorkspaceConfig = { id: "repo", path: workspacePath };
  const runtime = new SummingRuntime(new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "token",
    1,
    "codex",
    8_765,
    2,
    1,
    "",
    "medium",
    true,
    new Map([["summing", new ProjectConfig(
      "summing",
      "SUMMING",
      "repo",
      new Map([["repo", workspace]]),
    )]]),
  ));
  const replies: string[] = [];
  runtime.telegram.sendMessage = async (_chatId, text) => {
    replies.push(text);
    return replies.length;
  };
  const handleCommand = (
    runtime as unknown as {
      handleCommand(
        chatId: number,
        topicId: number,
        messageId: number,
        senderId: number,
        chatType: string,
        text: string,
      ): Promise<void>;
    }
  ).handleCommand.bind(runtime);
  try {
    await handleCommand(1, 0, 1, 1, "private", "/sync_status");
    assert.match(replies.at(-1) ?? "", /Telegram-группы ещё не настроены/);
    await handleCommand(-100, 0, 2, 1, "supergroup", "/sync_status");
    assert.match(replies.at(-1) ?? "", /только в личном чате/);
    await handleCommand(42, 0, 3, 42, "private", "/sync_status");
    assert.match(replies.at(-1) ?? "", /только администратору/);
  } finally {
    await runtime.knowledgeSync.close();
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
