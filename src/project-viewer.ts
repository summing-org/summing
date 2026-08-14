import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ConfigError, type RuntimeConfig } from "./config.js";
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from "./admin-assets.js";
import {
  DeploymentController,
  DeploymentControllerError,
  type DeploymentControl,
} from "./deployment-controller.js";
import {
  GitInspector,
  GitInspectorError,
  type RepositoryAccessVerification,
  type RepositorySyncStatus,
} from "./git-inspector.js";
import { ProjectCatalogError, type ProjectCatalog } from "./project-catalog.js";
import {
  ProjectRunnerClient,
  ProjectRunnerClientError,
  type RunnerAction,
} from "./project-runner-client.js";
import { RunArtifactStore } from "./run-artifacts.js";
import {
  type ManagedRepositoryCredential,
  type RepositoryAuditEntry,
  type RepositoryDiagnosticCode,
  type RepositoryExperienceState,
  type RepositoryRotationCandidate,
  type RepositoryVerificationRecord,
  RepositoryCredentialStore,
} from "./repository-credentials.js";
import type { Conversation, StateStore } from "./state-store.js";
import { ViewerAuthenticator, ViewerAuthError } from "./viewer-auth.js";
import { VIEWER_CSS, VIEWER_HTML, VIEWER_JS, VIEWER_LOGO_SVG } from "./viewer-assets.js";

interface ViewerScope {
  conversation: Conversation;
  inspector: GitInspector;
  project: { id: string; name: string; workspace: string };
}

interface ViewerRepositoryConnection {
  mode: "none" | "external" | "managed-ssh";
  publicKey: string;
  fingerprint: string;
  canCreateDeployKey: boolean;
  hostKeyPolicy: "" | "trust-on-first-use";
  rotation: {
    publicKey: string;
    fingerprint: string;
    preparedAt: string;
  } | null;
}

const REPOSITORY_ACTIONS = new Set([
  "pull",
  "push",
  "connect",
  "verify",
  "migrate-legacy",
  "preview-origin",
  "change-origin",
  "rollback-origin",
  "prepare-rotation",
  "verify-rotation",
  "activate-rotation",
  "cancel-rotation",
]);

class ViewerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-src blob:; " +
    "base-uri 'none'; frame-ancestors 'self' https://*.telegram.org",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function asset(response: ServerResponse, contentType: string, value: string): void {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "content-length": Buffer.byteLength(value),
    "cache-control": "no-cache",
  });
  response.end(value);
}

function queryValue(url: URL, name: string): string {
  return url.searchParams.get(name)?.trim() ?? "";
}

async function requestBody(request: IncomingMessage, maximumBytes = 16_384): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new ViewerHttpError(413, "request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new ViewerHttpError(400, "request body must be JSON");
  }
}

export class ProjectViewerServer {
  private server: Server | null = null;
  private readonly repositoryOperations = new Set<string>();
  private readonly projectOperations = new Set<string>();
  readonly auth: ViewerAuthenticator;
  readonly artifacts: RunArtifactStore;
  readonly runner: ProjectRunnerClient;
  readonly deployment: DeploymentControl;
  readonly repositoryCredentials: RepositoryCredentialStore;

