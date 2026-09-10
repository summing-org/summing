import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ProjectCatalog } from "../src/project-catalog.js";
import { ProjectRunnerClientError, type ProjectRunnerClient, type RunnerJob, type RunnerSubmissionMetadata, type RunnerService } from "../src/project-runner-client.js";
import { RunnerControlPlane, RunnerControlStore, type RunnerControlContext, type RunnerSchedule, type SchedulePlanInput } from "../src/runner-control.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "summing-scheduler-reliability-"));
  const repository = join(root, "repo");
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  writeFileSync(join(repository, "README.md"), "v1\n");
  git("add", ".");
  git("commit", "-m", "v1");
  const revision = git("rev-parse", "HEAD");
  const remote = join(repository, ".git", "origin.git");
  git("init", "--bare", "--initial-branch=main", remote);
  git("remote", "add", "origin", remote);
  git("push", "origin", "main");
  const ctx = (turnId: string, actorUserId = 42): RunnerControlContext => ({
    projectId: "demo", workspaceId: "repo", repositoryPath: repository,
    conversationId: "conversation-1", actorUserId, turnId,
  });
  let now = Date.parse("2026-09-08T08:00:00Z");
  const jobs: RunnerJob[] = [];
  const submissions: RunnerSubmissionMetadata[] = [];
  const reports: Array<{ job: RunnerJob; schedule: RunnerSchedule }> = [];
  const notifications: Array<{ key: string; text: string }> = [];
  const notices: string[] = [];
  const lookups: Array<{ jobId?: string; idempotencyKey?: string }> = [];
  const runner = {
    available: async () => true,
    jobs: async () => jobs,
    findJob: async (_project: string, _workspace: string, selector: { jobId?: string; idempotencyKey?: string }) => {
      lookups.push(selector);
      return jobs.find((job) => selector.jobId ? job.id === selector.jobId : job.idempotencyKey === selector.idempotencyKey) ?? null;
    },
    submit: async (projectId: string, workspaceId: string, action: RunnerJob["action"], sha: string, archive: Buffer, metadata: RunnerSubmissionMetadata) => {
      submissions.push(metadata);
      const job: RunnerJob = { id: randomUUID(), projectId, workspaceId, action, revision: sha,
        archiveSha256: createHash("sha256").update(archive).digest("hex"), ...metadata,
        status: "queued", createdAt: new Date(now).toISOString() };
      jobs.push(job);
      return job;
    },
  } as unknown as ProjectRunnerClient;
  const projects = { project: () => ({ workspace: () => ({ path: repository }) }) } as unknown as ProjectCatalog;
  const makeControl = () => new RunnerControlPlane(join(root, "control.db"), projects, runner,
    async (_project, message) => { notices.push(message); }, () => now, 15_000,
    async () => false,
    async (job, schedule) => { reports.push({ job, schedule }); return true; },
    (_ctx, query) => ({ chatId: -100500, topicId: Number(query), label: query }),
    () => {},
    async (_job, notification, key) => { notifications.push({ key, text: notification.text }); return true; });
  let control = makeControl();
  const add = (input: Partial<SchedulePlanInput> = {}) => {
    const plan = control.planSchedule(ctx(randomUUID()), { operation: "upsert", name: randomUUID(), action: "run",
      time: "08:00", timeZone: "UTC", enabled: false, ...input });
    return control.applySchedule(ctx(randomUUID()), plan.token)!;
  };
  const claim = (schedule: RunnerSchedule, job?: RunnerJob) => {
    const execution = control.store.claimExecution(schedule, { key: "2026-09-08T08:00@UTC", scheduledFor: new Date(now).toISOString() }, now)!;
    if (job) control.store.updateExecution(execution.id, "queued", { jobId: job.id, revision: job.revision }, now);
    return execution;
  };
  const job = (overrides: Partial<RunnerJob> = {}): RunnerJob => {
    const entry: RunnerJob = { id: randomUUID(), projectId: "demo", workspaceId: "repo", action: "run",
      revision, status: "completed", portalMessageCount: 1, createdAt: new Date(now).toISOString(), ...overrides };
    jobs.push(entry); return entry;
  };
  return { root, repository, git, remote, ctx, runner, jobs, submissions, reports, notifications, notices, lookups,
    add, claim, job, get control() { return control; }, get now() { return now; },
    advance(ms = 15_000) { now += ms; },
    reopen() { control.close(); control = makeControl(); },
    close() { control.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("a failing report does not block other schedules, manual results, or terminal lifecycle events", async () => {
  const f = fixture();
  try {
    const schedule = f.add({ deliveryTopic: "10", notifications: [{ chatId: -100500, topicId: 10, when: "finished", text: "Finished" }] });
    const finished = f.job();
    const execution = f.claim(schedule, finished);
    f.control.store.watchJob(f.ctx("manual"), f.job({ action: "validate", portalMessageCount: 0 }), f.now);
    f.add({ enabled: true });
    Object.assign(f.control, { deliverScheduledPortalMessages: async () => {
      assert.equal(f.control.store.execution(execution.id)?.status, "completed", "result is saved before delivery");
      throw new Error("topic A disappeared");
    } });
    await f.control.tick();
    assert.equal(f.submissions.length, 1);
    assert.equal(f.control.store.activeExecutions().length, 1);
    assert.equal(f.notices.length, 1);
    assert.deepEqual(f.notifications.map((item) => item.text), ["Finished"]);
    assert.equal(f.control.store.deliveryFailures("demo", "repo").length, 1);
    await f.control.tick();
    assert.equal(f.submissions.length, 1);
    f.reopen();
    f.advance();
    await f.control.tick();
    assert.equal(f.reports.length, 1);
    assert.equal(f.control.store.deliveryFailures("demo", "repo").length, 0);
    assert.equal(f.notifications.length, 1);
  } finally { f.close(); }
});

test("lifecycle and owner notices retry independently after restart with stable keys and backoff", async () => {
  const f = fixture();
  try {
    const schedule = f.add({ notifications: [
      { chatId: -100500, topicId: 10, when: "finished", text: "One" },
      { chatId: -100500, topicId: 20, when: "finished", text: "Two" },
    ] });
    f.claim(schedule, f.job({ status: "failed", portalMessageCount: 0 }));
    const tried: string[] = [];
    Object.assign(f.control, {
      deliverLifecycleNotification: async (_job: RunnerJob, notice: { text: string }, key: string) => {
        tried.push(key);
        if (notice.text === "Two") return false;
        f.notifications.push({ key, text: notice.text }); return true;
      },
      notify: async () => { throw new Error("outbox is temporarily unavailable"); },
    });
    await f.control.tick();
    assert.equal(f.control.store.activeExecutions().length, 0);
    assert.equal(tried.length, 2);
    assert.equal(f.control.store.deliveryFailures("demo", "repo").length, 2);
    await f.control.tick();
    assert.equal(tried.length, 2, "failed deliveries back off");
    f.reopen();
    await f.control.tick();
    assert.equal(f.notifications.length, 1);
    f.advance();
    await f.control.tick();
    assert.deepEqual(f.notifications.map((item) => item.text).sort(), ["One", "Two"]);
    assert.ok(tried.includes(f.notifications.find((item) => item.text === "Two")!.key));
    assert.equal(f.notices.length, 1);
    assert.equal(f.control.store.deliveryFailures("demo", "repo").length, 0);
  } finally { f.close(); }
});

test("old plans cannot undo a pause, overwrite another owner, or resurrect a deleted schedule", () => {
  const f = fixture();
  try {
    let schedule = f.add({ enabled: true });
    const change = f.control.planSchedule(f.ctx("plan-a"), { operation: "upsert", scheduleId: schedule.id, name: "Renamed" });
    const remove = f.control.planSchedule(f.ctx("plan-b"), { operation: "delete", scheduleId: schedule.id });
    schedule = f.control.setScheduleEnabled(f.ctx("pause", 43), schedule.id, false);
    assert.equal(schedule.version, 2);
    assert.throws(() => f.control.applySchedule(f.ctx("confirm-a"), change.token), /changed or was deleted/);
    assert.throws(() => f.control.applySchedule(f.ctx("confirm-b"), remove.token), /changed or was deleted/);
    const stale = f.control.planSchedule(f.ctx("plan-c"), { operation: "upsert", scheduleId: schedule.id, name: "Return" });
    const deletion = f.control.planSchedule(f.ctx("plan-d", 43), { operation: "delete", scheduleId: schedule.id });
    f.control.applySchedule(f.ctx("confirm-d", 43), deletion.token);
    assert.throws(() => f.control.applySchedule(f.ctx("confirm-c"), stale.token), /changed or was deleted/);
    assert.equal(f.control.store.schedules().length, 0);
  } finally { f.close(); }
});

test("editing then deleting a schedule retains an execution's original recipient and author after restart", async () => {
  const f = fixture();
  try {
    const schedule = f.add({ deliveryTopic: "10" });
    const execution = f.claim(schedule, f.job({ status: "running" }));
    const plan = f.control.planSchedule(f.ctx("edit", 43), { operation: "upsert", scheduleId: schedule.id, deliveryTopic: "20" });
    f.control.applySchedule(f.ctx("edit-confirm", 43), plan.token);
    const remove = f.control.planSchedule(f.ctx("remove"), { operation: "delete", scheduleId: schedule.id });
    f.control.applySchedule(f.ctx("remove-confirm"), remove.token);
    f.reopen();
    f.jobs[0]!.status = "completed";
    await f.control.tick();
    assert.equal(f.control.store.execution(execution.id)?.status, "completed");
    assert.equal(f.reports[0]?.schedule.delivery?.topicId, 10);
    assert.equal(f.reports[0]?.schedule.updatedBy, 42);
    assert.equal(f.reports[0]?.schedule.version, 1);
    assert.equal(f.control.store.schedules().length, 0);
  } finally { f.close(); }
});

test("lost submit response is reconciled beyond recent history without resubmitting or losing the report", async () => {
  const f = fixture();
  try {
    const schedule = f.add({ enabled: true, deliveryTopic: "10" });
    const submit = f.runner.submit.bind(f.runner);
    f.runner.submit = async (...args) => {
      const execution = f.control.store.lastExecution(schedule.id)!;
      assert.equal(execution.status, "reconciling");
      assert.equal(execution.submission?.metadata.idempotencyKey, args[5]?.idempotencyKey);
      assert.equal(execution.submission?.revision, args[3]);
      await submit(...args);
      throw new Error("response connection was lost");
    };
    await f.control.tick();
    const execution = f.control.store.lastExecution(schedule.id)!;
    assert.equal(execution.status, "reconciling");
    assert.equal(execution.jobId, null);
    f.jobs[0]!.status = "completed";
    f.jobs[0]!.portalMessageCount = 1;
    f.runner.jobs = async () => [];
    f.reopen();
    await f.control.tick();
    assert.equal(f.control.store.execution(execution.id)?.jobId, f.jobs[0]!.id);
    assert.equal(f.control.store.execution(execution.id)?.status, "completed");
    assert.equal(f.submissions.length, 1);
    assert.equal(f.lookups.length, 1);
    assert.equal(f.reports.length, 1);
  } finally { f.close(); }
});

test("a stale claim finds a previously accepted job and an unresolved submission blocks overlap", async () => {
  const f = fixture();
  try {
    const schedule = f.add({ enabled: true });
    const execution = f.claim(schedule);
    f.advance(61_000);
    await f.control.tick();
    assert.equal(f.control.store.execution(execution.id)?.status, "reconciling");
    assert.equal(f.submissions.length, 0);
    f.advance(24 * 60 * 60_000);
    await f.control.tick();
    assert.equal(f.submissions.length, 0);
    assert.equal(f.control.store.lastExecution(schedule.id)?.status, "skipped");
    f.job({ trigger: "schedule", scheduleId: schedule.id, scheduledFor: execution.scheduledFor,
      portalMessageCount: 0, idempotencyKey: f.lookups[0]!.idempotencyKey! });
    await f.control.tick();
    assert.equal(f.control.store.execution(execution.id)?.status, "completed");
  } finally { f.close(); }
});

test("a scheduled job fetches new published code, and fetch failure never submits stale code", async () => {
  const f = fixture();
  try {
    const schedule = f.add({ enabled: true });
    const old = f.git("rev-parse", "refs/remotes/origin/main");
    writeFileSync(join(f.repository, "README.md"), "v2\n");
    f.git("commit", "-am", "v2");
    const latest = f.git("rev-parse", "HEAD");
    f.git("push", "origin", "main");
    // Model a publish from a different checkout: local remote-tracking ref is still old.
    f.git("update-ref", "refs/remotes/origin/main", old);
    await f.control.tick();
    assert.equal(f.jobs[0]?.revision, latest);
    f.jobs[0]!.status = "completed";
    rmSync(f.remote, { recursive: true, force: true });
    f.advance(24 * 60 * 60_000);
    await f.control.tick();
    assert.equal(f.submissions.length, 1);
    assert.equal(f.control.store.lastExecution(schedule.id)?.status, "failed");
  } finally { f.close(); }
});

test("definitive submission rejection is terminal while an ambiguous transport failure is not", async () => {
  const f = fixture();
  try {
    const schedule = f.add({ enabled: true });
    f.runner.submit = async () => { throw new ProjectRunnerClientError("invalid project config", 400); };
    await f.control.tick();
    assert.equal(f.control.store.lastExecution(schedule.id)?.status, "failed");
    assert.match(f.notices[0]!, /invalid project config/);
  } finally { f.close(); }
});

test("migration snapshots legacy executions and removes cascade deletion without losing history", () => {
  const f = fixture();
  try {
    const schedule = f.add();
    const execution = f.claim(schedule);
    f.control.close();
    const db = new DatabaseSync(join(f.root, "control.db"));
    db.exec(`
      ALTER TABLE runner_schedule_executions RENAME TO new_executions;
      DROP INDEX runner_schedule_executions_scope;
      DROP INDEX runner_schedule_executions_active;
      CREATE TABLE runner_schedule_executions (
        id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES runner_schedules(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, occurrence_key TEXT NOT NULL,
        scheduled_for TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('claimed','queued','running','cancelling','completed','cancelled','failed','skipped')),
        job_id TEXT, revision TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(schedule_id, occurrence_key)
      );
      INSERT INTO runner_schedule_executions SELECT id, schedule_id, project_id, workspace_id,
        occurrence_key, scheduled_for, status, job_id, revision, reason, created_at, updated_at FROM new_executions;
      DROP TABLE new_executions;
    `);
    db.close();
    // Recreate directly because the original handle is already closed.
    Object.assign(f.control, { store: new RunnerControlStore(join(f.root, "control.db")) });
    const migrated = f.control.store.execution(execution.id)!;
    assert.equal(migrated.scheduleSnapshot.id, schedule.id);
    assert.equal(migrated.submission, null);
    const plan = f.control.planSchedule(f.ctx("delete"), { operation: "delete", scheduleId: schedule.id });
    f.control.applySchedule(f.ctx("confirmed"), plan.token);
    assert.ok(f.control.store.execution(execution.id));
  } finally { f.close(); }
});

test("slow delivery leaves periodic scheduling free to enqueue another due occurrence", async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const schedule = f.add({ deliveryTopic: "10" });
    f.claim(schedule, f.job());
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    Object.assign(f.control, { deliverScheduledPortalMessages: async () => {
      started(); await blocked; return true;
    } });
    await f.control.tick(false);
    await entered;
    f.add({ enabled: true });
    await f.control.tick(false);
    assert.equal(f.submissions.length, 1);
    release();
    await f.control.stopAndWait();
  } finally { release(); await f.control.stopAndWait(); f.close(); }
});

