import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeploymentController } from "../src/deployment-controller.js";

test("deployment controller atomically requests an update and reports worker state", async () => {
  const root = mkdtempSync(join(tmpdir(), "summate-deployment-"));
  const request = join(root, "deploy", "request.json");
  const state = join(root, "deploy", "state.json");
  const controller = new DeploymentController(request, state);
  try {
    assert.equal(controller.available, true);
    assert.deepEqual(await controller.status(), {
      available: true,
      status: "idle",
      message: "Проверка обновлений ещё не запускалась",
      currentSha: null,
      remoteSha: null,
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
        status: "succeeded",
        message: "Deployment completed",
        currentSha: "a".repeat(40),
        remoteSha: "a".repeat(40),
        startedAt: new Date(Date.parse(result.requestedAt) + 1_000).toISOString(),
        finishedAt: new Date(Date.parse(result.requestedAt) + 2_000).toISOString(),
      }),
    );
    const completed = await controller.status();
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.currentSha, "a".repeat(40));
    assert.equal(completed.message, "Deployment completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment controller is explicitly unavailable without both paths", async () => {
  const controller = new DeploymentController("", "");
  assert.equal(controller.available, false);
  assert.equal((await controller.status()).status, "disabled");
  await assert.rejects(controller.requestUpdate(), /not configured/);
});