  constructor(
    readonly config: RuntimeConfig,
    readonly state: StateStore,
    readonly projects: ProjectCatalog,
    deployment?: DeploymentControl,
    readonly bindingBusy: (conversation: Conversation) => boolean = () => false,
    readonly afterTopicBound: (chatId: number, topicId: number) => void = () => {},
  ) {
    this.auth = new ViewerAuthenticator(
      config.telegramToken,
      config.viewerAuthMaxAgeSeconds,
      config.viewerLocalToken,
    );
    this.artifacts = new RunArtifactStore(config.dataDir);
    this.runner = new ProjectRunnerClient(config.runnerSocket);
    this.repositoryCredentials = new RepositoryCredentialStore(config.dataDir);
    this.deployment = deployment ?? new DeploymentController(
      config.deploymentRequestPath,
      config.deploymentStatePath,
    );
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => this.report(response, error));
    });
    await new Promise<void>((resolveStart, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.viewerPort, "127.0.0.1", () => {
        this.server!.off("error", reject);
        resolveStart();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://viewer.local");
    if (
      request.method === "GET" &&
      (url.pathname === "/admin" ||
        url.pathname === "/admin/" ||
        url.pathname === "/admin/index.html")
    ) {
      asset(response, "text/html; charset=utf-8", ADMIN_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin.css") {
      asset(response, "text/css; charset=utf-8", ADMIN_CSS);
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin.js") {
      asset(response, "text/javascript; charset=utf-8", ADMIN_JS);
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      asset(response, "text/html; charset=utf-8", VIEWER_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/app.css") {
      asset(response, "text/css; charset=utf-8", VIEWER_CSS);
      return;
    }
    if (request.method === "GET" && url.pathname === "/app.js") {
      asset(response, "text/javascript; charset=utf-8", VIEWER_JS);
      return;
    }
    if (request.method === "GET" && url.pathname === "/logo.svg") {
      asset(response, "image/svg+xml; charset=utf-8", VIEWER_LOGO_SVG);
      return;
    }
    if (!url.pathname.startsWith("/api/viewer/")) throw new ViewerHttpError(404, "not found");

    const telegramUser = this.auth.authenticate(
      request.headers as Record<string, string | string[] | undefined>,
    );
    if (request.method === "GET" && url.pathname === "/api/viewer/admin") {
      this.requireAdminAccess(telegramUser);
      json(response, 200, this.adminOverview());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/admin/users") {
      this.requireAdminAccess(telegramUser);
      const rawChatId = url.searchParams.get("chatId") ?? "";
      const chatId = Number(rawChatId);
      if (!rawChatId || !Number.isSafeInteger(chatId) || chatId === 0) {
        throw new ViewerHttpError(400, "некорректный chatId");
      }
      const chat = this.state.telegramChat(chatId);
      if (!chat) throw new ViewerHttpError(404, "Telegram-группа ещё не обнаружена SUMMING");
      const rawTopicId = url.searchParams.get("topicId");
      if (rawTopicId === null) {
        json(response, 200, {
          scope: "chat",
          chat: { chatId: chat.chatId, title: chat.title, username: chat.username },
          users: this.state.listTelegramChatUsers(chatId),
        });
        return;
      }
      const topicId = Number(rawTopicId);
      if (!rawTopicId || !Number.isSafeInteger(topicId) || topicId < 0) {
        throw new ViewerHttpError(400, "некорректный topicId");
      }
      const topic = this.state.telegramTopic(chatId, topicId);
      if (!topic) throw new ViewerHttpError(404, "Telegram-топик ещё не обнаружен SUMMING");
      json(response, 200, {
        scope: "topic",
        chat: { chatId: chat.chatId, title: chat.title, username: chat.username },
        topic: { topicId: topic.topicId, name: topic.name },
        users: this.state.listTelegramTopicUsers(chatId, topicId),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/admin/projects") {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      const mode = String(body?.mode ?? "");
      const projectId = String(body?.projectId ?? "").trim().toLowerCase();
      if (mode !== "empty" && mode !== "clone") {
        throw new ViewerHttpError(400, "выберите создание или клонирование проекта");
      }
      if (!projectId) throw new ViewerHttpError(400, "projectId is required");
      if (this.projectOperations.has(projectId)) {
        throw new ViewerHttpError(409, `проект '${projectId}' уже создаётся`);
      }
      this.projectOperations.add(projectId);
      try {
        const project = mode === "clone"
          ? await this.projects.cloneRemote(
            body?.projectId,
            body?.ownerId,
            body?.workspaceId,
            String(body?.remoteUrl ?? ""),
          )
          : await this.projects.createLocal(body?.projectId, body?.ownerId, body?.workspaceId);
        json(response, 201, {
          project: {
            id: project.id,
            name: project.name,
            defaultWorkspaceId: project.defaultWorkspace,
            workspaces: [...project.workspaces.values()].map((workspace) => ({ id: workspace.id })),
          },
        });
      } finally {
        this.projectOperations.delete(projectId);
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/admin/bindings") {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      const chatId = Number(body?.chatId);
      const topicId = Number(body?.topicId);
      if (!Number.isSafeInteger(chatId) || chatId === 0) {
        throw new ViewerHttpError(400, "некорректный chatId");
      }
      if (!Number.isSafeInteger(topicId) || topicId < 0) {
        throw new ViewerHttpError(400, "некорректный topicId");
      }
      const chat = this.state.telegramChat(chatId);
      const topic = this.state.telegramTopic(chatId, topicId);
      if (!chat || !topic) {
        throw new ViewerHttpError(404, "Telegram-топик ещё не обнаружен SUMMING");
      }
      if (chat.type !== "supergroup") {
        throw new ViewerHttpError(409, "привязать можно только топик Telegram supergroup");
      }
      if (["left", "kicked"].includes(chat.botStatus)) {
        throw new ViewerHttpError(409, "бот больше не состоит в выбранной группе");
      }
      const project = this.projects.project(body?.projectId as string);
      const workspace = project.workspace(String(body?.workspaceId ?? ""));
      const current = this.state.byTopic(chatId, topicId);
      if (current?.projectId === project.id && current.workspaceId === workspace.id) {
        json(response, 200, { conversation: current });
        return;
      }
      if (
        current &&
        (current.activeTurnId !== null ||
          this.state.pendingAll(current.id).length > 0 ||
          this.bindingBusy(current))
      ) {
        throw new ViewerHttpError(
          409,
          "в выбранном топике есть активная или ожидающая задача; сначала отмените её",
        );
      }
      const conversation = this.state.bind(chatId, topicId, project.id, workspace.id);
      this.afterTopicBound(chatId, topicId);
      json(response, 200, { conversation });
      return;
    }
    const conversationId =
      request.method === "POST"
        ? ""
        : queryValue(url, "conversation");

    if (request.method === "GET" && url.pathname === "/api/viewer/session") {
      const scope = await this.scope(conversationId, telegramUser);
      json(response, 200, {
        conversation: scope.conversation.id,
        project: scope.project,
        repository: await scope.inspector.summary(),
        runnerAvailable: await this.runner.available(),
        administrator: this.isAdministrator(telegramUser),
        deploymentAvailable: this.isAdministrator(telegramUser) && this.deployment.available,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/environment") {
      const scope = await this.scope(conversationId, telegramUser);
      this.requireEnvironmentAdministrator(telegramUser);
      json(response, 200, {
        environment: await this.runner.environment(scope.project.id, scope.project.workspace),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/repository") {
      const scope = await this.scope(conversationId, telegramUser);
      const activeRun = this.state.get(scope.conversation.id).activeTurnId !== null;
      const operationKey = await scope.inspector.commonDirectory();
      const payload = await this.withRepositoryOperation(operationKey, async () => {
        const context = await this.repositoryContext(scope);
        const repository = await context.inspector.repositoryStatus(!activeRun);
        return this.repositoryPayload(scope, repository, context, activeRun);
      });
      json(response, 200, payload);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/repository") {
      const body = await requestBody(request) as Record<string, unknown> | null;
      const requestedConversation = String(body?.conversation ?? "");
      const action = String(body?.action ?? "");
      if (!REPOSITORY_ACTIONS.has(action)) {
        throw new ViewerHttpError(400, "неизвестное действие с репозиторием");
      }
      const scope = await this.scope(requestedConversation, telegramUser);
      const operationKey = await scope.inspector.commonDirectory();
      const result = await this.withRepositoryOperation(operationKey, async () => {
        if (this.state.get(scope.conversation.id).activeTurnId !== null) {
          throw new ViewerHttpError(409, "дождитесь завершения активного Codex run");
        }
        return this.repositoryAction(scope, telegramUser, action, body ?? {});
      });
      json(response, 200, result);
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/viewer/environment") {
      const scope = await this.scope(conversationId, telegramUser);
      this.requireEnvironmentAdministrator(telegramUser);
      const body = await requestBody(request, 1_100_000) as Record<string, unknown> | null;
      const text = body?.text;
      const expectedRevision = body?.expectedRevision;
      if (typeof text !== "string" || typeof expectedRevision !== "number") {
        throw new ViewerHttpError(400, "text and expectedRevision are required");
      }
      json(response, 200, {
        environment: await this.runner.saveEnvironment(
          scope.project.id,
          scope.project.workspace,
          text,
          expectedRevision,
        ),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/tree") {
      const scope = await this.scope(conversationId, telegramUser);
      json(response, 200, { files: await scope.inspector.tree() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/file") {
      const scope = await this.scope(conversationId, telegramUser);
      json(response, 200, await scope.inspector.file(queryValue(url, "path")));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/diff") {
      const scope = await this.scope(conversationId, telegramUser);
      const mode = queryValue(url, "mode");
      const diff =
        mode === "working"
          ? await scope.inspector.workingDiff()
          : mode === "commit"
            ? await scope.inspector.commitDiff(queryValue(url, "base"), queryValue(url, "head"))
            : (() => { throw new ViewerHttpError(400, "unknown diff mode"); })();
      json(response, 200, { diff });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/commits") {
      const scope = await this.scope(conversationId, telegramUser);
      json(response, 200, { commits: await scope.inspector.commits() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/runs") {
      const scope = await this.scope(conversationId, telegramUser);
      json(response, 200, { runs: await this.artifacts.list(scope.conversation.id) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/run-diff") {
      const scope = await this.scope(conversationId, telegramUser);
      const runId = Number(queryValue(url, "run"));
      if (!Number.isSafeInteger(runId) || runId <= 0) throw new ViewerHttpError(400, "invalid run id");
      json(response, 200, { diff: await this.artifacts.patch(scope.conversation.id, runId) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/jobs") {
      const scope = await this.scope(conversationId, telegramUser);
      const available = await this.runner.available();
      json(response, 200, {
        available,
        jobs: available ? await this.runner.jobs(scope.project.id, scope.project.workspace) : [],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/job-log") {
      const scope = await this.scope(conversationId, telegramUser);
      const jobId = queryValue(url, "job");
      if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new ViewerHttpError(400, "invalid job id");
      json(response, 200, { log: await this.runner.log(scope.project.id, jobId) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/job-artifacts") {
      const scope = await this.scope(conversationId, telegramUser);
      const jobId = queryValue(url, "job");
      if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new ViewerHttpError(400, "invalid job id");
      json(response, 200, { artifacts: await this.runner.artifacts(scope.project.id, jobId) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/job-artifact") {
      const scope = await this.scope(conversationId, telegramUser);
      const jobId = queryValue(url, "job");
      const name = queryValue(url, "name");
      if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new ViewerHttpError(400, "invalid job id");
      json(response, 200, {
        artifact: await this.runner.artifact(scope.project.id, jobId, name),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/deployment") {
      await this.scope(conversationId, telegramUser);
      this.requireAdministrator(telegramUser);
      json(response, 200, await this.deployment.status());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/deployment") {
      const body = await requestBody(request) as Record<string, unknown> | null;
      const requestedConversation = String(body?.conversation ?? "");
      await this.scope(requestedConversation, telegramUser);
      this.requireAdministrator(telegramUser);
      const requestResult = await this.deployment.requestUpdate();
      json(response, 202, {
        request: requestResult,
        deployment: await this.deployment.status(),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/jobs") {
      const body = await requestBody(request) as Record<string, unknown> | null;
      const requestedConversation = String(body?.conversation ?? "");
      const action = String(body?.action ?? "") as RunnerAction;
      if (!(["build", "validate", "dry-run", "run"] as string[]).includes(action)) {
        throw new ViewerHttpError(400, "unknown runner action");
      }
      const scope = await this.scope(requestedConversation, telegramUser);
      if (!(await this.runner.available())) throw new ViewerHttpError(503, "runner is unavailable");
      const repository = await scope.inspector.summary();
      if (action === "run" && repository.dirty) {
        throw new ViewerHttpError(409, "live run requires a clean committed worktree");
      }
      const revision =
        action === "run"
          ? repository.head
          : await scope.inspector.snapshot(`${action} requested from viewer`);
      const archive = await scope.inspector.archive(revision);
      const job = await this.runner.submit(
        scope.project.id,
        scope.project.workspace,
        action,
        revision,
        archive,
      );
      json(response, 202, { job });
      return;
    }
    throw new ViewerHttpError(404, "not found");
  }

  private isAdministrator(telegramUser: number): boolean {
    return telegramUser === 0 || telegramUser === this.config.telegramOwnerId;
  }

  private requireAdminAccess(telegramUser: number): void {
    if (!this.isAdministrator(telegramUser)) {
      throw new ViewerHttpError(403, "центр управления доступен только администратору SUMMING");
    }
  }

  private adminOverview(): Record<string, unknown> {
    const conversations = this.state.listConversations();
    const bindingsByTopic = new Map(
      conversations.map((conversation) => [
        `${conversation.chatId}:${conversation.topicId}`,
        conversation,
      ]),
    );
    const projectBindings = new Map<string, number>();
    for (const conversation of conversations) {
      projectBindings.set(
        conversation.projectId,
        (projectBindings.get(conversation.projectId) ?? 0) + 1,
      );
    }
    const projects = this.projects.all().map((entry) => ({
      id: entry.project.id,
      name: entry.project.name,
      ownerId: entry.ownerId,
      managed: entry.managed,
      selfChange: entry.project.selfChange,
      defaultWorkspaceId: entry.project.defaultWorkspace,
      workspaces: [...entry.project.workspaces.values()].map((workspace) => ({ id: workspace.id })),
      bindingCount: projectBindings.get(entry.project.id) ?? 0,
    }));
    let topics = 0;
    let bindings = 0;
    const chats = this.state.listTelegramChats().map((chat) => ({
      chatId: chat.chatId,
      type: chat.type,
      title: chat.title,
      username: chat.username,
      isForum: chat.isForum,
      botStatus: chat.botStatus,
      updatedAt: chat.updatedAt,
      userCount: this.state.telegramChatUserCount(chat.chatId),
      topics: this.state.listTelegramTopics(chat.chatId).map((topic) => {
        topics += 1;
        const conversation = bindingsByTopic.get(`${topic.chatId}:${topic.topicId}`);
        if (conversation) bindings += 1;
        return {
          topicId: topic.topicId,
          name: topic.name,
          updatedAt: topic.updatedAt,
          userCount: this.state.telegramTopicUserCount(topic.chatId, topic.topicId),
          binding: conversation
            ? {
                conversationId: conversation.id,
                projectId: conversation.projectId,
                workspaceId: conversation.workspaceId,
                busy:
                  conversation.activeTurnId !== null ||
                  this.state.pendingAll(conversation.id).length > 0 ||
                  this.bindingBusy(conversation),
              }
            : null,
        };
      }),
    }));
    return {
      administratorId: this.config.telegramOwnerId,
      counts: {
        projects: projects.length,
        topics,
        bindings,
        users: this.state.telegramUserCount(),
      },
      projects,
      chats,
    };
  }

  private requireEnvironmentAdministrator(telegramUser: number): void {
    if (!this.isAdministrator(telegramUser)) {
      throw new ViewerHttpError(403, "project environments are available only to the administrator");
    }
  }

  private requireAdministrator(telegramUser: number): void {
    if (!this.isAdministrator(telegramUser)) {
      throw new ViewerHttpError(403, "deployment settings are available only to the administrator");
    }
    if (!this.deployment.available) {
      throw new ViewerHttpError(503, "automatic deployment is not configured");
    }
  }

  private async withRepositoryOperation<T>(
    repositoryKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.repositoryOperations.has(repositoryKey)) {
      throw new ViewerHttpError(409, "другая операция с репозиторием ещё выполняется");
    }
    this.repositoryOperations.add(repositoryKey);
    try {
      return await operation();
    } finally {
      this.repositoryOperations.delete(repositoryKey);
    }
  }

  private async repositoryAction(
    scope: ViewerScope,
    telegramUser: number,
    action: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const expectedHead = String(body.expectedHead ?? "");
    const expectedRemote = String(body.expectedRemote ?? "");
    const remoteUrl = String(body.remoteUrl ?? "");
    let context = await this.repositoryContext(scope);
    let summary = await context.inspector.summary();
    let previousRemote = "";
    try {
      let repository: RepositorySyncStatus;
      let preview: RepositoryAccessVerification | null = null;
      let outcome: "success" | "error" = "success";
      let code: RepositoryDiagnosticCode = "ok";
      let message = "Операция выполнена.";

      if (action === "connect") {
        if (!summary.remote && !remoteUrl) {
          throw new ViewerHttpError(400, "укажите SSH URL репозитория");
        }
        if (summary.remote && remoteUrl) {
          throw new ViewerHttpError(409, "origin уже настроен; используйте безопасную смену URL");
        }
        if (summary.remote && !this.supportsManagedSsh(summary.remote)) {
          throw new ViewerHttpError(409, "deploy key можно подключить только к SSH origin");
        }
        if (!summary.remote) await scope.inspector.validateManagedSshOrigin(remoteUrl);
        const credential = await this.repositoryCredentials.ensure(
          scope.project.id,
          scope.project.workspace,
        );
        context = {
          inspector: new GitInspector(scope.inspector.root, credential),
          credential,
          rotation: await this.repositoryCredentials.inspectRotation(
            scope.project.id,
            scope.project.workspace,
          ),
        };
        repository = summary.remote
          ? await context.inspector.repositoryStatus(false)
          : await context.inspector.connectOrigin(remoteUrl);
        await this.repositoryCredentials.setVerification(
          scope.project.id,
          scope.project.workspace,
          null,
        );
        repository = {
          ...repository,
          canPush: false,
          canPull: false,
          message:
            "Deploy key создан. Добавьте публичный ключ в Git-сервис с правом записи, затем проверьте доступ.",
        };
        message = "Создан управляемый deploy key.";
      } else if (action === "verify") {
        preview = await context.inspector.verifyRepositoryAccess();
        await this.repositoryCredentials.setVerification(
          scope.project.id,
          scope.project.workspace,
          this.verificationRecord(preview, context.credential?.fingerprint ?? ""),
        );
        repository = await context.inspector.repositoryStatus(preview.read);
        outcome = preview.read && preview.write ? "success" : "error";
        code = preview.code;
        message = preview.message;
      } else if (action === "migrate-legacy") {
        if (!context.credential) throw new ViewerHttpError(409, "сначала создайте deploy key");
        preview = await context.inspector.verifyRepositoryAccess();
        if (!preview.read || !preview.write) {
          await this.repositoryCredentials.setVerification(
            scope.project.id,
            scope.project.workspace,
            this.verificationRecord(preview, context.credential.fingerprint),
          );
          throw new GitInspectorError(
            `Старый SSH-параметр сохранён: ${preview.message}`,
            preview.code,
          );
        }
        const removed = await context.inspector.removeLegacySshCommand();
        const migrated = {
          ...preview,
          code: "ok" as const,
          message: removed
            ? "Доступ подтверждён; старый core.sshCommand удалён."
            : "Старый core.sshCommand уже отсутствует.",
          legacySshCommand: false,
        };
        await this.repositoryCredentials.setVerification(
          scope.project.id,
          scope.project.workspace,
          this.verificationRecord(migrated, context.credential.fingerprint),
        );
        repository = await context.inspector.repositoryStatus(true);
        message = migrated.message;
      } else if (action === "preview-origin") {
        if (!summary.remote) throw new ViewerHttpError(409, "сначала подключите origin");
        if (!remoteUrl || remoteUrl === summary.remote) {
          throw new ViewerHttpError(400, "укажите новый URL origin");
        }
        preview = await context.inspector.verifyRepositoryAccess(remoteUrl);
        repository = await context.inspector.repositoryStatus(false);
        outcome = preview.read && preview.write ? "success" : "error";
        code = preview.code;
        message = preview.message;
      } else if (action === "change-origin") {
        if (body.confirmed !== true) {
          throw new ViewerHttpError(400, "подтвердите смену origin");
        }
        if (!summary.remote || expectedRemote !== summary.remote) {
          throw new ViewerHttpError(409, "origin изменился; обновите состояние");
        }
        preview = await context.inspector.verifyRepositoryAccess(remoteUrl);
        if (!preview.read || !preview.write) {
          throw new GitInspectorError(
            `URL не изменён: ${preview.message}`,
            preview.code,
          );
        }
        previousRemote = summary.remote;
        repository = await context.inspector.changeOrigin(expectedRemote, remoteUrl);
        await this.repositoryCredentials.setPreviousRemote(
          scope.project.id,
          scope.project.workspace,
          {
            previous: previousRemote,
            replacement: repository.remote,
            changedAt: new Date().toISOString(),
            changedBy: telegramUser,
          },
        );
        await this.repositoryCredentials.setVerification(
          scope.project.id,
          scope.project.workspace,
          this.verificationRecord(preview, context.credential?.fingerprint ?? ""),
        );
        message = "Origin изменён после успешной проверки чтения и записи.";
      } else if (action === "rollback-origin") {
        const experience = await this.repositoryCredentials.state(
          scope.project.id,
          scope.project.workspace,
        );
        const rollback = experience.previousRemote;
        if (!rollback || summary.remote !== rollback.replacement) {
          throw new ViewerHttpError(409, "нет доступной точки отката origin");
        }
        preview = await context.inspector.verifyRepositoryAccess(rollback.previous);
        if (!preview.read || !preview.write) {
          throw new GitInspectorError(
            `Откат не выполнен: ${preview.message}`,
            preview.code,
          );
        }
        previousRemote = summary.remote;
        repository = await context.inspector.changeOrigin(summary.remote, rollback.previous);
        await this.repositoryCredentials.setPreviousRemote(
          scope.project.id,
          scope.project.workspace,
          null,
        );
        await this.repositoryCredentials.setVerification(
          scope.project.id,
          scope.project.workspace,
          this.verificationRecord(preview, context.credential?.fingerprint ?? ""),
        );
        message = "Прежний origin восстановлен.";
      } else if (action === "prepare-rotation") {
        if (!context.credential) {
          throw new ViewerHttpError(409, "ротация доступна только для управляемого deploy key");
        }
        context.rotation = await this.repositoryCredentials.prepareRotation(
          scope.project.id,
          scope.project.workspace,
        );
        repository = await context.inspector.repositoryStatus(false);
        message = "Новый deploy key создан; добавьте его в Git-сервис.";
      } else if (action === "verify-rotation") {
        if (!context.rotation) throw new ViewerHttpError(409, "сначала создайте новый ключ");
        const candidateInspector = new GitInspector(scope.inspector.root, context.rotation);
        preview = await candidateInspector.verifyRepositoryAccess();
        await this.repositoryCredentials.setRotationVerification(
          scope.project.id,
          scope.project.workspace,
          this.verificationRecord(preview, context.rotation.fingerprint),
        );
        repository = await context.inspector.repositoryStatus(false);
        outcome = preview.read && preview.write ? "success" : "error";
        code = preview.code;
        message = preview.message;
      } else if (action === "activate-rotation") {
        if (!context.rotation) throw new ViewerHttpError(409, "новый ключ не подготовлен");
        const candidateInspector = new GitInspector(scope.inspector.root, context.rotation);
        preview = await candidateInspector.verifyRepositoryAccess();
        if (!preview.read || !preview.write) {
          await this.repositoryCredentials.setRotationVerification(
            scope.project.id,
            scope.project.workspace,
            this.verificationRecord(preview, context.rotation.fingerprint),
          );
          throw new GitInspectorError(
            `Новый ключ не активирован: ${preview.message}`,
            preview.code,
          );
        }
        const credential = await this.repositoryCredentials.activateRotation(
          scope.project.id,
          scope.project.workspace,
        );
        context = { inspector: new GitInspector(scope.inspector.root, credential), credential, rotation: null };
        await this.repositoryCredentials.setVerification(
          scope.project.id,
          scope.project.workspace,
          this.verificationRecord(preview, credential.fingerprint),
        );
        repository = await context.inspector.repositoryStatus(true);
        message = "Новый deploy key активирован. Старый ключ можно удалить в Git-сервисе.";
      } else if (action === "cancel-rotation") {
        await this.repositoryCredentials.cancelRotation(scope.project.id, scope.project.workspace);
        context.rotation = null;
        repository = await context.inspector.repositoryStatus(false);
        message = "Ротация ключа отменена.";
      } else {
        repository = action === "pull"
          ? await context.inspector.pullCurrentBranch(expectedHead)
          : await context.inspector.pushCurrentBranch(expectedHead);
        message = action === "pull"
          ? "Коммиты получены из origin."
          : "Коммиты отправлены в origin.";
      }

      summary = repository;
      await this.appendRepositoryAudit(
        scope,
        telegramUser,
        action,
        outcome,
        summary,
        code,
        message,
        previousRemote,
      );
      const payload = await this.repositoryPayload(scope, repository, context, false);
      return preview ? { ...payload, preview } : payload;
    } catch (error) {
      const code = error instanceof GitInspectorError ? error.code : "unknown";
      const message = error instanceof Error ? error.message : "Неизвестная ошибка.";
      await this.appendRepositoryAudit(
        scope,
        telegramUser,
        action,
        "error",
        summary,
        code,
        message,
        previousRemote,
      ).catch(() => undefined);
      if (error instanceof GitInspectorError) {
        throw new ViewerHttpError(409, error.message);
      }
      throw error;
    }
  }

  private verificationRecord(
    verification: RepositoryAccessVerification,
    fingerprint: string,
  ): RepositoryVerificationRecord {
    return {
      remote: verification.remote,
      head: verification.head,
      read: verification.read,
      write: verification.write,
      emptyRemote: verification.emptyRemote,
      checkedAt: verification.checkedAt,
      code: verification.code,
      message: verification.message,
      fingerprint,
    };
  }

  private async appendRepositoryAudit(
    scope: ViewerScope,
    actor: number,
    action: string,
    outcome: "success" | "error",
    repository: { remote: string; branch: string; head: string },
    code: RepositoryDiagnosticCode,
    message: string,
    previousRemote = "",
  ): Promise<void> {
    const entry: RepositoryAuditEntry = {
      at: new Date().toISOString(),
      actor,
      action,
      outcome,
      remote: repository.remote,
      previousRemote,
      branch: repository.branch,
      head: repository.head,
      code,
      message,
    };
    await this.repositoryCredentials.appendAudit(scope.project.id, scope.project.workspace, entry);
  }

  private async repositoryPayload(
    scope: ViewerScope,
    repository: RepositorySyncStatus,
    context: {
      inspector: GitInspector;
      credential: ManagedRepositoryCredential | null;
      rotation: RepositoryRotationCandidate | null;
    },
    activeRun: boolean,
  ): Promise<Record<string, unknown>> {
    const experience = await this.repositoryCredentials.state(scope.project.id, scope.project.workspace);
    const verification = this.currentVerification(repository, context.credential, experience);
    const gated = activeRun
      ? {
          ...repository,
          canPush: false,
          canPull: false,
          message: `${repository.message} Дождитесь завершения активного Codex run.`,
        }
      : verification
        ? {
            ...repository,
            canPush: repository.canPush && verification.write,
            canPull: repository.canPull && verification.read,
          }
        : context.credential
          ? { ...repository, canPush: false, canPull: false }
          : repository;
    return {
      repository: gated,
      connection: this.repositoryConnection(repository, context.credential, context.rotation),
      experience: {
        verification: experience.verification,
        rotationVerification: experience.rotationVerification,
        previousRemote: experience.previousRemote,
        audit: [...experience.audit].reverse().slice(0, 50),
      },
      activeRun,
    };
  }

  private currentVerification(
    repository: RepositorySyncStatus,
    credential: ManagedRepositoryCredential | null,
    experience: RepositoryExperienceState,
  ): RepositoryVerificationRecord | null {
    const verification = experience.verification;
    if (!verification || verification.remote !== repository.remote) return null;
    if (verification.fingerprint !== (credential?.fingerprint ?? "")) return null;
    return verification;
  }

  private async repositoryContext(scope: ViewerScope): Promise<{
    inspector: GitInspector;
    credential: ManagedRepositoryCredential | null;
    rotation: RepositoryRotationCandidate | null;
  }> {
    const [credential, rotation] = await Promise.all([
      this.repositoryCredentials.inspect(scope.project.id, scope.project.workspace),
      this.repositoryCredentials.inspectRotation(scope.project.id, scope.project.workspace),
    ]);
    return {
      inspector: credential ? new GitInspector(scope.inspector.root, credential) : scope.inspector,
      credential,
      rotation,
    };
  }

  private repositoryConnection(
    repository: { remote: string },
    credential: ManagedRepositoryCredential | null,
    rotation: RepositoryRotationCandidate | null,
  ): ViewerRepositoryConnection {
    return {
      mode: credential ? "managed-ssh" : repository.remote ? "external" : "none",
      publicKey: credential?.publicKey ?? "",
      fingerprint: credential?.fingerprint ?? "",
      canCreateDeployKey: !credential && (
        !repository.remote || this.supportsManagedSsh(repository.remote)
      ),
      hostKeyPolicy: credential ? "trust-on-first-use" : "",
      rotation: rotation
        ? {
            publicKey: rotation.publicKey,
            fingerprint: rotation.fingerprint,
            preparedAt: rotation.preparedAt,
          }
        : null,
    };
  }

  private supportsManagedSsh(remote: string): boolean {
    return /^ssh:\/\//i.test(remote) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(remote);
  }

  private async scope(conversationId: string, telegramUser: number): Promise<ViewerScope> {
    if (!/^tg-[0-9a-f]{20}$/.test(conversationId)) {
      throw new ViewerHttpError(400, "invalid conversation id");
    }
    let conversation: Conversation;
    try {
      conversation = this.state.get(conversationId);
    } catch {
      throw new ViewerHttpError(404, "conversation not found");
    }
    if (telegramUser !== 0 && !this.projects.canAccess(telegramUser, conversation.projectId)) {
      throw new ViewerHttpError(403, "project access denied");
    }
    const project = this.projects.project(conversation.projectId);
    const workspace = project.workspace(conversation.workspaceId);
    const path = conversation.worktreePath || workspace.path;
    const root = await GitInspector.worktreeRoot(path);
    return {
      conversation,
      inspector: new GitInspector(root),
      project: { id: project.id, name: project.name, workspace: workspace.id },
    };
  }

  private report(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof ViewerHttpError) {
      json(response, error.status, { error: error.message });
      return;
    }
    if (error instanceof ViewerAuthError) {
      json(response, 401, { error: error.message });
      return;
    }
    if (error instanceof GitInspectorError) {
      json(response, 400, { error: error.message });
      return;
    }
    if (error instanceof ConfigError) {
      json(response, 400, { error: error.message });
      return;
    }
    if (error instanceof ProjectCatalogError) {
      json(response, 409, { error: error.message });
      return;
    }
    if (error instanceof ProjectRunnerClientError) {
      json(response, error.status >= 400 && error.status < 500 ? error.status : 503, {
        error: error.message,
      });
      return;
    }
    if (error instanceof DeploymentControllerError) {
      json(response, 503, { error: error.message });
      return;
    }
    console.error("project viewer request failed", error);
    json(response, 500, { error: "internal viewer error" });
  }
}
