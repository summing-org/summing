import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";
import type { TelegramObject } from "../src/telegram-api.js";

test("owners control projects while group participants get read-only Q&A", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-access-"));
  const staticPath = join(root, "summing");
  mkdirSync(staticPath);
  const workspace: WorkspaceConfig = { id: "repo", path: staticPath };
  const staticProject = new ProjectConfig(
    "summing",
    "SUMMING",
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
    new Map([["summing", staticProject]]),
  );
  const runtime = new SummingRuntime(config);
  const replies: string[] = [];
  const replyChats: number[] = [];
  const replyOptions: Array<{ topicId?: number; parseMode?: string }> = [];
  let replyId = 100;
  runtime.telegram.sendMessage = async (chatId, text, options) => {
    replies.push(text);
    replyChats.push(chatId);
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
    repliedText = "",
    replyToUserId = 0,
    replyMessageId = 500,
  ): Promise<number> => {
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
      ...(replyToBot || replyToUserId
        ? {
            reply_to_message: {
              message_id: replyMessageId,
              from: replyToBot
                ? { id: 500, is_bot: true, username: "summing_bot" }
                : { id: replyToUserId, is_bot: false, username: "teammate" },
              ...(repliedText ? { text: repliedText } : {}),
            },
          }
        : {}),
    });
    return messageId;
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
    runtime.projects.replaceOwners("alpha", 42, [42, 88]);
    assert.deepEqual(runtime.projects.owners("alpha"), [42, 88]);

    await send(42, "/help", 42, "private");
    assert.match(replies.at(-1) ?? "", /\*Помощь по SUMMING\*/);
    assert.match(replies.at(-1) ?? "", /Пример: `\/bind shop backend`/);
    assert.match(
      replies.at(-1) ?? "",
      /Пример: `\/remember constraint: Все даты в API передаём в UTC`/,
    );
    assert.doesNotMatch(replies.at(-1) ?? "", /Только для администратора|project_create/);
    assert.equal(replyOptions.at(-1)?.parseMode, "MarkdownV2");

    await send(1, "/help", 1, "private");
    assert.match(replies.at(-1) ?? "", /\*Только для администратора\*/);
    assert.match(replies.at(-1) ?? "", /`\/project_create shop 123456789 backend`/);
    assert.equal(replyOptions.at(-1)?.parseMode, "MarkdownV2");

    const handleChatMemberUpdate = (
      runtime as unknown as {
        handleChatMemberUpdate(update: TelegramObject): Promise<void>;
      }
    ).handleChatMemberUpdate.bind(runtime);
    await handleChatMemberUpdate({
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
    const engineeringSpace = runtime.state.teamSpaceForProvider("telegram", "-300")!;
    assert.equal(engineeringSpace.announcedAt !== null, true);
    assert.equal(runtime.state.teamEventCount(engineeringSpace.id), 1);
    await send(1, "/topics", 1, "private");
    assert.match(replies.at(-1) ?? "", /Engineering/);
    assert.match(replies.at(-1) ?? "", /топики пока не обнаружены/);
    await handleMessage({
      message_id: 999,
      message_thread_id: 44,
      date: 1_700_000_100,
      from: {
        id: 1,
        username: "admin",
        first_name: "Admin",
        last_name: "Owner",
        language_code: "ru",
        is_premium: true,
      },
      chat: {
        id: -300,
        type: "supergroup",
        title: "Engineering",
        is_forum: true,
      },
      forum_topic_created: { name: "Backend" },
    });
    assert.equal(runtime.state.telegramTopic(-300, 44)?.name, "Backend");
    assert.equal(runtime.state.telegramTopicUserCount(-300, 44), 1);
    assert.deepEqual(runtime.state.listTelegramTopicUsers(-300, 44)[0], {
      userId: 1,
      username: "admin",
      firstName: "Admin",
      lastName: "Owner",
      isBot: false,
      languageCode: "ru",
      isPremium: true,
      messageCount: 1,
      topicCount: 1,
      firstSeenAt: 1_700_000_100,
      lastSeenAt: 1_700_000_100,
    });

    await send(999, "/topic_id@summing_bot", -300, "supergroup", 44);
    assert.equal(
      replies.at(-1),
      "Текущий Telegram-топик:\nchat_id: -300\ntopic_id: 44",
    );
    assert.equal(replyChats.at(-1), -300);
    assert.equal(replyOptions.at(-1)?.topicId, 44);

    await send(999, "/topic_id", 999, "private");
    assert.equal(
      replies.at(-1),
      "Команда /topic_id работает только внутри топика Telegram-форума.",
    );

    await send(999, "/topic_id", -300, "supergroup");
    assert.equal(
      replies.at(-1),
      "Команда /topic_id работает только внутри топика Telegram-форума.",
    );

    await send(1, "/topics", 1, "private");
    assert.match(replies.at(-1) ?? "", /topic_id: 44 «Backend» → не привязан/);
    await send(42, "/topics", 42, "private");
    assert.match(replies.at(-1) ?? "", /только администратору/);
    await send(1, "/bind_topic -300 44 summing repo", 1, "private");
    assert.equal(runtime.state.byTopic(-300, 44)?.projectId, "summing");
    assert.match(replies.at(-1) ?? "", /Основной рабочий топик привязан/);
    await send(1, "/topics", 1, "private");
    assert.match(replies.at(-1) ?? "", /topic_id: 44 «Backend» → summing\/repo/);
    await send(1, "/bind_topic -300 44 summing repo", -300, "supergroup", 44);
    assert.match(replies.at(-1) ?? "", /только в личном чате/);

    const beforeUnknown = replies.length;
    await send(999, "/projects", 999, "private");
    assert.equal(replies.length, beforeUnknown);

    await send(42, "/projects", 42, "private");
    assert.match(replies.at(-1) ?? "", /alpha/);
    assert.doesNotMatch(replies.at(-1) ?? "", /beta|summing/);
    await send(88, "/projects", 88, "private");
    assert.match(replies.at(-1) ?? "", /alpha/);
    assert.doesNotMatch(replies.at(-1) ?? "", /beta|summing/);

    await send(1, "/project_create grouped 42 repo", -100, "supergroup", 5);
    assert.throws(() => runtime.projects.project("grouped"), ConfigError);
    assert.match(replies.at(-1) ?? "", /только в личном чате/);

    await send(42, "/bind alpha", -100, "supergroup", 5);
    assert.equal(runtime.state.byTopic(-100, 5)?.projectId, "alpha");
    const ownerNotice = replies.findIndex((reply) =>
      reply.includes("основным рабочим столом проекта <b>alpha</b>")
    );
    assert.notEqual(ownerNotice, -1);
    assert.equal(replyChats[ownerNotice], -100);
    assert.match(replies[ownerNotice] ?? "", /tg:\/\/user\?id=42/);
    assert.doesNotMatch(replies[ownerNotice] ?? "", /tg:\/\/user\?id=88/);
    assert.match(replies[ownerNotice] ?? "", /Repository: <code>repo<\/code>/);
    assert.deepEqual(replyOptions[ownerNotice], { topicId: 5, parseMode: "HTML" });
    const ownerNoticeCount = replies.filter((reply) =>
      reply.includes("где вы назначены владельцем")
    ).length;
    await send(42, "/bind alpha", -100, "supergroup", 5);
    assert.equal(
      replies.filter((reply) => reply.includes("где вы назначены владельцем")).length,
      ownerNoticeCount,
    );
    await send(77, "/bind beta", -100, "supergroup", 5);
    assert.equal(runtime.state.byTopic(-100, 5)?.projectId, "alpha");
    assert.match(replies.at(-1) ?? "", /гостевом режиме команды отключены/);

    let startedConversation = "";
    const unboundQuestions: Array<{
      chatId: number;
      topicId: number;
      messageId: number;
      senderId: number;
      text: string;
      context: Array<{ text: string; author?: "bot" }>;
    }> = [];
    Object.assign(runtime, {
      telegramBotId: 500,
      telegramUsername: "summing_bot",
      startProcessor: (conversation: { id: string }): void => {
        startedConversation = conversation.id;
      },
      startUnboundQuestion: (question: (typeof unboundQuestions)[number]): void => {
        unboundQuestions.push(question);
      },
    });

    await send(1, "/bind_observer_topic -300 44 alpha repo", 1, "private");
    const externalPortal = runtime.state.byTopic(-300, 44)!;
    assert.equal(externalPortal.role, "observer");
    assert.match(replies.at(-1) ?? "", /Топик-наблюдатель проекта привязан/);
    await send(42, "/publish Исправление авторизации принято и опубликовано.", -100, "supergroup", 5);
    const publishedIndex = replies.findIndex((reply) =>
      reply.includes("📣 Обновление проекта «alpha»") &&
      reply.includes("Исправление авторизации принято")
    );
    assert.notEqual(publishedIndex, -1);
    assert.equal(replyChats[publishedIndex], -300);
    assert.equal(replyOptions[publishedIndex]?.topicId, 44);
    assert.match(replies.at(-1) ?? "", /Обновление опубликовано: 1\/1/);
    startedConversation = "";
    await send(42, "Обсудим детали отчёта", -300, "supergroup", 44);
    assert.equal(startedConversation, "");
    await send(42, "@summing_bot что означает второй пункт?", -300, "supergroup", 44);
    assert.equal(startedConversation, externalPortal.id);
    assert.deepEqual(
      runtime.state.pendingAll(externalPortal.id).map((item) => [item.access, item.responseMode]),
      [["read-only", "direct"]],
    );
    await send(1, "/cancel", -300, "supergroup", 44);
    assert.match(replies.at(-1) ?? "", /В топике-наблюдателе команды отключены/);
    runtime.state.consume(runtime.state.pendingAll(externalPortal.id).map((item) => item.id));
    startedConversation = "";

    const bound = runtime.state.byTopic(-100, 5)!;
    await send(42, "/remember constraint: Все даты UTC", -100, "supergroup", 5);
    const remembered = runtime.state.projectMemoryItems("alpha")[0]!;
    assert.equal(remembered.kind, "constraint");
    assert.equal(remembered.text, "Все даты UTC");
    assert.match(replies.at(-1) ?? "", new RegExp(`memory:${remembered.id}`));
    await send(
      42,
      `/remember_replace ${remembered.id} decision: API принимает RFC 3339`,
      -100,
      "supergroup",
      5,
    );
    const replacement = runtime.state.projectMemoryItems("alpha")[0]!;
    assert.equal(replacement.kind, "decision");
    assert.equal(replacement.supersedesId, remembered.id);
    await send(42, "/remember_list", -100, "supergroup", 5);
    assert.match(replies.at(-1) ?? "", /API принимает RFC 3339/);
    await send(42, `/remember_forget ${replacement.id}`, -100, "supergroup", 5);
    assert.deepEqual(runtime.state.projectMemoryItems("alpha"), []);
    const humanAddressedMessageId = await send(
      42,
      "@TON1K_01 текущий топик настроен на проект summing",
      -100,
      "supergroup",
      5,
    );
    const humanReplyMessageId = await send(
      42,
      "тебя там владельцем поставим",
      -100,
      "supergroup",
      5,
      false,
      "",
      "",
      42,
    );
    assert.equal(startedConversation, "");
    assert.deepEqual(runtime.state.pendingAll(bound.id), []);
    const boundSource = runtime.state.teamSourceForProvider("telegram", "-100", "5")!;
    assert.equal(
      runtime.state.teamEventByExternalId(
        boundSource.id,
        String(humanAddressedMessageId),
      )?.directClaimedAt,
      null,
    );
    assert.equal(
      runtime.state.teamEventByExternalId(boundSource.id, String(humanReplyMessageId))
        ?.directClaimedAt,
      null,
    );
    assert.deepEqual(
      runtime.state.recentTeamEvents(boundSource.spaceId, boundSource.id)
        .slice(-2)
        .map((event) => event.text),
      [
        "@TON1K_01 текущий топик настроен на проект summing",
        "тебя там владельцем поставим",
      ],
    );

    await send(
      42,
      "@TON1K_01, @summing_bot уточни риск",
      -100,
      "supergroup",
      5,
    );
    assert.equal(startedConversation, bound.id);
    assert.deepEqual(
      runtime.state.pendingAll(bound.id).map((item) => [item.access, item.responseMode]),
      [["write", "direct"]],
    );
    runtime.state.consume(runtime.state.pendingAll(bound.id).map((item) => item.id));
    startedConversation = "";

    await send(
      42,
      "подтянул, чекай",
      -100,
      "supergroup",
      5,
      false,
      "",
      "корень forum topic",
      42,
      5,
    );
    assert.equal(startedConversation, bound.id);
    assert.deepEqual(
      runtime.state.pendingAll(bound.id).map((item) => [
        item.text,
        item.access,
        item.responseMode,
      ]),
      [["подтянул, чекай", "write", "direct"]],
    );
    runtime.state.consume(runtime.state.pendingAll(bound.id).map((item) => item.id));
    startedConversation = "";

    await send(
      42,
      "@summing_bot",
      -100,
      "supergroup",
      5,
      false,
      "",
      "подтянул, чекай",
      42,
      639,
    );
    assert.equal(startedConversation, bound.id);
    const explicitReplyInput = runtime.state.pendingAll(bound.id)[0]!;
    assert.equal(explicitReplyInput.access, "write");
    assert.equal(explicitReplyInput.responseMode, "direct");
    assert.match(explicitReplyInput.text, /SUMMING transport context/);
    assert.match(explicitReplyInput.text, /"message_id": 639/);
    assert.match(explicitReplyInput.text, /"text": "подтянул, чекай"/);
    assert.match(explicitReplyInput.text, /deepest relevant quoted message/);
    runtime.state.consume([explicitReplyInput.id]);
    startedConversation = "";

    const rootReplyId = await send(
      42,
      "Исходное решение: выпускать в пятницу",
      -100,
      "supergroup",
      5,
    );
    const bridgeReplyId = await send(
      42,
      "вот",
      -100,
      "supergroup",
      5,
      false,
      "",
      "Исходное решение: выпускать в пятницу",
      42,
      rootReplyId,
    );
    runtime.state.consume(runtime.state.pendingAll(bound.id).map((item) => item.id));
    await send(
      42,
      "@summing_bot",
      -100,
      "supergroup",
      5,
      false,
      "",
      "вот",
      42,
      bridgeReplyId,
    );
    const replyChainInput = runtime.state.pendingAll(bound.id)[0]!;
    assert.match(replyChainInput.text, /"relation": "explicit_reply_chain"/);
    assert.match(
      replyChainInput.text,
      /"depth": 1[\s\S]*"text": "вот"[\s\S]*"depth": 2[\s\S]*"text": "Исходное решение: выпускать в пятницу"/,
    );
    runtime.state.consume([replyChainInput.id]);
    startedConversation = "";

    const handleTeamEditedMessage = (
      runtime as unknown as {
        handleTeamEditedMessage(
          message: TelegramObject,
          providerUpdateId?: string,
        ): Promise<void>;
      }
    ).handleTeamEditedMessage.bind(runtime);
    await handleTeamEditedMessage({
      message_id: 641,
      message_thread_id: 5,
      edit_date: 1_700_000_200,
      text: "@summing_bot алё братело!",
      from: { id: 42 },
      chat: { id: -100, type: "supergroup", title: "dev", is_forum: true },
      reply_to_message: {
        message_id: 5,
        from: { id: 42, is_bot: false },
        text: "корень forum topic",
      },
    }, "edited-641");
    assert.equal(startedConversation, bound.id);
    assert.deepEqual(
      runtime.state.pendingAll(bound.id).map((item) => [
        item.text,
        item.access,
        item.responseMode,
      ]),
      [["@summing_bot алё братело!", "write", "direct"]],
    );
    runtime.state.consume(runtime.state.pendingAll(bound.id).map((item) => item.id));
    startedConversation = "";

    const directStatusMessageId = await send(
      42,
      "проверь текущий статус проекта",
      -100,
      "supergroup",
      5,
    );
    assert.equal(startedConversation, bound.id);
    assert.deepEqual(
      runtime.state.pendingAll(bound.id).map((item) => [item.access, item.responseMode]),
      [["write", "direct"]],
    );
    assert.notEqual(
      runtime.state.teamEventByExternalId(boundSource.id, String(directStatusMessageId))
        ?.directClaimedAt,
      null,
    );
    runtime.state.consume(runtime.state.pendingAll(bound.id).map((item) => item.id));
    startedConversation = "";

    const beforeUnboundReplies = replies.length;
    await send(999, "Всем привет", -100, "supergroup", 6);
    await send(42, "Обсудим планы на вечер", -100, "supergroup", 6);
    assert.equal(replies.length, beforeUnboundReplies);
    assert.equal(unboundQuestions.length, 0);
    assert.equal(runtime.state.byTopic(-100, 6), null);
    assert.ok(runtime.state.telegramTopic(-100, 6));

    await send(999, "@summing_bot", -100, "supergroup", 6);
    assert.equal(replies.at(-1), "Я здесь. Напишите вопрос вместе с упоминанием.");
    assert.equal(unboundQuestions.length, 0);
    const afterBareMentionReplies = replies.length;

    await send(999, "@summing_bot, подведи итог обсуждения", -100, "supergroup", 6);
    assert.equal(replies.length, afterBareMentionReplies);
    assert.equal(unboundQuestions.length, 1);
    assert.equal(unboundQuestions[0]?.topicId, 6);
    assert.equal(unboundQuestions[0]?.senderId, 999);
    assert.deepEqual(
      unboundQuestions[0]?.context.map((item) => item.text),
      ["Всем привет", "Обсудим планы на вечер", "@summing_bot"],
    );
    for (let index = 0; index < 25; index += 1) {
      await send(999, `Контекст ${index}`, -100, "supergroup", 6);
    }
    await send(999, "@summing_bot, что было последним?", -100, "supergroup", 6);
    assert.equal(unboundQuestions[1]?.context.length, 20);
    assert.equal(unboundQuestions[1]?.context[0]?.text, "Контекст 5");
    assert.equal(unboundQuestions[1]?.context.at(-1)?.text, "Контекст 24");
    await send(
      999,
      "Раскрой второй пункт",
      -100,
      "supergroup",
      6,
      true,
      "",
      "Первый пункт: сроки. Второй пункт: риски.",
    );
    assert.equal(unboundQuestions[2]?.context.at(-1)?.author, "bot");
    assert.equal(
      unboundQuestions[2]?.context.at(-1)?.text,
      "Первый пункт: сроки. Второй пункт: риски.",
    );
    await send(
      999,
      "@summing_bot",
      -100,
      "supergroup",
      6,
      false,
      "",
      "подтянул, чекай",
      42,
      638,
    );
    assert.match(unboundQuestions[3]?.text ?? "", /SUMMING transport context/);
    assert.match(unboundQuestions[3]?.text ?? "", /"text": "подтянул, чекай"/);

    for (let topic = 1; topic <= 101; topic += 1) {
      await send(777, `Фоновый контекст ${topic}`, -400, "supergroup", topic);
    }
    const observedSpace = runtime.state.teamSpaceForProvider("telegram", "-400")!;
    assert.equal(runtime.state.teamEventCount(observedSpace.id), 101);
    const firstSource = runtime.state.teamSourceForProvider("telegram", "-400", "1")!;
    const lastSource = runtime.state.teamSourceForProvider("telegram", "-400", "101")!;
    assert.equal(runtime.state.recentTeamEvents(observedSpace.id, firstSource.id)[0]?.text, "Фоновый контекст 1");
    assert.equal(runtime.state.recentTeamEvents(observedSpace.id, lastSource.id)[0]?.text, "Фоновый контекст 101");
    assert.equal(runtime.state.telegramChatUserCount(-400), 1);
    await send(777, "/memory_forget_me", -400, "supergroup", 101);
    assert.equal(
      runtime.state.teamEventCountForIdentity(observedSpace.id, "telegram", "777"),
      0,
    );
    assert.equal(runtime.state.telegramChatUserCount(-400), 0);
    await send(777, "Не сохраняй это", -400, "supergroup", 101);
    assert.equal(runtime.state.teamEventCount(observedSpace.id), 0);
    assert.equal(runtime.state.telegramChatUserCount(-400), 0);
    await send(777, "/memory_resume_me", -400, "supergroup", 101);
    await send(777, "Снова сохраняй", -400, "supergroup", 101);
    assert.equal(runtime.state.teamEventCount(observedSpace.id), 1);
    assert.equal(runtime.state.telegramChatUserCount(-400), 1);

    await send(999, "Как устроена авторизация?", -100, "supergroup", 5);
    assert.equal(startedConversation, "");
    assert.deepEqual(runtime.state.pendingAll(bound.id), []);
    await send(999, "@summing_bot, как устроена авторизация?", -100, "supergroup", 5);
    assert.equal(startedConversation, bound.id);
    await send(999, "А токены где проверяются?", -100, "supergroup", 5, true);
    assert.deepEqual(
      runtime.state.pendingAll(bound.id).map((item) => item.responseMode),
      ["direct", "direct"],
    );
    await send(999, "/cancel", -100, "supergroup", 5);
    assert.match(replies.at(-1) ?? "", /гостевом режиме команды отключены/);
    assert.equal(runtime.state.pendingAll(bound.id).length, 2);

    const beforeRateLimit = runtime.state.pendingAll(bound.id).length;
    for (let index = 0; index < 12; index += 1) {
      await send(888, `Обычное фоновое сообщение ${index}`, -100, "supergroup", 5);
    }
    assert.equal(runtime.state.pendingAll(bound.id).length, beforeRateLimit);
    for (let index = 0; index < 12; index += 1) {
      await send(888, `@summing_bot прямой вопрос ${index}`, -100, "supergroup", 5);
    }
    const beforeNotice = replies.length;
    await send(888, "@summing_bot ответь", -100, "supergroup", 5);
    assert.equal(runtime.state.pendingAll(bound.id).length, beforeRateLimit + 12);
    assert.equal(replies.length, beforeNotice + 1);
    assert.match(replies.at(-1) ?? "", /Слишком много сообщений/);
    await send(888, "@summing_bot ещё раз", -100, "supergroup", 5);
    assert.equal(replies.length, beforeNotice + 1);

    runtime.state.enqueueInput(
      bound.id,
      9999,
      "legacy ambient input",
      "followup",
      "read-only",
      999,
      "ambient",
    );
    let directRuns = 0;
    Object.assign(runtime, {
      executeRun: async (
        _conversationId: string,
        _prompt: string,
        _replyTo: number,
        inputIds: number[],
        _access: string,
      ): Promise<void> => {
        directRuns += 1;
        runtime.state.consume(inputIds);
      },
    });
    const conversationLoop = (
      runtime as unknown as { conversationLoop(conversationId: string): Promise<void> }
    ).conversationLoop.bind(runtime);
    await conversationLoop(bound.id);
    assert.equal(directRuns, 1);
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

    runtime.state.setThread(bound.id, "thr-legacy", "write", "legacy-v1");
    let resumedLegacy = false;
    let writeOptions: Record<string, unknown> = {};
    runtime.codex.resumeThread = async () => {
      resumedLegacy = true;
    };
    runtime.codex.startThread = async (_cwd, _model, options) => {
      writeOptions = options as Record<string, unknown>;
      return "thr-write";
    };
    assert.equal(
      await selectThread(
        runtime.state.get(bound.id),
        alphaWorkspace,
        alphaWorkspace,
        [],
        [],
        "write",
      ),
      "thr-write",
    );
    assert.equal(resumedLegacy, false);
    assert.ok(Array.isArray(writeOptions.dynamicTools));
    assert.deepEqual(
      (writeOptions.dynamicTools as Array<{ name: string }>).map((tool) => tool.name),
      [
        "runner",
        "service",
        "repository",
        "project_context",
        "project_history",
        "project_memory",
        "project_portal",
      ],
    );
    assert.equal(typeof writeOptions.dynamicToolHandler, "function");
    assert.equal(
      runtime.state.get(bound.id).codexThreadCapability,
      "runner-repository-project-portal-history-memory-v6",
    );
    assert.equal(runtime.state.get(bound.id).previousCodexThreadId, "thr-legacy");

    (runtime.runnerControl as unknown as {
      inspect(): Promise<{ services: Array<{ name: string }>; recent: unknown[] }>;
    }).inspect = async () => ({ services: [{ name: "web" }], recent: [] });
    (runtime as unknown as { activeByThread: Map<string, unknown> }).activeByThread.set(
      "thr-write",
      {
        access: "write",
        turnId: "turn-service-inspect",
        actorUserId: 42,
        conversation: runtime.state.get(bound.id),
        prepared: { readableRoot: alphaWorkspace },
      },
    );
    const dynamicToolHandler = writeOptions.dynamicToolHandler as (call: {
      threadId: string;
      turnId: string;
      callId: string;
      namespace: string;
      tool: string;
      arguments: Record<string, never>;
    }) => Promise<{ success: boolean; contentItems: Array<{ text: string }> }>;
    const serviceInspection = await dynamicToolHandler({
      threadId: "thr-write",
      turnId: "turn-service-inspect",
      callId: "call-service-inspect",
      namespace: "service",
      tool: "inspect",
      arguments: {},
    });
    assert.equal(serviceInspection.success, true);
    assert.match(serviceInspection.contentItems[0]?.text ?? "", /"name":"web"/);
    (runtime as unknown as { activeByThread: Map<string, unknown> }).activeByThread.delete(
      "thr-write",
    );

    await send(42, "/new", -100, "supergroup", 5);
    assert.equal(runtime.state.get(bound.id).codexThreadId, null);
    assert.equal(runtime.state.get(bound.id).readOnlyCodexThreadId, null);

    await send(42, "/restart", 42, "private");
    assert.match(replies.at(-1) ?? "", /только администратору/);

    runtime.state.bind(-200, 9, "removed-project", "repo");
    await send(1, "/bind summing", -200, "supergroup", 9);
    assert.equal(runtime.state.byTopic(-200, 9)?.projectId, "summing");

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

test("explicit questions in unbound topics run without Project access", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-unbound-"));
  const staticPath = join(root, "summing");
  mkdirSync(staticPath);
  const workspace: WorkspaceConfig = { id: "repo", path: staticPath };
  const project = new ProjectConfig(
    "summing",
    "SUMMING",
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
    new Map([["summing", project]]),
  );
  const runtime = new SummingRuntime(config);
  const replies: Array<{
    chatId: number;
    text: string;
    options: { topicId?: number; replyTo?: number } | undefined;
  }> = [];
  let threadOptions: Record<string, unknown> = {};
  let turnPrompt = "";
  let unsubscribedThread = "";
  let knowledgeContextLookups = 0;
  let knowledgeContextQuery: { query: string; chatId: number } | null = null;
  config.knowledgeSync.enabled = true;
  runtime.knowledgeSync.contextForQuestion = async (query, chatId) => {
    knowledgeContextLookups += 1;
    knowledgeContextQuery = { query, chatId };
    return [
      {
        evidence: "telegram-event:321",
        text: "Исторический XSS-репорт уже закрыт без выплаты.",
      },
    ];
  };
  runtime.telegram.sendChatAction = async () => {};
  runtime.telegram.sendMessage = async (chatId, text, options) => {
    replies.push({ chatId, text, options });
    return replies.length;
  };
  runtime.codex.account = async () => ({ account: { type: "chatgpt" } });
  runtime.codex.startThread = async (_cwd, _model, options) => {
    threadOptions = options as Record<string, unknown>;
    return "thr-unbound";
  };
  Object.defineProperty(runtime.codex, "running", { configurable: true, get: () => true });
  runtime.codex.unsubscribeThread = async (threadId) => {
    unsubscribedThread = threadId;
  };
  const routeCodexEvent = (
    runtime as unknown as {
      routeCodexEvent(event: {
        method: string;
        params: Record<string, unknown>;
      }): Promise<void>;
    }
  ).routeCodexEvent.bind(runtime);
  runtime.codex.startTurn = async (_threadId, prompt) => {
    turnPrompt = prompt;
    setImmediate(() => {
      void (async () => {
        await routeCodexEvent({
          method: "item/completed",
          params: {
            threadId: "thr-unbound",
            turnId: "turn-unbound",
            item: {
              id: "commentary-1",
              type: "agentMessage",
              phase: "commentary",
              text: "Проверил контекст обсуждения.",
            },
          },
        });
        await routeCodexEvent({
          method: "item/completed",
          params: {
            threadId: "thr-unbound",
            turnId: "turn-unbound",
            item: {
              type: "agentMessage",
              phase: "final_answer",
              text: "**Короткий ответ** по обсуждению.",
            },
          },
        });
        await routeCodexEvent({
          method: "turn/completed",
          params: {
            threadId: "thr-unbound",
            turnId: "turn-unbound",
            turn: { id: "turn-unbound", status: "completed" },
          },
        });
      })();
    });
    return "turn-unbound";
  };
  const answerUnboundQuestion = (
    runtime as unknown as {
      answerUnboundQuestion(question: {
        chatId: number;
        topicId: number;
        messageId: number;
        senderId: number;
        text: string;
        hasAttachment: boolean;
        context: Array<{
          messageId: number;
          senderId: number;
          text: string;
          author?: "bot";
        }>;
      }): Promise<void>;
    }
  ).answerUnboundQuestion.bind(runtime);

  try {
    await answerUnboundQuestion({
      chatId: -500,
      topicId: 77,
      messageId: 10,
      senderId: 999,
      text: "@summing_bot, что решили?",
      hasAttachment: false,
      context: [
        { messageId: 9, senderId: 42, text: "Релиз переносим на пятницу" },
        { messageId: 8, senderId: 500, text: "Обсудили два риска", author: "bot" },
      ],
    });

    assert.deepEqual(threadOptions, {
      deniedPaths: [],
      disableEnvironments: true,
      ephemeral: true,
      networkAccess: false,
      readOnly: true,
      workspaceAccess: false,
    });
    assert.match(turnPrompt, /No Project or Workspace is bound/);
    assert.match(turnPrompt, /Релиз переносим на пятницу/);
    assert.match(turnPrompt, /"author": "bot"/);
    assert.match(turnPrompt, /что решили/);
    assert.match(turnPrompt, /Offer cautious general guidance/);
    assert.match(turnPrompt, /cannot inspect it here/);
    assert.match(turnPrompt, /Team Space knowledge base/);
    assert.match(turnPrompt, /telegram-event:321/);
    assert.match(turnPrompt, /Исторический XSS-репорт уже закрыт без выплаты/);
    assert.equal(knowledgeContextLookups, 1);
    assert.deepEqual(knowledgeContextQuery, {
      query: "@summing_bot, что решили?",
      chatId: -500,
    });
    assert.equal(unsubscribedThread, "thr-unbound");
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.chatId, -500);
    assert.deepEqual(replies[0]?.options, { topicId: 77, replyTo: 10, parseMode: "HTML" });
    assert.match(
      replies[0]?.text ?? "",
      /^<b>Короткий ответ<\/b> по обсуждению\./,
    );
    assert.match(replies[0]?.text ?? "", /Проверил контекст обсуждения\./);
    assert.match(
      replies[0]?.text ?? "",
      /<blockquote expandable><b>Ход работы · 1 сек<\/b>\nПроверил контекст обсуждения\.\n<\/blockquote>$/,
    );

    replies.length = 0;
    runtime.codex.startThread = async () => {
      throw new Error("thread/start did not preserve any runtime workspace roots");
    };
    await answerUnboundQuestion({
      chatId: -500,
      topicId: 77,
      messageId: 11,
      senderId: 999,
      text: "@summing_bot, что решили?",
      hasAttachment: false,
      context: [],
    });
    assert.deepEqual(replies, [
      {
        chatId: -500,
        text: "Не удалось ответить. Попробуйте ещё раз позже.",
        options: { topicId: 77, replyTo: 11 },
      },
    ]);
    assert.equal(knowledgeContextLookups, 1);
  } finally {
    runtime.requestStop();
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unbound questions have a bounded queue isolated from Project capacity", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-unbound-queue-"));
  const runtime = new SummingRuntime(
    new RuntimeConfig(
      join(root, "data"),
      join(root, "codex"),
      join(root, "worktrees"),
      "token",
      1,
      "codex",
      8765,
      1,
      1,
      "",
      "medium",
      true,
      new Map(),
    ),
  );
  const replies: string[] = [];
  runtime.telegram.sendMessage = async (_chatId, text) => {
    replies.push(text);
    return replies.length;
  };
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let answersStarted = 0;
  Object.assign(runtime, {
    answerUnboundQuestion: async (): Promise<void> => {
      answersStarted += 1;
      await gate;
    },
  });
  const privateRuntime = runtime as unknown as {
    startUnboundQuestion(question: {
      chatId: number;
      topicId: number;
      messageId: number;
      senderId: number;
      text: string;
      hasAttachment: boolean;
      context: [];
    }): void;
    semaphore: { run<T>(action: () => Promise<T>): Promise<T> };
    unboundProcessors: Set<Promise<void>>;
  };
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for unbound queue");
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
  };
  try {
    for (let index = 0; index < 5; index += 1) {
      privateRuntime.startUnboundQuestion({
        chatId: -500,
        topicId: 77,
        messageId: index + 1,
        senderId: 999,
        text: `Вопрос ${index}`,
        hasAttachment: false,
        context: [],
      });
    }
    await waitFor(() => answersStarted === 1 && replies.length === 1);
    assert.equal(privateRuntime.unboundProcessors.size, 4);
    assert.match(replies[0] ?? "", /несколько прямых вопросов/);

    let projectCapacityReached = false;
    await privateRuntime.semaphore.run(async () => {
      projectCapacityReached = true;
    });
    assert.equal(projectCapacityReached, true);

    release();
    await waitFor(() => privateRuntime.unboundProcessors.size === 0);
    assert.equal(answersStarted, 4);
  } finally {
    release();
    runtime.requestStop();
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stalled unbound questions time out and interrupt their Codex turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-unbound-timeout-"));
  const runtime = new SummingRuntime(
    new RuntimeConfig(
      join(root, "data"),
      join(root, "codex"),
      join(root, "worktrees"),
      "token",
      1,
      "codex",
      8765,
      1,
      1,
      "",
      "medium",
      true,
      new Map(),
    ),
  );
  const interrupted: string[] = [];
  runtime.codex.interrupt = async (threadId, turnId) => {
    interrupted.push(`${threadId}:${turnId}`);
  };
  const active = {
    threadId: "thr-stalled",
    turnId: "turn-stalled",
    status: "running",
    error: null as string | null,
    done: { promise: new Promise<void>(() => {}) },
  };
  const waitForUnboundTurn = (
    runtime as unknown as {
      waitForUnboundTurn(
        response: typeof active,
        timeoutMilliseconds: number,
      ): Promise<void>;
    }
  ).waitForUnboundTurn.bind(runtime);
  try {
    await waitForUnboundTurn(active, 5);
    assert.equal(active.status, "failed");
    assert.match(active.error ?? "", /timed out after 1s/);
    assert.deepEqual(interrupted, ["thr-stalled:turn-stalled"]);
  } finally {
    runtime.requestStop();
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
