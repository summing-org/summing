import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RuntimeConfig } from "./config.js";
import {
  DeploymentController,
  DeploymentControllerError,
  type DeploymentControl,
} from "./deployment-controller.js";
import { GitInspector, GitInspectorError } from "./git-inspector.js";
import type { ProjectCatalog } from "./project-catalog.js";
import {
  ProjectRunnerClient,
  ProjectRunnerClientError,
  type RunnerAction,
} from "./project-runner-client.js";
import { RunArtifactStore } from "./run-artifacts.js";
import {
  type ManagedRepositoryCredential,
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
}

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
      const context = await this.repositoryContext(scope);
      const repository = await this.withRepositoryOperation(operationKey, async () =>
        context.inspector.repositoryStatus(!activeRun)
      );
      json(response, 200, {
        repository: activeRun
          ? {
              ...repository,
              canPush: false,
              canPull: false,
              message: `${repository.message} Дождитесь завершения активного Codex run.`,
            }
          : repository,
        connection: this.repositoryConnection(repository, context.credential),
        activeRun,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/repository") {
      const body = await requestBody(request) as Record<string, unknown> | null;
      const requestedConversation = String(body?.conversation ?? "");
      const action = String(body?.action ?? "");
      const expectedHead = String(body?.expectedHead ?? "");
      const remoteUrl = String(body?.remoteUrl ?? "");
      if (action !== "pull" && action !== "push" && action !== "connect") {
        throw new ViewerHttpError(400, "неизвестное действие с репозиторием");
      }
      const scope = await this.scope(requestedConversation, telegramUser);
      const operationKey = await scope.inspector.commonDirectory();
      const result = await this.withRepositoryOperation(operationKey, async () => {
        if (this.state.get(scope.conversation.id).activeTurnId !== null) {
          throw new ViewerHttpError(409, "дождитесь завершения активного Codex run");
        }
        try {
          if (action === "connect") {
            const current = await scope.inspector.summary();
            if (!current.remote && !remoteUrl) {
              throw new ViewerHttpError(400, "укажите SSH URL репозитория");
            }
            if (current.remote && remoteUrl) {
              throw new ViewerHttpError(409, "origin уже настроен; его замена через Mini App запрещена");
            }
            if (current.remote && !this.supportsManagedSsh(current.remote)) {
              throw new ViewerHttpError(409, "deploy key можно подключить только к SSH origin");
            }
            if (!current.remote) await scope.inspector.validateManagedSshOrigin(remoteUrl);
            const credential = await this.repositoryCredentials.ensure(
              scope.project.id,
              scope.project.workspace,
            );
            const inspector = new GitInspector(scope.inspector.root, credential);
            const connected = current.remote
              ? await inspector.repositoryStatus(false)
              : await inspector.connectOrigin(remoteUrl);
            const repository = {
              ...connected,
              canPush: false,
              canPull: false,
              message:
                "Deploy key создан. Добавьте публичный ключ в Git-сервис с правом записи, затем проверьте доступ.",
            };
            return { repository, credential };
          }
          const context = await this.repositoryContext(scope);
          const repository = action === "pull"
            ? await context.inspector.pullCurrentBranch(expectedHead)
            : await context.inspector.pushCurrentBranch(expectedHead);
          return { repository, credential: context.credential };
        } catch (error) {
          if (error instanceof GitInspectorError) {
            throw new ViewerHttpError(409, error.message);
          }
          throw error;
        }
      });
      json(response, 200, {
        repository: result.repository,
        connection: this.repositoryConnection(result.repository, result.credential),
      });
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

  private async repositoryContext(scope: ViewerScope): Promise<{
    inspector: GitInspector;
    credential: ManagedRepositoryCredential | null;
  }> {
    const credential = await this.repositoryCredentials.inspect(
      scope.project.id,
      scope.project.workspace,
    );
    return {
      inspector: credential ? new GitInspector(scope.inspector.root, credential) : scope.inspector,
      credential,
    };
  }

  private repositoryConnection(
    repository: { remote: string },
    credential: ManagedRepositoryCredential | null,
  ): ViewerRepositoryConnection {
    return {
      mode: credential ? "managed-ssh" : repository.remote ? "external" : "none",
      publicKey: credential?.publicKey ?? "",
      fingerprint: credential?.fingerprint ?? "",
      canCreateDeployKey: !credential && (
        !repository.remote || this.supportsManagedSsh(repository.remote)
      ),
      hostKeyPolicy: credential ? "trust-on-first-use" : "",
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
