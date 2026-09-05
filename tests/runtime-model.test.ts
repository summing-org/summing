import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import type { CodexModel } from "../src/codex-app-server.js";
import { SummingRuntime } from "../src/runtime.js";

function catalog(): CodexModel[] {
  return [
    {
      id: "luna",
      model: "gpt-5.6-luna",
      displayName: "GPT 5.6 Luna",
      description: "Fast",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast" },
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deep" },
      ],
    },
    {
      id: "astra",
      model: "gpt-astra",
      displayName: "GPT Astra",
      description: "Advanced",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }],
    },
  ];
}

test("/model persists a validated model only for the current conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-model-"));
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
  const alpha = runtime.state.bind(-100, 5, "alpha", "repo");
  const beta = runtime.state.bind(-100, 6, "beta", "repo");
  const replies: string[] = [];
  runtime.telegram.sendMessage = async (_chatId, text) => {
    replies.push(text);
    return replies.length;
  };
  runtime.codex.models = async () => catalog();
  runtime.codex.account = async () => ({ account: { type: "chatgpt", planType: "plus" } });
  const handleCommand = (
    runtime as unknown as {
      handleCommand(
        chatId: number,
        topicId: number,
        messageId: number,
        senderId: number,
        chatType: string,
        text: string,
      ): Promise<void>;
    }
  ).handleCommand.bind(runtime);

  try {
    await handleCommand(-100, 5, 1, 1, "supergroup", "/model");
    assert.match(replies.at(-1) ?? "", /Модель этого topic: gpt-5\.6-luna/);
    assert.match(replies.at(-1) ?? "", /gpt-astra/);

    await handleCommand(-100, 5, 2, 1, "supergroup", "/model astra high");
    assert.deepEqual(
      [runtime.state.get(alpha.id).modelOverride, runtime.state.get(alpha.id).effortOverride],
      ["gpt-astra", "high"],
    );
    assert.deepEqual(
      [runtime.state.get(beta.id).modelOverride, runtime.state.get(beta.id).effortOverride],
      ["", ""],
    );

    await handleCommand(-100, 5, 3, 1, "supergroup", "/status");
    assert.match(replies.at(-1) ?? "", /Model: gpt-astra \(high, topic\)/);

    await handleCommand(-100, 5, 4, 1, "supergroup", "/model luna ultra");
    assert.match(replies.at(-1) ?? "", /доступны effort: low, medium, high/);
    assert.equal(runtime.state.get(alpha.id).modelOverride, "gpt-astra");

    await handleCommand(-100, 5, 5, 1, "supergroup", "/model default");
    assert.deepEqual(
      [runtime.state.get(alpha.id).modelOverride, runtime.state.get(alpha.id).effortOverride],
      ["", ""],
    );
    assert.match(replies.at(-1) ?? "", /Модель этого topic: gpt-5\.6-luna/);
  } finally {
    runtime.requestStop();
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