test("a changed enabled-schedule snapshot cannot claim a new occurrence after pause or delete", () => {
  const f = fixture();
  try {
    const schedule = f.add({ enabled: true });
    f.control.setScheduleEnabled(f.ctx("pause"), schedule.id, false);
    assert.equal(f.control.store.claimExecution(schedule,
      { key: "2026-09-08T08:00@UTC", scheduledFor: new Date(f.now).toISOString() }, f.now, true), null);
    const remove = f.control.planSchedule(f.ctx("remove"), { operation: "delete", scheduleId: schedule.id });
    f.control.applySchedule(f.ctx("confirmed"), remove.token);
    assert.equal(f.control.store.claimExecution(schedule,
      { key: "2026-09-08T08:00@UTC", scheduledFor: new Date(f.now).toISOString() }, f.now, true), null);
  } finally { f.close(); }
});

test("a conflicting job with the same key is not attached to the execution", async () => {
  const f = fixture();
  try {
    const schedule = f.add({ enabled: true });
    const submit = f.runner.submit.bind(f.runner);
    f.runner.submit = async (...args) => { await submit(...args); throw new Error("response lost"); };
    await f.control.tick();
    const execution = f.control.store.lastExecution(schedule.id)!;
    f.jobs[0]!.revision = "b".repeat(40);
    await f.control.tick();
    assert.equal(f.control.store.execution(execution.id)?.status, "reconciling");
    assert.equal(f.control.store.execution(execution.id)?.jobId, null);
    assert.equal(f.submissions.length, 1);
  } finally { f.close(); }
});

