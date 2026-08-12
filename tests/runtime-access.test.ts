import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import { SummateRuntime } from "../src/runtime.js";
import type { TelegramObject } from "../src/telegram-api.js";

test("owners control projects while group participants get read-only Q&A", async () => {
  const root = mkdtempSync(join(tmpdir(), "summate-runtime-access-"));
  const staticPath = join(root, "summate");
  mkdirSync(staticPath);
  const workspace: WorkspaceConfig = { id: "repo", path: staticPath };
  const staticProject = new ProjectConfig(
    "summate",
    "Summate",
    "repo",
    new Map([["repo", workspace]]),
    true,
  );
  const config = new RuntimeConfig(
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
    new Map([["summate", staticProject]]),
  );
  const runtime = new SummateRuntime(config);
  const replies: string[] = [];
  let replyId = 100;
  runtime.telegram.sendMessage = async (_chatId, text) => {
    replies.push(text);
    replyId += 1;
    return replyId;
  };
  const handleMessage = (
    runtime as unknown as { handleMessage(message: TelegramObject): Promise<void> }
  ).handleMessage.bind(runtime);
  let messageId = 0;
  const send = async (
    senderId: number,
    text: string,
    chatId: number,
    chatType: "private" | "supergroup",
    topicId = 0,
  ): Promise<void> => {
    messageId += 1;
    await handleMessage({
      message_id: messageId,
      message_thread_id: topicId,
      text,
      from: { id: senderId },
      chat: { id: chatId, type: chatType },
    });
  };
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for runtime state");
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  };

  try {
    await send(1, "/project_create alpha 42 repo", 1, "private");
    await waitFor(() => replies.some((reply) => reply.includes("Проект создан: alpha")));
    await send(1, "/project_create beta 77 repo", 1, "private");
    await waitFor(() => replies.some((reply) => reply.includes("Проект создан: beta")));
    assert.equal(runtime.projects.owner("alpha"), 42);
    assert.equal(runtime.projects.owner("beta"), 77);

    const beforeUnknown = replies.length;
    await send(999, "/projects", 999, "private");
    assert.equal(replies.length, beforeUnknown);

    await send(42, "/projects", 42, "private");
    assert.match(replies.at(-1) ?? "", /alpha/);
    assert.doesNotMatch(replies.at(-1) ?? "", /beta|summate/);

    await send(1, "/project_create grouped 42 repo", -100, "supergroup", 5);
    assert.throws(() => runtime.projects.project("grouped"), ConfigError);
    assert.match(replies.at(-1) ?? "", /только в личном чате/);

    await send(42, "/bind alpha", -100, "supergroup", 5);
    assert.equal(runtime.state.byTopic(-100, 5)?.projectId, "alpha");
    await send(77, "/bind beta", -100, "supergroup", 5);
    assert.equal(runtime.state.byTopic(-100, 5)?.projectId, "alpha");
    assert.match(replies.at(-1) ?? "", /гостевом режиме команды отключены/);

    let startedConversation = "";
    Object.assign(runtime, {
      startProcessor: (conversation: { id: string }): void => {
        startedConversation = conversation.id;
      },
    });
    await send(999, "Как устроена авторизация?", -100, "supergroup", 5);
    const bound = runtime.state.byTopic(-100, 5)!;
    assert.equal(startedConversation, bound.id);
    assert.deepEqual(
      runtime.state.pendingAll(bound.id).map((item) => [item.text, item.access]),
      [["Как устроена авторизация?", "read-only"]],
    );
    await send(999, "/cancel", -100, "supergroup", 5);
    assert.match(replies.at(-1) ?? "", /гостевом режиме команды отключены/);
    assert.equal(runtime.state.pendingAll(bound.id).length, 1);

    let readOnlyOptions: Record<string, unknown> = {};
    runtime.codex.startThread = async (_cwd, _model, options) => {
      readOnlyOptions = options as Record<string, unknown>;
      return "thr-readonly";
    };
    const selectThread = (
      runtime as unknown as {
        thread(
          conversation: typeof bound,
          cwd: string,
          readableRoot: string,
          gitMetadataRoots: string[],
          readOnlyDeniedPaths: string[],
          access: "write" | "read-only",
        ): Promise<string>;
      }
    ).thread.bind(runtime);
    const alphaWorkspace = runtime.projects.project("alpha").workspace().path;
    assert.equal(
      await selectThread(
        bound,
        alphaWorkspace,
        alphaWorkspace,
        [],
        ["deep/.env"],
        "read-only",
      ),
      "thr-readonly",
    );
    assert.deepEqual(readOnlyOptions, {
      deniedPaths: ["deep/.env"],
      networkAccess: false,
      gitMetadataRoots: [],
      readableRoots: [alphaWorkspace],
      readOnly: true,
    });
    assert.equal(runtime.state.get(bound.id).readOnlyCodexThreadId, "thr-readonly");
    assert.equal(runtime.state.get(bound.id).codexThreadId, null);

    runtime.state.setThread(bound.id, "thr-write");
    await send(42, "/new", -100, "supergroup", 5);
    assert.equal(runtime.state.get(bound.id).codexThreadId, null);
    assert.equal(runtime.state.get(bound.id).readOnlyCodexThreadId, null);

    await send(42, "/restart", 42, "private");
    assert.match(replies.at(-1) ?? "", /только администратору/);

    runtime.state.bind(-200, 9, "removed-project", "repo");
    await send(1, "/bind summate", -200, "supergroup", 9);
    assert.equal(runtime.state.byTopic(-200, 9)?.projectId, "summate");

    let cloneCancelled = false;
    runtime.projects.cloneRemote = async (
      _projectId: unknown,
      _ownerId: unknown,
      _workspaceId: unknown,
      _remote: string,
      signal?: AbortSignal,
    ) => new Promise((_resolveClone, rejectClone) => {
      const cancel = (): void => {
        cloneCancelled = true;
        rejectClone(new Error("cancelled"));
      };
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
    });
    await send(1, "/project_clone slow 42 repo ssh://example.invalid/repo", 1, "private");
    await send(1, "/projects", 1, "private");
    assert.match(replies.at(-1) ?? "", /Проекты:/);
    await send(1, "/cancel", 1, "private");
    await waitFor(() => cloneCancelled);
    assert.match(replies.at(-1) ?? "", /Останавливаю создание проекта/);
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
