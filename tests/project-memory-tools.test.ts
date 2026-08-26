import assert from "node:assert/strict";
import test from "node:test";
import {
  executeProjectMemoryTool,
  type ProjectMemoryToolContext,
} from "../src/project-memory-tools.js";

const context: ProjectMemoryToolContext = {
  projectId: "demo",
  workspaceId: "app",
  conversationId: "tg-00000000000000000000",
  actorUserId: 42,
  turnId: "turn",
  runId: 10,
};

test("project memory tools validate structured mutations and retain host scope", async () => {
  const calls: unknown[] = [];
  const host = {
    projectMemoryTool: async (
      receivedContext: ProjectMemoryToolContext,
      operation: "list" | "remember" | "supersede" | "archive",
      input: unknown,
    ) => {
      calls.push({ receivedContext, operation, input });
      return { ok: true };
    },
  };
  const result = await executeProjectMemoryTool(host, context, {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    namespace: "project_memory",
    tool: "remember",
    arguments: { kind: "constraint", text: "All timestamps use UTC" },
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [{
    receivedContext: context,
    operation: "remember",
    input: { kind: "constraint", text: "All timestamps use UTC" },
  }]);
  await assert.rejects(
    executeProjectMemoryTool(host, context, {
      threadId: "thread",
      turnId: "turn",
      callId: "bad",
      namespace: "project_memory",
      tool: "supersede",
      arguments: { itemId: 0, kind: "fact", text: "new" },
    }),
    /positive safe integer/,
  );
});
