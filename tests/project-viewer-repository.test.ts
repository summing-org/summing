import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeConfig } from "../src/config.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { ProjectViewerServer } from "../src/project-viewer.js";
import { StateStore } from "../src/state-store.js";
import { VIEWER_HTML, VIEWER_JS } from "../src/viewer-assets.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initializeRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "--initial-branch=main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.test");
  writeFileSync(join(path, "README.md"), "initial\n");
  git(path, "add", "README.md");
  git(path, "commit", "-m", "initial");
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function signedInitData(token: string, userId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1_000)),
    query_id: `query-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "Viewer" }),
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

test("repository tab gives the project owner and administrator safe push and pull", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-viewer-repository-"));
  const workspace = join(root, "workspace");
  const remote = join(workspace, ".git", "origin.git");
  const updater = join(root, "updater");
  initializeRepository(workspace);
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
  git(workspace, "remote", "add", "origin", remote);
  git(workspace, "push", "origin", "main");
  writeFileSync(join(workspace, "LOCAL.md"), "local\n");
  git(workspace, "add", "LOCAL.md");
  git(workspace, "commit", "-m", "local change");

  const dataDir = join(root, "data");
  const state = new StateStore(join(dataDir, "state.sqlite3"));
  const port = await freePort();
  const config = new RuntimeConfig(
    dataDir,
    join(root, "codex"),
    join(root, "worktrees"),
    "bot-token",
    1,
    "codex",
    8_765,
    2,
    1,
    "",
    "medium",
    true,
    new Map(),
    20,
    12,
    60,
    "openai",
    "gpt-transcribe",
    "",
    "",
    20_000_000,
    port,
    "",
    300,
  );
  state.createManagedProject({
    id: "client",
    name: "Client",
    ownerId: 42,
    defaultWorkspaceId: "repo",
    workspaces: [{ id: "repo", path: workspace }],
    createdAt: Date.now() / 1_000,
  });
  const projects = new ProjectCatalog(config, state);
  const conversation = state.bind(42, 1, "client", "repo");
  const viewer = new ProjectViewerServer(config, state, projects);
  const endpoint = `http://127.0.0.1:${port}`;
  const auth = (userId: number): Record<string, string> => ({
    "x-telegram-init-data": signedInitData("bot-token", userId),
  });
  try {
    await viewer.start();

    const statusResponse = await fetch(
      `${endpoint}/api/viewer/repository?conversation=${conversation.id}`,
      { headers: auth(42) },
    );
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json() as {
      repository: { head: string; ahead: number; canPush: boolean };
    };
    assert.equal(statusPayload.repository.ahead, 1);
    assert.equal(statusPayload.repository.canPush, true);

    const administratorStatus = await fetch(
      `${endpoint}/api/viewer/repository?conversation=${conversation.id}`,
      { headers: auth(1) },
    );
    assert.equal(administratorStatus.status, 200);
    const denied = await fetch(
      `${endpoint}/api/viewer/repository?conversation=${conversation.id}`,
      { headers: auth(99) },
    );
    assert.equal(denied.status, 403);

    state.setActive(conversation.id, "active-turn", null);
    const busy = await fetch(`${endpoint}/api/viewer/repository`, {
      method: "POST",
      headers: { ...auth(42), "content-type": "application/json" },
      body: JSON.stringify({
        conversation: conversation.id,
        action: "push",
        expectedHead: statusPayload.repository.head,
      }),
    });
    assert.equal(busy.status, 409);
    state.clearActive(conversation.id);

    const pushed = await fetch(`${endpoint}/api/viewer/repository`, {
      method: "POST",
      headers: { ...auth(42), "content-type": "application/json" },
      body: JSON.stringify({
        conversation: conversation.id,
        action: "push",
        expectedHead: statusPayload.repository.head,
      }),
    });
    assert.equal(pushed.status, 200);
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), git(workspace, "rev-parse", "HEAD"));

    execFileSync("git", ["clone", "--branch", "main", remote, updater]);
    git(updater, "config", "user.name", "Remote");
    git(updater, "config", "user.email", "remote@example.test");
    writeFileSync(join(updater, "REMOTE.md"), "remote\n");
    git(updater, "add", "REMOTE.md");
    git(updater, "commit", "-m", "remote change");
    git(updater, "push", "origin", "main");

    const behindResponse = await fetch(
      `${endpoint}/api/viewer/repository?conversation=${conversation.id}`,
      { headers: auth(1) },
    );
    const behindPayload = await behindResponse.json() as {
      repository: { head: string; behind: number; canPull: boolean };
    };
    assert.equal(behindPayload.repository.behind, 1);
    assert.equal(behindPayload.repository.canPull, true);
    const pulled = await fetch(`${endpoint}/api/viewer/repository`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        conversation: conversation.id,
        action: "pull",
        expectedHead: behindPayload.repository.head,
      }),
    });
    assert.equal(pulled.status, 200);
    assert.equal(git(workspace, "show", "HEAD:REMOTE.md"), "remote");
  } finally {
    await viewer.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository controls are present in the Mini App", () => {
  assert.match(VIEWER_HTML, /data-tab="repository">Репозиторий/);
  assert.match(VIEWER_HTML, /id="repositoryUrl"/);
  assert.match(VIEWER_HTML, /id="repositoryPublicKey"/);
  assert.match(VIEWER_HTML, /id="verifyRepository"/);
  assert.match(VIEWER_HTML, /id="pullRepository"/);
  assert.match(VIEWER_HTML, /id="pushRepository"/);
  assert.match(VIEWER_JS, /action:"connect"/);
  assert.match(VIEWER_JS, /copyRepositoryKey/);
  assert.match(VIEWER_JS, /syncRepository\("pull"\)/);
  assert.match(VIEWER_JS, /syncRepository\("push"\)/);
});

