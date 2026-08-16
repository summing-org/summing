import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeploymentController } from "../src/deployment-controller.js";

test("deployment controller atomically requests an update and reports worker state", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-deployment-"));
  const request = join(root, "deploy", "request.json");
  const state = join(root, "deploy", "state.json");
  const controller = new DeploymentController(request, state);
  try {
    assert.equal(controller.available, true);
    assert.deepEqual(await controller.status(), {
      available: true,
      status: "idle",
      phase: null,
      message: "Проверка обновлений ещё не запускалась",
      currentSha: null,
      remoteSha: null,
      attemptId: null,
      failure: null,
      history: [],
      requestedAt: null,
      startedAt: null,
      finishedAt: null,
    });

    const result = await controller.requestUpdate();
    assert.equal(JSON.parse(readFileSync(request, "utf8")).requestedAt, result.requestedAt);
    assert.equal((await controller.status()).status, "requested");

    writeFileSync(
      state,
      JSON.stringify({
        attemptId: "deploy-1",
        status: "succeeded",
        phase: "complete",
        message: "Deployment completed",
        currentSha: "a".repeat(40),
        remoteSha: "a".repeat(40),
        startedAt: new Date(Date.parse(result.requestedAt) + 1_000).toISOString(),
        finishedAt: new Date(Date.parse(result.requestedAt) + 2_000).toISOString(),
      }),
    );
    const completed = await controller.status();
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.phase, "complete");
    assert.equal(completed.attemptId, "deploy-1");
    assert.equal(completed.currentSha, "a".repeat(40));
    assert.equal(completed.message, "Deployment completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment controller exposes bounded structured failures and attempt history", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-deployment-history-"));
  const request = join(root, "deploy", "request.json");
  const state = join(root, "deploy", "state.json");
  const history = join(root, "deploy", "history.json");
  const controller = new DeploymentController(request, state);
  const failed = {
    attemptId: "attempt-failed",
    status: "failed",
    phase: "test",
    message: "Тесты не пройдены: 3 из 118",
    currentSha: "a".repeat(40),
    remoteSha: "b".repeat(40),
    startedAt: "2026-08-16T01:00:00Z",
    finishedAt: "2026-08-16T01:01:00Z",
    failure: {
      kind: "tests",
      phase: "test",
      exitCode: 1,
      logTail: "assertion failed\n".repeat(1_000),
      tests: {
        total: 118,
        passed: 115,
        failed: 3,
        failedTests: [
          "the bot profile always preserves the complete SUMMING version",
          ...Array.from({ length: 25 }, (_, index) => `failure ${index}`),
        ],
      },
    },
  };
  try {
    mkdirSync(join(root, "deploy"));
    writeFileSync(state, JSON.stringify(failed));
    writeFileSync(history, JSON.stringify([failed, { status: "failed" }]));
    const result = await controller.status();
    assert.equal(result.failure?.kind, "tests");
    assert.equal(result.failure?.tests?.failed, 3);
    assert.equal(result.failure?.tests?.failedTests.length, 20);
    assert.equal(result.failure?.logTail.length, 12_000);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0]?.attemptId, "attempt-failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment controller is explicitly unavailable without both paths", async () => {
  const controller = new DeploymentController("", "");
  assert.equal(controller.available, false);
  const status = await controller.status();
  assert.equal(status.status, "disabled");
  assert.deepEqual(status.history, []);
  await assert.rejects(controller.requestUpdate(), /not configured/);
});
