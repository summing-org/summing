import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeMasterKey, readMasterKey, SecretVault } from "../src/secret-vault.js";

test("encrypts connection values, versions rotations, leases metadata, and destroys ciphertext on revoke", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-vault-"));
  const path = join(root, "secrets.sqlite3");
  const key = randomBytes(32);
  const vault = new SecretVault(path, key);
  const secret = "sk_live_super_secret_material_1234567890";
  try {
    const first = vault.put({
      projectId: "demo",
      integrationId: "payments",
      environment: "production",
      provider: "stripe",
      auth: "api_key",
      scopes: [],
      createdBy: 42,
      fingerprint: "…7890",
      rawGrant: "once",
    }, { api_key: secret }, 100);
    assert.equal(first.version, 1);
    assert.equal(first.rawGrant, "once");
    assert.equal(vault.get("demo", "payments", "production").credentials.api_key, secret);
    assert.doesNotMatch(readFileSync(path).toString("latin1"), /sk_live_super_secret/);

    const rotated = vault.put({
      projectId: "demo",
      integrationId: "payments",
      environment: "production",
      provider: "stripe",
      auth: "api_key",
      scopes: [],
      createdBy: 42,
      fingerprint: "…next",
      rawGrant: "project",
    }, { api_key: "sk_live_next_secret_material_0987654321" }, 200);
    assert.equal(rotated.id, first.id);
    assert.equal(rotated.version, 2);
    vault.consumeRawGrant(rotated, "00000000-0000-4000-8000-000000000000", 240);
    assert.equal(vault.getSummary("demo", "payments", "production")?.rawGrant, "project");
    const authorizedOnce = vault.authorizeRaw(
      "demo",
      "payments",
      "production",
      42,
      "once",
      245,
    );
    vault.consumeRawGrant(authorizedOnce, "00000000-0000-4000-8000-000000000001", 246);
    assert.equal(vault.getSummary("demo", "payments", "production")?.rawGrant, null);
    assert.throws(
      () => vault.consumeRawGrant(authorizedOnce, "00000000-0000-4000-8000-000000000002", 247),
      /not authorized/,
    );
    vault.markUsed(rotated, "00000000-0000-4000-8000-000000000000", 250);
    assert.equal(vault.getSummary("demo", "payments", "production")?.lastUsedAt, 250);

    const revoked = vault.revoke("demo", "payments", "production", 42, 300);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.version, 3);
    assert.throws(() => vault.get("demo", "payments", "production"), /revoked/);
    vault.consumeTicket("00000000-0000-4000-8000-000000000001", 500, 350);
    assert.throws(
      () => vault.consumeTicket("00000000-0000-4000-8000-000000000001", 500, 351),
      /already used/,
    );
  } finally {
    vault.close();
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("master key parser requires exactly 32 bytes", () => {
  const key = randomBytes(32);
  assert.deepEqual(decodeMasterKey(key.toString("base64url")), key);
  assert.deepEqual(decodeMasterKey(key.toString("hex")), key);
  assert.throws(() => decodeMasterKey("short"), /32 bytes/);
});

test("master key file must not be readable by group or others", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-master-key-"));
  const path = join(root, "master.key");
  const key = randomBytes(32);
  try {
    writeFileSync(path, key.toString("hex"), { mode: 0o600 });
    assert.deepEqual(readMasterKey(path), key);
    chmodSync(path, 0o640);
    assert.throws(() => readMasterKey(path), /private regular file/);
  } finally {
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});
