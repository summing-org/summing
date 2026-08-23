import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const provisioner = join(repositoryRoot, "deploy", "provision-self-project-worktree");

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function identity(repository: string): void {
  git("-C", repository, "config", "user.name", "Test");
  git("-C", repository, "config", "user.email", "test@example.test");
}

test("self-project migration keeps branches while moving master to durable integration worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-self-project-"));
  try {
    const remote = join(root, "origin.git");
    const source = join(root, "source");
    const topic = join(root, "topic");
    const updater = join(root, "updater");
    const target = join(root, "data", "repositories", "summing", "repo");
    const config = join(root, "config.toml");
    mkdirSync(dirname(target), { recursive: true });
    git("init", "--bare", remote);
    git("init", "--initial-branch=master", source);
    identity(source);
    writeFileSync(join(source, "VERSION.txt"), "v1\n");
    git("-C", source, "add", "VERSION.txt");
    git("-C", source, "commit", "-m", "initial");
    git("-C", source, "remote", "add", "origin", remote);
    git("-C", source, "push", "-u", "origin", "master");

    git("-C", source, "worktree", "add", "-b", "summing/summing/topic", topic);
    writeFileSync(join(topic, "TOPIC.txt"), "persistent branch\n");
    git("-C", topic, "add", "TOPIC.txt");
    git("-C", topic, "commit", "-m", "topic work");
    const topicCommit = git("-C", topic, "rev-parse", "HEAD");

    git("clone", remote, updater);
    identity(updater);
    writeFileSync(join(updater, "VERSION.txt"), "v2\n");
    git("-C", updater, "add", "VERSION.txt");
    git("-C", updater, "commit", "-m", "remote update");
    git("-C", updater, "push", "origin", "master");
    const remoteCommit = git("-C", updater, "rev-parse", "HEAD");

    writeFileSync(config, [
      "[projects.summing]",
      'name = "SUMMING"',
      'default_workspace = "repo"',
      "self_change = true",
      "",
      "[projects.summing.workspaces.repo]",
      `path = "${source}"`,
      "",
    ].join("\n"));

    const environment = {
      ...process.env,
      SUMMING_SELF_PROJECT_SOURCE: source,
      SUMMING_SELF_PROJECT_WORKTREE: target,
      SUMMING_SELF_PROJECT_CONFIG: config,
      SUMMING_SELF_PROJECT_TEST_ROOT: root,
      SUMMING_SELF_PROJECT_USER: execFileSync("id", ["-un"], { encoding: "utf8" }).trim(),
    };
    const migrated = spawnSync("bash", [provisioner], { encoding: "utf8", env: environment });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.match(migrated.stdout, /Self-project integration worktree ready/);
    assert.notEqual(
      spawnSync("git", ["-C", source, "symbolic-ref", "--quiet", "--short", "HEAD"]).status,
      0,
      "the deployment source must be detached",
    );
    assert.equal(git("-C", target, "branch", "--show-current"), "master");
    assert.equal(git("-C", target, "rev-parse", "HEAD"), remoteCommit);
    assert.ok(readFileSync(config, "utf8").includes(`path = "${target}"`));
    assert.equal(
      realpathSync(git("-C", target, "rev-parse", "--path-format=absolute", "--git-common-dir")),
      realpathSync(git("-C", topic, "rev-parse", "--path-format=absolute", "--git-common-dir")),
    );
    assert.equal(git("-C", topic, "rev-parse", "HEAD"), topicCommit);

    writeFileSync(join(target, "LOCAL.txt"), "not pushed yet\n");
    git("-C", target, "add", "LOCAL.txt");
    git("-C", target, "commit", "-m", "local integration");
    const localCommit = git("-C", target, "rev-parse", "HEAD");
    const repeated = spawnSync("bash", [provisioner], { encoding: "utf8", env: environment });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /preserving local commits/);
    assert.equal(git("-C", target, "rev-parse", "HEAD"), localCommit);
    assert.equal(git("-C", topic, "rev-parse", "HEAD"), topicCommit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
