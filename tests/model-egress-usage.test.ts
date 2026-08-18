import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexRateLimits } from "../src/codex-rate-limits.js";
import {
  modelEgressThreadCreditsMicros,
  observeModelEgressWeeklyUsage,
} from "../src/model-egress-usage.js";

function weekly(usedPercent: number, resetsAt = 1_800_000_000) {
  return parseCodexRateLimits({
    rateLimits: {
      secondary: { usedPercent, windowDurationMins: 10_080, resetsAt },
    },
  });
}

test("reads estimated credits for one model-egress thread", () => {
  assert.equal(modelEgressThreadCreditsMicros({
    threadUsage: { estimatedUsageCreditsMicros: 2_750_000 },
  }), 2_750_000);
  assert.equal(modelEgressThreadCreditsMicros({ threadUsage: null }), 0);
});

test("attributes only the weekly indicator increase observed around the turn", () => {
  assert.deepEqual(observeModelEgressWeeklyUsage(weekly(12), weekly(15), 2_750_000), {
    estimatedCreditsMicros: 2_750_000,
    measured: true,
    observedWeeklyPercent: 3,
    weeklyResetsAt: 1_800_000_000,
  });
  assert.deepEqual(
    observeModelEgressWeeklyUsage(weekly(99, 100), weekly(2, 200), 100_000),
    {
      estimatedCreditsMicros: 100_000,
      measured: true,
      observedWeeklyPercent: 2,
      weeklyResetsAt: 200,
    },
  );
  assert.equal(observeModelEgressWeeklyUsage(null, weekly(5), 0).measured, false);
});
