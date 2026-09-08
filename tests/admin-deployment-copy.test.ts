import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from "../src/admin-assets.js";

// Exercise the shipped UI functions, including actual button handlers, without
// a network, clipboard permission prompt or a production Telegram WebView.
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  className = "";
  textContent = "";
  value = "";
  type = "";
  disabled = false;
  readOnly = false;
  spellcheck = false;
  rows = 0;
  focused = false;
  selection: [number, number] | null = null;
  onclick: (() => unknown) | null = null;
  attributes = new Map<string, string>();
  constructor(readonly tag = "div") {}
  classList = {
    contains: (name: string) => this.className.split(" ").includes(name),
    toggle: (name: string, enabled: boolean) => {
      const classes = new Set(this.className.split(" ").filter(Boolean));
      if (enabled) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(" ");
    },
  };
  append(...items: Element[]) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items: Element[]) { for (const child of this.children) child.parent = null; this.children = []; this.append(...items); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, callback: () => unknown) { assert.equal(name, "click"); this.onclick = callback; }
  focus() { this.focused = true; }
  select() { this.selection = [0, this.value.length]; }
  setSelectionRange(start: number, end: number) { this.selection = [start, end]; }
  after(item: Element) { assert.ok(this.parent); item.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, item); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  get nextElementSibling(): Element | null { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
}

const failure = {
  kind: "tests", phase: "test", exitCode: 1,
  tests: { failed: 1, passed: 294, total: 295, failedTests: ["scope test"] },
  logTail: "  fatal: not a git repository\n    at scope\n<script>untrusted()</script>\n" + "д".repeat(12_000),
};
const attempt = { remoteSha: "50bfdd8".padEnd(40, "0"), status: "failed", phase: "test", finishedAt: "2026-09-05T13:21:10Z", message: "tests failed", failure };

function fixture(clipboard?: { writeText(text: string): Promise<void> }, legacy = false) {
  const elements = new Map<string, Element>();
  const $ = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const body = new Element("body");
  $("deploymentFailure").append($("copyDeploymentLog"));
  const notices: string[] = [], copied: string[] = [];
  let legacyCalls = 0;
  const document = {
    body, activeElement: new Element("button"), createElement: (tag: string) => new Element(tag),
    execCommand: (command: string) => {
      assert.equal(command, "copy"); legacyCalls++;
      const field = body.children[0]!;
      assert.equal(field.tag, "textarea");
      assert.deepEqual(field.selection, [0, field.value.length]);
      if (legacy) copied.push(field.value);
      return legacy;
    },
  };
  const start = ADMIN_JS.indexOf("  const deploymentLabels=");
  const end = ADMIN_JS.indexOf("  async function loadDeployment()");
  assert.ok(start >= 0 && end > start);
  const ui = new Function("$", "document", "navigator", "toast", "deploymentTime", ADMIN_JS.slice(start, end) + ";return {deploymentDiagnostic,copyDiagnostic,renderDeploymentFailure,renderDeploymentHistory};")(
    $, document, clipboard ? { clipboard } : {}, (message: string) => notices.push(message), (value: string) => value,
  ) as {
    deploymentDiagnostic(value: unknown): string;
    copyDiagnostic(text: string, button: Element): Promise<void>;
    renderDeploymentFailure(failure: unknown, value?: unknown): void;
    renderDeploymentHistory(value: unknown): void;
  };
  return { $, ui, document, notices, copied, legacyCalls: () => legacyCalls };
}

test("deployment errors expose copy controls and selectable logs", () => {
  assert.doesNotThrow(() => new Function(ADMIN_JS));
  assert.match(ADMIN_HTML, /id="copyDeploymentLog"[^>]+>Скопировать лог/);
  assert.match(ADMIN_CSS, /-webkit-user-select:text;user-select:text/);
  const { ui } = fixture();
  const text = ui.deploymentDiagnostic(attempt);
  assert.ok(text.includes(attempt.remoteSha));
  assert.match(text, /Этап: тесты\nВремя: 2026-09-05T13:21:10Z\nExit: 1/);
  assert.match(text, /1 упало из 295/);
  assert.ok(text.endsWith(failure.logTail), "copy retains the entire available tail and its whitespace");
  assert.equal(ui.deploymentDiagnostic({}), "");
});