test("repository onboarding configures a missing origin and returns only its public deploy key", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-viewer-repository-onboarding-"));
  const workspace = join(root, "workspace");
  initializeRepository(workspace);
  const dataDir = join(root, "data");
  const state = new StateStore(join(dataDir, "state.sqlite3"));
  const port = await freePort();
  const config = new RuntimeConfig(
    dataDir,
    join(root, "codex"),
    join(root, "worktrees"),
    "bot-token",
    1,
    "codex",
    8_765,
    2,
    1,
    "",
    "medium",
    true,
    new Map(),
    20,
    12,
    60,
    "openai",
    "gpt-transcribe",
    "",
    "",
    20_000_000,
    port,
    "",
    300,
  );
  state.createManagedProject({
    id: "client",
    name: "Client",
    ownerId: 42,
    defaultWorkspaceId: "repo",
    workspaces: [{ id: "repo", path: workspace }],
    createdAt: Date.now() / 1_000,
  });
  const projects = new ProjectCatalog(config, state);
  const conversation = state.bind(42, 1, "client", "repo");
  const viewer = new ProjectViewerServer(config, state, projects);
  const endpoint = `http://127.0.0.1:${port}`;
  const auth = (userId: number): Record<string, string> => ({
    "x-telegram-init-data": signedInitData("bot-token", userId),
  });
  const request = (userId: number, remoteUrl: string) => fetch(`${endpoint}/api/viewer/repository`, {
    method: "POST",
    headers: { ...auth(userId), "content-type": "application/json" },
    body: JSON.stringify({
      conversation: conversation.id,
      action: "connect",
      remoteUrl,
    }),
  });
  try {
    await viewer.start();

    const initial = await fetch(
      `${endpoint}/api/viewer/repository?conversation=${conversation.id}`,
      { headers: auth(42) },
    );
    assert.equal(initial.status, 200);
    const initialBody = await initial.json() as {
      repository: { remote: string };
      connection: { mode: string; canCreateDeployKey: boolean };
    };
    assert.equal(initialBody.repository.remote, "");
    assert.equal(initialBody.connection.mode, "none");
    assert.equal(initialBody.connection.canCreateDeployKey, true);

    const denied = await request(99, "git@example.test:owner/project.git");
    assert.equal(denied.status, 403);
    assert.equal(git(workspace, "remote"), "");

    state.setActive(conversation.id, "active-turn", null);
    const busy = await request(42, "git@example.test:owner/project.git");
    assert.equal(busy.status, 409);
    state.clearActive(conversation.id);

    const identity = join(
      dataDir,
      "repository-credentials",
      "client",
      "repo",
      "id_ed25519",
    );
    const invalid = await request(42, "https://example.test/owner/project.git");
    assert.equal(invalid.status, 409);
    assert.equal(existsSync(identity), false);
    assert.equal(git(workspace, "remote"), "");

    const connected = await request(42, "git@example.test:owner/project.git");
    assert.equal(connected.status, 200);
    const body = await connected.json() as {
      repository: { remote: string; state: string; canPush: boolean; message: string };
      connection: {
        mode: string;
        publicKey: string;
        fingerprint: string;
        hostKeyPolicy: string;
      };
    };
    assert.equal(body.repository.remote, "git@example.test:owner/project.git");
    assert.equal(body.repository.state, "unpublished");
    assert.equal(body.repository.canPush, false);
    assert.match(body.repository.message, /Добавьте публичный ключ/);
    assert.equal(body.connection.mode, "managed-ssh");
    assert.match(body.connection.publicKey, /^ssh-ed25519 /);
    assert.match(body.connection.fingerprint, /^SHA256:/);
    assert.equal(body.connection.hostKeyPolicy, "trust-on-first-use");
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /BEGIN OPENSSH PRIVATE KEY/);
    assert.doesNotMatch(serialized, /identityFile|knownHostsFile|repository-credentials/);

    assert.equal(existsSync(identity), true);
    assert.equal(statSync(identity).mode & 0o777, 0o600);
    assert.equal(git(workspace, "remote", "get-url", "origin"), "git@example.test:owner/project.git");

    const replacement = await request(42, "git@example.test:owner/other.git");
    assert.equal(replacement.status, 409);
    assert.equal(git(workspace, "remote", "get-url", "origin"), "git@example.test:owner/project.git");
  } finally {
    await viewer.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
