import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";

test("administrator /start opens the control center and refreshes the menu button", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-admin-miniapp-"));
  const repository = join(root, "summing");
  mkdirSync(repository);
  const workspace: WorkspaceConfig = { id: "repo", path: repository };
  const runtime = new SummingRuntime(
    new RuntimeConfig(
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
      new Map([
        [
          "summing",
          new ProjectConfig("summing", "SUMMING", "repo", new Map([["repo", workspace]]), true),
        ],
      ]),
      20,
      12,
      60,
      "openai",
      "gpt-transcribe",
      "",
      "",
      20_000_000,
      8_766,
      "https://summing.example",
    ),
  );
  const menuCalls: Array<{ chatId: number; url: string }> = [];
  const messages: Array<{ text: string; options: Record<string, unknown> | undefined }> = [];
  runtime.telegram.setChatMenuButton = async (chatId, url) => {
    menuCalls.push({ chatId, url });
  };
  runtime.telegram.sendMessage = async (_chatId, text, options) => {
    messages.push({ text, options });
    return 17;
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
    await handleCommand(1, 0, 10, 1, "private", "/start");
    assert.deepEqual(menuCalls, [{ chatId: 1, url: "https://summing.example/admin" }]);
    assert.match(messages[0]?.text ?? "", /Центр управления SUMMING/);
    assert.deepEqual(messages[0]?.options?.replyMarkup, {
      inline_keyboard: [[{
        text: "Открыть центр управления",
        web_app: { url: "https://summing.example/admin" },
      }]],
    });
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
