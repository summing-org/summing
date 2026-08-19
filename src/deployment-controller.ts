import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const SHA = /^[0-9a-f]{40}$/;
const STATUSES = new Set([
  "idle",
  "requested",
  "checking",
  "building",
  "waiting",
  "deploying",
  "rolling_back",
  "succeeded",
  "failed",
]);

export interface DeploymentStatus {
  available: boolean;
  status: string;
  phase: string | null;
  message: string;
  currentSha: string | null;
  remoteSha: string | null;
  attemptId: string | null;
  failure: DeploymentFailure | null;
  history: DeploymentAttempt[];
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DeploymentTestSummary {
  total: number | null;
  passed: number | null;
  failed: number | null;
  failedTests: string[];
}

export interface DeploymentFailure {
  kind: string;
  phase: string;
  exitCode: number | null;
  logTail: string;
  tests: DeploymentTestSummary | null;
}

export interface DeploymentAttempt {
  attemptId: string;
  status: string;
  phase: string | null;
  message: string;
  currentSha: string | null;
  remoteSha: string | null;
  failure: DeploymentFailure | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DeploymentControl {
  readonly available: boolean;
  status(): Promise<DeploymentStatus>;
  requestRefresh(): Promise<{ requestedAt: string }>;
  requestUpdate(): Promise<{ requestedAt: string }>;
}

export class DeploymentControllerError extends Error {}

function text(value: unknown, maximum = 500): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function timestamp(value: unknown): string | null {
  const candidate = text(value, 64);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : null;
}

function sha(value: unknown): string | null {
  const candidate = text(value, 40);
  return SHA.test(candidate) ? candidate : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000
    ? Number(value)
    : null;
}

function failure(value: unknown): DeploymentFailure | null {
  const candidate = record(value);
  if (!candidate) return null;
  const rawTests = record(candidate.tests);
  const failedTests = Array.isArray(rawTests?.failedTests)
    ? rawTests.failedTests
      .map((item) => text(item, 300))
      .filter(Boolean)
      .slice(0, 20)
    : [];
  return {
    kind: text(candidate.kind, 64) || "unknown",
    phase: text(candidate.phase, 64) || "unknown",
    exitCode: boundedInteger(candidate.exitCode),
    logTail: text(candidate.logTail, 12_000),
    tests: rawTests
      ? {
        total: boundedInteger(rawTests.total),
        passed: boundedInteger(rawTests.passed),
        failed: boundedInteger(rawTests.failed),
        failedTests,
      }
      : null,
  };
}

function attempt(value: unknown): DeploymentAttempt | null {
  const candidate = record(value);
  if (!candidate) return null;
  const attemptId = text(candidate.attemptId, 96);
  const status = text(candidate.status, 32);
  if (!attemptId || !STATUSES.has(status)) return null;
  return {
    attemptId,
    status,
    phase: text(candidate.phase, 64) || null,
    message: text(candidate.message) || "Deployment attempt",
    currentSha: sha(candidate.currentSha),
    remoteSha: sha(candidate.remoteSha),
    failure: failure(candidate.failure),
    startedAt: timestamp(candidate.startedAt),
    finishedAt: timestamp(candidate.finishedAt),
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export class DeploymentController implements DeploymentControl {
  readonly available: boolean;

  constructor(
    readonly requestPath: string,
    readonly statePath: string,
  ) {
    this.available = Boolean(requestPath && statePath);
  }

  async status(): Promise<DeploymentStatus> {
    if (!this.available) {
      return {
        available: false,
        status: "disabled",
        phase: null,
        message: "Автоматическое обновление не настроено",
        currentSha: null,
        remoteSha: null,
        attemptId: null,
        failure: null,
        history: [],
        requestedAt: null,
        startedAt: null,
        finishedAt: null,
      };
    }
    const [rawState, rawRequest, rawHistory] = await Promise.all([
      readJson(this.statePath),
      readJson(this.requestPath),
      readJson(join(dirname(this.statePath), "history.json")),
    ]);
    const state = record(rawState);
    const request = record(rawRequest);
    const requestAction = request?.action === "check" ? "check" : "deploy";
    const rawStatus = text(state?.status, 32);
    const requestedAt = timestamp(request?.requestedAt);
    const startedAt = timestamp(state?.startedAt);
    const finishedAt = timestamp(state?.finishedAt);
    const workerActive = new Set([
      "checking",
      "building",
      "waiting",
      "deploying",
      "rolling_back",
    ]).has(rawStatus);
    const latestWorkerAt = finishedAt ?? startedAt;
    const pendingRequest = Boolean(
      requestedAt &&
      !workerActive &&
      (!latestWorkerAt || Date.parse(requestedAt) > Date.parse(latestWorkerAt)),
    );
    return {
      available: true,
      status: pendingRequest ? "requested" : STATUSES.has(rawStatus) ? rawStatus : "idle",
      phase: pendingRequest ? "request" : text(state?.phase, 64) || null,
      message: pendingRequest
        ? requestAction === "check"
          ? "Запрос принят; ждём проверки origin"
          : "Запрос принят; ждём запуска обновления"
        : text(state?.message) || "Проверка обновлений ещё не запускалась",
      currentSha: sha(state?.currentSha),
      remoteSha: sha(state?.remoteSha),
      attemptId: text(state?.attemptId, 96) || null,
      failure: pendingRequest ? null : failure(state?.failure),
      history: Array.isArray(rawHistory)
        ? rawHistory.map(attempt).filter((item): item is DeploymentAttempt => item !== null).slice(0, 20)
        : [],
      requestedAt,
      startedAt,
      finishedAt,
    };
  }

  async requestUpdate(): Promise<{ requestedAt: string }> {
    return await this.request("deploy");
  }

  async requestRefresh(): Promise<{ requestedAt: string }> {
    return await this.request("check");
  }

  private async request(action: "check" | "deploy"): Promise<{ requestedAt: string }> {
    if (!this.available) {
      throw new DeploymentControllerError("automatic deployment is not configured");
    }
    const requestedAt = new Date().toISOString();
    const temporary = `${this.requestPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.requestPath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify({ requestedAt, action })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.requestPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new DeploymentControllerError(
        `cannot request ${action === "check" ? "origin refresh" : "deployment"}: ${String(error)}`,
      );
    }
    return { requestedAt };
  }
}
