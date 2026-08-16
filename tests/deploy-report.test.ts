import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const report = join(root, "deploy", "summing-deploy-report");

test("deployment report extracts bounded TAP failures without ANSI control sequences", () => {
  const directory = mkdtempSync(join(tmpdir(), "summing-deploy-report-"));
  const log = join(directory, "test.log");
  try {
    writeFileSync(log, [
      "TAP version 13",
      "not ok 8 - bot profile preserves the version",
      "not ok 13 - weekly limits preserve the version",
      "\u001b[31massertion failed\u001b[0m",
      ...Array.from({ length: 80 }, (_, index) => `diagnostic ${index} ${"x".repeat(500)}`),
      "# tests 118",
      "# pass 115",
      "# fail 3",
    ].join("\n"));
    const result = spawnSync(report, ["tests", "test", "1", log], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const failure = JSON.parse(result.stdout) as {
      kind: string;
      phase: string;
      exitCode: number;
      logTail: string;
      tests: { total: number; passed: number; failed: number; failedTests: string[] };
    };
    assert.equal(failure.kind, "tests");
    assert.equal(failure.phase, "test");
    assert.equal(failure.exitCode, 1);
    assert.deepEqual(failure.tests, {
      total: 118,
      passed: 115,
      failed: 3,
      failedTests: [
        "bot profile preserves the version",
        "weekly limits preserve the version",
      ],
    });
    assert.ok(failure.logTail.length <= 12_000);
    assert.doesNotMatch(failure.logTail, /\u001b/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment report is executable and omits test fields for non-test phases", () => {
  const directory = mkdtempSync(join(tmpdir(), "summing-deploy-report-lint-"));
  const log = join(directory, "lint.log");
  try {
    assert.notEqual(statSync(report).mode & 0o111, 0);
    writeFileSync(log, "TypeScript error\n");
    const result = spawnSync(report, ["lint", "lint", "2", log], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const failure = JSON.parse(result.stdout) as { tests: unknown; logTail: string };
    assert.equal(failure.tests, null);
    assert.equal(failure.logTail, "TypeScript error");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
