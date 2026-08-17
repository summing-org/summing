import { summingProfileDescription } from "./version.js";

export interface CodexRateLimitWindow {
  kind: "primary" | "secondary";
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexRateLimitsSnapshot {
  capturedAt: number;
  windows: readonly CodexRateLimitWindow[];
  weekly: CodexRateLimitWindow | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function window(
  value: unknown,
  kind: CodexRateLimitWindow["kind"],
): CodexRateLimitWindow | null {
  const raw = record(value);
  if (!raw) return null;
  const usedPercent = Number(raw.usedPercent);
  const windowDurationMins = Number(raw.windowDurationMins);
  const resetsAt = Number(raw.resetsAt);
  if (
    !Number.isFinite(usedPercent) ||
    !Number.isFinite(windowDurationMins) ||
    !Number.isFinite(resetsAt) ||
    windowDurationMins <= 0 ||
    resetsAt <= 0
  ) {
    return null;
  }
  const boundedUsedPercent = Math.min(100, Math.max(0, usedPercent));
  return {
    kind,
    usedPercent: boundedUsedPercent,
    remainingPercent: Math.round(100 - boundedUsedPercent),
    windowDurationMins,
    resetsAt,
  };
}

function activeBucket(value: unknown): Record<string, unknown> | null {
  const result = record(value);
  if (!result) return null;
  const direct = record(result.rateLimits);
  if (direct && (record(direct.primary) || record(direct.secondary))) return direct;
  const byLimitId = record(result.rateLimitsByLimitId);
  if (!byLimitId) return null;
  const codex = record(byLimitId.codex);
  if (codex) return codex;
  for (const candidate of Object.values(byLimitId)) {
    const bucket = record(candidate);
    if (bucket) return bucket;
  }
  return null;
}

export function parseCodexRateLimits(
  value: unknown,
  capturedAt = Date.now() / 1_000,
): CodexRateLimitsSnapshot {
  const bucket = activeBucket(value);
  const windows = bucket
    ? ([window(bucket.primary, "primary"), window(bucket.secondary, "secondary")].filter(
        (candidate): candidate is CodexRateLimitWindow => candidate !== null,
      ))
    : [];
  const weekly =
    windows
      .filter((candidate) => candidate.windowDurationMins >= 6 * 24 * 60)
      .sort((left, right) => right.windowDurationMins - left.windowDurationMins)[0] ?? null;
  return { capturedAt, windows, weekly };
}

function resetText(resetsAt: number, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date(resetsAt * 1_000));
}

function windowName(windowDurationMins: number): string {
  if (windowDurationMins >= 6 * 24 * 60) return "Неделя";
  if (windowDurationMins >= 24 * 60) {
    return `${Math.round(windowDurationMins / (24 * 60))} дн.`;
  }
  if (windowDurationMins >= 60) return `${Math.round(windowDurationMins / 60)} ч.`;
  return `${Math.round(windowDurationMins)} мин.`;
}

function progressBar(remainingPercent: number): string {
  const filled = Math.round(remainingPercent / 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

export function codexLimitsProfileText(
  snapshot: CodexRateLimitsSnapshot,
  timeZone: string,
): string {
  const weekly = snapshot.weekly;
  if (!weekly) {
    return summingProfileDescription("Codex: нет данных");
  }
  return summingProfileDescription(
    `Codex: ${weekly.remainingPercent}% · до ${resetText(weekly.resetsAt, timeZone)}`,
  );
}

export function codexLimitsMessage(
  snapshot: CodexRateLimitsSnapshot,
  timeZone: string,
): string {
  if (snapshot.windows.length === 0) {
    return "Codex limits на VPS пока недоступны.";
  }
  const lines = ["Codex limits на VPS:"];
  for (const limit of snapshot.windows) {
    lines.push(
      "",
      `${windowName(limit.windowDurationMins)}: ${limit.remainingPercent}% осталось`,
      progressBar(limit.remainingPercent),
      `Сброс: ${resetText(limit.resetsAt, timeZone)}`,
    );
  }
  if (!snapshot.weekly) {
    lines.push("", "Недельное окно App Server не вернул.");
  }
  lines.push("", `Обновлено: ${resetText(snapshot.capturedAt, timeZone)}`);
  return lines.join("\n");
}
