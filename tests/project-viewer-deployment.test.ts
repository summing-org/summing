import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import type { DeploymentControl, DeploymentStatus } from "../src/deployment-controller.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { ProjectViewerServer } from "../src/project-viewer.js";
import { StateStore } from "../src/state-store.js";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function repository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "--initial-branch=main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.com");
  writeFileSync(join(path, "README.md"), "fixture\n");
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

class FakeDeployment implements DeploymentControl {
  readonly available = true;
  requests = 0;

  async status(): Promise<DeploymentStatus> {
    return {
      available: true,
      status: "idle",
      message: "Already up to date",
      currentSha: "a".repeat(40),
      remoteSha: "a".repeat(40),
      requestedAt: null,
      startedAt: "2026-08-13T00:00:00Z",
      finishedAt: "2026-08-13T00:00:01Z",
    };
  }

  async requestUpdate(): Promise<{ requestedAt: string }> {
    this.requests += 1;
    return { requestedAt: "2026-08-13T00:01:00Z" };
  }
}

test("viewer exposes deployment controls only to the SUMMING administrator", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-viewer-deploy-"));
  const staticPath = join(root, "summing");
  const clientPath = join(root, "client");
  repository(staticPath);
  repository(clientPath);
  const dataDir = join(root, "data");
  const state = new StateStore(join(dataDir, "state.sqlite3"));
  const port = await freePort();
  const staticWorkspace: WorkspaceConfig = { id: "repo", path: staticPath };
  const staticProject = new ProjectConfig(
    "summing",
    "SUMMING",
    "repo",
    new Map([["repo", staticWorkspace]]),
    true,
  );
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
    new Map([["summing", staticProject]]),
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
    "",
    join(root, "runner.sock"),
    join(root, "deploy", "request.json"),
    join(root, "deploy", "state.json"),
  );
  state.createManagedProject({
    id: "client",
    name: "Client",
    ownerId: 42,
    defaultWorkspaceId: "repo",
    workspaces: [{ id: "repo", path: clientPath }],
    createdAt: Date.now() / 1_000,
  });
  const projects = new ProjectCatalog(config, state);
  const adminConversation = state.bind(1, 1, "summing", "repo");
  const ownerConversation = state.bind(42, 1, "client", "repo");
  const deployment = new FakeDeployment();
  const viewer = new ProjectViewerServer(config, state, projects, deployment);
  const endpoint = `http://127.0.0.1:${port}`;
  const auth = (userId: number): Record<string, string> => ({
    "x-telegram-init-data": signedInitData("bot-token", userId),
  });
  try {
    await viewer.start();

    const adminSession = await fetch(
      `${endpoint}/api/viewer/session?conversation=${adminConversation.id}`,
      { headers: auth(1) },
    );
    assert.equal(adminSession.status, 200);
    const adminPayload = await adminSession.json() as {
      administrator: boolean;
      deploymentAvailable: boolean;
    };
    assert.equal(adminPayload.administrator, true);
    assert.equal(adminPayload.deploymentAvailable, true);

    const adminStatus = await fetch(
      `${endpoint}/api/viewer/deployment?conversation=${adminConversation.id}`,
      { headers: auth(1) },
    );
    assert.equal(adminStatus.status, 200);

    const requested = await fetch(`${endpoint}/api/viewer/deployment`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({ conversation: adminConversation.id }),
    });
    assert.equal(requested.status, 202);
    assert.equal(deployment.requests, 1);

    const ownerSession = await fetch(
      `${endpoint}/api/viewer/session?conversation=${ownerConversation.id}`,
      { headers: auth(42) },
    );
    assert.equal(ownerSession.status, 200);
    const ownerPayload = await ownerSession.json() as {
      administrator: boolean;
      deploymentAvailable: boolean;
    };
    assert.equal(ownerPayload.administrator, false);
    assert.equal(ownerPayload.deploymentAvailable, false);

    const denied = await fetch(`${endpoint}/api/viewer/deployment`, {
      method: "POST",
      headers: { ...auth(42), "content-type": "application/json" },
      body: JSON.stringify({ conversation: ownerConversation.id }),
    });
    assert.equal(denied.status, 403);
    assert.equal(deployment.requests, 1);
  } finally {
    await viewer.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
