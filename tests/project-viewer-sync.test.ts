import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import type { KnowledgeSyncAdmin } from "../src/knowledge-sync.js";
import type { NodeRecoveryAdmin } from "../src/node-recovery-service.js";
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
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function signedInitData(token: string, userId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1_000)),
    query_id: `query-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "Viewer" }),
  });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

test("owner-only Admin API exposes MTProto, consent and source sync actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-viewer-sync-"));
  const repository = join(root, "repo");
  mkdirSync(repository);
  const state = new StateStore(join(root, "state.sqlite"));
  const port = await freePort();
  const workspace: WorkspaceConfig = { id: "repo", path: repository };
  const config = new RuntimeConfig(
    root,
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
    new Map([["summing", new ProjectConfig(
      "summing", "SUMMING", "repo", new Map([["repo", workspace]]), true,
    )]]),
    20, 12, 60, "openai", "gpt-transcribe", "", "", 20_000_000, port,
  );
  const calls: Array<[string, unknown]> = [];
  const syncOverview = {
    enabled: true,
    telegramTermsReviewed: true,
    objectStore: "s3",
    embeddings: { configured: true },
    connectors: [],
    consents: { granted: 0, revoked: 0, sources: 0 },
    statuses: [],
  };
  const fake: KnowledgeSyncAdmin = {
    overview: () => syncOverview,
    beginAuthorization: (input) => {
      calls.push(["authorize", { ...input, apiHash: "[redacted]" }]);
      return {
        connectorId: "11111111-1111-4111-8111-111111111111",
        state: "starting",
        passwordHint: "",
        expiresAt: 999,
        error: "",
      };
    },
    submitAuthorization: (id, input) => {
      calls.push(["code", { id, ...input }]);
      return { connectorId: id, state: "ready", passwordHint: "", expiresAt: 999, error: "" };
    },
    grantConsent: (input) => { calls.push(["consent", input]); return input; },
    grantGroupConsent: (input) => { calls.push(["group-consent", input]); return input; },
    revokeConsent: async (chatId, userId) => { calls.push(["revoke-consent", { chatId, userId }]); },
    startSource: async (input) => {
      calls.push(["start", input]);
      return { sourceId: "source" } as never;
    },
    pauseSource: (chatId) => ({ chatId } as never),
    resumeSource: async (chatId) => ({ chatId } as never),
    unbindSource: (chatId) => { calls.push(["unbind", chatId]); },
    revokeConnector: async (id) => { calls.push(["revoke-connector", id]); },
    startKnowledgeExport: (input) => {
      calls.push(["export", input]);
      return { id: "export" } as never;
    },
    startKnowledgeImport: (input) => {
      calls.push(["import", input]);
      return { id: "import" } as never;
    },
    confirmKnowledgeImport: (id, acceptConsents) => {
      calls.push(["confirm-import", { id, acceptConsents }]);
      return { id } as never;
    },
  };
  const recovery: NodeRecoveryAdmin = {
    overview: () => ({ configured: true, jobs: [] }),
    startExport: (input) => {
      calls.push(["node-export", input]);
      return { id: "node-export", recoveryKey: "b".repeat(64) } as never;
    },
    startRestore: (input) => {
      calls.push(["node-restore", input]);
      return { id: "node-restore" } as never;
    },
    confirmRestore: (id) => {
      calls.push(["node-confirm", id]);
      return { id } as never;
    },
  };
  const viewer = new ProjectViewerServer(
    config,
    state,
    new ProjectCatalog(config, state),
    undefined,
    () => false,
    () => {},
    fake,
    () => ({ botConnected: true, codexAuthenticated: true }),
    recovery,
  );
  const endpoint = `http://127.0.0.1:${port}`;
  const auth = (userId: number) => ({ "x-telegram-init-data": signedInitData("bot-token", userId) });
  try {
    assert.equal(viewer.knowledgeSync, fake);
    await viewer.start();
    assert.equal((await fetch(`${endpoint}/api/viewer/admin/sync`, { headers: auth(2) })).status, 403);
    const overview = await fetch(`${endpoint}/api/viewer/admin/sync`, { headers: auth(1) });
    const overviewPayload = await overview.json();
    assert.equal(overview.status, 200, JSON.stringify(overviewPayload));
    assert.deepEqual(overviewPayload, syncOverview);

    assert.equal(
      (await fetch(`${endpoint}/api/viewer/admin/onboarding`, { headers: auth(2) })).status,
      403,
    );
    const onboardingResponse = await fetch(
      `${endpoint}/api/viewer/admin/onboarding`,
      { headers: auth(1) },
    );
    const onboarding = await onboardingResponse.json() as {
      complete: boolean;
      steps: Array<{ id: string; state: string }>;
    };
    assert.equal(onboardingResponse.status, 200);
    assert.equal(onboarding.complete, false);
    assert.deepEqual(
      Object.fromEntries(onboarding.steps.map((step) => [step.id, step.state])),
      {
        provisioning: "complete",
        "secure-bootstrap": "complete",
        codex: "complete",
        "telegram-group": "pending",
        mtproto: "pending",
        consent: "pending",
        "first-source": "pending",
      },
    );

    const created = await fetch(`${endpoint}/api/viewer/admin/mtproto/connectors`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({ apiId: 123, apiHash: "a".repeat(32), phone: "+79990000000" }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json() as { state: string }).state, "starting");

    const consent = await fetch(`${endpoint}/api/viewer/admin/knowledge/consents`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({ chatId: -100, allUsers: true, proof: "contract" }),
    });
    assert.equal(consent.status, 200);

    const started = await fetch(`${endpoint}/api/viewer/admin/knowledge/sources`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        action: "start",
        chatId: -100,
        connectorId: "11111111-1111-4111-8111-111111111111",
      }),
    });
    assert.equal(started.status, 202);
    const exported = await fetch(`${endpoint}/api/viewer/admin/knowledge/transfers`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({ kind: "export", spaceId: "space-test", mode: "portable" }),
    });
    assert.equal(exported.status, 202);
    const imported = await fetch(`${endpoint}/api/viewer/admin/knowledge/transfers`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        kind: "import",
        bundleKey: "summing/exports/id/manifest.json",
        recoveryKey: "a".repeat(64),
      }),
    });
    assert.equal(imported.status, 202);
    assert.equal(
      calls.map(([name]) => name).join(","),
      "authorize,group-consent,start,export,import",
    );

    assert.equal(
      (await fetch(`${endpoint}/api/viewer/admin/recovery`, { headers: auth(2) })).status,
      403,
    );
    const recoveryOverview = await fetch(
      `${endpoint}/api/viewer/admin/recovery`,
      { headers: auth(1) },
    );
    assert.deepEqual(await recoveryOverview.json(), { configured: true, jobs: [] });
    const nodeExport = await fetch(`${endpoint}/api/viewer/admin/recovery/jobs`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        kind: "export",
        includeSecrets: true,
        confirmation: "INCLUDE SECRETS",
      }),
    });
    assert.equal(nodeExport.status, 202);
    assert.equal((await nodeExport.json() as { recoveryKey: string }).recoveryKey, "b".repeat(64));
    const nodeRestore = await fetch(`${endpoint}/api/viewer/admin/recovery/jobs`, {
      method: "POST",
      headers: { ...auth(1), "content-type": "application/json" },
      body: JSON.stringify({
        kind: "restore",
        bundleKey: "summing/node-recovery/node/backup/manifest.json",
        recoveryKey: "b".repeat(64),
      }),
    });
    assert.equal(nodeRestore.status, 202);
    const confirmedRecovery = await fetch(
      `${endpoint}/api/viewer/admin/recovery/jobs/11111111-1111-4111-8111-111111111111/confirm`,
      { method: "POST", headers: auth(1) },
    );
    assert.equal(confirmedRecovery.status, 202);
    assert.equal(
      calls.map(([name]) => name).join(","),
      "authorize,group-consent,start,export,import,node-export,node-restore,node-confirm",
    );
  } finally {
    await viewer.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
