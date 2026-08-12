import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import type { Conversation } from "../src/state-store.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("conversation gets a persistent worktree and project memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "summate-workspace-"));
  try {
    const source = join(root, "repo");
    const nested = join(source, "apps", "web");
    mkdirSync(nested, { recursive: true });
    const deepSecretRelative = [
      "deep",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      ".env",
    ].join("/");
    mkdirSync(join(source, deepSecretRelative, ".."), { recursive: true });
    mkdirSync(join(source, ".ssh"), { recursive: true });
    git(source, "init");
    git(source, "config", "user.email", "test@example.com");
    git(source, "config", "user.name", "Test");
    writeFileSync(join(nested, "README.md"), "demo\n");
    writeFileSync(join(source, deepSecretRelative), "secret=hidden\n");
    writeFileSync(join(source, ".ssh", "id_ed25519"), "private key\n");
    writeFileSync(join(source, ".envrc"), "export SECRET=hidden\n");
    writeFileSync(join(source, ".git-credentials"), "https://user:token@example.test\n");
    git(
      source,
      "add",
      "apps/web/README.md",
      deepSecretRelative,
      ".ssh/id_ed25519",
      ".envrc",
      ".git-credentials",
    );
    git(source, "commit", "-m", "initial");

    const workspace: WorkspaceConfig = { id: "app", path: nested };
    const project = new ProjectConfig("demo", "Demo", "app", new Map([["app", workspace]]));
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
      new Map([["demo", project]]),
    );
    const manager = new WorkspaceManager(config);
    manager.initialize();
    const conversation: Conversation = {
      id: "tg-abc",
      chatId: -1,
      topicId: 2,
      projectId: "demo",
      workspaceId: "app",
      codexThreadId: null,
      readOnlyCodexThreadId: null,
      activeTurnId: null,
      streamMessageId: null,
      worktreePath: null,
    };
    const prepared = await manager.prepare(conversation, project, workspace);
    assert.notEqual(prepared.path, source);
    assert.equal(prepared.path.split("/").at(-1), "web");
    assert.equal(prepared.readableRoot, join(root, "worktrees", conversation.id));
    assert.deepEqual(prepared.gitMetadataRoots, [realpathSync(join(source, ".git"))]);
    const readOnlyDeniedPaths = await manager.readOnlyDeniedPaths(prepared.readableRoot);
    assert.ok(readOnlyDeniedPaths.includes(".git"));
    assert.ok(readOnlyDeniedPaths.includes(".ssh"));
    assert.ok(readOnlyDeniedPaths.includes(".envrc"));
    assert.ok(readOnlyDeniedPaths.includes(".git-credentials"));
    assert.ok(readOnlyDeniedPaths.includes("apps/web/.summate-runtime"));
    assert.ok(readOnlyDeniedPaths.includes(deepSecretRelative));
    const localMemory = join(prepared.path, ".summate-runtime", "PROJECT_MEMORY.md");
    assert.ok(readFileSync(join(prepared.path, ".summate-runtime", "CONTEXT.md"), "utf8"));
    writeFileSync(localMemory, `${readFileSync(localMemory, "utf8")}\n- durable fact\n`);
    assert.equal(await manager.mergeProjectMemory("demo", prepared), null);
    assert.match(readFileSync(manager.projectMemoryPath("demo"), "utf8"), /durable fact/);

    const outside = join(root, "outside-secret");
    writeFileSync(outside, "must not enter project memory\n");
    rmSync(localMemory);
    symlinkSync(outside, localMemory);
    await assert.rejects(
      manager.mergeProjectMemory("demo", prepared),
      /unsafe project memory file/,
    );
    assert.doesNotMatch(
      readFileSync(manager.projectMemoryPath("demo"), "utf8"),
      /must not enter project memory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
