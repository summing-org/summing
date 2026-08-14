import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const MAX_GIT_OUTPUT = 4_000_000;
const MAX_ARCHIVE_BYTES = 50_000_000;
const MAX_FILE_BYTES = 1_000_000;
const DENIED_SEGMENTS = new Set([
  ".git",
  ".summing-runtime",
  ".ssh",
  "node_modules",
  "dist",
  "data",
]);

interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface TreeEntry {
  path: string;
  status: string;
}

export interface RepositorySummary {
  branch: string;
  head: string;
  shortHead: string;
  remote: string;
  dirty: boolean;
  changes: number;
}

export type RepositorySyncState =
  | "unavailable"
  | "unpublished"
  | "synchronized"
  | "ahead"
  | "behind"
  | "diverged"
  | "error";

export interface RepositorySyncStatus extends RepositorySummary {
  remoteName: "origin";
  remoteBranch: string;
  defaultBranch: string;
  pullSource: string;
  published: boolean;
  ahead: number;
  behind: number;
  state: RepositorySyncState;
  message: string;
  canPush: boolean;
  canPull: boolean;
}

export interface CommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  authoredAt: string;
  subject: string;
}

export class GitInspectorError extends Error {}

function command(
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = safeCommandEnvironment(),
  maximumBytes = MAX_GIT_OUTPUT,
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let killedForSize = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumBytes) {
        killedForSize = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killedForSize) {
        reject(new GitInspectorError(`command output exceeds ${maximumBytes} bytes`));
        return;
      }
      resolveCommand({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

function safeCommandEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "SSH_AUTH_SOCK",
    "TMPDIR",
    "TZ",
    "USER",
    "XDG_CONFIG_HOME",
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return { ...environment, ...extra, GIT_TERMINAL_PROMPT: "0" };
}

function deniedPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => DENIED_SEGMENTS.has(segment))) return true;
  const name = segments.at(-1)?.toLowerCase() ?? "";
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return true;
  return /\.(?:key|pem|p12|pfx)$/i.test(name);
}

function normalizedRelativePath(path: string): string {
  const value = path.trim();
  if (!value || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
    throw new GitInspectorError("invalid project path");
  }
  const normalized = value.split("/").filter((part) => part !== ".").join("/");
  if (!normalized || normalized.split("/").some((part) => !part || part === "..")) {
    throw new GitInspectorError("invalid project path");
  }
  if (deniedPath(normalized)) throw new GitInspectorError("project path is private");
  return normalized;
}

function text(result: CommandResult): string {
  return result.stdout.toString("utf8");
}

function safeRemoteUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "ssh:"].includes(parsed.protocol)) return value;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function gitFailure(result: CommandResult, remote: string): string {
  const detail = result.stderr
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .at(-1) ?? "Git operation failed";
  const withoutRemote = remote ? detail.split(remote).join("origin") : detail;
  return withoutRemote.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1");
}

export class GitInspector {
  constructor(readonly root: string) {}

