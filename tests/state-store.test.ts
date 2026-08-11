import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.js";

function tempStore(): { root: string; path: string; store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "summate-state-"));
  const path = join(root, "state.sqlite3");
  return { root, path, store: new StateStore(path) };
}

test("binding, input queues, and Telegram offset", () => {
  const { root, store } = tempStore();
  try {
    const conversation = store.bind(-1001, 17, "secret-cloud", "web");
    assert.deepEqual(store.byTopic(-1001, 17), conversation);
    store.setThread(conversation.id, "thr_1");
    store.setActive(conversation.id, "turn_1", 99);
    const steerId = store.enqueueInput(conversation.id, 10, "stop editing", "steer");
    const followId = store.enqueueInput(conversation.id, 11, "also inspect logout", "followup");
    assert.deepEqual(store.pending(conversation.id, "steer").map((item) => item.id), [steerId]);
    assert.deepEqual(store.pending(conversation.id, "followup").map((item) => item.id), [followId]);
    assert.deepEqual(store.counts(), { conversations: 1, active: 1, pending: 2 });
    store.setTelegramOffset(123);
    assert.equal(store.telegramOffset(), 123);
    store.consume([steerId, followId]);
    store.clearActive(conversation.id);
    assert.deepEqual(store.counts(), { conversations: 1, active: 0, pending: 0 });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rebinding starts a fresh Codex context", () => {
  const { root, store } = tempStore();
  try {
    const conversation = store.bind(5, 9, "one", "app");
    store.setThread(conversation.id, "thr_old");
    const rebound = store.bind(5, 9, "two", "backend");
    assert.equal(rebound.projectId, "two");
    assert.equal(rebound.codexThreadId, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart recovers active state and steer", () => {
  const { root, path, store } = tempStore();
  const conversation = store.bind(1, 2, "demo", "app");
  const runId = store.startRun(conversation.id, "work");
  store.attachTurn(runId, "turn-1");
  store.setActive(conversation.id, "turn-1", 9);
  store.enqueueInput(conversation.id, 10, "continue safely", "steer");
  store.close();
  const recovered = new StateStore(path);
  try {
    assert.equal(recovered.counts().active, 0);
    assert.deepEqual(recovered.pending(conversation.id, "steer"), []);
    assert.deepEqual(
      recovered.pending(conversation.id, "followup").map((item) => item.text),
      ["work", "continue safely"],
    );
  } finally {
    recovered.close();
    rmSync(root, { recursive: true, force: true });
  }
});