test("manual started notifications survive restart before handoff and are not repeated after completion", async () => {
  const f = fixture();
  try {
    const job = f.job({ status: "running", action: "validate", portalMessageCount: 0 });
    f.control.store.watchJob(f.ctx("start"), job, f.now,
      [{ chatId: -100500, topicId: 10, when: "started", text: "Started" }]);
    // No call to the notification callback occurred before the process restarted.
    f.reopen();
    await f.control.tick();
    assert.deepEqual(f.notifications.map((item) => item.text), ["Started"]);
    job.status = "completed";
    await f.control.tick();
    f.reopen();
    await f.control.tick();
    assert.equal(f.notifications.length, 1);
    assert.equal(f.notices.length, 1);
  } finally { f.close(); }
});

test("new and resumed schedules run future occurrences unless catch-up is explicitly selected", async () => {
  const f = fixture();
  try {
    f.advance(10 * 60_000);
    f.add({ enabled: true });
    await f.control.tick();
    assert.equal(f.submissions.length, 0, "creation at 08:10 must not launch 08:00");
    const paused = f.add({ enabled: false });
    f.control.setScheduleEnabled(f.ctx("resume"), paused.id, true);
    await f.control.tick();
    assert.equal(f.submissions.length, 0, "resume must not launch a past occurrence");
    f.control.setScheduleEnabled(f.ctx("pause"), paused.id, false);
    f.control.setScheduleEnabled(f.ctx("explicit-catch-up"), paused.id, true, true);
    await f.control.tick();
    assert.equal(f.submissions.length, 1);
    assert.equal(f.submissions[0]?.scheduledFor, "2026-09-08T08:00:00.000Z");
    const plan = f.control.planSchedule(f.ctx("preview"), { operation: "upsert", name: "Preview",
      action: "run", time: "09:00", timeZone: "UTC", weekdays: [1, 3], notifications: [
        { chatId: -100500, topicId: 77, when: "finished", text: "Exact report text" },
      ] });
    assert.match(plan.summary, /пн, ср/);
    assert.match(plan.summary, /Следующие времена/);
    assert.match(plan.summary, /без прошлых запусков/);
    assert.match(plan.summary, /Exact report text/);
    assert.match(plan.summary, /-100500\/77/);
    const catchUpPlan = f.control.planSchedule(f.ctx("catch-up-preview"), { operation: "upsert", name: "Catch up",
      action: "run", time: "08:00", timeZone: "UTC", catchUp: true });
    assert.match(catchUpPlan.summary, /допустим также запуск за .*08:00/);
    assert.doesNotMatch(plan.summary, /допустим также/);
  } finally { f.close(); }
});

