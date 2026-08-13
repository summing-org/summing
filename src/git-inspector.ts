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
  environment: NodeJS.ProcessEnv = process.env,
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

export class GitInspector {
  constructor(readonly root: string) {}

  private async git(args: string[], options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
    const result = await command("git", ["-C", this.root, ...args], this.root, options.env);
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
      remote: remote.code === 0 ? text(remote).trim() : "",
      dirty: changes > 0,
      changes,
    };
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

  async snapshot(label: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "summing-index-"));
    const indexPath = join(directory, "index");
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
      await this.git(["read-tree", "HEAD"], { env });
      await this.git(["add", "-A", "--", "."], { env });
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
    const result = await command(
      "git",
      ["-C", this.root, "archive", "--format=tar", resolved],
      this.root,
      process.env,
      MAX_ARCHIVE_BYTES,
    );
    if (result.code !== 0) throw new GitInspectorError(result.stderr.trim() || "git archive failed");
    return result.stdout;
  }

  static async worktreeRoot(path: string): Promise<string> {
    const result = await command("git", ["-C", path, "rev-parse", "--show-toplevel"], path);
    if (result.code !== 0) throw new GitInspectorError(result.stderr.trim() || "not a Git worktree");
    return result.stdout.toString("utf8").trim();
  }
}
