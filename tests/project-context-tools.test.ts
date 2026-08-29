import assert from "node:assert/strict";
import test from "node:test";
import {
  executeProjectContextTool,
  type ProjectContextToolContext,
} from "../src/project-context-tools.js";

const context: ProjectContextToolContext = {
  projectId: "demo",
  workspaceId: "repo",
  conversationId: "tg-00000000000000000000",
  actorUserId: 42,
  turnId: "turn-current",
};

test("project context send requires an exact result and keeps routing host-scoped", async () => {
  const calls: unknown[] = [];
  const host = {
    projectContextTool: async (
      receivedContext: ProjectContextToolContext,
      operation: "sources" | "results" | "search" | "send",
      input: unknown,
    ) => {
      calls.push({ receivedContext, operation, input });
      return { ok: true };
    },
  };
  const resultId = "result-0123456789abcdef01234567";
  const result = await executeProjectContextTool(host, context, {
    threadId: "thread",
    turnId: context.turnId,
    callId: "call",
    namespace: "project_context",
    tool: "send",
    arguments: {
      resultId,
      text: "Customer-safe update",
      filePath: "report.txt",
      filePaths: ["details.pdf"],
      replyToMessageId: 701,
      idempotencyKey: "update-v1",
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [{
    receivedContext: context,
    operation: "send",
    input: {
      resultId,
      text: "Customer-safe update",
      filePaths: ["report.txt", "details.pdf"],
      replyToMessageId: 701,
      idempotencyKey: "update-v1",
    },
  }]);
  await assert.rejects(
    executeProjectContextTool(host, context, {
      threadId: "thread",
      turnId: context.turnId,
      callId: "call-invalid-result",
      namespace: "project_context",
      tool: "send",
      arguments: { resultId: "result-guessed", text: "unsafe route" },
    }),
    /exact resultId/,
  );
  await assert.rejects(
    executeProjectContextTool(host, context, {
      threadId: "thread",
      turnId: context.turnId,
      callId: "call-empty",
      namespace: "project_context",
      tool: "send",
      arguments: { resultId },
    }),
    /requires text or filePath/,
  );
});
