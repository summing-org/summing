import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig } from "../src/config.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { ProjectViewerServer } from "../src/project-viewer.js";
import { StateStore } from "../src/state-store.js";
import { GitInspector } from "../src/git-inspector.js";

test("viewer list and diff enforce immutable run scope before and after async artifact reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-run-scope-"));
  const repository = join(root, "repository");
  const projects = new Map(["alpha", "beta"].map((id) => [id, new ProjectConfig(id, id, "repo", new Map([["repo", { id: "repo", path: repository }]]))]));
  const config = new RuntimeConfig(root, join(root, "codex"), join(root, "worktrees"), "token", 1, "codex", 8765, 1, 1, "", "medium", false, projects);
  const state = new StateStore(join(root, "state.sqlite3"));
  const catalog = new ProjectCatalog(config, state);
  catalog.canAccess = (_user, id) => id === "beta";
  const viewer = new ProjectViewerServer(config, state, catalog);
  const route = (viewer as unknown as { route(request: IncomingMessage, response: ServerResponse): Promise<void> }).route.bind(viewer);
  const auth = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 222 }) });
  const check = [...auth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  auth.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update("token").digest()).update(check).digest("hex"));
  let body = "";
  const response = { writeHead: () => {}, end: (data: string) => { body = data; } } as unknown as ServerResponse;
  const request = (path: string) => ({ method: "GET", url: path, headers: { "x-telegram-init-data": auth.toString() } }) as unknown as IncomingMessage;
  const snapshots = { snapshot: async () => "a".repeat(40), commitDiff: async () => "ALPHA_PRIVATE_PATCH" } as unknown as GitInspector;
  try {
    mkdirSync(repository);
    execFileSync("git", ["init", "--initial-branch=main", repository], { stdio: "pipe" });
    // Never accidentally use the checkout enclosing TMPDIR. Deploy tests run
    // from an exported release with no .git directory in its parent chain.
    assert.equal(realpathSync(await GitInspector.worktreeRoot(repository)), realpathSync(repository));
    const topic = state.bind(-100, 1, "alpha", "repo");
    const old = state.startRun(topic.id, "ALPHA_PRIVATE_PROMPT", []);
    state.finishRun(old, "interrupted", "", "restart");
    await viewer.artifacts.begin(old, topic.id, snapshots);
    await viewer.artifacts.complete(old, topic.id, snapshots);
    state.bind(-100, 1, "beta", "repo");
    await route(request(`/api/viewer/runs?conversation=${topic.id}`), response);
    assert.deepEqual(JSON.parse(body).runs, []);
    await assert.rejects(route(request(`/api/viewer/run-diff?conversation=${topic.id}&run=${old}`), response), /not found/);
    const fresh = state.startRun(topic.id, "BETA", []);
    state.finishRun(fresh, "completed", "", null);
    await viewer.artifacts.begin(fresh, topic.id, snapshots);
    await viewer.artifacts.complete(fresh, topic.id, snapshots);
    await route(request(`/api/viewer/runs?conversation=${topic.id}`), response);
    assert.deepEqual(JSON.parse(body).runs.map((item: { runId: number }) => item.runId), [fresh]);
    viewer.artifacts.patch = async () => { state.bind(-100, 1, "alpha", "repo"); return "must not escape"; };
    await assert.rejects(route(request(`/api/viewer/run-diff?conversation=${topic.id}&run=${fresh}`), response), /scope changed/);
    assert.doesNotMatch(body, /PRIVATE|must not escape/);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});