  private async git(args: string[], options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
    const result = await command(
      "git",
      [
        "-C",
        this.root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      this.root,
      options.env ?? safeCommandEnvironment(),
    );
    if (result.code !== 0 && !options.allowFailure) {
      throw new GitInspectorError(result.stderr.trim() || `git ${args[0] ?? "command"} failed`);
    }
    return result;
  }

  async summary(): Promise<RepositorySummary> {
    const [branch, head, remote, statusResult] = await Promise.all([
      this.git(["branch", "--show-current"]),
      this.git(["rev-parse", "HEAD"]),
      this.git(["remote", "get-url", "origin"], { allowFailure: true }),
      this.git(["status", "--porcelain=v1", "-uall"]),
    ]);
    const fullHead = text(head).trim();
    const changes = text(statusResult).split(/\r?\n/).filter(Boolean).length;
    return {
      branch: text(branch).trim() || "detached",
      head: fullHead,
      shortHead: fullHead.slice(0, 8),
      remote: remote.code === 0 ? safeRemoteUrl(text(remote).trim()) : "",
      dirty: changes > 0,
      changes,
    };
  }

  async commonDirectory(): Promise<string> {
    const result = await this.git(["rev-parse", "--git-common-dir"]);
    return realpath(resolve(this.root, text(result).trim()));
  }

  async repositoryStatus(refresh = true): Promise<RepositorySyncStatus> {
    const summary = await this.summary();
    const remote = summary.remote;
    const base: RepositorySyncStatus = {
      ...summary,
      remote: safeRemoteUrl(remote),
      remoteName: "origin",
      remoteBranch: summary.branch === "detached" ? "" : `origin/${summary.branch}`,
      defaultBranch: "",
      pullSource: "",
      published: false,
      ahead: 0,
      behind: 0,
      state: "unavailable",
      message: "Origin не настроен.",
      canPush: false,
      canPull: false,
    };
    if (!remote) return base;
    if (summary.branch === "detached") {
      return { ...base, message: "Detached HEAD нельзя синхронизировать с origin." };
    }

    let endpoints: { fetch: string; push: string };
    try {
      endpoints = await this.repositoryEndpoints();
    } catch (error) {
      return {
        ...base,
        state: "error",
        message: error instanceof Error ? error.message : "Небезопасная конфигурация origin.",
      };
    }

    if (refresh) {
      const fetched = await this.git(
        [
          "fetch",
          "--prune",
          "--",
          endpoints.fetch,
          "+refs/heads/*:refs/remotes/origin/*",
        ],
        { allowFailure: true, env: this.repositoryEnvironment() },
      );
      if (fetched.code !== 0) {
        return {
          ...base,
          state: "error",
          message: `Не удалось получить данные origin: ${gitFailure(fetched, remote)}`,
        };
      }
    }

    const remoteRef = `refs/remotes/origin/${summary.branch}`;
    const publishedResult = await this.git(
      ["show-ref", "--verify", "--quiet", remoteRef],
      { allowFailure: true },
    );
    const published = publishedResult.code === 0;
    const defaultBranch = await this.defaultRemoteBranch();
    const pullSource = published ? `origin/${summary.branch}` : defaultBranch;
    let ahead = 0;
    let behind = 0;
    if (pullSource) {
      const counts = text(await this.git([
        "rev-list",
        "--left-right",
        "--count",
        `HEAD...${pullSource}`,
      ])).trim().split(/\s+/);
      ahead = Number(counts[0] ?? 0);
      behind = Number(counts[1] ?? 0);
    } else {
      ahead = Number(text(await this.git(["rev-list", "--count", "HEAD"])).trim());
    }

    let state: RepositorySyncState;
    let message: string;
    if (!published) {
      state = ahead > 0 && behind > 0 ? "diverged" : "unpublished";
      if (!pullSource) message = "В origin пока нет веток; текущую ветку можно опубликовать.";
      else if (ahead > 0 && behind > 0) {
        message =
          `Текущая ветка и ${pullSource} разошлись. ` +
          "Push опубликует отдельную ветку; для Pull сначала нужен merge или rebase.";
      } else if (behind > 0) {
        message = `${pullSource} впереди на ${behind}; изменения можно получить fast-forward.`;
      } else {
        message = "Текущая ветка ещё не опубликована в origin.";
      }
    } else if (ahead > 0 && behind > 0) {
      state = "diverged";
      message = `Локальная ветка и ${pullSource} разошлись; сначала объедините изменения.`;
    } else if (ahead > 0) {
      state = "ahead";
      message = `Локальная ветка впереди на ${ahead}.`;
    } else if (behind > 0) {
      state = "behind";
      message = `${pullSource} впереди на ${behind}.`;
    } else {
      state = "synchronized";
      message = "Локальная ветка синхронизирована с origin.";
    }
    if (summary.dirty) {
      message += ` Незакоммиченных изменений: ${summary.changes}.`;
    }

    return {
      ...base,
      defaultBranch,
      pullSource,
      published,
      ahead,
      behind,
      state,
      message,
      canPush: !published || (ahead > 0 && behind === 0),
      canPull: !summary.dirty && Boolean(pullSource) && ahead === 0 && behind > 0,
    };
  }

  async pushCurrentBranch(expectedHead: string): Promise<RepositorySyncStatus> {
    const status = await this.repositoryStatus(true);
    this.verifyExpectedHead(status, expectedHead);
    if (!status.remote) throw new GitInspectorError("origin не настроен");
    if (status.state === "error") throw new GitInspectorError(status.message);
    if (!status.canPush) {
      if (status.behind > 0) {
        throw new GitInspectorError(
          "в origin есть отсутствующие локально коммиты; сначала выполните Pull, merge или rebase",
        );
      }
      return status;
    }
    const target = `refs/heads/${status.branch}`;
    const endpoints = await this.repositoryEndpoints();
    const pushed = await this.git(
      ["push", "--porcelain", "--", endpoints.push, `${status.head}:${target}`],
      { allowFailure: true, env: this.repositoryEnvironment() },
    );
    if (pushed.code !== 0) {
      throw new GitInspectorError(`Push в origin не выполнен: ${gitFailure(pushed, status.remote)}`);
    }
    return this.repositoryStatus(true);
  }

  async pullCurrentBranch(expectedHead: string): Promise<RepositorySyncStatus> {
    const status = await this.repositoryStatus(true);
    this.verifyExpectedHead(status, expectedHead);
    if (!status.remote) throw new GitInspectorError("origin не настроен");
    if (status.state === "error") throw new GitInspectorError(status.message);
    if (status.dirty) {
      throw new GitInspectorError(
        "перед Pull закоммитьте или отмените незакоммиченные изменения",
      );
    }
    if (status.ahead > 0 && status.behind > 0) {
      throw new GitInspectorError(
        "локальная ветка и origin разошлись; выполните merge или rebase явно",
      );
    }
    if (!status.pullSource) throw new GitInspectorError("в origin нет ветки для Pull");
    if (status.behind === 0) return status;
    const merged = await this.git(["merge", "--ff-only", status.pullSource], {
      allowFailure: true,
    });
    if (merged.code !== 0) {
      throw new GitInspectorError(`Pull из origin не выполнен: ${gitFailure(merged, status.remote)}`);
    }
    return this.repositoryStatus(false);
  }

  private verifyExpectedHead(status: RepositorySyncStatus, expectedHead: string): void {
    if (!/^[0-9a-f]{40}$/.test(expectedHead) || expectedHead !== status.head) {
      throw new GitInspectorError(
        "репозиторий изменился после отображения; обновите состояние и попробуйте снова",
      );
    }
  }

  private repositoryEnvironment(): NodeJS.ProcessEnv {
    return safeCommandEnvironment({
      GIT_ASKPASS: "/bin/false",
      GIT_SSH_COMMAND: "/usr/bin/ssh",
      SSH_ASKPASS: "/bin/false",
    });
  }

  private async repositoryEndpoints(): Promise<{ fetch: string; push: string }> {
    await this.rejectUnsafeRepositoryConfig("--local");
    await this.rejectUnsafeRepositoryConfig("--worktree");
    const [fetchResult, pushResult] = await Promise.all([
      this.git(["remote", "get-url", "origin"]),
      this.git(["remote", "get-url", "--push", "origin"]),
    ]);
    const fetch = text(fetchResult).trim();
    const push = text(pushResult).trim();
    await this.validateRemoteEndpoint(fetch);
    await this.validateRemoteEndpoint(push);
    return { fetch, push };
  }

  private async rejectUnsafeRepositoryConfig(scope: "--local" | "--worktree"): Promise<void> {
    const result = await this.git(
      ["config", scope, "--name-only", "--get-regexp", ".*"],
      { allowFailure: true },
    );
    if (result.code !== 0) return;
    const unsafe = text(result).split(/\r?\n/).map((key) => key.trim().toLowerCase()).find((key) =>
      key === "core.askpass" ||
      key === "core.sshcommand" ||
      key.startsWith("include.") ||
      key.startsWith("includeif.") ||
      (key.startsWith("url.") && key.endsWith(".insteadof")) ||
      (key.startsWith("credential.") && key.endsWith(".helper")) ||
      (key.startsWith("filter.") && [".clean", ".smudge", ".process"].some((suffix) =>
        key.endsWith(suffix)
      ))
    );
    if (unsafe) {
      throw new GitInspectorError(
        `Синхронизация отключена: небезопасная project-local Git настройка ${unsafe}.`,
      );
    }
  }

  private async validateRemoteEndpoint(value: string): Promise<void> {
    if (/^https:\/\//i.test(value)) {
      const parsed = new URL(value);
      if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) return;
      throw new GitInspectorError("Синхронизация отключена: token нельзя хранить в Git URL.");
    }
    if (/^ssh:\/\//i.test(value)) {
      const parsed = new URL(value);
      if (parsed.hostname && !parsed.password && !parsed.search && !parsed.hash) return;
    }
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return;

    let localPath = value;
    if (/^file:\/\//i.test(value)) {
      try {
        localPath = new URL(value).pathname;
      } catch {
        localPath = "";
      }
    }
    if (localPath && !localPath.includes("\0") && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(localPath)) {
      try {
        const [endpoint, common] = await Promise.all([
          realpath(resolve(this.root, localPath)),
          this.commonDirectory(),
        ]);
        if (endpoint === common || endpoint.startsWith(`${common}${sep}`)) return;
      } catch {
        // Report the same bounded error for absent and out-of-scope local repositories.
      }
    }
    throw new GitInspectorError(
      "Синхронизация поддерживает SSH/HTTPS origin или local test remote внутри Git directory.",
    );
  }

