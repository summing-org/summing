import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectSecretData,
  detectSecretFile,
  detectSecretText,
} from "../src/secret-ingress.js";

test("detects known credentials and high-confidence assignments without retaining values", () => {
  const detections = detectSecretText([
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "password: CorrectHorseBatteryStaple-2026",
  ].join("\n"));
  assert.deepEqual(detections.map((item) => item.kind), ["credential-assignment", "openai-key"]);
  assert.doesNotMatch(JSON.stringify(detections), /CorrectHorse|sk-proj/);
  assert.deepEqual(detectSecretText("API_KEY=replace-me"), []);
  assert.deepEqual(detectSecretText("Use process.env.API_KEY in this example"), []);
});

test("scans bounded text attachments but ignores binary files", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-secret-scan-"));
  try {
    const env = join(root, ".env");
    writeFileSync(env, "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890\n");
    assert.ok(detectSecretFile(env, ".env", "text/plain").length > 0);
    assert.ok(
      detectSecretData(
        new TextEncoder().encode("ACCESS_TOKEN=customer-secret-1234567890\n"),
        "notes.txt",
        "text/plain",
      ).length > 0,
    );
    const binary = join(root, "image.bin");
    writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
    assert.deepEqual(detectSecretFile(binary, "image.bin", "application/octet-stream"), []);
    const oversized = join(root, "large.txt");
    writeFileSync(oversized, "x".repeat(1_001));
    assert.deepEqual(
      detectSecretFile(oversized, "large.txt", "text/plain", 1_000),
      [{ kind: "unscanned-large-text" }],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
