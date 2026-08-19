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
  const replacementRemote = join(workspace, ".git", "replacement.git");
  const updater = join(root, "updater");
  initializeRepository(workspace);
  git(workspace, "branch", "-m", "master");
  execFileSync("git", ["init", "--bare", "--initial-branch=master", remote]);
  execFileSync("git", ["init", "--bare", "--initial-branch=master", replacementRemote]);
  git(workspace, "remote", "add", "origin", remote);
  git(workspace, "push", "origin", "master");
  git(workspace, "switch", "-c", "summing/client/topic");
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
    primaryOwnerId: 42,
    ownerIds: [42, 77],
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
  const repositoryPost = (action: string, extra: Record<string, unknown> = {}) => fetch(
    `${endpoint}/api/viewer/repository`,
    {
      method: "POST",
      headers: { ...auth(42), "content-type": "application/json" },
      body: JSON.stringify({ conversation: conversation.id, action, ...extra }),
    },
  );
  try {
    await viewer.start();

    const statusResponse = await fetch(
      `${endpoint}/api/viewer/repository?conversation=${conversation.id}`,
      { headers: auth(42) },
    );
    assert.equal(statusResponse.status, 200);
    const coOwnerStatus = await fetch(
      `${endpoint}/api/viewer/repository?conversation=${conversation.id}`,
      { headers: auth(77) },
    );
    assert.equal(coOwnerStatus.status, 200);
    const statusPayload = await statusResponse.json() as {
      repository: {
        head: string;
        ahead: number;
        canPush: boolean;
        masterHead: string;
        masterAhead: number;
        canPushMaster: boolean;
      };
    };
    assert.equal(statusPayload.repository.ahead, 1);
    assert.equal(statusPayload.repository.canPush, true);
    assert.equal(statusPayload.repository.masterAhead, 1);
    assert.equal(statusPayload.repository.canPushMaster, true);

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
        action: "push-master",
        expectedHead: statusPayload.repository.head,
        expectedMasterHead: statusPayload.repository.masterHead,
        confirmed: true,
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
    assert.equal(
      git(remote, "rev-parse", "refs/heads/summing/client/topic"),
      git(workspace, "rev-parse", "HEAD"),
    );
    assert.notEqual(
      git(remote, "rev-parse", "refs/heads/master"),
      git(workspace, "rev-parse", "HEAD"),
    );

    const unconfirmedMaster = await fetch(`${endpoint}/api/viewer/repository`, {
      method: "POST",
      headers: { ...auth(42), "content-type": "application/json" },
      body: JSON.stringify({
        conversation: conversation.id,
        action: "push-master",
        expectedHead: statusPayload.repository.head,
        expectedMasterHead: statusPayload.repository.masterHead,
      }),
    });
    assert.equal(unconfirmedMaster.status, 400);
    const ownerMaster = await fetch(`${endpoint}/api/viewer/repository`, {
      method: "POST",
      headers: { ...auth(42), "content-type": "application/json" },
      body: JSON.stringify({
        conversation: conversation.id,
        action: "push-master",
        expectedHead: statusPayload.repository.head,
        expectedMasterHead: statusPayload.repository.masterHead,
        confirmed: true,
      }),
    });
    assert.equal(ownerMaster.status, 200);
    assert.equal(
      git(remote, "rev-parse", "refs/heads/master"),
      git(workspace, "rev-parse", "HEAD"),
    );

    writeFileSync(join(workspace, "ADMIN.md"), "administrator publication\n");
    git(workspace, "add", "ADMIN.md");
    git(workspace, "commit", "-m", "administrator publication");
    const administratorMasterStatus = await fetch(
      `${endpoint}/api/viewer/repository?conversation=${conversation.id}`,
      { headers: auth(1) },
    );
    const administratorMasterPayload = await administratorMasterStatus.json() as {
      repository: {
        head: string;
        masterHead: string;
        canPush: boolean;
        canPushMaster: boolean;
      };
    };
    assert.equal(administratorMasterPayload.repository.canPushMaster, true);
    const administratorMaster = await fetch(`${endpoint}/api/viewer/repository`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        conversation: conversation.id,
        action: "push-master",
        expectedHead: administratorMasterPayload.repository.head,
        expectedMasterHead: administratorMasterPayload.repository.masterHead,
        confirmed: true,
      }),
    });
    assert.equal(administratorMaster.status, 200);
    assert.equal(
      git(remote, "rev-parse", "refs/heads/master"),
      administratorMasterPayload.repository.head,
    );
    const synchronizedFeature = await repositoryPost("push", {
      expectedHead: administratorMasterPayload.repository.head,
    });
    assert.equal(synchronizedFeature.status, 200);

    execFileSync("git", ["clone", "--branch", "summing/client/topic", remote, updater]);
    git(updater, "config", "user.name", "Remote");
    git(updater, "config", "user.email", "remote@example.test");
    writeFileSync(join(updater, "REMOTE.md"), "remote\n");
    git(updater, "add", "REMOTE.md");
    git(updater, "commit", "-m", "remote change");
    git(updater, "push", "origin", "HEAD");

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

    const verified = await repositoryPost("verify");
    assert.equal(verified.status, 200);
    const verifiedBody = await verified.json() as {
      experience: {
        verification: { read: boolean; write: boolean; checkedAt: string; code: string };
        audit: Array<{ action: string }>;
      };
    };
    assert.equal(verifiedBody.experience.verification.read, true);
    assert.equal(verifiedBody.experience.verification.write, true);
    assert.equal(verifiedBody.experience.verification.code, "ok");
    assert.match(verifiedBody.experience.verification.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/summing/access-check-"),
      "",
    );

    const preview = await repositoryPost("preview-origin", { remoteUrl: replacementRemote });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json() as { preview: { read: boolean; write: boolean } };
    assert.equal(previewBody.preview.read, true);
    assert.equal(previewBody.preview.write, true);
    const changed = await repositoryPost("change-origin", {
      remoteUrl: replacementRemote,
      expectedRemote: remote,
      confirmed: true,
    });
    assert.equal(changed.status, 200);
    const changedBody = await changed.json() as {
      repository: { remote: string };
      experience: { previousRemote: { previous: string; replacement: string } };
    };
    assert.equal(changedBody.repository.remote, replacementRemote);
    assert.equal(changedBody.experience.previousRemote.previous, remote);
    assert.equal(git(workspace, "remote", "get-url", "origin"), replacementRemote);
    const rolledBack = await repositoryPost("rollback-origin");
    assert.equal(rolledBack.status, 200);
    assert.equal(git(workspace, "remote", "get-url", "origin"), remote);

    const activeCredential = await viewer.repositoryCredentials.ensure("client", "repo");
    git(workspace, "config", "core.sshCommand", "ssh -i /old/key");
    const legacyStatus = await fetch(
      `${endpoint}/api/viewer/repository?conversation=${conversation.id}`,
      { headers: auth(42) },
    );
    const legacyBody = await legacyStatus.json() as {
      repository: { state: string; legacySshCommand: boolean };
    };
    assert.notEqual(legacyBody.repository.state, "error");
    assert.equal(legacyBody.repository.legacySshCommand, true);
    const migrated = await repositoryPost("migrate-legacy");
    assert.equal(migrated.status, 200);
    assert.throws(() => git(workspace, "config", "--get", "core.sshCommand"));

    const prepared = await repositoryPost("prepare-rotation");
    assert.equal(prepared.status, 200);
    const preparedBody = await prepared.json() as {
      connection: { rotation: { fingerprint: string; publicKey: string } };
    };
    assert.match(preparedBody.connection.rotation.publicKey, /^ssh-ed25519 /);
    assert.notEqual(preparedBody.connection.rotation.fingerprint, activeCredential.fingerprint);
    const rotationVerified = await repositoryPost("verify-rotation");
    assert.equal(rotationVerified.status, 200);
    const rotationVerifiedBody = await rotationVerified.json() as {
      experience: { rotationVerification: { read: boolean; write: boolean } };
    };
    assert.equal(rotationVerifiedBody.experience.rotationVerification.read, true);
    assert.equal(rotationVerifiedBody.experience.rotationVerification.write, true);
    const activated = await repositoryPost("activate-rotation");
    assert.equal(activated.status, 200);
    const activatedBody = await activated.json() as {
      connection: { fingerprint: string; rotation: null };
      experience: { audit: Array<{ action: string; actor: number; head: string }> };
    };
    assert.equal(activatedBody.connection.fingerprint, preparedBody.connection.rotation.fingerprint);
    assert.equal(activatedBody.connection.rotation, null);
    assert.ok(activatedBody.experience.audit.some((entry) => entry.action === "change-origin"));
    assert.ok(activatedBody.experience.audit.some((entry) => entry.action === "migrate-legacy"));
    assert.equal(activatedBody.experience.audit[0]?.actor, 42);
    assert.match(activatedBody.experience.audit[0]?.head ?? "", /^[0-9a-f]{40}$/);
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
  assert.match(VIEWER_HTML, /id="repositoryReadAccess"/);
  assert.match(VIEWER_HTML, /id="repositoryWriteAccess"/);
  assert.match(VIEWER_HTML, /id="repositoryNewUrl"/);
  assert.match(VIEWER_HTML, /id="rollbackOrigin"/);
  assert.match(VIEWER_HTML, /id="migrateLegacy"/);
  assert.match(VIEWER_HTML, /id="prepareRotation"/);
  assert.match(VIEWER_HTML, /id="repositoryAudit"/);
  assert.match(VIEWER_HTML, /id="pullRepository"/);
  assert.match(VIEWER_HTML, /id="pushRepository"/);
  assert.match(VIEWER_HTML, /id="pushMasterRepository"/);
  assert.match(VIEWER_HTML, /id="repositoryMasterHead"/);
  assert.match(VIEWER_HTML, /id="repositoryMasterAhead"/);
  assert.match(VIEWER_JS, /postRepository\("connect"/);
  assert.match(VIEWER_JS, /copyFrom\("repositoryPublicKey"/);
  assert.match(VIEWER_JS, /postRepository\("verify"\)/);
  assert.match(VIEWER_JS, /postRepository\("preview-origin"/);
  assert.match(VIEWER_JS, /rotationAction\("activate-rotation"\)/);
  assert.match(VIEWER_JS, /syncRepository\("pull"\)/);
  assert.match(VIEWER_JS, /syncRepository\("push"\)/);
  assert.match(VIEWER_JS, /postRepository\("push-master"/);
  assert.match(VIEWER_JS, /expectedMasterHead:repository\.masterHead/);
});

test("active owner turns use the managed host repository control plane", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-agent-repository-"));
  const workspace = join(root, "workspace");
  const remote = join(workspace, ".git", "origin.git");
  const updater = join(root, "updater");
  initializeRepository(workspace);
  git(workspace, "branch", "-m", "master");
  execFileSync("git", ["init", "--bare", "--initial-branch=master", remote]);
  git(workspace, "remote", "add", "origin", remote);
  git(workspace, "push", "origin", "master");

  const dataDir = join(root, "data");
  const state = new StateStore(join(dataDir, "state.sqlite3"));
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
  );
  state.createManagedProject({
    id: "client",
    name: "Client",
    primaryOwnerId: 42,
    ownerIds: [42],
    defaultWorkspaceId: "repo",
    workspaces: [{ id: "repo", path: workspace }],
    createdAt: Date.now() / 1_000,
  });
  const projects = new ProjectCatalog(config, state);
  const conversation = state.bind(42, 1, "client", "repo");
  const viewer = new ProjectViewerServer(config, state, projects);
  const turnId = "turn-agent-repository";
  const context = {
    projectId: "client",
    workspaceId: "repo",
    repositoryPath: workspace,
    conversationId: conversation.id,
    actorUserId: 42,
    turnId,
  };
  try {
    await viewer.repositoryCredentials.ensure("client", "repo");
    state.setActive(conversation.id, turnId, null);

    const initial = await viewer.repositoryTool(context, "inspect") as {
      repository: { head: string; state: string };
      managedCredential: boolean;
      access: unknown;
    };
    assert.equal(initial.repository.state, "synchronized");
    assert.equal(initial.managedCredential, true);
    assert.equal(initial.access, null);

    const verified = await viewer.repositoryTool(context, "verify_access") as {
      access: { read: boolean; write: boolean };
    };
    assert.equal(verified.access.read, true);
    assert.equal(verified.access.write, true);
    assert.doesNotMatch(
      JSON.stringify(verified),
      /identityFile|knownHostsFile|repository-credentials|BEGIN OPENSSH PRIVATE KEY/,
    );

    execFileSync("git", ["clone", "--branch", "master", remote, updater]);
    git(updater, "config", "user.name", "Remote");
    git(updater, "config", "user.email", "remote@example.test");
    writeFileSync(join(updater, "REMOTE.md"), "remote\n");
    git(updater, "add", "REMOTE.md");
    git(updater, "commit", "-m", "remote change");
    git(updater, "push", "origin", "master");

    const behind = await viewer.repositoryTool(context, "inspect") as {
      repository: { head: string; behind: number; canPull: boolean };
    };
    assert.equal(behind.repository.behind, 1);
    assert.equal(behind.repository.canPull, true);
    await viewer.repositoryTool(context, "pull", behind.repository.head);
    assert.equal(git(workspace, "show", "HEAD:REMOTE.md"), "remote");

    writeFileSync(join(workspace, "LOCAL.md"), "local\n");
    git(workspace, "add", "LOCAL.md");
    git(workspace, "commit", "-m", "local change");
    const ahead = await viewer.repositoryTool(context, "inspect") as {
      repository: { head: string; ahead: number; canPush: boolean };
    };
    assert.equal(ahead.repository.ahead, 1);
    assert.equal(ahead.repository.canPush, true);
    await viewer.repositoryTool(context, "push", ahead.repository.head);
    assert.equal(git(remote, "rev-parse", "refs/heads/master"), git(workspace, "rev-parse", "HEAD"));

    await assert.rejects(
      viewer.repositoryTool({ ...context, actorUserId: 99 }, "inspect"),
      /active authorized owner turn/,
    );
    await assert.rejects(
      viewer.repositoryTool({ ...context, turnId: "another-turn" }, "inspect"),
      /active authorized owner turn/,
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
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
    primaryOwnerId: 42,
    ownerIds: [42],
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