test("offline occurrences outside grace are recorded once and survive restart", async () => {
  const f = fixture();
  try {
    const schedule = f.add({ enabled: true });
    Object.assign(f.runner, { available: async () => false });
    f.advance(2 * 60 * 60_000);
    await f.control.tick();
    assert.equal(f.control.store.lastExecution(schedule.id)?.status, "skipped");
    assert.match(f.control.store.lastExecution(schedule.id)?.reason ?? "", /30 мин/);
    f.reopen();
    await f.control.tick();
    assert.equal(f.control.store.recentExecutions("demo", "repo").length, 1);
    assert.equal(f.submissions.length, 0);
  } finally { f.close(); }
});

test("an operator can close an unconfirmed occurrence only after an online check and explicit risk acknowledgement", async () => {
  const f = fixture();
  try {
    const schedule = f.add({ enabled: true });
    const execution = f.claim(schedule);
    await assert.rejects(f.control.resolveExecution({ ...f.ctx("wrong-scope"), workspaceId: "other" }, execution.id, "check"), /not found/);
    await assert.rejects(f.control.resolveExecution(f.ctx("too-early"), execution.id, "close_unconfirmed", "Investigated", true), /two minutes/);
    f.advance(121_000);
    await f.control.tick();
    await assert.rejects(f.control.resolveExecution(f.ctx("no-ack"), execution.id, "close_unconfirmed", "Investigated"), /acknowledgement/);
    Object.assign(f.runner, { available: async () => false });
    await assert.rejects(f.control.resolveExecution(f.ctx("offline"), execution.id, "close_unconfirmed", "Investigated", true), /available/);
    Object.assign(f.runner, { available: async () => true });
    assert.equal((await f.control.resolveExecution(f.ctx("check"), execution.id, "check")).status, "reconciling");
    const closed = await f.control.resolveExecution(f.ctx("close", 43), execution.id, "close_unconfirmed", "Проверил журнал раннера", true);
    assert.equal(closed.status, "failed");
    assert.match(closed.reason ?? "", /43.*Проверил журнал/);
    assert.equal(f.submissions.length, 0);
    f.advance(24 * 60 * 60_000);
    await f.control.tick();
    assert.equal(f.submissions.length, 1, "future occurrences are unblocked without replaying the original");
  } finally { f.close(); }
});

