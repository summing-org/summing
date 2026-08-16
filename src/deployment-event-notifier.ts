import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const EVENT_FILE = /^[0-9A-Za-z._-]{1,160}\.json$/;
const SHA = /^[0-9a-f]{40}$/;

type Sender = (message: string) => Promise<void>;

interface RenderedEvent {
  eventId: string;
  message: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function version(value: unknown): string {
  const candidate = text(value, 64);
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(candidate) ? candidate : "";
}

function shortSha(value: unknown): string {
  const candidate = text(value, 40);
  return SHA.test(candidate) ? candidate.slice(0, 12) : "";
}

function boundedInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000
    ? Number(value)
    : null;
}

function renderDeploymentEvent(value: unknown): RenderedEvent | null {
  const event = record(value);
  if (!event || event.schemaVersion !== 1) return null;
  const eventId = text(event.eventId, 96);
  const kind = text(event.kind, 32);
  if (!eventId) return null;

  const previousVersion = version(event.previousVersion);
  const targetVersion = version(event.targetVersion);
  const targetSha = shortSha(event.targetSha);

  if (kind === "update_succeeded") {
    const lines = [
      `✅ SUMMING обновлён${targetVersion ? ` до ${targetVersion}` : ""}`,
    ];
    if (previousVersion && targetVersion && previousVersion !== targetVersion) {
      lines.push(`Версия: ${previousVersion} → ${targetVersion}`);
    }
    if (targetSha) lines.push(`Commit: ${targetSha}`);
    return { eventId, message: lines.join("\n") };
  }

  if (kind !== "update_failed") return null;
  const failure = record(event.failure);
  const tests = record(failure?.tests);
  const phase = text(failure?.phase, 64);
  const message = text(event.message, 500);
  const failed = boundedInteger(tests?.failed);
  const total = boundedInteger(tests?.total);
  const failedTests = Array.isArray(tests?.failedTests)
    ? tests.failedTests
      .map((item) => text(item, 300))
      .filter(Boolean)
      .slice(0, 10)
    : [];
  const lines = ["❌ Обновление SUMMING не установлено"];
  if (targetVersion) lines.push(`Целевая версия: ${targetVersion}`);
  if (targetSha) lines.push(`Commit: ${targetSha}`);
  if (message) lines.push(message);
  if (phase) lines.push(`Этап: ${phase}`);
  if (failed !== null) {
    lines.push(`Тесты: ${failed}${total === null ? "" : ` из ${total}`} не пройдено`);
  }
  if (failedTests.length > 0) {
    lines.push("Упали:", ...failedTests.map((name) => `• ${name}`));
  }
  return { eventId, message: lines.join("\n").slice(0, 4_000) };
}

export class DeploymentEventNotifier {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private closed = false;
  private readonly observedAttempts = new Set<string>();
  private readonly outboxAttempts = new Set<string>();
  private readonly deliveredAttempts = new Set<string>();

  constructor(
    readonly eventDirectory: string,
    readonly sender: Sender,
    readonly intervalMilliseconds = 5_000,
    readonly statePath = "",
    readonly currentVersion = "",
  ) {}

  start(): void {
    if ((!this.eventDirectory && !this.statePath) || this.closed || this.timer || this.active) return;
    this.tick();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async close(): Promise<void> {
    this.stop();
    await this.active?.catch(() => undefined);
  }

  async check(): Promise<void> {
    if ((!this.eventDirectory && !this.statePath) || this.closed) return;
    if (this.active) return this.active;
    const task = this.drain();
    this.active = task;
    try {
      await task;
    } finally {
      if (this.active === task) this.active = null;
    }
  }

  async observeState(): Promise<void> {
    if (!this.statePath || this.closed) return;
    await this.observeWorkerState();
  }

  private tick(): void {
    void this.check()
      .catch((error) => console.warn("could not deliver deployment event", error))
      .finally(() => {
        if (this.closed) return;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.tick();
        }, this.intervalMilliseconds);
        this.timer.unref();
      });
  }

  private async drain(): Promise<void> {
    await this.drainOutbox();
    await this.observeWorkerState();
  }

  private async drainOutbox(): Promise<void> {
    if (!this.eventDirectory) return;
    let entries;
    try {
      entries = await readdir(this.eventDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !EVENT_FILE.test(entry.name)) continue;
      const path = join(this.eventDirectory, entry.name);
      let payload: unknown;
      try {
        payload = JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error) {
        console.warn(`ignoring invalid deployment event ${entry.name}`, error);
        continue;
      }
      const rendered = renderDeploymentEvent(payload);
      if (!rendered) {
        console.warn(`ignoring unsupported deployment event ${entry.name}`);
        continue;
      }
      this.outboxAttempts.add(rendered.eventId);
      if (this.deliveredAttempts.has(rendered.eventId)) {
        await rm(path, { force: true });
        continue;
      }
      try {
        await this.sender(rendered.message);
      } catch (error) {
        console.warn(`deployment event delivery failed for ${entry.name}`, error);
        break;
      }
      this.deliveredAttempts.add(rendered.eventId);
      await rm(path, { force: true });
    }
  }

  private async observeWorkerState(): Promise<void> {
    if (!this.statePath) return;
    let rawState: unknown;
    try {
      rawState = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      console.warn("could not read deployment state for notifications", error);
      return;
    }
    const state = record(rawState);
    if (!state) return;
    const attemptId = text(state.attemptId, 96);
    const status = text(state.status, 32);
    if (!attemptId) return;
    if (new Set(["checking", "building", "waiting", "deploying", "rolling_back"])
      .has(status)) {
      this.observedAttempts.add(attemptId);
      return;
    }
    if (
      !this.observedAttempts.has(attemptId) ||
      this.outboxAttempts.has(attemptId) ||
      this.deliveredAttempts.has(attemptId)
    ) {
      return;
    }
    const failure = record(state.failure);
    const failureKind = text(failure?.kind, 64);
    if (status !== "succeeded" && !(status === "failed" && new Set(["lint", "tests"])
      .has(failureKind))) {
      return;
    }
    const rendered = renderDeploymentEvent({
      schemaVersion: 1,
      eventId: attemptId,
      kind: status === "succeeded" ? "update_succeeded" : "update_failed",
      message: state.message,
      targetVersion: status === "succeeded" ? this.currentVersion : null,
      targetSha: state.remoteSha,
      failure: state.failure,
    });
    if (!rendered) return;
    await this.sender(rendered.message);
    this.deliveredAttempts.add(attemptId);
    this.observedAttempts.delete(attemptId);
  }
}
