import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import { LocalObjectStore } from "../src/object-store.js";
import {
  NodeRecoveryManager,
  parseNodeRecoveryKey,
  unwrapNodeRecoveryKey,
  wrapNodeRecoveryKey,
} from "../src/node-recovery.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { StateStore } from "../src/state-store.js";

function git(repository: string, ...args: string[]): void {
  execFileSync("git", ["-C", repository, ...args], {
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: repository },
  });
}

test("node recovery exports, verifies and stages portable node state", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-node-recovery-"));
  const dataDir = join(root, "data");
  const repository = join(root, "repo");
  const discoveredRepository = join(dataDir, "repositories", "orphan", "source");
  const codexHome = join(dataDir, "codex");
  mkdirSync(repository, { recursive: true });
  mkdirSync(discoveredRepository, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  mkdirSync(join(dataDir, "projects", "demo"), { recursive: true });
  mkdirSync(join(codexHome, "sessions", "2026", "08", "18"), { recursive: true });
  git(repository, "init", "--initial-branch=master");
  git(repository, "config", "user.name", "SUMMING Test");
  git(repository, "config", "user.email", "summing@example.invalid");
  writeFileSync(join(repository, "tracked.txt"), "base\n");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-m", "base");
  writeFileSync(join(repository, "tracked.txt"), "changed\n");
  writeFileSync(join(repository, "untracked.txt"), "portable\n");
  git(discoveredRepository, "init", "--initial-branch=master");
  git(discoveredRepository, "config", "user.name", "SUMMING Test");
  git(discoveredRepository, "config", "user.email", "summing@example.invalid");
  writeFileSync(join(discoveredRepository, "orphan.txt"), "must survive\n");
  git(discoveredRepository, "add", "orphan.txt");
  git(discoveredRepository, "commit", "-m", "orphan base");
  writeFileSync(join(dataDir, "memory", "identity.md"), "node identity\n");
  writeFileSync(join(dataDir, "projects", "demo", "memory.md"), "project memory\n");

  const workspace: WorkspaceConfig = { id: "repo", path: repository };
  const config = new RuntimeConfig(
    dataDir,
    codexHome,
    join(dataDir, "worktrees"),
    "bot-token",
    1,
    "codex",
    8_765,
    2,
    1,
    "",
    "medium",
    true,
    new Map([["demo", new ProjectConfig(
      "demo", "Demo", "repo", new Map([["repo", workspace]]), true,
    )]]),
  );
  const state = new StateStore(join(dataDir, "state.sqlite3"));
  const threadId = "11111111-1111-4111-8111-111111111111";
  const sessionPath = join(codexHome, "sessions", "2026", "08", "18", `${threadId}.jsonl`);
  writeFileSync(sessionPath, "{\"type\":\"session_meta\"}\n");
  writeFileSync(join(codexHome, "session_index.jsonl"), `{\"threadId\":\"${threadId}\"}\n`);
  writeFileSync(join(codexHome, "auth.json"), "{\"token\":\"must-not-export\"}\n");
  const conversation = state.bind(-100, 7, "demo", "repo");
  state.setThread(conversation.id, threadId, "write", "runner-control-v1");
  const store = new LocalObjectStore(join(root, "objects"));
  let teamReferences = [{
    spaceId: "space-1",
    title: "Team One",
    bundleKey: "summing/exports/space-1/manifest.json",
    mode: "portable",
    createdAt: 123,
  }];
  const manager = new NodeRecoveryManager(
    config,
    state,
    new ProjectCatalog(config, state),
    store,
    () => teamReferences,
    async () => ({ text: "PRIVATE_TOKEN=recovered\n", revision: 3, updatedAt: "2026-08-18T00:00:00.000Z" }),
  );
  try {
    const exported = await manager.export({ includeSecrets: false });
    assert.match(exported.recoveryKey, /^[a-f0-9]{64}$/);
    assert.equal(exported.includeSecrets, false);
    assert.equal(await store.exists(exported.bundleKey), true);
    const recoveryKey = parseNodeRecoveryKey(exported.recoveryKey);
    try {
      const inspection = await manager.inspect(exported.bundleKey, recoveryKey);
      assert.equal(inspection.ready, true);
      assert.equal(inspection.inventory.conversations, 1);
      assert.equal(inspection.inventory.teamSpaces[0]?.bundleKey, "summing/exports/space-1/manifest.json");
      assert.equal(inspection.inventory.sessions[0]?.state, "resumable");
      const configuredWorkspace = inspection.inventory.workspaces.find((item) => item.originalPath === repository);
      const discoveredWorkspace = inspection.inventory.workspaces.find(
        (item) => item.originalPath === discoveredRepository,
      );
      assert.equal(configuredWorkspace?.state, "captured");
      assert.equal(discoveredWorkspace?.kind, "discovered");
      assert.equal(discoveredWorkspace?.state, "captured");
      assert.equal(inspection.components.some((component) => component.kind === "secrets"), false);
      assert.match(inspection.restore.excluded.join("\n"), /Team Space contents/);
      assert.match(inspection.restore.reconnectRequired.join("\n"), /Codex account/);

      const staged = await manager.stage(exported.bundleKey, recoveryKey, join(root, "staging"));
      const stagedState = join(
        staged.stagePath,
        "components",
        "node-state",
        "payload",
        "data",
        "state.sqlite3",
      );
      const db = new DatabaseSync(stagedState, { readOnly: true });
      try {
        const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
          .map((row) => row.name);
        assert.equal(names.includes("conversations"), true);
        assert.equal(names.some((name) => name.startsWith("team_")), false);
      } finally {
        db.close();
      }
      assert.equal(readFileSync(join(
        staged.stagePath,
        "components",
        "node-state",
        "payload",
        "data",
        "memory",
        "identity.md",
      ), "utf8"), "node identity\n");
      assert.equal(readFileSync(join(
        staged.stagePath,
        "components",
        "node-state",
        "payload",
        "data",
        "projects",
        "demo",
        "memory.md",
      ), "utf8"), "project memory\n");
      assert.equal(readFileSync(join(
        staged.stagePath,
        "components",
        "codex-sessions",
        "payload",
        "data",
        "codex",
        "session_index.jsonl",
      ), "utf8"), `{\"threadId\":\"${threadId}\"}\n`);
      assert.ok(configuredWorkspace);
      const workspaceRoot = join(
        staged.stagePath,
        "components",
        configuredWorkspace.componentId,
        "payload",
        "meta",
      );
      assert.equal(readFileSync(join(workspaceRoot, "metadata.json"), "utf8").includes("untracked.txt"), true);
      assert.throws(() => readFileSync(join(
        staged.stagePath,
        "components",
        "codex-sessions",
        "payload",
        "data",
        "codex",
        "auth.json",
      )));
      await assert.rejects(manager.stage(exported.bundleKey, recoveryKey, join(root, "staging")), /already staged/);
    } finally {
      recoveryKey.fill(0);
    }
    const wrongKey = parseNodeRecoveryKey("a".repeat(64));
    try {
      await assert.rejects(manager.inspect(exported.bundleKey, wrongKey), /signature is invalid/);
    } finally {
      wrongKey.fill(0);
    }

    const team = state.ensureTeamSource({
      provider: "telegram",
      externalSpaceId: "-100",
      externalThreadId: "0",
      spaceName: "Current Team",
      sourceTitle: "Current Team",
      administratorUserId: 1,
      joinedAt: 100,
    }).space;
    teamReferences = [];
    await assert.rejects(
      manager.export({ includeSecrets: true }),
      /has no successful export bundle/,
    );
    teamReferences = [{
      spaceId: team.id,
      title: team.name,
      bundleKey: "summing/exports/current/manifest.json",
      mode: "manifest",
      createdAt: 101,
    }];
    const secretExport = await manager.export({ includeSecrets: true });
    const secretKey = parseNodeRecoveryKey(secretExport.recoveryKey);
    try {
      const staged = await manager.stage(secretExport.bundleKey, secretKey, join(root, "secret-staging"));
      const recoveredEnvironments = readFileSync(join(
        staged.stagePath,
        "components",
        "secrets",
        "payload",
        "data",
        "connector-core",
        "project-environments.json",
      ), "utf8");
      assert.match(recoveredEnvironments, /PRIVATE_TOKEN=recovered/);
      const objectFiles = readdirSync(join(root, "objects"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".enc"));
      assert.equal(objectFiles.length > 0, true);
    } finally {
      secretKey.fill(0);
    }
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("node recovery durable jobs wrap their one-time key under a node-local key", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-node-recovery-key-"));
  const localKeyPath = join(root, "local.key");
  const recoveryKey = parseNodeRecoveryKey("b".repeat(64));
  try {
    writeFileSync(localKeyPath, `${"a".repeat(64)}\n`, { mode: 0o600 });
    const wrapped = wrapNodeRecoveryKey(
      localKeyPath,
      "11111111-1111-4111-8111-111111111111",
      recoveryKey,
    );
    assert.doesNotMatch(wrapped, /b{32}/);
    const unwrapped = unwrapNodeRecoveryKey(
      localKeyPath,
      "11111111-1111-4111-8111-111111111111",
      wrapped,
    );
    try {
      assert.deepEqual(unwrapped, recoveryKey);
    } finally {
      unwrapped.fill(0);
    }
    assert.throws(() => unwrapNodeRecoveryKey(
      localKeyPath,
      "22222222-2222-4222-8222-222222222222",
      wrapped,
    ));
  } finally {
    recoveryKey.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});
