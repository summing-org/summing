import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  environmentRedactions,
  parseProjectEnvironment,
  ProjectEnvironmentConflictError,
  ProjectEnvironmentError,
  ProjectEnvironmentStore,
  readEnvironmentKey,
  runtimeEnvironmentText,
} from "../src/project-environment.js";

test("dotenv parser preserves plain text while rejecting duplicate and runner-owned variables", () => {
  const parsed = parseProjectEnvironment(
    "# app\r\nexport API_URL=https://example.test?a=b\r\nTOKEN=\"secret-value-123456\"\r\n",
  );
  assert.equal(
    parsed.normalized,
    "# app\nexport API_URL=https://example.test?a=b\nTOKEN=\"secret-value-123456\"\n",
  );
  assert.equal(parsed.values.get("TOKEN"), "secret-value-123456");
  assert.equal(
    runtimeEnvironmentText(parsed.values),
    "API_URL=https://example.test?a=b\nTOKEN=secret-value-123456\n",
  );
  assert.deepEqual(environmentRedactions(parsed.values), [
    "https://example.test?a=b",
    "secret-value-123456",
  ]);
  assert.throws(() => parseProjectEnvironment("TOKEN=one\nTOKEN=two\n"), /duplicated/);
  assert.throws(() => parseProjectEnvironment("SUMMING_JOB_ID=mine\n"), /reserved/);
  assert.throws(() => parseProjectEnvironment("PATH=/tmp\n"), /reserved/);
  assert.throws(() => parseProjectEnvironment("not-an-assignment\n"), /NAME=value/);
  assert.throws(() => parseProjectEnvironment('TOKEN="line\\nnext"\n'), /multiline value/);
});

test("environment store encrypts revisions, authenticates scope, and detects stale writes", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-environment-store-"));
  try {
    const store = new ProjectEnvironmentStore(root, Buffer.alloc(32, 9));
    assert.deepEqual(store.get("demo", "web"), { text: "", revision: 0, updatedAt: null });
    const saved = store.save("demo", "web", "API_TOKEN=value-123456789\n", 0);
    assert.equal(saved.revision, 1);
    assert.equal(store.get("demo", "web").text, "API_TOKEN=value-123456789\n");
    assert.throws(
      () => store.save("demo", "web", "API_TOKEN=stale\n", 0),
      ProjectEnvironmentConflictError,
    );
    const envelope = readFileSync(join(root, "demo--web.json"), "utf8");
    assert.doesNotMatch(envelope, /value-123456789/);
    const wrongKey = new ProjectEnvironmentStore(root, Buffer.alloc(32, 8));
    assert.throws(() => wrongKey.get("demo", "web"), /authentication failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment key must be private and exactly 32 bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-environment-key-"));
  const path = join(root, "environment.key");
  try {
    writeFileSync(path, `${Buffer.alloc(32, 5).toString("hex")}\n`, { mode: 0o600 });
    assert.deepEqual(readEnvironmentKey(path), Buffer.alloc(32, 5));
    chmodSync(path, 0o644);
    assert.throws(() => readEnvironmentKey(path), ProjectEnvironmentError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
