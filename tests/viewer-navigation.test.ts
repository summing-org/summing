import assert from "node:assert/strict";
import test from "node:test";
import { NAVIGATION_JS } from "../src/viewer-navigation-assets.js";

class Element {
  hidden = false;
  tabIndex = 0;
  scrollTop = 0;
  scrollLeft = 0;
  offsetLeft = 80;
  offsetWidth = 80;
  clientWidth = 320;
  isConnected = true;
  classes = new Set<string>();
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: any) => void>();
  children: Element[] = [];
  classList = {
    toggle: (name: string, on = !this.classes.has(name)) => on ? this.classes.add(name) : this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };
  constructor(public id = "", public dataset: Record<string, string> = {}) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelectorAll() { return this.children; }
  addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, listener); }
  focus() {}
}

function harness(input: { tab?: string; saved?: unknown; environmentAccess?: boolean } = {}) {
  const tabs = ["overview", "runs", "results", "launch", "files", "changes", "history", "model", "repository", "environment"];
  const panels = tabs.map(name => new Element(name + "Panel"));
  const primary = ["overview", "work", "files", "settings"].map(section => new Element("", { section }));
  const secondary = tabs.filter(tab => tab !== "overview").map(tab => new Element("", { tab }));
  const bar = new Element("subtabs");
  const document = {
    activeElement: null as Element | null,
    querySelectorAll(selector: string) {
      if (selector === ".primary-nav button") return primary;
      if (selector === ".section-tabs button") return secondary;
      if (selector === ".panel") return panels;
      throw new Error(selector);
    },
    querySelector(selector: string) {
      if (selector === ".section-tabs") return bar;
      return secondary.find(button => selector.includes('data-tab="' + button.dataset.tab + '"')) ?? null;
    },
  };
  for (const button of secondary) button.focus = () => { document.activeElement = button; };
  const events = new Map<string, () => void>();
  const storage = new Map<string, string>();
  if (input.saved !== undefined) storage.set("summingViewerNavigation:current", JSON.stringify(input.saved));
  const calls = new Map<string, number>();
  const handlers = new Map<string, () => Promise<void>>();
  const location = { href: "https://viewer.example/?conversation=current" + (input.tab ? "&tab=" + input.tab : "") };
  const writes: string[] = [];
  const history = {
    pushState: (_state: unknown, _title: string, url: string) => { location.href = url; writes.push(url); },
    replaceState: (_state: unknown, _title: string, url: string) => { location.href = url; },
  };
  const state = { conversation: "current", tab: "overview", session: { environmentAccess: input.environmentAccess ?? true }, overview: {} };
  const loaderNames = ["loadOverview", "loadRuns", "loadServices", "loadJobs", "loadTree", "loadWorkingDiff", "loadCommits", "loadModel", "loadRepository", "loadEnvironment"];
  const loaders = loaderNames.map(name => async () => { calls.set(name, (calls.get(name) ?? 0) + 1); await handlers.get(name)?.(); });
  const ui = new Function("state", "$", "document", "window", "sessionStorage", "location", "history", "URL", "toast", ...loaderNames,
    NAVIGATION_JS + ";return {initializeNavigation,setTab,setSection,ensurePanelLoaded,refreshCurrentTab,navigation};")(
    state, (id: string) => panels.find(panel => panel.id === id), document,
    { addEventListener: (name: string, handler: () => void) => events.set(name, handler) },
    { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
    location, history, URL, () => {}, ...loaders,
  );
  return { ui, state, panels, primary, secondary, bar, document, location, writes, calls, handlers, events, storage,
    settle: () => ui.ensurePanelLoaded(state.tab) as Promise<void> };
}

test("navigation maps legacy links and remembers each section without reloading its content", async () => {
  const h = harness({ tab: "repository" }); h.ui.initializeNavigation(); await h.settle();
  assert.equal(h.state.tab, "repository");
  assert.equal(h.primary.find(button => button.classes.has("active"))?.dataset.section, "settings");
  assert.deepEqual(h.secondary.filter(button => !button.hidden).map(button => button.dataset.tab), ["model", "repository", "environment"]);
  assert.equal(h.calls.get("loadRepository"), 1);
  const repository = h.panels.find(panel => panel.id === "repositoryPanel")!;
  const nested = new Element(); repository.children.push(nested);
  repository.scrollTop = 400; nested.scrollLeft = 90;
  h.ui.setSection("files"); await h.settle();
  h.ui.setTab("history"); await h.settle();
  repository.scrollTop = 0; nested.scrollLeft = 0;
  h.ui.setSection("settings"); await h.settle();
  assert.equal(h.state.tab, "repository");
  assert.equal(h.calls.get("loadRepository"), 1);
  assert.equal(repository.scrollTop, 400);
  assert.equal(nested.scrollLeft, 90);
  h.ui.setSection("files"); await h.settle();
  assert.equal(h.state.tab, "history");
  assert.equal(h.calls.get("loadCommits"), 1);
  assert.equal(new URL(h.location.href).searchParams.get("tab"), "history");
  assert.equal(JSON.parse(h.storage.get("summingViewerNavigation:current")!).last.settings, "repository");
});

test("rapid section switches share one load and browser Back does not add history entries", async () => {
  const h = harness({ tab: "launch" });
  let release!: () => void;
  h.handlers.set("loadJobs", () => new Promise(resolve => { release = resolve; }));
  h.ui.initializeNavigation();
  const pending = h.settle(); await Promise.resolve();
  h.ui.setSection("files"); await h.settle();
  h.ui.setSection("work");
  assert.equal(h.calls.get("loadJobs"), 1);
  release(); await pending; await h.settle();
  const count = h.writes.length;
  h.location.href = "https://viewer.example/?conversation=current&tab=files";
  h.events.get("popstate")!(); await h.settle();
  assert.equal(h.state.tab, "files");
  assert.equal(h.writes.length, count);
  assert.equal(h.calls.get("loadTree"), 1);
});

test("unavailable environment and invalid saved tabs cannot enter the navigation", async () => {
  const h = harness({ tab: "environment", environmentAccess: false, saved: { tab: "not-a-tab", last: { settings: "not-a-tab" } } });
  h.ui.initializeNavigation(); await h.settle();
  assert.equal(h.state.tab, "overview");
  h.ui.setSection("settings"); await h.settle();
  assert.equal(h.state.tab, "model");
  assert.deepEqual(h.secondary.filter(button => !button.hidden).map(button => button.dataset.tab), ["model", "repository"]);
  h.document.activeElement = h.secondary.find(button => button.dataset.tab === "repository")!;
  h.bar.listeners.get("keydown")!({ key: "ArrowRight", preventDefault() {} }); await h.settle();
  assert.equal(h.state.tab, "model");
  assert.equal(h.document.activeElement?.dataset.tab, "model");
});

test("explicit refresh reloads only the still-selected panel", async () => {
  const h = harness({ tab: "files" }); h.ui.initializeNavigation(); await h.settle();
  await h.ui.refreshCurrentTab("files");
  assert.equal(h.calls.get("loadTree"), 2);
  h.ui.setSection("settings"); await h.settle();
  await h.ui.refreshCurrentTab("files");
  assert.equal(h.calls.get("loadTree"), 2);
  assert.equal(h.calls.get("loadModel"), 1);
});
