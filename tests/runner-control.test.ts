import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectCatalog } from "../src/project-catalog.js";
import type {
  ProjectRunnerClient,
  RunnerJob,
  RunnerSubmissionMetadata,
} from "../src/project-runner-client.js";
import {
  dueScheduleOccurrence,
  nextScheduleOccurrence,
  RunnerControlPlane,
  type RunnerControlContext,
  type RunnerSchedule,
} from "../src/runner-control.js";
import { executeRunnerTool, RUNNER_DYNAMIC_TOOLS } from "../src/runner-tools.js";

function context(turnId: string): RunnerControlContext {
  return {
    projectId: "demo",
    workspaceId: "repo",
    repositoryPath: "/unused",
    conversationId: "conversation-1",
    actorUserId: 42,
    turnId,
  };
}

function schedule(overrides: Partial<RunnerSchedule> = {}): RunnerSchedule {
  return {
    id: "fef80899-e998-4c5a-8f58-cd775802a954",
    projectId: "demo",
    workspaceId: "repo",
    name: "Утренний запуск",
    action: "run",
    time: "08:50",
    timeZone: "Europe/Moscow",
    weekdays: [1, 2, 3, 4, 5],
    enabled: true,
    revisionRef: "master",
    overlapPolicy: "skip",
    misfireGraceMinutes: 30,
    createdBy: 42,
    updatedBy: 42,
    createdAt: "2026-08-17T05:00:00.000Z",
    updatedAt: "2026-08-17T05:00:00.000Z",
    ...overrides,
  };
}

test("schedule occurrence respects IANA timezone, weekdays, grace, and DST deduplication", () => {
  const weekday = schedule();
  assert.deepEqual(dueScheduleOccurrence(weekday, Date.parse("2026-08-17T05:50:00.000Z")), {
    key: "2026-08-17T08:50@Europe/Moscow",
    scheduledFor: "2026-08-17T05:50:00.000Z",
  });
  assert.deepEqual(dueScheduleOccurrence(weekday, Date.parse("2026-08-17T06:05:00.000Z")), {
    key: "2026-08-17T08:50@Europe/Moscow",
    scheduledFor: "2026-08-17T05:50:00.000Z",
  });
  assert.equal(dueScheduleOccurrence(weekday, Date.parse("2026-08-17T06:21:00.000Z")), null);
  assert.equal(
    nextScheduleOccurrence(weekday, Date.parse("2026-08-17T05:50:00.000Z")),
    "2026-08-18T05:50:00.000Z",
  );

  const fallBack = schedule({
    time: "01:30",
    timeZone: "America/New_York",
    weekdays: [7],
  });
  const first = dueScheduleOccurrence(fallBack, Date.parse("2026-11-01T05:30:00.000Z"));
  const second = dueScheduleOccurrence(fallBack, Date.parse("2026-11-01T06:30:00.000Z"));
  assert.equal(first?.key, "2026-11-01T01:30@America/New_York");
  assert.equal(second?.key, first?.key);
});

