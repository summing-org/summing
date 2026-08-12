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
  const replyOptions: Array<{ parseMode?: string }> = [];
  let replyId = 100;
  runtime.telegram.sendMessage = async (_chatId, text, options) => {
    replies.push(text);
    replyOptions.push(options ?? {});
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
    replyToBot = false,
    chatTitle = "",
  ): Promise<void> => {
    messageId += 1;
    await handleMessage({
      message_id: messageId,
      message_thread_id: topicId,
      text,
      from: { id: senderId },
      chat: {
        id: chatId,
        type: chatType,
        ...(chatTitle ? { title: chatTitle, is_forum: true } : {}),
      },
      ...(replyToBot
        ? {
            reply_to_message: {
              message_id: 500,
              from: { id: 500, is_bot: true, username: "summate_bot" },
            },
          }
        : {}),
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

    await send(42, "/help", 42, "private");
    assert.match(replies.at(-1) ?? "", /\*Помощь по Summate\*/);
    assert.match(replies.at(-1) ?? "", /Пример: `\/bind shop backend`/);
    assert.match(replies.at(-1) ?? "", /Пример: `\/remember Все даты в API передаём в UTC`/);
    assert.doesNotMatch(replies.at(-1) ?? "", /Только для администратора|project_create/);
    assert.equal(replyOptions.at(-1)?.parseMode, "MarkdownV2");

    await send(1, "/help", 1, "private");
    assert.match(replies.at(-1) ?? "", /\*Только для администратора\*/);
    assert.match(replies.at(-1) ?? "", /`\/project_create shop 123456789 backend`/);
    assert.equal(replyOptions.at(-1)?.parseMode, "MarkdownV2");

    const handleChatMemberUpdate = (
      runtime as unknown as {
        handleChatMemberUpdate(update: TelegramObject): void;
      }
    ).handleChatMemberUpdate.bind(runtime);
    handleChatMemberUpdate({
      date: 1_700_000_000,
      from: { id: 1, first_name: "Admin" },
      chat: {
        id: -300,
        type: "supergroup",
        title: "Engineering",
        is_forum: true,
      },
      old_chat_member: { status: "left" },
      new_chat_member: { status: "administrator" },
    });
    assert.equal(runtime.state.telegramChat(-300)?.addedByUserId, 1);
    assert.equal(runtime.state.telegramChat(-300)?.botStatus, "administrator");
    await send(1, "/topics", 1, "private");
    assert.match(replies.at(-1) ?? "", /Engineering/);
    assert.match(replies.at(-1) ?? "", /топики пока не обнаружены/);
    await handleMessage({
      message_id: 999,
      message_thread_id: 44,
      date: 1_700_000_100,
      from: { id: 1 },
      chat: {
        id: -300,
        type: "supergroup",
        title: "Engineering",
        is_forum: true,
      },
      forum_topic_created: { name: "Backend" },
    });
    assert.equal(runtime.state.telegramTopic(-300, 44)?.name, "Backend");

    await send(1, "/topics", 1, "private");
    assert.match(replies.at(-1) ?? "", /topic_id: 44 «Backend» → не привязан/);
    await send(42, "/topics", 42, "private");
    assert.match(replies.at(-1) ?? "", /только администратору/);
    await send(1, "/bind_topic -300 44 summate repo", 1, "private");
    assert.equal(runtime.state.byTopic(-300, 44)?.projectId, "summate");
    assert.match(replies.at(-1) ?? "", /Топик привязан/);
    await send(1, "/topics", 1, "private");
    assert.match(replies.at(-1) ?? "", /topic_id: 44 «Backend» → summate\/repo/);
    await send(1, "/bind_topic -300 44 summate repo", -300, "supergroup", 44);
    assert.match(replies.at(-1) ?? "", /только в личном чате/);

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
      telegramBotId: 500,
      telegramUsername: "summate_bot",
      startProcessor: (conversation: { id: string }): void => {
        startedConversation = conversation.id;
      },
    });
    await send(999, "Как устроена авторизация?", -100, "supergroup", 5);
    const bound = runtime.state.byTopic(-100, 5)!;
    assert.equal(startedConversation, "");
    assert.deepEqual(
      runtime.state.pendingAll(bound.id).map((item) => [
        item.text,
        item.access,
        item.senderId,
        item.responseMode,
      ]),
      [["Как устроена авторизация?", "read-only", 999, "ambient"]],
    );
    await send(999, "@summate_bot, как устроена авторизация?", -100, "supergroup", 5);
    assert.equal(startedConversation, bound.id);
    await send(999, "А токены где проверяются?", -100, "supergroup", 5, true);
    assert.deepEqual(
      runtime.state.pendingAll(bound.id).map((item) => item.responseMode),
      ["ambient", "direct", "direct"],
    );
    await send(999, "/cancel", -100, "supergroup", 5);
    assert.match(replies.at(-1) ?? "", /гостевом режиме команды отключены/);
    assert.equal(runtime.state.pendingAll(bound.id).length, 3);

    const beforeRateLimit = runtime.state.pendingAll(bound.id).length;
    for (let index = 0; index < 12; index += 1) {
      await send(888, `Фоновое сообщение ${index}`, -100, "supergroup", 5);
    }
    const beforeNotice = replies.length;
    await send(888, "@summate_bot ответь", -100, "supergroup", 5);
    assert.equal(runtime.state.pendingAll(bound.id).length, beforeRateLimit + 12);
    assert.equal(replies.length, beforeNotice + 1);
    assert.match(replies.at(-1) ?? "", /Слишком много сообщений/);
    await send(888, "@summate_bot ещё раз", -100, "supergroup", 5);
    assert.equal(replies.length, beforeNotice + 1);

    const parseAmbientDecision = (
      runtime as unknown as {
        parseAmbientDecision(
          response: string,
          candidates: number[],
        ): { shouldReply: boolean; replyToMessageId: number | null; answer: string } | null;
      }
    ).parseAmbientDecision.bind(runtime);
    assert.deepEqual(
      parseAmbientDecision(
        '{"should_reply":false,"reply_to_message_id":null,"answer":""}',
        [10],
      ),
      { shouldReply: false, replyToMessageId: null, answer: "" },
    );
    assert.deepEqual(
      parseAmbientDecision(
        '{"should_reply":true,"reply_to_message_id":10,"answer":"Полезный ответ"}',
        [10],
      ),
      { shouldReply: true, replyToMessageId: 10, answer: "Полезный ответ" },
    );
    assert.equal(
      parseAmbientDecision(
        '{"should_reply":true,"reply_to_message_id":999,"answer":"Не туда"}',
        [10],
      ),
      null,
    );
    const longDecision = parseAmbientDecision(
      JSON.stringify({
        should_reply: true,
        reply_to_message_id: 10,
        answer: "а".repeat(5_000),
      }),
      [10],
    );
    assert.equal(longDecision?.answer.length, 3_900);
    assert.match(longDecision?.answer ?? "", /…$/);

    const executedModes: string[] = [];
    Object.assign(runtime, {
      executeRun: async (
        _conversationId: string,
        _prompt: string,
        _replyTo: number,
        inputIds: number[],
        _access: string,
        responseMode: string,
      ): Promise<void> => {
        executedModes.push(responseMode);
        runtime.state.consume(inputIds);
      },
    });
    const conversationLoop = (
      runtime as unknown as { conversationLoop(conversationId: string): Promise<void> }
    ).conversationLoop.bind(runtime);
    await conversationLoop(bound.id);
    assert.deepEqual(executedModes, ["direct"]);
    assert.ok(runtime.state.pendingAll(bound.id).every((item) => item.responseMode === "ambient"));
    (
      runtime as unknown as { ambientReady: Set<string> }
    ).ambientReady.add(bound.id);
    await conversationLoop(bound.id);
    assert.deepEqual(executedModes, ["direct", "ambient"]);
    assert.equal(runtime.state.pendingAll(bound.id).length, 0);

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
    runtime.requestStop();
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
