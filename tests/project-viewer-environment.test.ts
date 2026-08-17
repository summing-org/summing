import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { ProjectRunnerClientError } from "../src/project-runner-client.js";
import { ProjectViewerServer } from "../src/project-viewer.js";
import { StateStore } from "../src/state-store.js";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function repository(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "fixture\n");
  git(path, "init", "--initial-branch=main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.com");
  git(path, "add", "README.md");
  git(path, "commit", "-m", "fixture");
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
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

test("viewer edits one environment while job launch stays agent-only and cancellation remains available", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-viewer-environment-"));
  const workspace = join(root, "workspace");
  repository(workspace);
  const port = await freePort();
  const configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    `[viewer]\nport = ${port}\n\n[projects.demo]\nname = "Demo"\ndefault_workspace = "repo"\n\n[projects.demo.workspaces.repo]\npath = "${workspace}"\n`,
  );
  const config = loadConfig({
    SUMMING_DATA_DIR: join(root, "data"),
    SUMMING_CONFIG: configPath,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_OWNER_ID: "42",
    SUMMING_RUNNER_SOCKET: join(root, "runner.sock"),
  });
  const state = new StateStore(join(config.dataDir, "state.sqlite3"));
  const projects = new ProjectCatalog(config, state);
  const conversation = state.bind(42, 1, "demo", "repo");
  const viewer = new ProjectViewerServer(config, state, projects);
  let document = {
    text: "API_TOKEN=secret-value-123456\n",
    revision: 3,
    updatedAt: "2026-08-14T00:00:00.000Z" as string | null,
  };
  let submission: unknown[] = [];
  let cancellation: unknown[] = [];
  Object.assign(viewer.runner, {
    available: async () => true,
    environment: async (projectId: string, workspaceId: string) => {
      assert.equal(projectId, "demo");
      assert.equal(workspaceId, "repo");
      return document;
    },
    saveEnvironment: async (
      projectId: string,
      workspaceId: string,
      text: string,
      expectedRevision: number,
    ) => {
      assert.deepEqual([projectId, workspaceId, expectedRevision], ["demo", "repo", 3]);
      document = { text, revision: 4, updatedAt: "2026-08-14T01:00:00.000Z" };
      return document;
    },
    submit: async (...args: unknown[]) => {
      submission = args;
      return {
        id: "00000000-0000-4000-8000-000000000001",
        projectId: "demo",
        workspaceId: "repo",
        action: "dry-run",
        revision: "a".repeat(40),
        status: "queued",
        createdAt: "2026-08-14T00:00:00Z",
      };
    },
    cancel: async (...args: unknown[]) => {
      cancellation = args;
      return {
        id: "00000000-0000-4000-8000-000000000001",
        projectId: "demo",
        workspaceId: "repo",
        action: "dry-run",
        revision: "a".repeat(40),
        status: "cancelled",
        createdAt: "2026-08-14T00:00:00Z",
        completedAt: "2026-08-14T00:01:00Z",
      };
    },
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const headers = { "x-telegram-init-data": signedInitData("bot-token", 42) };

  try {
    await viewer.start();
    const loaded = await fetch(
      `${endpoint}/api/viewer/environment?conversation=${conversation.id}`,
      { headers },
    );
    assert.equal(loaded.status, 200);
    assert.deepEqual((await loaded.json() as { environment: unknown }).environment, document);

    const saved = await fetch(
      `${endpoint}/api/viewer/environment?conversation=${conversation.id}`,
      {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ text: "API_TOKEN=rotated-secret-654321\n", expectedRevision: 3 }),
      },
    );
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as { environment: { revision: number } }).environment.revision, 4);

    const launched = await fetch(`${endpoint}/api/viewer/jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ conversation: conversation.id, action: "dry-run" }),
    });
    assert.equal(launched.status, 404);
    assert.deepEqual(submission, []);

    const cancelled = await fetch(`${endpoint}/api/viewer/jobs/cancel`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        conversation: conversation.id,
        job: "00000000-0000-4000-8000-000000000001",
      }),
    });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancellation, [
      "demo",
      "repo",
      "00000000-0000-4000-8000-000000000001",
    ]);
  } finally {
    await viewer.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("viewer lets a managed project owner edit only that project's environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-viewer-environment-access-"));
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  repository(workspace);
  repository(otherWorkspace);
  const port = await freePort();
  const configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    `[viewer]\nport = ${port}\n\n[projects.system]\nname = "System"\ndefault_workspace = "repo"\n\n[projects.system.workspaces.repo]\npath = "${workspace}"\n`,
  );
  const config = loadConfig({
    SUMMING_DATA_DIR: join(root, "data"),
    SUMMING_CONFIG: configPath,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_OWNER_ID: "42",
  });
  const state = new StateStore(join(config.dataDir, "state.sqlite3"));
  state.createManagedProject({
    id: "demo",
    name: "Demo",
    primaryOwnerId: 99,
    ownerIds: [99],
    defaultWorkspaceId: "repo",
    workspaces: [{ id: "repo", path: workspace }],
    createdAt: Date.now() / 1_000,
  });
  state.createManagedProject({
    id: "other",
    name: "Other",
    primaryOwnerId: 100,
    ownerIds: [100],
    defaultWorkspaceId: "repo",
    workspaces: [{ id: "repo", path: otherWorkspace }],
    createdAt: Date.now() / 1_000,
  });
  const projects = new ProjectCatalog(config, state);
  projects.replaceOwners("demo", 99, [99, 102]);
  const conversation = state.bind(99, 1, "demo", "repo");
  const viewer = new ProjectViewerServer(config, state, projects);
  Object.assign(viewer.runner, {
    available: async () => true,
    environment: async () => ({ text: "TOKEN=hidden\n", revision: 1, updatedAt: null }),
    saveEnvironment: async () => {
      throw new ProjectRunnerClientError("environment changed; reload before saving", 409);
    },
  });
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    await viewer.start();
    const ownerHeaders = { "x-telegram-init-data": signedInitData("bot-token", 99) };
    const session = await fetch(
      `${endpoint}/api/viewer/session?conversation=${conversation.id}`,
      { headers: ownerHeaders },
    );
    assert.equal(session.status, 200);
    const sessionPayload = await session.json() as {
      administrator: boolean;
      environmentAccess: boolean;
    };
    assert.equal(sessionPayload.administrator, false);
    assert.equal(sessionPayload.environmentAccess, true);

    const allowed = await fetch(
      `${endpoint}/api/viewer/environment?conversation=${conversation.id}`,
      { headers: ownerHeaders },
    );
    assert.equal(allowed.status, 200);

    const coOwnerAllowed = await fetch(
      `${endpoint}/api/viewer/environment?conversation=${conversation.id}`,
      { headers: { "x-telegram-init-data": signedInitData("bot-token", 102) } },
    );
    assert.equal(coOwnerAllowed.status, 200);

    const otherOwnerForbidden = await fetch(
      `${endpoint}/api/viewer/environment?conversation=${conversation.id}`,
      { headers: { "x-telegram-init-data": signedInitData("bot-token", 100) } },
    );
    assert.equal(otherOwnerForbidden.status, 403);
    assert.doesNotMatch(await otherOwnerForbidden.text(), /TOKEN=hidden/);

    const participantForbidden = await fetch(
      `${endpoint}/api/viewer/environment?conversation=${conversation.id}`,
      { headers: { "x-telegram-init-data": signedInitData("bot-token", 101) } },
    );
    assert.equal(participantForbidden.status, 403);
    assert.doesNotMatch(await participantForbidden.text(), /TOKEN=hidden/);

    const conflict = await fetch(
      `${endpoint}/api/viewer/environment?conversation=${conversation.id}`,
      {
        method: "PUT",
        headers: {
          ...ownerHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "TOKEN=new\n", expectedRevision: 1 }),
      },
    );
    assert.equal(conflict.status, 409);
  } finally {
    await viewer.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