  private async defaultRemoteBranch(): Promise<string> {
    const symbolic = await this.git(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { allowFailure: true },
    );
    const symbolicName = symbolic.code === 0 ? text(symbolic).trim() : "";
    if (symbolicName.startsWith("origin/") && symbolicName !== "origin/HEAD") {
      const target = await this.git(
        ["show-ref", "--verify", "--quiet", `refs/remotes/${symbolicName}`],
        { allowFailure: true },
      );
      if (target.code === 0) return symbolicName;
    }
    for (const branch of ["main", "master"]) {
      const result = await this.git(
        ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
        { allowFailure: true },
      );
      if (result.code === 0) return `origin/${branch}`;
    }
    const refs = text(await this.git([
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/remotes/origin",
    ])).split(/\r?\n/).map((value) => value.trim()).filter((value) =>
      value.startsWith("origin/") && value !== "origin/HEAD"
    );
    return refs.length === 1 ? refs[0]! : "";
  }

  async tree(): Promise<TreeEntry[]> {
    const [filesResult, statusResult] = await Promise.all([
      this.git(["ls-files", "-co", "--exclude-standard", "-z"]),
      this.git(["status", "--porcelain=v1", "-z", "-uall"]),
    ]);
    const status = new Map<string, string>();
    const records = text(statusResult).split("\0");
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.length < 4) continue;
      const code = record.slice(0, 2).trim() || "M";
      const path = record.slice(3);
      status.set(path, code === "??" ? "untracked" : code);
      if (record[0] === "R" || record[0] === "C") index += 1;
    }
    return [...new Set(text(filesResult).split("\0").filter(Boolean))]
      .filter((path) => !deniedPath(path))
      .sort((left, right) => left.localeCompare(right))
      .map((path) => ({ path, status: status.get(path) ?? "" }));
  }

  async file(path: string): Promise<{ path: string; content: string; bytes: number }> {
    const normalized = normalizedRelativePath(path);
    const target = resolve(this.root, normalized);
    const root = await realpath(this.root);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new GitInspectorError("project path is not a regular file");
    }
    const canonical = await realpath(target);
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
      throw new GitInspectorError("project path escapes its worktree");
    }
    if (metadata.size > MAX_FILE_BYTES) {
      throw new GitInspectorError(`file exceeds ${MAX_FILE_BYTES} bytes`);
    }
    const body = await readFile(canonical);
    if (body.includes(0)) throw new GitInspectorError("binary files are not displayed");
    return { path: normalized, content: body.toString("utf8"), bytes: body.length };
  }

  async workingDiff(): Promise<string> {
    const tracked = await this.git(["diff", "--no-ext-diff", "--no-color", "HEAD", "--"]);
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    const sections = [text(tracked).trimEnd()];
    for (const path of text(untracked).split("\0").filter(Boolean)) {
      if (deniedPath(path)) continue;
      try {
        const file = await this.file(path);
        const lines = file.content.split("\n");
        sections.push([
          `diff --git a/${path} b/${path}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${path}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((line) => `+${line}`),
        ].join("\n"));
      } catch {
        sections.push(`diff --git a/${path} b/${path}\nBinary or oversized untracked file omitted`);
      }
    }
    return sections.filter(Boolean).join("\n\n").slice(0, MAX_GIT_OUTPUT);
  }

  async commits(limit = 30): Promise<CommitSummary[]> {
    const result = await this.git([
      "log",
      `-${Math.max(1, Math.min(limit, 100))}`,
      "--date=iso-strict",
      "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e",
    ]);
    return text(result).split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [hash = "", shortHash = "", author = "", authoredAt = "", subject = ""] = entry.split("\x1f");
      return { hash, shortHash, author, authoredAt, subject };
    });
  }

  async commitDiff(base: string, head: string): Promise<string> {
    const left = await this.resolveRevision(base);
    const right = await this.resolveRevision(head);
    const result = await this.git(["diff", "--no-ext-diff", "--no-color", left, right, "--"]);
    return text(result).slice(0, MAX_GIT_OUTPUT);
  }

  async resolveRevision(revision: string): Promise<string> {
    if (!revision || revision.startsWith("-") || !/^[A-Za-z0-9_./~^]{1,120}$/.test(revision)) {
      throw new GitInspectorError("invalid Git revision");
    }
    const result = await this.git(["rev-parse", "--verify", `${revision}^{commit}`]);
    return text(result).trim();
  }

  private async removePrivateIndexEntries(env: NodeJS.ProcessEnv): Promise<void> {
    const indexed = text(await this.git(["ls-files", "-z"], { env }))
      .split("\0")
      .filter((path) => path && deniedPath(path));
    for (let offset = 0; offset < indexed.length; offset += 100) {
      await this.git(
        ["update-index", "--force-remove", "--", ...indexed.slice(offset, offset + 100)],
        { env },
      );
    }
  }

  async snapshot(label: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "summing-index-"));
    const indexPath = join(directory, "index");
    const env = safeCommandEnvironment({ GIT_INDEX_FILE: indexPath });
    try {
      await this.git(["read-tree", "HEAD"], { env });
      await this.git(["add", "-A", "--", "."], { env });
      await this.removePrivateIndexEntries(env);
      const tree = text(await this.git(["write-tree"], { env })).trim();
      const head = text(await this.git(["rev-parse", "HEAD"])).trim();
      const committed = await this.git(
        ["commit-tree", tree, "-p", head, "-m", `SUMMING snapshot: ${label}`],
        { env },
      );
      return text(committed).trim();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async archive(revision: string): Promise<Buffer> {
    const resolved = await this.resolveRevision(revision);
    const directory = await mkdtemp(join(tmpdir(), "summing-archive-index-"));
    const indexPath = join(directory, "index");
    const env = safeCommandEnvironment({ GIT_INDEX_FILE: indexPath });
    try {
      await this.git(["read-tree", resolved], { env });
      await this.removePrivateIndexEntries(env);
      const tree = text(await this.git(["write-tree"], { env })).trim();
      const result = await command(
        "git",
        ["-C", this.root, "archive", "--format=tar", tree],
        this.root,
        safeCommandEnvironment(),
        MAX_ARCHIVE_BYTES,
      );
      if (result.code !== 0) {
        throw new GitInspectorError(result.stderr.trim() || "git archive failed");
      }
      return result.stdout;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  static async worktreeRoot(path: string): Promise<string> {
    const result = await command("git", ["-C", path, "rev-parse", "--show-toplevel"], path);
    if (result.code !== 0) throw new GitInspectorError(result.stderr.trim() || "not a Git worktree");
    return result.stdout.toString("utf8").trim();
  }
}
