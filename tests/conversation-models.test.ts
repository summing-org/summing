import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConversationModels } from "../src/conversation-models.js";
import type { CodexModel } from "../src/codex-app-server.js";
import { StateStore } from "../src/state-store.js";

const candidate = (model = "astra", isDefault = true): CodexModel => ({
  id: model, model, displayName: model, description: "", hidden: false, isDefault,
  defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
});

function fixture(t: test.TestContext, configuredModel = "") {
  const root = mkdtempSync(join(tmpdir(), "summing-models-"));
  const path = join(root, "state.sqlite3");
  const state = new StateStore(path);
  const first = state.bind(42, 1, "alpha", "repo");
  const second = state.bind(42, 2, "beta", "repo");
  const codex = { models: async () => [candidate()] };
  const manager = new ConversationModels({ model: configuredModel, effort: "medium" }, state, codex);
  t.after(() => { state.close(); rmSync(root, { recursive: true, force: true }); });
  return { state, path, first, second, codex, manager };
}

test("model selection validates efforts and resets only after resolving a fresh default", async (t) => {
  const f = fixture(t);
  await f.manager.set(f.first.id, "astra", "high");
  await assert.rejects(f.manager.set(f.first.id, "astra", "medium"), /доступны effort/);
  assert.equal(f.state.get(f.second.id).modelOverride, "");
  f.codex.models = async () => [candidate("astra", false)];
  await assert.rejects(f.manager.set(f.first.id, null), /не обозначил default/);
  assert.equal(f.state.get(f.first.id).modelOverride, "astra");
  f.codex.models = async () => [candidate("next")];
  assert.equal((await f.manager.set(f.first.id, null)).model, "next");
  assert.equal(f.state.get(f.first.id).modelOverride, "");
});

test("unsupported global effort falls back to model default and configured model takes precedence", async (t) => {
  const f = fixture(t, "configured");
  f.codex.models = async () => [candidate("configured", false), candidate("live-default")];
  assert.deepEqual(await f.manager.resolve(f.first), { model: "configured", effort: "high", source: "config" });
});

test("catalog outage preserves saved selection and last known catalog; explicit writes fail closed", async (t) => {
  const f = fixture(t);
  await f.manager.set(f.first.id, "astra");
  f.codex.models = async () => { throw new Error("offline"); };
  const overview = await f.manager.overview(f.first.id);
  assert.equal(overview.selection?.model, "astra");
  assert.match(overview.catalogError!, /недоступен/);
  assert.equal(overview.models.length, 1);
  assert.equal((await f.manager.resolve(f.state.get(f.first.id))).model, "astra");
  await assert.rejects(f.manager.set(f.first.id, "astra"), /offline/);
  await assert.rejects(f.manager.set(f.first.id, null), /offline/);
  assert.equal(f.state.get(f.first.id).modelOverride, "astra");
});

test("parallel catalog readers share one request and a later retry recovers", async (t) => {
  const f = fixture(t);
  let finish!: (value: CodexModel[]) => void;
  let calls = 0;
  f.codex.models = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const readers = [f.manager.overview(f.first.id), f.manager.overview(f.second.id), f.manager.catalog(true)];
  assert.equal(calls, 1);
  finish([candidate()]);
  await Promise.all(readers);
  f.codex.models = async () => { calls++; return [candidate("next")]; };
  assert.equal((await f.manager.catalog(true))[0]?.model, "next");
  assert.equal(calls, 2);
});

test("an in-flight selection cannot overwrite a rebind or another saved selection", async (t) => {
  const f = fixture(t);
  let finish!: (value: CodexModel[]) => void;
  f.codex.models = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.manager.set(f.first.id, "astra");
  f.state.setConversationModel(f.first.id, "newer-choice", "low");
  finish([candidate()]);
  await assert.rejects(pending, /изменилась/);
  assert.equal(f.state.get(f.first.id).modelOverride, "newer-choice");
});

test("requested and confirmed run settings survive reopening; old runs remain unknown", async (t) => {
  const f = fixture(t);
  const legacy = f.state.startRun(f.first.id, "old", []);
  const recent = f.state.startRun(f.first.id, "new", []);
  const settings = { requestedModel: "astra", requestedEffort: "high", model: "luna", effort: null,
    confirmation: "rerouted" as const, reroutes: [{ fromModel: "astra", toModel: "luna", reason: "capacity" }] };
  f.state.setRunModel(recent, settings);
  const reopened = new StateStore(f.path);
  try {
    assert.deepEqual(reopened.runModel(recent), settings);
    assert.equal(reopened.runModel(legacy), null);
    assert.deepEqual(reopened.conversationModelHistory(f.first.id).map((run) => run.runId), [recent, legacy]);
    assert.deepEqual(reopened.conversationModelHistory(f.second.id), []);
  } finally { reopened.close(); }
});
