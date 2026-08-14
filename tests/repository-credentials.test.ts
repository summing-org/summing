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
