import assert from "node:assert/strict";
import test from "node:test";
import {
  codexLimitsMessage,
  codexLimitsProfileText,
  parseCodexRateLimits,
} from "../src/codex-rate-limits.js";

test("selects the weekly Codex window and renders remaining usage", () => {
  const snapshot = parseCodexRateLimits(
    {
      rateLimits: {
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: 1_786_656_000,
        },
        secondary: {
          usedPercent: 32.4,
          windowDurationMins: 10_080,
          resetsAt: 1_787_260_800,
        },
      },
    },
    1_786_650_000,
  );

  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.weekly?.kind, "secondary");
  assert.equal(snapshot.weekly?.remainingPercent, 68);
  assert.match(
    codexLimitsProfileText(snapshot, "UTC"),
    /^🟢 Codex: неделя 68% · сброс .* · SUMMING 9\.4\.2$/,
  );
  const message = codexLimitsMessage(snapshot, "UTC");
  assert.match(message, /5 ч\.: 80% осталось/);
  assert.match(message, /Неделя: 68% осталось/);
  assert.match(message, /███████░░░/);
});

test("uses the codex bucket from the multi-bucket response", () => {
  const snapshot = parseCodexRateLimits({
    rateLimitsByLimitId: {
      codex_other: {
        primary: { usedPercent: 90, windowDurationMins: 60, resetsAt: 100 },
      },
      codex: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 200 },
        secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 300 },
      },
    },
  });

  assert.equal(snapshot.windows[0]?.remainingPercent, 75);
  assert.equal(snapshot.weekly?.remainingPercent, 60);
});

test("falls back to the codex bucket when the direct bucket is empty", () => {
  const snapshot = parseCodexRateLimits({
    rateLimits: {},
    rateLimitsByLimitId: {
      codex: {
        secondary: { usedPercent: 45, windowDurationMins: 10_080, resetsAt: 300 },
      },
    },
  });

  assert.equal(snapshot.weekly?.remainingPercent, 55);
});

test("shows an explicit unknown state when a weekly window is absent", () => {
  const snapshot = parseCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: 100 },
    },
  });

  assert.equal(snapshot.weekly, null);
  assert.equal(
    codexLimitsProfileText(snapshot, "UTC"),
    "⚪ Codex: недельный лимит недоступен · SUMMING 9.4.2",
  );
  assert.match(codexLimitsMessage(snapshot, "UTC"), /Недельное окно App Server не вернул/);
});
