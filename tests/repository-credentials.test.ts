import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  RepositoryCredentialError,
  RepositoryCredentialStore,
} from "../src/repository-credentials.js";

test("creates one stable private Ed25519 deploy key outside the repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-repository-credentials-"));
  try {
    const dataDir = join(root, "data");
    const repository = join(dataDir, "repositories", "client", "repo");
    mkdirSync(repository, { recursive: true });
    const store = new RepositoryCredentialStore(dataDir);
    const first = await store.ensure("client", "repo");
    const second = await store.ensure("client", "repo");

    assert.equal(second.publicKey, first.publicKey);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.match(first.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=* summing:client\/repo$/);
    assert.match(first.fingerprint, /^SHA256:/);
    assert.equal(first.identityFile.startsWith(repository), false);
    assert.equal(first.identityFile, join(dataDir, "repository-credentials", "client", "repo", "id_ed25519"));
    assert.equal(statSync(first.identityFile).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(first.identityFile)).mode & 0o777, 0o700);
    assert.equal(statSync(first.knownHostsFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(first.knownHostsFile, "utf8"), "");
    assert.doesNotMatch(readFileSync(first.identityFile, "utf8"), /summing:client\/repo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses invalid identifiers and symlinked credential directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-repository-credential-safety-"));
  try {
    const dataDir = join(root, "data");
    const credentials = join(dataDir, "repository-credentials");
    const project = join(credentials, "client");
    const outside = join(root, "outside");
    mkdirSync(project, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(project, "repo"), "dir");
    const store = new RepositoryCredentialStore(dataDir);

    await assert.rejects(store.ensure("../client", "repo"), RepositoryCredentialError);
    await assert.rejects(store.ensure("client", "repo"), /unsafe credential directory/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rotates deploy keys in two phases and persists bounded verification and audit state", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-repository-rotation-"));
  try {
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const store = new RepositoryCredentialStore(dataDir);
    const active = await store.ensure("client", "repo");
    const candidate = await store.prepareRotation("client", "repo");
    assert.notEqual(candidate.fingerprint, active.fingerprint);
    assert.equal((await store.prepareRotation("client", "repo")).fingerprint, candidate.fingerprint);

    await store.setVerification("client", "repo", {
      remote: "git@example.test:owner/repo.git",
      head: "a".repeat(40),
      read: true,
      write: true,
      emptyRemote: false,
      checkedAt: "2026-08-14T12:00:00.000Z",
      code: "ok",
      message: "ok",
      fingerprint: active.fingerprint,
    });
    for (let index = 0; index < 205; index += 1) {
      await store.appendAudit("client", "repo", {
        at: new Date(1_700_000_000_000 + index).toISOString(),
        actor: 42,
        action: "verify",
        outcome: "success",
        remote: "git@example.test:owner/repo.git",
        previousRemote: "",
        branch: "main",
        head: "a".repeat(40),
        code: "ok",
        message: `entry ${index}`,
      });
    }
    const state = await store.state("client", "repo");
    assert.equal(state.verification?.fingerprint, active.fingerprint);
    assert.equal(state.audit.length, 200);
    assert.equal(state.audit[0]?.message, "entry 5");
    const statePath = join(dataDir, "repository-credentials", "client", "repo", "state.json");
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(statePath, "utf8"), /BEGIN OPENSSH PRIVATE KEY/);

    const activated = await store.activateRotation("client", "repo");
    assert.equal(activated.fingerprint, candidate.fingerprint);
    assert.equal(await store.inspectRotation("client", "repo"), null);
    const cancelled = await store.prepareRotation("client", "repo");
    assert.notEqual(cancelled.fingerprint, activated.fingerprint);
    await store.cancelRotation("client", "repo");
    assert.equal(await store.inspectRotation("client", "repo"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
