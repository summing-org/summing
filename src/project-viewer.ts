import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstatSync, readFileSync } from "node:fs";
import { issueConnectionTicket, ConnectionTicketError } from "./connection-ticket.js";
import type { RuntimeConfig } from "./config.js";
import {
  DeploymentController,
  DeploymentControllerError,
  type DeploymentControl,
} from "./deployment-controller.js";
import { GitInspector, GitInspectorError } from "./git-inspector.js";
import {
  IntegrationManifestError,
  loadIntegrationManifest,
  type IntegrationDeclaration,
} from "./integration-manifest.js";
import type { ProjectCatalog } from "./project-catalog.js";
import {
  ProjectRunnerClient,
  ProjectRunnerClientError,
  type RunnerAction,
} from "./project-runner-client.js";
import { RunArtifactStore } from "./run-artifacts.js";
import {
  SecretBrokerClientError,
  SecretBrokerControlClient,
  type IntegrationModeOptions,
} from "./secret-broker-client.js";
import type { ConnectionSummary } from "./secret-vault.js";
import type { Conversation, StateStore } from "./state-store.js";
import { ViewerAuthenticator, ViewerAuthError } from "./viewer-auth.js";
import { VIEWER_CSS, VIEWER_HTML, VIEWER_JS, VIEWER_LOGO_SVG } from "./viewer-assets.js";

interface ViewerScope {
  conversation: Conversation;
  inspector: GitInspector;
  project: { id: string; name: string; workspace: string };
}

function connectionReady(
  integration: IntegrationDeclaration,
  connection: ConnectionSummary | undefined,
): boolean {
  if (integration.auth === "none") return true;
  if (!connection || connection.status !== "connected") return false;
  return integration.mode !== "raw" || connection.rawGrant !== null;
}

function readConnectionSigningKey(path: string): Buffer {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 64_000 ||
    (metadata.mode & 0o007) !== 0
  ) {
    throw new Error("connection ticket signing key must be a non-public regular file under 64 KB");
  }
  return readFileSync(path);
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
  readonly auth: ViewerAuthenticator;
  readonly artifacts: RunArtifactStore;
  readonly runner: ProjectRunnerClient;
  readonly deployment: DeploymentControl;
  readonly secrets: SecretBrokerControlClient;
  private readonly connectionTicketPrivateKey: Buffer | null;

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
    this.secrets = new SecretBrokerControlClient(config.secretBrokerControlSocket);
    this.connectionTicketPrivateKey = config.connectionsEnabled
      ? readConnectionSigningKey(config.connectionTicketPrivateKeyPath)
      : null;
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
        connectionsAvailable:
          this.config.connectionsEnabled && await this.secrets.available(),
        administrator: this.isAdministrator(telegramUser),
        deploymentAvailable: this.isAdministrator(telegramUser) && this.deployment.available,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/connections") {
      const scope = await this.scope(conversationId, telegramUser);
      const state = await this.connectionState(scope);
      json(response, 200, state);
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
        jobs: available ? await this.runner.jobs(scope.project.id) : [],
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
      if (action === "dry-run" || action === "run") {
        const connectionState = await this.connectionState(scope);
        const missing = connectionState.integrations.filter((integration) =>
          integration.actions.includes(action) &&
          integration.auth !== "none" &&
          !connectionReady(
            integration,
            connectionState.connections.find((connection) =>
              connection.integrationId === integration.id &&
              connection.environment === integration.environment,
            ),
          ),
        );
        if (missing.length > 0) {
          throw new ViewerHttpError(
            409,
            `missing connections: ${missing.map((item) => `${item.id}@${item.environment}`).join(", ")}`,
          );
        }
      }
      const repository = await scope.inspector.summary();
      if (action === "run" && repository.dirty) {
        throw new ViewerHttpError(409, "live run requires a clean committed worktree");
      }
      const revision =
        action === "run"
          ? repository.head
          : await scope.inspector.snapshot(`${action} requested from viewer`);
      const archive = await scope.inspector.archive(revision);
      const job = await this.runner.submit(scope.project.id, action, revision, archive);
      json(response, 202, { job });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/connection-ticket") {
      if (!this.config.connectionsEnabled || !this.connectionTicketPrivateKey) {
        throw new ViewerHttpError(503, "connections are not configured");
      }
      if (!(await this.secrets.available())) throw new ViewerHttpError(503, "secret broker is unavailable");
      const body = await requestBody(request) as Record<string, unknown> | null;
      const requestedConversation = String(body?.conversation ?? "");
      const integrationId = String(body?.integration ?? "");
      const environment = String(body?.environment ?? "");
      const scope = await this.scope(requestedConversation, telegramUser);
      const manifest = loadIntegrationManifest(scope.inspector.root);
      const integration = manifest.integrations.find((item) =>
        item.id === integrationId && item.environment === environment,
      );
      if (!integration) throw new ViewerHttpError(404, "integration declaration not found");
      if (integration.auth === "none") throw new ViewerHttpError(400, "integration does not require credentials");
      const userId = telegramUser === 0 ? this.config.telegramOwnerId : telegramUser;
      const ticket = issueConnectionTicket(
        this.connectionTicketPrivateKey,
        userId,
        scope.project.id,
        integration,
      );
      json(response, 201, {
        url: `${this.config.connectionsPublicUrl}/connections#ticket=${encodeURIComponent(ticket)}`,
        expiresIn: 300,
      });
      return;
    }
    throw new ViewerHttpError(404, "not found");
  }

  private async connectionState(scope: ViewerScope): Promise<{
    available: boolean;
    integrations: IntegrationDeclaration[];
    connections: ConnectionSummary[];
    modes: IntegrationModeOptions[];
  }> {
    const integrations = loadIntegrationManifest(scope.inspector.root).integrations;
    if (!this.config.connectionsEnabled) {
      return { available: false, integrations, connections: [], modes: [] };
    }
    const available = await this.secrets.available();
    const [connections, modes] = available
      ? await Promise.all([
        this.secrets.connections(scope.project.id),
        this.secrets.modeOptions(integrations),
      ])
      : [[], []];
    return {
      available,
      integrations,
      connections,
      modes,
    };
  }

  private isAdministrator(telegramUser: number): boolean {
    return telegramUser === 0 || telegramUser === this.config.telegramOwnerId;
  }

  private requireAdministrator(telegramUser: number): void {
    if (!this.isAdministrator(telegramUser)) {
      throw new ViewerHttpError(403, "deployment settings are available only to the administrator");
    }
    if (!this.deployment.available) {
      throw new ViewerHttpError(503, "automatic deployment is not configured");
    }
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
      json(response, 503, { error: error.message });
      return;
    }
    if (error instanceof DeploymentControllerError) {
      json(response, 503, { error: error.message });
      return;
    }
    if (
      error instanceof IntegrationManifestError ||
      error instanceof ConnectionTicketError
    ) {
      json(response, 400, { error: error.message });
      return;
    }
    if (error instanceof SecretBrokerClientError) {
      json(response, 503, { error: error.message });
      return;
    }
    console.error("project viewer request failed", error);
    json(response, 500, { error: "internal viewer error" });
  }
}
