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
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, isAbsolute, resolve } from "node:path";
import {
  integrationRuntimePrefix,
  loadIntegrationManifest,
  type IntegrationMode,
} from "./integration-manifest.js";
import type { RunnerAction, RunnerJob } from "./project-runner-client.js";
import { SecretBrokerRuntimeClient } from "./secret-broker-client.js";

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOB_ID = /^[0-9a-f-]{36}$/;
const REVISION = /^[0-9a-f]{40}$/;
const MAX_ARCHIVE_BYTES = 50_000_000;
const MAX_ARTIFACT_BYTES = 8_000_000;
const MAX_STATIC_ENVIRONMENT_BYTES = 1_000_000;
const DRY_RUN_RETENTION = 30;
const RUNNER_ACTIONS = new Set<RunnerAction>(["build", "validate", "dry-run", "run"]);
const ARTIFACTS = new Map([
  ["manifest.json", "application/json"],
  ["sources.jsonl", "application/x-ndjson"],
  ["candidates.json", "application/json"],
  ["editorial-plan.json", "application/json"],
  ["errors.json", "application/json"],
  ["report.html", "text/html"],
]);
const CREDENTIAL_ENVIRONMENT_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|AUTH|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i;

interface RunnerProjectConfig {
  configPath: string;
  envPath: string;
  dataPath: string;
}

interface CommandResult {
  code: number;
  output: string;
}

interface RuntimeAccess {
  leaseId: string | null;
  envPath: string | null;
  gateway: boolean;
  modes: IntegrationMode[];
  redactions: string[];
}

class RunnerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

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

function validateStaticEnvironment(path: string): void {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > MAX_STATIC_ENVIRONMENT_BYTES ||
    (metadata.mode & 0o007) !== 0
  ) {
    throw new Error("static project environment must be a non-public regular file under 1 MB");
  }
  const content = readFileSync(path, "utf8");
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const name = separator < 0 ? line : line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || separator < 0) {
      throw new Error(`static project environment line ${index + 1} is invalid`);
    }
    if (CREDENTIAL_ENVIRONMENT_NAME.test(name)) {
      throw new Error(
        `static project environment contains credential-like variable '${name}'; use Connections`,
      );
    }
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
  },
): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
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
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs ?? 600_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      if (pendingLog) emit(pendingLog);
      log?.end();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (pendingLog) emit(pendingLog);
      log?.end();
      resolveRun({ code: code ?? 1, output: output.join("") });
    });
  });
}

export class ProjectRunnerServer {
  private server: Server | null = null;
  private readonly queue: RunnerJob[] = [];
  private processing = false;
  private readonly secrets: SecretBrokerRuntimeClient;
  private readonly runtimeAccessRoot: string;

