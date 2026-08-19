import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { ManagedProjectRunnerRegistry } from "../src/managed-project-runner-registry.js";
import type { RunnerProjectRegistration } from "../src/project-runner-client.js";
import { StateStore } from "../src/state-store.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(): {
  root: string;
  config: RuntimeConfig;
  state: StateStore;
} {
  const root = mkdtempSync(join(tmpdir(), "summing-project-catalog-"));
  const staticPath = join(root, "summing");
  mkdirSync(staticPath);
  const workspace: WorkspaceConfig = { id: "repo", path: staticPath };
  const staticProject = new ProjectConfig(
    "summing",
    "SUMMING",
    "repo",
    new Map([["repo", workspace]]),
    true,
  );
  const config = new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "token",
    1,
    "codex",
    8765,
    2,
    1,
    "",
    "medium",
    true,
    new Map([["summing", staticProject]]),
  );
  return {
    root,
    config,
    state: new StateStore(join(config.dataDir, "state.sqlite3")),
  };
}

test("creates a persistent managed Git repository and enforces project ownership", async () => {
  const { root, config, state } = fixture();
  try {
    const catalog = new ProjectCatalog(config, state);
    const project = await catalog.createLocal("client_name", "42", "repo_name");
    const repository = join(config.dataDir, "repositories", "client_name", "repo_name");

    assert.equal(project.workspace().path, repository);
    assert.equal(git(repository, "branch", "--show-current"), "main");
    assert.ok(git(repository, "rev-parse", "HEAD"));
    assert.equal(
      readFileSync(join(config.dataDir, "projects", "client_name", "memory.md"), "utf8"),
      "# Project memory: client_name\n\n",
    );
    assert.equal(catalog.canAccess(42, "client_name"), true);
    assert.equal(catalog.canAccess(42, "summing"), false);
    assert.deepEqual(catalog.visibleTo(42).map((entry) => entry.project.id), ["client_name"]);
    assert.deepEqual(
      catalog.visibleTo(1).map((entry) => entry.project.id),
      ["client_name", "summing"],
    );
    catalog.replaceOwners("client_name", 42, [42, 77]);
    assert.equal(catalog.canAccess(77, "client_name"), true);
    assert.deepEqual(catalog.owners("client_name"), [42, 77]);
    catalog.replaceOwners("client_name", 77, [42, 77]);
    assert.equal(catalog.owner("client_name"), 77);
    assert.deepEqual(catalog.owners("client_name"), [77, 42]);
    catalog.replaceOwners("client_name", 77, [77, 88]);
    assert.equal(catalog.canAccess(42, "client_name"), false);
    assert.equal(catalog.canAccess(88, "client_name"), true);
    assert.throws(
      () => catalog.replaceOwners("summing", 1, [1]),
      /configured outside Mini App/,
    );

    state.close();
    const reopened = new StateStore(join(config.dataDir, "state.sqlite3"));
    try {
      const reloaded = new ProjectCatalog(config, reopened);
      assert.equal(reloaded.project("client_name").workspace().path, repository);
      assert.equal(reloaded.owner("client_name"), 77);
      assert.deepEqual(reloaded.owners("client_name"), [77, 88]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clones an existing repository into the managed project root", async () => {
  const { root, config, state } = fixture();
  try {
    const source = join(root, "source");
    mkdirSync(source);
    git(source, "init", "--initial-branch=main");
    git(source, "config", "user.name", "Test");
    git(source, "config", "user.email", "test@example.com");
    writeFileSync(join(source, "README.md"), "managed clone\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "initial");

    const catalog = new ProjectCatalog(config, state);
    const project = await catalog.cloneRemote("cloned", 77, "backend", source);
    assert.equal(readFileSync(join(project.workspace().path, "README.md"), "utf8"), "managed clone\n");
    assert.equal(
      readFileSync(join(config.dataDir, "projects", "cloned", "memory.md"), "utf8"),
      "# Project memory: cloned\n\n",
    );
    assert.equal(catalog.owner("cloned"), 77);

    const emptyRemote = join(root, "empty.git");
    mkdirSync(emptyRemote);
    git(emptyRemote, "init", "--bare");
    const empty = await catalog.cloneRemote("empty", 88, "repo", emptyRemote);
    assert.equal(git(empty.workspace().path, "branch", "--show-current"), "main");
    assert.ok(git(empty.workspace().path, "rev-parse", "HEAD"));

    const brokenHeadRemote = join(root, "broken-head.git");
    git(root, "clone", "--bare", source, brokenHeadRemote);
    git(brokenHeadRemote, "symbolic-ref", "HEAD", "refs/heads/missing");
    const preserved = await catalog.cloneRemote(
      "preserved",
      99,
      "repo",
      brokenHeadRemote,
    );
    assert.equal(
      readFileSync(join(preserved.workspace().path, "README.md"), "utf8"),
      "managed clone\n",
    );
    assert.equal(git(preserved.workspace().path, "branch", "--show-current"), "main");
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects project identifiers that cannot be used in SUMMING Git branches", async () => {
  const { root, config, state } = fixture();
  try {
    const catalog = new ProjectCatalog(config, state);
    await assert.rejects(
      catalog.createLocal("a..b", 42, "repo"),
      /valid Git branch component/,
    );
    await assert.rejects(
      catalog.createLocal("client.lock", 42, "repo"),
      /valid Git branch component/,
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleans up a failed clone so the project id can be retried", async () => {
  const { root, config, state } = fixture();
  try {
    const catalog = new ProjectCatalog(config, state);
    await assert.rejects(
      catalog.cloneRemote("retryable", 42, "repo", join(root, "missing-remote")),
      /git clone failed/,
    );
    const project = await catalog.createLocal("retryable", 42, "repo");
    assert.ok(git(project.workspace().path, "rev-parse", "HEAD"));
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("registers a managed project at creation and reconciles persisted projects after restart", async () => {
  const { root, config, state } = fixture();
  const calls: Array<{ projectId: string; workspaceIds: readonly string[] }> = [];
  let unavailable = true;
  const runner = {
    async registerProject(
      projectId: string,
      workspaceIds: readonly string[],
    ): Promise<RunnerProjectRegistration> {
      calls.push({ projectId, workspaceIds: [...workspaceIds] });
      if (unavailable) throw new Error("runner socket is unavailable");
      return { projectId, workspaceIds: [...workspaceIds], source: "managed" };
    },
  };
  let registry: ManagedProjectRunnerRegistry | null = null;
  const catalog = new ProjectCatalog(
    config,
    state,
    (project) => registry?.register(project),
  );
  registry = new ManagedProjectRunnerRegistry(runner, catalog, 10);
  try {
    await registry.start();
    const created = await catalog.createLocal("runner-ready", 42, "repo");
    assert.equal(created.id, "runner-ready");
    assert.deepEqual(calls, [{ projectId: "runner-ready", workspaceIds: ["repo"] }]);
    assert.equal(state.listManagedProjects().some((project) => project.id === "runner-ready"), true);

    unavailable = false;
    const retryDeadline = Date.now() + 1_000;
    while (calls.length < 2 && Date.now() < retryDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.ok(calls.length >= 2, "pending runner registration must be retried automatically");
    assert.deepEqual(calls.at(-1), { projectId: "runner-ready", workspaceIds: ["repo"] });

    const afterRestart = new ManagedProjectRunnerRegistry(runner, catalog, 60_000);
    await afterRestart.start();
    afterRestart.stop();
    assert.deepEqual(calls.at(-1), { projectId: "runner-ready", workspaceIds: ["repo"] });
  } finally {
    registry.stop();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
