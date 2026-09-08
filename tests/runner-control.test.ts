import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ProjectCatalog } from "../src/project-catalog.js";
import type {
  ProjectRunnerClient,
  RunnerJob,
  RunnerService,
  RunnerSubmissionMetadata,
} from "../src/project-runner-client.js";
import {
  dueScheduleOccurrence,
  nextScheduleOccurrence,
  RunnerControlPlane,
  RunnerControlStore,
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
    version: 1,
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
    delivery: null,
    deliveryCondition: "success",
    notifications: [],
    originConversationId: "conversation-1",
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

test("runner control migrates legacy job watches for provision jobs", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-watch-migration-"));
  const databasePath = join(root, "control.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE runner_job_watches (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('build', 'validate', 'dry-run', 'run')),
      last_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      notified_at TEXT
    );
    CREATE INDEX runner_job_watches_pending
      ON runner_job_watches(notified_at, project_id, workspace_id, created_at);
    INSERT INTO runner_job_watches VALUES
      ('legacy-job', 'demo', 'repo', 'conversation-1', 'run', 'completed',
       '2026-08-17T05:00:00.000Z', '2026-08-17T05:01:00.000Z', NULL);
  `);
  legacy.close();

  const store = new RunnerControlStore(databasePath);
  try {
    assert.equal(store.jobWatch("legacy-job")?.actorUserId, 0);
    store.watchJob(context("turn-provision"), {
      id: "provision-job",
      projectId: "demo",
      workspaceId: "repo",
      action: "provision",
      provisionId: "rotate-api",
      revision: "a".repeat(40),
      status: "queued",
      createdAt: "2026-08-17T06:00:00.000Z",
    }, Date.parse("2026-08-17T06:00:00.000Z"));
    assert.equal(store.jobWatch("provision-job")?.action, "provision");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner control migrates schedules created before direct report destinations", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-schedule-migration-"));
  const databasePath = join(root, "control.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE runner_schedules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      local_time TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      weekdays_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      revision_ref TEXT NOT NULL,
      overlap_policy TEXT NOT NULL,
      misfire_grace_minutes INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      updated_by INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, workspace_id, name)
    );
    INSERT INTO runner_schedules VALUES
      ('fef80899-e998-4c5a-8f58-cd775802a954', 'demo', 'repo', 'Legacy report',
       'dry-run', '08:30', 'Europe/Moscow', '[1,2,3,4,5]', 1, 'master', 'skip', 30,
       42, 42, '2026-08-17T05:00:00.000Z', '2026-08-17T05:00:00.000Z');
  `);
  legacy.close();

  const store = new RunnerControlStore(databasePath);
  try {
    const migrated = store.schedules("demo", "repo")[0]!;
    assert.equal(migrated.delivery, null);
    assert.equal(migrated.deliveryCondition, "success");
    assert.equal(migrated.originConversationId, "");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled dry-run resolves and hands off its exact Telegram destination once", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-scheduled-report-"));
  const now = Date.parse("2026-08-20T04:01:15.000Z");
  const job: RunnerJob = {
    id: "51c813ba-bfe7-4669-b590-b5bfb60ce9fa",
    projectId: "demo",
    workspaceId: "repo",
    action: "dry-run",
    revision: "a".repeat(40),
    trigger: "schedule",
    status: "completed",
    portalMessageCount: 1,
    createdAt: "2026-08-20T04:00:00.000Z",
    completedAt: "2026-08-20T04:01:00.000Z",
  };
  const deliveries: Array<{ jobId: string; scheduleId: string; topicId: number }> = [];
  const runner = {
    available: async () => true,
    jobs: async () => [job],
  } as unknown as ProjectRunnerClient;
  const control = new RunnerControlPlane(
    join(root, "control.sqlite3"),
    {} as ProjectCatalog,
    runner,
    async () => {},
    () => now,
    15_000,
    async () => false,
    async (deliveredJob, deliveredSchedule) => {
      deliveries.push({
        jobId: deliveredJob.id,
        scheduleId: deliveredSchedule.id,
        topicId: deliveredSchedule.delivery!.topicId,
      });
      return true;
    },
    (_context, query) => {
      assert.equal(query, "Отчёты заказчику");
      return { chatId: -100500, topicId: 67800, label: "«Customer» / «Reports»" };
    },
  );
  try {
    const plan = control.planSchedule(context("turn-plan"), {
      operation: "upsert",
      name: "Утренний отчёт",
      action: "dry-run",
      time: "08:30",
      timeZone: "Europe/Moscow",
      weekdays: [1, 2, 3, 4, 5],
      deliveryTopic: "Отчёты заказчику",
    });
    assert.match(plan.summary, /отчёт → «Customer» \/ «Reports»/);
    const stored = control.applySchedule(context("turn-confirm"), plan.token)!;
    assert.deepEqual(stored.delivery, {
      chatId: -100500,
      topicId: 67800,
      label: "«Customer» / «Reports»",
    });
    assert.equal(stored.deliveryCondition, "success");
    assert.equal(stored.originConversationId, "conversation-1");

    const execution = control.store.claimExecution(stored, {
      key: "2026-08-20T08:30@Europe/Moscow",
      scheduledFor: "2026-08-20T05:30:00.000Z",
    }, now)!;
    control.store.updateExecution(execution.id, "queued", {
      jobId: job.id,
      revision: job.revision,
    }, now);

    await control.tick();
    await control.tick();
    assert.deepEqual(deliveries, [{ jobId: job.id, scheduleId: stored.id, topicId: 67800 }]);
    assert.equal(control.store.execution(execution.id)?.status, "completed");
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled live-run report delivery follows the configured terminal condition", async () => {
  for (const [deliveryCondition, expectedDeliveries] of [
    ["success", 0],
    ["failure", 1],
    ["always", 1],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `summing-runner-live-report-${deliveryCondition}-`));
    const now = Date.parse("2026-08-20T09:01:15.000Z");
    const job: RunnerJob = {
      id: "61c813ba-bfe7-4669-b590-b5bfb60ce9fa",
      projectId: "demo",
      workspaceId: "repo",
      action: "run",
      revision: "b".repeat(40),
      trigger: "schedule",
      status: "failed",
      error: "partial publication failed",
      portalMessageCount: 1,
      createdAt: "2026-08-20T09:00:00.000Z",
      completedAt: "2026-08-20T09:01:00.000Z",
    };
    const deliveries: string[] = [];
    const runner = {
      available: async () => true,
      jobs: async () => [job],
    } as unknown as ProjectRunnerClient;
    const control = new RunnerControlPlane(
      join(root, "control.sqlite3"),
      {} as ProjectCatalog,
      runner,
      async () => {},
      () => now,
      15_000,
      async () => false,
      async (deliveredJob) => {
        deliveries.push(deliveredJob.id);
        return true;
      },
      () => ({ chatId: -100500, topicId: 67800, label: "«Customer» / «Reports»" }),
    );
    try {
      const plan = control.planSchedule(context(`turn-plan-${deliveryCondition}`), {
        operation: "upsert",
        name: `Live report ${deliveryCondition}`,
        action: "run",
        time: "12:00",
        timeZone: "Europe/Moscow",
        weekdays: [1, 2, 3, 4, 5],
        enabled: false,
        deliveryTopic: "Customer reports",
        deliveryCondition,
      });
      const stored = control.applySchedule(
        context(`turn-confirm-${deliveryCondition}`),
        plan.token,
      )!;
      assert.equal(stored.deliveryCondition, deliveryCondition);
      const execution = control.store.claimExecution(stored, {
        key: `2026-08-20T12:00@Europe/Moscow-${deliveryCondition}`,
        scheduledFor: "2026-08-20T09:00:00.000Z",
      }, now)!;
      control.store.updateExecution(execution.id, "queued", {
        jobId: job.id,
        revision: job.revision,
      }, now);
      await control.tick();
      await control.tick();
      assert.equal(deliveries.length, expectedDeliveries);
      assert.equal(control.store.execution(execution.id)?.status, "failed");
    } finally {
      control.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("schedule changes require a later-turn confirmation and execute each occurrence once", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-control-"));
  const repository = join(root, "repo");
  mkdirSync(repository);
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  writeFileSync(join(repository, "README.md"), "test\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);
  execFileSync("git", ["-C", repository, "switch", "-c", "published-work"]);
  writeFileSync(join(repository, "README.md"), "published\n");
  execFileSync("git", ["-C", repository, "commit", "-am", "published"]);
  const publishedRevision = execFileSync(
    "git",
    ["-C", repository, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const origin = join(repository, ".git", "test-origin.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=master", origin]);
  execFileSync("git", ["-C", repository, "remote", "add", "origin", origin]);
  execFileSync("git", ["-C", repository, "push", "origin", "HEAD:master"]);
  execFileSync("git", ["-C", repository, "switch", "main"]);

  let now = Date.parse("2026-08-17T05:50:00.000Z");
  const jobs: RunnerJob[] = [];
  const submissions: RunnerSubmissionMetadata[] = [];
  const runner = {
    available: async () => true,
    health: async () => ({
      ok: true,
      version: "9.19.0",
      protocolVersion: 2,
      queued: 1,
      running: 1,
      maxParallelJobs: 2,
      runTimeoutHours: 12,
    }),
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
    assert.equal(jobs[0]?.revision, publishedRevision);
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
    health: async () => ({
      ok: true,
      version: "9.19.0",
      protocolVersion: 2,
      queued: 1,
      running: 1,
      maxParallelJobs: 2,
      runTimeoutHours: 12,
    }),
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
    assert.equal(queuedInspection.health?.maxParallelJobs, 2);
    assert.match(queuedInspection.overview.summary, /1\/2/);

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

test("provision requires an explicit profile and forwards only pinned metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-manual-provision-"));
  const repository = join(root, "repo");
  mkdirSync(repository);
  execFileSync("git", ["init", "--initial-branch=master", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  writeFileSync(join(repository, "README.md"), "test\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);
  const revision = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  const jobs: RunnerJob[] = [];
  const submissions: RunnerSubmissionMetadata[] = [];
  const runner = {
    available: async () => true,
    jobs: async () => jobs,
    submit: async (
      projectId: string,
      workspaceId: string,
      action: RunnerJob["action"],
      submittedRevision: string,
      _archive: Buffer,
      metadata: RunnerSubmissionMetadata,
    ) => {
      submissions.push(metadata);
      const job: RunnerJob = {
        id: "e6e19e96-5ab4-45c8-a78e-a952819d3c3a",
        projectId,
        workspaceId,
        action,
        revision: submittedRevision,
        trigger: "manual",
        ...(metadata.provisionId ? { provisionId: metadata.provisionId } : {}),
        ...(metadata.idempotencyKey ? { idempotencyKey: metadata.idempotencyKey } : {}),
        status: "queued",
        createdAt: "2026-08-17T06:00:00.000Z",
      };
      jobs.push(job);
      return job;
    },
  } as unknown as ProjectRunnerClient;
  const control = new RunnerControlPlane(
    join(root, "control.sqlite3"),
    {} as ProjectCatalog,
    runner,
  );
  const provisionContext = { ...context("turn-provision"), repositoryPath: repository };
  try {
    await assert.rejects(
      executeRunnerTool(control, provisionContext, {
        threadId: "thread",
        turnId: "turn-provision",
        callId: "provision-missing-profile",
        namespace: "runner",
        tool: "start",
        arguments: { action: "provision" },
      }),
      /requires a valid provisionId/,
    );
    const started = await executeRunnerTool(control, provisionContext, {
      threadId: "thread",
      turnId: "turn-provision",
      callId: "provision-explicit-profile",
      namespace: "runner",
      tool: "start",
      arguments: { action: "provision", provisionId: "rotate-api" },
    });
    const job = JSON.parse(started.contentItems[0]!.text) as RunnerJob;
    assert.equal(job.action, "provision");
    assert.equal(job.revision, revision);
    assert.equal(job.provisionId, "rotate-api");
    assert.equal(submissions.length, 1);
    assert.deepEqual(Object.keys(submissions[0]!).sort(), [
      "idempotencyKey",
      "provisionId",
      "trigger",
    ]);
    assert.equal(submissions[0]?.provisionId, "rotate-api");
    assert.match(submissions[0]?.idempotencyKey ?? "", /^[0-9a-f]{64}$/);
    assert.equal(control.store.jobWatch(job.id)?.action, "provision");

    await assert.rejects(
      executeRunnerTool(control, provisionContext, {
        threadId: "thread",
        turnId: "turn-provision",
        callId: "provision-schedule",
        namespace: "runner",
        tool: "schedule_plan",
        arguments: {
          operation: "upsert",
          name: "Unsafe provisioning schedule",
          action: "provision",
          time: "08:00",
          timeZone: "Europe/Moscow",
          weekdays: [1],
        },
      }),
      /schedule action is invalid/,
    );

    writeFileSync(join(repository, "README.md"), "dirty\n");
    await assert.rejects(
      control.startJob(
        { ...provisionContext, turnId: "turn-dirty" },
        "provision",
        "provision-dirty",
        "rotate-api",
      ),
      /requires a clean committed worktree/,
    );
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completed manual live-run routes portal messages to the originating actor and conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-portal-watch-"));
  const job: RunnerJob = {
    id: "b4a0bb44-d858-40ba-93b9-5e8f0c105c85",
    projectId: "demo",
    workspaceId: "repo",
    action: "run",
    revision: "a".repeat(40),
    status: "completed",
    portalMessageCount: 1,
    createdAt: "2026-08-20T04:00:00.000Z",
    completedAt: "2026-08-20T04:01:00.000Z",
  };
  const genericNotifications: string[] = [];
  const portalNotifications: Array<{
    jobId: string;
    conversationId: string;
    authorizedUserId: number;
  }> = [];
  const runner = {
    available: async () => true,
    jobs: async () => [job],
  } as unknown as ProjectRunnerClient;
  const control = new RunnerControlPlane(
    join(root, "control.sqlite3"),
    {} as ProjectCatalog,
    runner,
    async (_projectId, message) => {
      genericNotifications.push(message);
    },
    () => Date.parse("2026-08-20T04:01:15.000Z"),
    15_000,
    async (portalJob, conversationId, authorizedUserId) => {
      portalNotifications.push({ jobId: portalJob.id, conversationId, authorizedUserId });
      return true;
    },
  );
  try {
    const { portalMessageCount: _portalMessageCount, ...queuedJob } = job;
    control.store.watchJob(
      context("turn-report"),
      { ...queuedJob, status: "queued" },
      Date.parse("2026-08-20T04:00:00.000Z"),
    );
    await control.tick();
    await control.tick();
    assert.deepEqual(portalNotifications, [{
      jobId: job.id,
      conversationId: "conversation-1",
      authorizedUserId: 42,
    }]);
    assert.deepEqual(genericNotifications, []);
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const action of ["dry-run", "run"] as const) {
  test(`a failed manual ${action} delivers its captured batch once and still reports the failure`, async () => {
    const root = mkdtempSync(join(tmpdir(), "summing-runner-failed-report-"));
    const now = Date.parse("2026-09-04T09:21:00.000Z");
    const job: RunnerJob = {
      id: "f4edc136-bfe4-47ab-a889-62bbcfc82a53",
      projectId: "demo",
      workspaceId: "repo",
      action,
      revision: "a".repeat(40),
      status: "failed",
      exitCode: 1,
      error: "invalid_grant",
      portalMessageCount: 1,
      createdAt: "2026-09-04T09:16:26.000Z",
      completedAt: "2026-09-04T09:20:11.000Z",
    };
    const reports: Array<{ job: RunnerJob; conversationId: string; actorUserId: number }> = [];
    const notices: Array<{ message: string; conversationId: string | undefined }> = [];
    const control = new RunnerControlPlane(
      join(root, "control.sqlite3"),
      {} as ProjectCatalog,
      { available: async () => true, jobs: async () => [job] } as unknown as ProjectRunnerClient,
      async (_projectId, message, conversationId) => { notices.push({ message, conversationId }); },
      () => now,
      15_000,
      async (reportJob, conversationId, actorUserId) => {
        reports.push({ job: reportJob, conversationId, actorUserId });
        return true;
      },
    );
    try {
      control.store.watchJob(context("turn-failed-report"), { ...job, status: "queued" }, now);
      await control.tick();
      await control.tick();
      assert.deepEqual(reports, [{ job, conversationId: "conversation-1", actorUserId: 42 }]);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.conversationId, "conversation-1");
      assert.match(notices[0]!.message, /invalid_grant/);
      assert.match(notices[0]!.message, /ошибк/);
      assert.equal(control.store.jobWatch(job.id)?.lastStatus, "failed");
      assert.ok(control.store.jobWatch(job.id)?.notifiedAt);
      assert.equal(job.status, "failed");
      assert.equal(job.exitCode, 1);
    } finally {
      control.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("manual report recovery excludes active, cancelled, interrupted, non-report, empty, legacy, and already-notified jobs", async () => {
  const cases: Array<{
    status: RunnerJob["status"];
    action: RunnerJob["action"];
    count: number;
    actor: number;
    notified?: boolean;
  }> = [
    { status: "queued", action: "run", count: 1, actor: 42 },
    { status: "running", action: "run", count: 1, actor: 42 },
    { status: "cancelling", action: "run", count: 1, actor: 42 },
    { status: "cancelled", action: "run", count: 1, actor: 42 },
    { status: "interrupted", action: "run", count: 1, actor: 42 },
    { status: "failed", action: "build", count: 1, actor: 42 },
    { status: "failed", action: "validate", count: 1, actor: 42 },
    { status: "failed", action: "provision", count: 1, actor: 42 },
    { status: "failed", action: "run", count: 0, actor: 42 },
    { status: "failed", action: "run", count: 1, actor: 0 },
    { status: "failed", action: "run", count: 1, actor: 42, notified: true },
  ];
  for (const entry of cases) {
    const root = mkdtempSync(join(tmpdir(), "summing-runner-report-boundary-"));
    const job: RunnerJob = {
      id: "f4edc136-bfe4-47ab-a889-62bbcfc82a53",
      projectId: "demo", workspaceId: "repo", revision: "a".repeat(40),
      status: entry.status, action: entry.action, portalMessageCount: entry.count,
      createdAt: "2026-09-04T09:16:26.000Z",
    };
    let reports = 0;
    const control = new RunnerControlPlane(
      join(root, "control.sqlite3"),
      {} as ProjectCatalog,
      { available: async () => true, jobs: async () => [job] } as unknown as ProjectRunnerClient,
      async () => {}, Date.now, 15_000,
      async () => { reports++; return true; },
    );
    try {
      control.store.watchJob({ ...context("turn-boundary"), actorUserId: entry.actor }, job, Date.now());
      if (entry.notified) control.store.markJobWatchNotified(job.id, Date.now());
      await control.tick();
      assert.equal(reports, 0, JSON.stringify(entry));
    } finally {
      control.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("manual lifecycle notifications can report failures, successes, or every finish independently", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-lifecycle-watch-"));
  const job: RunnerJob = {
    id: "c4a0bb44-d858-40ba-93b9-5e8f0c105c85",
    projectId: "demo",
    workspaceId: "repo",
    action: "run",
    revision: "c".repeat(40),
    status: "failed",
    exitCode: 1,
    error: "one publication was rejected",
    createdAt: "2026-08-20T04:00:00.000Z",
    completedAt: "2026-08-20T04:01:00.000Z",
  };
  const delivered: Array<{ when: string; text: string }> = [];
  const runner = {
    available: async () => true,
    jobs: async () => [job],
  } as unknown as ProjectRunnerClient;
  const control = new RunnerControlPlane(
    join(root, "control.sqlite3"),
    {} as ProjectCatalog,
    runner,
    async () => {},
    () => Date.parse("2026-08-20T04:01:15.000Z"),
    15_000,
    async () => false,
    async () => false,
    () => ({ chatId: -100500, topicId: 9, label: "unused" }),
    () => {},
    async (_job, notification) => {
      delivered.push({ when: notification.when, text: notification.text });
      return true;
    },
  );
  try {
    const { error: _error, exitCode: _exitCode, ...queuedJob } = job;
    control.store.watchJob(
      context("turn-lifecycle"),
      { ...queuedJob, status: "queued" },
      Date.parse("2026-08-20T04:00:00.000Z"),
      [
        { chatId: -100500, topicId: 9, when: "succeeded", text: "success" },
        { chatId: -100500, topicId: 9, when: "failed", text: "failed {{error}}" },
        { chatId: -100501, topicId: 0, when: "finished", text: "finished {{status}}" },
      ],
    );
    await control.tick();
    await control.tick();
    assert.deepEqual(delivered, [
      { when: "failed", text: "failed {{error}}" },
      { when: "finished", text: "finished {{status}}" },
    ]);
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
  const jobs = [job];
  let replayCalls = 0;
  const runner = {
    available: async () => true,
    jobs: async () => jobs,
    replay: async (
      projectId: string,
      workspaceId: string,
      sourceJobId: string,
      idempotencyKey: string,
    ) => {
      replayCalls += 1;
      const replay: RunnerJob = {
        id: "342f0836-b79b-44e4-8e0a-b437d368bd33",
        releaseId: sourceJobId,
        replayOfJobId: sourceJobId,
        projectId,
        workspaceId,
        action: job.action,
        revision: job.revision,
        trigger: "replay",
        idempotencyKey,
        status: "queued",
        createdAt: "2026-08-17T05:03:00.000Z",
      };
      jobs.push(replay);
      return replay;
    },
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
    for (const namespace of RUNNER_DYNAMIC_TOOLS) {
      for (const tool of namespace.tools) {
        const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
        assert.equal(Object.hasOwn(properties ?? {}, "projectId"), false);
        assert.equal(Object.hasOwn(properties ?? {}, "workspaceId"), false);
        assert.equal(Object.hasOwn(properties ?? {}, "actorUserId"), false);
      }
    }
    const replayCall = {
      threadId: "thread",
      turnId: "turn-replay",
      callId: "call-replay",
      namespace: "runner",
      tool: "replay",
      arguments: { jobId: job.id },
    } as const;
    const replayed = await executeRunnerTool(control, context("turn-replay"), replayCall);
    const replayedAgain = await executeRunnerTool(control, context("turn-replay"), replayCall);
    assert.equal(JSON.parse(replayed.contentItems[0]!.text).replayOfJobId, job.id);
    assert.equal(JSON.parse(replayedAgain.contentItems[0]!.text).replayOfJobId, job.id);
    assert.equal(replayCalls, 1);
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

test("service tools deploy an exact Release and keep restart separate from jobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-service-control-"));
  const release: RunnerJob = {
    id: "cfd3dd5d-96f8-4bd2-805d-aa4f13cceca0",
    releaseId: "cfd3dd5d-96f8-4bd2-805d-aa4f13cceca0",
    projectId: "demo",
    workspaceId: "repo",
    action: "validate",
    revision: "a".repeat(40),
    status: "completed",
    createdAt: "2026-08-17T05:00:00.000Z",
    completedAt: "2026-08-17T05:01:00.000Z",
  };
  let service: RunnerService | null = null;
  const deployKeys: string[] = [];
  const actions: string[] = [];
  const runner = {
    available: async () => true,
    health: async () => ({
      ok: true,
      version: "9.20.0",
      protocolVersion: 3,
      queued: 0,
      running: 0,
      maxParallelJobs: 2,
      runTimeoutHours: 12,
      servicePortRange: [20_000, 29_999] as [number, number],
    }),
    jobs: async () => [release],
    services: async () => service ? [service] : [],
    deployService: async (
      projectId: string,
      workspaceId: string,
      name: string,
      releaseId: string,
      idempotencyKey: string,
    ) => {
      deployKeys.push(idempotencyKey);
      service = {
        projectId,
        workspaceId,
        name,
        desiredState: "running",
        status: "running",
        current: {
          deploymentId: "dd705c36-0725-45a3-ae50-e87a2df2d807",
          releaseId,
          revision: release.revision,
          imageId: "sha256:image",
          environmentRevision: 2,
          deployedAt: "2026-08-17T05:02:00.000Z",
        },
        previous: null,
        localEndpoint: "http://127.0.0.1:23000",
        updatedAt: "2026-08-17T05:02:00.000Z",
      };
      return service;
    },
    serviceAction: async (
      _projectId: string,
      _workspaceId: string,
      _name: string,
      action: string,
    ) => {
      actions.push(action);
      return service!;
    },
    serviceLog: async () => "service log\n",
  } as unknown as ProjectRunnerClient;
  const control = new RunnerControlPlane(
    join(root, "control.sqlite3"),
    {} as ProjectCatalog,
    runner,
  );
  try {
    const inspected = await executeRunnerTool(control, context("turn-service-inspect"), {
      threadId: "thread",
      turnId: "turn-service-inspect",
      callId: "service-inspect",
      namespace: "service",
      tool: "inspect",
      arguments: {},
    });
    assert.match(inspected.contentItems[0]!.text, /deployableReleases/);
    const deployed = await executeRunnerTool(control, context("turn-service-deploy"), {
      threadId: "thread",
      turnId: "turn-service-deploy",
      callId: "service-deploy",
      namespace: "service",
      tool: "deploy",
      arguments: { name: "api", releaseId: release.id },
    });
    assert.match(deployed.contentItems[0]!.text, /127\.0\.0\.1:23000/);
    assert.match(deployKeys[0] ?? "", /^[0-9a-f]{64}$/);
    await executeRunnerTool(control, context("turn-service-restart"), {
      threadId: "thread",
      turnId: "turn-service-restart",
      callId: "service-restart",
      namespace: "service",
      tool: "restart",
      arguments: { name: "api" },
    });
    assert.deepEqual(actions, ["restart"]);
    const log = await executeRunnerTool(control, context("turn-service-log"), {
      threadId: "thread",
      turnId: "turn-service-log",
      callId: "service-log",
      namespace: "service",
      tool: "log",
      arguments: { name: "api" },
    });
    assert.match(log.contentItems[0]!.text, /service log/);
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});
