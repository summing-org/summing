import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ProjectConfig, RuntimeConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

async function reviewFixture(mutatesWorkspace: boolean): Promise<{
  review: ReturnType<SummingRuntime["state"]["runReview"]>;
  messages: string[];
}> {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-review-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  writeFileSync(join(repository, "README.md"), "before\n");
  git(repository, "init");
  git(repository, "config", "user.email", "test@example.com");
  git(repository, "config", "user.name", "Test");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  writeFileSync(join(repository, "README.md"), "candidate\n");
  const project = new ProjectConfig(
    "demo",
    "Demo",
    "repo",
    new Map([["repo", { id: "repo", path: repository }]]),
  );
  const runtime = new SummingRuntime(new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "telegram-token",
    1,
    "codex",
    8765,
    2,
    0.5,
    "",
    "medium",
    true,
    new Map([["demo", project]]),
  ));
  runtime.workspaces.initialize();
  const conversation = runtime.state.bind(42, 0, "demo", "repo");
  runtime.state.setConversationModel(conversation.id, "gpt-astra", "high");
  runtime.state.setThread(conversation.id, "stale-qa-thread", "read-only");
  const messages: string[] = [];
  runtime.telegram.sendChatAction = async () => undefined;
  runtime.telegram.sendMessage = async (_chatId, text) => {
    messages.push(text);
    return messages.length;
  };
  runtime.telegram.editMessage = async () => undefined;
  runtime.telegram.deleteMessage = async () => undefined;
  runtime.codex.account = async () => ({ account: { type: "chatgpt" } });
  let reviewCwd = repository;
  runtime.codex.startThread = async (cwd, model, options) => {
    reviewCwd = cwd;
    assert.equal(model, "gpt-astra");
    assert.equal(options?.readOnly, true);
    assert.equal(options?.networkAccess, false);
    assert.equal(options?.effort, "high");
    assert.equal(options?.reviewModel, "gpt-astra");
    return "thread-review-source";
  };
  runtime.codex.unsubscribeThread = async () => undefined;
  const routeCodexEvent = (
    runtime as unknown as {
      routeCodexEvent(event: {
        method: string;
        params: Record<string, unknown>;
      }): Promise<void>;
    }
  ).routeCodexEvent.bind(runtime);
  runtime.codex.startReview = async (threadId, target, delivery) => {
    assert.equal(threadId, "thread-review-source");
    assert.deepEqual(target, { type: "uncommittedChanges" });
    assert.equal(delivery, "detached");
    setImmediate(() => {
      void (async () => {
        if (mutatesWorkspace) writeFileSync(join(reviewCwd, "README.md"), "reviewer mutation\n");
        await routeCodexEvent({
          method: "item/completed",
          params: {
            threadId: "thread-review-detached",
            turnId: "turn-review",
            item: {
              id: "review-result",
              type: "exitedReviewMode",
              review: "[P1] Проверить обратную совместимость.",
            },
          },
        });
        await routeCodexEvent({
          method: "turn/completed",
          params: {
            threadId: "thread-review-detached",
            turnId: "turn-review",
            turn: { id: "turn-review", status: "completed" },
          },
        });
      })();
    });
    return { reviewThreadId: "thread-review-detached", turnId: "turn-review" };
  };
  const executeReview = (
    runtime as unknown as {
      executeReview(conversationId: string, replyTo: number, actorUserId: number): Promise<void>;
    }
  ).executeReview.bind(runtime);
  try {
    await executeReview(conversation.id, 17, 1);
    assert.equal(runtime.state.get(conversation.id).readOnlyCodexThreadId, "stale-qa-thread");
    assert.equal(runtime.state.runModel(1)?.requestedEffort, "high");
    assert.equal(runtime.state.runModel(1)?.model, null, "a request is not execution evidence");
    return { review: runtime.state.runReview(1), messages };
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("review runs detached from a read-only source thread and persists findings", async () => {
  const result = await reviewFixture(false);
  assert.equal(result.review?.delivery, "detached");
  assert.equal(result.review?.reviewThreadId, "thread-review-detached");
  assert.equal(result.review?.status, "completed");
  assert.equal(result.review?.workspaceChanged, false);
  assert.equal(result.review?.findings, "[P1] Проверить обратную совместимость.");
  assert.ok(result.messages.some((message) => message.includes("обратную совместимость")));
});

test("a detached review that changes the workspace is invalidated", async () => {
  const result = await reviewFixture(true);
  assert.equal(result.review?.status, "failed");
  assert.equal(result.review?.workspaceChanged, true);
  assert.match(result.review?.error ?? "", /changed the workspace/);
  assert.ok(result.messages.some((message) => message.includes("Reviewer изменил workspace")));
});
