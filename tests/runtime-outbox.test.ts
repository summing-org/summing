import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";
import type { PendingInput } from "../src/state-store.js";

test("a successful editor run uploads generated outbox files to its Telegram reply", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-outbox-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  const git = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repository, "README.md"), "demo\n");
  git("add", "README.md");
  git("commit", "-m", "initial");
  const workspace: WorkspaceConfig = { id: "repo", path: repository };
  const project = new ProjectConfig(
    "demo",
    "Demo",
    "repo",
    new Map([["repo", workspace]]),
  );
  const runtime = new SummingRuntime(new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "telegram-token",
    1,
    "codex",
    8765,
    2,
    0.5,
    "",
    "medium",
    true,
    new Map([["demo", project]]),
  ));
  runtime.workspaces.initialize();
  const conversation = runtime.state.bind(42, 0, "demo", "repo");
  const attachmentDirectory = join(runtime.attachments.spoolRoot, conversation.id);
  mkdirSync(attachmentDirectory, { recursive: true });
  const attachmentPath = join(attachmentDirectory, "owner-photo.jpg");
  writeFileSync(attachmentPath, Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]));
  const imageInputId = runtime.state.enqueueInput(
    conversation.id,
    18,
    "Добавь к фото смартфон",
    "followup",
    "write",
    1,
    "direct",
    [{
      kind: "image",
      fileName: "owner-photo.jpg",
      mimeType: "image/jpeg",
      filePath: attachmentPath,
      size: 4,
    }],
  );
  const messages: string[] = [];
  const documents: Array<{
    chatId: number;
    fileName: string;
    mimeType: string;
    data: number[];
    options: { topicId?: number; replyTo?: number };
  }> = [];
  runtime.telegram.sendChatAction = async () => {};
  runtime.telegram.sendMessage = async (_chatId, text) => {
    messages.push(text);
    return messages.length;
  };
  runtime.telegram.editMessage = async () => {};
  runtime.telegram.deleteMessage = async () => {};
  runtime.telegram.sendDocument = async (chatId, data, fileName, mimeType, options) => {
    documents.push({ chatId, fileName, mimeType, data: [...data], options: options ?? {} });
    return 100 + documents.length;
  };
  runtime.codex.account = async () => ({ account: { type: "chatgpt" } });
  runtime.codex.startThread = async () => "thread-outbox";
  let receivedLocalImagePaths: string[] = [];
  const routeCodexEvent = (
    runtime as unknown as {
      routeCodexEvent(event: {
        method: string;
        params: Record<string, unknown>;
      }): Promise<void>;
    }
  ).routeCodexEvent.bind(runtime);
  runtime.codex.startTurn = async (threadId, _prompt, cwd, options) => {
    receivedLocalImagePaths = options?.localImagePaths ?? [];
    assert.deepEqual(receivedLocalImagePaths, [
      join(cwd, ".summing-runtime", "attachments", `18-${imageInputId}-owner-photo.jpg`),
    ]);
    assert.equal(existsSync(receivedLocalImagePaths[0]!), true);
    writeFileSync(
      join(cwd, ".summing-runtime", "outbox", "test-report.pdf"),
      Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
    );
    setImmediate(() => {
      void (async () => {
        await routeCodexEvent({
          method: "item/completed",
          params: {
            threadId,
            turnId: "turn-outbox",
            item: {
              id: "answer-outbox",
              type: "agentMessage",
              phase: "final_answer",
              text: "Готово, PDF приложен к сообщению.",
            },
          },
        });
        await routeCodexEvent({
          method: "turn/completed",
          params: {
            threadId,
            turnId: "turn-outbox",
            turn: { id: "turn-outbox", status: "completed" },
          },
        });
      })();
    });
    return "turn-outbox";
  };
  const executeRun = (
    runtime as unknown as {
      executeRun(
        conversationId: string,
        prompt: string,
        replyTo: number,
        inputIds: number[],
        access: "write" | "read-only",
        inputs?: PendingInput[],
      ): Promise<void>;
    }
  ).executeRun.bind(runtime);

  try {
    await executeRun(
      conversation.id,
      "Добавь к фото смартфон и пришли результат",
      17,
      [imageInputId],
      "write",
      runtime.state.pendingAll(conversation.id),
    );
    assert.equal(receivedLocalImagePaths.length, 1);
    assert.deepEqual(documents, [{
      chatId: 42,
      fileName: "test-report.pdf",
      mimeType: "application/pdf",
      data: [0x25, 0x50, 0x44, 0x46],
      options: { topicId: 0, replyTo: 17 },
    }]);
    assert.ok(messages.some((message) => message.includes("PDF приложен")));
    assert.equal(messages.some((message) => message.includes("не отправлена")), false);
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