  constructor(
    readonly socketPath: string,
    readonly dataRoot: string,
    readonly configRoot: string,
    readonly dockerBinary = "/usr/bin/docker",
    readonly secretBrokerRuntimeSocket = "/run/summing-secrets/runtime.sock",
    readonly secretBrokerGatewaySocket = "/run/summing-secrets/gateway.sock",
  ) {
    if (!isAbsolute(socketPath) || basename(socketPath) !== "runner.sock") {
      throw new Error("runner socket must be an absolute runner.sock path");
    }
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    this.secrets = new SecretBrokerRuntimeClient(secretBrokerRuntimeSocket);
    this.runtimeAccessRoot = resolve(socketPath, "..", "leases");
    mkdirSync(this.runtimeAccessRoot, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(this.runtimeAccessRoot)) {
      if (!/^[0-9a-f-]{36}\.env$/.test(entry)) continue;
      const path = resolve(this.runtimeAccessRoot, entry);
      const metadata = lstatSync(path);
      if (metadata.isFile() && !metadata.isSymbolicLink()) rmSync(path);
    }
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
      json(response, 200, { ok: true, queued: this.queue.length, running: this.processing });
      return;
    }
    if (request.method === "POST" && url.pathname === "/jobs") {
      const projectId = url.searchParams.get("project") ?? "";
      const action = url.searchParams.get("action") as RunnerAction;
      const revision = url.searchParams.get("revision") ?? "";
      if (!PROJECT_ID.test(projectId)) throw new RunnerHttpError(400, "invalid project id");
      if (!RUNNER_ACTIONS.has(action)) {
        throw new RunnerHttpError(400, "invalid runner action");
      }
      if (!REVISION.test(revision)) throw new RunnerHttpError(400, "invalid revision");
      this.projectConfig(projectId);
      const job: RunnerJob = {
        id: randomUUID(),
        projectId,
        action,
        revision,
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      const directory = this.jobDirectory(projectId, job.id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      await this.receiveArchive(request, resolve(directory, "source.tar"));
      this.saveJob(job);
      this.queue.push(job);
      void this.processQueue();
      json(response, 202, { job });
      return;
    }
    if (request.method === "GET" && url.pathname === "/jobs") {
      const projectId = url.searchParams.get("project") ?? "";
      if (!PROJECT_ID.test(projectId)) throw new RunnerHttpError(400, "invalid project id");
      this.projectConfig(projectId);
      json(response, 200, { jobs: this.listJobs(projectId) });
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
    return {
      configPath: safeAbsolutePath(raw.configPath, "configPath"),
      envPath: safeAbsolutePath(raw.envPath, "envPath"),
      dataPath: safeAbsolutePath(raw.dataPath, "dataPath"),
    };
  }

  private jobDirectory(projectId: string, jobId: string): string {
    return resolve(this.dataRoot, "projects", projectId, "runs", jobId);
  }

  private jobMetadataPath(job: RunnerJob): string {
    return resolve(this.jobDirectory(job.projectId, job.id), "job.json");
  }

  private saveJob(job: RunnerJob): void {
    writeFileSync(this.jobMetadataPath(job), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  }

  private listJobs(projectId: string): RunnerJob[] {
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
        await this.execute(job);
      }
    } finally {
      this.processing = false;
    }
  }

  private async execute(job: RunnerJob): Promise<void> {
    const directory = this.jobDirectory(job.projectId, job.id);
    const logPath = resolve(directory, "job.log");
    const source = resolve(directory, "source");
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.saveJob(job);
    writeFileSync(logPath, `[${job.startedAt}] ${job.action} ${job.projectId}@${job.revision}\n`, { mode: 0o600 });
    try {
      mkdirSync(source, { mode: 0o700 });
      const listed = await run("/usr/bin/tar", ["-tf", resolve(directory, "source.tar")], {
        cwd: directory,
        logPath,
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
        { cwd: directory, logPath, timeoutMs: 60_000 },
      );
      if (extracted.code !== 0) throw new Error("source archive extraction failed");
      await this.ensureImage(job, source, logPath);
      const result = job.action === "build"
        ? { code: 0 }
        : await this.runImage(job, this.projectConfig(job.projectId), source, logPath);
      job.exitCode = result.code;
      if (result.code !== 0) throw new Error(`${job.action} exited with code ${result.code}`);
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      writeFileSync(logPath, `[${new Date().toISOString()}] ERROR ${job.error}\n`, { flag: "a" });
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
    }
  }

  private image(job: RunnerJob): string {
    return `summing/${job.projectId}:${job.revision}`;
  }

  private async ensureImage(job: RunnerJob, source: string, logPath: string): Promise<void> {
    const image = this.image(job);
    const existing = await run(this.dockerBinary, ["image", "inspect", image], {
      cwd: source,
      logPath,
      timeoutMs: 30_000,
    });
    if (existing.code === 0) return;
    const built = await run(
      this.dockerBinary,
      [
        "build",
        "--label", `summing.project=${job.projectId}`,
        "--label", `summing.revision=${job.revision}`,
        "--tag", image,
        ".",
      ],
      { cwd: source, logPath, timeoutMs: 900_000 },
    );
    if (built.code !== 0) throw new Error(`docker build exited with code ${built.code}`);
  }

  private async runImage(
    job: RunnerJob,
    project: RunnerProjectConfig,
    source: string,
    logPath: string,
  ): Promise<{ code: number }> {
    if (!existsSync(project.configPath)) throw new Error(`project config is missing: ${project.configPath}`);
    if (!existsSync(project.envPath)) throw new Error(`project environment is missing: ${project.envPath}`);
    validateStaticEnvironment(project.envPath);
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
    const access = await this.runtimeAccess(job, source, logPath);
    try {
      const args = [
      "run", "--rm", "--init",
      "--name", `summing-${job.projectId}-${job.id.slice(0, 8)}`,
      "--read-only",
      "--user", "0:0",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--pids-limit", "256",
      "--memory", "1536m",
      "--cpus", "1.5",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=134217728",
      "--env-file", project.envPath,
      "--env", "CONFIG_PATH=/run/config.json",
      "--env", "HISTORY_PATH=/app/data/history.json",
      "--volume", `${project.configPath}:/run/config.json:ro`,
      "--volume", `${project.dataPath}:/app/data`,
    ];
      if (access.envPath) args.push("--env-file", access.envPath);
      if (access.gateway) {
        if (!existsSync(this.secretBrokerGatewaySocket) || !lstatSync(this.secretBrokerGatewaySocket).isSocket()) {
          throw new Error("secret broker gateway socket is unavailable");
        }
        args.push(
          "--volume",
          `${this.secretBrokerGatewaySocket}:/run/summing-secrets/gateway.sock:rw`,
        );
      }
      if (
        job.action === "validate" ||
        (access.modes.length > 0 && access.modes.every((mode) => mode === "gateway"))
      ) {
        args.push("--network", "none");
      }
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
      });
      return { code: result.code };
    } finally {
      let releaseError: unknown = null;
      if (access.leaseId) {
        try {
          await this.releaseRuntimeLease(job, access.leaseId, logPath);
        } catch (error) {
          releaseError = error;
        }
      }
      try {
        this.redactArtifacts(job, project, access.redactions);
      } finally {
        if (access.envPath) rmSync(access.envPath, { force: true });
        access.redactions.fill("");
      }
      if (releaseError) throw releaseError;
    }
  }

