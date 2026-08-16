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
  const bindingNotifications: Array<[number, number]> = [];
  const viewer = new ProjectViewerServer(
    config,
    state,
    projects,
    undefined,
    () => false,
    (chatId, topicId) => bindingNotifications.push([chatId, topicId]),
  );
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
  state.recordTelegramTopicUser(-300, 44, {
    userId: 42,
    username: "maria",
    firstName: "Мария",
    lastName: "Петрова",
    languageCode: "ru",
    isPremium: true,
    observedAt: 1_700_000_100,
  });
  state.recordTelegramTopicUser(-300, 44, {
    userId: 42,
    username: "maria",
    firstName: "Мария",
    lastName: "Петрова",
    languageCode: "ru",
    isPremium: true,
    observedAt: 1_700_000_110,
  });
  state.recordTelegramTopicUser(-300, 44, {
    userId: 77,
    firstName: "Deploy Bot",
    isBot: true,
    observedAt: 1_700_000_105,
  });

  try {
    await viewer.start();

    const page = await fetch(`${endpoint}/admin`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Центр управления/);

    const denied = await fetch(`${endpoint}/api/viewer/admin`, { headers: auth(42) });
    assert.equal(denied.status, 403);

    const disabledDeployment = await fetch(
      `${endpoint}/api/viewer/admin/deployment`,
      { headers: auth(1) },
    );
    assert.equal(disabledDeployment.status, 200);
    assert.deepEqual(await disabledDeployment.json(), {
      available: false,
      status: "disabled",
      phase: null,
      message: "Автоматическое обновление не настроено",
      currentSha: null,
      remoteSha: null,
      attemptId: null,
      failure: null,
      history: [],
      requestedAt: null,
      startedAt: null,
      finishedAt: null,
    });
    const unavailableDeploymentRequest = await fetch(
      `${endpoint}/api/viewer/admin/deployment`,
      { method: "POST", headers: auth(1) },
    );
    assert.equal(unavailableDeploymentRequest.status, 503);

    const initial = await fetch(`${endpoint}/api/viewer/admin`, { headers: auth(1) });
    assert.equal(initial.status, 200);
    const initialPayload = await initial.json() as {
      counts: { projects: number; topics: number; bindings: number; users: number };
      chats: Array<{
        userCount: number;
        topics: Array<{ name: string; userCount: number; binding: unknown }>;
      }>;
    };
    assert.deepEqual(
      initialPayload.counts,
      { projects: 1, topics: 1, bindings: 0, users: 2 },
    );
    assert.equal(initialPayload.chats[0]?.userCount, 2);
    assert.equal(initialPayload.chats[0]?.topics[0]?.name, "Backend");
    assert.equal(initialPayload.chats[0]?.topics[0]?.userCount, 2);

    const deniedUsers = await fetch(
      `${endpoint}/api/viewer/admin/users?chatId=-300`,
      { headers: auth(42) },
    );
    assert.equal(deniedUsers.status, 403);

    const topicUsers = await fetch(
      `${endpoint}/api/viewer/admin/users?chatId=-300&topicId=44`,
      { headers: auth(1) },
    );
    assert.equal(topicUsers.status, 200);
    const topicUsersPayload = await topicUsers.json() as {
      scope: string;
      topic: { topicId: number; name: string };
      users: Array<Record<string, unknown>>;
    };
    assert.equal(topicUsersPayload.scope, "topic");
    assert.deepEqual(topicUsersPayload.topic, { topicId: 44, name: "Backend" });
    assert.deepEqual(topicUsersPayload.users[0], {
      userId: 42,
      username: "maria",
      firstName: "Мария",
      lastName: "Петрова",
      isBot: false,
      languageCode: "ru",
      isPremium: true,
      messageCount: 2,
      topicCount: 1,
      firstSeenAt: 1_700_000_100,
      lastSeenAt: 1_700_000_110,
    });

    const chatUsers = await fetch(
      `${endpoint}/api/viewer/admin/users?chatId=-300`,
      { headers: auth(1) },
    );
    assert.equal(chatUsers.status, 200);
    const chatUsersPayload = await chatUsers.json() as {
      scope: string;
      users: Array<{ userId: number; messageCount: number; topicCount: number }>;
    };
    assert.equal(chatUsersPayload.scope, "chat");
    assert.deepEqual(
      chatUsersPayload.users.map((user) => [user.userId, user.messageCount, user.topicCount]),
      [[42, 2, 1], [77, 1, 1]],
    );

    const created = await fetch(`${endpoint}/api/viewer/admin/projects`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        mode: "empty",
        projectId: "client",
        primaryOwnerId: "42",
        workspaceId: "backend",
      }),
    });
    assert.equal(created.status, 201, await created.text());
    assert.equal(projects.owner("client"), 42);
    assert.deepEqual(projects.owners("client"), [42]);

    const deniedOwnerUpdate = await fetch(`${endpoint}/api/viewer/admin/project-owners`, {
      method: "PUT",
      headers: { ...auth(42), "content-type": "application/json" },
      body: JSON.stringify({ projectId: "client", primaryOwnerId: 42, ownerIds: [42, 77] }),
    });
    assert.equal(deniedOwnerUpdate.status, 403);

    const addedOwner = await fetch(`${endpoint}/api/viewer/admin/project-owners`, {
      method: "PUT",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({ projectId: "client", primaryOwnerId: 42, ownerIds: [42, 77] }),
    });
    assert.equal(addedOwner.status, 200, await addedOwner.text());
    assert.deepEqual(projects.owners("client"), [42, 77]);
    assert.equal(projects.canAccess(77, "client"), true);

    const changedPrimary = await fetch(`${endpoint}/api/viewer/admin/project-owners`, {
      method: "PUT",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({ projectId: "client", primaryOwnerId: 77, ownerIds: [42, 77] }),
    });
    assert.equal(changedPrimary.status, 200, await changedPrimary.text());
    assert.equal(projects.owner("client"), 77);
    assert.deepEqual(projects.owners("client"), [77, 42]);

    const removedOwner = await fetch(`${endpoint}/api/viewer/admin/project-owners`, {
      method: "PUT",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({ projectId: "client", primaryOwnerId: 77, ownerIds: [77] }),
    });
    assert.equal(removedOwner.status, 200, await removedOwner.text());
    assert.deepEqual(projects.owners("client"), [77]);
    assert.equal(projects.canAccess(42, "client"), false);

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
    assert.deepEqual(bindingNotifications, [[-300, 44]]);

    const unchanged = await fetch(`${endpoint}/api/viewer/admin/bindings`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        chatId: -300,
        topicId: 44,
        projectId: "client",
        workspaceId: "backend",
      }),
    });
    assert.equal(unchanged.status, 200, await unchanged.text());
    assert.deepEqual(bindingNotifications, [[-300, 44]]);

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
    assert.deepEqual(bindingNotifications, [[-300, 44], [-300, 44]]);

    const final = await fetch(`${endpoint}/api/viewer/admin`, { headers: auth(1) });
    const finalPayload = await final.json() as {
      counts: { projects: number; topics: number; bindings: number; users: number };
      projects: Array<{
        id: string;
        primaryOwnerId: number;
        ownerIds: number[];
        managed: boolean;
      }>;
      chats: Array<{
        topics: Array<{
          binding: { projectId: string; workspaceId: string; busy: boolean } | null;
        }>;
      }>;
    };
    assert.deepEqual(
      finalPayload.counts,
      { projects: 2, topics: 1, bindings: 1, users: 2 },
    );
    assert.deepEqual(
      finalPayload.projects.find((project) => project.id === "client"),
      {
        id: "client",
        name: "client",
        primaryOwnerId: 77,
        ownerIds: [77],
        managed: true,
        selfChange: false,
        defaultWorkspaceId: "backend",
        workspaces: [{ id: "backend" }],
        bindingCount: 0,
      },
    );
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
