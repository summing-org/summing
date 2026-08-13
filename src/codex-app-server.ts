import { EventEmitter, once } from "node:events";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parse } from "smol-toml";

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

const PROJECT_PERMISSION_PROFILE = "summing-project";
const READ_ONLY_PERMISSION_PROFILE = "summing-project-readonly";

function executableReadRoot(command: string): string | null {
  const candidates = command.includes("/")
    ? [resolve(command)]
    : (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return dirname(realpathSync(candidate));
    } catch {
      // Try the next PATH entry. start() reports a clear error if none can run.
    }
  }
  return null;
}

interface WorkspacePermissionOptions {
  deniedPaths?: string[];
  gitMetadataRoots?: string[];
  networkAccess?: boolean;
  readableRoots?: string[];
  readOnly?: boolean;
}

export class CodexAppServer extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private readonly binaryReadRoot: string | null;

  constructor(
    readonly binary: string,
    readonly codexHome: string,
  ) {
    super();
    this.binaryReadRoot = executableReadRoot(binary);
  }

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    mkdirSync(this.codexHome, { recursive: true });
    this.assertSafeCodexHomeConfig();
    this.closed = false;
    try {
      this.process = spawn(this.binary, ["app-server"], {
        env: this.appServerEnvironment(),
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
          name: "summing_telegram",
          title: "SUMMING Telegram",
          version: "9.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
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
      await this.send({ id, result: { permissions: {}, scope: "turn" } });
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

  async rateLimits(): Promise<JsonRecord> {
    return this.record(await this.request("account/rateLimits/read", {}, 30_000));
  }

  async startThread(
    cwd: string,
    model = "",
    options: WorkspacePermissionOptions = {},
  ): Promise<string> {
    const permissionProfile = options.readOnly
      ? READ_ONLY_PERMISSION_PROFILE
      : PROJECT_PERMISSION_PROFILE;
    const params: JsonRecord = {
      cwd,
      runtimeWorkspaceRoots: options.readableRoots ?? [cwd],
      approvalPolicy: "never",
      permissions: permissionProfile,
      config: this.permissionConfig(cwd, options),
      serviceName: "summing_telegram",
      dynamicTools: [],
      selectedCapabilityRoots: [],
    };
    if (model) params.model = model;
    const result = this.record(await this.request("thread/start", params));
    const thread = this.record(result.thread);
    if (typeof thread.id !== "string") {
      throw new CodexProtocolError("thread/start did not return a thread id");
    }
    if (
      !Array.isArray(result.runtimeWorkspaceRoots) ||
      result.runtimeWorkspaceRoots.length === 0
    ) {
      throw new CodexProtocolError(
        "thread/start did not preserve any runtime workspace roots",
      );
    }
    return thread.id;
  }

  async resumeThread(
    threadId: string,
    cwd: string,
    options: WorkspacePermissionOptions = {},
  ): Promise<void> {
    const permissionProfile = options.readOnly
      ? READ_ONLY_PERMISSION_PROFILE
      : PROJECT_PERMISSION_PROFILE;
    await this.request("thread/resume", {
      threadId,
      cwd,
      runtimeWorkspaceRoots: options.readableRoots ?? [cwd],
      approvalPolicy: "never",
      permissions: permissionProfile,
      config: this.permissionConfig(cwd, options),
    });
  }

  async startTurn(
    threadId: string,
    prompt: string,
    cwd: string,
    options: {
      model?: string;
      effort?: string;
      networkAccess?: boolean;
      outputSchema?: JsonRecord;
      readableRoots?: string[];
    } = {},
  ): Promise<string> {
    const params: JsonRecord = {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd,
      runtimeWorkspaceRoots: options.readableRoots ?? [cwd],
      approvalPolicy: "never",
      effort: options.effort ?? "medium",
      summary: "concise",
    };
    if (options.model) params.model = options.model;
    if (options.outputSchema) params.outputSchema = options.outputSchema;
    const result = this.record(await this.request("turn/start", params));
    const turn = this.record(result.turn);
    if (typeof turn.id !== "string") {
      throw new CodexProtocolError("turn/start did not return a turn id");
    }
    return turn.id;
  }

  private permissionConfig(cwd: string, options: WorkspacePermissionOptions): JsonRecord {
    const readableRoot = resolve(options.readableRoots?.[0] ?? cwd);
    const writableSubpath = relative(readableRoot, resolve(cwd)) || ".";
    if (writableSubpath === ".." || writableSubpath.startsWith("../")) {
      throw new CodexProtocolError(
        `Codex cwd must be inside its readable project root: ${cwd} is outside ${readableRoot}`,
      );
    }
    const runtimeSubpath =
      writableSubpath === "."
        ? ".summing-runtime"
        : `${writableSubpath}/.summing-runtime`;
    const runtimeTempPath = resolve(cwd, ".summing-runtime", "tmp");
    const runtimeAttachmentsSubpath = `${runtimeSubpath}/attachments`;
    const workspaceRoots: JsonRecord = { ".": "read" };
    if (!options.readOnly) {
      workspaceRoots[writableSubpath] = "write";
      workspaceRoots[".git"] = "read";
      workspaceRoots[runtimeSubpath] = "read";
      // Keep write grants directory-scoped: older App Server builds probe writable
      // paths for project metadata and cannot probe through a regular file.
      workspaceRoots[`${runtimeSubpath}/memory`] = "write";
      workspaceRoots[`${runtimeSubpath}/tmp`] = "write";
      workspaceRoots[runtimeAttachmentsSubpath] = "read";
    } else {
      workspaceRoots[".git"] = "deny";
      workspaceRoots[runtimeSubpath] = "deny";
      workspaceRoots[runtimeAttachmentsSubpath] = "read";
      for (const deniedPath of options.deniedPaths ?? []) {
        if (
          deniedPath &&
          deniedPath !== "." &&
          deniedPath !== ".." &&
          !deniedPath.startsWith("../") &&
          !deniedPath.startsWith("/")
        ) {
          workspaceRoots[deniedPath] = "deny";
        }
      }
    }
    const projects: JsonRecord = {};
    for (const root of new Set([readableRoot, resolve(cwd)])) {
      projects[root] = { trust_level: "untrusted" };
    }
    const permissionProfile = options.readOnly
      ? READ_ONLY_PERMISSION_PROFILE
      : PROJECT_PERMISSION_PROFILE;
    const network = !options.readOnly && (options.networkAccess ?? true);
    const filesystem: JsonRecord = {
      ":minimal": "read",
      ":workspace_roots": workspaceRoots,
    };
    // Standalone installs resolve /usr/local/bin/codex into a versioned release
    // under CODEX_HOME. Codex re-executes that binary when it launches a Linux
    // sandbox command, so the containing bin directory must remain readable
    // inside restricted permission profiles.
    if (this.binaryReadRoot) filesystem[this.binaryReadRoot] = "read";
    if (!options.readOnly) {
      for (const gitMetadataRoot of options.gitMetadataRoots ?? []) {
        filesystem[resolve(gitMetadataRoot)] = "write";
      }
    }
    const shellEnvironment: JsonRecord = {
      LANG: process.env.LANG ?? "C.UTF-8",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    };
    if (!options.readOnly) {
      shellEnvironment.TMPDIR = runtimeTempPath;
      shellEnvironment.TMP = runtimeTempPath;
      shellEnvironment.TEMP = runtimeTempPath;
    }
    const config: JsonRecord = {
      default_permissions: permissionProfile,
      permissions: {
        [permissionProfile]: {
          description: options.readOnly
            ? "Read project files without writes or network access"
            : "Write the active project worktree and read only its project root",
          filesystem,
          network: network
            ? { enabled: true, domains: { "*": "allow" } }
            : { enabled: false },
        },
      },
      shell_environment_policy: {
        inherit: "none",
        set: shellEnvironment,
      },
      projects,
      features: {
        apps: false,
        browser_use: false,
        browser_use_external: false,
        browser_use_full_cdp_access: false,
        computer_use: false,
        hooks: false,
        image_generation: false,
        in_app_browser: false,
        memories: false,
        plugins: false,
        remote_plugin: false,
        multi_agent: false,
        skill_search: false,
        skill_mcp_dependency_install: false,
        workspace_dependencies: false,
      },
    };
    if (options.readOnly) config.web_search = "disabled";
    return config;
  }

  private assertSafeCodexHomeConfig(): void {
    const configPath = resolve(this.codexHome, "config.toml");
    if (!existsSync(configPath)) return;
    let config: JsonRecord;
    try {
      config = parse(readFileSync(configPath, "utf8")) as JsonRecord;
    } catch (error) {
      throw new CodexProtocolError(`cannot parse ${configPath}: ${String(error)}`);
    }
    for (const key of [
      "mcp_servers",
      "hooks",
      "sandbox_mode",
      "sandbox_workspace_write",
      "default_permissions",
      "permissions",
    ]) {
      const value = config[key];
      const configured =
        typeof value === "string"
          ? value.length > 0
          : value !== null && typeof value === "object" && !Array.isArray(value)
            ? Object.keys(value).length > 0
            : value !== undefined;
      if (configured) {
        throw new CodexProtocolError(
          `SUMMING CODEX_HOME must not define ${key}; use a dedicated auth-only CODEX_HOME`,
        );
      }
    }
  }

  private appServerEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { CODEX_HOME: this.codexHome };
    for (const key of [
      "HOME",
      "USER",
      "LOGNAME",
      "PATH",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ]) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    return environment;
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
