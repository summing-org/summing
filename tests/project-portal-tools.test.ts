import assert from "node:assert/strict";
import test from "node:test";
import {
  executeExternalMessageTool,
  EXTERNAL_MESSAGE_DYNAMIC_TOOLS,
  type ExternalMessageToolContext,
} from "../src/project-portal-tools.js";

const context: Omit<ExternalMessageToolContext, "callId"> = {
  projectId: "demo",
  workspaceId: "repo",
  conversationId: "tg-00000000000000000000",
  actorUserId: 42,
  turnId: "turn-current",
};

test("external message send requires one exact destination and hides idempotency", async () => {
  const calls: unknown[] = [];
  const host = {
    externalMessageTool: async (
      receivedContext: ExternalMessageToolContext,
      operation: "destinations" | "bind" | "unbind" | "history" | "send" |
        "materialize_attachment",
      input: unknown,
    ) => {
      calls.push({ receivedContext, operation, input });
      return { ok: true };
    },
  };
  assert.deepEqual(
    EXTERNAL_MESSAGE_DYNAMIC_TOOLS[0]?.tools
      .find((tool) => tool.name === "send")?.inputSchema.required,
    ["chatId", "topicId"],
  );
  assert.equal(
    Object.hasOwn(
      EXTERNAL_MESSAGE_DYNAMIC_TOOLS[0]?.tools
        .find((tool) => tool.name === "send")?.inputSchema.properties ?? {},
      "idempotencyKey",
    ),
    false,
  );
  await assert.rejects(
    executeExternalMessageTool(host, context, {
      threadId: "thread",
      turnId: context.turnId,
      callId: "call-missing-route",
      namespace: "external_message",
      tool: "send",
      arguments: { text: "Release completed" },
    }),
    /chatId/,
  );
  const result = await executeExternalMessageTool(host, context, {
    threadId: "thread",
    turnId: context.turnId,
    callId: "call-release",
    namespace: "external_message",
    tool: "send",
    arguments: {
      chatId: -100500,
      topicId: 17,
      text: "Release completed",
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, [{
    receivedContext: { ...context, callId: "call-release" },
    operation: "send",
    input: {
      chatId: -100500,
      topicId: 17,
      text: "Release completed",
    },
  }]);
});

test("external message history accepts either all routes or one complete exact route", async () => {
  const host = { externalMessageTool: async () => ({ ok: true }) };
  await executeExternalMessageTool(host, context, {
    threadId: "thread",
    turnId: context.turnId,
    callId: "history-all",
    namespace: "external_message",
    tool: "history",
    arguments: {},
  });
  await assert.rejects(
    executeExternalMessageTool(host, context, {
      threadId: "thread",
      turnId: context.turnId,
      callId: "history-half",
      namespace: "external_message",
      tool: "history",
      arguments: { chatId: -100500 },
    }),
    /chatId and topicId together/,
  );
});
