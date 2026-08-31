import assert from "node:assert/strict";
import test from "node:test";
import {
  executeProjectPortalTool,
  PROJECT_PORTAL_DYNAMIC_TOOLS,
  type ProjectPortalToolContext,
} from "../src/project-portal-tools.js";

const context: ProjectPortalToolContext = {
  projectId: "demo",
  workspaceId: "repo",
  conversationId: "tg-00000000000000000000",
  actorUserId: 42,
  turnId: "turn-current",
};

test("project portal send requires one explicit logical destination", async () => {
  const calls: unknown[] = [];
  const host = {
    projectPortalTool: async (
      receivedContext: ProjectPortalToolContext,
      operation: "sources" | "history" | "send" | "materialize_attachment",
      input: unknown,
    ) => {
      calls.push({ receivedContext, operation, input });
      return { ok: true };
    },
  };
  assert.deepEqual(
    PROJECT_PORTAL_DYNAMIC_TOOLS[0]?.tools
      .find((tool) => tool.name === "send")?.inputSchema.required,
    ["portalKey"],
  );
  await assert.rejects(
    executeProjectPortalTool(host, context, {
      threadId: "thread",
      turnId: context.turnId,
      callId: "call-missing-route",
      namespace: "project_portal",
      tool: "send",
      arguments: { text: "Release completed" },
    }),
    /requires portalKey/,
  );
  const result = await executeProjectPortalTool(host, context, {
    threadId: "thread",
    turnId: context.turnId,
    callId: "call-release",
    namespace: "project_portal",
    tool: "send",
    arguments: {
      portalKey: "releases",
      text: "Release completed",
      idempotencyKey: "release-42",
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [{
    receivedContext: context,
    operation: "send",
    input: {
      portalKey: "releases",
      text: "Release completed",
      idempotencyKey: "release-42",
    },
  }]);
});
