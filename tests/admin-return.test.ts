import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_RETURN_STATE_JS, VIEWER_ADMIN_RETURN_JS } from "../src/admin-return-assets.js";

function viewer(input: { from?: string; native?: boolean; dirty?: boolean } = {}) {
  const listeners = new Map<string, (event?: any) => void>(), windowEvents = new Map<string, () => void>();
  const handlers = new Set<() => void>();
  const link = { hidden: true, addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler) };
  const destinations: string[] = [];
  const location = { href: "https://summing.example/?conversation=topic&tab=model" + (input.from ? "&from=" + input.from : ""), assign: (url: string) => destinations.push(url) };
  const back = { visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, onClick: (handler: () => void) => handlers.add(handler), offClick: (handler: () => void) => handlers.delete(handler) };
  let consent = false, prompts = 0;
  new Function("$", "window", "location", "URL", "tg", "hasUnsavedSettings", "confirm", VIEWER_ADMIN_RETURN_JS)(
    (id: string) => id === "adminBack" ? link : {},
    { addEventListener: (name: string, handler: () => void) => windowEvents.set(name, handler) },
    location, URL, input.native === false ? null : { BackButton: back }, () => input.dirty,
    () => { prompts++; return consent; },
  );
  return { link, back, handlers, windowEvents, destinations, listeners, get prompts() { return prompts; }, accept: () => { consent = true; } };
}

test("return from an admin-opened project ignores internal tab history and supports native Back lifecycle", () => {
  const h = viewer({ from: "admin" });
  assert.equal(h.link.hidden, false); assert.equal(h.back.visible, true); assert.equal(h.handlers.size, 1);
  h.windowEvents.get("pageshow")!(); h.windowEvents.get("pageshow")!(); assert.equal(h.handlers.size, 1);
  [...h.handlers][0]!();
  assert.deepEqual(h.destinations, ["/admin?section=bindings&restore=1"]);
  h.windowEvents.get("pagehide")!(); assert.equal(h.back.visible, false); assert.equal(h.handlers.size, 0);
  h.windowEvents.get("pageshow")!(); assert.equal(h.back.visible, true); assert.equal(h.handlers.size, 1);
  const regular = viewer(); assert.equal(regular.link.hidden, true); assert.equal(regular.back.visible, false); assert.equal(regular.handlers.size, 0);
  const invalid = viewer({ from: "https://outside.example" }); assert.equal(invalid.link.hidden, true);
});

test("admin return honors unsaved-settings confirmation and works without the Telegram SDK", () => {
  const h = viewer({ from: "admin", native: false, dirty: true });
  let prevented = false;
  h.listeners.get("click")!({ button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.prompts, 1); assert.equal(h.destinations.length, 0);
  h.accept(); h.listeners.get("click")!({ button: 0, preventDefault() {} });
  assert.deepEqual(h.destinations, ["/admin?section=bindings&restore=1"]);
  h.listeners.get("click")!({ button: 0, ctrlKey: true, preventDefault() { throw new Error("must preserve opening in a new tab"); } });
  assert.equal(h.prompts, 2);
});

function admin(input: { snapshot?: string; restore?: boolean; blocked?: boolean } = {}) {
  const search = { value: "" }, content = { scrollTop: 0, scrollLeft: 0 }, positions = new Map<string, unknown>();
  const storage = new Map<string, string>(), listeners = new Map<string, (event: any) => void>();
  if (input.snapshot) storage.set("summingAdminReturn", input.snapshot);
  const location = { href: "https://summing.example/admin?section=bindings" + (input.restore ? "&restore=1" : "") };
  let hidden = 0;
  new Function("$", "document", "window", "location", "history", "URL", "tg", "sessionStorage", "adminNavigation", ADMIN_RETURN_STATE_JS)(
    (id: string) => id === "topicSearch" ? search : content,
    { addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler) },
    { addEventListener() {} }, location, { replaceState: (_state: unknown, _title: string, url: string) => { location.href = url; } }, URL,
    { BackButton: { hide() { hidden++; } } },
    { getItem: (key: string) => { if (input.blocked) throw new Error("blocked"); return storage.get(key); }, setItem: (key: string, value: string) => { if (input.blocked) throw new Error("blocked"); storage.set(key, value); } },
    { positions },
  );
  return { search, content, positions, storage, listeners, location, hidden };
}

test("return to admin restores the topic filter and scroll only on an explicit return", () => {
  const snapshot = JSON.stringify({ search: "Разработка", top: 530, left: 12 });
  const h = admin({ snapshot, restore: true });
  assert.equal(h.search.value, "Разработка"); assert.deepEqual(h.positions.get("bindings"), { top: 530, left: 12 });
  assert.equal(new URL(h.location.href).searchParams.has("restore"), false); assert.equal(h.hidden, 1);
  const fresh = admin({ snapshot }); assert.equal(fresh.search.value, ""); assert.equal(fresh.positions.size, 0);
  h.search.value = "Отчёты"; h.content.scrollTop = 200; h.content.scrollLeft = 0;
  h.listeners.get("click")!({ target: { closest: () => ({}) } });
  assert.deepEqual(JSON.parse(h.storage.get("summingAdminReturn")!), { search: "Отчёты", top: 200, left: 0 });
});

test("blocked or malformed return storage leaves admin navigation usable", () => {
  for (const snapshot of ["invalid", JSON.stringify({ search: "x", top: -1, left: 0 }), JSON.stringify({ search: "x", top: "300", left: 0 })]) {
    const h = admin({ snapshot, restore: true }); assert.equal(h.positions.size, 0); assert.equal(h.search.value, "");
  }
  const h = admin({ blocked: true, restore: true });
  assert.equal(h.positions.size, 0);
  assert.doesNotThrow(() => h.listeners.get("click")!({ target: { closest: () => ({}) } }));
});
