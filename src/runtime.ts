import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Deferred, Semaphore } from "./async-primitives.js";
import {
  CodexAppServer,
  CodexProtocolError,
  type CodexEvent,
  type JsonRecord,
} from "./codex-app-server.js";
import { ConfigError, type RuntimeConfig } from "./config.js";
import { HealthServer } from "./health-server.js";
import { StateStore, type Conversation, type PendingInput } from "./state-store.js";
import {
  TelegramAPI,
  TelegramError,
  splitMessage,
  type TelegramObject,
} from "./telegram-api.js";
import {
  WorkspaceError,
  WorkspaceManager,
  type PreparedWorkspace,
} from "./workspace-manager.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

export class TelegramStream {
  readonly messageIds: number[] = [];
  private readonly rendered: string[] = [];
  text = "";
  private lastFlush = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushChain = Promise.resolve();

  constructor(
    readonly api: TelegramAPI,
    readonly chatId: number,
    readonly topicId: number,
    readonly intervalSeconds: number,
  ) {}

  async start(replyTo?: number): Promise<number> {
    const messageId = await this.api.sendMessage(this.chatId, "⚙️ Работаю…", {
      topicId: this.topicId,
      ...(replyTo ? { replyTo } : {}),
    });
    this.messageIds.push(messageId);
    this.rendered.push("⚙️ Работаю…");
    return messageId;
  }

  append(delta: string): void {
    this.text += delta;
    if (this.timer) return;
    const wait = Math.max(0, this.intervalSeconds * 1_000 - (performance.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.queueFlush("");
    }, wait);
  }

  async flush(fallback = ""): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.queueFlush(fallback);
  }

  private queueFlush(fallback: string): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.render(fallback));
    return this.flushChain;
  }

  private async render(fallback: string): Promise<void> {
    const content = this.text.trim() || fallback;
    if (!content) return;
    const chunks = splitMessage(content);
    for (const [index, chunk] of chunks.entries()) {
      const messageId = this.messageIds[index];
      if (messageId !== undefined) {
        if (this.rendered[index] !== chunk) await this.api.editMessage(this.chatId, messageId, chunk);
      } else {
        this.messageIds.push(
          await this.api.sendMessage(this.chatId, chunk, { topicId: this.topicId }),
        );
      }
      this.rendered[index] = chunk;
    }
    this.lastFlush = performance.now();
  }
}

interface ActiveRun {
  conversation: Conversation;
  threadId: string;
  runId: number;
  stream: TelegramStream;
  prepared: PreparedWorkspace;
  turnId: string | null;
  response: string;
  status: string;
  error: string | null;
  cancelRequested: boolean;
  done: Deferred<void>;
}

export class SummateRuntime {
  readonly state: StateStore;
  readonly codex: CodexAppServer;
  readonly telegram: TelegramAPI;
  readonly workspaces: WorkspaceManager;
  readonly health: HealthServer;
  private readonly shutdown = new Deferred<void>();
  private readonly shutdownController = new AbortController();
  private stopping = false;
  private exitCode = 0;
  private accountState: JsonRecord = {};
  private lastTelegramPoll: number | null = null;
  private readonly processors = new Map<string, Promise<void>>();
  private readonly activeByThread = new Map<string, ActiveRun>();
  private readonly activeByTurn = new Map<string, ActiveRun>();
  private readonly loadedThreads = new Set<string>();
  private readonly semaphore: Semaphore;

  constructor(readonly config: RuntimeConfig) {
    this.state = new StateStore(resolve(config.dataDir, "state.sqlite3"));
    this.codex = new CodexAppServer(config.codexBinary, config.codexHome);
    this.telegram = new TelegramAPI(config.telegramToken);
    this.workspaces = new WorkspaceManager(config);
    this.health = new HealthServer("127.0.0.1", config.healthPort, () => this.status());
    this.semaphore = new Semaphore(config.maxParallelConversations);
  }

  async run(): Promise<number> {
    let pollTask: Promise<void> | null = null;
    const onEvent = (event: CodexEvent): void => {
      void this.routeCodexEvent(event).catch((error) => console.error("Codex event failed", error));
    };
    this.codex.on("event", onEvent);
    try {
      mkdirSync(this.config.dataDir, { recursive: true });
      this.workspaces.initialize();
      await this.codex.start();
      this.accountState = await this.codex.account();
      const me = await this.telegram.getMe();
      console.info(`Telegram bot connected: @${String(me.username ?? "unknown")}`);
      await this.health.start();
      for (const conversation of this.state.listConversations()) {
        if (this.state.pendingAll(conversation.id).length > 0) this.startProcessor(conversation);
      }
      pollTask = this.pollTelegram();
      await this.shutdown.promise;
    } finally {
      this.stopping = true;
      this.shutdownController.abort();
      await this.telegram.close();
      await this.codex.close(this.exitCode === 99);
      for (const active of this.activeByThread.values()) {
        active.status = "interrupted";
        active.error = active.error ?? "runtime stopped";
        active.done.resolve(undefined);
      }
      if (pollTask) await Promise.allSettled([pollTask]);
      await Promise.allSettled([...this.processors.values()]);
      await this.health.close();
      this.state.close();
      this.codex.off("event", onEvent);
    }
    return this.exitCode;
  }

