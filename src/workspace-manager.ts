import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { ProjectConfig, RuntimeConfig, WorkspaceConfig } from "./config.js";
import type { Conversation } from "./state-store.js";

export interface PreparedWorkspace {
  path: string;
  projectMemorySnapshot: string;
}

export class WorkspaceError extends Error {}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) {
      reject(new WorkspaceError(`${command} cancelled`));
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (cancelled) reject(new WorkspaceError(`${command} cancelled`));
      else if (timedOut) reject(new WorkspaceError(`${command} timed out`));
      else resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

export class WorkspaceManager {
  readonly identityPath: string;
  readonly projectsRoot: string;

  constructor(readonly config: RuntimeConfig) {
    this.identityPath = resolve(config.dataDir, "memory", "identity.md");
    this.projectsRoot = resolve(config.dataDir, "projects");
  }

  initialize(): void {
    mkdirSync(this.config.worktreeRoot, { recursive: true });
    mkdirSync(resolve(this.identityPath, ".."), { recursive: true });
    mkdirSync(this.projectsRoot, { recursive: true });
    if (!existsSync(this.identityPath)) {
      writeFileSync(
        this.identityPath,
        "# Summate identity\n\n" +
          "I am Summate, one persistent agent serving one owner through Telegram.\n" +
          "I preserve continuity across projects and change my own code only on the " +
          "owner's direct request.\n",
        "utf8",
      );
    }
    try {
      chmodSync(this.identityPath, 0o600);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
    for (const project of this.config.projects.values()) {
      const memoryPath = this.projectMemoryPath(project.id);
      mkdirSync(resolve(memoryPath, ".."), { recursive: true });
      if (!existsSync(memoryPath)) {
        writeFileSync(memoryPath, `# Project memory: ${project.name}\n\n`, "utf8");
      }
    }
  }

  projectMemoryPath(projectId: string): string {
    return resolve(this.projectsRoot, projectId, "memory.md");
  }

  async prepare(
    conversation: Conversation,
    project: ProjectConfig,
    workspace: WorkspaceConfig,
    signal?: AbortSignal,
  ): Promise<PreparedWorkspace> {
    const source = existsSync(workspace.path) ? realpathSync(workspace.path) : workspace.path;
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      throw new WorkspaceError(`workspace does not exist: ${source}`);
    }
    const gitRoot = await this.gitRoot(source, signal);
    let path: string;
    if (!gitRoot) {
      path = source;
    } else {
      const worktreeRoot = resolve(this.config.worktreeRoot, conversation.id);
      const branch = `summate/${project.id}/${conversation.id}`;
      await this.ensureWorktree(gitRoot, worktreeRoot, branch, signal);
      const relativeWorkspace = relative(gitRoot, resolve(source));
      if (relativeWorkspace === ".." || relativeWorkspace.startsWith(`..${sep}`)) {
        throw new WorkspaceError(`workspace ${source} is outside its Git root ${gitRoot}`);
      }
      path = resolve(worktreeRoot, relativeWorkspace);
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new WorkspaceError(`workspace subdirectory is absent from worktree: ${path}`);
      }
    }
    const memory = readFileSync(this.projectMemoryPath(project.id), "utf8");
    this.writeContext(path, project, workspace, memory);
    return { path, projectMemorySnapshot: memory };
  }

  private async gitRoot(path: string, signal?: AbortSignal): Promise<string | null> {
    const result = await runProcess("git", ["-C", path, "rev-parse", "--show-toplevel"], 60_000, signal);
    return result.code === 0 ? realpathSync(result.stdout.trim()) : null;
  }

  private async commonGitDir(path: string, signal?: AbortSignal): Promise<string | null> {
    const result = await runProcess("git", ["-C", path, "rev-parse", "--git-common-dir"], 60_000, signal);
    if (result.code !== 0) return null;
    const raw = result.stdout.trim();
    const resolved = resolve(path, raw);
    return existsSync(resolved) ? realpathSync(resolved) : resolved;
  }

  private async ensureWorktree(
    gitRoot: string,
    target: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (existsSync(resolve(target, ".git"))) {
      const [sourceCommon, targetCommon] = await Promise.all([
        this.commonGitDir(gitRoot, signal),
        this.commonGitDir(target, signal),
      ]);
      if (!sourceCommon || sourceCommon !== targetCommon) {
        throw new WorkspaceError(
          `existing worktree belongs to another repository: ${target}; clean it before rebinding`,
        );
      }
      await this.excludeRuntimeFiles(target, signal);
      return;
    }
    if (existsSync(target) && readdirSync(target).length > 0) {
      throw new WorkspaceError(`worktree target is not empty: ${target}`);
    }
    mkdirSync(resolve(target, ".."), { recursive: true });
    await this.runGit(gitRoot, signal, "worktree", "prune");
    if (await this.branchExists(gitRoot, branch, signal)) {
      await this.runGit(gitRoot, signal, "worktree", "add", target, branch);
    } else {
      await this.runGit(gitRoot, signal, "worktree", "add", "-b", branch, target, "HEAD");
    }
    await this.excludeRuntimeFiles(target, signal);
  }

