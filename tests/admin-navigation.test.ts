import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_NAVIGATION_JS } from "../src/admin-navigation-assets.js";

class Element {
  hidden = false;
  tabIndex = 0;
  scrollTop = 0;
  scrollLeft = 0;
  value = "";
  classes = new Set<string>();
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: any) => void>();
  classList = { toggle: (name: string, active: boolean) => active ? this.classes.add(name) : this.classes.delete(name) };
  constructor(public id: string, public dataset: Record<string, string> = {}) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, handler: (event: any) => void) { this.listeners.set(name, handler); }
  focus() {}
}

function harness(input: { section?: string; saved?: string; storageBlocked?: boolean } = {}) {
  const sections = ["projects", "bindings", "knowledge", "system"];
  const panels = sections.map(section => new Element(section + "Panel"));
  const buttons = sections.map(section => new Element(section + "Tab", { adminSection: section }));
  buttons.forEach((button, index) => button.setAttribute("aria-controls", panels[index]!.id));
  const content = new Element("adminContent"), bar = new Element("navigation");
  const state = { section: "projects", overview: null as object | null, deploymentTimer: 1, syncTimer: 2, recoveryTimer: 3, portalTimer: 4 };
  const document = {
    activeElement: null as Element | null,
    querySelectorAll: () => buttons,
    querySelector: () => bar,
  };
  buttons.forEach(button => { button.focus = () => { document.activeElement = button; }; });
  const events = new Map<string, () => void>(), storage = new Map<string, string>();
  if (input.saved) storage.set("summingAdminSection", input.saved);
  const location = { href: "https://admin.example/?source=telegram" + (input.section ? "&section=" + input.section : "") };
  const writes: string[] = [], cleared: number[] = [], errors: string[] = [];
  const history = {
    pushState: (_state: unknown, _title: string, url: string) => { location.href = url; writes.push(url); },
    replaceState: (_state: unknown, _title: string, url: string) => { location.href = url; },
  };
  const calls = new Map<string, number>(), handlers = new Map<string, () => Promise<void>>();
  let overview: Promise<void> | undefined;
  const load = async (name: string) => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    await handlers.get(name)?.();
    if (name === "loadOverview") state.overview = {};
  };
  const loadOverview = () => overview ??= load("loadOverview").finally(() => { overview = undefined; });
  const ui = new Function("state", "$", "document", "window", "sessionStorage", "location", "history", "URL", "toast", "clearTimeout", "loadOverview", "loadPortalDeliveries", "loadSystem", "loadKnowledge",
    ADMIN_NAVIGATION_JS + ";return {activateAdminSection,initializeAdminNavigation,loadAdminSection};")(
    state, (id: string) => id === content.id ? content : panels.find(panel => panel.id === id), document,
    { addEventListener: (name: string, handler: () => void) => events.set(name, handler) },
    {
      getItem: (key: string) => { if (input.storageBlocked) throw new Error("denied"); return storage.get(key); },
      setItem: (key: string, value: string) => { if (input.storageBlocked) throw new Error("denied"); storage.set(key, value); },
    }, location, history, URL, (message: string) => errors.push(message), (timer: number) => cleared.push(timer),
    loadOverview, () => load("loadPortalDeliveries"), () => load("loadSystem"), () => load("loadKnowledge"),
  );
  return { ui, state, panels, buttons, content, bar, document, location, writes, storage, calls, handlers, events, cleared, errors };
}

test("admin sections keep mounted drafts, restore independent scroll positions and stop outgoing polling", async () => {
  const h = harness(); await h.ui.initializeAdminNavigation();
  const originalPanel = h.panels[0]!; originalPanel.value = "unsaved project";
  h.content.scrollTop = 460; h.content.scrollLeft = 12;
  await h.ui.activateAdminSection("knowledge");
  assert.equal(h.content.scrollTop, 0);
  h.content.scrollTop = 980;
  await h.ui.activateAdminSection("projects");
  assert.equal(h.content.scrollTop, 460); assert.equal(h.content.scrollLeft, 12);
  assert.equal(h.panels[0], originalPanel); assert.equal(originalPanel.value, "unsaved project");
  assert.deepEqual(h.panels.map(panel => panel.hidden), [false, true, true, true]);
  assert.deepEqual(h.buttons.map(button => button.tabIndex), [0, -1, -1, -1]);
  await h.ui.activateAdminSection("knowledge");
  assert.equal(h.content.scrollTop, 980);
  assert.equal(h.calls.get("loadOverview"), 1);
  assert.equal(h.calls.get("loadKnowledge"), 2); // Statuses refresh when returning; forms stay mounted.
  assert.deepEqual(h.cleared.slice(0, 4), [1, 2, 3, 4]);
});

