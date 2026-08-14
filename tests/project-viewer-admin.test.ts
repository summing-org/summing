import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { ProjectViewerServer } from "../src/project-viewer.js";
import { StateStore } from "../src/state-store.js";

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

test("administrator Mini App creates projects and safely rebinds discovered topics", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-viewer-admin-"));
  const staticPath = join(root, "summing");
  mkdirSync(staticPath);
  const dataDir = join(root, "data");
  const state = new StateStore(join(dataDir, "state.sqlite3"));
  const port = await freePort();
  const workspace: WorkspaceConfig = { id: "repo", path: staticPath };
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
    new Map([
      [
        "summing",
        new ProjectConfig("summing", "SUMMING", "repo", new Map([["repo", workspace]]), true),
      ],
    ]),
    20,
    12,
    60,
    "openai",
    "gpt-transcribe",
    "",
    "",
    20_000_000,
    port,
  );
  const projects = new ProjectCatalog(config, state);
  const viewer = new ProjectViewerServer(config, state, projects);
  const endpoint = `http://127.0.0.1:${port}`;
  const auth = (userId: number): Record<string, string> => ({
    "x-telegram-init-data": signedInitData("bot-token", userId),
  });

  state.recordTelegramChat({
    chatId: -300,
    type: "supergroup",
    title: "Engineering",
    isForum: true,
    botStatus: "administrator",
  });
  state.recordTelegramTopic(-300, 44, "Backend");

  try {
    await viewer.start();

    const page = await fetch(`${endpoint}/admin`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Центр управления/);

    const denied = await fetch(`${endpoint}/api/viewer/admin`, { headers: auth(42) });
    assert.equal(denied.status, 403);

    const initial = await fetch(`${endpoint}/api/viewer/admin`, { headers: auth(1) });
    assert.equal(initial.status, 200);
    const initialPayload = await initial.json() as {
      counts: { projects: number; topics: number; bindings: number };
      chats: Array<{ topics: Array<{ name: string; binding: unknown }> }>;
    };
    assert.deepEqual(initialPayload.counts, { projects: 1, topics: 1, bindings: 0 });
    assert.equal(initialPayload.chats[0]?.topics[0]?.name, "Backend");

    const created = await fetch(`${endpoint}/api/viewer/admin/projects`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        mode: "empty",
        projectId: "client",
        ownerId: "42",
        workspaceId: "backend",
      }),
    });
    assert.equal(created.status, 201, await created.text());
    assert.equal(projects.owner("client"), 42);

    const bound = await fetch(`${endpoint}/api/viewer/admin/bindings`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        chatId: -300,
        topicId: 44,
        projectId: "client",
        workspaceId: "backend",
      }),
    });
    assert.equal(bound.status, 200, await bound.text());
    const conversation = state.byTopic(-300, 44)!;
    assert.equal(conversation.projectId, "client");
    state.setThread(conversation.id, "thread-client");
    state.setActive(conversation.id, "turn-active", null);

    const busy = await fetch(`${endpoint}/api/viewer/admin/bindings`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        chatId: -300,
        topicId: 44,
        projectId: "summing",
        workspaceId: "repo",
      }),
    });
    assert.equal(busy.status, 409);
    assert.equal(state.byTopic(-300, 44)?.projectId, "client");

    state.clearActive(conversation.id);
    const rebound = await fetch(`${endpoint}/api/viewer/admin/bindings`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        chatId: -300,
        topicId: 44,
        projectId: "summing",
        workspaceId: "repo",
      }),
    });
    assert.equal(rebound.status, 200, await rebound.text());
    assert.equal(state.byTopic(-300, 44)?.projectId, "summing");
    assert.equal(state.byTopic(-300, 44)?.codexThreadId, null);

    const final = await fetch(`${endpoint}/api/viewer/admin`, { headers: auth(1) });
    const finalPayload = await final.json() as {
      counts: { projects: number; topics: number; bindings: number };
      chats: Array<{
        topics: Array<{
          binding: { projectId: string; workspaceId: string; busy: boolean } | null;
        }>;
      }>;
    };
    assert.deepEqual(finalPayload.counts, { projects: 2, topics: 1, bindings: 1 });
    assert.deepEqual(finalPayload.chats[0]?.topics[0]?.binding, {
      conversationId: state.byTopic(-300, 44)?.id,
      projectId: "summing",
      workspaceId: "repo",
      busy: false,
    });
  } finally {
    await viewer.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
