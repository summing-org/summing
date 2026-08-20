import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunnerReportError, RunnerReportStore } from "../src/runner-report.js";

test("captures and idempotently binds an informational portal report", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-report-"));
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts);
  writeFileSync(join(artifacts, "report.html"), "<html>report</html>");
  writeFileSync(join(artifacts, "report-request.json"), JSON.stringify({
    schemaVersion: 1,
    reportId: "plan-1",
    reportArtifact: "report.html",
    message: "Информационный dry-run готов. Ответьте боту, чтобы задать вопрос.",
  }));
  const store = new RunnerReportStore(root, () => new Date("2026-08-20T08:00:00.000Z"));
  try {
    const captured = store.capture({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "768d307d-1234-4567-89ab-123456789012",
      artifactDirectory: artifacts,
      delivery: { chatId: -100500, topicId: 9 },
    });
    assert.equal(captured?.messageId, null);
    assert.equal(captured?.chatId, -100500);
    const bound = store.bindMessage({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "768d307d-1234-4567-89ab-123456789012",
      chatId: -100500,
      topicId: 9,
      messageId: 245,
    });
    assert.equal(bound.messageId, 245);
    assert.equal(store.capture({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "768d307d-1234-4567-89ab-123456789012",
      artifactDirectory: artifacts,
      delivery: { chatId: -100500, topicId: 9 },
    })?.messageId, 245);
    assert.throws(() => store.bindMessage({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "768d307d-1234-4567-89ab-123456789012",
      chatId: -100501,
      topicId: 9,
      messageId: 246,
    }), RunnerReportError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
