import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MtprotoHistoryScheduler,
  MtprotoSecretVault,
  mtprotoFloodWaitSeconds,
  mtprotoRetryDelaySeconds,
} from "../src/mtproto-connector.js";

test("MTProto vault encrypts API secrets and derives a distinct TDLib key per connector", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-mtproto-vault-"));
  const keyPath = join(root, "mtproto.key");
  writeFileSync(keyPath, "01".repeat(32), { mode: 0o400 });
  try {
    const vault = new MtprotoSecretVault(keyPath);
    const secret = "abcdef0123456789abcdef0123456789";
    const encrypted = vault.encrypt(secret);
    assert.notEqual(encrypted, secret);
    assert.equal(vault.decrypt(encrypted), secret);
    assert.notEqual(vault.databaseKey("connector-a"), vault.databaseKey("connector-b"));
    assert.equal(vault.databaseKey("connector-a"), vault.databaseKey("connector-a"));
    assert.match(vault.databaseKey("connector-a"), /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(Buffer.from(vault.databaseKey("connector-a"), "base64").length, 32);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MTProto flood waits preserve Telegram's exact retry interval with a safety margin", () => {
  assert.equal(mtprotoFloodWaitSeconds(new Error("420 FLOOD_WAIT_54")), 54);
  assert.equal(mtprotoFloodWaitSeconds({ code: 429, message: "Too Many Requests: retry after 17" }), 17);
  assert.equal(mtprotoFloodWaitSeconds({ parameters: { retry_after: 9 } }), 9);
  assert.equal(mtprotoFloodWaitSeconds(new Error("network unavailable")), null);
  assert.equal(mtprotoRetryDelaySeconds(new Error("FLOOD_PREMIUM_WAIT_120")), 123);
  assert.equal(mtprotoRetryDelaySeconds(new Error("network unavailable")), 60);
});

test("MTProto history requests are paced and serialized per connector", async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const scheduler = new MtprotoHistoryScheduler(
    500,
    () => now,
    async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  );
  const events: string[] = [];
  const first = scheduler.run("connector-a", async () => {
    events.push("a1");
    return 1;
  });
  const second = scheduler.run("connector-a", async () => {
    events.push("a2");
    return 2;
  });
  const independent = scheduler.run("connector-b", async () => {
    events.push("b1");
    return 3;
  });

  assert.deepEqual(await Promise.all([first, second, independent]), [1, 2, 3]);
  assert.deepEqual(events, ["a1", "b1", "a2"]);
  assert.deepEqual(sleeps, [500]);
});

test("a failed history request does not poison the connector queue", async () => {
  const scheduler = new MtprotoHistoryScheduler(0);
  const failed = scheduler.run("connector-a", async () => {
    throw new Error("429 FLOOD_WAIT_1");
  });
  const recovered = scheduler.run("connector-a", async () => "ok");
  await assert.rejects(failed, /FLOOD_WAIT_1/);
  assert.equal(await recovered, "ok");
});
