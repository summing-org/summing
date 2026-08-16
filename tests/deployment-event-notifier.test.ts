import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeploymentEventNotifier } from "../src/deployment-event-notifier.js";

function event(
  kind: "update_succeeded" | "update_failed",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: "20260816T120000000Z-42",
    kind,
    message: "Тесты не пройдены: 2 из 120",
    previousVersion: "9.8.1",
    targetVersion: "9.8.2",
    previousSha: "a".repeat(40),
    targetSha: "b".repeat(40),
    failure: null,
    createdAt: "2026-08-16T12:00:00.000Z",
    ...overrides,
  };
}

test("deployment events notify the administrator and leave no delivered outbox file", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-deployment-events-"));
  const events = join(root, "events");
  const successPath = join(events, "01-update_succeeded.json");
  const failurePath = join(events, "02-update_failed.json");
  const messages: string[] = [];
  try {
    mkdirSync(events);
    writeFileSync(successPath, JSON.stringify(event("update_succeeded")));
    writeFileSync(failurePath, JSON.stringify(event("update_failed", {
      eventId: "20260816T120100000Z-43",
      failure: {
        kind: "tests",
        phase: "test",
        exitCode: 1,
        logTail: "TOKEN=must-not-reach-telegram",
        tests: {
          total: 120,
          passed: 118,
          failed: 2,
          failedTests: ["builds the release", "keeps the deployment atomic"],
        },
      },
    })));
    const notifier = new DeploymentEventNotifier(events, async (message) => {
      messages.push(message);
    });

    await notifier.check();

    assert.equal(messages.length, 2);
    assert.match(messages[0] ?? "", /✅ SUMMING обновлён до 9\.8\.2/);
    assert.match(messages[0] ?? "", /Версия: 9\.8\.1 → 9\.8\.2/);
    assert.match(messages[0] ?? "", /Commit: b{12}/);
    assert.match(messages[1] ?? "", /❌ Обновление SUMMING не установлено/);
    assert.match(messages[1] ?? "", /Тесты: 2 из 120 не пройдено/);
    assert.match(messages[1] ?? "", /• builds the release/);
    assert.doesNotMatch(messages[1] ?? "", /must-not-reach-telegram/);
    assert.equal(existsSync(successPath), false);
    assert.equal(existsSync(failurePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed Telegram delivery keeps the event for the next check", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-deployment-event-retry-"));
  const events = join(root, "events");
  const path = join(events, "retry-update_failed.json");
  let attempts = 0;
  try {
    mkdirSync(events);
    writeFileSync(path, JSON.stringify(event("update_failed", {
      failure: { kind: "lint", phase: "lint", tests: null },
    })));
    const notifier = new DeploymentEventNotifier(events, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Telegram is temporarily unavailable");
    });

    await notifier.check();
    assert.equal(attempts, 1);
    assert.equal(existsSync(path), true);

    await notifier.check();
    assert.equal(attempts, 2);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the newly started release observes its own deployment completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-deployment-state-event-"));
  const statePath = join(root, "state.json");
  const messages: string[] = [];
  const notifier = new DeploymentEventNotifier(
    join(root, "events"),
    async (message) => {
      messages.push(message);
    },
    5_000,
    statePath,
    "9.8.2",
  );
  try {
    writeFileSync(statePath, JSON.stringify({
      attemptId: "bootstrap-attempt",
      status: "deploying",
      phase: "health",
      message: "Проверяем health",
      remoteSha: "c".repeat(40),
    }));
    await notifier.check();
    assert.deepEqual(messages, []);

    writeFileSync(statePath, JSON.stringify({
      attemptId: "bootstrap-attempt",
      status: "succeeded",
      phase: "complete",
      message: "Обновление установлено",
      remoteSha: "c".repeat(40),
    }));
    await notifier.check();
    await notifier.check();

    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", /✅ SUMMING обновлён до 9\.8\.2/);
    assert.match(messages[0] ?? "", /Commit: c{12}/);
  } finally {
    await notifier.close();
    rmSync(root, { recursive: true, force: true });
  }
});
