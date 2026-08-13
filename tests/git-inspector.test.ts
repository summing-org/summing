import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates immutable snapshots without changing the worktree index", async () => {
  const root = repository();
  try {
    const inspector = new GitInspector(root);
    const before = await inspector.snapshot("before");
    writeFileSync(join(root, "src", "main.ts"), "export const value = 3;\n");
    const after = await inspector.snapshot("after");
    assert.match(await inspector.commitDiff(before, after), /value = 3/);
    assert.equal(execFileSync("git", ["-C", root, "diff", "--cached"]).toString(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
