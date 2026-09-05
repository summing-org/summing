import assert from "node:assert/strict";
import test from "node:test";
import { KeyedMutex, Semaphore } from "../src/async-primitives.js";

test("cancelled mutex waiters release their queue position without releasing a live holder", async () => {
  const mutex = new KeyedMutex();
  const held = await mutex.acquire("a");
  const controller = new AbortController();
  const cancelled = mutex.acquire("a", controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(cancelled, /cancelled/);
  let acquired = false;
  const next = mutex.acquire("a").then((release) => { acquired = true; return release; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquired, false);
  held(); held();
  (await next)();
  (await mutex.acquire("a"))();
});

test("abort before semaphore action does not leak a permit", async () => {
  const semaphore = new Semaphore(1);
  const controller = new AbortController();
  let called = false;
  const task = semaphore.run(async () => { called = true; }, controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(task, /cancelled/);
  assert.equal(called, false);
  await semaphore.run(async () => { called = true; });
  assert.equal(called, true);
});

test("keyed mutex serializes the same workspace without blocking another key", async () => {
  const mutex = new KeyedMutex();
  const releaseFirst = await mutex.acquire("workspace-a");
  let secondAcquired = false;
  const second = mutex.acquire("workspace-a").then((release) => {
    secondAcquired = true;
    return release;
  });

  const releaseOther = await mutex.acquire("workspace-b");
  assert.equal(secondAcquired, false);
  releaseOther();

  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  releaseSecond();
});