test("current and historical copy buttons use only their own immutable diagnostic", async () => {
  const copies: string[] = [];
  const f = fixture({ writeText: async (text) => { copies.push(text); } });
  f.ui.renderDeploymentFailure(failure, attempt);
  assert.deepEqual(copies, [], "rendering never writes to the clipboard");
  await f.$("copyDeploymentLog").onclick!();
  assert.equal(copies[0], f.ui.deploymentDiagnostic(attempt));
  assert.equal(f.legacyCalls(), 0);
  assert.equal(f.notices.at(-1), "Лог скопирован");
  const older = { ...attempt, remoteSha: "old", failure: { ...failure, logTail: "old log" } };
  f.ui.renderDeploymentHistory([attempt, older, { ...attempt, failure: null, status: "succeeded" }]);
  const cards = f.$("deploymentHistory").children;
  const copy = (card: Element) => card.children.find((child) => child.tag === "button");
  await copy(cards[1]!)!.onclick!();
  await copy(cards[0]!)!.onclick!();
  assert.equal(copies[1], f.ui.deploymentDiagnostic(older));
  assert.equal(copies[2], f.ui.deploymentDiagnostic(attempt));
  assert.equal(copy(cards[2]!), undefined);
  f.ui.renderDeploymentFailure(null);
  assert.equal(f.$("copyDeploymentLog").onclick, null);
  assert.equal(f.$("copyDeploymentLog").disabled, true);
});

test("clipboard rejection falls back to selected text and cleans temporary buffers", async () => {
  const f = fixture({ writeText: async () => { throw new Error("denied"); } }, true);
  const button = f.$("copyDeploymentLog");
  await f.ui.copyDiagnostic(failure.logTail, button);
  assert.deepEqual(f.copied, [failure.logTail]);
  assert.equal(f.legacyCalls(), 1);
  assert.equal(f.document.body.children.length, 0);
  assert.equal(f.document.activeElement.focused, true);
  assert.equal(button.disabled, false);
  assert.equal(f.notices.at(-1), "Лог скопирован");
});

test("unavailable clipboard leaves a readable, selectable fallback and never claims success", async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    if (throws) f.document.execCommand = () => { throw new Error("unsupported"); };
    const button = f.$("copyDeploymentLog");
    await f.ui.copyDiagnostic(failure.logTail, button);
    const panel = button.nextElementSibling!;
    const field = panel.children.find((item) => item.tag === "textarea")!;
    assert.equal(field.value, failure.logTail);
    assert.equal(field.readOnly, true);
    assert.deepEqual(field.selection, [0, failure.logTail.length]);
    assert.ok(field.attributes.get("aria-label"));
    field.selection = null;
    await panel.children.find((item) => item.tag === "button")!.onclick!();
    assert.deepEqual(field.selection, [0, failure.logTail.length]);
    assert.equal(f.document.body.children.length, 0);
    assert.ok(!f.notices.includes("Лог скопирован"));
    await f.ui.copyDiagnostic("next log", button);
    assert.equal(button.parent!.children.length, 2, "retry replaces, not duplicates, the manual field");
    assert.equal(button.nextElementSibling!.children.at(-1)!.value, "next log");
  }
});

test("copy avoids duplicate writes while permission is pending and ignores empty content", async () => {
  let release!: () => void, calls = 0;
  const f = fixture({ writeText: () => { calls++; return new Promise<void>((resolve) => { release = resolve; }); } });
  const button = f.$("copyDeploymentLog");
  await f.ui.copyDiagnostic("", button);
  assert.equal(calls, 0);
  const pending = f.ui.copyDiagnostic("log", button);
  assert.equal(calls, 1, "writeText is invoked synchronously in the click handler");
  assert.equal(button.disabled, true);
  await f.ui.copyDiagnostic("log", button);
  assert.equal(calls, 1);
  release(); await pending;
  assert.equal(button.disabled, false);
});

test("a superseded clipboard rejection cannot overwrite a newer diagnostic via fallback", async () => {
  let rejectOld!: (error: Error) => void;
  const copies: string[] = [];
  const f = fixture({ writeText: (text) => {
    if (text === "old") return new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    copies.push(text); return Promise.resolve();
  } }, true);
  const oldButton = f.$("copyDeploymentLog"), newButton = new Element("button");
  const pending = f.ui.copyDiagnostic("old", oldButton);
  await f.ui.copyDiagnostic("new", newButton);
  rejectOld(new Error("replaced by the next write")); await pending;
  assert.deepEqual(copies, ["new"]);
  assert.equal(f.legacyCalls(), 0);
  assert.deepEqual(f.notices, ["Лог скопирован"]);
  assert.equal(oldButton.disabled, false);
  assert.equal(newButton.disabled, false);
});
