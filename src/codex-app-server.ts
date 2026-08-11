import { EventEmitter, once } from "node:events";
import { mkdirSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type JsonRecord = Record<string, unknown>;

export interface CodexEvent {
  method: string;
  params: JsonRecord;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcMessage extends JsonRecord {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export class CodexProtocolError extends Error {}

export class CodexAppServer extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(
    readonly binary: string,
    readonly codexHome: string,
  ) {
    super();
  }

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    mkdirSync(this.codexHome, { recursive: true });
    this.closed = false;
    try {
      this.process = spawn(this.binary, ["app-server"], {
        env: { ...process.env, CODEX_HOME: this.codexHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
      await Promise.race([
        once(this.process, "spawn"),
        once(this.process, "error").then(([error]) => Promise.reject(error)),
      ]);
    } catch (error) {
      this.process = null;
      throw new CodexProtocolError(
        `Codex executable not found: '${this.binary}'; install Codex CLI (${String(error)})`,
      );
    }
    this.readStdout(this.process);
    this.readStderr(this.process);
    this.process.once("close", () => this.handleExit());
    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "summate_telegram",
          title: "Summate Telegram",
          version: "8.0.0",
        },
      },
      30_000,
    );
    await this.notify("initialized", {});
  }

  async close(force = false): Promise<void> {
    this.closed = true;
    const child = this.process;
    if (child && child.exitCode === null) {
      child.kill(force ? "SIGKILL" : "SIGTERM");
      const exited = once(child, "close");
      const timeout = new Promise<"timeout">((resolveTimeout) => {
        setTimeout(() => resolveTimeout("timeout"), 10_000).unref();
      });
      if ((await Promise.race([exited, timeout])) === "timeout" && child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "close");
      }
    }
    this.rejectPending(new CodexProtocolError("Codex App Server stopped"));
    this.process = null;
  }

  async request(method: string, params: JsonRecord = {}, timeoutMs = 60_000): Promise<unknown> {
    if (!this.running) throw new CodexProtocolError("Codex App Server is not running");
    const id = this.nextId++;
    const result = new Promise<unknown>((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexProtocolError(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
    });
    try {
      await this.send({ method, id, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result;
  }

  async notify(method: string, params: JsonRecord = {}): Promise<void> {
    await this.send({ method, params });
  }

  private async send(payload: RpcMessage): Promise<void> {
    const child = this.process;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      throw new CodexProtocolError("Codex App Server stdin is unavailable");
    }
    const line = `${JSON.stringify(payload)}\n`;
    if (!child.stdin.write(line, "utf8")) await once(child.stdin, "drain");
  }

  private readStdout(child: ChildProcessWithoutNullStreams): void {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        console.warn(`codex emitted non-JSON stdout: ${line.slice(0, 500)}`);
        return;
      }
      void this.dispatch(message).catch((error) => {
        console.error("Codex message dispatch failed", error);
      });
    });
  }

  private readStderr(child: ChildProcessWithoutNullStreams): void {
    const lines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    lines.on("line", (line) => console.error(`codex: ${line}`));
  }

  private async dispatch(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as RpcMessage;
    if (message.method && message.id !== undefined) {
      await this.answerServerRequest(message.id, message.method);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined && message.error !== null) {
        const detail = this.errorDetail(message.error);
        pending.reject(new CodexProtocolError(detail));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      const params = this.record(message.params);
      this.emit("event", { method: message.method, params } satisfies CodexEvent);
    }
  }

  private async answerServerRequest(id: number, method: string): Promise<void> {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      await this.send({ id, result: { decision: "decline" } });
      console.warn(`declined unexpected Codex approval request: ${method}`);
      return;
    }
    if (method === "item/permissions/requestApproval") {
      await this.send({ id, result: { permissions: {} } });
      console.warn("declined unexpected Codex permission request");
      return;
    }
    if (method === "applyPatchApproval" || method === "execCommandApproval") {
      await this.send({
        id,
        result: { decision: { denied: { rejection: "no interactive approval channel" } } },
      });
      console.warn(`declined legacy Codex approval request: ${method}`);
      return;
    }
    await this.send({
      id,
      error: { code: -32601, message: `unsupported server request: ${method}` },
    });
  }

  private handleExit(): void {
    this.rejectPending(new CodexProtocolError("Codex App Server exited unexpectedly"));
    this.process = null;
    if (!this.closed) this.emit("event", { method: "server/exited", params: {} } satisfies CodexEvent);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private record(value: unknown): JsonRecord {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonRecord)
      : {};
  }

  private errorDetail(value: unknown): string {
    const error = this.record(value);
    return typeof error.message === "string" ? error.message : JSON.stringify(value);
  }

  async account(refresh = false): Promise<JsonRecord> {
    return this.record(await this.request("account/read", { refreshToken: refresh }, 30_000));
  }

  async loginDeviceCode(): Promise<JsonRecord> {
    return this.record(
      await this.request("account/login/start", { type: "chatgptDeviceCode" }, 30_000),
    );
  }

  async startThread(cwd: string, model = ""): Promise<string> {
    const params: JsonRecord = {
      cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "summate_telegram",
    };
    if (model) params.model = model;
    const result = this.record(await this.request("thread/start", params));
    const thread = this.record(result.thread);
    if (typeof thread.id !== "string") {
      throw new CodexProtocolError("thread/start did not return a thread id");
    }
    return thread.id;
  }

  async resumeThread(threadId: string, cwd: string): Promise<void> {
    await this.request("thread/resume", { threadId, cwd });
  }

  async startTurn(
    threadId: string,
    prompt: string,
    cwd: string,
    options: { model?: string; effort?: string; networkAccess?: boolean } = {},
  ): Promise<string> {
    const params: JsonRecord = {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: options.networkAccess ?? true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      effort: options.effort ?? "medium",
      summary: "concise",
    };
    if (options.model) params.model = options.model;
    const result = this.record(await this.request("turn/start", params));
    const turn = this.record(result.turn);
    if (typeof turn.id !== "string") {
      throw new CodexProtocolError("turn/start did not return a turn id");
    }
    return turn.id;
  }

  async steer(threadId: string, turnId: string, text: string): Promise<void> {
    await this.request(
      "turn/steer",
      {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text }],
      },
      30_000,
    );
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId }, 30_000);
  }
}
