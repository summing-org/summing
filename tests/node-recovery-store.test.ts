import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeRecoveryStore } from "../src/node-recovery-store.js";

test("node recovery queue survives restart and requires explicit restore confirmation", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-node-recovery-store-"));
  const path = join(root, "jobs.sqlite3");
  let store = new NodeRecoveryStore(path);
  try {
    store.create({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "restore",
      bundleKey: "summing/node-recovery/manifest.json",
      request: { wrappedRecoveryKey: "wrapped", confirmed: false },
    });
    const claimed = store.claimNext();
    assert.equal(claimed?.state, "running");
    store.close();

    store = new NodeRecoveryStore(path);
    assert.equal(store.get(claimed!.id)?.state, "queued");
    assert.equal(store.claimNext()?.attempts, 2);
    store.awaitConfirmation(claimed!.id, { ready: true }, "bundle/manifest.json");
    assert.throws(() => store.succeed(claimed!.id, {}));
    const confirmed = store.confirmRestore(claimed!.id);
    assert.equal(confirmed.state, "queued");
    assert.equal(confirmed.request.confirmed, true);
    assert.equal(store.claimNext()?.state, "running");
    store.succeed(claimed!.id, { stagePath: "/stage" });
    assert.equal(store.get(claimed!.id)?.state, "succeeded");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
