import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunnerApprovalStore } from "../src/runner-approval.js";

function fixture(): {
  root: string;
  dataRoot: string;
  projectData: string;
  artifactDirectory: string;
  statePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "summing-approval-bridge-"));
  const dataRoot = join(root, "runner");
  const projectData = join(root, "project-data");
  const artifactDirectory = join(projectData, "dry-runs", "job-1");
  const statePath = join(projectData, "approval-plans", "plan-1", "approval.json");
  mkdirSync(artifactDirectory, { recursive: true });
  mkdirSync(join(projectData, "approval-plans", "plan-1"), { recursive: true });
  writeFileSync(join(artifactDirectory, "report.html"), "<html>report</html>\n");
  writeFileSync(statePath, JSON.stringify({
    planId: "plan-1",
    digest: "a".repeat(64),
    status: "pending",
    requestMessageId: null,
    approvedBy: null,
    approvedAt: null,
    approvalMessageId: null,
    updatedAt: "2026-08-20T04:00:00.000Z",
  }));
  writeFileSync(join(artifactDirectory, "approval-request.json"), JSON.stringify({
    schemaVersion: 1,
    planId: "plan-1",
    digest: "a".repeat(64),
    statePath: "approval-plans/plan-1/approval.json",
    reportArtifact: "report.html",
    message: "План готов к согласованию.",
  }));
  return { root, dataRoot, projectData, artifactDirectory, statePath };
}

test("runner approval bridge binds a plan to one Telegram message and persists an approval event", () => {
  const item = fixture();
  const store = new RunnerApprovalStore(
    item.dataRoot,
    () => new Date("2026-08-20T04:26:47.000Z"),
  );
  try {
    const captured = store.capture({
      projectId: "demo",
      workspaceId: "repo",
      jobId: "job-1",
      projectDataPath: item.projectData,
      artifactDirectory: item.artifactDirectory,
    });
    assert.ok(captured);
    assert.match(captured.callbackToken, /^[A-Za-z0-9_-]{20,48}$/);
    assert.equal(
      store.capture({
        projectId: "demo",
        workspaceId: "repo",
        jobId: "job-1",
        projectDataPath: item.projectData,
        artifactDirectory: item.artifactDirectory,
      })?.callbackToken,
      captured.callbackToken,
    );

    const bound = store.bind(captured.callbackToken, {
      chatId: -10042,
      topicId: 17,
      messageId: 245,
      authorizedUserId: 123456789,
    });
    assert.equal(bound.messageId, 245);
    assert.equal(
      (JSON.parse(readFileSync(item.statePath, "utf8")) as { requestMessageId: number })
        .requestMessageId,
      245,
    );
    assert.throws(
      () => store.decide(captured.callbackToken, "approved", {
        chatId: -10042,
        topicId: 17,
        messageId: 245,
        userId: 9,
      }),
      /not authorized/,
    );
    assert.throws(
      () => store.decide(captured.callbackToken, "approved", {
        chatId: -10042,
        topicId: 18,
        messageId: 245,
        userId: 123456789,
      }),
      /not attached to the bound report message/,
    );

    const approved = store.decide(captured.callbackToken, "approved", {
      chatId: -10042,
      topicId: 17,
      messageId: 245,
      userId: 123456789,
    });
    assert.equal(approved.status, "approved");
    assert.equal(approved.decidedBy, 123456789);
    const state = JSON.parse(readFileSync(item.statePath, "utf8")) as Record<string, unknown>;
    assert.equal(state.status, "pending", "the callback must not bypass the next-run barrier");
    const eventPath = store.eventPath("demo", "repo");
    assert.ok(eventPath);
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(
      {
        planId: event.planId,
        digest: event.digest,
        status: event.status,
        approvedBy: event.approvedBy,
        approvedAt: event.approvedAt,
        approvalMessageId: event.approvalMessageId,
      },
      {
        planId: "plan-1",
        digest: "a".repeat(64),
        status: "approved",
        approvedBy: 123456789,
        approvedAt: "2026-08-20T04:26:47.000Z",
        approvalMessageId: 245,
      },
    );
    assert.equal(
      store.decide(captured.callbackToken, "approved", {
        chatId: -10042,
        topicId: 17,
        messageId: 245,
        userId: 123456789,
      }).status,
      "approved",
    );
    assert.throws(
      () => store.decide(captured.callbackToken, "rejected", {
        chatId: -10042,
        topicId: 17,
        messageId: 245,
        userId: 123456789,
      }),
      /already approved/,
    );
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("runner approval bridge rejects a request whose durable state does not match its digest", () => {
  const item = fixture();
  try {
    writeFileSync(join(item.artifactDirectory, "approval-request.json"), JSON.stringify({
      schemaVersion: 1,
      planId: "plan-1",
      digest: "b".repeat(64),
      statePath: "approval-plans/plan-1/approval.json",
      reportArtifact: "report.html",
      message: "План готов к согласованию.",
    }));
    const store = new RunnerApprovalStore(item.dataRoot);
    assert.throws(
      () => store.capture({
        projectId: "demo",
        workspaceId: "repo",
        jobId: "job-1",
        projectDataPath: item.projectData,
        artifactDirectory: item.artifactDirectory,
      }),
      /does not match planId and digest/,
    );
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});
