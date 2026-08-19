import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  ConfigError,
  ProjectConfig,
  normalizeIdentifier,
  normalizeProjectIdentifier,
  telegramUserId,
  type RuntimeConfig,
  type WorkspaceConfig,
} from "./config.js";
import { ensureProjectMemory } from "./project-memory.js";
import { StateStore, type ManagedProject } from "./state-store.js";

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProjectAccess {
  project: ProjectConfig;
  primaryOwnerId: number;
  ownerIds: readonly number[];
  managed: boolean;
}

export type ManagedProjectCreated = (project: ProjectConfig) => Promise<void> | void;

export class ProjectCatalogError extends Error {}

function runGit(
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) {
      reject(new ProjectCatalogError("git operation cancelled"));
      return;
    }
    const child = spawn("git", [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const cancel = (): void => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (cancelled) reject(new ProjectCatalogError("git operation cancelled"));
      else if (timedOut) reject(new ProjectCatalogError("git operation timed out"));
      else resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

function failureDetail(result: ProcessResult): string {
  return result.stderr.trim().split(/\r?\n/).at(-1) ?? "unknown git error";
}

export class ProjectCatalog {
  readonly repositoriesRoot: string;
  private readonly entries = new Map<string, ProjectAccess>();

  constructor(
    readonly config: RuntimeConfig,
    readonly state: StateStore,
    readonly managedProjectCreated: ManagedProjectCreated = () => {},
  ) {
    this.repositoriesRoot = resolve(config.dataDir, "repositories");
    for (const project of config.projects.values()) {
      this.entries.set(project.id, {
        project,
        primaryOwnerId: config.telegramOwnerId,
        ownerIds: [config.telegramOwnerId],
        managed: false,
      });
    }
    for (const stored of state.listManagedProjects()) this.loadManaged(stored);
  }

  initialize(): void {
    mkdirSync(this.repositoriesRoot, { recursive: true });
  }

  all(): ProjectAccess[] {
    return [...this.entries.values()].sort((left, right) =>
      left.project.id.localeCompare(right.project.id),
    );
  }

  visibleTo(telegramUser: number): ProjectAccess[] {
    return this.all().filter((entry) => this.canAccess(telegramUser, entry.project.id));
  }

  isKnownOwner(telegramUser: number): boolean {
    return (
      telegramUser === this.config.telegramOwnerId ||
      this.all().some((entry) => entry.ownerIds.includes(telegramUser))
    );
  }

  canAccess(telegramUser: number, projectId: string): boolean {
    const entry = this.entries.get(projectId);
    if (!entry) return false;
    return telegramUser === this.config.telegramOwnerId || entry.ownerIds.includes(telegramUser);
  }

  project(projectId: string): ProjectConfig {
    const project = this.entries.get(projectId)?.project;
    if (!project) throw new ConfigError(`unknown project '${projectId}'`);
    return project;
  }

  owner(projectId: string): number {
    const ownerId = this.entries.get(projectId)?.primaryOwnerId;
    if (ownerId === undefined) throw new ConfigError(`unknown project '${projectId}'`);
    return ownerId;
  }

  owners(projectId: string): readonly number[] {
    const ownerIds = this.entries.get(projectId)?.ownerIds;
    if (!ownerIds) throw new ConfigError(`unknown project '${projectId}'`);
    return ownerIds;
  }

  replaceOwners(
    rawProjectId: unknown,
    rawPrimaryOwnerId: unknown,
    rawOwnerIds: unknown,
  ): ProjectAccess {
    const projectId = normalizeProjectIdentifier(rawProjectId, "project id");
    const entry = this.entries.get(projectId);
    if (!entry) throw new ProjectCatalogError(`project '${projectId}' does not exist`);
    if (!entry.managed) {
      throw new ProjectCatalogError(`project '${projectId}' is configured outside Mini App`);
    }
    if (!Array.isArray(rawOwnerIds)) {
      throw new ProjectCatalogError("project owner ids must be an array");
    }
    const primaryOwnerId = telegramUserId(rawPrimaryOwnerId, "primary project owner id");
    const ownerIds = [...new Set([
      primaryOwnerId,
      ...rawOwnerIds.map((ownerId) => telegramUserId(ownerId, "project owner id")),
    ])];
    this.state.replaceManagedProjectOwners(projectId, primaryOwnerId, ownerIds);
    entry.primaryOwnerId = primaryOwnerId;
    entry.ownerIds = ownerIds;
    return entry;
  }

  async createLocal(
    rawProjectId: unknown,
    rawOwnerId: unknown,
    rawWorkspaceId: unknown,
    signal?: AbortSignal,
  ): Promise<ProjectConfig> {
    return this.create(rawProjectId, rawOwnerId, rawWorkspaceId, "", signal);
  }

  async cloneRemote(
    rawProjectId: unknown,
    rawOwnerId: unknown,
    rawWorkspaceId: unknown,
    remote: string,
    signal?: AbortSignal,
  ): Promise<ProjectConfig> {
    if (!remote.trim()) throw new ProjectCatalogError("Git URL is required");
    return this.create(rawProjectId, rawOwnerId, rawWorkspaceId, remote.trim(), signal);
  }

  private async create(
    rawProjectId: unknown,
    rawOwnerId: unknown,
    rawWorkspaceId: unknown,
    remote: string,
    signal?: AbortSignal,
  ): Promise<ProjectConfig> {
    const projectId = normalizeProjectIdentifier(rawProjectId, "project id");
    const workspaceId = normalizeIdentifier(rawWorkspaceId, "repository id");
    const ownerId = telegramUserId(rawOwnerId, "project owner id");
    if (this.entries.has(projectId)) {
      throw new ProjectCatalogError(`project '${projectId}' already exists`);
    }
    this.initialize();
    const projectRoot = resolve(this.repositoriesRoot, projectId);
    const repositoryPath = resolve(projectRoot, workspaceId);
    if (existsSync(projectRoot)) {
      throw new ProjectCatalogError(
        `managed project directory already exists: ${projectRoot}; inspect it before retrying`,
      );
    }

    try {
      if (remote) await this.cloneRepository(projectRoot, repositoryPath, remote, signal);
      else await this.initializeRepository(repositoryPath, signal);
      if (signal?.aborted) throw new ProjectCatalogError("project creation cancelled");
    } catch (error) {
      rmSync(projectRoot, { recursive: true, force: true });
      throw error;
    }

    const workspace: WorkspaceConfig = { id: workspaceId, path: repositoryPath };
    const project = new ProjectConfig(
      projectId,
      projectId,
      workspaceId,
      new Map([[workspaceId, workspace]]),
    );
    ensureProjectMemory(this.config.dataDir, project);
    const stored: ManagedProject = {
      id: projectId,
      name: project.name,
      primaryOwnerId: ownerId,
      ownerIds: [ownerId],
      defaultWorkspaceId: workspaceId,
      workspaces: [workspace],
      createdAt: Date.now() / 1000,
    };
    try {
      this.state.createManagedProject(stored);
    } catch (error) {
      throw new ProjectCatalogError(
        `repository was created at ${repositoryPath}, but project registration failed: ${String(error)}`,
      );
    }
    this.entries.set(projectId, {
      project,
      primaryOwnerId: ownerId,
      ownerIds: [ownerId],
      managed: true,
    });
    try {
      await this.managedProjectCreated(project);
    } catch (error) {
      console.warn(
        `project ${projectId} was created, but runner registration is pending: ${String(error)}`,
      );
    }
    return project;
  }

  private async initializeRepository(repositoryPath: string, signal?: AbortSignal): Promise<void> {
    const initialized = await runGit(
      ["init", "--initial-branch=main", repositoryPath],
      60_000,
      signal,
    );
    if (initialized.code !== 0) {
      throw new ProjectCatalogError(`git init failed: ${failureDetail(initialized)}`);
    }
    await this.configureIdentity(repositoryPath, signal);
    const committed = await runGit(
      ["-C", repositoryPath, "commit", "--allow-empty", "-m", "Initial commit"],
      60_000,
      signal,
    );
    if (committed.code !== 0) {
      throw new ProjectCatalogError(`initial commit failed: ${failureDetail(committed)}`);
    }
  }

  private async cloneRepository(
    projectRoot: string,
    repositoryPath: string,
    remote: string,
    signal?: AbortSignal,
  ): Promise<void> {
    mkdirSync(projectRoot, { recursive: false });
    const cloned = await runGit(["clone", "--", remote, repositoryPath], 300_000, signal);
    if (cloned.code !== 0) {
      throw new ProjectCatalogError(
        "git clone failed; verify the URL and non-interactive credentials for the summing user",
      );
    }
    await this.configureIdentity(repositoryPath, signal);
    const head = await runGit(
      ["-C", repositoryPath, "rev-parse", "--verify", "HEAD"],
      60_000,
      signal,
    );
    if (head.code === 0) return;
    const remoteRefs = await runGit(
      [
        "-C",
        repositoryPath,
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/remotes/origin",
      ],
      60_000,
      signal,
    );
    if (remoteRefs.code !== 0) {
      throw new ProjectCatalogError(
        `cannot inspect cloned remote branches: ${failureDetail(remoteRefs)}`,
      );
    }
    const remoteBranches = remoteRefs.stdout
      .split(/\r?\n/)
      .map((branch) => branch.trim())
      .filter((branch) => branch.startsWith("origin/") && branch !== "origin/HEAD");
    if (remoteBranches.length > 1) {
      throw new ProjectCatalogError(
        "remote HEAD is invalid and the remote has multiple branches; repair its HEAD and retry",
      );
    }
    if (remoteBranches.length === 1) {
      const remoteBranch = remoteBranches[0]!;
      const localBranch = remoteBranch.slice("origin/".length);
      const switched = await runGit(
        ["-C", repositoryPath, "switch", "--track", "-c", localBranch, remoteBranch],
        60_000,
        signal,
      );
      if (switched.code !== 0) {
        throw new ProjectCatalogError(
          `cannot check out the remote branch: ${failureDetail(switched)}`,
        );
      }
      return;
    }
    const main = await runGit(
      ["-C", repositoryPath, "symbolic-ref", "HEAD", "refs/heads/main"],
      60_000,
      signal,
    );
    if (main.code !== 0) {
      throw new ProjectCatalogError(`cannot initialize empty clone: ${failureDetail(main)}`);
    }
    const committed = await runGit(
      ["-C", repositoryPath, "commit", "--allow-empty", "-m", "Initial commit"],
      60_000,
      signal,
    );
    if (committed.code !== 0) {
      throw new ProjectCatalogError(`initial commit failed: ${failureDetail(committed)}`);
    }
  }

  private async configureIdentity(repositoryPath: string, signal?: AbortSignal): Promise<void> {
    for (const [key, value] of [
      ["user.name", "SUMMING"],
      ["user.email", "summing@localhost"],
    ] as const) {
      const configured = await runGit(
        ["-C", repositoryPath, "config", key, value],
        60_000,
        signal,
      );
      if (configured.code !== 0) {
        throw new ProjectCatalogError(`git config failed: ${failureDetail(configured)}`);
      }
    }
  }

  private loadManaged(stored: ManagedProject): void {
    const projectId = normalizeProjectIdentifier(stored.id, "managed project id");
    const defaultWorkspaceId = normalizeIdentifier(
      stored.defaultWorkspaceId,
      `managed project '${projectId}' default repository id`,
    );
    if (this.entries.has(projectId)) {
      throw new ProjectCatalogError(
        `managed project '${projectId}' conflicts with config.toml`,
      );
    }
    const workspaces = new Map<string, WorkspaceConfig>();
    for (const storedWorkspace of stored.workspaces) {
      const workspaceId = normalizeIdentifier(storedWorkspace.id, "managed repository id");
      if (!isAbsolute(storedWorkspace.path)) {
        throw new ProjectCatalogError(
          `managed workspace path must be absolute: ${storedWorkspace.path}`,
        );
      }
      workspaces.set(workspaceId, { id: workspaceId, path: resolve(storedWorkspace.path) });
    }
    if (workspaces.size === 0 || !workspaces.has(defaultWorkspaceId)) {
      throw new ProjectCatalogError(`managed project '${projectId}' has invalid workspaces`);
    }
    const project = new ProjectConfig(
      projectId,
      stored.name,
      defaultWorkspaceId,
      workspaces,
    );
    const primaryOwnerId = telegramUserId(
      stored.primaryOwnerId,
      `managed project '${projectId}' primary owner id`,
    );
    const ownerIds = [...new Set(stored.ownerIds.map((ownerId) =>
      telegramUserId(ownerId, `managed project '${projectId}' owner id`)
    ))];
    if (!ownerIds.includes(primaryOwnerId)) {
      throw new ProjectCatalogError(
        `managed project '${projectId}' primary owner is missing from its owner list`,
      );
    }
    this.entries.set(projectId, {
      project,
      primaryOwnerId,
      ownerIds,
      managed: true,
    });
  }
}
