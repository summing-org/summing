import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitInspector, GitInspectorError } from "../src/git-inspector.js";

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "summing-inspector-"));
  execFileSync("git", ["init", "--initial-branch=main", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.test"]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}

function gitOutput(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("shows tracked and untracked files without exposing secrets", async () => {
  const root = repository();
  try {
    writeFileSync(join(root, "src", "main.ts"), "export const value = 2;\n");
    writeFileSync(join(root, "README.md"), "hello\n");
    writeFileSync(join(root, ".env"), "TOKEN=secret\n");
    const inspector = new GitInspector(root);
    const tree = await inspector.tree();
    assert.deepEqual(tree.map((entry) => entry.path), ["README.md", "src/main.ts"]);
    assert.equal(tree.find((entry) => entry.path === "README.md")?.status, "untracked");
    const diff = await inspector.workingDiff();
    assert.match(diff, /export const value = 2/);
    assert.match(diff, /new file mode 100644/);
    assert.doesNotMatch(diff, /TOKEN=secret/);
    await assert.rejects(inspector.file(".env"), GitInspectorError);
    execFileSync("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://embedded-token@example.test/project.git",
    ]);
    assert.equal(
      (await inspector.summary()).remote,
      "https://example.test/project.git",
    );
    const unsafeRemote = await inspector.repositoryStatus();
    assert.equal(unsafeRemote.state, "error");
    assert.match(unsafeRemote.message, /token нельзя хранить в Git URL/);
    execFileSync("git", [
      "-C",
      root,
      "remote",
      "set-url",
      "origin",
      "ssh://git@example.test/owner/project.git",
    ]);
    assert.equal(
      (await inspector.summary()).remote,
      "ssh://git@example.test/owner/project.git",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates immutable snapshots without changing the worktree index", async () => {
  const root = repository();
  try {
    writeFileSync(join(root, ".env.production"), "TRACKED_TOKEN=secret\n");
    writeFileSync(join(root, ".env.example"), "TOKEN=replace-me\n");
    execFileSync("git", ["-C", root, "add", ".env.production", ".env.example"]);
    execFileSync("git", ["-C", root, "commit", "-m", "tracked private fixture"]);
    writeFileSync(join(root, ".env"), "UNTRACKED_TOKEN=secret\n");
    const inspector = new GitInspector(root);
    const before = await inspector.snapshot("before");
    writeFileSync(join(root, "src", "main.ts"), "export const value = 3;\n");
    const after = await inspector.snapshot("after");
    assert.match(await inspector.commitDiff(before, after), /value = 3/);
    assert.throws(() => execFileSync(
      "git",
      ["-C", root, "cat-file", "-e", `${before}:.env`],
      { stdio: "ignore" },
    ));
    assert.throws(() => execFileSync(
      "git",
      ["-C", root, "cat-file", "-e", `${before}:.env.production`],
      { stdio: "ignore" },
    ));
    assert.doesNotThrow(() => execFileSync(
      "git",
      ["-C", root, "cat-file", "-e", `${before}:.env.example`],
      { stdio: "ignore" },
    ));
    const archived = execFileSync("/usr/bin/tar", ["-tf", "-"], {
      input: await inspector.archive("HEAD"),
      encoding: "utf8",
    });
    assert.doesNotMatch(archived, /\.env\.production/);
    assert.match(archived, /\.env\.example/);
    assert.match(archived, /src\/main\.ts/);
    assert.equal(execFileSync("git", ["-C", root, "diff", "--cached"]).toString(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("connects a missing origin only to a validated SSH URL and never replaces it", async () => {
  const root = repository();
  try {
    const inspector = new GitInspector(root);
    await assert.rejects(
      inspector.connectOrigin("https://github.com/example/project.git"),
      /Для deploy key используйте SSH URL/,
    );
    await assert.rejects(
      inspector.connectOrigin("ssh://git:secret@example.test/project.git"),
      /небезопасный формат/,
    );
    await assert.rejects(
      inspector.connectOrigin("git@example.test:owner/../project.git"),
      /Для deploy key используйте SSH URL/,
    );
    await assert.rejects(
      inspector.connectOrigin("ssh://git@-oProxyCommand.example/project.git"),
      /небезопасный формат/,
    );

    const connected = await inspector.connectOrigin("git@example.test:owner/project.git");
    assert.equal(connected.remote, "git@example.test:owner/project.git");
    assert.equal(connected.state, "unpublished");
    assert.equal(gitOutput(root, "remote", "get-url", "origin"), "git@example.test:owner/project.git");
    await assert.rejects(
      inspector.connectOrigin("git@example.test:owner/other.git"),
      /origin уже настроен/,
    );
    assert.equal(gitOutput(root, "remote", "get-url", "origin"), "git@example.test:owner/project.git");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishes and fast-forwards the current branch without force or automatic commits", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "summing-inspector-sync-"));
  const local = join(fixture, "local");
  const remote = join(local, ".git", "origin.git");
  const updater = join(fixture, "updater");
  try {
    execFileSync("git", ["init", "--initial-branch=main", local]);
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
    execFileSync("git", ["-C", local, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", local, "config", "user.email", "test@example.test"]);
    writeFileSync(join(local, "README.md"), "initial\n");
    execFileSync("git", ["-C", local, "add", "README.md"]);
    execFileSync("git", ["-C", local, "commit", "-m", "initial"]);
    execFileSync("git", ["-C", local, "remote", "add", "origin", remote]);
    execFileSync("git", ["-C", local, "push", "origin", "main"]);
    execFileSync("git", ["-C", local, "switch", "-c", "summing/client/topic"]);

    const inspector = new GitInspector(local);
    const unpublished = await inspector.repositoryStatus();
    assert.equal(unpublished.state, "unpublished");
    assert.equal(unpublished.published, false);
    assert.equal(unpublished.pullSource, "origin/main");
    assert.equal(unpublished.canPush, true);

    writeFileSync(join(local, "README.md"), "local\n");
    execFileSync("git", ["-C", local, "add", "README.md"]);
    execFileSync("git", ["-C", local, "commit", "-m", "local change"]);
    writeFileSync(join(local, "DRAFT.md"), "not committed\n");
    const hookMarker = join(fixture, "hook-ran");
    const hook = join(local, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(hookMarker)}\n`);
    chmodSync(hook, 0o700);
    const ahead = await inspector.repositoryStatus();
    assert.equal(ahead.ahead, 1);
    assert.equal(ahead.dirty, true);
    const pushed = await inspector.pushCurrentBranch(ahead.head);
    assert.equal(pushed.state, "synchronized");
    assert.equal(pushed.published, true);
    assert.equal(
      gitOutput(remote, "rev-parse", "refs/heads/summing/client/topic"),
      ahead.head,
    );
    assert.throws(() => gitOutput(remote, "show", "refs/heads/summing/client/topic:DRAFT.md"));
    assert.equal(existsSync(hookMarker), false);
    rmSync(join(local, "DRAFT.md"));

    execFileSync("git", ["clone", remote, updater]);
    execFileSync("git", ["-C", updater, "config", "user.name", "Remote"]);
    execFileSync("git", ["-C", updater, "config", "user.email", "remote@example.test"]);
    execFileSync("git", [
      "-C",
      updater,
      "switch",
      "--track",
      "origin/summing/client/topic",
    ]);
    writeFileSync(join(updater, "REMOTE.md"), "remote\n");
    execFileSync("git", ["-C", updater, "add", "REMOTE.md"]);
    execFileSync("git", ["-C", updater, "commit", "-m", "remote change"]);
    execFileSync("git", ["-C", updater, "push", "origin", "HEAD"]);

    const behind = await inspector.repositoryStatus();
    assert.equal(behind.state, "behind");
    assert.equal(behind.behind, 1);
    assert.equal(behind.canPull, true);
    assert.equal(behind.canPush, false);
    const pulled = await inspector.pullCurrentBranch(behind.head);
    assert.equal(pulled.state, "synchronized");
    assert.equal(gitOutput(local, "show", "HEAD:REMOTE.md"), "remote");

    writeFileSync(join(local, "README.md"), "not committed\n");
    writeFileSync(join(updater, "SECOND.md"), "second\n");
    execFileSync("git", ["-C", updater, "add", "SECOND.md"]);
    execFileSync("git", ["-C", updater, "commit", "-m", "second remote change"]);
    execFileSync("git", ["-C", updater, "push", "origin", "HEAD"]);
    const dirty = await inspector.repositoryStatus();
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.canPull, false);
    await assert.rejects(
      inspector.pullCurrentBranch(dirty.head),
      /перед Pull закоммитьте/,
    );
    await assert.rejects(
      inspector.pushCurrentBranch("0".repeat(40)),
      /репозиторий изменился после отображения/,
    );
    execFileSync("git", ["-C", local, "restore", "README.md"]);
    writeFileSync(join(local, "LOCAL-ONLY.md"), "local only\n");
    execFileSync("git", ["-C", local, "add", "LOCAL-ONLY.md"]);
    execFileSync("git", ["-C", local, "commit", "-m", "diverging local change"]);
    const diverged = await inspector.repositoryStatus();
    assert.equal(diverged.state, "diverged");
    assert.equal(diverged.canPush, false);
    assert.equal(diverged.canPull, false);
    await assert.rejects(
      inspector.pushCurrentBranch(diverged.head),
      /в origin есть отсутствующие локально коммиты/,
    );
    execFileSync("git", ["-C", local, "config", "core.sshCommand", "malicious-command"]);
    const unsafe = await inspector.repositoryStatus(false);
    assert.equal(unsafe.state, "error");
    assert.match(unsafe.message, /небезопасная project-local Git настройка core\.sshcommand/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("verifies read and write without creating refs, migrates legacy SSH, and safely changes origin", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "summing-inspector-access-"));
  const local = join(fixture, "local");
  const firstRemote = join(local, ".git", "first.git");
  const secondRemote = join(local, ".git", "second.git");
  try {
    execFileSync("git", ["init", "--initial-branch=main", local]);
    execFileSync("git", ["init", "--bare", "--initial-branch=main", firstRemote]);
    execFileSync("git", ["init", "--bare", "--initial-branch=main", secondRemote]);
    execFileSync("git", ["-C", local, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", local, "config", "user.email", "test@example.test"]);
    writeFileSync(join(local, "README.md"), "initial\n");
    execFileSync("git", ["-C", local, "add", "README.md"]);
    execFileSync("git", ["-C", local, "commit", "-m", "initial"]);
    execFileSync("git", ["-C", local, "remote", "add", "origin", firstRemote]);

    const credential = {
      identityFile: join(fixture, "managed-key"),
      knownHostsFile: join(fixture, "known-hosts"),
    };
    const inspector = new GitInspector(local, credential);
    const verification = await inspector.verifyRepositoryAccess();
    assert.equal(verification.read, true);
    assert.equal(verification.write, true);
    assert.equal(verification.emptyRemote, true);
    assert.equal(verification.code, "ok");
    assert.equal(gitOutput(firstRemote, "for-each-ref", "--format=%(refname)"), "");

    execFileSync("git", ["-C", local, "config", "core.sshCommand", "legacy-key-command"]);
    const managedStatus = await inspector.repositoryStatus(false);
    assert.notEqual(managedStatus.state, "error");
    assert.equal(managedStatus.legacySshCommand, true);
    assert.equal(managedStatus.errorCode, "legacy-ssh-command");
    assert.equal(await inspector.removeLegacySshCommand(), true);
    assert.equal(await inspector.legacySshCommandPresent(), false);

    const next = await inspector.verifyRepositoryAccess(secondRemote);
    assert.equal(next.read, true);
    assert.equal(next.write, true);
    const changed = await inspector.changeOrigin(firstRemote, secondRemote);
    assert.equal(changed.remote, secondRemote);
    const restored = await inspector.changeOrigin(secondRemote, firstRemote);
    assert.equal(restored.remote, firstRemote);
    assert.equal(gitOutput(secondRemote, "for-each-ref", "--format=%(refname)"), "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
