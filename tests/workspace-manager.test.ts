import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    git(source, "init");
    git(source, "config", "user.email", "test@example.com");
    git(source, "config", "user.name", "Test");
    writeFileSync(join(nested, "README.md"), "demo\n");
    git(source, "add", "apps/web/README.md");
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
      activeTurnId: null,
      streamMessageId: null,
      worktreePath: null,
    };
    const prepared = await manager.prepare(conversation, project, workspace);
    assert.notEqual(prepared.path, source);
    assert.equal(prepared.path.split("/").at(-1), "web");
    const localMemory = join(prepared.path, ".summate-runtime", "PROJECT_MEMORY.md");
    assert.ok(readFileSync(join(prepared.path, ".summate-runtime", "CONTEXT.md"), "utf8"));
    writeFileSync(localMemory, `${readFileSync(localMemory, "utf8")}\n- durable fact\n`);
    assert.equal(await manager.mergeProjectMemory("demo", prepared), null);
    assert.match(readFileSync(manager.projectMemoryPath("demo"), "utf8"), /durable fact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
