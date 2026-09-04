import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GitInspector } from "./git-inspector.js";
import { ProjectCatalog } from "./project-catalog.js";
import {
  ProjectRunnerClient,
  type RunnerAction,
  type RunnerArtifact,
  type RunnerArtifactDeletion,
  type RunnerHealth,
  type RunnerJob,
  type RunnerSchedulableAction,
  type RunnerService,
  type RunnerServiceAction,
} from "./project-runner-client.js";

const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "cancelling"]);
const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "cancelled", "failed", "skipped"]);
const SCHEDULE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()\-]{0,79}$/u;
const SCHEDULE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAXIMUM_ARTIFACT_TOOL_CHARACTERS = 64_000;
const MAXIMUM_LOG_TOOL_CHARACTERS = 64_000;
const MANUAL_JOB_TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed", "interrupted"]);

type Row = Record<string, unknown>;

function deliveryConditionMatches(
  condition: RunnerDeliveryCondition,
  status: RunnerScheduleExecutionStatus,
): boolean {
  if (condition === "always") {
    return status === "completed" || status === "failed" || status === "cancelled";
  }
  if (condition === "success") return status === "completed";
  return status === "failed" || status === "cancelled";
}

export interface RunnerControlContext {
  projectId: string;
  workspaceId: string;
  repositoryPath: string;
  conversationId: string;
  actorUserId: number;
  turnId: string;
}

export interface RunnerScheduleDestination {
  chatId: number;
  topicId: number;
  label: string;
}

export type RunnerNotificationWhen = "started" | "succeeded" | "failed" | "finished";

export interface RunnerLifecycleNotification {
  chatId: number;
  topicId: number;
  when: RunnerNotificationWhen;
  text: string;
}

export type RunnerDeliveryCondition = "success" | "failure" | "always";

export interface RunnerSchedule {
  id: string;
  projectId: string;
  workspaceId: string;
  name: string;
  action: RunnerSchedulableAction;
  time: string;
  timeZone: string;
  weekdays: number[];
  enabled: boolean;
  // Legacy persisted selector; execution resolves the repository's published default branch.
  revisionRef: "master";
  overlapPolicy: "skip";
  misfireGraceMinutes: number;
  delivery: RunnerScheduleDestination | null;
  deliveryCondition: RunnerDeliveryCondition;
  notifications: RunnerLifecycleNotification[];
  originConversationId: string;
  createdBy: number;
  updatedBy: number;
  createdAt: string;
  updatedAt: string;
}

export type RunnerScheduleExecutionStatus =
  | "claimed"
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "skipped";

export interface RunnerScheduleExecution {
  id: string;
  scheduleId: string;
  projectId: string;
  workspaceId: string;
  occurrenceKey: string;
  scheduledFor: string;
  status: RunnerScheduleExecutionStatus;
  jobId: string | null;
  revision: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SchedulePlanPayload {
  operation: "upsert" | "delete";
  schedule?: RunnerSchedule;
  scheduleId?: string;
}

export interface ArtifactPlanTarget {
  jobId: string;
  name: string;
}

interface ArtifactPlanPayload {
  targets: ArtifactPlanTarget[];
}

export interface SchedulePlanInput {
  operation: "upsert" | "delete";
  scheduleId?: string;
  name?: string;
  action?: RunnerSchedulableAction;
  time?: string;
  timeZone?: string;
  weekdays?: number[];
  enabled?: boolean;
  misfireGraceMinutes?: number;
  deliveryTopic?: string;
  clearDeliveryTopic?: boolean;
  deliveryCondition?: RunnerDeliveryCondition;
  notifications?: RunnerLifecycleNotification[];
  clearNotifications?: boolean;
}

export interface SchedulePlan {
  token: string;
  summary: string;
  expiresAt: string;
}

export interface ArtifactDeletionPlan extends SchedulePlan {
  targets: ArtifactPlanTarget[];
}

export interface ArtifactDeletionResult {
  deleted: RunnerArtifactDeletion[];
  failed: Array<ArtifactPlanTarget & { error: string }>;
}

export interface RunnerScheduleView extends RunnerSchedule {
  nextRunAt: string | null;
  lastExecution: RunnerScheduleExecution | null;
}

export interface RunnerInspection {
  available: boolean;
  health: RunnerHealth | null;
  overview: {
    state: "unavailable" | "idle" | "queued" | "running";
    summary: string;
    activeCount: number;
    queuedCount: number;
    runningServiceCount: number;
    unhealthyServiceCount: number;
    enabledScheduleCount: number;
    nextScheduledAt: string | null;
    lastResult: RunnerJob | null;
  };
  active: RunnerJob[];
  queued: RunnerJob[];
  recent: RunnerJob[];
  services: RunnerService[];
  schedules: RunnerScheduleView[];
  artifacts: Array<{ jobId: string; action: RunnerAction; count: number; createdAt: string }>;
  capabilities: RunnerAction[];
}

export interface RunnerArtifactView {
  job: RunnerJob;
  artifacts: RunnerArtifact[];
}

interface RunnerJobWatch {
  jobId: string;
  projectId: string;
  workspaceId: string;
  conversationId: string;
  actorUserId: number;
  action: RunnerAction;
  lastStatus: RunnerJob["status"];
  createdAt: string;
  updatedAt: string;
  notifiedAt: string | null;
  notifications: RunnerLifecycleNotification[];
}

export class RunnerControlError extends Error {}

function iso(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}

function idempotencyKey(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function manualJobNotification(job: RunnerJob): string {
  const target = `Ручной запуск «${job.action}${job.provisionId ? `:${job.provisionId}` : ""}» (${job.id})`;
  if (job.status === "completed") return `${target} завершён успешно.`;
  if (job.status === "cancelled") return `${target} отменён.`;
  if (job.status === "interrupted") {
    return `${target} прерван из-за перезапуска раннера и не был перезапущен автоматически.`;
  }
  return `${target} завершился с ошибкой${job.error ? `: ${job.error}` : "."}`;
}

function parseJson<T>(value: unknown, field: string): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    throw new RunnerControlError(`${field} is malformed`);
  }
}

function validateTimeZone(value: unknown): string {
  const timeZone = String(value ?? "").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new RunnerControlError("timeZone must be a valid IANA time zone");
  }
  return timeZone;
}

function validateWeekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RunnerControlError("weekdays must contain at least one ISO weekday");
  }
  const weekdays = [...new Set(value.map(Number))].sort((left, right) => left - right);
  if (weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new RunnerControlError("weekdays must contain integers from 1 (Monday) to 7 (Sunday)");
  }
  return weekdays;
}

function validateLifecycleNotifications(value: unknown): RunnerLifecycleNotification[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) {
    throw new RunnerControlError("notifications must contain at most 12 items");
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RunnerControlError("notification must be an object");
    }
    const input = item as Record<string, unknown>;
    const chatId = Number(input.chatId);
    const topicId = Number(input.topicId);
    const when = String(input.when ?? "") as RunnerNotificationWhen;
    const text = String(input.text ?? "").trim();
    if (!Number.isSafeInteger(chatId) || chatId === 0) {
      throw new RunnerControlError("notification chatId must be a non-zero safe integer");
    }
    if (!Number.isSafeInteger(topicId) || topicId < 0) {
      throw new RunnerControlError("notification topicId must be a non-negative safe integer");
    }
    if (!(new Set<RunnerNotificationWhen>([
      "started",
      "succeeded",
      "failed",
      "finished",
    ])).has(when)) {
      throw new RunnerControlError(
        "notification when must be started, succeeded, failed, or finished",
      );
    }
    if (!text || Array.from(text).length > 3_500) {
      throw new RunnerControlError("notification text must contain 1-3500 characters");
    }
    return { chatId, topicId, when, text };
  });
}

function terminalNotificationKinds(job: RunnerJob): RunnerNotificationWhen[] {
  return job.status === "completed"
    ? ["succeeded", "finished"]
    : ["failed", "finished"];
}

