import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  message: string;
  currentSha: string | null;
  remoteSha: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DeploymentControl {
  readonly available: boolean;
  status(): Promise<DeploymentStatus>;
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

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
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
        message: "Автоматическое обновление не настроено",
        currentSha: null,
        remoteSha: null,
        requestedAt: null,
        startedAt: null,
        finishedAt: null,
      };
    }
    const [state, request] = await Promise.all([
      readJson(this.statePath),
      readJson(this.requestPath),
    ]);
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
      message: pendingRequest
        ? "Запрос принят; ждём запуска обновления"
        : text(state?.message) || "Проверка обновлений ещё не запускалась",
      currentSha: sha(state?.currentSha),
      remoteSha: sha(state?.remoteSha),
      requestedAt,
      startedAt,
      finishedAt,
    };
  }

  async requestUpdate(): Promise<{ requestedAt: string }> {
    if (!this.available) {
      throw new DeploymentControllerError("automatic deployment is not configured");
    }
    const requestedAt = new Date().toISOString();
    const temporary = `${this.requestPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.requestPath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify({ requestedAt })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.requestPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new DeploymentControllerError(`cannot request deployment: ${String(error)}`);
    }
    return { requestedAt };
  }
}
