import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
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

function gitOutput(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): void {
  gitOutput(cwd, ...args);
}

test("upgrades the previous identity, worktree branch, and runtime directory to SUMMING", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-workspace-upgrade-"));
  try {
    const source = join(root, "repo");
    mkdirSync(source, { recursive: true });
    git(source, "init");
    git(source, "config", "user.email", "test@example.com");
    git(source, "config", "user.name", "Test");
    writeFileSync(join(source, "README.md"), "demo\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "initial");

    const workspace: WorkspaceConfig = { id: "repo", path: source };
    const project = new ProjectConfig(
      "summing",
      "SUMMING",
      "repo",
      new Map([["repo", workspace]]),
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
      new Map([["summing", project]]),
    );
    const manager = new WorkspaceManager(config);
    const retiredIdentity = "Sum" + "mate";
    mkdirSync(join(config.dataDir, "memory"), { recursive: true });
    writeFileSync(
      manager.identityPath,
      `# ${retiredIdentity} identity\n\n` +
        `I am ${retiredIdentity}, one persistent agent serving one owner through Telegram.\n` +
        "I preserve continuity across projects and change my own code only on the " +
        "owner's direct request.\n",
    );
    manager.initialize();
    assert.match(readFileSync(manager.identityPath, "utf8"), /^# SUMMING identity$/m);

    const conversation: Conversation = {
      id: "tg-upgrade",
      chatId: -1,
      topicId: 2,
      projectId: "summing",
      workspaceId: "repo",
      role: "primary",
      codexThreadId: null,
      codexThreadCapability: "",
      previousCodexThreadId: null,
      readOnlyCodexThreadId: null,
      activeTurnId: null,
      streamMessageId: null,
      worktreePath: null,
    };
    const worktree = join(config.worktreeRoot, conversation.id);
    mkdirSync(config.worktreeRoot, { recursive: true });
    const retiredPrefix = retiredIdentity.toLowerCase();
    git(
      source,
      "worktree",
      "add",
      "-b",
      `${retiredPrefix}/${retiredPrefix}/${conversation.id}`,
      worktree,
      "HEAD",
    );
    const retiredRuntime = join(worktree, `.${retiredPrefix}-runtime`);
    mkdirSync(retiredRuntime);
    writeFileSync(join(retiredRuntime, "sentinel.txt"), "preserved\n");
    writeFileSync(join(source, ".git", "info", "exclude"), `.${retiredPrefix}-runtime/\n`);

    await manager.prepare(conversation, project, workspace);

    assert.equal(existsSync(retiredRuntime), false);
    assert.equal(
      readFileSync(join(worktree, ".summing-runtime", "sentinel.txt"), "utf8"),
      "preserved\n",
    );
    const branch = spawnSync("git", ["branch", "--show-current"], {
      cwd: worktree,
      encoding: "utf8",
    });
    assert.equal(branch.status, 0, branch.stderr);
    assert.equal(branch.stdout.trim(), `summing/${project.id}/${conversation.id}`);
    const exclude = readFileSync(join(source, ".git", "info", "exclude"), "utf8");
    assert.doesNotMatch(exclude, new RegExp(retiredPrefix, "iu"));
    assert.match(exclude, /^\.summing-runtime\/$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conversation gets a persistent worktree and project memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-workspace-"));
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
    const hookMarker = join(root, "host-hook-ran");
    writeFileSync(
      join(source, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(hookMarker)}\n`,
      { mode: 0o700 },
    );

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
    Object.defineProperty(config, "maximumAttachmentBytes", { value: 16 });
    const manager = new WorkspaceManager(config);
    manager.initialize();
    rmSync(manager.projectMemoryPath(project.id));
    const conversation: Conversation = {
      id: "tg-abc",
      chatId: -1,
      topicId: 2,
      projectId: "demo",
      workspaceId: "app",
      role: "primary",
      codexThreadId: null,
      codexThreadCapability: "",
      previousCodexThreadId: null,
      readOnlyCodexThreadId: null,
      activeTurnId: null,
      streamMessageId: null,
      worktreePath: null,
    };
    const prepared = await manager.prepare(conversation, project, workspace);
    assert.equal(existsSync(hookMarker), false);
    assert.equal(
      readFileSync(manager.projectMemoryPath(project.id), "utf8"),
      "# Project memory: Demo\n\n",
    );
    assert.notEqual(prepared.path, source);
    assert.equal(prepared.path.split("/").at(-1), "web");
    assert.equal(prepared.readableRoot, join(root, "worktrees", conversation.id));
    assert.deepEqual(prepared.gitMetadataRoots, [
      realpathSync(join(source, ".git")),
      realpathSync(gitOutput(prepared.readableRoot, "rev-parse", "--git-dir")),
    ]);
    const readOnlyDeniedPaths = await manager.readOnlyDeniedPaths(prepared.readableRoot);
    assert.ok(readOnlyDeniedPaths.includes(".git"));
    assert.ok(readOnlyDeniedPaths.includes(".ssh"));
    assert.ok(readOnlyDeniedPaths.includes(".envrc"));
    assert.ok(readOnlyDeniedPaths.includes(".git-credentials"));
    assert.ok(readOnlyDeniedPaths.includes("apps/web/.summing-runtime"));
    assert.ok(readOnlyDeniedPaths.includes(deepSecretRelative));
    const legacyMemory = join(prepared.path, ".summing-runtime", "PROJECT_MEMORY.md");
    writeFileSync(legacyMemory, "legacy runtime memory\n");
    await manager.prepare(conversation, project, workspace);
    assert.equal(existsSync(legacyMemory), false);
    const context = readFileSync(
      join(prepared.path, ".summing-runtime", "CONTEXT.md"),
      "utf8",
    );
    assert.match(context, /write each final deliverable/);
    assert.match(context, /combined size must not exceed 16 bytes/);
    const outbox = join(prepared.path, ".summing-runtime", "outbox");
    const outboxOutside = join(root, "outbox-outside.txt");
    writeFileSync(outboxOutside, "outside\n");
    writeFileSync(join(outbox, "report.pdf"), Uint8Array.from([1, 2, 3, 4]));
    writeFileSync(join(outbox, "too-large.txt"), "x".repeat(17));
    mkdirSync(join(outbox, "nested"));
    symlinkSync(outboxOutside, join(outbox, "outside-link.txt"));
    linkSync(outboxOutside, join(outbox, "outside-hardlink.txt"));
    const collected = manager.collectOutbox(prepared);
    assert.deepEqual(
      collected.documents.map((document) => ({
        fileName: document.fileName,
        mimeType: document.mimeType,
        size: document.size,
        data: [...document.data],
      })),
      [{
        fileName: "report.pdf",
        mimeType: "application/pdf",
        size: 4,
        data: [1, 2, 3, 4],
      }],
    );
    assert.equal(collected.warnings.length, 4);
    assert.ok(collected.warnings.some((warning) => warning.includes("too-large.txt")));
    assert.ok(collected.warnings.some((warning) => warning.includes("nested")));
    assert.ok(collected.warnings.some((warning) => warning.includes("outside-link.txt")));
    assert.ok(collected.warnings.some((warning) => warning.includes("outside-hardlink.txt")));
    await manager.prepare(conversation, project, workspace);
    assert.deepEqual(readdirSync(outbox), []);
    const localMemory = join(
      prepared.path,
      ".summing-runtime",
      "memory",
      "PROJECT_MEMORY.md",
    );
    assert.ok(readFileSync(join(prepared.path, ".summing-runtime", "CONTEXT.md"), "utf8"));
    const spoolDir = join(root, "data", "attachments", conversation.id);
    mkdirSync(spoolDir, { recursive: true });
    const spoolFile = join(spoolDir, "source.zip");
    writeFileSync(spoolFile, "PK test archive");
    const materialized = manager.materializeAttachments(prepared, [{
      inputId: 7,
      telegramMessageId: 99,
      attachment: {
        kind: "document",
        fileName: "source.zip",
        mimeType: "application/zip",
        filePath: spoolFile,
        size: 15,
      },
    }]);
    assert.deepEqual(materialized.map((item) => item.relativePath), [
      ".summing-runtime/attachments/99-7-source.zip",
    ]);
    assert.equal(
      readFileSync(join(prepared.path, materialized[0]!.relativePath), "utf8"),
      "PK test archive",
    );
    const portalDocument = manager.portalDocument(prepared, materialized[0]!.relativePath);
    assert.equal(portalDocument.fileName, "99-7-source.zip");
    assert.equal(Buffer.from(portalDocument.data).toString("utf8"), "PK test archive");
    writeFileSync(join(prepared.path, ".env.portal"), "API_TOKEN=secret\n");
    await assert.rejects(
      async () => manager.portalDocument(prepared, ".env.portal"),
      /unsafe Project portal file path|credentials or unscanned secrets/,
    );
    await assert.rejects(
      async () => manager.materializeAttachments(prepared, [{
        inputId: 8,
        telegramMessageId: 100,
        attachment: {
          kind: "document",
          fileName: "outside.txt",
          mimeType: "text/plain",
          filePath: join(root, "outside-secret"),
          size: 1,
        },
      }]),
      /outside private spool/,
    );
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

test("observer worktree follows the published repository HEAD by fast-forward", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-observer-workspace-"));
  try {
    const source = join(root, "repo");
    mkdirSync(source);
    git(source, "init");
    git(source, "config", "user.email", "test@example.com");
    git(source, "config", "user.name", "Test");
    writeFileSync(join(source, "README.md"), "published v1\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "published v1");
    const workspace: WorkspaceConfig = { id: "repo", path: source };
    const project = new ProjectConfig("demo", "Demo", "repo", new Map([["repo", workspace]]));
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
      id: "tg-observer",
      chatId: -100,
      topicId: 9,
      projectId: "demo",
      workspaceId: "repo",
      role: "observer",
      codexThreadId: null,
      codexThreadCapability: "",
      previousCodexThreadId: null,
      readOnlyCodexThreadId: null,
      activeTurnId: null,
      streamMessageId: null,
      worktreePath: null,
    };
    const first = await manager.prepare(conversation, project, workspace);
    assert.equal(readFileSync(join(first.path, "README.md"), "utf8"), "published v1\n");

    writeFileSync(join(source, "README.md"), "published v2\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "published v2");
    const second = await manager.prepare(conversation, project, workspace);
    assert.equal(readFileSync(join(second.path, "README.md"), "utf8"), "published v2\n");
    assert.equal(
      gitOutput(second.readableRoot, "rev-parse", "HEAD"),
      gitOutput(source, "rev-parse", "HEAD"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
