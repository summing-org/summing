import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig } from "../src/config.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { ProjectViewerServer } from "../src/project-viewer.js";
import { StateStore } from "../src/state-store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "viewer-overview-"));
  const projects = new Map(["alpha", "beta"].map((id) => [id, new ProjectConfig(id, id, "repo", new Map([
    ["repo", { id: "repo", path: root }], ["other", { id: "other", path: root }],
  ]))]));
  const config = new RuntimeConfig(root, join(root, "codex"), join(root, "worktrees"), "token", 1, "codex", 8765, 1, 1, "", "medium", false, projects);
  const state = new StateStore(join(root, "state.sqlite3"));
  const catalog = new ProjectCatalog(config, state);
  let allowed = true;
  catalog.canAccess = (_user, id) => allowed && id === "alpha";
  const busy = new Set<string>();
  const viewer = new ProjectViewerServer(config, state, catalog, undefined, (topic) => busy.has(topic.id), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (project, workspace) => {
      assert.equal(project, "alpha"); assert.equal(workspace, "repo");
      return [{ name: "Публикация", nextRunAt: "2026-09-09T06:00:00.000Z", timeZone: "Europe/Moscow", destination: "Отчёты" }];
    });
  viewer.runner.available = async () => { throw new Error("overview must not depend on runner I/O"); };
  const route = (viewer as unknown as { route(request: IncomingMessage, response: ServerResponse): Promise<void> }).route.bind(viewer);
  const auth = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 222 }) });
  const check = [...auth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  auth.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update("token").digest()).update(check).digest("hex"));
  const get = async (id: string) => {
    let body = "";
    await route({ method: "GET", url: `/api/viewer/overview?conversation=${id}`, headers: { "x-telegram-init-data": auth.toString() } } as unknown as IncomingMessage,
      { writeHead: () => {}, end: (data: string) => { body = data; } } as unknown as ServerResponse);
    return JSON.parse(body);
  };
  return { state, busy, get, revoke: () => { allowed = false; }, close: () => { state.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("overview shows all editable topics in one workspace without Git or runner access", async () => {
  const f = fixture();
  try {
    const main = f.state.bind(-10012345, 1, "alpha", "repo");
    const parallel = f.state.bind(-10012345, 2, "alpha", "repo");
    const queued = f.state.bind(-10012345, 3, "alpha", "repo");
    const preparing = f.state.bind(-10012345, 4, "alpha", "repo");
    const otherWorkspace = f.state.bind(-10012345, 5, "alpha", "other");
    const beta = f.state.bind(-10012345, 6, "beta", "repo");
    f.state.bind(-10012345, 7, "alpha", "repo", "observer");
    const done = f.state.startRun(main.id, "Завершённая задача");
    f.state.finishRun(done, "completed", "Готовый результат");
    const running = f.state.startRun(parallel.id, "Параллельная задача");
    f.state.setActive(parallel.id, "active-turn", null);
    f.state.enqueueInput(queued.id, 10, "Ожидает", "followup");
    f.busy.add(preparing.id);
    f.state.startRun(otherWorkspace.id, "OTHER_WORKSPACE_PRIVATE");
    f.state.startRun(beta.id, "BETA_PRIVATE");
    const result = await f.get(parallel.id);
    assert.equal(result.conversation, parallel.id);
    assert.equal(result.topics.length, 4);
    assert.equal(result.topics[0].id, main.id);
    assert.equal(result.topics[0].primary, true);
    assert.equal(result.topics[0].telegramUrl, "https://t.me/c/12345/1");
    assert.equal(result.topics.find((t: { id: string }) => t.id === parallel.id).latestRun.id, running);
    assert.equal(result.topics.find((t: { id: string }) => t.id === parallel.id).status, "running");
    assert.equal(result.topics.find((t: { id: string }) => t.id === queued.id).pendingCount, 1);
    assert.equal(result.topics.find((t: { id: string }) => t.id === queued.id).status, "queued");
    assert.equal(result.topics.find((t: { id: string }) => t.id === preparing.id).status, "preparing");
    assert.deepEqual(result.recent.map((r: { id: number }) => r.id), [done]);
    assert.equal(result.recent[0].result, "Готовый результат");
    assert.equal(result.schedules[0].timeZone, "Europe/Moscow");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|worktreePath|codexThreadId|active-turn/);
    await assert.rejects(f.get(beta.id), /access denied/);
    f.revoke();
    await assert.rejects(f.get(main.id), /access denied/);
  } finally { f.close(); }
});

test("overview discards rebound history, bounds previews and reflects completion on next refresh", async () => {
  const f = fixture();
  try {
    const main = f.state.bind(-10012345, 1, "alpha", "repo");
    const rebound = f.state.bind(-10012345, 2, "beta", "repo");
    const secret = f.state.startRun(rebound.id, "BETA_PRIVATE");
    f.state.finishRun(secret, "failed", "BETA_RESULT", "BETA_ERROR");
    f.state.bind(-10012345, 2, "alpha", "repo");
    const running = f.state.startRun(main.id, "З".repeat(500));
    let result = await f.get(main.id);
    assert.equal(result.topics[0].status, "running");
    assert.equal(result.topics[0].latestRun.request.length, 240);
    assert.doesNotMatch(JSON.stringify(result), /BETA_/);
    f.state.finishRun(running, "failed", "Р".repeat(900), "О".repeat(400));
    result = await f.get(main.id);
    assert.equal(result.topics[0].status, "idle");
    assert.equal(result.recent[0].status, "failed");
    assert.equal(result.recent[0].result.length, 600);
    assert.equal(result.recent[0].error.length, 240);
    f.state.bind(-10012345, 2, "beta", "repo");
    result = await f.get(main.id);
    assert.equal(result.topics.length, 1);
  } finally { f.close(); }
});
