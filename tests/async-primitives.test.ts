import assert from "node:assert/strict";
import test from "node:test";
import { KeyedMutex } from "../src/async-primitives.js";

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