function scheduleParts(epochMilliseconds: number, timeZone: string): {
  date: string;
  time: string;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(epochMilliseconds).map((part) => [part.type, part.value]),
  );
  const weekday = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as const)[
    parts.weekday as keyof { Mon: 1; Tue: 2; Wed: 3; Thu: 4; Fri: 5; Sat: 6; Sun: 7 }
  ];
  if (!weekday || !parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute) {
    throw new RunnerControlError(`cannot resolve local time in ${timeZone}`);
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday,
  };
}

function occurrenceAt(schedule: RunnerSchedule, epochMilliseconds: number): {
  key: string;
  scheduledFor: string;
} | null {
  const minute = Math.floor(epochMilliseconds / 60_000) * 60_000;
  const parts = scheduleParts(minute, schedule.timeZone);
  if (parts.time !== schedule.time || !schedule.weekdays.includes(parts.weekday)) return null;
  return {
    key: `${parts.date}T${parts.time}@${schedule.timeZone}`,
    scheduledFor: iso(minute),
  };
}

export function dueScheduleOccurrence(
  schedule: RunnerSchedule,
  nowMilliseconds: number,
): { key: string; scheduledFor: string } | null {
  for (let offset = 0; offset <= schedule.misfireGraceMinutes; offset += 1) {
    const occurrence = occurrenceAt(schedule, nowMilliseconds - offset * 60_000);
    if (occurrence) return occurrence;
  }
  return null;
}

export function nextScheduleOccurrence(
  schedule: RunnerSchedule,
  nowMilliseconds: number,
): string | null {
  const start = Math.floor(nowMilliseconds / 60_000) * 60_000 + 60_000;
  for (let offset = 0; offset <= 8 * 24 * 60; offset += 1) {
    const occurrence = occurrenceAt(schedule, start + offset * 60_000);
    if (occurrence) return occurrence.scheduledFor;
  }
  return null;
}