test("admin deep links override saved sections and browser Back does not add history", async () => {
  const h = harness({ section: "system", saved: "knowledge" }); await h.ui.initializeAdminNavigation();
  assert.equal(h.state.section, "system"); assert.equal(h.calls.get("loadOverview"), 1);
  assert.equal(h.calls.get("loadSystem"), 1); assert.equal(h.writes.length, 0);
  await h.ui.activateAdminSection("bindings");
  assert.equal(h.storage.get("summingAdminSection"), "bindings");
  assert.equal(new URL(h.location.href).searchParams.get("source"), "telegram");
  h.location.href = "https://admin.example/?section=system";
  h.events.get("popstate")!(); await h.ui.loadAdminSection("system");
  assert.equal(h.state.section, "system"); assert.equal(h.writes.length, 1);
  const remembered = harness({ saved: "knowledge" }); await remembered.ui.initializeAdminNavigation();
  assert.equal(remembered.state.section, "knowledge");
  const denied = harness({ section: "invalid", storageBlocked: true }); await denied.ui.initializeAdminNavigation();
  assert.equal(denied.state.section, "projects");
});

test("rapid admin switches share pending requests and late responses preserve the user's new scroll", async () => {
  const h = harness(); await h.ui.initializeAdminNavigation();
  await h.ui.activateAdminSection("system"); h.content.scrollTop = 700;
  await h.ui.activateAdminSection("projects");
  let release!: () => void;
  h.handlers.set("loadSystem", () => new Promise(resolve => { release = resolve; }));
  const first = h.ui.activateAdminSection("system"); await Promise.resolve();
  assert.equal(h.panels[3]!.getAttribute("aria-busy"), "true");
  await h.ui.activateAdminSection("bindings");
  const second = h.ui.activateAdminSection("system"); await Promise.resolve();
  assert.equal(h.calls.get("loadSystem"), 2);
  h.content.scrollTop = 900;
  release(); await Promise.all([first, second]);
  assert.equal(h.state.section, "system"); assert.equal(h.content.scrollTop, 900);
  assert.equal(h.panels[3]!.getAttribute("aria-busy"), undefined);
});

test("failed admin section loads can be retried and tabs support keyboard navigation", async () => {
  const h = harness({ section: "knowledge" });
  h.handlers.set("loadKnowledge", async () => { throw new Error("offline"); });
  await h.ui.initializeAdminNavigation();
  assert.deepEqual(h.errors, ["offline"]); assert.equal(h.state.section, "knowledge");
  h.handlers.delete("loadKnowledge"); await h.ui.activateAdminSection("knowledge");
  assert.equal(h.calls.get("loadKnowledge"), 2);
  h.document.activeElement = h.buttons[2]!;
  h.bar.listeners.get("keydown")!({ key: "End", preventDefault() {} }); await h.ui.loadAdminSection("system");
  assert.equal(h.document.activeElement, h.buttons[3]); assert.equal(h.state.section, "system");
  h.bar.listeners.get("keydown")!({ key: "ArrowRight", preventDefault() {} }); await h.ui.loadAdminSection("projects");
  assert.equal(h.document.activeElement, h.buttons[0]); assert.equal(h.state.section, "projects");
});

test("failed initial authorization never starts section-specific requests", async () => {
  const h = harness({ section: "system" });
  h.handlers.set("loadOverview", async () => { throw new Error("unauthorized"); });
  await assert.rejects(h.ui.initializeAdminNavigation(), /unauthorized/);
  assert.equal(h.calls.get("loadOverview"), 1);
  assert.equal(h.calls.get("loadSystem"), undefined);
});
