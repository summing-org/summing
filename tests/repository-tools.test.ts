import assert from "node:assert/strict";
import test from "node:test";
import {
  executeRepositoryTool,
  REPOSITORY_DYNAMIC_TOOLS,
  type RepositoryToolContext,
  type RepositoryToolHost,
  type RepositoryToolOperation,
} from "../src/repository-tools.js";

const context: RepositoryToolContext = {
  projectId: "project",
  workspaceId: "repo",
  repositoryPath: "/workspace",
  conversationId: "tg-00000000000000000000",
  actorUserId: 42,
  turnId: "turn-1",
};

test("repository tools expose only bounded managed-origin operations", () => {
  const namespace = REPOSITORY_DYNAMIC_TOOLS[0]!;
  assert.equal(namespace.name, "repository");
  assert.deepEqual(namespace.tools.map((tool) => tool.name), [
    "inspect",
    "verify_access",
    "pull",
    "push",
  ]);
  assert.match(namespace.description, /never exposes private key material/);
  const push = namespace.tools.find((tool) => tool.name === "push")!;
  assert.match(push.description, /without force/);
  assert.deepEqual(push.inputSchema.required, ["expectedHead"]);
});

test("repository tool dispatch validates namespace and expected HEAD", async () => {
  const calls: Array<{ operation: RepositoryToolOperation; expectedHead?: string }> = [];
  const host: RepositoryToolHost = {
    async repositoryTool(_context, operation, expectedHead) {
      calls.push({ operation, ...(expectedHead ? { expectedHead } : {}) });
      return { operation, head: expectedHead ?? "fresh" };
    },
  };
  const call = (
    tool: string,
    args: Record<string, unknown>,
    namespace: string | null = "repository",
  ) => executeRepositoryTool(host, context, {
    threadId: "thread-1",
    turnId: context.turnId,
    callId: `call-${tool}`,
    namespace,
    tool,
    arguments: args,
  });

  const inspected = await call("inspect", {});
  assert.equal(inspected.success, true);
  assert.deepEqual(JSON.parse(inspected.contentItems[0]!.text), {
    operation: "inspect",
    head: "fresh",
  });
  const head = "a".repeat(40);
  await call("pull", { expectedHead: head });
  await call("push", { expectedHead: head });
  await call("verify_access", {});
  assert.deepEqual(calls, [
    { operation: "inspect" },
    { operation: "pull", expectedHead: head },
    { operation: "push", expectedHead: head },
    { operation: "verify_access" },
  ]);
  await assert.rejects(call("pull", { expectedHead: "stale" }), /40-character Git commit id/);
  await assert.rejects(call("inspect", {}, "runner"), /unknown dynamic tool namespace/);
  await assert.rejects(call("force_push", {}), /unknown repository tool/);
});
