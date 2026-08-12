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
import type { RunnerAction, RunnerJob } from "./project-runner-client.js";

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOB_ID = /^[0-9a-f-]{36}$/;
const REVISION = /^[0-9a-f]{40}$/;
const MAX_ARCHIVE_BYTES = 50_000_000;
const RUNNER_ACTIONS = new Set<RunnerAction>(["build", "validate", "dry-run", "run"]);

interface RunnerProjectConfig {
  configPath: string;
  envPath: string;
  dataPath: string;
}

interface CommandResult {
  code: number;
  output: string;
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

function run(
  executable: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; logPath?: string; timeoutMs?: number },
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
    const record = (chunk: Buffer): void => {
      log?.write(chunk);
      if (bytes < 1_000_000) {
        bytes += chunk.length;
        output.push(chunk.toString("utf8"));
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
      log?.end();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      log?.end();
      resolveRun({ code: code ?? 1, output: output.join("") });
    });
  });
}

export class ProjectRunnerServer {
  private server: Server | null = null;
  private readonly queue: RunnerJob[] = [];
  private processing = false;

  constructor(
    readonly socketPath: string,
    readonly dataRoot: string,
    readonly configRoot: string,
    readonly dockerBinary = "/usr/bin/docker",
  ) {
    if (!isAbsolute(socketPath) || basename(socketPath) !== "runner.sock") {
      throw new Error("runner socket must be an absolute runner.sock path");
    }
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
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
        : await this.runImage(job, this.projectConfig(job.projectId), logPath);
      job.exitCode = result.code;
      if (result.code !== 0) throw new Error(`${job.action} exited with code ${result.code}`);
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      writeFileSync(logPath, `[${new Date().toISOString()}] ERROR ${job.error}\n`, { flag: "a" });
    } finally {
      job.completedAt = new Date().toISOString();
      this.saveJob(job);
      rmSync(resolve(directory, "source"), { recursive: true, force: true });
      rmSync(resolve(directory, "source.tar"), { force: true });
    }
  }

  private image(job: RunnerJob): string {
    return `summate/${job.projectId}:${job.revision}`;
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
        "--label", `summate.project=${job.projectId}`,
        "--label", `summate.revision=${job.revision}`,
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
    logPath: string,
  ): Promise<{ code: number }> {
    if (!existsSync(project.configPath)) throw new Error(`project config is missing: ${project.configPath}`);
    if (!existsSync(project.envPath)) throw new Error(`project environment is missing: ${project.envPath}`);
    mkdirSync(project.dataPath, { recursive: true, mode: 0o700 });
    const args = [
      "run", "--rm", "--init",
      "--name", `summate-${job.projectId}-${job.id.slice(0, 8)}`,
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
    if (job.action === "validate") args.push("--network", "none");
    if (job.action === "dry-run") {
      args.push("--env", "DRY_RUN=true", "--env", "PUBLISH_IMMEDIATELY=true");
    }
    if (job.action === "run") args.push("--env", "DRY_RUN=false");
    args.push(this.image(job));
    if (job.action === "validate") args.push("node", "dist/src/main.js", "--validate");
    const result = await run(this.dockerBinary, args, {
      cwd: this.dataRoot,
      logPath,
      timeoutMs: job.action === "run" ? 14_400_000 : 900_000,
    });
    return { code: result.code };
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