  private async runtimeAccess(
    job: RunnerJob,
    source: string,
    logPath: string,
  ): Promise<RuntimeAccess> {
    if (!(job.action === "dry-run" || job.action === "run")) {
      return { leaseId: null, envPath: null, gateway: false, modes: [], redactions: [] };
    }
    const integrations = loadIntegrationManifest(source).integrations.filter((integration) =>
      integration.actions.includes(job.action as "dry-run" | "run"),
    );
    if (integrations.length === 0) {
      return { leaseId: null, envPath: null, gateway: false, modes: [], redactions: [] };
    }
    const lease = await this.secrets.lease({
      projectId: job.projectId,
      action: job.action as "dry-run" | "run",
      jobId: job.id,
      integrations,
    });
    if (
      !/^[0-9a-f-]{36}$/.test(lease.id) ||
      lease.projectId !== job.projectId ||
      lease.jobId !== job.id ||
      lease.expiresAt <= Date.now() / 1_000
    ) {
      throw new Error("secret broker returned an invalid or expired runtime lease");
    }
    let handedOff = false;
    try {
      const environment: Record<string, string> = { ...lease.environment };
      const expectedEnvironment = new Set(
      integrations.flatMap((integration) => integration.runtime.map((entry) => entry.env)),
    );
      const expectedGatewayTokens = new Set(
      integrations
        .filter((integration) => integration.mode === "gateway")
        .map((integration) => `${integration.id}@${integration.environment}`),
    );
      if (
      Object.keys(lease.environment).some((name) => !expectedEnvironment.has(name)) ||
      [...expectedEnvironment].some((name) => !(name in lease.environment)) ||
      Object.keys(lease.gatewayTokens).some((name) => !expectedGatewayTokens.has(name)) ||
      [...expectedGatewayTokens].some((name) => !(name in lease.gatewayTokens))
      ) {
        for (const name of Object.keys(environment)) environment[name] = "";
        for (const name of Object.keys(lease.environment)) lease.environment[name] = "";
        for (const name of Object.keys(lease.gatewayTokens)) lease.gatewayTokens[name] = "";
        throw new Error("secret broker returned credentials outside the integration manifest");
      }
      const redactions = [
      ...Object.values(lease.environment),
      ...Object.values(lease.gatewayTokens),
    ].filter(Boolean);
      const envPath = resolve(this.runtimeAccessRoot, `${job.id}.env`);
      let ready = false;
      try {
      for (const integration of integrations) {
        const key = `${integration.id}@${integration.environment}`;
        const token = lease.gatewayTokens[key];
        if (integration.mode !== "gateway") continue;
        if (!token) throw new Error(`secret broker omitted gateway capability ${key}`);
        const prefix = integrationRuntimePrefix(integration);
        environment[`${prefix}_GATEWAY_TOKEN`] = token;
        environment[`${prefix}_GATEWAY_SOCKET`] = "/run/summing-secrets/gateway.sock";
        environment[`${prefix}_GATEWAY_PATH`] = `/v1/proxy/${encodeURIComponent(key)}`;
      }
      const lines = Object.entries(environment).map(([name, value]) => {
        if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || /[\r\n\0]/.test(value)) {
          throw new Error("secret broker returned an unsafe runtime environment value");
        }
        return `${name}=${value}`;
      });
      if (Buffer.byteLength(lines.join("\n")) > 1_000_000) {
        throw new Error("secret broker runtime environment exceeds 1 MB");
      }
      writeFileSync(envPath, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
      writeFileSync(
        logPath,
        `[${new Date().toISOString()}] runtime access: ${integrations.map((item) => `${item.id}@${item.environment}:${item.mode}`).join(", ")}\n`,
        { flag: "a", mode: 0o600 },
      );
        ready = true;
        handedOff = true;
        return {
        leaseId: lease.id,
        envPath,
        gateway: integrations.some((integration) => integration.mode === "gateway"),
        modes: integrations.map((integration) => integration.mode),
        redactions,
        };
      } finally {
        for (const name of Object.keys(environment)) environment[name] = "";
        for (const name of Object.keys(lease.environment)) lease.environment[name] = "";
        for (const name of Object.keys(lease.gatewayTokens)) lease.gatewayTokens[name] = "";
        if (!ready) {
          rmSync(envPath, { force: true });
          redactions.fill("");
        }
      }
    } finally {
      if (!handedOff) await this.releaseRuntimeLease(job, lease.id, logPath);
    }
  }

  private async releaseRuntimeLease(job: RunnerJob, leaseId: string, logPath: string): Promise<void> {
    await this.secrets.release({ id: leaseId, projectId: job.projectId, jobId: job.id });
    writeFileSync(
      logPath,
      `[${new Date().toISOString()}] runtime access released\n`,
      { flag: "a", mode: 0o600 },
    );
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

  private report(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof RunnerHttpError) {
      json(response, error.status, { error: error.message });
      return;
    }
    console.error("project runner request failed", error);
    json(response, 500, { error: "internal runner error" });
  }
}
