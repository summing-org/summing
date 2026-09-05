import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";

test("parallel creates an independent bound topic and enforces access and validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-parallel-"));
  const alphaPath = join(root, "alpha");
  const betaPath = join(root, "beta");
  mkdirSync(alphaPath);
  mkdirSync(betaPath);
  const alphaWorkspace: WorkspaceConfig = { id: "repo", path: alphaPath };
  const betaWorkspace: WorkspaceConfig = { id: "repo", path: betaPath };
  const runtime = new SummingRuntime(new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "token",
    1,
    "codex",
    8_765,
    2,
    1,
    "",
    "medium",
    true,
    new Map([
      ["alpha", new ProjectConfig("alpha", "Alpha", "repo", new Map([["repo", alphaWorkspace]]))],
      ["beta", new ProjectConfig("beta", "Beta", "repo", new Map([["repo", betaWorkspace]]))],
    ]),
  ));
  const alpha = runtime.state.bind(-100123456, 5, "alpha", "repo");
  const beta = runtime.state.bind(-100123456, 6, "beta", "repo");
  const replies: string[] = [];
  runtime.telegram.sendMessage = async (_chatId, text) => {
    replies.push(text);
    return replies.length;
  };

  const handle = (runtime as unknown as { handleCommand(chatId: number, topicId: number,
    messageId: number, senderId: number, chatType: string, text: string): Promise<void>
  }).handleCommand.bind(runtime);
  runtime.state.recordTelegramChat({ chatId: -100123456, type: "supergroup", title: "Team", isForum: true });
  let calls = 0;
  runtime.telegram.call = async (method, payload) => {
    assert.equal(method, "createForumTopic");
    assert.deepEqual(payload, { chat_id: -100123456, name: "Feature" });
    calls++;
    return { message_thread_id: 42, name: "Feature" };
  };
  try {
    await handle(-100123456, 5, 1, 1, "supergroup", "/parallel");
    await handle(-100123456, 5, 2, 1, "supergroup", "/parallel " + "x".repeat(129));
    await handle(-100123456, 5, 3, 999, "supergroup", "/parallel Feature");
    await handle(-100123456, 55, 4, 1, "supergroup", "/parallel Feature");
    await handle(-100123456, 5, 5, 1, "private", "/parallel Feature");
    assert.equal(calls, 0);
    await handle(-100123456, 5, 6, 1, "supergroup", "/parallel Feature");
    assert.equal(calls, 1);
    const parallel = runtime.state.byTopic(-100123456, 42)!;
    assert.equal(parallel.projectId, alpha.projectId);
    assert.equal(parallel.workspaceId, alpha.workspaceId);
    assert.notEqual(parallel.id, alpha.id);
    assert.equal(parallel.isPrimary, false);
    assert.equal(parallel.codexThreadId, null);
    assert.equal(runtime.state.primaryConversation("alpha", "repo")?.id, alpha.id);
    assert.match(replies.at(-1)!, /t.me\/c\/123456\/42/);
    await handle(-100123456, 43, 7, 1, "supergroup", "/bind alpha repo");
    assert.equal(runtime.state.byTopic(-100123456, 43)?.isPrimary, false);
    runtime.telegram.call = async () => { throw new Error("not enough rights"); };
    await handle(-100123456, 5, 8, 1, "supergroup", "/parallel Feature");
    assert.match(replies.at(-1)!, /права управления топиками/);
    assert.equal(runtime.state.listConversations().length, 4);
    runtime.telegram.call = async () => {
      runtime.state.bind(-100123456, 5, "beta", "repo");
      return { message_thread_id: 50 };
    };
    await handle(-100123456, 5, 9, 1, "supergroup", "/parallel Feature");
    assert.equal(runtime.state.byTopic(-100123456, 50), null);
    assert.match(replies.at(-1)!, /Привязка исходного топика/);
  } finally {
    runtime.state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
