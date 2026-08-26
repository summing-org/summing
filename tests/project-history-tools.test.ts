import assert from "node:assert/strict";
import test from "node:test";
import {
  executeProjectHistoryTool,
  type ProjectHistoryToolContext,
} from "../src/project-history-tools.js";

const context: ProjectHistoryToolContext = {
  projectId: "demo",
  workspaceId: "app",
  conversationId: "tg-00000000000000000000",
  actorUserId: 42,
  turnId: "turn-current",
  runId: 9,
};

test("project history tools validate inputs and keep host-fixed scope", async () => {
  const calls: unknown[] = [];
  const host = {
    projectHistoryTool: async (
      receivedContext: ProjectHistoryToolContext,
      operation: "recent" | "search" | "read",
      input: unknown,
    ) => {
      calls.push({ receivedContext, operation, input });
      return { ok: true };
    },
  };
  const result = await executeProjectHistoryTool(host, context, {
    threadId: "thread",
    turnId: context.turnId,
    callId: "call",
    namespace: "project_history",
    tool: "search",
    arguments: { query: "migration status", limit: 5 },
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [{
    receivedContext: context,
    operation: "search",
    input: { query: "migration status", limit: 5 },
  }]);
  await assert.rejects(
    executeProjectHistoryTool(host, context, {
      threadId: "thread",
      turnId: context.turnId,
      callId: "call-2",
      namespace: "project_history",
      tool: "read",
      arguments: { runId: 0 },
    }),
    /positive safe integer/,
  );
});
