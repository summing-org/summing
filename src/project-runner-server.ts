import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  environmentRedactions,
  parseProjectEnvironment,
  ProjectEnvironmentConflictError,
  ProjectEnvironmentError,
  ProjectEnvironmentStore,
  runtimeEnvironmentText,
  type ParsedEnvironment,
} from "./project-environment.js";
import {
  currentEnvironmentVerification,
  importLegacyConnections,
  ProjectEnvironmentMigrationError,
  recordEnvironmentMigrationVerification,
  type EnvironmentMigrationMarker,
  type LegacyEnvironmentMigrationTarget,
} from "./project-environment-migration.js";
import {
  provisionedEnvironmentText,
  readProvisioningProfile,
  readProvisioningResult,
  type ProvisioningProfile,
} from "./project-provisioning.js";
import type {
  RunnerAction,
  RunnerArtifactDeletion,
  RunnerJob,
  RunnerJobTrigger,
  RunnerProjectRegistration,
} from "./project-runner-client.js";
import {
  SERVICE_NAME,
  serviceDefinition,
  serviceDefinitions,
  type RunnerService,
  type RunnerServiceAction,
  type RunnerServiceDefinition,
  type RunnerServiceDesiredState,
  type RunnerServiceRevision,
  type RunnerServiceStatus,
} from "./project-service.js";
import {
  RunnerPortalMessageError,
  RunnerPortalMessageStore,
} from "./runner-portal-messages.js";
import { SUMMING_VERSION } from "./version.js";

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WORKSPACE_ID = PROJECT_ID;
const JOB_ID = /^[0-9a-f-]{36}$/;
const SCHEDULE_ID = JOB_ID;
const IDEMPOTENCY_KEY = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const MAX_ARCHIVE_BYTES = 50_000_000;
const MAX_ARTIFACT_BYTES = 8_000_000;
const MAX_VIDEO_ARTIFACT_BYTES = 20_000_000;
const MAX_JSON_BYTES = 1_100_000;
const JOB_ARTIFACT_RETENTION = 30;
const RELEASE_PAYLOAD_RETENTION = 20;
const JOB_RETENTION = 100;
const RUNNER_ACTIONS = new Set<RunnerAction>(["build", "validate", "dry-run", "run", "provision"]);
const RUNNER_TRIGGERS = new Set<RunnerJobTrigger>(["manual", "schedule"]);
const SERVICE_ACTIONS = new Set<RunnerServiceAction>(["start", "stop", "restart", "rollback"]);
const SERVICE_MANIFEST_PATH = ".summing/services.json";
const SERVICE_DEPLOYMENT_RETENTION = 2;
const ARTIFACTS = new Map([
  ["manifest.json", "application/json"],
  ["sources.jsonl", "application/x-ndjson"],
  ["candidates.json", "application/json"],
  ["editorial-plan.json", "application/json"],
  ["errors.json", "application/json"],
  ["report.html", "text/html"],
  ["portal-messages.json", "application/json"],
]);
const VIDEO_ARTIFACT = /^video-(?:preview|0[1-9]|[1-4][0-9]|50)\.mp4$/;

function artifactContentType(name: string): string | null {
  return ARTIFACTS.get(name) ?? (VIDEO_ARTIFACT.test(name) ? "video/mp4" : null);
}

function maximumArtifactBytes(name: string): number {
  return VIDEO_ARTIFACT.test(name) ? MAX_VIDEO_ARTIFACT_BYTES : MAX_ARTIFACT_BYTES;
}

type RunnerProjectConfigSource =
  | { kind: "host"; path: string }
  | { kind: "snapshot"; paths: readonly string[] }
  | { kind: "optional-snapshot"; paths: readonly string[] };

interface RunnerProjectConfig {
  config: RunnerProjectConfigSource;
  dataPath: string;
  environmentBootstrap: ReadonlyMap<string, string>;
  network: boolean;
  workspaceIds: ReadonlySet<string> | null;
}

interface CommandResult {
  code: number;
  output: string;
}

interface RuntimeAccess {
  envPath: string | null;
  redactions: string[];
}

interface StoredServiceDeployment extends RunnerServiceRevision, RunnerServiceDefinition {
  containerName: string;
  hostPort: number | null;
  configSha256: string;
  environmentSha256?: string;
}

interface StoredServiceOperation {
  idempotencyKey: string;
  action: "deploy" | RunnerServiceAction;
  releaseId?: string;
}

interface StoredRunnerService {
  version: 1;
  projectId: string;
  workspaceId: string;
  name: string;
  desiredState: RunnerServiceDesiredState;
  status: RunnerServiceStatus;
  activeDeploymentId: string | null;
  deployments: StoredServiceDeployment[];
  lastOperation?: StoredServiceOperation;
  error?: string;
  updatedAt: string;
}

class RunnerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class RunnerCommandCancelledError extends Error {}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function safeAbsolutePath(value: unknown, name: string): string {
  const path = String(value ?? "");
  if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  return resolve(path);
}

