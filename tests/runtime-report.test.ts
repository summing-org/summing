import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import type { RunnerJob, RunnerReport } from "../src/project-runner-client.js";
import { SummingRuntime } from "../src/runtime.js";

test("dry-run report is delivered only to the matching external read-only portal", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-report-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  const workspace: WorkspaceConfig = { id: "repo", path: repository };
  const project = new ProjectConfig("demo", "Demo", "repo", new Map([["repo", workspace]]));
  const runtime = new SummingRuntime(new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "telegram-token",
    1,
    "codex",
    8765,
    2,
    1,
    "",
    "medium",
    true,
    new Map([["demo", project]]),
  ));
  const internal = runtime.state.bind(1, 0, "demo", "repo");
  runtime.state.bind(-100500, 9, "demo", "repo", "external-readonly");
  const job: RunnerJob = {
    id: "768d307d-1234-4567-89ab-123456789012",
    projectId: "demo",
    workspaceId: "repo",
    action: "dry-run",
    revision: "a".repeat(40),
    status: "completed",
    reportAvailable: true,
    createdAt: "2026-08-20T08:00:00.000Z",
  };
  let report: RunnerReport = {
    projectId: "demo",
    workspaceId: "repo",
    jobId: job.id,
    reportId: "plan-1",
    reportArtifact: "report.html",
    message: "Информационный dry-run готов.",
    chatId: -100500,
    topicId: 9,
    messageId: null,
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:00.000Z",
  };
  runtime.viewer.runner.report = async () => report;
  runtime.viewer.runner.artifact = async () => ({
    name: "report.html",
    bytes: 19,
    contentType: "text/html",
    content: "<html>report</html>",
  });
  runtime.viewer.runner.bindReportMessage = async (input) => {
    report = { ...report, messageId: input.messageId };
    return report;
  };
  const deliveries: Array<{ chatId: number; fileName: string; topicId?: number; caption?: string }> = [];
  runtime.telegram.sendDocument = async (chatId, _content, fileName, _contentType, options) => {
    deliveries.push({
      chatId,
      fileName,
      ...(options?.topicId === undefined ? {} : { topicId: options.topicId }),
      ...(options?.caption === undefined ? {} : { caption: options.caption }),
    });
    return 245;
  };
  try {
    const delivered = await (
      runtime as unknown as {
        sendRunnerReport(job: RunnerJob, conversationId: string, actorUserId: number): Promise<boolean>;
      }
    ).sendRunnerReport(job, internal.id, 1);
    assert.equal(delivered, true);
    assert.deepEqual(deliveries, [{
      chatId: -100500,
      fileName: "dry-run-plan-1.html",
      topicId: 9,
      caption: "Информационный dry-run готов.",
    }]);
    const source = runtime.state.teamSourceForProvider("telegram", "-100500", "9");
    assert.ok(source);
    assert.equal(
      runtime.state.recentTeamEvents(source.spaceId, source.id)[0]?.externalEventId,
      "245",
    );
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