test("operator resolution attaches a found job instead of closing it", async () => {
  const f = fixture();
  try {
    const schedule = f.add();
    const execution = f.claim(schedule);
    f.advance(121_000);
    await f.control.tick();
    const accepted = f.job({ trigger: "schedule", scheduleId: schedule.id, scheduledFor: execution.scheduledFor,
      idempotencyKey: f.lookups[0]!.idempotencyKey!, status: "running" });
    const found = await f.control.resolveExecution(f.ctx("close"), execution.id, "close_unconfirmed", "Investigated", true);
    assert.equal(found.jobId, accepted.id);
    assert.equal(found.status, "running");
    assert.equal(f.submissions.length, 0);
  } finally { f.close(); }
});

test("service monitoring reports sustained failures and recovery once, persists across restart, and preserves offline snapshots", async () => {
  const f = fixture();
  let status: RunnerService["status"] = "running";
  try {
    Object.assign(f.control.projects, { all: () => [{ project: { id: "demo", workspaces: new Map([["repo", {}]]) } }] });
    Object.assign(f.runner, { services: async (): Promise<RunnerService[]> => [{ projectId: "demo", workspaceId: "repo",
      name: "worker", desiredState: "running", status, current: null, previous: null, localEndpoint: null,
      updatedAt: new Date(f.now).toISOString(), restartCount: 3 }] });
    const job = f.job({ status: "queued", portalMessageCount: 0 });
    f.control.store.watchJob(f.ctx("queued", 43), job, f.now);
    f.advance(120_000);
    await f.control.monitor(); await f.control.tick();
    assert.equal(f.notices.length, 0);
    const snapshot = f.control.operationsOverview("demo", "repo");
    assert.equal(snapshot.jobs[0]?.initiatedBy, 43);
    assert.equal(snapshot.jobs[0]?.waitSeconds, 120);
    assert.equal(snapshot.services[0]?.restartCount, 3);
    status = "failed";
    await f.control.monitor(); await f.control.tick();
    assert.equal(f.notices.length, 0, "a single failed sample must not alert");
    f.advance(30_000);
    await f.control.monitor(); await f.control.tick();
    assert.equal(f.notices.length, 1);
    f.reopen();
    await f.control.monitor(); await f.control.tick();
    assert.equal(f.notices.length, 1, "restart must not repeat an unchanged failure");
    status = "running";
    await f.control.monitor(); await f.control.tick();
    assert.equal(f.notices.length, 2);
    assert.match(f.notices[1]!, /снова работает/);
    Object.assign(f.runner, { available: async () => false });
    await f.control.monitor();
    const offline = f.control.operationsOverview("demo", "repo");
    assert.equal(offline.available, false);
    assert.ok(offline.lastSuccessAt);
    assert.equal(offline.services.length, 1);
    assert.equal(f.control.operationsOverview("other", "repo").services.length, 0);
  } finally { f.close(); }
});

test("operations overview explains a cleanup block even when execution slots are free", async () => {
  const f = fixture();
  try {
    Object.assign(f.control.projects, { all: () => [{ project: { id: "demo", workspaces: new Map([["repo", {}]]) } }] });
    let blockedProjects = ["demo"];
    Object.assign(f.runner, {
      services: async () => [],
      health: async () => ({ ok: true, running: 0, maxParallelJobs: 2, blockedProjects }),
    });
    f.job({ status: "queued" });
    await f.control.monitor();
    assert.match(f.control.operationsOverview("demo", "repo").jobs[0]?.queueReason ?? "", /остановки предыдущего контейнера/);
    blockedProjects = [];
    await f.control.monitor();
    assert.doesNotMatch(f.control.operationsOverview("demo", "repo").jobs[0]?.queueReason ?? "", /предыдущего контейнера/);
  } finally { f.close(); }
});