test("schedule changes require a later-turn confirmation and execute each occurrence once", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-control-"));
  const repository = join(root, "repo");
  mkdirSync(repository);
  execFileSync("git", ["init", "--initial-branch=master", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  writeFileSync(join(repository, "README.md"), "test\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

  let now = Date.parse("2026-08-17T05:50:00.000Z");
  const jobs: RunnerJob[] = [];
  const submissions: RunnerSubmissionMetadata[] = [];
  const runner = {
    available: async () => true,
    jobs: async () => jobs,
    submit: async (
      projectId: string,
      workspaceId: string,
      action: RunnerJob["action"],
      revision: string,
      _archive: Buffer,
      metadata: RunnerSubmissionMetadata,
    ) => {
      submissions.push(metadata);
      const job: RunnerJob = {
        id: "92ce53c0-565c-4168-81f7-d4926a9842b2",
        projectId,
        workspaceId,
        action,
        revision,
        ...(metadata.trigger ? { trigger: metadata.trigger } : {}),
        ...(metadata.scheduleId ? { scheduleId: metadata.scheduleId } : {}),
        ...(metadata.scheduledFor ? { scheduledFor: metadata.scheduledFor } : {}),
        status: "queued",
        createdAt: new Date(now).toISOString(),
      };
      jobs.push(job);
      return job;
    },
  } as unknown as ProjectRunnerClient;
  const projects = {
    project: () => ({ workspace: () => ({ id: "repo", path: repository }) }),
  } as unknown as ProjectCatalog;
  const control = new RunnerControlPlane(
    join(root, "control.sqlite3"),
    projects,
    runner,
    async () => {},
    () => now,
  );
  try {
    assert.throws(
      () => control.planSchedule(context("turn-invalid"), {
        operation: "upsert",
        name: "Без timezone",
        action: "run",
        time: "08:50",
        weekdays: [1],
      }),
      /valid IANA time zone/,
    );
    const planned = control.planSchedule(context("turn-1"), {
      operation: "upsert",
      name: "Утренний запуск",
      action: "run",
      time: "08:50",
      timeZone: "Europe/Moscow",
      weekdays: [1, 2, 3, 4, 5],
    });
    assert.match(planned.summary, /Утренний запуск/);
    assert.throws(
      () => control.applySchedule(context("turn-1"), planned.token),
      /explicit user confirmation in a later message/,
    );
    const stored = control.applySchedule(context("turn-2"), planned.token);
    assert.ok(stored);

    await control.tick();
    await control.tick();
    assert.equal(submissions.length, 1);
    const { idempotencyKey: scheduleRequestKey, ...scheduleMetadata } = submissions[0]!;
    assert.deepEqual(scheduleMetadata, {
      trigger: "schedule",
      scheduleId: stored.id,
      scheduledFor: "2026-08-17T05:50:00.000Z",
    });
    assert.match(scheduleRequestKey ?? "", /^[0-9a-f]{64}$/);

    now = Date.parse("2026-08-18T05:50:00.000Z");
    await control.tick();
    assert.equal(submissions.length, 1, "overlapping occurrence must be skipped");
    assert.equal(control.store.lastExecution(stored.id)?.status, "skipped");

    const inspection = await control.inspect(context("turn-3"));
    assert.equal(inspection.queued.length, 1);
    assert.equal(inspection.schedules[0]?.lastExecution?.status, "skipped");
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual tool calls deduplicate jobs, expose an overview, and notify their conversation once", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-manual-watch-"));
  const repository = join(root, "repo");
  mkdirSync(repository);
  execFileSync("git", ["init", "--initial-branch=master", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  writeFileSync(join(repository, "README.md"), "test\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);

  let now = Date.parse("2026-08-17T06:00:00.000Z");
  const jobs: RunnerJob[] = [];
  const submissions: RunnerSubmissionMetadata[] = [];
  const notifications: Array<{ projectId: string; message: string; conversationId?: string }> = [];
  const runner = {
    available: async () => true,
    jobs: async () => jobs,
    submit: async (
      projectId: string,
      workspaceId: string,
      action: RunnerJob["action"],
      revision: string,
      _archive: Buffer,
      metadata: RunnerSubmissionMetadata,
    ) => {
      submissions.push(metadata);
      const existing = jobs.find((job) => job.idempotencyKey === metadata.idempotencyKey);
      if (existing) return existing;
      const job: RunnerJob = {
        id: "80d40abc-663c-4795-af9c-833e8beccc92",
        projectId,
        workspaceId,
        action,
        revision,
        trigger: "manual",
        ...(metadata.idempotencyKey ? { idempotencyKey: metadata.idempotencyKey } : {}),
        status: "queued",
        createdAt: new Date(now).toISOString(),
      };
      jobs.push(job);
      return job;
    },
  } as unknown as ProjectRunnerClient;
  const control = new RunnerControlPlane(
    join(root, "control.sqlite3"),
    {} as ProjectCatalog,
    runner,
    async (projectId, message, conversationId) => {
      notifications.push({
        projectId,
        message,
        ...(conversationId ? { conversationId } : {}),
      });
    },
    () => now,
  );
  const manualContext = { ...context("turn-manual"), repositoryPath: repository };
  const call = {
    threadId: "thread",
    turnId: "turn-manual",
    callId: "call-manual-retry",
    namespace: "runner",
    tool: "start",
    arguments: { action: "run" },
  };
  try {
    const first = await executeRunnerTool(control, manualContext, call);
    const second = await executeRunnerTool(control, manualContext, call);
    const firstJob = JSON.parse(first.contentItems[0]!.text) as RunnerJob;
    const secondJob = JSON.parse(second.contentItems[0]!.text) as RunnerJob;
    assert.equal(firstJob.id, secondJob.id);
    assert.equal(jobs.length, 1);
    assert.equal(submissions.length, 1);
    assert.match(submissions[0]?.idempotencyKey ?? "", /^[0-9a-f]{64}$/);

    const queuedInspection = await control.inspect(manualContext);
    assert.equal(queuedInspection.overview.state, "queued");
    assert.equal(queuedInspection.overview.queuedCount, 1);
    assert.match(queuedInspection.overview.summary, /в очереди 1/);

    jobs[0]!.status = "completed";
    jobs[0]!.completedAt = new Date(now + 10_000).toISOString();
    now += 15_000;
    await control.tick();
    await control.tick();
    assert.deepEqual(notifications, [{
      projectId: "demo",
      conversationId: "conversation-1",
      message: `Ручной запуск «run» (${jobs[0]!.id}) завершён успешно.`,
    }]);

    const completedInspection = await control.inspect(manualContext);
    assert.equal(completedInspection.overview.state, "idle");
    assert.equal(completedInspection.overview.lastResult?.id, jobs[0]!.id);
    assert.match(completedInspection.overview.summary, /ничего не запущено/);
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner tools expose only conversation-scoped arguments and treat artifacts as bounded data", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-tools-"));
  let availableArtifacts = [{
    name: "manifest.json",
    bytes: 70_000,
    contentType: "application/json",
  }];
  const job: RunnerJob = {
    id: "21ea9ded-dc28-45b5-91d0-35fbe75e7bfa",
    projectId: "demo",
    workspaceId: "repo",
    action: "dry-run",
    revision: "a".repeat(40),
    trigger: "manual",
    status: "completed",
    createdAt: "2026-08-17T05:00:00.000Z",
    completedAt: "2026-08-17T05:01:00.000Z",
    artifactCount: 1,
  };
  const runner = {
    available: async () => true,
    jobs: async () => [job],
    log: async () => `old-prefix-${"l".repeat(70_000)}`,
    artifacts: async () => availableArtifacts,
    artifact: async () => ({
      name: "manifest.json",
      contentType: "application/json",
      content: "x".repeat(70_000),
    }),
    deleteArtifact: async (
      _projectId: string,
      _workspaceId: string,
      jobId: string,
      name: string,
    ) => {
      const artifact = availableArtifacts.find((candidate) => candidate.name === name);
      if (!artifact) throw new Error("artifact not found");
      availableArtifacts = availableArtifacts.filter((candidate) => candidate.name !== name);
      job.artifactCount = availableArtifacts.length;
      return { ...artifact, jobId, deletedAt: "2026-08-17T05:02:00.000Z" };
    },
  } as unknown as ProjectRunnerClient;
  const control = new RunnerControlPlane(
    join(root, "control.sqlite3"),
    {} as ProjectCatalog,
    runner,
  );
  try {
    const namespace = RUNNER_DYNAMIC_TOOLS[0]!;
    for (const tool of namespace.tools) {
      const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
      assert.equal(Object.hasOwn(properties ?? {}, "projectId"), false);
      assert.equal(Object.hasOwn(properties ?? {}, "workspaceId"), false);
      assert.equal(Object.hasOwn(properties ?? {}, "actorUserId"), false);
    }
    const listed = await executeRunnerTool(control, context("turn-artifacts"), {
      threadId: "thread",
      turnId: "turn-artifacts",
      callId: "call-list",
      namespace: "runner",
      tool: "artifacts",
      arguments: {},
    });
    assert.equal(listed.success, true);
    assert.match(listed.contentItems[0]!.text, /manifest\.json/);

    const read = await executeRunnerTool(control, context("turn-artifacts"), {
      threadId: "thread",
      turnId: "turn-artifacts",
      callId: "call-read",
      namespace: "runner",
      tool: "artifact_read",
      arguments: { jobId: job.id, name: "manifest.json" },
    });
    const payload = JSON.parse(read.contentItems[0]!.text) as { content: string; truncated: boolean };
    assert.equal(payload.truncated, true);
    assert.equal(payload.content.length, 64_000);

    const logRead = await executeRunnerTool(control, context("turn-artifacts"), {
      threadId: "thread",
      turnId: "turn-artifacts",
      callId: "call-log",
      namespace: "runner",
      tool: "job_log",
      arguments: { jobId: job.id },
    });
    const logPayload = JSON.parse(logRead.contentItems[0]!.text) as {
      log: string;
      truncated: boolean;
    };
    assert.equal(logPayload.truncated, true);
    assert.equal(logPayload.log.length, 64_000);
    assert.doesNotMatch(logPayload.log, /old-prefix/);

    const planned = await executeRunnerTool(control, context("turn-plan"), {
      threadId: "thread",
      turnId: "turn-plan",
      callId: "call-plan",
      namespace: "runner",
      tool: "artifact_delete_plan",
      arguments: { jobId: job.id, name: "manifest.json" },
    });
    const plan = JSON.parse(planned.contentItems[0]!.text) as { token: string };
    await assert.rejects(
      executeRunnerTool(control, context("turn-plan"), {
        threadId: "thread",
        turnId: "turn-plan",
        callId: "call-apply-early",
        namespace: "runner",
        tool: "artifact_apply",
        arguments: { token: plan.token },
      }),
      /explicit user confirmation in a later message/,
    );
    const applied = await executeRunnerTool(control, context("turn-confirm"), {
      threadId: "thread",
      turnId: "turn-confirm",
      callId: "call-apply",
      namespace: "runner",
      tool: "artifact_apply",
      arguments: { token: plan.token },
    });
    assert.match(applied.contentItems[0]!.text, /manifest\.json/);
    assert.equal(availableArtifacts.length, 0);

    availableArtifacts = [
      { name: "candidates.json", bytes: 10, contentType: "application/json" },
      { name: "report.html", bytes: 20, contentType: "text/html" },
    ];
    job.artifactCount = 2;
    const clearPlanned = await executeRunnerTool(control, context("turn-clear-plan"), {
      threadId: "thread",
      turnId: "turn-clear-plan",
      callId: "call-clear-plan",
      namespace: "runner",
      tool: "artifacts_clear_plan",
      arguments: { jobId: job.id },
    });
    const clearPlan = JSON.parse(clearPlanned.contentItems[0]!.text) as {
      token: string;
      targets: Array<{ name: string }>;
    };
    assert.deepEqual(clearPlan.targets.map((target) => target.name), [
      "candidates.json",
      "report.html",
    ]);
    availableArtifacts.push({ name: "errors.json", bytes: 30, contentType: "application/json" });
    job.artifactCount = 3;
    await executeRunnerTool(control, context("turn-clear-confirm"), {
      threadId: "thread",
      turnId: "turn-clear-confirm",
      callId: "call-clear-apply",
      namespace: "runner",
      tool: "artifact_apply",
      arguments: { token: clearPlan.token },
    });
    assert.deepEqual(availableArtifacts.map((artifact) => artifact.name), ["errors.json"]);
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});
