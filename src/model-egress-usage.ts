import type { CodexRateLimitsSnapshot } from "./codex-rate-limits.js";

export interface ModelEgressUsageObservation {
  estimatedCreditsMicros: number;
  measured: boolean;
  observedWeeklyPercent: number;
  weeklyResetsAt: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function modelEgressThreadCreditsMicros(value: unknown): number {
  const threadUsage = record(record(value)?.threadUsage);
  const credits = Number(threadUsage?.estimatedUsageCreditsMicros);
  return Number.isSafeInteger(credits) && credits >= 0 ? credits : 0;
}

export function observeModelEgressWeeklyUsage(
  before: CodexRateLimitsSnapshot | null,
  after: CodexRateLimitsSnapshot | null,
  estimatedCreditsMicros: number,
): ModelEgressUsageObservation {
  const previous = before?.weekly ?? null;
  const current = after?.weekly ?? null;
  if (!previous || !current) {
    return {
      estimatedCreditsMicros,
      measured: false,
      observedWeeklyPercent: 0,
      weeklyResetsAt: current?.resetsAt ?? previous?.resetsAt ?? null,
    };
  }
  const observedWeeklyPercent = current.resetsAt === previous.resetsAt
    ? Math.max(0, current.usedPercent - previous.usedPercent)
    : current.usedPercent;
  return {
    estimatedCreditsMicros,
    measured: true,
    observedWeeklyPercent: Math.min(100, observedWeeklyPercent),
    weeklyResetsAt: current.resetsAt,
  };
}