  private async branchExists(root: string, branch: string, signal?: AbortSignal): Promise<boolean> {
    const result = await runProcess("git", [
      "-C",
      root,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ], 60_000, signal);
    return result.code === 0;
  }

  private async runGit(root: string, signal: AbortSignal | undefined, ...args: string[]): Promise<string> {
    const result = await runProcess("git", ["-C", root, ...args], 60_000, signal);
    if (result.code !== 0) {
      throw new WorkspaceError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    }
    return result.stdout;
  }

  private async excludeRuntimeFiles(worktree: string, signal?: AbortSignal): Promise<void> {
    const result = await runProcess("git", [
      "-C",
      worktree,
      "rev-parse",
      "--git-path",
      "info/exclude",
    ], 60_000, signal);
    if (result.code !== 0) return;
    const raw = result.stdout.trim();
    const exclude = resolve(worktree, raw);
    mkdirSync(resolve(exclude, ".."), { recursive: true });
    const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!existing.split(/\r?\n/).includes(".summate-runtime/")) {
      const separator = existing && !existing.endsWith("\n") ? "\n" : "";
      appendFileSync(exclude, `${separator}.summate-runtime/\n`, "utf8");
    }
  }

  private writeContext(
    path: string,
    project: ProjectConfig,
    workspace: WorkspaceConfig,
    projectMemory: string,
  ): void {
    const runtimeDir = resolve(path, ".summate-runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const identity = readFileSync(this.identityPath, "utf8");
    writeFileSync(resolve(runtimeDir, "PROJECT_MEMORY.md"), projectMemory, "utf8");
    writeFileSync(
      resolve(runtimeDir, "CONTEXT.md"),
      "# Summate runtime context\n\n" +
        "Read this file before acting. It is private runtime context and is excluded from Git.\n\n" +
        `## Identity\n\n${identity.trimEnd()}\n\n` +
        "## Project\n\n" +
        `- id: ${project.id}\n- name: ${project.name}\n` +
        `- workspace: ${workspace.id}\n- self-change project: ${project.selfChange}\n\n` +
        `## Durable project memory\n\n${projectMemory.trimEnd()}\n\n` +
        "## Memory rule\n\n" +
        "If this run establishes a durable project fact, append it to " +
        "`.summate-runtime/PROJECT_MEMORY.md`. Do not rewrite or delete existing memory. " +
        "Conversation-specific details belong in the Codex thread, not in project memory. " +
        "Change Summate itself only when the owner directly asks.\n",
      "utf8",
    );
  }

  async mergeProjectMemory(
    projectId: string,
    prepared: PreparedWorkspace,
  ): Promise<string | null> {
    const localPath = resolve(prepared.path, ".summate-runtime", "PROJECT_MEMORY.md");
    if (!existsSync(localPath) || !statSync(localPath).isFile()) return null;
    const updated = readFileSync(localPath, "utf8");
    const base = prepared.projectMemorySnapshot;
    if (updated === base) return null;

    const authority = this.projectMemoryPath(projectId);
    const current = readFileSync(authority, "utf8");
    if (updated.startsWith(base)) {
      const suffix = updated.slice(base.length);
      if (suffix && !current.includes(suffix)) {
        writeFileSync(authority, `${current.trimEnd()}\n${suffix.trimStart()}`, "utf8");
      }
      return null;
    }
    if (current === base) {
      writeFileSync(authority, updated, "utf8");
      return null;
    }
    const conflictDir = resolve(authority, "..", "memory-conflicts");
    mkdirSync(conflictDir, { recursive: true });
    const conflict = resolve(conflictDir, `${process.hrtime.bigint()}.md`);
    writeFileSync(
      conflict,
      "# Project memory merge conflict\n\n" +
        "The conversation rewrote memory while another conversation changed the authority. " +
        "No version was discarded.\n\n" +
        `## Authority\n\n${current}\n\n## Conversation candidate\n\n${updated}`,
      "utf8",
    );
    console.error(`project memory conflict preserved at ${conflict}`);
    return conflict;
  }
}
