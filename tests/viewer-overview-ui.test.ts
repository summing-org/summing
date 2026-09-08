import assert from "node:assert/strict";
import test from "node:test";
import { OVERVIEW_JS } from "../src/viewer-overview-assets.js";

function harness() {
  const elements = new Map<string, any>();
  const $ = (id: string) => {
    if (!elements.has(id)) {
      let html = "";
      elements.set(id, { value: "", textContent: "", writes: 0, disabled: false,
        get innerHTML() { return html; }, set innerHTML(value: string) { html = value; this.writes++; },
        classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, querySelectorAll() { return []; },
      });
    }
    return elements.get(id);
  };
  const document = { hidden: false, activeElement: null, addEventListener() {} };
  const state: any = { conversation: "main", tab: "environment" };
  const navigated: string[] = [];
  let documentReloads = 0;
  let confirm = true, calls = 0, reloads = 0;
  let respond: () => Promise<any> = async () => data;
  const scheduled = new Map<number, number>();
  let timerId = 0;
  const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const api = async () => { calls++; return respond(); };
  const ui = new Function("state", "$", "document", "window", "location", "api", "esc", "safeUrl", "localTime", "confirm", "setTimeout", "clearTimeout", "loadJobs", "loadServices", OVERVIEW_JS + "; return {renderOverview,loadOverview,refreshLiveStatus,scheduleOverviewRefresh,switchTopic,hasUnsavedSettings};")(
    state, $, document, { addEventListener() {} }, { href: "https://viewer.example/?conversation=main&tab=environment", assign: (url: string) => navigated.push(url), reload: () => { documentReloads++; } }, api, esc, (v: string) => v || "", (v: string) => v,
    () => confirm, (_callback: unknown, delay: number) => { scheduled.set(++timerId, delay); return timerId; }, (id: number) => scheduled.delete(id), async () => { reloads++; }, async () => { reloads++; },
  );
  return { $, state, document, ui, navigated, scheduled, setConfirm: (value: boolean) => { confirm = value; }, setResponse: (value: typeof respond) => { respond = value; }, documentReloads: () => documentReloads, calls: () => calls, reloads: () => reloads };
}

const data = {
  project: { id: "example", name: "Example", workspace: "repo" }, updatedAt: "2026-09-08T10:00:00Z",
  topics: [
    { id: "main", name: "Main", chat: "Team", primary: true, status: "running", pendingCount: 1, telegramUrl: "https://t.me/c/123/1", latestRun: { id: 7, status: "running", request: "<script>request</script>" } },
    { id: "parallel", name: "Parallel", chat: "Team", primary: false, status: "idle", pendingCount: 0, latestRun: { id: 6, status: "failed", error: "failed" } },
  ],
  recent: [{ id: 6, conversationId: "parallel", status: "failed", request: "Check", result: "<img src=x>", error: "failed", completedAt: "2026-09-08T09:00:00Z" }], schedules: [],
};

test("live overview coalesces reads, preserves settings and unchanged result DOM, and backs off offline", async () => {
  const h = harness();
  let release!: (value: unknown) => void;
  h.setResponse(() => new Promise((resolve) => { release = resolve; }));
  const first = h.ui.loadOverview(), second = h.ui.loadOverview();
  assert.equal(h.calls(), 1);
  release(data); await Promise.all([first, second]);
  assert.equal(h.$("activeTopics").textContent, 1);
  assert.equal(h.$("queuedInputs").textContent, 1);
  assert.equal(h.$("attentionTopics").textContent, 1);
  assert.match(h.$("overviewTopics").innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(h.$("overviewRecent").innerHTML, /<img/);
  const writes = h.$("overviewRecent").writes;
  h.$("environmentText").value = "UNSAVED=1";
  h.$("modelSelect").value = "my-model";
  h.setResponse(async () => data);
  await h.ui.refreshLiveStatus();
  assert.equal(h.$("overviewRecent").writes, writes, "expanded results and reading position survive an unchanged refresh");
  assert.equal(h.$("environmentText").value, "UNSAVED=1");
  assert.equal(h.$("modelSelect").value, "my-model");
  assert.equal(h.reloads(), 0, "background refresh does not reload settings");
  h.setResponse(async () => { throw new Error("offline"); });
  await h.ui.refreshLiveStatus();
  assert.equal(h.state.overview, data);
  assert.match(h.$("overviewFreshness").textContent, /Нет связи/);
  assert.deepEqual([...h.scheduled.values()], [10000]);
  const calls = h.calls();
  h.document.hidden = true;
  await h.ui.refreshLiveStatus();
  assert.equal(h.calls(), calls, "hidden pages do not poll");
  assert.equal(h.scheduled.size, 0);
  h.document.hidden = false; h.setResponse(async () => data);
  await h.ui.refreshLiveStatus();
  assert.equal(h.state.overviewFailures, 0);
  assert.deepEqual([...h.scheduled.values()], [5000]);
});

test("topic navigation checks unsaved settings and only opens a topic from the current overview", () => {
  const h = harness(); h.ui.renderOverview(data);
  h.state.environmentSaved = "ORIGINAL=1"; h.$("environmentText").value = "UNSAVED=1";
  h.setConfirm(false); h.ui.switchTopic("parallel");
  assert.deepEqual(h.navigated, []);
  assert.equal(h.$("topicSelect").value, "main");
  h.setConfirm(true); h.ui.switchTopic("unlisted-private-topic");
  assert.deepEqual(h.navigated, []);
  h.ui.switchTopic("parallel");
  assert.equal(new URL(h.navigated[0]!).searchParams.get("conversation"), "parallel");
  assert.equal(new URL(h.navigated[0]!).searchParams.get("tab"), "environment");
  assert.equal(h.state.conversation, "main", "navigation reloads the document; old responses cannot update the next topic");
});

test("environment editor waits for its revision and does not discard a draft on an unconfirmed reload", async () => {
  const { VIEWER_JS } = await import("../src/viewer-assets.js");
  const h = harness();
  let release!: (value: unknown) => void;
  let calls = 0;
  const state: any = { conversation: "main", environmentSaved: null, environmentRevision: 0 };
  const source = VIEWER_JS.slice(VIEWER_JS.indexOf("  async function loadEnvironment()"), VIEWER_JS.indexOf("  async function saveEnvironment()"));
  const load = new Function("state", "$", "api", "confirm", source + ";return loadEnvironment;")(
    state, h.$, async () => { calls++; return new Promise((resolve) => { release = resolve; }); }, () => false,
  );
  const pending = load();
  assert.equal(h.$("environmentText").disabled, true, "late loading response cannot overwrite user input");
  assert.equal(h.$("saveEnvironment").disabled, true, "saving requires a loaded revision");
  await load();
  assert.equal(calls, 1);
  release({ environment: { revision: 3, text: "ORIGINAL=1" } });
  await pending;
  assert.equal(h.$("environmentText").disabled, false);
  assert.equal(state.environmentRevision, 3);
  h.$("environmentText").value = "UNSAVED=1";
  await load();
  assert.equal(calls, 1);
  assert.equal(h.$("environmentText").value, "UNSAVED=1");
});


test("a rebound topic reloads the document before displaying another project with cached panels", () => {
  const h = harness(); h.ui.renderOverview(data);
  h.ui.renderOverview({ ...data, project: { id: "other-project", name: "Other", workspace: "repo" } });
  assert.equal(h.documentReloads(), 1);
  assert.equal(h.state.overview.project.id, "example", "old content must not be relabelled as the new project");
  h.ui.renderOverview({ ...data, project: { ...data.project, workspace: "other-workspace" } });
  assert.equal(h.documentReloads(), 2);
});
