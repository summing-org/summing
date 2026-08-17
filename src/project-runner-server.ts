import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, isAbsolute, resolve } from "node:path";
import {
  environmentRedactions,
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
import type { RunnerAction, RunnerJob } from "./project-runner-client.js";

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WORKSPACE_ID = PROJECT_ID;
const JOB_ID = /^[0-9a-f-]{36}$/;
const REVISION = /^[0-9a-f]{40}$/;
const MAX_ARCHIVE_BYTES = 50_000_000;
const MAX_ARTIFACT_BYTES = 8_000_000;
const MAX_JSON_BYTES = 1_100_000;
const DRY_RUN_RETENTION = 30;
const JOB_RETENTION = 100;
const RUNNER_ACTIONS = new Set<RunnerAction>(["build", "validate", "dry-run", "run"]);
const ARTIFACTS = new Map([
  ["manifest.json", "application/json"],
  ["sources.jsonl", "application/x-ndjson"],
  ["candidates.json", "application/json"],
  ["editorial-plan.json", "application/json"],
  ["errors.json", "application/json"],
  ["report.html", "text/html"],
]);

type RunnerProjectConfigSource =
  | { kind: "host"; path: string }
  | { kind: "snapshot"; paths: readonly string[] };

interface RunnerProjectConfig {
  config: RunnerProjectConfigSource;
  dataPath: string;
  environmentBootstrap: ReadonlyMap<string, string>;
  network: boolean;
}

interface CommandResult {
  code: number;
  output: string;
}

interface RuntimeAccess {
  envPath: string | null;
  redactions: string[];
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
  private processing = false;
  private activeJob: { job: RunnerJob; controller: AbortController } | null = null;
  private readonly environments: ProjectEnvironmentStore;
  private readonly runtimeEnvironmentRoot: string;
  private ready: boolean;
  private readonly migrationTargets: ReadonlyMap<string, LegacyEnvironmentMigrationTarget>;
  private readonly importedMigrations = new Set<string>();
  private readonly migrationImports = new Map<string, Promise<EnvironmentMigrationMarker>>();

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
  ) {
    if (!isAbsolute(socketPath) || basename(socketPath) !== "runner.sock") {
      throw new Error("runner socket must be an absolute runner.sock path");
    }
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    this.environments = new ProjectEnvironmentStore(resolve(dataRoot, "environments"), environmentKey);
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
        queued: this.queue.length,
        running: this.processing,
      });
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
      const project = this.projectConfig(projectId);
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
    if (request.method === "POST" && url.pathname === "/jobs") {
      const projectId = url.searchParams.get("project") ?? "";
      const workspaceId = url.searchParams.get("workspace") ?? "";
      const action = url.searchParams.get("action") as RunnerAction;
      const revision = url.searchParams.get("revision") ?? "";
      if (!PROJECT_ID.test(projectId) || !WORKSPACE_ID.test(workspaceId)) {
        throw new RunnerHttpError(400, "invalid project or workspace id");
      }
      if (!RUNNER_ACTIONS.has(action)) {
        throw new RunnerHttpError(400, "invalid runner action");
      }
      if (!REVISION.test(revision)) throw new RunnerHttpError(400, "invalid revision");
      const project = this.projectConfig(projectId);
      const job: RunnerJob = {
        id: randomUUID(),
        projectId,
        workspaceId,
        action,
        revision,
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      const directory = this.jobDirectory(projectId, job.id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        await this.receiveArchive(request, resolve(directory, "source.tar"));
        if (action !== "build") {
          job.environmentRevision = this.environments.writeJobSnapshot(
            projectId,
            workspaceId,
            job.id,
            resolve(directory, "environment.json"),
            project.environmentBootstrap.get(workspaceId),
          );
        }
        this.saveJob(job);
        this.queue.push(job);
        void this.processQueue();
        json(response, 202, { job });
      } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
      }
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
      this.projectConfig(projectId);
      json(response, 200, { job: await this.cancelJob(projectId, workspaceId, jobId) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/jobs") {
      const projectId = url.searchParams.get("project") ?? "";
      const workspaceId = url.searchParams.get("workspace") ?? "";
      if (!PROJECT_ID.test(projectId) || !WORKSPACE_ID.test(workspaceId)) {
        throw new RunnerHttpError(400, "invalid project or workspace id");
      }
      this.projectConfig(projectId);
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
    if (request.method === "GET" && url.pathname === "/artifact") {
      const { projectId, jobId, project } = this.artifactScope(url);
      const name = url.searchParams.get("name") ?? "";
      const contentType = ARTIFACTS.get(name);
      if (!contentType) throw new RunnerHttpError(400, "invalid artifact name");
      const directory = this.safeArtifactDirectory(project, jobId);
      if (!directory) throw new RunnerHttpError(404, "artifact not found");
      const path = resolve(directory, name);
      if (!existsSync(path)) throw new RunnerHttpError(404, "artifact not found");
      const metadata = lstatSync(path);
      if (!metadata.isFile()) throw new RunnerHttpError(404, "artifact not found");
      if (metadata.size > MAX_ARTIFACT_BYTES) {
        throw new RunnerHttpError(413, "artifact exceeds 8 MB");
      }
      json(response, 200, {
        artifact: { name, bytes: metadata.size, contentType, content: readFileSync(path, "utf8") },
      });
      return;
    }
    throw new RunnerHttpError(404, "not found");
  }

  private async receiveArchive(request: IncomingMessage, path: string): Promise<void> {
    const announced = Number(request.headers["content-length"] ?? 0);
    if (!Number.isSafeInteger(announced) || announced <= 0 || announced > MAX_ARCHIVE_BYTES) {
      throw new RunnerHttpError(413, "invalid source archive size");
    }
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 });
    let bytes = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_ARCHIVE_BYTES) throw new RunnerHttpError(413, "source archive is too large");
        if (!output.write(buffer)) {
          await new Promise<void>((resolveDrain) => output.once("drain", resolveDrain));
        }
      }
    } finally {
      await new Promise<void>((resolveEnd) => output.end(resolveEnd));
    }
    if (bytes !== announced) throw new RunnerHttpError(400, "source archive is incomplete");
  }

  private projectConfig(projectId: string): RunnerProjectConfig {
    const path = resolve(this.configRoot, `${projectId}.json`);
    if (!existsSync(path)) throw new RunnerHttpError(404, "runner project is not configured");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
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
        ? { kind: "snapshot", paths: snapshotConfigs! }
        : { kind: "host", path: hostConfig },
      dataPath: safeAbsolutePath(raw.dataPath, "dataPath"),
      environmentBootstrap,
      network: raw.network === true,
    };
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
      return JSON.parse(readFileSync(path, "utf8")) as RunnerJob;
    } catch {
      throw new RunnerHttpError(409, "runner job is malformed");
    }
  }

  private async cancelJob(
    projectId: string,
    workspaceId: string,
    jobId: string,
  ): Promise<RunnerJob> {
    const active = this.activeJob;
    if (active?.job.id === jobId && active.job.projectId === projectId) {
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
    if (!new Set(["queued", "running", "cancelling", "cancelled", "completed", "failed"])
      .has(stored.status)) {
      throw new RunnerHttpError(409, "runner job status is malformed");
    }
    if (stored.status === "cancelled") return stored;
    if (stored.status === "completed" || stored.status === "failed") {
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
    rmSync(resolve(directory, "source.tar"), { force: true });
    rmSync(resolve(directory, "environment.json"), { force: true });
    this.pruneJobDirectories(job.projectId);
    return job;
  }

  private saveJob(job: RunnerJob): void {
    writeFileSync(this.jobMetadataPath(job), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  }

  private listJobs(projectId: string, workspaceId?: string): RunnerJob[] {
    const directory = resolve(this.dataRoot, "projects", projectId, "runs");
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((entry) => JOB_ID.test(entry))
      .map((entry) => {
        try {
          return JSON.parse(readFileSync(resolve(directory, entry, "job.json"), "utf8")) as RunnerJob;
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
    if (job.projectId !== projectId || job.id !== jobId || job.action !== "dry-run") {
      throw new RunnerHttpError(404, "dry-run artifacts are not available for this job");
    }
    return { projectId, jobId, project };
  }

  private listArtifacts(jobId: string, project: RunnerProjectConfig): Array<{
    name: string;
    bytes: number;
    contentType: string;
  }> {
    const directory = this.safeArtifactDirectory(project, jobId);
    if (!directory) return [];
    return [...ARTIFACTS.entries()].flatMap(([name, contentType]) => {
      const path = resolve(directory, name);
      if (!existsSync(path)) return [];
      const metadata = lstatSync(path);
      return metadata.isFile() ? [{ name, bytes: metadata.size, contentType }] : [];
    });
  }

  private safeArtifactDirectory(project: RunnerProjectConfig, jobId: string): string | null {
    const root = resolve(project.dataPath, "dry-runs");
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return null;
    const directory = resolve(root, jobId);
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return null;
    return directory;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        const controller = new AbortController();
        this.activeJob = { job, controller };
        try {
          await this.execute(job, controller.signal);
        } finally {
          if (this.activeJob?.job.id === job.id) this.activeJob = null;
        }
      }
    } finally {
      this.processing = false;
    }
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
      `[${job.startedAt}] ${job.action} ${job.projectId}/${job.workspaceId}@${job.revision}\n`,
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
      await this.ensureImage(job, source, logPath, signal);
      if (signal.aborted) throw new RunnerCommandCancelledError("runner job cancelled");
      const result = job.action === "build"
        ? { code: 0 }
        : await this.runImage(job, this.projectConfig(job.projectId), source, logPath, signal);
      job.exitCode = result.code;
      if (result.code !== 0) throw new Error(`${job.action} exited with code ${result.code}`);
      if (signal.aborted) throw new RunnerCommandCancelledError("runner job cancelled");
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
      if (job.action === "dry-run") {
        const project = this.projectConfig(job.projectId);
        job.artifactCount = this.listArtifacts(job.id, project).length;
        this.pruneDryRunArtifacts(job.projectId, project);
      }
      job.completedAt = new Date().toISOString();
      this.saveJob(job);
      rmSync(resolve(directory, "source"), { recursive: true, force: true });
      rmSync(resolve(directory, "source.tar"), { force: true });
      rmSync(resolve(directory, "environment.json"), { force: true });
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
  ): Promise<void> {
    const image = this.image(job);
    const existing = await run(this.dockerBinary, ["image", "inspect", image], {
      cwd: source,
      logPath,
      signal,
      timeoutMs: 30_000,
    });
    if (existing.code === 0) return;
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
  }

  private async runImage(
    job: RunnerJob,
    project: RunnerProjectConfig,
    source: string,
    logPath: string,
    signal: AbortSignal,
  ): Promise<{ code: number }> {
    const configPath = this.runtimeConfigPath(project, source);
    mkdirSync(project.dataPath, { recursive: true, mode: 0o700 });
    if (job.action === "dry-run") {
      const root = resolve(project.dataPath, "dry-runs");
      if (existsSync(root) && !lstatSync(root).isDirectory()) {
        throw new Error("dry-run artifact root is not a directory");
      }
      const directory = resolve(root, job.id);
      if (existsSync(directory) && !lstatSync(directory).isDirectory()) {
        throw new Error("dry-run artifact job path is not a directory");
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const access = this.runtimeAccess(job, logPath);
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
          "--env", `SUMMING_JOB_ID=${job.id}`,
          "--env", `SUMMING_REVISION=${job.revision}`,
          "--env", `DRY_RUN_ARTIFACT_DIR=/app/data/dry-runs/${job.id}`,
        );
      }
      if (job.action === "run") args.push("--env", "DRY_RUN=false");
      args.push(this.image(job));
      if (job.action === "validate") args.push("node", "dist/src/main.js", "--validate");
      const result = await run(this.dockerBinary, args, {
        cwd: this.dataRoot,
        logPath,
        timeoutMs: job.action === "run" ? 14_400_000 : 900_000,
        redactions: access.redactions,
        signal,
      });
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
        access.redactions.fill("");
      }
    }
  }

  private runtimeConfigPath(project: RunnerProjectConfig, source: string): string {
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
      job.id,
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
    if (job.action !== "dry-run" || secrets.length === 0) return;
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

  private pruneDryRunArtifacts(projectId: string, project: RunnerProjectConfig): void {
    const root = resolve(project.dataPath, "dry-runs");
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
    const keep = new Set(
      this.listJobs(projectId)
        .filter((job) => job.action === "dry-run")
        .slice(0, DRY_RUN_RETENTION)
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
              job.status !== "cancelled") ||
            typeof job.createdAt !== "string"
          ) {
            return [];
          }
          return [{ id: entry, createdAt: job.createdAt }];
        } catch {
          return [];
        }
      })
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
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

  private report(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof RunnerHttpError) {
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
