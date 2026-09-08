import assert from "node:assert/strict";
import test from "node:test";
import { OPERATIONS_JS } from "../src/viewer-operations-assets.js";

test("operations escape runner data, show queue and delivery failures, and keep stale data visibly dated", async () => {
  const elements = new Map<string, { innerHTML: string; textContent: string }>();
  const $ = (id: string) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "" });
    return elements.get(id)!;
  };
  const state: any = { conversation: "alpha" };
  let calls = 0;
  let respond: () => Promise<unknown> = async () => null;
  const escape = (value: unknown) => String(value ?? "").replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const ui = new Function("state", "$", "api", "esc", "localTime", "renderOverviewPart", OPERATIONS_JS + ";return {renderOperations,loadOperations}")(
    state, $, () => { calls++; return respond(); }, escape, (value: unknown) => String(value),
    (id: string, html: string) => { $(id).innerHTML = html; },
  );
  const snapshot = { checkedAt: "2026-09-08T08:01:00Z", lastSuccessAt: "2026-09-08T08:00:00Z", available: false,
    jobs: [{ id: "job-12345678", action: "run", status: "queued", revision: "abcdef1234", createdAt: "2026-09-08T07:59:00Z",
      queueReason: "<img src=x>", waitSeconds: 120, initiatedBy: 42 }],
    services: [{ name: "<worker>", status: "unhealthy", current: null, restartCount: 4, error: "<script>fail</script>" }],
    executions: [{ id: "exec-123", name: "Morning", status: "reconciling", scheduledFor: "2026-09-08T08:00:00Z", reason: "No response" }],
    deliveryFailures: [{ error: "<b>offline</b>", attempts: 3, nextAttemptAt: "2026-09-08T08:10:00Z" }],
  };
  ui.renderOperations(snapshot);
  assert.match($("operationsFreshness").textContent, /Нет связи.*08:00/);
  assert.match($("operationsJobs").innerHTML, /ожидание 2 мин/);
  assert.match($("operationsServices").innerHTML, /перезапусков: 4/);
  assert.match($("operationsExecutions").innerHTML, /exec-123/);
  assert.match($("operationsDeliveries").innerHTML, /Попыток: 3/);
  assert.doesNotMatch([...elements.values()].map((el) => el.innerHTML).join(""), /<script>|<img|<worker>|<b>/);
  let release!: (value: unknown) => void;
  respond = () => new Promise((resolve) => { release = resolve; });
  const first = ui.loadOperations(), duplicate = ui.loadOperations();
  assert.equal(calls, 1);
  state.conversation = "beta";
  release({ ...snapshot, available: true });
  await Promise.all([first, duplicate]);
  assert.equal(state.operations, snapshot, "late data from another conversation is not applied");
  respond = async () => { throw new Error("offline"); };
  await ui.loadOperations();
  assert.equal(state.operations, snapshot);
  assert.match($("operationsFreshness").textContent, /Нет связи/);
});
