import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";
import type { TelegramObject } from "../src/telegram-api.js";

function runtimeFixture(): { root: string; runtime: SummingRuntime } {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-limits-"));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const workspace: WorkspaceConfig = { id: "repo", path: workspacePath };
  const project = new ProjectConfig(
    "summing",
    "SUMMING",
    "repo",
    new Map([["repo", workspace]]),
  );
  return {
    root,
    runtime: new SummingRuntime(
      new RuntimeConfig(
        join(root, "data"),
        join(root, "codex"),
        join(root, "worktrees"),
        "token",
        1,
        "codex",
        8765,
        2,
        1,
        "",
        "medium",
        true,
        new Map([["summing", project]]),
      ),
    ),
  };
}

test("administrator reads VPS limits and refreshes the bot profile", async () => {
  const { root, runtime } = runtimeFixture();
  const replies: string[] = [];
  const profiles: string[] = [];
  runtime.telegram.sendMessage = async (_chatId, text) => {
    replies.push(text);
    return replies.length;
  };
  runtime.telegram.setMyShortDescription = async (description) => {
    profiles.push(description);
  };
  runtime.codex.account = async () => ({ account: { type: "chatgpt", planType: "plus" } });
  runtime.codex.rateLimits = async () => ({
    rateLimits: {
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_786_656_000 },
      secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_787_260_800 },
    },
  });
  const handleMessage = (
    runtime as unknown as { handleMessage(message: TelegramObject): Promise<void> }
  ).handleMessage.bind(runtime);

  try {
    await handleMessage({
      message_id: 1,
      text: "/limits",
      from: { id: 1 },
      chat: { id: 1, type: "private" },
    });
    assert.match(replies.at(-1) ?? "", /Codex limits на VPS/);
    assert.match(replies.at(-1) ?? "", /Неделя: 60% осталось/);
    assert.match(profiles.at(-1) ?? "", /^🟢 Codex: неделя 60%/);
    assert.match(profiles.at(-1) ?? "", / · SUMMING 9\.4\.2$/);
    assert.equal(
      (runtime.status().codex_limits as Record<string, unknown>).weekly_remaining_percent,
      60,
    );
    assert.equal(runtime.status().version, "9.4.2");

    await handleMessage({
      message_id: 2,
      text: "/status",
      from: { id: 1 },
      chat: { id: 1, type: "private" },
    });
    assert.match(replies.at(-1) ?? "", /^SUMMING: 9\.4\.2$/m);
  } finally {
    runtime.requestStop();
    runtime.state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("VPS limits command is restricted to the administrator private chat", async () => {
  const { root, runtime } = runtimeFixture();
  const replies: string[] = [];
  runtime.telegram.sendMessage = async (_chatId, text) => {
    replies.push(text);
    return replies.length;
  };
  const handleMessage = (
    runtime as unknown as { handleMessage(message: TelegramObject): Promise<void> }
  ).handleMessage.bind(runtime);

  try {
    await handleMessage({
      message_id: 1,
      text: "/limits",
      from: { id: 42 },
      chat: { id: 42, type: "private" },
    });
    assert.equal(replies.length, 0);

    await handleMessage({
      message_id: 2,
      text: "/limits",
      from: { id: 1 },
      chat: { id: -100, type: "supergroup" },
    });
    assert.match(replies.at(-1) ?? "", /в личном чате/);
  } finally {
    runtime.requestStop();
    runtime.state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
