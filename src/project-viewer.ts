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
import type { KnowledgeSyncAdmin } from "./knowledge-sync.js";
import type { NodeRecoveryAdmin } from "./node-recovery-service.js";
import {
  ProjectRunnerClient,
  ProjectRunnerClientError,
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
import type {
  RepositoryToolContext,
  RepositoryToolOperation,
} from "./repository-tools.js";
import type { Conversation, StateStore } from "./state-store.js";
import { ViewerAuthenticator, ViewerAuthError } from "./viewer-auth.js";
import { VIEWER_CSS, VIEWER_HTML, VIEWER_JS, VIEWER_LOGO_SVG } from "./viewer-assets.js";

interface ViewerScope {
  conversation: Conversation;
  inspector: GitInspector;
  project: { id: string; name: string; workspace: string };
}

export interface OnboardingRuntimeStatus {
  botConnected: boolean;
  codexAuthenticated: boolean;
}

export interface TeamModelEgressAdmin {
  overview(): Promise<Record<string, unknown>> | Record<string, unknown>;
  setEnabled(enabled: boolean): Promise<Record<string, unknown>> | Record<string, unknown>;
  setProactiveRepliesEnabled(
    enabled: boolean,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface ProjectPortalAdmin {
  overview(): Promise<Record<string, unknown>> | Record<string, unknown>;
  retry(id: string): Promise<unknown> | unknown;
  cancel(id: string): Promise<unknown> | unknown;
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
  "push-default",
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

function artifactDownload(
  response: ServerResponse,
  artifact: { content?: string; data?: Uint8Array; contentType: string; name: string },
): void {
  const body = artifact.data
    ? Buffer.from(artifact.data)
    : Buffer.from(artifact.content ?? "", "utf8");
  const contentType = /^(?:text\/|application\/(?:json|xml)(?:$|;))/i.test(artifact.contentType)
    ? `${artifact.contentType}; charset=utf-8`
    : artifact.contentType;
  const fallbackName = artifact.name.replace(/[^A-Za-z0-9._-]/g, "_") || "artifact";
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "content-disposition":
      `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
    "content-length": body.length,
    "cache-control": "private, no-store",
  });
  response.end(body);
}

function queryValue(url: URL, name: string): string {
  return url.searchParams.get(name)?.trim() ?? "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(objectValue) : [];
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
    readonly knowledgeSync?: KnowledgeSyncAdmin,
    readonly onboardingRuntime: () => OnboardingRuntimeStatus = () => ({
      botConnected: false,
      codexAuthenticated: false,
    }),
    readonly nodeRecovery?: NodeRecoveryAdmin,
    readonly teamModelEgress?: TeamModelEgressAdmin,
    readonly projectPortalAdmin?: ProjectPortalAdmin,
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

  async repositoryTool(
    toolContext: RepositoryToolContext,
    operation: RepositoryToolOperation,
    expectedHead = "",
  ): Promise<unknown> {
    const conversation = this.state.get(toolContext.conversationId);
    if (
      conversation.projectId !== toolContext.projectId ||
      conversation.workspaceId !== toolContext.workspaceId ||
      conversation.activeTurnId !== toolContext.turnId ||
      !this.projects.canAccess(toolContext.actorUserId, toolContext.projectId)
    ) {
      throw new Error("repository tool is unavailable outside the active authorized owner turn");
    }
    const scope = await this.scope(toolContext.conversationId, toolContext.actorUserId);
    const repositoryRoot = await GitInspector.worktreeRoot(toolContext.repositoryPath);
    if (repositoryRoot !== scope.inspector.root) {
      throw new Error("repository tool path does not match the active conversation workspace");
    }
    const operationKey = await scope.inspector.commonDirectory();
    return this.withRepositoryOperation(operationKey, async () => {
      if (operation === "inspect") {
        const context = await this.repositoryContext(scope);
        const repository = await context.inspector.repositoryStatus(true);
        const experience = await this.repositoryCredentials.state(
          scope.project.id,
          scope.project.workspace,
        );
        const access = this.currentVerification(repository, context.credential, experience);
        return {
          operation,
          repository,
          managedCredential: Boolean(context.credential),
          access: access
            ? {
                read: access.read,
                write: access.write,
                checkedAt: access.checkedAt,
                code: access.code,
                message: access.message,
              }
            : null,
        };
      }
      const payload = await this.repositoryAction(
        scope,
        toolContext.actorUserId,
        operation === "verify_access" ? "verify" : operation,
        expectedHead ? { expectedHead } : {},
      );
      return {
        operation,
        repository: payload.repository,
        ...(operation === "verify_access" ? { access: payload.preview } : {}),
      };
    });
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
    if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
      await this.downloadArtifact(url, response);
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
    if (request.method === "GET" && url.pathname === "/api/viewer/admin/project-portals") {
      this.requireAdminAccess(telegramUser);
      json(response, 200, await this.requireProjectPortalAdmin().overview());
      return;
    }
    const portalOutboxAction = url.pathname.match(
      /^\/api\/viewer\/admin\/project-portals\/outbox\/([a-f0-9]{64})\/(retry|cancel)$/,
    );
    if (request.method === "POST" && portalOutboxAction) {
      this.requireAdminAccess(telegramUser);
      try {
        const admin = this.requireProjectPortalAdmin();
        json(
          response,
          200,
          portalOutboxAction[2] === "retry"
            ? await admin.retry(portalOutboxAction[1]!)
            : await admin.cancel(portalOutboxAction[1]!),
        );
      } catch (error) {
        throw new ViewerHttpError(409, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/admin/model-egress") {
      this.requireAdminAccess(telegramUser);
      json(response, 200, await this.requireTeamModelEgress().overview());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/admin/model-egress") {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      if (typeof body?.enabled !== "boolean") {
        throw new ViewerHttpError(400, "enabled must be boolean");
      }
      json(response, 200, await this.requireTeamModelEgress().setEnabled(body.enabled));
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/viewer/admin/model-egress/proactive-replies"
    ) {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      if (typeof body?.enabled !== "boolean") {
        throw new ViewerHttpError(400, "enabled must be boolean");
      }
      json(
        response,
        200,
        await this.requireTeamModelEgress().setProactiveRepliesEnabled(body.enabled),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/admin/sync") {
      this.requireAdminAccess(telegramUser);
      json(response, 200, this.requireKnowledgeSync().overview());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/admin/onboarding") {
      this.requireAdminAccess(telegramUser);
      json(response, 200, this.onboardingOverview());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/admin/recovery") {
      this.requireAdminAccess(telegramUser);
      json(response, 200, this.requireNodeRecovery().overview());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/admin/recovery/jobs") {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      try {
        const recovery = this.requireNodeRecovery();
        const kind = String(body?.kind ?? "");
        if (kind === "export") {
          json(response, 202, recovery.startExport({
            includeSecrets: body?.includeSecrets === true,
            ...(body?.confirmation ? { confirmation: String(body.confirmation) } : {}),
          }));
        } else if (kind === "restore") {
          json(response, 202, recovery.startRestore({
            bundleKey: String(body?.bundleKey ?? ""),
            recoveryKey: String(body?.recoveryKey ?? ""),
          }));
        } else {
          throw new Error("node recovery job kind must be export or restore");
        }
      } catch (error) {
        throw new ViewerHttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const recoveryConfirmation = url.pathname.match(
      /^\/api\/viewer\/admin\/recovery\/jobs\/([0-9a-f-]{36})\/confirm$/,
    );
    if (request.method === "POST" && recoveryConfirmation) {
      this.requireAdminAccess(telegramUser);
      try {
        json(response, 202, this.requireNodeRecovery().confirmRestore(recoveryConfirmation[1]!));
      } catch (error) {
        throw new ViewerHttpError(409, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/admin/mtproto/connectors") {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      try {
        const status = this.requireKnowledgeSync().beginAuthorization({
          apiId: Number(body?.apiId),
          apiHash: String(body?.apiHash ?? ""),
          phone: String(body?.phone ?? ""),
        });
        json(response, 201, status);
      } catch (error) {
        throw new ViewerHttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const mtprotoAuth = url.pathname.match(
      /^\/api\/viewer\/admin\/mtproto\/connectors\/([0-9a-f-]{36})\/auth$/,
    );
    if (request.method === "POST" && mtprotoAuth) {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      try {
        json(response, 200, this.requireKnowledgeSync().submitAuthorization(mtprotoAuth[1]!, {
          ...(body?.code ? { code: String(body.code) } : {}),
          ...(body?.password ? { password: String(body.password) } : {}),
        }));
      } catch (error) {
        throw new ViewerHttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const mtprotoConnector = url.pathname.match(
      /^\/api\/viewer\/admin\/mtproto\/connectors\/([0-9a-f-]{36})$/,
    );
    if (request.method === "DELETE" && mtprotoConnector) {
      this.requireAdminAccess(telegramUser);
      try {
        await this.requireKnowledgeSync().revokeConnector(mtprotoConnector[1]!);
        json(response, 200, { revoked: true });
      } catch (error) {
        throw new ViewerHttpError(409, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/admin/knowledge/consents") {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      try {
        json(response, 200, {
          consent: body?.allUsers === true
            ? this.requireKnowledgeSync().grantGroupConsent({
                chatId: Number(body?.chatId),
                proof: String(body?.proof ?? ""),
                ...(body?.historicalFrom === undefined || body.historicalFrom === null
                  ? {}
                  : { historicalFrom: Number(body.historicalFrom) }),
              })
            : this.requireKnowledgeSync().grantConsent({
                chatId: Number(body?.chatId),
                telegramUserId: Number(body?.telegramUserId),
                proof: String(body?.proof ?? ""),
                ...(body?.historicalFrom === undefined || body.historicalFrom === null
                  ? {}
                  : { historicalFrom: Number(body.historicalFrom) }),
              }),
        });
      } catch (error) {
        throw new ViewerHttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/api/viewer/admin/knowledge/consents") {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      try {
        await this.requireKnowledgeSync().revokeConsent(
          Number(body?.chatId),
          Number(body?.telegramUserId),
        );
        json(response, 200, { revoked: true });
      } catch (error) {
        throw new ViewerHttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/admin/knowledge/sources") {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      const action = String(body?.action ?? "start");
      try {
        const sync = this.requireKnowledgeSync();
        if (action === "start") {
          json(response, 202, await sync.startSource({
            connectorId: String(body?.connectorId ?? ""),
            chatId: Number(body?.chatId),
            ...(body?.title ? { title: String(body.title) } : {}),
          }));
        } else if (action === "pause") {
          json(response, 200, sync.pauseSource(Number(body?.chatId)));
        } else if (action === "resume") {
          json(response, 200, await sync.resumeSource(Number(body?.chatId)));
        } else if (action === "unbind") {
          sync.unbindSource(Number(body?.chatId));
          json(response, 200, { unbound: true });
        } else {
          throw new Error("unsupported sync action");
        }
      } catch (error) {
        throw new ViewerHttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/admin/knowledge/transfers") {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      try {
        const sync = this.requireKnowledgeSync();
        const kind = String(body?.kind ?? "");
        if (kind === "export") {
          const mode = String(body?.mode ?? "manifest");
          if (mode !== "manifest" && mode !== "portable") {
            throw new Error("knowledge export mode must be manifest or portable");
          }
          const requestedSpaceId = String(body?.spaceId ?? "").trim();
          const legacyChatId = Number(body?.chatId);
          const spaceId = requestedSpaceId || (
            Number.isSafeInteger(legacyChatId)
              ? this.state.teamSpaceForProvider("telegram", String(legacyChatId))?.id ?? ""
              : ""
          );
          if (!spaceId) throw new Error("Team Space is required for export");
          json(response, 202, sync.startKnowledgeExport({
            spaceId,
            mode,
            includeEmbeddings: body?.includeEmbeddings !== false,
          }));
        } else if (kind === "import") {
          json(response, 202, sync.startKnowledgeImport({
            bundleKey: String(body?.bundleKey ?? ""),
            recoveryKey: String(body?.recoveryKey ?? ""),
          }));
        } else {
          throw new Error("knowledge transfer kind must be export or import");
        }
      } catch (error) {
        throw new ViewerHttpError(400, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const knowledgeTransferConfirmation = url.pathname.match(
      /^\/api\/viewer\/admin\/knowledge\/transfers\/([0-9a-f-]{36})\/confirm$/,
    );
    if (request.method === "POST" && knowledgeTransferConfirmation) {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      try {
        json(response, 202, this.requireKnowledgeSync().confirmKnowledgeImport(
          knowledgeTransferConfirmation[1]!,
          body?.acceptConsents === true,
        ));
      } catch (error) {
        throw new ViewerHttpError(409, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/admin/deployment") {
      this.requireAdminAccess(telegramUser);
      json(response, 200, await this.deployment.status());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/admin/deployment") {
      this.requireAdministrator(telegramUser);
      const requestResult = await this.deployment.requestUpdate();
      json(response, 202, {
        request: requestResult,
        deployment: await this.deployment.status(),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/viewer/admin/deployment/refresh") {
      this.requireAdministrator(telegramUser);
      const requestResult = await this.deployment.requestRefresh();
      json(response, 202, {
        request: requestResult,
        deployment: await this.deployment.status(),
      });
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
            body?.primaryOwnerId ?? body?.ownerId,
            body?.workspaceId,
            String(body?.remoteUrl ?? ""),
          )
          : await this.projects.createLocal(
            body?.projectId,
            body?.primaryOwnerId ?? body?.ownerId,
            body?.workspaceId,
          );
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
    if (request.method === "PUT" && url.pathname === "/api/viewer/admin/project-owners") {
      this.requireAdminAccess(telegramUser);
      const body = await requestBody(request) as Record<string, unknown> | null;
      const entry = this.projects.replaceOwners(
        body?.projectId,
        body?.primaryOwnerId,
        body?.ownerIds,
      );
      json(response, 200, {
        project: {
          id: entry.project.id,
          primaryOwnerId: entry.primaryOwnerId,
          ownerIds: entry.ownerIds,
        },
      });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/api/viewer/admin/bindings") {
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
      const current = this.state.topicConversation(chatId, topicId);
      if (!current) {
        json(response, 200, { conversation: null });
        return;
      }
      if (
        current.activeTurnId !== null ||
        this.state.pendingAll(current.id).length > 0 ||
        this.bindingBusy(current)
      ) {
        throw new ViewerHttpError(
          409,
          "в выбранном топике есть активная или ожидающая задача; сначала отмените её",
        );
      }
      const conversation = this.state.unbind(chatId, topicId);
      json(response, 200, { conversation });
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
      const legacyBindingMode = String(body?.bindingMode ?? "");
      if (body?.role === undefined && legacyBindingMode &&
          legacyBindingMode !== "project") {
        throw new ViewerHttpError(400, "некорректная legacy-роль топика");
      }
      const role = body?.role === undefined ? "primary" : String(body.role);
      if (role !== "primary" && role !== "portal") {
        throw new ViewerHttpError(400, "роль топика должна быть primary или portal");
      }
      const portalKey = String(body?.portalKey ?? "").trim();
      if (role === "portal" && !portalKey) {
        throw new ViewerHttpError(400, "для portal-топика требуется portalKey");
      }
      const current = this.state.topicConversation(chatId, topicId);
      const currentPortal = current?.role === "observer"
        ? this.state.projectPortal(current.projectId, current.workspaceId, current.id)
        : null;
      if (
        current?.projectId === project.id &&
        current.workspaceId === workspace.id &&
        (role === "portal" ? current.role === "observer" : current.role === "primary") &&
        (role !== "portal" || currentPortal?.portalKey === portalKey)
      ) {
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
      let conversation: Conversation;
      try {
        conversation = this.state.bind(
          chatId,
          topicId,
          project.id,
          workspace.id,
          role === "portal" ? "observer" : "primary",
          role === "portal"
            ? {
                portalKey,
                ...(typeof body?.isDefault === "boolean"
                  ? { isDefault: body.isDefault }
                  : {}),
              }
            : {},
        );
      } catch (error) {
        throw new ViewerHttpError(409, error instanceof Error ? error.message : String(error));
      }
      if (role === "primary") this.afterTopicBound(chatId, topicId);
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
        environmentAccess: true,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/environment") {
      const scope = await this.scope(conversationId, telegramUser);
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
      const runs = await this.artifacts.list(scope.conversation.id);
      json(response, 200, {
        runs: runs.map((run) => {
          const deliveries = this.state.runDeliveries(run.runId);
          const evidence = this.state.runEvidence(run.runId);
          const attention = deliveries.filter((delivery) =>
            !["sent", "cancelled"].includes(delivery.status)
          );
          return {
            ...run,
            delivery: {
              total: deliveries.length,
              sent: deliveries.filter((delivery) => delivery.status === "sent").length,
              attention: attention.length,
              statuses: [...new Set(attention.map((delivery) => delivery.status))],
            },
            evidence: {
              total: evidence.length,
              current: evidence.filter((item) => item.freshness === "current").length,
              stale: evidence.filter((item) => item.freshness === "stale").length,
              redacted: evidence.filter((item) => item.redactionKinds.length > 0).length,
              failed: evidence.filter((item) =>
                item.status !== "completed" || (item.exitCode !== null && item.exitCode !== 0)
              ).length,
              scope: "unknown",
            },
          };
        }),
      });
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
    if (request.method === "GET" && url.pathname === "/api/viewer/services") {
      const scope = await this.scope(conversationId, telegramUser);
      const available = await this.runner.available();
      json(response, 200, {
        available,
        services: available
          ? await this.runner.services(scope.project.id, scope.project.workspace)
          : [],
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/viewer/service-log") {
      const scope = await this.scope(conversationId, telegramUser);
      const name = queryValue(url, "name");
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) {
        throw new ViewerHttpError(400, "invalid service name");
      }
      json(response, 200, {
        log: await this.runner.serviceLog(scope.project.id, scope.project.workspace, name),
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
      const artifacts = await this.runner.artifacts(scope.project.id, jobId);
      json(response, 200, {
        artifacts: artifacts.map((artifact) => {
          const grant = this.auth.createArtifactDownloadGrant({
            conversationId: scope.conversation.id,
            jobId,
            name: artifact.name,
            userId: telegramUser,
          });
          return {
            ...artifact,
            downloadExpiresAt: new Date(grant.expiresAt * 1_000).toISOString(),
            downloadUrl: `/artifacts/${grant.token}/${encodeURIComponent(artifact.name)}`,
          };
        }),
      });
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
    if (request.method === "POST" && url.pathname === "/api/viewer/jobs/cancel") {
      const body = await requestBody(request) as Record<string, unknown> | null;
      const requestedConversation = String(body?.conversation ?? "");
      const jobId = String(body?.job ?? "");
      if (!/^[0-9a-f-]{36}$/.test(jobId)) {
        throw new ViewerHttpError(400, "invalid job id");
      }
      const scope = await this.scope(requestedConversation, telegramUser);
      const job = await this.runner.cancel(
        scope.project.id,
        scope.project.workspace,
        jobId,
      );
      json(response, 200, { job });
      return;
    }
    throw new ViewerHttpError(404, "not found");
  }

  private isAdministrator(telegramUser: number): boolean {
    return telegramUser === 0 || telegramUser === this.config.telegramOwnerId;
  }

  private async downloadArtifact(url: URL, response: ServerResponse): Promise<void> {
    const match = /^\/artifacts\/((?:[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+)\/([^/]+)$/.exec(
      url.pathname,
    );
    if (!match) throw new ViewerHttpError(404, "artifact download not found");
    let requestedName: string;
    try {
      requestedName = decodeURIComponent(match[2] ?? "");
    } catch {
      throw new ViewerHttpError(404, "artifact download not found");
    }
    const grant = this.auth.verifyArtifactDownloadGrant(match[1] ?? "");
    if (requestedName !== grant.name) {
      throw new ViewerHttpError(404, "artifact download not found");
    }
    const scope = await this.scope(grant.conversationId, grant.userId);
    const artifact = await this.runner.artifactData(scope.project.id, grant.jobId, grant.name);
    if (artifact.name !== grant.name) {
      throw new ViewerHttpError(404, "artifact download not found");
    }
    artifactDownload(response, artifact);
  }

  private requireAdminAccess(telegramUser: number): void {
    if (!this.isAdministrator(telegramUser)) {
      throw new ViewerHttpError(403, "центр управления доступен только администратору SUMMING");
    }
  }

  private requireKnowledgeSync(): KnowledgeSyncAdmin {
    if (!this.knowledgeSync) throw new ViewerHttpError(503, "синхронизация базы знаний не настроена");
    return this.knowledgeSync;
  }

  private requireNodeRecovery(): NodeRecoveryAdmin {
    if (!this.nodeRecovery) throw new ViewerHttpError(503, "node recovery не настроен");
    return this.nodeRecovery;
  }

  private requireTeamModelEgress(): TeamModelEgressAdmin {
    if (!this.teamModelEgress) {
      throw new ViewerHttpError(503, "управление model egress не настроено");
    }
    return this.teamModelEgress;
  }

  private onboardingOverview(): Record<string, unknown> {
    const runtime = this.onboardingRuntime();
    const sync = objectValue(this.knowledgeSync?.overview());
    const connectors = arrayValue(sync.connectors);
    const statuses = arrayValue(sync.statuses);
    const embeddings = objectValue(sync.embeddings);
    const consents = objectValue(sync.consents);
    const knownGroups = this.state.listTelegramChats()
      .filter((chat) => chat.type !== "private").length;
    const configurationReady =
      sync.enabled === true &&
      sync.telegramTermsReviewed === true &&
      sync.objectStore === "s3" &&
      embeddings.configured === true;
    const connectorReady = connectors.some((connector) => connector.state === "ready");
    const connectorAuthorizing = connectors.some((connector) => connector.state === "authorizing");
    const grantedConsents = Number(consents.granted ?? 0);
    const collected = statuses.some((status) => {
      const collector = objectValue(status.collector);
      return collector.state === "tailing" || collector.state === "collected" ||
        Number(collector.initialCollectedAt ?? 0) > 0;
    });
    const syncing = statuses.some((status) => {
      const state = objectValue(status.collector).state;
      return state === "backfilling" || state === "tailing" || state === "collected";
    });
    const steps = [
      {
        id: "provisioning",
        state: "complete",
        title: "Provisioning",
        detail: "Ubuntu, Node, Codex, Caddy и systemd доступны; Admin API отвечает.",
      },
      {
        id: "secure-bootstrap",
        state: configurationReady ? "complete" : "blocked",
        title: "Secure bootstrap",
        detail: configurationReady
          ? "Knowledge sync, legal gate, S3 и OpenAI настроены."
          : "Проверьте fresh-install manifest: knowledge sync, legal gate, S3 и OpenAI обязательны.",
      },
      {
        id: "codex",
        state: runtime.codexAuthenticated ? "complete" : "pending",
        title: "Авторизация Codex",
        detail: runtime.codexAuthenticated
          ? "Codex App Server авторизован."
          : "Отправьте /login владельцу в личном чате и завершите device-code flow.",
        action: runtime.codexAuthenticated ? "" : "/login",
      },
      {
        id: "telegram-group",
        state: runtime.botConnected && knownGroups > 0 ? "complete" : "pending",
        title: "Группа Telegram",
        detail: knownGroups > 0
          ? `Bot API наблюдает групп: ${knownGroups}.`
          : "Добавьте бота в группу и отправьте доступное ему сообщение.",
      },
      {
        id: "mtproto",
        state: connectorReady ? "complete" : connectorAuthorizing ? "active" : "pending",
        title: "Технический MTProto-аккаунт",
        detail: connectorReady
          ? "Постоянный TDLib-коннектор готов."
          : connectorAuthorizing
            ? "Завершите OTP/2FA challenge ниже."
            : "Введите API ID/hash и телефон ниже; затем подтвердите OTP/2FA.",
      },
      {
        id: "consent",
        state: grantedConsents > 0 ? "complete" : "pending",
        title: "Согласия авторов",
        detail: grantedConsents > 0
          ? `Активных записей согласия: ${grantedConsents}.`
          : "Зафиксируйте групповые history + future + model egress для всех наблюдаемых участников.",
      },
      {
        id: "first-source",
        state: collected ? "complete" : syncing ? "active" : "pending",
        title: "Первый источник",
        detail: collected
          ? "Первичная история собрана, источник работает в live tail."
          : syncing
            ? "Первичный backfill выполняется; прогресс показан ниже."
            : "Выберите группу и готовый коннектор, затем запустите sync.",
      },
    ];
    return {
      complete: steps.every((step) => step.state === "complete"),
      knownGroups,
      steps,
    };
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
      primaryOwnerId: entry.primaryOwnerId,
      ownerIds: entry.ownerIds,
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
        const portal = conversation?.role === "observer"
          ? this.state.projectPortal(
              conversation.projectId,
              conversation.workspaceId,
              conversation.id,
            )
          : null;
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
                role: conversation.role === "observer" ? "portal" : "primary",
                portalKey: portal?.portalKey ?? null,
                default: portal?.isDefault ?? false,
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

  private requireAdministrator(telegramUser: number): void {
    if (!this.isAdministrator(telegramUser)) {
      throw new ViewerHttpError(403, "deployment settings are available only to the administrator");
    }
    if (!this.deployment.available) {
      throw new ViewerHttpError(503, "automatic deployment is not configured");
    }
  }

  private requireProjectPortalAdmin(): ProjectPortalAdmin {
    if (!this.projectPortalAdmin) {
      throw new ViewerHttpError(503, "Project portal control plane is unavailable");
    }
    return this.projectPortalAdmin;
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
    const expectedDefaultBranch = String(body.expectedDefaultBranch ?? "");
    const expectedDefaultHead = String(body.expectedDefaultHead ?? "");
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
      } else if (action === "push-default") {
        if (body.confirmed !== true) {
          throw new ViewerHttpError(400, "подтвердите публикацию в основную ветку origin");
        }
        repository = await context.inspector.pushHeadToDefault(
          expectedHead,
          expectedDefaultBranch,
          expectedDefaultHead,
        );
        message = repository.defaultBranch
          ? `Текущий HEAD опубликован в origin/${repository.defaultBranch} без перезаписи истории.`
          : "Текущий HEAD опубликован в основную ветку origin без перезаписи истории.";
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
          canPushDefault: false,
          defaultMessage: `${repository.defaultMessage} Дождитесь завершения активного Codex run.`,
          message: `${repository.message} Дождитесь завершения активного Codex run.`,
        }
      : verification
        ? {
            ...repository,
            canPush: repository.canPush && verification.write,
            canPull: repository.canPull && verification.read,
            canPushDefault: repository.canPushDefault && verification.write,
          }
        : context.credential
          ? { ...repository, canPush: false, canPull: false, canPushDefault: false }
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
    if (conversation.role === "observer") {
      throw new ViewerHttpError(
        410,
        "legacy observer conversation is retired; use its result publication context",
      );
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