  requestStop(exitCode = 0): void {
    if (this.stopping) return;
    this.exitCode = exitCode;
    this.stopping = true;
    this.shutdownController.abort();
    this.shutdown.resolve(undefined);
  }

  status(): Record<string, unknown> {
    const account = record(this.accountState.account);
    return {
      ok: this.codex.running && !this.stopping,
      version: "8.0.0",
      codex_running: this.codex.running,
      auth: account?.type ?? null,
      plan: account?.planType ?? null,
      telegram_last_poll: this.lastTelegramPoll,
      ...this.state.counts(),
    };
  }

  private async pollTelegram(): Promise<void> {
    let offset = this.state.telegramOffset();
    while (!this.stopping) {
      try {
        const updates = await this.telegram.getUpdates(offset);
        this.lastTelegramPoll = Date.now() / 1000;
        for (const update of updates) {
          const nextOffset = Math.max(offset ?? 0, Number(update.update_id ?? 0) + 1);
          const message = record(update.message);
          if (message) {
            try {
              await this.handleMessage(message);
            } catch (error) {
              console.error("could not handle Telegram message", error);
              const [chatId, topicId] = this.messageLocation(message);
              try {
                await this.reply(chatId, topicId, Number(message.message_id ?? 0), `Ошибка: ${errorText(error)}`);
              } catch (replyError) {
                console.error("could not report message failure", replyError);
              }
            }
          }
          offset = nextOffset;
          this.state.setTelegramOffset(offset);
        }
      } catch (error) {
        if (this.stopping) return;
        console.error("Telegram polling failed", error);
        await sleep(3_000);
      }
    }
  }

  private messageLocation(message: TelegramObject): [number, number, number] {
    const chat = record(message.chat) ?? {};
    const sender = record(message.from) ?? {};
    return [
      Number(chat.id ?? 0),
      Number(message.message_thread_id ?? 0),
      Number(sender.id ?? 0),
    ];
  }

  private async handleMessage(message: TelegramObject): Promise<void> {
    const [chatId, topicId, senderId] = this.messageLocation(message);
    if (senderId !== this.config.telegramOwnerId || !chatId) return;
    const text = String(message.text ?? message.caption ?? "").trim();
    if (!text) return;
    const messageId = Number(message.message_id ?? 0);
    if (text.startsWith("/")) {
      const chat = record(message.chat) ?? {};
      const command = (text.split(/\s+/, 1)[0] ?? "").split("@", 1)[0]!.toLowerCase();
      if (command === "/login" && chat.type !== "private") {
        await this.reply(
          chatId,
          topicId,
          messageId,
          "Из соображений безопасности выполните /login в личном чате с ботом.",
        );
        return;
      }
      await this.handleCommand(chatId, topicId, messageId, text);
      return;
    }

    const conversation = this.state.byTopic(chatId, topicId);
    if (!conversation) {
      await this.telegram.sendMessage(
        chatId,
        "Этот топик не привязан. Используйте /projects, затем /bind <project> [workspace].",
        { topicId, replyTo: messageId },
      );
      return;
    }
    if (this.processors.has(conversation.id)) {
      const reply = record(message.reply_to_message);
      const replyId = Number(reply?.message_id ?? 0);
      const active = this.activeForConversation(conversation.id);
      const mode = replyId && active?.stream.messageIds.includes(replyId) ? "steer" : "followup";
      const inputId = this.state.enqueueInput(conversation.id, messageId, text, mode);
      if (mode === "steer" && active?.turnId) {
        const pending = this.state.pending(conversation.id, "steer");
        const latest = pending.at(-1);
        if (latest) await this.deliverSteer(active, [latest]);
      }
      console.info(`queued ${mode} input ${inputId} for ${conversation.id}`);
      return;
    }
    this.state.enqueueInput(conversation.id, messageId, text, "followup");
    this.startProcessor(conversation);
  }

