import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  IntegrationManifestError,
  integrationRuntimePrefix,
  loadIntegrationManifest,
  parseIntegrationManifest,
} from "../src/integration-manifest.js";

const manifest = {
  version: 1,
  integrations: [{
    id: "transactional-email",
    provider: "resend",
    environment: "production",
    auth: "api_key",
    mode: "gateway",
    capabilities: ["email.send"],
    scopes: [],
    actions: ["dry-run", "run"],
    secrets: [{ name: "api_key" }],
    gateway: { methods: ["POST"], pathPrefixes: ["/emails"] },
  }],
};

test("parses a strict, credential-free integration contract", () => {
  const parsed = parseIntegrationManifest(manifest);
  assert.equal(parsed.integrations[0]?.id, "transactional-email");
  assert.equal(parsed.integrations[0]?.gateway?.methods[0], "POST");
  assert.equal(
    integrationRuntimePrefix(parsed.integrations[0]!),
    "SUMMING_TRANSACTIONAL_EMAIL_PRODUCTION",
  );
  assert.doesNotMatch(JSON.stringify(parsed), /replace-me|secret-value/);
});

test("supports explicit raw runtime mappings while rejecting unsafe mode contracts", () => {
  const raw = parseIntegrationManifest({
    version: 1,
    integrations: [{
      ...manifest.integrations[0],
      mode: "raw",
      runtime: [{ name: "api_key", env: "RESEND_API_KEY" }],
      gateway: undefined,
    }],
  });
  assert.equal(raw.integrations[0]?.mode, "raw");
  assert.equal(raw.integrations[0]?.runtime[0]?.env, "RESEND_API_KEY");
  assert.throws(
    () => parseIntegrationManifest({
      ...manifest,
      integrations: [{ ...manifest.integrations[0], gateway: { methods: ["POST"], pathPrefixes: ["/../admin"] } }],
    }),
    IntegrationManifestError,
  );
  assert.throws(
    () => parseIntegrationManifest({
      ...manifest,
      integrations: [{
        ...manifest.integrations[0],
        mode: "raw",
        runtime: [{ name: "api_key", env: "SUMMING_JOB_ID" }],
        gateway: undefined,
      }],
    }),
    /reserved by the runtime/,
  );
  assert.throws(
    () => parseIntegrationManifest({
      version: 1,
      integrations: [
        manifest.integrations[0],
        { ...manifest.integrations[0], id: "transactional_email" },
      ],
    }),
    /runtime variable prefixes/,
  );
});

test("loads only a bounded regular manifest file", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-integrations-"));
  try {
    assert.deepEqual(loadIntegrationManifest(root), { version: 1, integrations: [] });
    mkdirSync(join(root, ".summing"));
    writeFileSync(join(root, ".summing", "integrations.json"), JSON.stringify(manifest));
    assert.equal(loadIntegrationManifest(root).integrations.length, 1);
    rmSync(join(root, ".summing", "integrations.json"));
    writeFileSync(join(root, "outside.json"), JSON.stringify(manifest));
    symlinkSync(join(root, "outside.json"), join(root, ".summing", "integrations.json"));
    assert.throws(() => loadIntegrationManifest(root), /regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
