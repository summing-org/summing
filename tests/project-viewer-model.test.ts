import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { ConversationModels } from "../src/conversation-models.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { ProjectViewerServer } from "../src/project-viewer.js";
import { StateStore } from "../src/state-store.js";

function auth(userId: number) {
  const data = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1_000)), user: JSON.stringify({ id: userId }) });
  const check = [...data.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  data.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update("bot-token").digest()).update(check).digest("hex"));
  return { "x-telegram-init-data": data.toString() };
}

test("Mini App model endpoint authorizes the exact topic and validates before saving", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-viewer-model-"));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const path = join(root, "workspace"); mkdirSync(path);
  const configPath = join(root, "config.toml");
  writeFileSync(configPath, `[viewer]\nport = ${port}\n[projects.demo]\nname = "Demo"\ndefault_workspace = "repo"\n[projects.demo.workspaces.repo]\npath = "${path}"\n`);
  const config = loadConfig({ SUMMING_DATA_DIR: join(root, "data"), SUMMING_CONFIG: configPath, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_OWNER_ID: "42" });
  const state = new StateStore(join(config.dataDir, "state.sqlite3"));
  const projects = new ProjectCatalog(config, state);
  const topic = state.bind(-100, 1, "demo", "repo");
  let calls = 0;
  let offline = false;
  const models = new ConversationModels({ model: "", effort: "medium" }, state, {
    models: async () => {
      calls++;
      if (offline) throw new Error("offline");
      return [{ id: "astra", model: "astra", displayName: "Astra", description: "", hidden: false, isDefault: true,
        defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }] }];
    },
  });
  const viewer = new ProjectViewerServer(config, state, projects, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    overview: (id) => models.overview(id),
    set: async (id, model, effort) => { await models.set(id, model, effort); return models.overview(id, false); },
  });
  const endpoint = `http://127.0.0.1:${port}/api/viewer/model`;
  const save = (body: unknown, user = 42) => fetch(endpoint, { method: "POST", headers: { ...auth(user), "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await viewer.start();
    assert.equal((await fetch(`${endpoint}?conversation=${topic.id}`)).status, 401);
    assert.equal((await save({ conversation: topic.id, model: "astra" }, 999)).status, 403);
    assert.equal(calls, 0, "reject unauthorized callers before catalog access");
    assert.equal((await save({ conversation: topic.id, model: "astra", effort: "high" })).status, 200);
    assert.equal(state.get(topic.id).modelOverride, "astra");
    assert.equal((await save({ conversation: topic.id, model: "astra", effort: "low" })).status, 400);
    assert.equal((await save({ conversation: topic.id, model: "invalid" })).status, 400);
    assert.equal((await save({ conversation: topic.id })).status, 400);
    assert.equal((await save({ conversation: "not-a-topic", model: null })).status, 400);
    offline = true;
    const response = await fetch(`${endpoint}?conversation=${topic.id}`, { headers: auth(42) });
    assert.equal(response.status, 200);
    const data = await response.json() as { selection: { model: string }; catalogError: string };
    assert.equal(data.selection.model, "astra");
    assert.match(data.catalogError, /недоступен/);
    assert.equal((await save({ conversation: topic.id, model: null })).status, 400);
    assert.equal(state.get(topic.id).modelOverride, "astra");
    offline = false;
    assert.equal((await save({ conversation: topic.id, model: null })).status, 200);
    assert.equal(state.get(topic.id).modelOverride, "");
  } finally { await viewer.close(); state.close(); rmSync(root, { recursive: true, force: true }); }
});