function safeSnapshotPath(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._/-]+$/.test(value) || isAbsolute(value)) {
    throw new Error(`${name} must be a safe relative path`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${name} must be a safe relative path`);
  }
  return value;
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const announced = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(announced) || announced <= 0 || announced > MAX_JSON_BYTES) {
    throw new RunnerHttpError(413, "invalid JSON body size");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_JSON_BYTES) throw new RunnerHttpError(413, "JSON body is too large");
    chunks.push(buffer);
  }
  if (bytes !== announced) throw new RunnerHttpError(400, "JSON body is incomplete");
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new RunnerHttpError(400, "request body must be a JSON object");
  }
}

function run(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    logPath?: string;
    timeoutMs?: number;
    redactions?: string[];
    suppressOutput?: boolean;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    if (options.signal?.aborted) {
      reject(new RunnerCommandCancelledError("runner command cancelled"));
      return;
    }
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];
    let bytes = 0;
    const log = options.logPath
      ? createWriteStream(options.logPath, { flags: "a", mode: 0o600 })
      : null;
    const secrets = (options.redactions ?? []).filter(Boolean).sort((left, right) => right.length - left.length);
    let cancelled = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let pendingLog = "";
    const redact = (value: string): string => {
      let result = value;
      for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
      return result;
    };
    const emit = (value: string): void => {
      const safe = redact(value);
      log?.write(safe);
      if (bytes < 1_000_000) {
        bytes += Buffer.byteLength(safe);
        output.push(safe);
      }
    };
    const record = (chunk: Buffer): void => {
      if (options.suppressOutput) return;
      pendingLog += chunk.toString("utf8");
      const newline = pendingLog.lastIndexOf("\n");
      if (newline >= 0) {
        emit(pendingLog.slice(0, newline + 1));
        pendingLog = pendingLog.slice(newline + 1);
      }
      if (pendingLog.length > 1_000_000) {
        pendingLog = redact(pendingLog);
        const overlap = Math.min(
          Math.max(0, ...secrets.map((secret) => secret.length - 1)),
          262_143,
        );
        const split = Math.max(1, pendingLog.length - overlap);
        emit(pendingLog.slice(0, split));
        pendingLog = pendingLog.slice(split);
      }
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKillTimer.unref();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const cleanup = (): void => {
      options.signal?.removeEventListener("abort", cancel);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs ?? 600_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      cleanup();
      if (pendingLog) emit(pendingLog);
      log?.end();
      reject(cancelled ? new RunnerCommandCancelledError("runner command cancelled") : error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      cleanup();
      if (pendingLog) emit(pendingLog);
      log?.end();
      if (cancelled) {
        reject(new RunnerCommandCancelledError("runner command cancelled"));
      } else {
        resolveRun({ code: code ?? 1, output: output.join("") });
      }
    });
  });
}

export class ProjectRunnerServer {
  private server: Server | null = null;
  private readonly queue: RunnerJob[] = [];
  private readonly activeJobs = new Map<
    string,
    { job: RunnerJob; controller: AbortController }
  >();
  private readonly environments: ProjectEnvironmentStore;
  private readonly portalMessages: RunnerPortalMessageStore;
  private readonly runtimeEnvironmentRoot: string;
  private ready: boolean;
  private readonly migrationTargets: ReadonlyMap<string, LegacyEnvironmentMigrationTarget>;
  private readonly importedMigrations = new Set<string>();
  private readonly migrationImports = new Map<string, Promise<EnvironmentMigrationMarker>>();
  private readonly pendingSubmissions = new Map<string, Promise<RunnerJob>>();
  private readonly activeServiceOperations = new Set<string>();

  constructor(
    readonly socketPath: string,
    readonly dataRoot: string,
    readonly configRoot: string,
    readonly dockerBinary: string,
    environmentKey: Buffer,
    initiallyReady = true,
    migrationTargets: LegacyEnvironmentMigrationTarget[] = [],
    readonly migrationBrokerSocket = process.env.SUMMING_SECRETS_RUNTIME_SOCKET ||
      "/run/summing-secrets/runtime.sock",
    readonly managedDataRoot = resolve(dataRoot, "..", "managed-data"),
    readonly maxParallelJobs = 2,
    readonly runTimeoutHours = 12,
    readonly servicePortStart = 20_000,
    readonly servicePortEnd = 29_999,
  ) {
    if (!isAbsolute(socketPath) || basename(socketPath) !== "runner.sock") {
      throw new Error("runner socket must be an absolute runner.sock path");
    }
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    if (!isAbsolute(managedDataRoot)) {
      throw new Error("managed project data root must be an absolute path");
    }
    if (!Number.isSafeInteger(maxParallelJobs) || maxParallelJobs < 1 || maxParallelJobs > 16) {
      throw new Error("runner max parallel jobs must be an integer between 1 and 16");
    }
    if (!Number.isSafeInteger(runTimeoutHours) || runTimeoutHours < 1 || runTimeoutHours > 168) {
      throw new Error("runner run timeout must be an integer between 1 and 168 hours");
    }
    if (!Number.isSafeInteger(servicePortStart) || !Number.isSafeInteger(servicePortEnd) ||
      servicePortStart < 1_024 || servicePortEnd > 65_535 || servicePortStart > servicePortEnd ||
      servicePortEnd - servicePortStart > 20_000) {
      throw new Error("runner service port range must contain at most 20001 ports between 1024 and 65535");
    }
    mkdirSync(this.managedConfigRoot(), { recursive: true, mode: 0o700 });
    this.environments = new ProjectEnvironmentStore(resolve(dataRoot, "environments"), environmentKey);
    this.portalMessages = new RunnerPortalMessageStore(dataRoot);
    this.ready = initiallyReady;
    this.migrationTargets = new Map(
      migrationTargets.map((target) => [this.migrationKey(target.projectId, target.workspaceId), target]),
    );
    this.runtimeEnvironmentRoot = resolve(socketPath, "..", "environments");
    mkdirSync(this.runtimeEnvironmentRoot, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(this.runtimeEnvironmentRoot)) {
      if (!/^[0-9a-f-]{36}\.env$/.test(entry)) continue;
      const path = resolve(this.runtimeEnvironmentRoot, entry);
      const metadata = lstatSync(path);
      if (metadata.isFile() && !metadata.isSymbolicLink()) rmSync(path);
    }
    this.recoverInterruptedJobs();
    this.pruneStoredJobDirectories();
  }

  markReady(): void {
    this.ready = true;
  }

  async start(): Promise<void> {
    if (this.server) return;
    if (existsSync(this.socketPath)) {
      const metadata = lstatSync(this.socketPath);
      if (!metadata.isSocket()) throw new Error(`refusing to replace non-socket ${this.socketPath}`);
      rmSync(this.socketPath);
    }
    mkdirSync(resolve(this.socketPath, ".."), { recursive: true, mode: 0o750 });
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => this.report(response, error));
    });
    await new Promise<void>((resolveStart, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        chmodSync(this.socketPath, 0o660);
        resolveStart();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    if (server.listening) {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    }
    if (existsSync(this.socketPath) && lstatSync(this.socketPath).isSocket()) rmSync(this.socketPath);
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://runner.local");
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, this.ready ? 200 : 503, {
        ok: this.ready,
        version: SUMMING_VERSION,
        protocolVersion: 5,
        queued: this.queue.length,
        running: this.activeJobs.size,
        maxParallelJobs: this.maxParallelJobs,
        runTimeoutHours: this.runTimeoutHours,
        servicePortRange: [this.servicePortStart, this.servicePortEnd],
      });
      return;
    }
    if (url.pathname === "/projects" && (request.method === "GET" || request.method === "PUT")) {
      const projectId = url.searchParams.get("project") ?? "";
      if (!PROJECT_ID.test(projectId)) {
        throw new RunnerHttpError(400, "invalid runner project id");
      }
      if (request.method === "PUT") {
        const body = await jsonBody(request);
        if (Object.keys(body).some((key) => key !== "workspaceIds")) {
          throw new RunnerHttpError(400, "runner project registration contains unsupported fields");
        }
        if (!Array.isArray(body.workspaceIds) || body.workspaceIds.length === 0 ||
          body.workspaceIds.length > 100) {
          throw new RunnerHttpError(400, "workspaceIds must contain 1-100 workspace ids");
        }
        const workspaceIds = body.workspaceIds.map((value) => String(value));
        if (workspaceIds.some((workspaceId) => !WORKSPACE_ID.test(workspaceId)) ||
          new Set(workspaceIds).size !== workspaceIds.length) {
          throw new RunnerHttpError(400, "workspaceIds contain invalid or duplicate ids");
        }
        json(response, 200, {
          project: this.registerManagedProject(projectId, workspaceIds),
        });
        return;
      }
      json(response, 200, { project: this.projectRegistration(projectId) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/migration/import") {
      const target = this.migrationTarget(url);
      const body = await jsonBody(request);
      if (typeof body.manifest !== "string") {
        throw new RunnerHttpError(400, "pinned migration manifest is required");
      }
      const marker = await this.importMigration(target, body.manifest);
      const verified = currentEnvironmentVerification(
        resolve(target.stateRoot, "verified.json"),
        target.projectId,
        target.workspaceId,
        target.revision,
        this.environments,
      );
      json(response, 200, {
        migration: {
          projectId: target.projectId,
          workspaceId: target.workspaceId,
          environmentRevision: marker.environmentRevision,
          variableNames: marker.variableNames,
          verified,
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/migration/verify") {
      const target = this.migrationTarget(url);
      const body = await jsonBody(request);
      const validateJobId = String(body.validateJobId ?? "");
      const dryRunJobId = String(body.dryRunJobId ?? "");
      if (!JOB_ID.test(validateJobId) || !JOB_ID.test(dryRunJobId)) {
        throw new RunnerHttpError(400, "migration verification job ids are invalid");
      }
      const result = recordEnvironmentMigrationVerification({
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        revision: target.revision,
        markerPath: resolve(target.stateRoot, "verified.json"),
        store: this.environments,
        validateJob: this.storedJob(target.projectId, validateJobId),
        dryRunJob: this.storedJob(target.projectId, dryRunJobId),
      });
      json(response, 200, { verification: { status: result.status, ...result.marker } });
      return;
    }
    if (url.pathname === "/environment" && (request.method === "GET" || request.method === "PUT")) {
      const projectId = url.searchParams.get("project") ?? "";
      const workspaceId = url.searchParams.get("workspace") ?? "";
      if (!PROJECT_ID.test(projectId) || !WORKSPACE_ID.test(workspaceId)) {
        throw new RunnerHttpError(400, "invalid environment scope");
      }
      const project = this.projectConfig(projectId, workspaceId);
      if (request.method === "GET") {
        json(response, 200, {
          environment: this.environments.ensure(
            projectId,
            workspaceId,
            project.environmentBootstrap.get(workspaceId),
          ),
        });
        return;
      }
      const body = await jsonBody(request);
      const text = body.text;
      const expectedRevision = body.expectedRevision;
      if (typeof text !== "string" || typeof expectedRevision !== "number") {
        throw new RunnerHttpError(400, "text and expectedRevision are required");
      }
      json(response, 200, {
        environment: this.environments.save(projectId, workspaceId, text, expectedRevision),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/services") {
      const { projectId, workspaceId } = this.serviceScope(url);
      json(response, 200, { services: await this.listServices(projectId, workspaceId) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/services/deploy") {
      const { projectId, workspaceId } = this.serviceScope(url);
      const body = await jsonBody(request);
      if (Object.keys(body).some((key) => !["name", "releaseId", "idempotencyKey"].includes(key))) {
        throw new RunnerHttpError(400, "service deployment contains unsupported fields");
      }
      const name = String(body.name ?? "");
      const releaseId = String(body.releaseId ?? "");
      const idempotencyKey = String(body.idempotencyKey ?? "");
      if (!SERVICE_NAME.test(name) || !JOB_ID.test(releaseId) || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw new RunnerHttpError(400, "invalid service deployment request");
      }
      json(response, 200, {
        service: await this.deployService(projectId, workspaceId, name, releaseId, idempotencyKey),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/services/action") {
      const { projectId, workspaceId } = this.serviceScope(url);
      const body = await jsonBody(request);
      if (Object.keys(body).some((key) => !["name", "action", "idempotencyKey"].includes(key))) {
        throw new RunnerHttpError(400, "service action contains unsupported fields");
      }
      const name = String(body.name ?? "");
      const action = String(body.action ?? "") as RunnerServiceAction;
      const idempotencyKey = String(body.idempotencyKey ?? "");
      if (!SERVICE_NAME.test(name) || !SERVICE_ACTIONS.has(action) ||
        !IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw new RunnerHttpError(400, "invalid service action request");
      }
      json(response, 200, {
        service: await this.changeService(
          projectId,
          workspaceId,
          name,
          action,
          idempotencyKey,
        ),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/service-log") {
      const { projectId, workspaceId } = this.serviceScope(url);
      const name = url.searchParams.get("name") ?? "";
      if (!SERVICE_NAME.test(name)) throw new RunnerHttpError(400, "invalid service name");
      json(response, 200, { log: await this.readServiceLog(projectId, workspaceId, name) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/jobs") {
      const projectId = url.searchParams.get("project") ?? "";
      const workspaceId = url.searchParams.get("workspace") ?? "";
      const action = url.searchParams.get("action") as RunnerAction;
      const revision = url.searchParams.get("revision") ?? "";
      const trigger = (url.searchParams.get("trigger") ?? "manual") as RunnerJobTrigger;
      const scheduleId = url.searchParams.get("schedule") ?? "";
      const scheduledFor = url.searchParams.get("scheduled_for") ?? "";
      const idempotencyKey = url.searchParams.get("idempotency_key") ?? "";
      const provisionId = url.searchParams.get("provision") ?? "";
      if (!PROJECT_ID.test(projectId) || !WORKSPACE_ID.test(workspaceId)) {
        throw new RunnerHttpError(400, "invalid project or workspace id");
      }
      if (!RUNNER_ACTIONS.has(action)) {
        throw new RunnerHttpError(400, "invalid runner action");
      }
      if (!REVISION.test(revision)) throw new RunnerHttpError(400, "invalid revision");
      if (!RUNNER_TRIGGERS.has(trigger)) throw new RunnerHttpError(400, "invalid runner trigger");
      if (idempotencyKey && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw new RunnerHttpError(400, "invalid idempotency key");
      }
      if (action === "provision") {
        if (trigger !== "manual" || !PROJECT_ID.test(provisionId)) {
          throw new RunnerHttpError(400, "provision action requires one valid manual profile");
        }
      } else if (provisionId) {
        throw new RunnerHttpError(400, "provision profile requires provision action");
      }
      if (trigger === "schedule") {
        if (!SCHEDULE_ID.test(scheduleId) || !scheduledFor || !Number.isFinite(Date.parse(scheduledFor))) {
          throw new RunnerHttpError(400, "invalid runner schedule metadata");
        }
      } else if (scheduleId || scheduledFor) {
        throw new RunnerHttpError(400, "manual jobs cannot contain schedule metadata");
      }
      const commonMetadata = {
        projectId,
        workspaceId,
        action,
        revision,
        trigger,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(provisionId ? { provisionId } : {}),
      };
      const metadata: Omit<RunnerJob, "id" | "status" | "createdAt"> = trigger === "schedule"
        ? { ...commonMetadata, scheduleId, scheduledFor: new Date(scheduledFor).toISOString() }
        : commonMetadata;
      if (!idempotencyKey) {
        json(response, 202, {
          job: await this.acceptJob(request, this.projectConfig(projectId, workspaceId), metadata),
        });
        return;
      }
      const submissionKey = `${projectId}\0${workspaceId}\0${idempotencyKey}`;
      const existing = this.idempotentJob(projectId, workspaceId, idempotencyKey);
      if (existing) {
        await this.discardArchive(request);
        this.assertSameSubmission(existing, metadata);
        json(response, 200, { job: existing, deduplicated: true });
        return;
      }
      const pending = this.pendingSubmissions.get(submissionKey);
      if (pending) {
        await this.discardArchive(request);
        const job = await pending;
        this.assertSameSubmission(job, metadata);
        json(response, 200, { job, deduplicated: true });
        return;
      }
      const submission = this.acceptJob(
        request,
        this.projectConfig(projectId, workspaceId),
        metadata,
      );
      this.pendingSubmissions.set(submissionKey, submission);
      try {
        json(response, 202, { job: await submission });
      } finally {
        if (this.pendingSubmissions.get(submissionKey) === submission) {
          this.pendingSubmissions.delete(submissionKey);
        }
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/jobs/replay") {
      const projectId = url.searchParams.get("project") ?? "";
      const workspaceId = url.searchParams.get("workspace") ?? "";
      const sourceJobId = url.searchParams.get("job") ?? "";
      const idempotencyKey = url.searchParams.get("idempotency_key") ?? "";
      if (
        !PROJECT_ID.test(projectId) ||
        !WORKSPACE_ID.test(workspaceId) ||
        !JOB_ID.test(sourceJobId) ||
        !IDEMPOTENCY_KEY.test(idempotencyKey)
      ) {
        throw new RunnerHttpError(400, "invalid runner replay scope");
      }
      this.projectConfig(projectId, workspaceId);
      const source = this.storedJob(projectId, sourceJobId);
      if ((source.workspaceId ?? "repo") !== workspaceId) {
        throw new RunnerHttpError(404, "runner release was not found in this workspace");
      }
      const existing = this.idempotentJob(projectId, workspaceId, idempotencyKey);
      if (existing) {
        if (existing.trigger !== "replay" || existing.replayOfJobId !== sourceJobId) {
          throw new RunnerHttpError(409, "idempotency key was reused for a different runner job");
        }
        json(response, 200, { job: existing, deduplicated: true });
        return;
      }
      json(response, 202, { job: this.replayJob(source, idempotencyKey) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/jobs/cancel") {
      const projectId = url.searchParams.get("project") ?? "";
      const workspaceId = url.searchParams.get("workspace") ?? "";
      const jobId = url.searchParams.get("job") ?? "";
      if (
        !PROJECT_ID.test(projectId) ||
        !WORKSPACE_ID.test(workspaceId) ||
        !JOB_ID.test(jobId)
      ) {
        throw new RunnerHttpError(400, "invalid runner cancellation scope");
      }
      this.projectConfig(projectId, workspaceId);
      json(response, 200, { job: await this.cancelJob(projectId, workspaceId, jobId) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/jobs") {
      const projectId = url.searchParams.get("project") ?? "";
      const workspaceId = url.searchParams.get("workspace") ?? "";
      if (!PROJECT_ID.test(projectId) || !WORKSPACE_ID.test(workspaceId)) {
        throw new RunnerHttpError(400, "invalid project or workspace id");
      }
      this.projectConfig(projectId, workspaceId);
      json(response, 200, { jobs: this.listJobs(projectId, workspaceId) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/logs") {
      const projectId = url.searchParams.get("project") ?? "";
      const jobId = url.searchParams.get("job") ?? "";
      if (!PROJECT_ID.test(projectId) || !JOB_ID.test(jobId)) {
        throw new RunnerHttpError(400, "invalid job log identifier");
      }
      this.projectConfig(projectId);
      const logPath = resolve(this.jobDirectory(projectId, jobId), "job.log");
      const content = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0);
      json(response, 200, { log: content.subarray(Math.max(0, content.length - 1_000_000)).toString("utf8") });
      return;
    }
    if (request.method === "GET" && url.pathname === "/artifacts") {
      const { jobId, project } = this.artifactScope(url);
      json(response, 200, { artifacts: this.listArtifacts(jobId, project) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/portal/messages") {
      const projectId = url.searchParams.get("project") ?? "";
      const workspaceId = url.searchParams.get("workspace") ?? "";
      const jobId = url.searchParams.get("job") ?? "";
      if (!PROJECT_ID.test(projectId) || !WORKSPACE_ID.test(workspaceId) || !JOB_ID.test(jobId)) {
        throw new RunnerHttpError(400, "invalid portal message scope");
      }
      this.projectConfig(projectId, workspaceId);
      const job = this.storedJob(projectId, jobId);
      if (
        job.workspaceId !== workspaceId ||
        (job.action !== "dry-run" && job.action !== "run")
      ) {
        throw new RunnerHttpError(404, "portal messages were not found for this job");
      }
      const batch = this.portalMessages.byJob(projectId, workspaceId, jobId);
      if (!batch) throw new RunnerHttpError(404, "portal messages were not found for this job");
      json(response, 200, { batch });
      return;
    }
    if (request.method === "GET" && url.pathname === "/artifact/data") {
      const { jobId, project } = this.artifactScope(url);
      const name = url.searchParams.get("name") ?? "";
      const contentType = artifactContentType(name);
      if (!contentType) throw new RunnerHttpError(400, "invalid artifact name");
      const directory = this.safeArtifactDirectory(project, jobId);
      if (!directory) throw new RunnerHttpError(404, "artifact not found");
      const path = resolve(directory, name);
      if (!existsSync(path)) throw new RunnerHttpError(404, "artifact not found");
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new RunnerHttpError(404, "artifact not found");
      }
      if (metadata.size <= 0 || metadata.size > maximumArtifactBytes(name)) {
        throw new RunnerHttpError(413, "artifact exceeds its delivery size limit");
      }
      response.statusCode = 200;
      response.setHeader("content-type", contentType);
      response.setHeader("content-length", String(metadata.size));
      response.end(readFileSync(path));
      return;
    }
    if (request.method === "GET" && url.pathname === "/artifact") {
      const { projectId, jobId, project } = this.artifactScope(url);
      const name = url.searchParams.get("name") ?? "";
      const contentType = artifactContentType(name);
      if (!contentType) throw new RunnerHttpError(400, "invalid artifact name");
      if (contentType === "video/mp4") {
        throw new RunnerHttpError(415, "binary artifact is not available as text");
      }
      const directory = this.safeArtifactDirectory(project, jobId);
      if (!directory) throw new RunnerHttpError(404, "artifact not found");
      const path = resolve(directory, name);
      if (!existsSync(path)) throw new RunnerHttpError(404, "artifact not found");
      const metadata = lstatSync(path);
      if (!metadata.isFile()) throw new RunnerHttpError(404, "artifact not found");
      if (metadata.size > maximumArtifactBytes(name)) {
        throw new RunnerHttpError(413, "artifact exceeds 8 MB");
      }
      json(response, 200, {
        artifact: { name, bytes: metadata.size, contentType, content: readFileSync(path, "utf8") },
      });
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/artifact") {
      const workspaceId = url.searchParams.get("workspace") ?? "";
      if (!WORKSPACE_ID.test(workspaceId)) {
        throw new RunnerHttpError(400, "invalid artifact workspace");
      }
      const { projectId, jobId, project, job } = this.artifactScope(url);
      if ((job.workspaceId ?? "repo") !== workspaceId) {
        throw new RunnerHttpError(404, "dry-run artifacts are not available for this workspace");
      }
      if (job.status === "queued" || job.status === "running" || job.status === "cancelling") {
        throw new RunnerHttpError(409, "artifacts cannot be deleted while the job is active");
      }
      const name = url.searchParams.get("name") ?? "";
      const deleted = this.trashArtifact(projectId, jobId, name, project);
      json(response, 200, { deleted });
      return;
    }
    throw new RunnerHttpError(404, "not found");
  }

  private async receiveArchive(request: IncomingMessage, path: string): Promise<string> {
    const announced = Number(request.headers["content-length"] ?? 0);
    if (!Number.isSafeInteger(announced) || announced <= 0 || announced > MAX_ARCHIVE_BYTES) {
      throw new RunnerHttpError(413, "invalid source archive size");
    }
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_ARCHIVE_BYTES) throw new RunnerHttpError(413, "source archive is too large");
        digest.update(buffer);
        if (!output.write(buffer)) {
          await new Promise<void>((resolveDrain) => output.once("drain", resolveDrain));
        }
      }
    } finally {
      await new Promise<void>((resolveEnd) => output.end(resolveEnd));
    }
    if (bytes !== announced) throw new RunnerHttpError(400, "source archive is incomplete");
    return digest.digest("hex");
  }

  private async discardArchive(request: IncomingMessage): Promise<void> {
    const announced = Number(request.headers["content-length"] ?? 0);
    if (!Number.isSafeInteger(announced) || announced <= 0 || announced > MAX_ARCHIVE_BYTES) {
      throw new RunnerHttpError(413, "invalid source archive size");
    }
    let bytes = 0;
    for await (const chunk of request) {
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (bytes > MAX_ARCHIVE_BYTES) {
        throw new RunnerHttpError(413, "source archive is too large");
      }
    }
    if (bytes !== announced) throw new RunnerHttpError(400, "source archive is incomplete");
  }

  private async acceptJob(
    request: IncomingMessage,
    project: RunnerProjectConfig,
    metadata: Omit<RunnerJob, "id" | "status" | "createdAt">,
  ): Promise<RunnerJob> {
    const job: RunnerJob = {
      id: randomUUID(),
      ...metadata,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    if (job.action !== "provision") job.releaseId = job.id;
    const directory = this.jobDirectory(job.projectId, job.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      job.archiveSha256 = await this.receiveArchive(request, resolve(directory, "source.tar"));
      if (job.action !== "build") {
        job.environmentRevision = this.environments.writeJobSnapshot(
          job.projectId,
          job.workspaceId,
          job.releaseId ?? job.id,
          resolve(directory, "environment.json"),
          project.environmentBootstrap.get(job.workspaceId),
        );
        const environmentPath = resolve(directory, "environment.json");
        if (existsSync(environmentPath)) job.environmentSha256 = this.fileSha256(environmentPath);
      }
      this.saveJob(job);
      this.queue.push(job);
      void this.processQueue();
      return job;
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private idempotentJob(
    projectId: string,
    workspaceId: string,
    idempotencyKey: string,
  ): RunnerJob | null {
    const directory = resolve(this.dataRoot, "projects", projectId, "runs");
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return null;
    for (const entry of readdirSync(directory)) {
      if (!JOB_ID.test(entry)) continue;
      try {
        const job = JSON.parse(
          readFileSync(resolve(directory, entry, "job.json"), "utf8"),
        ) as RunnerJob;
        if (
          job.id === entry &&
          job.projectId === projectId &&
          (job.workspaceId ?? "repo") === workspaceId &&
          job.idempotencyKey === idempotencyKey
        ) {
          return { ...job, trigger: job.trigger ?? "manual" };
        }
      } catch {
        // Malformed operator-recovery state is intentionally ignored.
      }
    }
    return null;
  }

  private fileSha256(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  private assertReleaseFile(path: string, expectedSha256?: string): void {
    if (!existsSync(path)) throw new RunnerHttpError(409, "release payload has expired");
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new RunnerHttpError(409, "release payload is unsafe");
    }
    if (expectedSha256 && this.fileSha256(path) !== expectedSha256) {
      throw new RunnerHttpError(409, "release payload integrity check failed");
    }
  }

  private replayJob(
    source: RunnerJob,
    idempotencyKey: string,
  ): RunnerJob {
    if (source.status === "queued" || source.status === "running" || source.status === "cancelling") {
      throw new RunnerHttpError(409, "an active runner job cannot be replayed");
    }
    if (source.action === "build") {
      throw new RunnerHttpError(409, "build-only jobs are not replayable releases");
    }
    if (source.action === "provision") {
      throw new RunnerHttpError(409, "provisioning jobs are intentionally not replayable");
    }
    if (
      !source.releaseId ||
      !source.archiveSha256 ||
      !source.configSha256 ||
      !Number.isSafeInteger(source.environmentRevision) ||
      Number(source.environmentRevision) < 0 ||
      !source.imageId
    ) {
      throw new RunnerHttpError(409, "runner job does not contain a complete release snapshot");
    }
    const environmentRevision = Number(source.environmentRevision);
    const sourceDirectory = this.jobDirectory(source.projectId, source.id);
    const sourceArchive = resolve(sourceDirectory, "source.tar");
    const sourceConfig = resolve(sourceDirectory, "release-config.json");
    const sourceEnvironment = resolve(sourceDirectory, "environment.json");
    this.assertReleaseFile(sourceArchive, source.archiveSha256);
    this.assertReleaseFile(sourceConfig, source.configSha256);
    if (source.environmentSha256) {
      this.assertReleaseFile(sourceEnvironment, source.environmentSha256);
    } else if (existsSync(sourceEnvironment)) {
      throw new RunnerHttpError(409, "release environment integrity metadata is missing");
    }

    const job: RunnerJob = {
      id: randomUUID(),
      releaseId: source.releaseId,
      replayOfJobId: source.id,
      projectId: source.projectId,
      workspaceId: source.workspaceId,
      action: source.action,
      revision: source.revision,
      archiveSha256: source.archiveSha256,
      configSha256: source.configSha256,
      imageId: source.imageId,
      environmentRevision,
      trigger: "replay",
      idempotencyKey,
      status: "queued",
      createdAt: new Date().toISOString(),
      ...(source.environmentSha256 ? { environmentSha256: source.environmentSha256 } : {}),
    };
    const directory = this.jobDirectory(job.projectId, job.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      copyFileSync(sourceArchive, resolve(directory, "source.tar"), constants.COPYFILE_EXCL);
      copyFileSync(sourceConfig, resolve(directory, "release-config.json"), constants.COPYFILE_EXCL);
      if (source.environmentSha256) {
        copyFileSync(
          sourceEnvironment,
          resolve(directory, "environment.json"),
          constants.COPYFILE_EXCL,
        );
      }
      for (const file of [
        "source.tar",
        "release-config.json",
        ...(source.environmentSha256 ? ["environment.json"] : []),
      ]) {
        chmodSync(resolve(directory, file), 0o600);
      }
      this.saveJob(job);
      this.queue.push(job);
      this.processQueue();
      return job;
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private assertSameSubmission(
    job: RunnerJob,
    expected: Omit<RunnerJob, "id" | "status" | "createdAt">,
  ): void {
    if (
      job.projectId !== expected.projectId ||
      (job.workspaceId ?? "repo") !== expected.workspaceId ||
      job.action !== expected.action ||
      (job.trigger ?? "manual") !== expected.trigger ||
      (job.scheduleId ?? "") !== (expected.scheduleId ?? "") ||
      (job.scheduledFor ?? "") !== (expected.scheduledFor ?? "") ||
      (job.provisionId ?? "") !== (expected.provisionId ?? "")
    ) {
      throw new RunnerHttpError(409, "idempotency key was reused for a different runner job");
    }
  }

  private managedConfigRoot(): string {
    return resolve(this.dataRoot, "managed-projects");
  }

  private staticProjectConfigPath(projectId: string): string {
    return resolve(this.configRoot, `${projectId}.json`);
  }

  private managedProjectConfigPath(projectId: string): string {
    return resolve(this.managedConfigRoot(), `${projectId}.json`);
  }

  private registerManagedProject(
    projectId: string,
    workspaceIds: string[],
  ): RunnerProjectRegistration {
    const staticPath = this.staticProjectConfigPath(projectId);
    if (existsSync(staticPath)) {
      this.projectConfig(projectId);
      return { projectId, workspaceIds, source: "static" };
    }
    const path = this.managedProjectConfigPath(projectId);
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
      throw new RunnerHttpError(500, "managed runner project config is unsafe");
    }
    const value = {
      kind: "managed",
      projectId,
      workspaceIds,
      configSourcePaths: ["config.json", "config.example.json"],
      dataPath: resolve(this.managedDataRoot, projectId, "data"),
      network: true,
    };
    const temporaryPath = resolve(
      this.managedConfigRoot(),
      `.${projectId}-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      const descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, path);
      const directoryDescriptor = openSync(this.managedConfigRoot(), constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
    return { projectId, workspaceIds, source: "managed" };
  }

  private projectRegistration(projectId: string): RunnerProjectRegistration {
    const staticPath = this.staticProjectConfigPath(projectId);
    const path = existsSync(staticPath) ? staticPath : this.managedProjectConfigPath(projectId);
    if (!existsSync(path)) throw new RunnerHttpError(404, "runner project is not configured");
    this.projectConfig(projectId);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const workspaceIds = Array.isArray(raw.workspaceIds)
      ? raw.workspaceIds.map((value) => String(value))
      : [];
    return {
      projectId,
      workspaceIds,
      source: path === staticPath ? "static" : "managed",
    };
  }

  private projectConfig(projectId: string, workspaceId?: string): RunnerProjectConfig {
    const staticPath = this.staticProjectConfigPath(projectId);
    const managedPath = this.managedProjectConfigPath(projectId);
    const path = existsSync(staticPath) ? staticPath : managedPath;
    if (!existsSync(path)) throw new RunnerHttpError(404, "runner project is not configured");
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new RunnerHttpError(500, "runner project config is unsafe");
    }
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    let workspaceIds: Set<string> | null = null;
    if (path === managedPath) {
      const allowedKeys = new Set([
        "kind",
        "projectId",
        "workspaceIds",
        "configSourcePaths",
        "dataPath",
        "network",
      ]);
      if (raw.kind !== "managed" || raw.projectId !== projectId ||
        Object.keys(raw).some((key) => !allowedKeys.has(key)) ||
        !Array.isArray(raw.workspaceIds) || raw.workspaceIds.length === 0 ||
        raw.workspaceIds.some((value) => typeof value !== "string" || !WORKSPACE_ID.test(value)) ||
        !Array.isArray(raw.configSourcePaths) || raw.configSourcePaths.length !== 2 ||
        raw.configSourcePaths[0] !== "config.json" ||
        raw.configSourcePaths[1] !== "config.example.json" ||
        raw.dataPath !== resolve(this.managedDataRoot, projectId, "data") ||
        raw.network !== true) {
        throw new Error("managed runner project config is invalid");
      }
      workspaceIds = new Set(raw.workspaceIds as string[]);
      if (workspaceIds.size !== raw.workspaceIds.length) {
        throw new Error("managed runner project workspaces contain duplicates");
      }
      if (workspaceId && !workspaceIds.has(workspaceId)) {
        throw new RunnerHttpError(404, "runner workspace is not configured");
      }
    }
    const bootstrapValue = raw.environmentBootstrap;
    const environmentBootstrap = new Map<string, string>();
    if (bootstrapValue !== undefined) {
      if (!bootstrapValue || typeof bootstrapValue !== "object" || Array.isArray(bootstrapValue)) {
        throw new Error("environmentBootstrap must be an object of workspace paths");
      }
      for (const [workspaceId, bootstrapPath] of Object.entries(bootstrapValue)) {
        if (!WORKSPACE_ID.test(workspaceId)) {
          throw new Error("environmentBootstrap contains an invalid workspace id");
        }
        environmentBootstrap.set(
          workspaceId,
          safeAbsolutePath(bootstrapPath, `environmentBootstrap.${workspaceId}`),
        );
      }
    }
    if (raw.envPath !== undefined && !environmentBootstrap.has("repo")) {
      environmentBootstrap.set("repo", safeAbsolutePath(raw.envPath, "envPath"));
    }
    const hostConfig = raw.configPath === undefined
      ? null
      : safeAbsolutePath(raw.configPath, "configPath");
    let snapshotConfigs: string[] | null = null;
    if (raw.configSourcePaths !== undefined) {
      if (!Array.isArray(raw.configSourcePaths) || raw.configSourcePaths.length === 0 ||
        raw.configSourcePaths.length > 10) {
        throw new Error("configSourcePaths must contain 1-10 relative paths");
      }
      snapshotConfigs = raw.configSourcePaths.map((value, index) =>
        safeSnapshotPath(value, `configSourcePaths[${index}]`));
      if (new Set(snapshotConfigs).size !== snapshotConfigs.length) {
        throw new Error("configSourcePaths must not contain duplicates");
      }
    }
    if ((hostConfig === null) === (snapshotConfigs === null)) {
      throw new Error("exactly one of configPath or configSourcePaths is required");
    }
    return {
      config: hostConfig === null
        ? {
            kind: path === managedPath ? "optional-snapshot" : "snapshot",
            paths: snapshotConfigs!,
          }
        : { kind: "host", path: hostConfig },
      dataPath: safeAbsolutePath(raw.dataPath, "dataPath"),
      environmentBootstrap,
      network: raw.network === true,
      workspaceIds,
    };
  }

  private serviceScope(url: URL): { projectId: string; workspaceId: string } {
    const projectId = url.searchParams.get("project") ?? "";
    const workspaceId = url.searchParams.get("workspace") ?? "";
    if (!PROJECT_ID.test(projectId) || !WORKSPACE_ID.test(workspaceId)) {
      throw new RunnerHttpError(400, "invalid service scope");
    }
    this.projectConfig(projectId, workspaceId);
    return { projectId, workspaceId };
  }

  private servicesRoot(projectId: string, workspaceId: string): string {
    return resolve(this.dataRoot, "projects", projectId, "services", workspaceId);
  }

  private serviceRoot(projectId: string, workspaceId: string, name: string): string {
    return resolve(this.servicesRoot(projectId, workspaceId), name);
  }

  private serviceStatePath(projectId: string, workspaceId: string, name: string): string {
    return resolve(this.serviceRoot(projectId, workspaceId, name), "service.json");
  }

  private serviceDeploymentDirectory(
    projectId: string,
    workspaceId: string,
    name: string,
    deploymentId: string,
  ): string {
    return resolve(this.serviceRoot(projectId, workspaceId, name), "deployments", deploymentId);
  }

  private storedService(
    projectId: string,
    workspaceId: string,
    name: string,
    required = true,
  ): StoredRunnerService | null {
    const path = this.serviceStatePath(projectId, workspaceId, name);
    if (!existsSync(path)) {
      if (required) throw new RunnerHttpError(404, "runner service is not configured");
      return null;
    }
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new RunnerHttpError(409, "runner service state is unsafe");
    }
    let state: StoredRunnerService;
    try {
      state = JSON.parse(readFileSync(path, "utf8")) as StoredRunnerService;
    } catch {
      throw new RunnerHttpError(409, "runner service state is malformed");
    }
    const desiredStates = new Set<RunnerServiceDesiredState>(["running", "stopped"]);
    const statuses = new Set<RunnerServiceStatus>([
      "deploying", "running", "stopped", "unhealthy", "failed",
    ]);
    const deploymentsValid = Array.isArray(state.deployments) &&
      state.deployments.length <= SERVICE_DEPLOYMENT_RETENTION &&
      state.deployments.every((deployment) => {
        if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) return false;
        const deploymentId = String(deployment.deploymentId ?? "");
        const expectedContainerName =
          `summing-svc-${projectId}-${workspaceId}-${name}-${deploymentId.slice(0, 8)}`;
        return JOB_ID.test(deployment.deploymentId) && JOB_ID.test(deployment.releaseId) &&
          REVISION.test(deployment.revision) &&
          typeof deployment.imageId === "string" && deployment.imageId.length <= 255 &&
          /^[A-Za-z0-9:_.@/-]+$/.test(deployment.imageId) &&
          Number.isSafeInteger(deployment.environmentRevision) && deployment.environmentRevision >= 0 &&
          Number.isFinite(Date.parse(deployment.deployedAt)) &&
          deployment.containerName === expectedContainerName &&
          (deployment.hostPort === null ||
            (Number.isSafeInteger(deployment.hostPort) && deployment.hostPort >= 1_024 &&
              deployment.hostPort <= 65_535)) &&
          /^[0-9a-f]{64}$/.test(deployment.configSha256) &&
          (deployment.environmentSha256 === undefined ||
            /^[0-9a-f]{64}$/.test(deployment.environmentSha256)) &&
          Array.isArray(deployment.command) && deployment.command.length <= 32 &&
          deployment.command.every((part) => typeof part === "string" && part.length > 0 &&
            part.length <= 1_024) &&
          (deployment.containerPort === null ||
            (Number.isSafeInteger(deployment.containerPort) && deployment.containerPort >= 1 &&
              deployment.containerPort <= 65_535)) &&
          (deployment.healthPath === null ||
            (deployment.containerPort !== null &&
              /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,255}$/.test(deployment.healthPath))) &&
          Number.isSafeInteger(deployment.startupTimeoutSeconds) &&
          deployment.startupTimeoutSeconds >= 5 && deployment.startupTimeoutSeconds <= 300;
      });
    const operationValid = state.lastOperation === undefined ||
      (state.lastOperation !== null && typeof state.lastOperation === "object" &&
        IDEMPOTENCY_KEY.test(state.lastOperation.idempotencyKey) &&
        (state.lastOperation.action === "deploy" || SERVICE_ACTIONS.has(state.lastOperation.action)) &&
        (state.lastOperation.releaseId === undefined || JOB_ID.test(state.lastOperation.releaseId)));
    if (state.version !== 1 || state.projectId !== projectId || state.workspaceId !== workspaceId ||
      state.name !== name || !SERVICE_NAME.test(state.name) ||
      !desiredStates.has(state.desiredState) || !statuses.has(state.status) ||
      !deploymentsValid ||
      new Set(state.deployments.map((deployment) => deployment.deploymentId)).size !==
        state.deployments.length ||
      !operationValid || !Number.isFinite(Date.parse(state.updatedAt)) ||
      (state.error !== undefined && typeof state.error !== "string") ||
      (state.activeDeploymentId !== null &&
        !state.deployments.some((deployment) => deployment.deploymentId === state.activeDeploymentId))) {
      throw new RunnerHttpError(409, "runner service state is invalid");
    }
    return state;
  }

  private saveService(state: StoredRunnerService): void {
    const path = this.serviceStatePath(state.projectId, state.workspaceId, state.name);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = resolve(directory, `.service-${process.pid}-${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, path);
      const directoryDescriptor = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private activeServiceDeployment(state: StoredRunnerService): StoredServiceDeployment | null {
    return state.activeDeploymentId
      ? state.deployments.find((deployment) => deployment.deploymentId === state.activeDeploymentId) ?? null
      : null;
  }

  private serviceRevision(deployment: StoredServiceDeployment | null): RunnerServiceRevision | null {
    if (!deployment) return null;
    return {
      deploymentId: deployment.deploymentId,
      releaseId: deployment.releaseId,
      revision: deployment.revision,
      imageId: deployment.imageId,
      environmentRevision: deployment.environmentRevision,
      deployedAt: deployment.deployedAt,
    };
  }

  private async serviceView(state: StoredRunnerService): Promise<RunnerService> {
    const current = this.activeServiceDeployment(state);
    const previous = state.deployments.find(
      (deployment) => deployment.deploymentId !== state.activeDeploymentId,
    ) ?? null;
    let status = state.status;
    if (current) {
      const running = await this.containerRunning(current.containerName);
      if (state.desiredState === "stopped") {
        status = running ? "failed" : "stopped";
      } else if (!running) {
        status = "failed";
      } else if (current.healthPath && current.hostPort &&
        !(await this.httpServiceHealthy(current.hostPort, current.healthPath))) {
        status = "unhealthy";
      } else {
        status = "running";
      }
    }
    return {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      name: state.name,
      desiredState: state.desiredState,
      status,
      current: this.serviceRevision(current),
      previous: this.serviceRevision(previous),
      localEndpoint: current?.hostPort ? `http://127.0.0.1:${current.hostPort}` : null,
      ...(state.error ? { error: state.error } : {}),
      updatedAt: state.updatedAt,
    };
  }

  private async listServices(projectId: string, workspaceId: string): Promise<RunnerService[]> {
    const root = this.servicesRoot(projectId, workspaceId);
    if (!existsSync(root)) return [];
    const states = readdirSync(root)
      .filter((name) => SERVICE_NAME.test(name))
      .map((name) => this.storedService(projectId, workspaceId, name, false))
      .filter((state): state is StoredRunnerService => state !== null);
    return await Promise.all(states.map((state) => this.serviceView(state)));
  }

  private serviceOperationScope(projectId: string, workspaceId: string, name: string): string {
    return `${projectId}\0${workspaceId}\0${name}`;
  }

  private assertServiceOperation(
    state: StoredRunnerService,
    operation: StoredServiceOperation,
  ): boolean {
    if (state.lastOperation?.idempotencyKey !== operation.idempotencyKey) return false;
    if (state.lastOperation.action !== operation.action ||
      (state.lastOperation.releaseId ?? "") !== (operation.releaseId ?? "")) {
      throw new RunnerHttpError(409, "idempotency key was reused for a different service operation");
    }
    return true;
  }

  private async serviceManifest(
    release: RunnerJob,
    archivePath: string,
    name: string,
  ): Promise<RunnerServiceDefinition> {
    this.assertReleaseFile(archivePath, release.archiveSha256);
    for (const manifestPath of [SERVICE_MANIFEST_PATH, `./${SERVICE_MANIFEST_PATH}`]) {
      const extracted = await run(
        "/usr/bin/tar",
        ["--extract", "--to-stdout", "--file", archivePath, manifestPath],
        { cwd: dirname(archivePath), timeoutMs: 30_000 },
      );
      if (extracted.code !== 0) continue;
      if (Buffer.byteLength(extracted.output) > 100_000) {
        throw new RunnerHttpError(413, "service manifest exceeds 100 KB");
      }
      try {
        return serviceDefinition(extracted.output, name);
      } catch (error) {
        throw new RunnerHttpError(409, error instanceof Error ? error.message : String(error));
      }
    }
    throw new RunnerHttpError(409, `${SERVICE_MANIFEST_PATH} is missing from the Release`);
  }

  private validateServiceRelease(source: string): boolean {
    const sourceRoot = realpathSync(source);
    const manifestPath = resolve(sourceRoot, SERVICE_MANIFEST_PATH);
    if (!existsSync(manifestPath)) return false;
    const metadata = lstatSync(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(manifestPath) !== manifestPath) {
      throw new Error(`${SERVICE_MANIFEST_PATH} must be a regular file in the source snapshot`);
    }
    if (metadata.size > 100_000) throw new Error("service manifest exceeds 100 KB");
    serviceDefinitions(readFileSync(manifestPath, "utf8"));
    return true;
  }

  private servicePorts(): Set<number> {
    const ports = new Set<number>();
    const projects = resolve(this.dataRoot, "projects");
    if (!existsSync(projects)) return ports;
    for (const projectId of readdirSync(projects).filter((name) => PROJECT_ID.test(name))) {
      const services = resolve(projects, projectId, "services");
      if (!existsSync(services)) continue;
      for (const workspaceId of readdirSync(services).filter((name) => WORKSPACE_ID.test(name))) {
        const workspace = resolve(services, workspaceId);
        for (const name of readdirSync(workspace).filter((entry) => SERVICE_NAME.test(entry))) {
          try {
            const state = this.storedService(projectId, workspaceId, name, false);
            for (const deployment of state?.deployments ?? []) {
              if (deployment.hostPort) ports.add(deployment.hostPort);
            }
          } catch {
            // Invalid operator-recovery state cannot reserve a network port.
          }
        }
      }
    }
    return ports;
  }

  private portAvailable(port: number): Promise<boolean> {
    return new Promise((resolvePort) => {
      const server = createNetServer();
      server.unref();
      server.once("error", () => resolvePort(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.close(() => resolvePort(true));
      });
    });
  }

  private async allocateServicePort(scope: string): Promise<number> {
    const used = this.servicePorts();
    const size = this.servicePortEnd - this.servicePortStart + 1;
    const seed = Number.parseInt(createHash("sha256").update(scope).digest("hex").slice(0, 8), 16);
    for (let offset = 0; offset < size; offset += 1) {
      const port = this.servicePortStart + ((seed + offset) % size);
      if (!used.has(port) && await this.portAvailable(port)) return port;
    }
    throw new RunnerHttpError(503, "no local service port is available");
  }

  private async containerRunning(containerName: string): Promise<boolean> {
    const result = await run(
      this.dockerBinary,
      ["container", "inspect", "--format", "{{.State.Running}}", containerName],
      { cwd: this.dataRoot, timeoutMs: 30_000 },
    );
    return result.code === 0 && result.output.trim() === "true";
  }

  private httpServiceHealthy(port: number, path: string): Promise<boolean> {
    return new Promise((resolveHealth) => {
      const requestHandle = httpRequest(
        { host: "127.0.0.1", port, path, method: "GET", timeout: 2_000 },
        (response) => {
          response.resume();
          resolveHealth((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 400);
        },
      );
      requestHandle.once("timeout", () => requestHandle.destroy());
      requestHandle.once("error", () => resolveHealth(false));
      requestHandle.end();
    });
  }

  private async waitForService(deployment: StoredServiceDeployment): Promise<void> {
    const deadline = Date.now() + deployment.startupTimeoutSeconds * 1_000;
    for (;;) {
      if (await this.containerRunning(deployment.containerName)) {
        if (!deployment.healthPath || !deployment.hostPort ||
          await this.httpServiceHealthy(deployment.hostPort, deployment.healthPath)) return;
      }
      if (Date.now() >= deadline) throw new Error("service did not become healthy before startup timeout");
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }

  private serviceRuntimeAccess(
    state: StoredRunnerService,
    deployment: StoredServiceDeployment,
  ): RuntimeAccess {
    const directory = this.serviceDeploymentDirectory(
      state.projectId,
      state.workspaceId,
      state.name,
      deployment.deploymentId,
    );
    const snapshotPath = resolve(directory, "environment.json");
    if (deployment.environmentSha256) {
      this.assertReleaseFile(snapshotPath, deployment.environmentSha256);
    } else if (existsSync(snapshotPath)) {
      throw new RunnerHttpError(409, "service environment integrity metadata is missing");
    } else {
      return { envPath: null, redactions: [] };
    }
    const parsed = this.environments.readJobSnapshot(
      state.projectId,
      state.workspaceId,
      deployment.releaseId,
      snapshotPath,
    );
    const envPath = resolve(this.runtimeEnvironmentRoot, `service-${deployment.deploymentId}.env`);
    const redactions = environmentRedactions(parsed.values);
    writeFileSync(envPath, runtimeEnvironmentText(parsed.values), { flag: "wx", mode: 0o600 });
    return { envPath, redactions };
  }

  private async launchServiceContainer(
    state: StoredRunnerService,
    deployment: StoredServiceDeployment,
    project: RunnerProjectConfig,
  ): Promise<void> {
    const directory = this.serviceDeploymentDirectory(
      state.projectId,
      state.workspaceId,
      state.name,
      deployment.deploymentId,
    );
    const configPath = resolve(directory, "release-config.json");
    this.assertReleaseFile(configPath, deployment.configSha256);
    const access = this.serviceRuntimeAccess(state, deployment);
    const dataPath = resolve(project.dataPath, "services", state.workspaceId, state.name);
    mkdirSync(dataPath, { recursive: true, mode: 0o700 });
    const args = [
      "run", "--detach", "--init",
      "--name", deployment.containerName,
      "--restart", "unless-stopped",
      "--read-only",
      "--user", "0:0",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "256",
      "--memory", "1536m",
      "--cpus", "1.5",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=134217728",
      "--env", "CONFIG_PATH=/run/config.json",
      "--env", "HISTORY_PATH=/app/data/history.json",
      "--env", "DRY_RUN=false",
      "--env", "SUMMING_PROJECT_DATA_PATH=/app/data",
      "--env", `SUMMING_SERVICE_NAME=${state.name}`,
      "--label", `summing.project=${state.projectId}`,
      "--label", `summing.workspace=${state.workspaceId}`,
      "--label", `summing.service=${state.name}`,
      "--label", `summing.release=${deployment.releaseId}`,
      "--volume", `${configPath}:/run/config.json:ro`,
      "--volume", `${dataPath}:/app/data`,
    ];
    try {
      if (access.envPath) args.push("--env-file", access.envPath);
      if (deployment.containerPort && deployment.hostPort) {
        if (!project.network) throw new Error("a network-disabled project cannot publish a service port");
        args.push("--publish", `127.0.0.1:${deployment.hostPort}:${deployment.containerPort}`);
      } else if (!project.network) {
        args.push("--network", "none");
      }
      args.push(deployment.imageId, ...deployment.command);
      const launched = await run(this.dockerBinary, args, {
        cwd: this.dataRoot,
        timeoutMs: 120_000,
        redactions: access.redactions,
      });
      if (launched.code !== 0) throw new Error(`service container start exited with code ${launched.code}`);
      await this.waitForService(deployment);
    } finally {
      if (access.envPath) rmSync(access.envPath, { force: true });
      access.redactions.fill("");
    }
  }

  private async stopServiceContainer(containerName: string): Promise<void> {
    if (!(await this.containerRunning(containerName))) return;
    const stopped = await run(this.dockerBinary, ["stop", "--time", "30", containerName], {
      cwd: this.dataRoot,
      timeoutMs: 45_000,
    });
    if (stopped.code !== 0) throw new Error(`service container stop exited with code ${stopped.code}`);
  }

  private async restoreServiceContainer(deployment: StoredServiceDeployment | null): Promise<void> {
    if (!deployment) return;
    const started = await run(this.dockerBinary, ["start", deployment.containerName], {
      cwd: this.dataRoot,
      timeoutMs: 45_000,
    });
    if (started.code !== 0) throw new Error("previous service container could not be restored");
    await this.waitForService(deployment);
  }

  private async deployService(
    projectId: string,
    workspaceId: string,
    name: string,
    sourceJobId: string,
    idempotencyKey: string,
  ): Promise<RunnerService> {
    const scope = this.serviceOperationScope(projectId, workspaceId, name);
    const operation: StoredServiceOperation = { idempotencyKey, action: "deploy", releaseId: sourceJobId };
    const existing = this.storedService(projectId, workspaceId, name, false);
    if (existing && this.assertServiceOperation(existing, operation)) return await this.serviceView(existing);
    if (this.activeServiceOperations.has(scope)) {
      throw new RunnerHttpError(409, "another service operation is already running");
    }
    this.activeServiceOperations.add(scope);
    try {
      const project = this.projectConfig(projectId, workspaceId);
      const release = this.storedJob(projectId, sourceJobId);
      if (release.workspaceId !== workspaceId || release.status !== "completed" ||
        release.action === "build" || release.action === "provision" ||
        !release.releaseId || !release.archiveSha256 ||
        !release.configSha256 || !release.imageId ||
        !Number.isSafeInteger(release.environmentRevision) || Number(release.environmentRevision) < 0) {
        throw new RunnerHttpError(409, "service deployment requires a completed non-build Release");
      }
      const releaseDirectory = this.jobDirectory(projectId, sourceJobId);
      const archivePath = resolve(releaseDirectory, "source.tar");
      const configPath = resolve(releaseDirectory, "release-config.json");
      const environmentPath = resolve(releaseDirectory, "environment.json");
      this.assertReleaseFile(configPath, release.configSha256);
      if (release.environmentSha256) {
        this.assertReleaseFile(environmentPath, release.environmentSha256);
      } else if (existsSync(environmentPath)) {
        throw new RunnerHttpError(409, "release environment integrity metadata is missing");
      }
      await this.ensureReleaseImage(release, releaseDirectory, resolve(releaseDirectory, "job.log"), new AbortController().signal);
      const definition = await this.serviceManifest(release, archivePath, name);
      if (definition.containerPort && !project.network) {
        throw new RunnerHttpError(409, "a network-disabled project cannot publish a service port");
      }
      const state = existing ?? {
        version: 1,
        projectId,
        workspaceId,
        name,
        desiredState: "running",
        status: "deploying",
        activeDeploymentId: null,
        deployments: [],
        updatedAt: new Date().toISOString(),
      } satisfies StoredRunnerService;
      const current = this.activeServiceDeployment(state);
      const hostPort = definition.containerPort
        ? current?.hostPort ?? await this.allocateServicePort(scope)
        : null;
      const deploymentId = randomUUID();
      const deployedAt = new Date().toISOString();
      const deployment: StoredServiceDeployment = {
        deploymentId,
        releaseId: release.releaseId,
        revision: release.revision,
        imageId: release.imageId,
        environmentRevision: Number(release.environmentRevision),
        deployedAt,
        containerName: `summing-svc-${projectId}-${workspaceId}-${name}-${deploymentId.slice(0, 8)}`,
        hostPort,
        configSha256: release.configSha256,
        ...(release.environmentSha256 ? { environmentSha256: release.environmentSha256 } : {}),
        ...definition,
      };
      const deploymentDirectory = this.serviceDeploymentDirectory(
        projectId,
        workspaceId,
        name,
        deploymentId,
      );
      mkdirSync(deploymentDirectory, { recursive: true, mode: 0o700 });
      copyFileSync(configPath, resolve(deploymentDirectory, "release-config.json"), constants.COPYFILE_EXCL);
      chmodSync(resolve(deploymentDirectory, "release-config.json"), 0o600);
      if (release.environmentSha256) {
        copyFileSync(environmentPath, resolve(deploymentDirectory, "environment.json"), constants.COPYFILE_EXCL);
        chmodSync(resolve(deploymentDirectory, "environment.json"), 0o600);
      }
      const previousDeployments = [...state.deployments];
      const retained = [deployment, ...previousDeployments]
        .filter((item, index, all) =>
          all.findIndex((candidate) => candidate.deploymentId === item.deploymentId) === index)
        .slice(0, SERVICE_DEPLOYMENT_RETENTION);
      const removed = previousDeployments.filter(
        (item) => !retained.some((candidate) => candidate.deploymentId === item.deploymentId),
      );
      state.activeDeploymentId = deploymentId;
      state.deployments = retained;
      state.desiredState = "running";
      state.status = "deploying";
      delete state.error;
      state.updatedAt = deployedAt;
      this.saveService(state);
      try {
        if (current) await this.stopServiceContainer(current.containerName);
        await this.launchServiceContainer(state, deployment, project);
      } catch (error) {
        await run(this.dockerBinary, ["rm", "--force", deployment.containerName], {
          cwd: this.dataRoot,
          timeoutMs: 30_000,
        }).catch(() => ({ code: 1, output: "" }));
        rmSync(deploymentDirectory, { recursive: true, force: true });
        let restored = false;
        try {
          await this.restoreServiceContainer(current);
          restored = current !== null;
        } catch {
          restored = false;
        }
        state.activeDeploymentId = current?.deploymentId ?? null;
        state.deployments = previousDeployments;
        state.status = restored ? "running" : "failed";
        state.error = error instanceof Error ? error.message : String(error);
        state.updatedAt = new Date().toISOString();
        this.saveService(state);
        throw new RunnerHttpError(409, `service deployment failed: ${state.error}`);
      }
      state.desiredState = "running";
      state.status = "running";
      state.lastOperation = operation;
      delete state.error;
      state.updatedAt = new Date().toISOString();
      this.saveService(state);
      for (const stale of removed) {
        await run(this.dockerBinary, ["rm", "--force", stale.containerName], {
          cwd: this.dataRoot,
          timeoutMs: 30_000,
        }).catch(() => ({ code: 1, output: "" }));
        rmSync(
          this.serviceDeploymentDirectory(projectId, workspaceId, name, stale.deploymentId),
          { recursive: true, force: true },
        );
      }
      return await this.serviceView(state);
    } finally {
      this.activeServiceOperations.delete(scope);
    }
  }

  private async changeService(
    projectId: string,
    workspaceId: string,
    name: string,
    action: RunnerServiceAction,
    idempotencyKey: string,
  ): Promise<RunnerService> {
    const scope = this.serviceOperationScope(projectId, workspaceId, name);
    const operation: StoredServiceOperation = { idempotencyKey, action };
    const state = this.storedService(projectId, workspaceId, name)!;
    if (this.assertServiceOperation(state, operation)) return await this.serviceView(state);
    if (this.activeServiceOperations.has(scope)) {
      throw new RunnerHttpError(409, "another service operation is already running");
    }
    this.activeServiceOperations.add(scope);
    try {
      const current = this.activeServiceDeployment(state);
      if (!current) throw new RunnerHttpError(409, "runner service has no deployed Release");
      state.desiredState = action === "stop" ? "stopped" : "running";
      if (action === "stop") {
        await this.stopServiceContainer(current.containerName);
        state.status = "stopped";
      } else if (action === "start") {
        if (!(await this.containerRunning(current.containerName))) {
          const started = await run(this.dockerBinary, ["start", current.containerName], {
            cwd: this.dataRoot,
            timeoutMs: 45_000,
          });
          if (started.code !== 0) throw new RunnerHttpError(409, "service container could not be started");
        }
        await this.waitForService(current);
        state.status = "running";
      } else if (action === "restart") {
        const restarted = await run(this.dockerBinary, ["restart", "--time", "30", current.containerName], {
          cwd: this.dataRoot,
          timeoutMs: 60_000,
        });
        if (restarted.code !== 0) throw new RunnerHttpError(409, "service container could not be restarted");
        await this.waitForService(current);
        state.status = "running";
      } else {
        const previous = state.deployments.find(
          (deployment) => deployment.deploymentId !== state.activeDeploymentId,
        );
        if (!previous) throw new RunnerHttpError(409, "runner service has no previous Release");
        await this.stopServiceContainer(current.containerName);
        try {
          await this.restoreServiceContainer(previous);
        } catch (error) {
          await this.restoreServiceContainer(current).catch(() => undefined);
          throw error;
        }
        state.activeDeploymentId = previous.deploymentId;
        state.deployments = [previous, current];
        state.status = "running";
      }
      state.lastOperation = operation;
      delete state.error;
      state.updatedAt = new Date().toISOString();
      this.saveService(state);
      return await this.serviceView(state);
    } catch (error) {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      state.updatedAt = new Date().toISOString();
      this.saveService(state);
      throw error;
    } finally {
      this.activeServiceOperations.delete(scope);
    }
  }

  private async readServiceLog(
    projectId: string,
    workspaceId: string,
    name: string,
  ): Promise<string> {
    const state = this.storedService(projectId, workspaceId, name)!;
    const current = this.activeServiceDeployment(state);
    if (!current) throw new RunnerHttpError(409, "runner service has no deployed Release");
    const directory = this.serviceDeploymentDirectory(
      projectId,
      workspaceId,
      name,
      current.deploymentId,
    );
    const environmentPath = resolve(directory, "environment.json");
    let redactions: string[] = [];
    if (current.environmentSha256) {
      this.assertReleaseFile(environmentPath, current.environmentSha256);
      const parsed = this.environments.readJobSnapshot(
        projectId,
        workspaceId,
        current.releaseId,
        environmentPath,
      );
      redactions = environmentRedactions(parsed.values);
    } else if (existsSync(environmentPath)) {
      throw new RunnerHttpError(409, "service environment integrity metadata is missing");
    }
    try {
      const result = await run(this.dockerBinary, ["logs", "--tail", "1000", current.containerName], {
        cwd: this.dataRoot,
        timeoutMs: 30_000,
        redactions,
      });
      if (result.code !== 0) throw new RunnerHttpError(409, "service log is unavailable");
      return result.output;
    } finally {
      redactions.fill("");
    }
  }

  private migrationKey(projectId: string, workspaceId: string): string {
    return `${projectId}:${workspaceId}`;
  }

  private migrationTarget(url: URL): LegacyEnvironmentMigrationTarget {
    const projectId = url.searchParams.get("project") ?? "";
    const workspaceId = url.searchParams.get("workspace") ?? "";
    const revision = url.searchParams.get("revision") ?? "";
    if (!PROJECT_ID.test(projectId) || !WORKSPACE_ID.test(workspaceId) || !REVISION.test(revision)) {
      throw new RunnerHttpError(400, "invalid migration target");
    }
    const target = this.migrationTargets.get(this.migrationKey(projectId, workspaceId));
    if (!target || target.revision !== revision) {
      throw new RunnerHttpError(404, "environment migration target is not configured");
    }
    return target;
  }

  private async importMigration(
    target: LegacyEnvironmentMigrationTarget,
    manifestText: string,
  ): Promise<EnvironmentMigrationMarker> {
    const key = this.migrationKey(target.projectId, target.workspaceId);
    const active = this.migrationImports.get(key);
    if (active) return await active;
    const migration = importLegacyConnections({
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      manifestPath: target.manifestPath,
      manifestText,
      brokerSocket: this.migrationBrokerSocket,
      bootstrapPath: target.bootstrapPath,
      markerPath: resolve(target.stateRoot, "imported.json"),
      store: this.environments,
    }).then((result) => result.marker);
    this.migrationImports.set(key, migration);
    try {
      const marker = await migration;
      this.importedMigrations.add(key);
      if (this.importedMigrations.size === this.migrationTargets.size) this.markReady();
      return marker;
    } finally {
      this.migrationImports.delete(key);
    }
  }

  private jobDirectory(projectId: string, jobId: string): string {
    return resolve(this.dataRoot, "projects", projectId, "runs", jobId);
  }

  private jobMetadataPath(job: RunnerJob): string {
    return resolve(this.jobDirectory(job.projectId, job.id), "job.json");
  }

  private storedJob(projectId: string, jobId: string): RunnerJob {
    const path = resolve(this.jobDirectory(projectId, jobId), "job.json");
    if (!existsSync(path)) throw new RunnerHttpError(404, "runner job not found");
    try {
      const job = JSON.parse(readFileSync(path, "utf8")) as RunnerJob;
      return { ...job, trigger: job.trigger ?? "manual" };
    } catch {
      throw new RunnerHttpError(409, "runner job is malformed");
    }
  }

  private async cancelJob(
    projectId: string,
    workspaceId: string,
    jobId: string,
  ): Promise<RunnerJob> {
    const active = this.activeJobs.get(jobId);
    if (active?.job.projectId === projectId) {
      if (active.job.workspaceId !== workspaceId) {
        throw new RunnerHttpError(404, "runner job not found in this workspace");
      }
      if (active.job.status !== "cancelling") {
        active.job.status = "cancelling";
        active.job.cancelRequestedAt = new Date().toISOString();
        this.saveJob(active.job);
        writeFileSync(
          resolve(this.jobDirectory(projectId, jobId), "job.log"),
          `[${active.job.cancelRequestedAt}] cancellation requested\n`,
          { flag: "a", mode: 0o600 },
        );
        active.controller.abort();
      }
      return active.job;
    }

    const queuedIndex = this.queue.findIndex((job) => job.id === jobId && job.projectId === projectId);
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1);
      if (!job || job.workspaceId !== workspaceId) {
        if (job) this.queue.splice(queuedIndex, 0, job);
        throw new RunnerHttpError(404, "runner job not found in this workspace");
      }
      return this.finishCancelledJob(job);
    }

    const stored = this.storedJob(projectId, jobId);
    if (
      stored.id !== jobId ||
      stored.projectId !== projectId ||
      (stored.workspaceId ?? "repo") !== workspaceId
    ) {
      throw new RunnerHttpError(404, "runner job not found in this workspace");
    }
    if (!new Set([
      "queued",
      "running",
      "cancelling",
      "cancelled",
      "completed",
      "failed",
      "interrupted",
    ])
      .has(stored.status)) {
      throw new RunnerHttpError(409, "runner job status is malformed");
    }
    if (stored.status === "cancelled") return stored;
    if (
      stored.status === "completed" ||
      stored.status === "failed" ||
      stored.status === "interrupted"
    ) {
      throw new RunnerHttpError(409, `runner job is already ${stored.status}`);
    }
    if (stored.status === "running" || stored.status === "cancelling") {
      const containerName = `summing-${stored.projectId}-${stored.id.slice(0, 8)}`;
      await run(this.dockerBinary, ["rm", "--force", containerName], {
        cwd: this.dataRoot,
        logPath: resolve(this.jobDirectory(projectId, jobId), "job.log"),
        timeoutMs: 30_000,
      });
    }
    return this.finishCancelledJob(stored);
  }

  private finishCancelledJob(job: RunnerJob): RunnerJob {
    const completedAt = new Date().toISOString();
    job.status = "cancelled";
    job.cancelRequestedAt ??= completedAt;
    job.completedAt = completedAt;
    job.error = "cancelled by user";
    const directory = this.jobDirectory(job.projectId, job.id);
    writeFileSync(
      resolve(directory, "job.log"),
      `[${completedAt}] CANCELLED by user\n`,
      { flag: "a", mode: 0o600 },
    );
    this.saveJob(job);
    rmSync(resolve(directory, "source"), { recursive: true, force: true });
    this.pruneJobDirectories(job.projectId);
    return job;
  }

  private saveJob(job: RunnerJob): void {
    const metadataPath = this.jobMetadataPath(job);
    const directory = dirname(metadataPath);
    const temporaryPath = resolve(directory, `.job-${process.pid}-${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(descriptor, `${JSON.stringify(job, null, 2)}\n`, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, metadataPath);
      const directoryDescriptor = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private listJobs(projectId: string, workspaceId?: string): RunnerJob[] {
    const directory = resolve(this.dataRoot, "projects", projectId, "runs");
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((entry) => JOB_ID.test(entry))
      .map((entry): RunnerJob | null => {
        try {
          const job = JSON.parse(
            readFileSync(resolve(directory, entry, "job.json"), "utf8"),
          ) as RunnerJob;
          return { ...job, trigger: job.trigger ?? "manual" };
        } catch {
          return null;
        }
      })
      .filter((job): job is RunnerJob => job !== null)
      .filter((job) => !workspaceId || (job.workspaceId ?? "repo") === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 50);
  }

  private artifactScope(url: URL): {
    projectId: string;
    jobId: string;
    project: RunnerProjectConfig;
    job: RunnerJob;
  } {
    const projectId = url.searchParams.get("project") ?? "";
    const jobId = url.searchParams.get("job") ?? "";
    if (!PROJECT_ID.test(projectId) || !JOB_ID.test(jobId)) {
      throw new RunnerHttpError(400, "invalid artifact identifier");
    }
    const project = this.projectConfig(projectId);
    const metadataPath = resolve(this.jobDirectory(projectId, jobId), "job.json");
    if (!existsSync(metadataPath)) throw new RunnerHttpError(404, "runner job not found");
    const job = JSON.parse(readFileSync(metadataPath, "utf8")) as RunnerJob;
    if (
      job.projectId !== projectId ||
      job.id !== jobId ||
      (job.action !== "dry-run" && job.action !== "run")
    ) {
      throw new RunnerHttpError(404, "job artifacts are not available for this job");
    }
    return { projectId, jobId, project, job };
  }

  private trashArtifact(
    projectId: string,
    jobId: string,
    name: string,
    project: RunnerProjectConfig,
  ): RunnerArtifactDeletion {
    const contentType = artifactContentType(name);
    if (!contentType) throw new RunnerHttpError(400, "invalid artifact name");
    const directory = this.safeArtifactDirectory(project, jobId);
    if (!directory) throw new RunnerHttpError(404, "artifact not found");
    const source = resolve(directory, name);
    if (!existsSync(source)) throw new RunnerHttpError(404, "artifact not found");
    const metadata = lstatSync(source);
    if (!metadata.isFile()) throw new RunnerHttpError(404, "artifact not found");

    const trashRoot = resolve(this.dataRoot, "artifact-trash", projectId);
    if (existsSync(trashRoot) && !lstatSync(trashRoot).isDirectory()) {
      throw new RunnerHttpError(500, "artifact trash is not a directory");
    }
    mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    const trashJobDirectory = resolve(trashRoot, jobId);
    if (existsSync(trashJobDirectory) && !lstatSync(trashJobDirectory).isDirectory()) {
      throw new RunnerHttpError(500, "artifact trash job path is not a directory");
    }
    mkdirSync(trashJobDirectory, { recursive: true, mode: 0o700 });
    const deletedAt = new Date().toISOString();
    renameSync(source, resolve(trashJobDirectory, `${randomUUID()}-${name}`));

    const job = this.storedJob(projectId, jobId);
    job.artifactCount = this.listArtifacts(jobId, project).length;
    this.saveJob(job);
    return { jobId, name, bytes: metadata.size, contentType, deletedAt };
  }

  private listArtifacts(jobId: string, project: RunnerProjectConfig): Array<{
    name: string;
    bytes: number;
    contentType: string;
  }> {
    const directory = this.safeArtifactDirectory(project, jobId);
    if (!directory) return [];
    const names = new Set([
      ...ARTIFACTS.keys(),
      ...readdirSync(directory).filter((name) => VIDEO_ARTIFACT.test(name)),
    ]);
    return [...names].flatMap((name) => {
      const contentType = artifactContentType(name);
      if (!contentType) return [];
      const path = resolve(directory, name);
      if (!existsSync(path)) return [];
      const metadata = lstatSync(path);
      return metadata.isFile() && !metadata.isSymbolicLink() &&
          metadata.size > 0 && metadata.size <= maximumArtifactBytes(name)
        ? [{ name, bytes: metadata.size, contentType }]
        : [];
    });
  }

  private safeArtifactDirectory(project: RunnerProjectConfig, jobId: string): string | null {
    const root = resolve(project.dataPath, "dry-runs");
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return null;
    const directory = resolve(root, jobId);
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return null;
    return directory;
  }

  private processQueue(): void {
    const activeScopes = new Set(
      [...this.activeJobs.values()].map(({ job }) => this.jobScope(job)),
    );
    while (this.activeJobs.size < this.maxParallelJobs) {
      const index = this.queue.findIndex((job) => !activeScopes.has(this.jobScope(job)));
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      if (!job) return;
      const controller = new AbortController();
      this.activeJobs.set(job.id, { job, controller });
      activeScopes.add(this.jobScope(job));
      void this.execute(job, controller.signal).finally(() => {
        this.activeJobs.delete(job.id);
        this.processQueue();
      });
    }
  }

  private jobScope(job: Pick<RunnerJob, "projectId">): string {
    return job.projectId;
  }

  private async execute(job: RunnerJob, signal: AbortSignal): Promise<void> {
    const directory = this.jobDirectory(job.projectId, job.id);
    const logPath = resolve(directory, "job.log");
    const source = resolve(directory, "source");
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.saveJob(job);
    writeFileSync(
      logPath,
      `[${job.startedAt}] ${job.action} ${job.projectId}/${job.workspaceId}@${job.revision}` +
        `${job.provisionId ? ` profile=${job.provisionId}` : ""}` +
        `${job.replayOfJobId ? ` replay-of=${job.replayOfJobId} release=${job.releaseId}` : ""}\n`,
      { mode: 0o600 },
    );
    try {
      mkdirSync(source, { mode: 0o700 });
      const listed = await run("/usr/bin/tar", ["-tf", resolve(directory, "source.tar")], {
        cwd: directory,
        logPath,
        signal,
        timeoutMs: 30_000,
      });
      if (listed.code !== 0) throw new Error("source archive cannot be listed");
      for (const path of listed.output.split(/\r?\n/).filter(Boolean)) {
        if (path.startsWith("/") || path.split("/").includes("..")) {
          throw new Error("source archive contains an unsafe path");
        }
      }
      const extracted = await run(
        "/usr/bin/tar",
        ["--extract", "--file", resolve(directory, "source.tar"), "--directory", source, "--no-same-owner", "--no-same-permissions"],
        { cwd: directory, logPath, signal, timeoutMs: 60_000 },
      );
      if (extracted.code !== 0) throw new Error("source archive extraction failed");
      const project = this.projectConfig(job.projectId, job.workspaceId);
      const provisionProfile = job.action === "provision"
        ? readProvisioningProfile(source, job.provisionId ?? "")
        : null;
      let configPath: string | null = null;
      if (job.action !== "build") {
        configPath = resolve(directory, "release-config.json");
        if (job.replayOfJobId) {
          this.assertReleaseFile(configPath, job.configSha256);
          const environmentPath = resolve(directory, "environment.json");
          if (job.environmentSha256) {
            this.assertReleaseFile(environmentPath, job.environmentSha256);
          } else if (existsSync(environmentPath)) {
            throw new Error("release environment integrity metadata is missing");
          }
        } else {
          const selectedConfig = this.runtimeConfigPath(project, source);
          if (selectedConfig === null) {
            writeFileSync(configPath, "{}\n", { mode: 0o600 });
          } else {
            copyFileSync(selectedConfig, configPath);
            chmodSync(configPath, 0o600);
          }
          job.configSha256 = this.fileSha256(configPath);
        }
      }
      if (job.replayOfJobId) {
        await this.ensureReleaseImage(job, source, logPath, signal);
      } else {
        job.imageId = await this.ensureImage(job, source, logPath, signal);
      }
      this.saveJob(job);
      if (signal.aborted) throw new RunnerCommandCancelledError("runner job cancelled");
      const serviceRelease = job.action === "validate" && this.validateServiceRelease(source);
      if (serviceRelease) {
        writeFileSync(
          logPath,
          `[${new Date().toISOString()}] service manifest and image validated; ` +
            "startup is deferred to service deployment health checks\n",
          { flag: "a" },
        );
      }
      const result = job.action === "build" || serviceRelease
        ? { code: 0 }
        : await this.runImage(job, project, configPath!, logPath, signal, provisionProfile);
      job.exitCode = result.code;
      if (result.code !== 0) throw new Error(`${job.action} exited with code ${result.code}`);
      if (signal.aborted) throw new RunnerCommandCancelledError("runner job cancelled");
      if (job.action === "dry-run" || job.action === "run") {
        const project = this.projectConfig(job.projectId, job.workspaceId);
        const artifactDirectory = this.safeArtifactDirectory(project, job.id);
        if (artifactDirectory) {
          const allowedArtifacts = new Map(
            this.listArtifacts(job.id, project)
              .filter((artifact) => artifact.name !== "portal-messages.json")
              .map((artifact) => [artifact.name, artifact.contentType]),
          );
          const batch = this.portalMessages.capture({
            projectId: job.projectId,
            workspaceId: job.workspaceId,
            jobId: job.id,
            artifactDirectory,
            allowedArtifacts,
          });
          if (batch) job.portalMessageCount = batch.messages.length;
        }
      }
      job.status = "completed";
    } catch (error) {
      if (signal.aborted || error instanceof RunnerCommandCancelledError) {
        job.status = "cancelled";
        job.error = "cancelled by user";
        writeFileSync(logPath, `[${new Date().toISOString()}] CANCELLED by user\n`, { flag: "a" });
      } else {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        writeFileSync(logPath, `[${new Date().toISOString()}] ERROR ${job.error}\n`, { flag: "a" });
      }
    } finally {
      if (job.action === "dry-run" || job.action === "run") {
        const project = this.projectConfig(job.projectId);
        job.artifactCount = this.listArtifacts(job.id, project).length;
        this.pruneJobArtifacts(job.projectId, project);
      }
      job.completedAt = new Date().toISOString();
      this.saveJob(job);
      rmSync(resolve(directory, "source"), { recursive: true, force: true });
      if (job.action === "provision") {
        for (const file of ["source.tar", "environment.json", "release-config.json"]) {
          rmSync(resolve(directory, file), { force: true });
        }
      }
      this.pruneJobDirectories(job.projectId);
    }
  }

  private image(job: RunnerJob): string {
    return `summing/${job.projectId}-${job.workspaceId}:${job.revision}`;
  }

  private async ensureImage(
    job: RunnerJob,
    source: string,
    logPath: string,
    signal: AbortSignal,
  ): Promise<string> {
    const image = this.image(job);
    const existing = await run(this.dockerBinary, ["image", "inspect", "--format", "{{.Id}}", image], {
      cwd: source,
      logPath,
      signal,
      timeoutMs: 30_000,
    });
    if (existing.code === 0) return existing.output.trim() || image;
    const built = await run(
      this.dockerBinary,
      [
        "build",
        "--label", `summing.project=${job.projectId}`,
        "--label", `summing.workspace=${job.workspaceId}`,
        "--label", `summing.revision=${job.revision}`,
        "--tag", image,
        ".",
      ],
      { cwd: source, logPath, signal, timeoutMs: 900_000 },
    );
    if (built.code !== 0) throw new Error(`docker build exited with code ${built.code}`);
    const inspected = await run(
      this.dockerBinary,
      ["image", "inspect", "--format", "{{.Id}}", image],
      { cwd: source, logPath, signal, timeoutMs: 30_000 },
    );
    if (inspected.code !== 0) throw new Error("built image could not be inspected");
    return inspected.output.trim() || image;
  }

  private async ensureReleaseImage(
    job: RunnerJob,
    source: string,
    logPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!job.imageId) throw new Error("release image id is missing");
    const inspected = await run(
      this.dockerBinary,
      ["image", "inspect", "--format", "{{.Id}}", job.imageId],
      { cwd: source, logPath, signal, timeoutMs: 30_000 },
    );
    if (inspected.code !== 0) throw new Error("release image is no longer available");
    const actualImageId = inspected.output.trim();
    if (actualImageId && actualImageId !== job.imageId) {
      throw new Error("release image integrity check failed");
    }
  }

  private async runImage(
    job: RunnerJob,
    project: RunnerProjectConfig,
    configPath: string,
    logPath: string,
    signal: AbortSignal,
    provisionProfile: ProvisioningProfile | null,
  ): Promise<{ code: number }> {
    mkdirSync(project.dataPath, { recursive: true, mode: 0o700 });
    if (job.action === "dry-run" || job.action === "run") {
      const root = resolve(project.dataPath, "dry-runs");
      if (existsSync(root) && !lstatSync(root).isDirectory()) {
        throw new Error("job artifact root is not a directory");
      }
      const directory = resolve(root, job.id);
      if (existsSync(directory) && !lstatSync(directory).isDirectory()) {
        throw new Error("job artifact path is not a directory");
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const access = this.runtimeAccess(job, logPath);
    const provisionDirectory = job.action === "provision"
      ? resolve(this.jobDirectory(job.projectId, job.id), "provisioning")
      : null;
    if (provisionDirectory) mkdirSync(provisionDirectory, { mode: 0o700 });
    const containerName = `summing-${job.projectId}-${job.id.slice(0, 8)}`;
    try {
      const args = [
      "run", "--rm", "--init",
      "--name", containerName,
      "--read-only",
      "--user", "0:0",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "256",
      "--memory", "1536m",
      "--cpus", "1.5",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=134217728",
      "--env", "CONFIG_PATH=/run/config.json",
      "--env", "HISTORY_PATH=/app/data/history.json",
      "--volume", `${configPath}:/run/config.json:ro`,
      "--volume", `${project.dataPath}:/app/data`,
    ];
      if (access.envPath) args.push("--env-file", access.envPath);
      if (job.action === "validate" || !project.network) args.push("--network", "none");
      if (job.action === "dry-run") {
        args.push(
          "--env", "DRY_RUN=true",
          "--env", "PUBLISH_IMMEDIATELY=true",
          "--env", "SUMMING_PORTAL_TRANSPORT=true",
          "--env", "SUMMING_PROJECT_DATA_PATH=/app/data",
          "--env", `SUMMING_JOB_ID=${job.id}`,
          "--env", `SUMMING_REVISION=${job.revision}`,
          "--env", `DRY_RUN_ARTIFACT_DIR=/app/data/dry-runs/${job.id}`,
        );
      }
      if (job.action === "run") {
        args.push(
          "--env", "DRY_RUN=false",
          "--env", "SUMMING_PORTAL_TRANSPORT=true",
          "--env", "SUMMING_PROJECT_DATA_PATH=/app/data",
          "--env", `SUMMING_JOB_ID=${job.id}`,
          "--env", `SUMMING_REVISION=${job.revision}`,
          "--env", `DRY_RUN_ARTIFACT_DIR=/app/data/dry-runs/${job.id}`,
        );
      }
      if (job.action === "provision") {
        if (!provisionProfile || !provisionDirectory) {
          throw new Error("provisioning profile was not loaded");
        }
        args.push(
          "--env", `SUMMING_PROVISION_ID=${provisionProfile.id}`,
          "--env", "SUMMING_PROVISION_RESULT=/run/summing-provision/result.json",
          "--env", "SUMMING_PROJECT_DATA_PATH=/app/data",
          "--env", `SUMMING_JOB_ID=${job.id}`,
          "--env", `SUMMING_REVISION=${job.revision}`,
          "--volume", `${provisionDirectory}:/run/summing-provision`,
        );
        writeFileSync(
          logPath,
          `[${new Date().toISOString()}] provision workload output is suppressed to protect generated secrets\n`,
          { flag: "a", mode: 0o600 },
        );
      }
      args.push(job.imageId || this.image(job));
      if (job.action === "validate") args.push("node", "dist/src/main.js", "--validate");
      const result = await run(this.dockerBinary, args, {
        cwd: this.dataRoot,
        logPath,
        timeoutMs: job.action === "run" ? this.runTimeoutHours * 3_600_000 : 900_000,
        redactions: access.redactions,
        suppressOutput: job.action === "provision",
        signal,
      });
      if (job.action === "provision") {
        job.exitCode = result.code;
        if (result.code === 0) {
          this.completeProvision(job, provisionProfile!, provisionDirectory!, logPath);
        }
      }
      return { code: result.code };
    } finally {
      try {
        if (signal.aborted) {
          await run(this.dockerBinary, ["rm", "--force", containerName], {
            cwd: this.dataRoot,
            logPath,
            timeoutMs: 30_000,
          });
        }
        this.redactArtifacts(job, project, access.redactions);
      } finally {
        if (access.envPath) rmSync(access.envPath, { force: true });
        if (provisionDirectory) rmSync(provisionDirectory, { recursive: true, force: true });
        access.redactions.fill("");
      }
    }
  }

  private completeProvision(
    job: RunnerJob,
    profile: ProvisioningProfile,
    provisionDirectory: string,
    logPath: string,
  ): void {
    const result = readProvisioningResult(resolve(provisionDirectory, "result.json"), profile);
    const snapshotPath = resolve(this.jobDirectory(job.projectId, job.id), "environment.json");
    const baseline = existsSync(snapshotPath)
      ? this.environments.readJobSnapshot(
        job.projectId,
        job.workspaceId,
        job.releaseId ?? job.id,
        snapshotPath,
      )
      : parseProjectEnvironment("");
    const current = this.environments.get(job.projectId, job.workspaceId);
    const text = provisionedEnvironmentText(current.text, baseline, profile, result.secrets);
    const saved = this.environments.save(job.projectId, job.workspaceId, text, current.revision);
    job.provisionedVariables = profile.outputs.map((output) => output.environment);
    job.consumedVariables = [...profile.consume];
    job.resultingEnvironmentRevision = saved.revision;
    writeFileSync(
      logPath,
      `[${new Date().toISOString()}] provision '${profile.id}' stored ` +
        `${job.provisionedVariables.join(", ")} in environment revision ${saved.revision}` +
        `${job.consumedVariables.length > 0
          ? `; consumed ${job.consumedVariables.join(", ")}`
          : ""}\n`,
      { flag: "a", mode: 0o600 },
    );
  }

  private runtimeConfigPath(project: RunnerProjectConfig, source: string): string | null {
    if (project.config.kind === "host") {
      if (!existsSync(project.config.path) || !lstatSync(project.config.path).isFile()) {
        throw new Error(`project config is missing or not a regular file: ${project.config.path}`);
      }
      return project.config.path;
    }
    const sourceRoot = realpathSync(source);
    for (const relativePath of project.config.paths) {
      const candidate = resolve(sourceRoot, relativePath);
      if (!existsSync(candidate)) continue;
      if (!lstatSync(candidate).isFile()) {
        throw new Error(`snapshot project config is not a regular file: ${relativePath}`);
      }
      if (realpathSync(candidate) !== candidate) {
        throw new Error(`snapshot project config must not traverse symlinks: ${relativePath}`);
      }
      return candidate;
    }
    if (project.config.kind === "optional-snapshot") return null;
    throw new Error(
      `project config is missing from source snapshot: ${project.config.paths.join(", ")}`,
    );
  }

  private runtimeAccess(job: RunnerJob, logPath: string): RuntimeAccess {
    const snapshotPath = resolve(this.jobDirectory(job.projectId, job.id), "environment.json");
    if (!existsSync(snapshotPath)) return { envPath: null, redactions: [] };
    const parsed: ParsedEnvironment = this.environments.readJobSnapshot(
      job.projectId,
      job.workspaceId,
      job.releaseId ?? job.id,
      snapshotPath,
    );
    const envPath = resolve(this.runtimeEnvironmentRoot, `${job.id}.env`);
    const redactions = environmentRedactions(parsed.values);
    writeFileSync(envPath, runtimeEnvironmentText(parsed.values), { flag: "wx", mode: 0o600 });
    writeFileSync(
      logPath,
      `[${new Date().toISOString()}] environment revision ${job.environmentRevision ?? 0} loaded\n`,
      { flag: "a", mode: 0o600 },
    );
    return { envPath, redactions };
  }

  private redactArtifacts(job: RunnerJob, project: RunnerProjectConfig, secrets: string[]): void {
    if ((job.action !== "dry-run" && job.action !== "run") || secrets.length === 0) return;
    const directory = this.safeArtifactDirectory(project, job.id);
    if (!directory) return;
    for (const name of ARTIFACTS.keys()) {
      const path = resolve(directory, name);
      if (!existsSync(path)) continue;
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.size > MAX_ARTIFACT_BYTES) continue;
      let content = readFileSync(path, "utf8");
      let changed = false;
      for (const secret of secrets) {
        if (!secret || !content.includes(secret)) continue;
        content = content.replaceAll(secret, "[REDACTED]");
        changed = true;
      }
      if (changed) writeFileSync(path, content, { mode: 0o600 });
    }
  }

  private pruneJobArtifacts(projectId: string, project: RunnerProjectConfig): void {
    const root = resolve(project.dataPath, "dry-runs");
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
    const keep = new Set(
      this.listJobs(projectId)
        .filter((job) => job.action === "dry-run" || job.action === "run")
        .slice(0, JOB_ARTIFACT_RETENTION)
        .map((job) => job.id),
    );
    for (const entry of readdirSync(root)) {
      if (JOB_ID.test(entry) && !keep.has(entry)) {
        rmSync(resolve(root, entry), { recursive: true, force: true });
      }
    }
  }

  private pruneJobDirectories(projectId: string): void {
    const root = resolve(this.dataRoot, "projects", projectId, "runs");
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
    const terminal = readdirSync(root)
      .filter((entry) => JOB_ID.test(entry))
      .flatMap((entry) => {
        try {
          const job = JSON.parse(readFileSync(resolve(root, entry, "job.json"), "utf8")) as RunnerJob;
          if (
            job.id !== entry ||
            job.projectId !== projectId ||
            (job.status !== "completed" &&
              job.status !== "failed" &&
              job.status !== "cancelled" &&
              job.status !== "interrupted") ||
            typeof job.createdAt !== "string"
          ) {
            return [];
          }
          return [{
            id: entry,
            retentionAt: job.completedAt ?? job.createdAt,
            releasePayload: job.action !== "provision",
          }];
        } catch {
          return [];
        }
      })
      .sort((left, right) =>
        right.retentionAt.localeCompare(left.retentionAt) || right.id.localeCompare(left.id));
    for (const job of terminal
      .filter((candidate) => candidate.releasePayload)
      .slice(RELEASE_PAYLOAD_RETENTION)) {
      for (const file of ["source.tar", "environment.json", "release-config.json"]) {
        rmSync(resolve(root, job.id, file), { force: true });
      }
    }
    for (const job of terminal.slice(JOB_RETENTION)) {
      rmSync(resolve(root, job.id), { recursive: true, force: true });
    }
  }

  private pruneStoredJobDirectories(): void {
    const root = resolve(this.dataRoot, "projects");
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
    for (const projectId of readdirSync(root)) {
      if (PROJECT_ID.test(projectId)) this.pruneJobDirectories(projectId);
    }
  }

  private recoverInterruptedJobs(): void {
    const root = resolve(this.dataRoot, "projects");
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
    const completedAt = new Date().toISOString();
    for (const projectId of readdirSync(root)) {
      if (!PROJECT_ID.test(projectId)) continue;
      const runs = resolve(root, projectId, "runs");
      if (!existsSync(runs) || !lstatSync(runs).isDirectory()) continue;
      for (const entry of readdirSync(runs)) {
        if (!JOB_ID.test(entry)) continue;
        const directory = resolve(runs, entry);
        rmSync(resolve(directory, "provisioning"), { recursive: true, force: true });
        const metadataPath = resolve(directory, "job.json");
        try {
          const job = JSON.parse(readFileSync(metadataPath, "utf8")) as RunnerJob;
          if (
            job.id !== entry ||
            job.projectId !== projectId ||
            !new Set(["queued", "running", "cancelling"]).has(job.status)
          ) {
            continue;
          }
          job.status = "interrupted";
          job.completedAt = completedAt;
          job.error = "runner restarted before the job completed";
          this.saveJob(job);
          writeFileSync(
            resolve(directory, "job.log"),
            `[${completedAt}] INTERRUPTED runner restarted; job was not restarted automatically\n`,
            { flag: "a", mode: 0o600 },
          );
          rmSync(resolve(directory, "source"), { recursive: true, force: true });
          if (job.action === "provision") {
            for (const file of ["source.tar", "environment.json", "release-config.json"]) {
              rmSync(resolve(directory, file), { force: true });
            }
          }
        } catch {
          // Preserve malformed operator-recovery state for manual inspection.
        }
      }
    }
  }

  private report(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof RunnerHttpError) {
      json(response, error.status, { error: error.message });
      return;
    }
    if (error instanceof RunnerPortalMessageError) {
      json(response, error.status, { error: error.message });
      return;
    }
    if (error instanceof ProjectEnvironmentConflictError) {
      json(response, 409, { error: error.message });
      return;
    }
    if (error instanceof ProjectEnvironmentError) {
      json(response, 400, { error: error.message });
      return;
    }
    if (error instanceof ProjectEnvironmentMigrationError) {
      json(response, 409, { error: error.message });
      return;
    }
    console.error("project runner request failed", error);
    json(response, 500, { error: "internal runner error" });
  }
}