  private async handleCommand(
    chatId: number,
    topicId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    const separator = text.indexOf(" ");
    const commandPart = separator < 0 ? text : text.slice(0, separator);
    const command = (commandPart.split("@", 1)[0] ?? "").toLowerCase();
    const argument = separator < 0 ? "" : text.slice(separator + 1).trim();
    const conversation = this.state.byTopic(chatId, topicId);

    if (command === "/start" || command === "/help") {
      await this.reply(
        chatId,
        topicId,
        messageId,
        "Команды: /login, /projects, /bind <project> [workspace], /status, " +
          "/steer <текст>, /cancel, /new, /remember <факт>, /review, /restart, /panic.",
      );
      return;
    }
    if (command === "/login") {
      const result = await this.codex.loginDeviceCode();
      const url = result.verificationUrl ?? "https://auth.openai.com/codex/device";
      const code = result.userCode ?? "(код не получен)";
      await this.reply(chatId, topicId, messageId, `Откройте ${String(url)}\nКод: ${String(code)}\nПосле входа используйте /status.`);
      return;
    }
    if (command === "/projects") {
      const lines = ["Проекты:"];
      for (const project of this.config.projects.values()) {
        lines.push(`- ${project.id}: ${project.name} [${[...project.workspaces.keys()].join(", ")}]`);
      }
      await this.reply(chatId, topicId, messageId, lines.join("\n"));
      return;
    }
    if (command === "/bind") {
      if (conversation && this.processors.has(conversation.id)) {
        await this.reply(chatId, topicId, messageId, "Сначала завершите текущий run командой /cancel.");
        return;
      }
      const parts = argument.split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        await this.reply(chatId, topicId, messageId, "Использование: /bind <project> [workspace]");
        return;
      }
      try {
        const project = this.config.project(parts[0]!);
        const workspace = project.workspace(parts[1] ?? "");
        const bound = this.state.bind(chatId, topicId, project.id, workspace.id);
        await this.reply(
          chatId,
          topicId,
          messageId,
          `Привязано: ${project.name} / ${workspace.id}\nconversation: ${bound.id}`,
        );
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        await this.reply(chatId, topicId, messageId, error.message);
      }
      return;
    }
    if (command === "/status") {
      this.accountState = await this.codex.account();
      const state = this.status();
      const binding = conversation ? `${conversation.projectId}/${conversation.workspaceId}` : "нет";
      await this.reply(
        chatId,
        topicId,
        messageId,
        [
          `Codex: ${state.codex_running ? "работает" : "остановлен"}`,
          `Auth: ${String(state.auth || "не выполнен")}`,
          `Plan: ${String(state.plan || "—")}`,
          `Binding: ${binding}`,
          `Active: ${String(state.active)}, pending inputs: ${String(state.pending)}`,
        ].join("\n"),
      );
      return;
    }
    if (command === "/steer") {
      if (!conversation || !argument) {
        await this.reply(chatId, topicId, messageId, "Использование: /steer <текст>");
        return;
      }
      const active = this.activeForConversation(conversation.id);
      if (!active) {
        await this.reply(chatId, topicId, messageId, "Активного run нет.");
        return;
      }
      this.state.enqueueInput(conversation.id, messageId, argument, "steer");
      if (active.turnId) await this.deliverSteer(active, this.state.pending(conversation.id, "steer"));
      return;
    }
    if (command === "/cancel") {
      if (!conversation) return;
      const active = this.activeForConversation(conversation.id);
      if (active) {
        if (active.turnId) await this.codex.interrupt(active.threadId, active.turnId);
        else active.cancelRequested = true;
        await this.reply(chatId, topicId, messageId, "Останавливаю текущий run.");
      } else if (this.processors.has(conversation.id)) {
        const queued = this.state.pendingAll(conversation.id);
        this.state.consume(queued.map((item) => item.id));
        await this.reply(chatId, topicId, messageId, "Run удалён из очереди.");
      } else {
        await this.reply(chatId, topicId, messageId, "Активного run нет.");
      }
      return;
    }
    if (command === "/new") {
      if (!conversation) return;
      if (this.processors.has(conversation.id)) {
        await this.reply(chatId, topicId, messageId, "Сначала завершите /cancel.");
        return;
      }
      this.state.setThread(conversation.id, null);
      await this.reply(chatId, topicId, messageId, "Начат новый контекст topic.");
      return;
    }
    if (command === "/remember") {
      if (!conversation || !argument) {
        await this.reply(chatId, topicId, messageId, "Использование: /remember <факт>");
        return;
      }
      appendFileSync(this.workspaces.projectMemoryPath(conversation.projectId), `\n- ${argument}\n`, "utf8");
      await this.reply(chatId, topicId, messageId, "Сохранено в памяти проекта.");
      return;
    }
    if (command === "/review") {
      if (!conversation) return;
      if (this.processors.has(conversation.id)) {
        await this.reply(chatId, topicId, messageId, "В topic уже идёт run.");
        return;
      }
      this.state.enqueueInput(
        conversation.id,
        messageId,
        "Review the current uncommitted changes. Report only actionable findings, " +
          "then give a concise verdict. Do not modify files.",
        "followup",
      );
      this.startProcessor(conversation);
      return;
    }
    if (command === "/restart") {
      await this.reply(chatId, topicId, messageId, "Перезапускаюсь.");
      this.requestStop(42);
      return;
    }
    if (command === "/panic") {
      console.warn("Panic Stop requested by owner");
      this.requestStop(99);
      return;
    }
    await this.reply(chatId, topicId, messageId, "Неизвестная команда. /help");
  }

  private async reply(chatId: number, topicId: number, messageId: number, text: string): Promise<void> {
    await this.telegram.sendMessage(chatId, text, { topicId, replyTo: messageId });
  }

  private startProcessor(conversation: Conversation): void {
    if (this.processors.has(conversation.id)) return;
    const processor = this.semaphore
      .run(() => this.conversationLoop(conversation.id))
      .catch((error) => console.error(`conversation processor failed: ${conversation.id}`, error))
      .finally(() => this.processors.delete(conversation.id));
    this.processors.set(conversation.id, processor);
  }

  private async conversationLoop(conversationId: string): Promise<void> {
    while (!this.stopping) {
      const queued = this.state.pendingAll(conversationId);
      if (queued.length === 0) return;
      const last = queued.at(-1)!;
      await this.executeRun(
        conversationId,
        queued.length === 1 ? queued[0]!.text : this.coalesce(queued),
        last.telegramMessageId,
        queued.map((item) => item.id),
      );
    }
  }

  private coalesce(items: PendingInput[]): string {
    const body = items.map((item, index) => `${index + 1}. ${item.text}`).join("\n");
    return `Messages received while the previous run was active:\n\n${body}`;
  }

  private async executeRun(
    conversationId: string,
    prompt: string,
    replyTo: number,
    inputIds: number[],
  ): Promise<void> {
    let conversation = this.state.get(conversationId);
    const project = this.config.project(conversation.projectId);
    const workspace = project.workspace(conversation.workspaceId);
    const stream = new TelegramStream(
      this.telegram,
      conversation.chatId,
      conversation.topicId,
      this.config.streamIntervalSec,
    );
    let runId: number | null = null;
    try {
      runId = this.state.startRun(conversation.id, prompt, inputIds);
      const account = await this.codex.account();
      this.accountState = account;
      if (!record(account.account)) {
        this.state.finishRun(runId, "failed", "", "Codex is not authenticated");
        await this.reply(
          conversation.chatId,
          conversation.topicId,
          replyTo,
          "Codex не авторизован. Выполните /login.",
        );
        return;
      }
      const prepared = await this.workspaces.prepare(
        conversation,
        project,
        workspace,
        this.shutdownController.signal,
      );
      this.state.setWorktree(conversation.id, prepared.path);
      conversation = this.state.get(conversation.id);
      const threadId = await this.thread(conversation, prepared.path);
      const streamMessageId = await stream.start(replyTo);
      this.state.setActive(conversation.id, "starting", streamMessageId);
      const active: ActiveRun = {
        conversation,
        threadId,
        runId,
        stream,
        prepared,
        turnId: null,
        response: "",
        status: "running",
        error: null,
        cancelRequested: false,
        done: new Deferred<void>(),
      };
      this.activeByThread.set(threadId, active);
      const turnId = await this.codex.startTurn(
        threadId,
        `Before acting, read \`.summate-runtime/CONTEXT.md\`.\n\n${prompt}`,
        prepared.path,
        {
          model: this.config.model,
          effort: this.config.effort,
          networkAccess: this.config.networkAccess,
        },
      );
      active.turnId = turnId;
      this.activeByTurn.set(turnId, active);
      this.state.attachTurn(runId, turnId);
      this.state.setActive(conversation.id, turnId, streamMessageId);
      if (active.cancelRequested) await this.codex.interrupt(active.threadId, turnId);
      else await this.deliverSteer(active, this.state.pending(conversation.id, "steer"));
      await active.done.promise;
      const fallback =
        active.status === "completed"
          ? "Готово."
          : `Run ${active.status}: ${active.error || "без подробностей"}`;
      await stream.flush(fallback);
      this.state.finishRun(runId, active.status, active.response, active.error);
      const conflict = await this.workspaces.mergeProjectMemory(project.id, prepared);
      if (conflict) {
        await this.telegram.sendMessage(conversation.chatId, `⚠️ Конфликт памяти сохранён: ${conflict}`, {
          topicId: conversation.topicId,
        });
      }
    } catch (error) {
      console.error(`conversation run failed: ${conversationId}`, error);
      if (runId !== null) this.state.finishRun(runId, this.stopping ? "interrupted" : "failed", stream.text, errorText(error));
      if (!this.stopping) {
        try {
          await stream.flush(`Ошибка: ${errorText(error)}`);
        } catch (reportError) {
          console.error("could not report run failure to Telegram", reportError);
        }
      }
    } finally {
      const active = this.activeForConversation(conversationId);
      if (active) {
        this.activeByThread.delete(active.threadId);
        if (active.turnId) this.activeByTurn.delete(active.turnId);
      }
      this.state.clearActive(conversationId);
    }
  }

  private async thread(conversation: Conversation, cwd: string): Promise<string> {
    if (conversation.codexThreadId) {
      if (!this.loadedThreads.has(conversation.codexThreadId)) {
        try {
          await this.codex.resumeThread(conversation.codexThreadId, cwd);
        } catch (error) {
          if (!(error instanceof CodexProtocolError)) throw error;
          console.warn(`could not resume ${conversation.codexThreadId}; starting a new Codex thread`);
          const threadId = await this.codex.startThread(cwd, this.config.model);
          this.state.setThread(conversation.id, threadId);
          this.loadedThreads.add(threadId);
          return threadId;
        }
        this.loadedThreads.add(conversation.codexThreadId);
      }
      return conversation.codexThreadId;
    }
    const threadId = await this.codex.startThread(cwd, this.config.model);
    this.state.setThread(conversation.id, threadId);
    this.loadedThreads.add(threadId);
    return threadId;
  }

  private async deliverSteer(active: ActiveRun, items: PendingInput[]): Promise<void> {
    if (!active.turnId) return;
    for (const item of items) {
      try {
        await this.codex.steer(active.threadId, active.turnId, item.text);
        this.state.consume([item.id]);
      } catch (error) {
        if (!(error instanceof CodexProtocolError)) throw error;
        console.warn("steer failed; keeping input for follow-up", error);
      }
    }
  }

  private activeForConversation(conversationId: string): ActiveRun | null {
    for (const active of this.activeByThread.values()) {
      if (active.conversation.id === conversationId) return active;
    }
    return null;
  }

  private async routeCodexEvent(event: CodexEvent): Promise<void> {
    if (event.method === "server/exited") {
      for (const active of this.activeByThread.values()) {
        active.status = "failed";
        active.error = "Codex App Server exited";
        active.done.resolve(undefined);
      }
      this.requestStop(1);
      return;
    }
    if (event.method === "account/updated" || event.method === "account/login/completed") {
      try {
        this.accountState = await this.codex.account();
      } catch {
        // The next /status or run refreshes account state.
      }
      return;
    }
    const active = this.activeForEvent(event);
    if (!active) return;
    if (event.method === "item/agentMessage/delta") {
      if (typeof event.params.delta === "string") {
        active.response += event.params.delta;
        active.stream.append(event.params.delta);
      }
    } else if (event.method === "item/completed") {
      const item = record(event.params.item);
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer" || item.phase === undefined || item.phase === null) {
          active.response = item.text;
          active.stream.text = item.text;
        }
      }
    } else if (event.method === "error") {
      const error = record(event.params.error);
      active.error = error ? String(error.message ?? JSON.stringify(error)) : String(event.params.error ?? "unknown Codex error");
    } else if (event.method === "turn/completed") {
      const turn = record(event.params.turn);
      if (turn) {
        active.status = String(turn.status ?? "failed");
        const error = record(turn.error);
        if (error && !active.error) active.error = String(error.message ?? JSON.stringify(error));
      } else {
        active.status = "failed";
        active.error ||= "malformed turn/completed event";
      }
      active.done.resolve(undefined);
    }
  }

  private activeForEvent(event: CodexEvent): ActiveRun | null {
    const threadId = event.params.threadId;
    if (typeof threadId === "string") {
      const active = this.activeByThread.get(threadId);
      if (active) return active;
    }
    let turnId = event.params.turnId;
    const turn = record(event.params.turn);
    if (!turnId && turn) turnId = turn.id;
    return typeof turnId === "string" ? (this.activeByTurn.get(turnId) ?? null) : null;
  }
}

export { ConfigError, CodexProtocolError, TelegramError, WorkspaceError };