export class RunnerControlStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    this.createSchema();
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runner_schedules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('build', 'validate', 'dry-run', 'run')),
        local_time TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        weekdays_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        revision_ref TEXT NOT NULL CHECK(revision_ref = 'master'),
        overlap_policy TEXT NOT NULL CHECK(overlap_policy = 'skip'),
        misfire_grace_minutes INTEGER NOT NULL CHECK(misfire_grace_minutes BETWEEN 0 AND 1440),
        delivery_chat_id INTEGER,
        delivery_topic_id INTEGER,
        delivery_label TEXT NOT NULL DEFAULT '',
        delivery_condition TEXT NOT NULL DEFAULT 'success'
          CHECK(delivery_condition IN ('success', 'failure', 'always')),
        notifications_json TEXT NOT NULL DEFAULT '[]',
        origin_conversation_id TEXT NOT NULL DEFAULT '',
        created_by INTEGER NOT NULL,
        updated_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, workspace_id, name)
      );
      CREATE INDEX IF NOT EXISTS runner_schedules_scope
        ON runner_schedules(project_id, workspace_id, enabled, name);
      CREATE TABLE IF NOT EXISTS runner_schedule_executions (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES runner_schedules(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN
          ('claimed', 'queued', 'running', 'cancelling', 'completed', 'cancelled', 'failed', 'skipped')),
        job_id TEXT,
        revision TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(schedule_id, occurrence_key)
      );
      CREATE INDEX IF NOT EXISTS runner_schedule_executions_scope
        ON runner_schedule_executions(project_id, workspace_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS runner_schedule_executions_active
        ON runner_schedule_executions(status, updated_at);
      CREATE TABLE IF NOT EXISTS runner_control_plans (
        token TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        actor_user_id INTEGER NOT NULL,
        created_turn_id TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS runner_control_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        actor_user_id INTEGER NOT NULL,
        turn_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runner_control_audit_scope
        ON runner_control_audit(project_id, workspace_id, created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS runner_job_watches (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        actor_user_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('build', 'validate', 'dry-run', 'run', 'provision')),
        last_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        notified_at TEXT,
        notifications_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS runner_job_watches_pending
        ON runner_job_watches(notified_at, project_id, workspace_id, created_at);
      CREATE TABLE IF NOT EXISTS runner_artifact_plans (
        token TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        actor_user_id INTEGER NOT NULL,
        created_turn_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        applying_at TEXT,
        consumed_at TEXT
      );
    `);
    const planColumns = this.db.prepare("PRAGMA table_info(runner_control_plans)").all() as Row[];
    if (!planColumns.some((column) => column.name === "created_turn_id")) {
      this.db.exec(
        "ALTER TABLE runner_control_plans ADD COLUMN created_turn_id TEXT NOT NULL DEFAULT ''",
      );
    }
    const watchColumns = this.db.prepare("PRAGMA table_info(runner_job_watches)").all() as Row[];
    if (!watchColumns.some((column) => column.name === "actor_user_id")) {
      this.db.exec(
        "ALTER TABLE runner_job_watches ADD COLUMN actor_user_id INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!watchColumns.some((column) => column.name === "notifications_json")) {
      this.db.exec(
        "ALTER TABLE runner_job_watches ADD COLUMN notifications_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    const watchSchema = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runner_job_watches'",
    ).get() as Row | undefined;
    if (!String(watchSchema?.sql ?? "").includes("'provision'")) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE runner_job_watches RENAME TO runner_job_watches_legacy;
        DROP INDEX IF EXISTS runner_job_watches_pending;
        CREATE TABLE runner_job_watches (
          job_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          actor_user_id INTEGER NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('build', 'validate', 'dry-run', 'run', 'provision')),
          last_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          notified_at TEXT,
          notifications_json TEXT NOT NULL DEFAULT '[]'
        );
        INSERT INTO runner_job_watches
          (job_id, project_id, workspace_id, conversation_id, actor_user_id, action,
           last_status, created_at, updated_at, notified_at, notifications_json)
        SELECT job_id, project_id, workspace_id, conversation_id, actor_user_id, action,
               last_status, created_at, updated_at, notified_at,
               COALESCE(notifications_json, '[]')
        FROM runner_job_watches_legacy;
        DROP TABLE runner_job_watches_legacy;
        CREATE INDEX runner_job_watches_pending
          ON runner_job_watches(notified_at, project_id, workspace_id, created_at);
        COMMIT;
      `);
    }
    const scheduleColumns = this.db.prepare("PRAGMA table_info(runner_schedules)").all() as Row[];
    if (!scheduleColumns.some((column) => column.name === "delivery_chat_id")) {
      this.db.exec("ALTER TABLE runner_schedules ADD COLUMN delivery_chat_id INTEGER");
    }
    if (!scheduleColumns.some((column) => column.name === "delivery_topic_id")) {
      this.db.exec("ALTER TABLE runner_schedules ADD COLUMN delivery_topic_id INTEGER");
    }
    if (!scheduleColumns.some((column) => column.name === "delivery_label")) {
      this.db.exec(
        "ALTER TABLE runner_schedules ADD COLUMN delivery_label TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!scheduleColumns.some((column) => column.name === "delivery_condition")) {
      this.db.exec(
        "ALTER TABLE runner_schedules ADD COLUMN delivery_condition TEXT NOT NULL DEFAULT 'success' " +
          "CHECK(delivery_condition IN ('success', 'failure', 'always'))",
      );
    }
    if (!scheduleColumns.some((column) => column.name === "notifications_json")) {
      this.db.exec(
        "ALTER TABLE runner_schedules ADD COLUMN notifications_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    if (!scheduleColumns.some((column) => column.name === "origin_conversation_id")) {
      this.db.exec(
        "ALTER TABLE runner_schedules ADD COLUMN origin_conversation_id TEXT NOT NULL DEFAULT ''",
      );
    }
  }

  schedules(projectId?: string, workspaceId?: string): RunnerSchedule[] {
    const rows = projectId && workspaceId
      ? this.db.prepare(`
          SELECT * FROM runner_schedules
          WHERE project_id = ? AND workspace_id = ? ORDER BY name, id
        `).all(projectId, workspaceId) as Row[]
      : this.db.prepare("SELECT * FROM runner_schedules ORDER BY project_id, workspace_id, name").all() as Row[];
    return rows.map((row) => this.toSchedule(row));
  }

  enabledSchedules(): RunnerSchedule[] {
    return (this.db.prepare(
      "SELECT * FROM runner_schedules WHERE enabled = 1 ORDER BY project_id, workspace_id, name",
    ).all() as Row[]).map((row) => this.toSchedule(row));
  }

  schedule(id: string, projectId: string, workspaceId: string): RunnerSchedule | null {
    const row = this.db.prepare(`
      SELECT * FROM runner_schedules WHERE id = ? AND project_id = ? AND workspace_id = ?
    `).get(id, projectId, workspaceId) as Row | undefined;
    return row ? this.toSchedule(row) : null;
  }

  savePlan(
    context: RunnerControlContext,
    payload: SchedulePlanPayload,
    summary: string,
    nowMilliseconds: number,
  ): SchedulePlan {
    const token = randomUUID();
    const expiresAt = iso(nowMilliseconds + 15 * 60_000);
    this.db.prepare(`
      INSERT INTO runner_control_plans
        (token, project_id, workspace_id, actor_user_id, created_turn_id,
         payload_json, summary, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      token,
      context.projectId,
      context.workspaceId,
      context.actorUserId,
      context.turnId,
      JSON.stringify(payload),
      summary,
      iso(nowMilliseconds),
      expiresAt,
    );
    return { token, summary, expiresAt };
  }

  applyPlan(
    context: RunnerControlContext,
    token: string,
    nowMilliseconds: number,
  ): RunnerSchedule | null {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM runner_control_plans
        WHERE token = ? AND project_id = ? AND workspace_id = ? AND actor_user_id = ?
      `).get(token, context.projectId, context.workspaceId, context.actorUserId) as Row | undefined;
      if (!row) throw new RunnerControlError("schedule confirmation token was not found in this scope");
      if (row.consumed_at !== null) throw new RunnerControlError("schedule confirmation token was already used");
      if (String(row.created_turn_id) === context.turnId) {
        throw new RunnerControlError(
          "schedule changes require explicit user confirmation in a later message",
        );
      }
      if (Date.parse(String(row.expires_at)) < nowMilliseconds) {
        throw new RunnerControlError("schedule confirmation token expired");
      }
      const payload = parseJson<SchedulePlanPayload>(row.payload_json, "schedule plan");
      let result: RunnerSchedule | null;
      if (payload.operation === "delete") {
        const scheduleId = String(payload.scheduleId ?? "");
        const removed = this.db.prepare(`
          DELETE FROM runner_schedules WHERE id = ? AND project_id = ? AND workspace_id = ?
        `).run(scheduleId, context.projectId, context.workspaceId);
        if (Number(removed.changes) !== 1) throw new RunnerControlError("schedule no longer exists");
        result = null;
      } else {
        if (!payload.schedule) throw new RunnerControlError("schedule plan has no schedule");
        const schedule = payload.schedule;
        this.db.prepare(`
          INSERT INTO runner_schedules
            (id, project_id, workspace_id, name, action, local_time, time_zone,
             weekdays_json, enabled, revision_ref, overlap_policy, misfire_grace_minutes,
             delivery_chat_id, delivery_topic_id, delivery_label, delivery_condition,
             notifications_json, origin_conversation_id, created_by, updated_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            action = excluded.action,
            local_time = excluded.local_time,
            time_zone = excluded.time_zone,
            weekdays_json = excluded.weekdays_json,
            enabled = excluded.enabled,
            revision_ref = excluded.revision_ref,
            overlap_policy = excluded.overlap_policy,
            misfire_grace_minutes = excluded.misfire_grace_minutes,
            delivery_chat_id = excluded.delivery_chat_id,
            delivery_topic_id = excluded.delivery_topic_id,
            delivery_label = excluded.delivery_label,
            delivery_condition = excluded.delivery_condition,
            notifications_json = excluded.notifications_json,
            origin_conversation_id = excluded.origin_conversation_id,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
          WHERE runner_schedules.project_id = excluded.project_id
            AND runner_schedules.workspace_id = excluded.workspace_id
        `).run(
          schedule.id,
          schedule.projectId,
          schedule.workspaceId,
          schedule.name,
          schedule.action,
          schedule.time,
          schedule.timeZone,
          JSON.stringify(schedule.weekdays),
          schedule.enabled ? 1 : 0,
          schedule.revisionRef,
          schedule.overlapPolicy,
          schedule.misfireGraceMinutes,
          schedule.delivery?.chatId ?? null,
          schedule.delivery?.topicId ?? null,
          schedule.delivery?.label ?? "",
          schedule.deliveryCondition,
          JSON.stringify(schedule.notifications),
          schedule.originConversationId === undefined
            ? context.conversationId
            : schedule.originConversationId,
          schedule.createdBy,
          schedule.updatedBy,
          schedule.createdAt,
          schedule.updatedAt,
        );
        result = this.schedule(schedule.id, schedule.projectId, schedule.workspaceId);
        if (!result) throw new RunnerControlError("schedule could not be stored");
      }
      this.db.prepare(
        "UPDATE runner_control_plans SET consumed_at = ? WHERE token = ?",
      ).run(iso(nowMilliseconds), token);
      return result;
    });
  }

  saveArtifactPlan(
    context: RunnerControlContext,
    targets: ArtifactPlanTarget[],
    summary: string,
    nowMilliseconds: number,
  ): ArtifactDeletionPlan {
    const token = randomUUID();
    const expiresAt = iso(nowMilliseconds + 15 * 60_000);
    this.db.prepare(`
      INSERT INTO runner_artifact_plans
        (token, project_id, workspace_id, actor_user_id, created_turn_id,
         payload_json, summary, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      token,
      context.projectId,
      context.workspaceId,
      context.actorUserId,
      context.turnId,
      JSON.stringify({ targets } satisfies ArtifactPlanPayload),
      summary,
      iso(nowMilliseconds),
      expiresAt,
    );
    return { token, summary, expiresAt, targets };
  }

  claimArtifactPlan(
    context: RunnerControlContext,
    token: string,
    nowMilliseconds: number,
  ): ArtifactPlanTarget[] {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM runner_artifact_plans
        WHERE token = ? AND project_id = ? AND workspace_id = ? AND actor_user_id = ?
      `).get(token, context.projectId, context.workspaceId, context.actorUserId) as Row | undefined;
      if (!row) throw new RunnerControlError("artifact confirmation token was not found in this scope");
      if (row.consumed_at !== null) {
        throw new RunnerControlError("artifact confirmation token was already used");
      }
      if (row.applying_at !== null) {
        throw new RunnerControlError("artifact confirmation token is already being applied");
      }
      if (String(row.created_turn_id) === context.turnId) {
        throw new RunnerControlError(
          "artifact deletion requires explicit user confirmation in a later message",
        );
      }
      if (Date.parse(String(row.expires_at)) < nowMilliseconds) {
        throw new RunnerControlError("artifact confirmation token expired");
      }
      const payload = parseJson<ArtifactPlanPayload>(row.payload_json, "artifact plan");
      if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
        throw new RunnerControlError("artifact plan has no targets");
      }
      this.db.prepare(`
        UPDATE runner_artifact_plans SET applying_at = ?
        WHERE token = ? AND applying_at IS NULL AND consumed_at IS NULL
      `).run(iso(nowMilliseconds), token);
      return payload.targets;
    });
  }

  completeArtifactPlan(token: string, nowMilliseconds: number): void {
    this.db.prepare(`
      UPDATE runner_artifact_plans
      SET consumed_at = ?, applying_at = NULL
      WHERE token = ? AND applying_at IS NOT NULL AND consumed_at IS NULL
    `).run(iso(nowMilliseconds), token);
  }

  setEnabled(
    id: string,
    projectId: string,
    workspaceId: string,
    enabled: boolean,
    actorUserId: number,
    nowMilliseconds: number,
  ): RunnerSchedule {
    const updated = this.db.prepare(`
      UPDATE runner_schedules SET enabled = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND workspace_id = ?
    `).run(enabled ? 1 : 0, actorUserId, iso(nowMilliseconds), id, projectId, workspaceId);
    if (Number(updated.changes) !== 1) throw new RunnerControlError("schedule was not found");
    return this.schedule(id, projectId, workspaceId)!;
  }

  claimExecution(
    schedule: RunnerSchedule,
    occurrence: { key: string; scheduledFor: string },
    nowMilliseconds: number,
  ): RunnerScheduleExecution | null {
    const id = randomUUID();
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO runner_schedule_executions
        (id, schedule_id, project_id, workspace_id, occurrence_key, scheduled_for,
         status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?)
    `).run(
      id,
      schedule.id,
      schedule.projectId,
      schedule.workspaceId,
      occurrence.key,
      occurrence.scheduledFor,
      iso(nowMilliseconds),
      iso(nowMilliseconds),
    );
    if (Number(inserted.changes) !== 1) return null;
    return this.execution(id)!;
  }

  updateExecution(
    id: string,
    status: RunnerScheduleExecutionStatus,
    values: { jobId?: string | null; revision?: string | null; reason?: string | null },
    nowMilliseconds: number,
  ): RunnerScheduleExecution {
    const current = this.execution(id);
    if (!current) throw new RunnerControlError("schedule execution was not found");
    this.db.prepare(`
      UPDATE runner_schedule_executions
      SET status = ?, job_id = ?, revision = ?, reason = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      values.jobId === undefined ? current.jobId : values.jobId,
      values.revision === undefined ? current.revision : values.revision,
      values.reason === undefined ? current.reason : values.reason,
      iso(nowMilliseconds),
      id,
    );
    return this.execution(id)!;
  }

  execution(id: string): RunnerScheduleExecution | null {
    const row = this.db.prepare(
      "SELECT * FROM runner_schedule_executions WHERE id = ?",
    ).get(id) as Row | undefined;
    return row ? this.toExecution(row) : null;
  }

  activeExecutions(): RunnerScheduleExecution[] {
    return (this.db.prepare(`
      SELECT * FROM runner_schedule_executions
      WHERE status IN ('claimed', 'queued', 'running', 'cancelling')
      ORDER BY created_at
    `).all() as Row[]).map((row) => this.toExecution(row));
  }

  watchJob(
    context: RunnerControlContext,
    job: RunnerJob,
    nowMilliseconds: number,
    notifications: RunnerLifecycleNotification[] = [],
  ): void {
    const timestamp = iso(nowMilliseconds);
    this.db.prepare(`
      INSERT OR IGNORE INTO runner_job_watches
        (job_id, project_id, workspace_id, conversation_id, actor_user_id, action,
         last_status, created_at, updated_at, notifications_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      context.projectId,
      context.workspaceId,
      context.conversationId,
      context.actorUserId,
      job.action,
      job.status,
      timestamp,
      timestamp,
      JSON.stringify(notifications),
    );
  }

  pendingJobWatches(): RunnerJobWatch[] {
    return (this.db.prepare(`
      SELECT * FROM runner_job_watches
      WHERE notified_at IS NULL
      ORDER BY created_at, job_id
    `).all() as Row[]).map((row) => ({
      jobId: String(row.job_id),
      projectId: String(row.project_id),
      workspaceId: String(row.workspace_id),
      conversationId: String(row.conversation_id),
      actorUserId: Number(row.actor_user_id),
      action: String(row.action) as RunnerAction,
      lastStatus: String(row.last_status) as RunnerJob["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      notifiedAt: row.notified_at === null ? null : String(row.notified_at),
      notifications: validateLifecycleNotifications(parseJson(row.notifications_json, "notifications")),
    }));
  }

  jobWatch(jobId: string): RunnerJobWatch | null {
    const row = this.db.prepare(
      "SELECT * FROM runner_job_watches WHERE job_id = ?",
    ).get(jobId) as Row | undefined;
    if (!row) return null;
    return {
      jobId: String(row.job_id),
      projectId: String(row.project_id),
      workspaceId: String(row.workspace_id),
      conversationId: String(row.conversation_id),
      actorUserId: Number(row.actor_user_id),
      action: String(row.action) as RunnerAction,
      lastStatus: String(row.last_status) as RunnerJob["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      notifiedAt: row.notified_at === null ? null : String(row.notified_at),
      notifications: validateLifecycleNotifications(parseJson(row.notifications_json, "notifications")),
    };
  }

  updateJobWatch(job: RunnerJob, nowMilliseconds: number): void {
    this.db.prepare(`
      UPDATE runner_job_watches SET last_status = ?, updated_at = ? WHERE job_id = ?
    `).run(job.status, iso(nowMilliseconds), job.id);
  }

  markJobWatchNotified(jobId: string, nowMilliseconds: number): void {
    const timestamp = iso(nowMilliseconds);
    this.db.prepare(`
      UPDATE runner_job_watches
      SET notified_at = ?, updated_at = ?
      WHERE job_id = ? AND notified_at IS NULL
    `).run(timestamp, timestamp, jobId);
  }

  lastExecution(scheduleId: string): RunnerScheduleExecution | null {
    const row = this.db.prepare(`
      SELECT * FROM runner_schedule_executions
      WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(scheduleId) as Row | undefined;
    return row ? this.toExecution(row) : null;
  }

  audit(
    context: RunnerControlContext,
    action: string,
    target: string,
    details: unknown,
    nowMilliseconds: number,
  ): void {
    this.db.prepare(`
      INSERT INTO runner_control_audit
        (project_id, workspace_id, actor_user_id, turn_id, action, target, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.projectId,
      context.workspaceId,
      context.actorUserId,
      context.turnId,
      action,
      target,
      JSON.stringify(details),
      iso(nowMilliseconds),
    );
  }

  private toSchedule(row: Row): RunnerSchedule {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      action: String(row.action) as RunnerSchedulableAction,
      time: String(row.local_time),
      timeZone: String(row.time_zone),
      weekdays: parseJson<number[]>(row.weekdays_json, "schedule weekdays"),
      enabled: Number(row.enabled) === 1,
      revisionRef: "master",
      overlapPolicy: "skip",
      misfireGraceMinutes: Number(row.misfire_grace_minutes),
      delivery: row.delivery_chat_id === null || row.delivery_topic_id === null
        ? null
        : {
            chatId: Number(row.delivery_chat_id),
            topicId: Number(row.delivery_topic_id),
            label: String(row.delivery_label || `topic ${String(row.delivery_topic_id)}`),
          },
      deliveryCondition: (["success", "failure", "always"] as const).includes(
        String(row.delivery_condition ?? "success") as RunnerDeliveryCondition,
      )
        ? String(row.delivery_condition ?? "success") as RunnerDeliveryCondition
        : "success",
      notifications: validateLifecycleNotifications(
        parseJson(row.notifications_json ?? "[]", "schedule notifications"),
      ),
      originConversationId: String(row.origin_conversation_id ?? ""),
      createdBy: Number(row.created_by),
      updatedBy: Number(row.updated_by),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private toExecution(row: Row): RunnerScheduleExecution {
    return {
      id: String(row.id),
      scheduleId: String(row.schedule_id),
      projectId: String(row.project_id),
      workspaceId: String(row.workspace_id),
      occurrenceKey: String(row.occurrence_key),
      scheduledFor: String(row.scheduled_for),
      status: String(row.status) as RunnerScheduleExecutionStatus,
      jobId: row.job_id === null ? null : String(row.job_id),
      revision: row.revision === null ? null : String(row.revision),
      reason: row.reason === null ? null : String(row.reason),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

export class RunnerControlPlane {
  readonly store: RunnerControlStore;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private scheduledTick: Promise<void> | null = null;

  constructor(
    storePath: string,
    readonly projects: ProjectCatalog,
    readonly runner: ProjectRunnerClient,
    readonly notify: (
      projectId: string,
      message: string,
      conversationId?: string,
    ) => Promise<void> = async () => {},
    readonly now: () => number = Date.now,
    readonly intervalMilliseconds = 15_000,
    readonly notifyPortalMessages: (
      job: RunnerJob,
      conversationId: string,
      authorizedUserId: number,
    ) => Promise<boolean> = async () => false,
    readonly deliverScheduledPortalMessages: (
      job: RunnerJob,
      schedule: RunnerSchedule,
    ) => Promise<boolean> = async () => false,
    readonly resolveScheduleDestination: (
      context: RunnerControlContext,
      query: string,
    ) => RunnerScheduleDestination = () => {
      throw new RunnerControlError("schedule delivery destination resolver is unavailable");
    },
    readonly validateLifecycleDestination: (
      context: Pick<RunnerControlContext, "projectId" | "workspaceId">,
      notification: RunnerLifecycleNotification,
    ) => void = () => {
      throw new RunnerControlError("external notification destination validator is unavailable");
    },
    readonly deliverLifecycleNotification: (
      job: RunnerJob,
      notification: RunnerLifecycleNotification,
      idempotencyKey: string,
      createdBy: number,
    ) => Promise<boolean> = async () => false,
  ) {
    this.store = new RunnerControlStore(storePath);
  }

  start(): void {
    if (this.timer) return;
    void this.runScheduledTick();
    this.timer = setInterval(() => void this.runScheduledTick(), this.intervalMilliseconds);
    this.timer.unref();
  }

  close(): void {
    this.stop();
    this.store.close();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    if (this.scheduledTick) await this.scheduledTick;
  }

  private runScheduledTick(): Promise<void> {
    if (this.scheduledTick) return this.scheduledTick;
    const pending = this.tick();
    this.scheduledTick = pending;
    void pending.finally(() => {
      if (this.scheduledTick === pending) this.scheduledTick = null;
    });
    return pending;
  }

  async inspect(context: RunnerControlContext): Promise<RunnerInspection> {
    const health = typeof this.runner.health === "function"
      ? await this.runner.health().catch(() => null)
      : null;
    const available = health?.ok === true || (health === null && await this.runner.available());
    const jobs = available
      ? await this.runner.jobs(context.projectId, context.workspaceId)
      : [];
    const services = available && typeof this.runner.services === "function"
      ? await this.runner.services(context.projectId, context.workspaceId)
      : [];
    const active = jobs.filter((job) => job.status === "running" || job.status === "cancelling");
    const queued = jobs.filter((job) => job.status === "queued");
    const schedules = this.store.schedules(context.projectId, context.workspaceId).map((schedule) => ({
      ...schedule,
      nextRunAt: schedule.enabled ? nextScheduleOccurrence(schedule, this.now()) : null,
      lastExecution: this.store.lastExecution(schedule.id),
    }));
    const recent = jobs.filter((job) => !ACTIVE_JOB_STATUSES.has(job.status)).slice(0, 10);
    const enabledScheduleCount = schedules.filter((schedule) => schedule.enabled).length;
    const runningServiceCount = services.filter((service) => service.status === "running").length;
    const unhealthyServiceCount = services.filter(
      (service) => service.status === "unhealthy" || service.status === "failed",
    ).length;
    const nextScheduledAt = schedules
      .flatMap((schedule) => schedule.nextRunAt ? [schedule.nextRunAt] : [])
      .sort()[0] ?? null;
    const state = !available
      ? "unavailable"
      : active.length > 0
        ? "running"
        : queued.length > 0
          ? "queued"
          : "idle";
    const capacity = health
      ? ` На узле выполняется ${health.running}/${health.maxParallelJobs}, в общей очереди ${health.queued}.`
      : "";
    const serviceSummary = !available
      ? ""
      : services.length === 0
      ? " Сервисы не развёрнуты."
      : ` Сервисы: ${runningServiceCount} работает, ${unhealthyServiceCount} требует внимания, ` +
        `${services.filter((service) => service.status === "stopped").length} остановлено.`;
    const summary = (state === "unavailable"
      ? "Раннер недоступен."
      : state === "running"
        ? `Сейчас выполняется ${active.length} запуск(ов); в очереди ${queued.length}.${capacity}`
        : state === "queued"
          ? `Активного запуска нет; в очереди ${queued.length}.${capacity}`
          : nextScheduledAt
            ? `Сейчас ничего не запущено; ближайший запуск по расписанию ${nextScheduledAt}.${capacity}`
            : `Сейчас ничего не запущено из jobs и активных расписаний нет.${capacity}`) + serviceSummary;
    return {
      available,
      health,
      overview: {
        state,
        summary,
        activeCount: active.length,
        queuedCount: queued.length,
        runningServiceCount,
        unhealthyServiceCount,
        enabledScheduleCount,
        nextScheduledAt,
        lastResult: recent[0] ?? null,
      },
      active,
      queued,
      recent,
      services,
      schedules,
      artifacts: jobs
        .filter((job) => Number(job.artifactCount ?? 0) > 0)
        .map((job) => ({
          jobId: job.id,
          action: job.action,
          count: Number(job.artifactCount ?? 0),
          createdAt: job.createdAt,
        })),
      capabilities: ["build", "validate", "dry-run", "run", "provision"],
    };
  }

  async startJob(
    context: RunnerControlContext,
    action: RunnerAction,
    requestId: string,
    provisionId?: string,
    requestedNotifications: RunnerLifecycleNotification[] = [],
  ): Promise<RunnerJob> {
    const notifications = validateLifecycleNotifications(requestedNotifications);
    for (const notification of notifications) {
      this.validateLifecycleDestination(context, notification);
    }
    if (!(new Set<RunnerAction>(["build", "validate", "dry-run", "run", "provision"])).has(action)) {
      throw new RunnerControlError("runner action is invalid");
    }
    if (action === "provision") {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provisionId ?? "")) {
        throw new RunnerControlError("provision action requires a valid provisionId");
      }
    } else if (provisionId) {
      throw new RunnerControlError("provisionId requires provision action");
    }
    if (!(await this.runner.available())) throw new RunnerControlError("runner is unavailable");
    const requestKey = idempotencyKey(
      "manual",
      context.projectId,
      context.workspaceId,
      context.conversationId,
      requestId,
    );
    const existing = (await this.runner.jobs(context.projectId, context.workspaceId))
      .find((job) => job.idempotencyKey === requestKey);
    if (existing) {
      if (
        existing.action !== action ||
        (existing.trigger ?? "manual") !== "manual" ||
        (existing.provisionId ?? "") !== (provisionId ?? "")
      ) {
        throw new RunnerControlError("runner request id was reused for a different job");
      }
      this.store.watchJob(context, existing, this.now(), notifications);
      try {
        await this.deliverNotifications(
          existing,
          notifications.filter((notification) => notification.when === "started"),
          `manual:${existing.id}:started`,
          context.actorUserId,
        );
      } catch (error) {
        console.warn(`could not queue started notifications for runner job ${existing.id}`, error);
      }
      return existing;
    }
    const inspector = new GitInspector(context.repositoryPath);
    const repository = await inspector.summary();
    if ((action === "run" || action === "provision") && repository.dirty) {
      throw new RunnerControlError(`${action} requires a clean committed worktree`);
    }
    const revision = action === "run" || action === "provision"
      ? repository.head
      : await inspector.snapshot(`${action} requested by Telegram owner ${context.actorUserId}`);
    const archive = await inspector.archive(revision);
    const job = await this.runner.submit(
      context.projectId,
      context.workspaceId,
      action,
      revision,
      archive,
      {
        trigger: "manual",
        idempotencyKey: requestKey,
        ...(provisionId ? { provisionId } : {}),
      },
    );
    this.store.watchJob(context, job, this.now(), notifications);
    this.store.audit(
      context,
      "runner.start",
      job.id,
      { action, revision, ...(provisionId ? { provisionId } : {}) },
      this.now(),
    );
    try {
      await this.deliverNotifications(
        job,
        notifications.filter((notification) => notification.when === "started"),
        `manual:${job.id}:started`,
        context.actorUserId,
      );
    } catch (error) {
      console.warn(`could not queue started notifications for runner job ${job.id}`, error);
    }
    return job;
  }

  async cancelJob(context: RunnerControlContext, jobId: string): Promise<RunnerJob> {
    const job = await this.runner.cancel(context.projectId, context.workspaceId, jobId);
    this.store.audit(context, "runner.cancel", job.id, { status: job.status }, this.now());
    return job;
  }

  async deployService(
    context: RunnerControlContext,
    name: string,
    releaseId: string,
    requestId: string,
  ): Promise<RunnerService> {
    if (!(await this.runner.available())) throw new RunnerControlError("runner is unavailable");
    const jobs = await this.runner.jobs(context.projectId, context.workspaceId);
    const release = jobs.find((job) => job.id === releaseId);
    if (!release) throw new RunnerControlError("Release was not found in this project");
    if (release.status !== "completed" || release.action === "build" || release.action === "provision") {
      throw new RunnerControlError("service deployment requires a completed non-build Release");
    }
    const requestKey = idempotencyKey(
      "service.deploy",
      context.projectId,
      context.workspaceId,
      context.conversationId,
      requestId,
    );
    const service = await this.runner.deployService(
      context.projectId,
      context.workspaceId,
      name,
      releaseId,
      requestKey,
    );
    this.store.audit(
      context,
      "service.deploy",
      `${name}/${service.current?.deploymentId ?? "unknown"}`,
      { name, releaseId, revision: service.current?.revision },
      this.now(),
    );
    return service;
  }

  async changeService(
    context: RunnerControlContext,
    name: string,
    action: RunnerServiceAction,
    requestId: string,
  ): Promise<RunnerService> {
    if (!(new Set<RunnerServiceAction>(["start", "stop", "restart", "rollback"])).has(action)) {
      throw new RunnerControlError("service action is invalid");
    }
    if (!(await this.runner.available())) throw new RunnerControlError("runner is unavailable");
    const requestKey = idempotencyKey(
      `service.${action}`,
      context.projectId,
      context.workspaceId,
      context.conversationId,
      requestId,
    );
    const service = await this.runner.serviceAction(
      context.projectId,
      context.workspaceId,
      name,
      action,
      requestKey,
    );
    this.store.audit(
      context,
      `service.${action}`,
      name,
      { status: service.status, releaseId: service.current?.releaseId },
      this.now(),
    );
    return service;
  }

  async readServiceLog(
    context: RunnerControlContext,
    name: string,
  ): Promise<{ name: string; log: string; truncated: boolean }> {
    const services = typeof this.runner.services === "function"
      ? await this.runner.services(context.projectId, context.workspaceId)
      : [];
    if (!services.some((service) => service.name === name)) {
      throw new RunnerControlError("service was not found in this project");
    }
    const raw = await this.runner.serviceLog(context.projectId, context.workspaceId, name);
    const characters = Array.from(raw);
    const truncated = characters.length > MAXIMUM_LOG_TOOL_CHARACTERS;
    const log = truncated ? characters.slice(-MAXIMUM_LOG_TOOL_CHARACTERS).join("") : raw;
    this.store.audit(context, "service.log.read", name, { truncated }, this.now());
    return { name, log, truncated };
  }

  async replayJob(
    context: RunnerControlContext,
    sourceJobId: string,
    requestId: string,
  ): Promise<RunnerJob> {
    if (!(await this.runner.available())) throw new RunnerControlError("runner is unavailable");
    const requestKey = idempotencyKey(
      "replay",
      context.projectId,
      context.workspaceId,
      context.conversationId,
      requestId,
    );
    const existing = (await this.runner.jobs(context.projectId, context.workspaceId))
      .find((job) => job.idempotencyKey === requestKey);
    if (existing) {
      if (existing.trigger !== "replay" || existing.replayOfJobId !== sourceJobId) {
        throw new RunnerControlError("runner request id was reused for a different replay");
      }
      this.store.watchJob(context, existing, this.now());
      return existing;
    }
    const job = await this.runner.replay(
      context.projectId,
      context.workspaceId,
      sourceJobId,
      requestKey,
    );
    this.store.watchJob(context, job, this.now());
    this.store.audit(
      context,
      "runner.replay",
      job.id,
      { sourceJobId, releaseId: job.releaseId, action: job.action },
      this.now(),
    );
    return job;
  }

  async readJobLog(
    context: RunnerControlContext,
    jobId: string,
  ): Promise<{ jobId: string; log: string; truncated: boolean }> {
    const jobs = await this.runner.jobs(context.projectId, context.workspaceId);
    if (!jobs.some((job) => job.id === jobId)) {
      throw new RunnerControlError("job was not found in this project");
    }
    const raw = await this.runner.log(context.projectId, jobId);
    const characters = Array.from(raw);
    const truncated = characters.length > MAXIMUM_LOG_TOOL_CHARACTERS;
    const log = truncated
      ? characters.slice(-MAXIMUM_LOG_TOOL_CHARACTERS).join("")
      : raw;
    this.store.audit(context, "runner.log.read", jobId, { truncated }, this.now());
    return { jobId, log, truncated };
  }

  async artifacts(context: RunnerControlContext, jobId?: string): Promise<RunnerArtifactView[]> {
    const jobs = await this.runner.jobs(context.projectId, context.workspaceId);
    const selected = jobId
      ? jobs.filter((job) => job.id === jobId)
      : jobs.filter((job) => Number(job.artifactCount ?? 0) > 0);
    if (jobId && selected.length === 0) throw new RunnerControlError("job was not found in this project");
    const result: RunnerArtifactView[] = [];
    for (const job of selected) {
      result.push({ job, artifacts: await this.runner.artifacts(context.projectId, job.id) });
    }
    return result;
  }

  async readArtifact(
    context: RunnerControlContext,
    jobId: string,
    name: string,
  ): Promise<Record<string, unknown>> {
    const jobs = await this.runner.jobs(context.projectId, context.workspaceId);
    if (!jobs.some((job) => job.id === jobId)) {
      throw new RunnerControlError("job was not found in this project");
    }
    const artifact = await this.runner.artifact(context.projectId, jobId, name);
    const characters = Array.from(artifact.content);
    const truncated = characters.length > MAXIMUM_ARTIFACT_TOOL_CHARACTERS;
    const content = truncated
      ? characters.slice(0, MAXIMUM_ARTIFACT_TOOL_CHARACTERS).join("")
      : artifact.content;
    this.store.audit(context, "artifact.read", `${jobId}/${name}`, { truncated }, this.now());
    return { ...artifact, content, truncated };
  }

  async planArtifactDelete(
    context: RunnerControlContext,
    jobId: string,
    name: string,
  ): Promise<ArtifactDeletionPlan> {
    const views = await this.artifacts(context, jobId);
    if (!views[0]?.artifacts.some((artifact) => artifact.name === name)) {
      throw new RunnerControlError("artifact was not found in this job");
    }
    const targets = [{ jobId, name }];
    const plan = this.store.saveArtifactPlan(
      context,
      targets,
      `Удалить артефакт «${name}» из запуска ${jobId}; файл будет перемещён в закрытую корзину`,
      this.now(),
    );
    this.store.audit(context, "artifact.delete.plan", `${jobId}/${name}`, {}, this.now());
    return plan;
  }

  async planArtifactClear(
    context: RunnerControlContext,
    jobId?: string,
  ): Promise<ArtifactDeletionPlan> {
    const views = await this.artifacts(context, jobId);
    const targets = views.flatMap((view) =>
      view.artifacts.map((artifact) => ({ jobId: view.job.id, name: artifact.name })),
    );
    if (targets.length === 0) throw new RunnerControlError("there are no artifacts to clear");
    const jobCount = new Set(targets.map((target) => target.jobId)).size;
    const scope = jobId ? `из запуска ${jobId}` : `из ${jobCount} запусков`;
    const plan = this.store.saveArtifactPlan(
      context,
      targets,
      `Очистить ${targets.length} артефакт(ов) ${scope}; файлы будут перемещены в закрытую корзину`,
      this.now(),
    );
    this.store.audit(
      context,
      "artifact.clear.plan",
      jobId ?? "workspace",
      { targets: targets.length, jobs: jobCount },
      this.now(),
    );
    return plan;
  }

  async applyArtifactPlan(
    context: RunnerControlContext,
    token: string,
  ): Promise<ArtifactDeletionResult> {
    if (!(await this.runner.available())) throw new RunnerControlError("runner is unavailable");
    const targets = this.store.claimArtifactPlan(context, token, this.now());
    const deleted: RunnerArtifactDeletion[] = [];
    const failed: ArtifactDeletionResult["failed"] = [];
    for (const target of targets) {
      try {
        deleted.push(await this.runner.deleteArtifact(
          context.projectId,
          context.workspaceId,
          target.jobId,
          target.name,
        ));
      } catch (error) {
        failed.push({
          ...target,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.store.completeArtifactPlan(token, this.now());
    this.store.audit(
      context,
      "artifact.delete.apply",
      token,
      { deleted: deleted.length, failed },
      this.now(),
    );
    return { deleted, failed };
  }

  planSchedule(context: RunnerControlContext, input: SchedulePlanInput): SchedulePlan {
    const nowMilliseconds = this.now();
    if (input.operation !== "upsert" && input.operation !== "delete") {
      throw new RunnerControlError("schedule operation is invalid");
    }
    if (input.operation === "delete") {
      const scheduleId = String(input.scheduleId ?? "");
      const existing = this.store.schedule(scheduleId, context.projectId, context.workspaceId);
      if (!existing) throw new RunnerControlError("schedule was not found");
      return this.store.savePlan(
        context,
        { operation: "delete", scheduleId },
        `Удалить расписание «${existing.name}» (${existing.action}, ${existing.time} ${existing.timeZone})`,
        nowMilliseconds,
      );
    }
    const existing = input.scheduleId
      ? this.store.schedule(input.scheduleId, context.projectId, context.workspaceId)
      : null;
    if (input.scheduleId && !existing) throw new RunnerControlError("schedule was not found");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new RunnerControlError("enabled must be a boolean");
    }
    if (input.clearDeliveryTopic !== undefined && typeof input.clearDeliveryTopic !== "boolean") {
      throw new RunnerControlError("clearDeliveryTopic must be a boolean");
    }
    if (input.clearDeliveryTopic && input.deliveryTopic) {
      throw new RunnerControlError("deliveryTopic and clearDeliveryTopic cannot be combined");
    }
    if (input.clearNotifications && input.notifications !== undefined) {
      throw new RunnerControlError("notifications and clearNotifications cannot be combined");
    }
    const name = String(input.name ?? existing?.name ?? "").trim();
    if (!SCHEDULE_NAME.test(name)) throw new RunnerControlError("schedule name is invalid");
    const action = String(input.action ?? existing?.action ?? "") as RunnerSchedulableAction;
    if (!(new Set<RunnerSchedulableAction>(["build", "validate", "dry-run", "run"])).has(action)) {
      throw new RunnerControlError("schedule action is invalid");
    }
    const time = String(input.time ?? existing?.time ?? "");
    if (!CLOCK_TIME.test(time)) throw new RunnerControlError("time must use HH:MM in 24-hour format");
    const timeZone = validateTimeZone(input.timeZone ?? existing?.timeZone ?? "");
    const weekdays = validateWeekdays(input.weekdays ?? existing?.weekdays ?? [1, 2, 3, 4, 5, 6, 7]);
    const misfireGraceMinutes = Number(
      input.misfireGraceMinutes ?? existing?.misfireGraceMinutes ?? 30,
    );
    if (!Number.isInteger(misfireGraceMinutes) || misfireGraceMinutes < 0 || misfireGraceMinutes > 1440) {
      throw new RunnerControlError("misfireGraceMinutes must be an integer from 0 to 1440");
    }
    let delivery = existing?.delivery ?? null;
    if (input.clearDeliveryTopic) delivery = null;
    if (input.deliveryTopic !== undefined) {
      const query = String(input.deliveryTopic).trim();
      if (!query) throw new RunnerControlError("deliveryTopic must be a non-empty topic name");
      if (Array.from(query).length > 200) {
        throw new RunnerControlError("deliveryTopic is limited to 200 characters");
      }
      delivery = this.resolveScheduleDestination(context, query);
    }
    if (delivery && action !== "dry-run" && action !== "run") {
      throw new RunnerControlError("automatic report delivery is supported only for dry-run and run schedules");
    }
    const deliveryCondition = String(
      input.deliveryCondition ?? existing?.deliveryCondition ?? "success",
    ) as RunnerDeliveryCondition;
    if (!(new Set<RunnerDeliveryCondition>(["success", "failure", "always"])).has(deliveryCondition)) {
      throw new RunnerControlError("deliveryCondition must be success, failure, or always");
    }
    const notifications = input.clearNotifications
      ? []
      : input.notifications === undefined
        ? existing?.notifications ?? []
        : validateLifecycleNotifications(input.notifications);
    for (const notification of notifications) {
      this.validateLifecycleDestination(context, notification);
    }
    const timestamp = iso(nowMilliseconds);
    const schedule: RunnerSchedule = {
      id: existing?.id ?? randomUUID(),
      projectId: context.projectId,
      workspaceId: context.workspaceId,
      name,
      action,
      time,
      timeZone,
      weekdays,
      enabled: input.enabled ?? existing?.enabled ?? true,
      revisionRef: "master",
      overlapPolicy: "skip",
      misfireGraceMinutes,
      delivery,
      deliveryCondition,
      notifications,
      originConversationId: existing ? existing.originConversationId : context.conversationId,
      createdBy: existing?.createdBy ?? context.actorUserId,
      updatedBy: context.actorUserId,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const days = weekdays.length === 7 ? "ежедневно" : `дни ISO ${weekdays.join(",")}`;
    const deliverySummary = schedule.delivery
      ? `, отчёт → ${schedule.delivery.label} (${({
          success: "при успехе",
          failure: "при ошибке",
          always: "при любом результате",
        } as const)[schedule.deliveryCondition]})`
      : "";
    const notificationSummary = schedule.notifications.length > 0
      ? `, внешних lifecycle-сообщений: ${schedule.notifications.length}`
      : "";
    return this.store.savePlan(
      context,
      { operation: "upsert", schedule },
      `${existing ? "Изменить" : "Создать"} расписание «${name}»: ${action}, ${days} в ${time} (${timeZone}), ` +
        `${schedule.enabled ? "включено" : "выключено"}${deliverySummary}${notificationSummary}`,
      nowMilliseconds,
    );
  }

  applySchedule(context: RunnerControlContext, token: string): RunnerSchedule | null {
    const schedule = this.store.applyPlan(context, token, this.now());
    this.store.audit(
      context,
      schedule ? "schedule.upsert" : "schedule.delete",
      schedule?.id ?? token,
      schedule,
      this.now(),
    );
    return schedule;
  }

  setScheduleEnabled(
    context: RunnerControlContext,
    scheduleId: string,
    enabled: boolean,
  ): RunnerSchedule {
    const schedule = this.store.setEnabled(
      scheduleId,
      context.projectId,
      context.workspaceId,
      enabled,
      context.actorUserId,
      this.now(),
    );
    this.store.audit(
      context,
      enabled ? "schedule.resume" : "schedule.pause",
      scheduleId,
      {},
      this.now(),
    );
    return schedule;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.refreshExecutions();
      await this.refreshWatchedJobs();
      if (!(await this.runner.available())) return;
      for (const schedule of this.store.enabledSchedules()) {
        const occurrence = dueScheduleOccurrence(schedule, this.now());
        if (!occurrence) continue;
        const execution = this.store.claimExecution(schedule, occurrence, this.now());
        if (!execution) continue;
        await this.enqueueScheduled(schedule, execution);
      }
    } catch (error) {
      console.error("runner scheduler tick failed", error);
    } finally {
      this.ticking = false;
    }
  }

  private async enqueueScheduled(
    schedule: RunnerSchedule,
    execution: RunnerScheduleExecution,
  ): Promise<void> {
    try {
      if (!(await this.runner.available())) throw new RunnerControlError("runner is unavailable");
      const jobs = await this.runner.jobs(schedule.projectId, schedule.workspaceId);
      if (jobs.some((job) => job.scheduleId === schedule.id && ACTIVE_JOB_STATUSES.has(job.status))) {
        this.store.updateExecution(
          execution.id,
          "skipped",
          { reason: "previous job from this schedule is still active" },
          this.now(),
        );
        return;
      }
      const workspace = this.projects.project(schedule.projectId).workspace(schedule.workspaceId);
      const inspector = new GitInspector(workspace.path);
      // revision_ref historically stores "master", but managed repositories may publish main or
      // another unambiguous default branch and may not have a matching local branch at all.
      const revision = await inspector.resolveDefaultRevision();
      const archive = await inspector.archive(revision);
      const job = await this.runner.submit(
        schedule.projectId,
        schedule.workspaceId,
        schedule.action,
        revision,
        archive,
        {
          trigger: "schedule",
          scheduleId: schedule.id,
          scheduledFor: execution.scheduledFor,
          idempotencyKey: idempotencyKey(
            "schedule",
            schedule.projectId,
            schedule.workspaceId,
            schedule.id,
            execution.occurrenceKey,
          ),
        },
      );
      this.store.updateExecution(
        execution.id,
        "queued",
        { jobId: job.id, revision },
        this.now(),
      );
      try {
        await this.deliverNotifications(
          job,
          schedule.notifications.filter((notification) => notification.when === "started"),
          `schedule:${schedule.id}:${execution.occurrenceKey}:started`,
          schedule.updatedBy,
        );
      } catch (error) {
        console.warn(`could not queue started notifications for schedule ${schedule.id}`, error);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.store.updateExecution(execution.id, "failed", { reason }, this.now());
      await this.notify(
        schedule.projectId,
        `Расписание «${schedule.name}» не смогло запустить ${schedule.action}: ${reason}`,
      );
    }
  }

  private async refreshExecutions(): Promise<void> {
    const grouped = new Map<string, RunnerScheduleExecution[]>();
    for (const execution of this.store.activeExecutions()) {
      if (execution.status === "claimed") {
        if (this.now() - Date.parse(execution.updatedAt) > 60_000) {
          this.store.updateExecution(
            execution.id,
            "failed",
            { reason: "scheduler restarted or lost the claim before submitting a job" },
            this.now(),
          );
        }
        continue;
      }
      if (!execution.jobId) continue;
      const key = `${execution.projectId}\0${execution.workspaceId}`;
      const entries = grouped.get(key) ?? [];
      entries.push(execution);
      grouped.set(key, entries);
    }
    for (const [key, executions] of grouped) {
      const [projectId, workspaceId] = key.split("\0") as [string, string];
      let jobs: RunnerJob[];
      try {
        jobs = await this.runner.jobs(projectId, workspaceId);
      } catch {
        continue;
      }
      for (const execution of executions) {
        const job = jobs.find((candidate) => candidate.id === execution.jobId);
        if (!job) continue;
        const status: RunnerScheduleExecutionStatus = job.status === "interrupted"
          ? "failed"
          : job.status;
        if (status === execution.status) continue;
        const schedule = this.store.schedule(
          execution.scheduleId,
          execution.projectId,
          execution.workspaceId,
        );
        if (
          deliveryConditionMatches(schedule?.deliveryCondition ?? "success", status) &&
          (job.action === "dry-run" || job.action === "run") &&
          (job.portalMessageCount ?? 0) > 0 &&
          schedule
        ) {
          if (!(await this.deliverScheduledPortalMessages(job, schedule))) continue;
        }
        if (schedule && TERMINAL_EXECUTION_STATUSES.has(status)) {
          try {
            await this.deliverNotifications(
              job,
              schedule.notifications.filter((notification) =>
                terminalNotificationKinds(job).includes(notification.when)
              ),
              `schedule:${schedule.id}:${execution.occurrenceKey}:${status}`,
              schedule.updatedBy,
            );
          } catch (error) {
            console.warn(`could not queue terminal notifications for schedule ${schedule.id}`, error);
          }
        }
        this.store.updateExecution(
          execution.id,
          status,
          { reason: job.error ?? null, revision: job.revision },
          this.now(),
        );
        if (TERMINAL_EXECUTION_STATUSES.has(status) && status !== "completed") {
          if (schedule) {
            await this.notify(
              execution.projectId,
              `Запуск расписания «${schedule.name}» завершился со статусом ${status}` +
                `${job.error ? `: ${job.error}` : ""}`,
            );
          }
        }
      }
    }
  }

  private async refreshWatchedJobs(): Promise<void> {
    const grouped = new Map<string, RunnerJobWatch[]>();
    for (const watch of this.store.pendingJobWatches()) {
      const key = `${watch.projectId}\0${watch.workspaceId}`;
      const entries = grouped.get(key) ?? [];
      entries.push(watch);
      grouped.set(key, entries);
    }
    for (const [key, watches] of grouped) {
      const [projectId, workspaceId] = key.split("\0") as [string, string];
      let jobs: RunnerJob[];
      try {
        jobs = await this.runner.jobs(projectId, workspaceId);
      } catch {
        continue;
      }
      for (const watch of watches) {
        const job = jobs.find((candidate) => candidate.id === watch.jobId);
        if (!job) continue;
        if (job.status !== watch.lastStatus) this.store.updateJobWatch(job, this.now());
        if (!MANUAL_JOB_TERMINAL_STATUSES.has(job.status)) continue;
        try {
          await this.deliverNotifications(
            job,
            watch.notifications.filter((notification) =>
              terminalNotificationKinds(job).includes(notification.when)
            ),
            `manual:${job.id}:${job.status}`,
            watch.actorUserId,
          );
          // A failed publication can still leave a valid, captured report/video batch.
          const reportDelivered = (
            (job.status === "completed" || job.status === "failed") &&
            (job.action === "dry-run" || job.action === "run") &&
            (job.portalMessageCount ?? 0) > 0 &&
            watch.actorUserId > 0 &&
            await this.notifyPortalMessages(job, watch.conversationId, watch.actorUserId)
          );
          // Delivering an artifact must not hide the failed job from its owner.
          if (!reportDelivered || job.status === "failed") {
            await this.notify(projectId, manualJobNotification(job), watch.conversationId);
          }
          this.store.markJobWatchNotified(job.id, this.now());
        } catch (error) {
          console.warn(`could not notify conversation about runner job ${job.id}`, error);
        }
      }
    }
  }

  private async deliverNotifications(
    job: RunnerJob,
    notifications: RunnerLifecycleNotification[],
    scope: string,
    createdBy: number,
  ): Promise<void> {
    for (const [index, notification] of notifications.entries()) {
      const accepted = await this.deliverLifecycleNotification(
        job,
        notification,
        idempotencyKey(scope, notification.when, String(index)),
        createdBy,
      );
      if (!accepted) {
        throw new RunnerControlError(
          `external ${notification.when} notification was not accepted by the outbox`,
        );
      }
    }
  }
}
