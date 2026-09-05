import assert from "node:assert/strict";
import test from "node:test";
import { VIEWER_HTML, VIEWER_JS } from "../src/viewer-assets.js";

test("Mini App picker uses explicit save, preserves failures and distinguishes execution evidence", async () => {
  assert.match(VIEWER_HTML, /data-tab="model"/);
  assert.doesNotThrow(() => new Function(VIEWER_JS));
  const source = VIEWER_JS.slice(VIEWER_JS.indexOf("  function modelEvidence("), VIEWER_JS.indexOf('  $("reloadModel").addEventListener'));
  const elements = new Map<string, { value: string; textContent: string; innerHTML: string; disabled: boolean }>();
  const $ = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", innerHTML: "", disabled: false });
    return elements.get(id)!;
  };
  const data = {
    conversationId: "tg-abc", chatId: -100, topicId: 5, catalogError: null as string | null,
    catalogUpdatedAt: Date.now(), selection: { model: "astra", effort: "high", source: "conversation" },
    override: { model: "astra", effort: "high" },
    models: [{ model: "astra", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
    active: { runId: 7, settings: { requestedModel: "luna", requestedEffort: "low", model: null } },
    history: [{ runId: 6, status: "completed", settings: { requestedModel: "<astra>", requestedEffort: "high", model: "sol", effort: null, confirmation: "rerouted", reroutes: [] } }],
  };
  const state = { conversation: "tg-abc", modelSettings: null, modelBusy: false };
  const requests: Array<{ path: string; body: string }> = [];
  let fail = false;
  const api = async (path: string, options: { body: string }) => {
    requests.push({ path, body: options.body });
    if (fail) throw new Error("catalog offline");
    return data;
  };
  const esc = (value: unknown) => String(value ?? "").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const ui = new Function("state", "$", "esc", "api", "toast", "localTime", source + "; return {renderModel,modelEfforts,saveModel};")(
    state, $, esc, api, () => {}, () => "now",
  ) as { renderModel(value: typeof data): void; modelEfforts(): void; saveModel(): Promise<void> };
  ui.renderModel(data);
  assert.equal($("modelSelect").value, "astra");
  assert.equal($("modelEffort").value, "high");
  assert.match($("modelScope").textContent, /topic 5/);
  assert.match($("modelActive").textContent, /Запрошено: luna/);
  assert.match($("modelActive").textContent, /не подтвердил/);
  assert.match($("modelHistory").innerHTML, /&lt;astra&gt;/);
  assert.doesNotMatch($("modelHistory").innerHTML, /<astra>/);
  assert.match($("modelHistory").innerHTML, /effort не подтверждён/);
  ui.modelEfforts();
  assert.equal(requests.length, 0, "changing a selector does not save implicitly");
  await ui.saveModel();
  assert.deepEqual(JSON.parse(requests[0]!.body), { conversation: "tg-abc", model: "astra", effort: "high" });
  $("modelSelect").value = "";
  ui.modelEfforts();
  assert.equal($("modelEffort").disabled, true);
  await ui.saveModel();
  assert.deepEqual(JSON.parse(requests[1]!.body), { conversation: "tg-abc", model: null });
  fail = true;
  $("modelSelect").value = "";
  await ui.saveModel();
  assert.equal($("modelSelect").value, "", "failure preserves the unsaved choice");
  assert.match($("modelStatus").textContent, /offline/);
  assert.equal(state.modelBusy, false);
  ui.renderModel({ ...data, catalogError: "offline" });
  assert.equal($("saveModel").disabled, true, "stale catalog cannot enable an explicit model write");
});
