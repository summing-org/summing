import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MtprotoSecretVault } from "../src/mtproto-connector.js";

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
