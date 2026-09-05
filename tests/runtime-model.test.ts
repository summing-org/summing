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
    assert.match(replies.at(-1) ?? "", /Модель этого topic \(следующий run\): gpt-5\.6-luna/);
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

    const internals = runtime as unknown as {
      handleMessage(message: Record<string, unknown>): Promise<void>;
      modelCommands: Map<string, Promise<void>>;
      recordTurnModel(active: { runId: number; threadId: string; turnId: string }): void;
    };
    let finishCatalog!: (models: CodexModel[]) => void;
    runtime.codex.models = () => new Promise((resolve) => { finishCatalog = resolve; });
    await internals.handleMessage({
      message_id: 6, message_thread_id: 5, text: "/model astra high",
      from: { id: 1 }, chat: { id: -100, type: "supergroup" },
    });
    assert.ok(internals.modelCommands.has(alpha.id), "polling returns while catalog is still pending");
    await handleCommand(-100, 6, 7, 1, "supergroup", "/help");
    assert.ok(internals.modelCommands.has(alpha.id), "another topic can finish its command");
    const pending = internals.modelCommands.get(alpha.id)!;
    finishCatalog(catalog());
    await pending;
    assert.equal(runtime.state.get(alpha.id).modelOverride, "gpt-astra");

    const runId = runtime.state.startRun(alpha.id, "model evidence", []);
    runtime.state.setRunModel(runId, {
      requestedModel: "gpt-astra", requestedEffort: "high", model: null, effort: null, confirmation: null, reroutes: [],
    });
    const dispatch = (runtime.codex as unknown as { dispatch(value: unknown): Promise<void> }).dispatch.bind(runtime.codex);
    await dispatch({ method: "thread/settings/updated", params: { threadId: "thread", threadSettings: { model: "gpt-astra", effort: "high" } } });
    internals.recordTurnModel({ runId, threadId: "thread", turnId: "turn" });
    assert.equal(runtime.state.runModel(runId)?.confirmation, "settings");
    await dispatch({ method: "model/rerouted", params: { threadId: "thread", turnId: "turn", fromModel: "gpt-astra", toModel: "gpt-5.6-luna", reason: "capacity" } });
    internals.recordTurnModel({ runId, threadId: "thread", turnId: "turn" });
    assert.equal(runtime.state.runModel(runId)?.model, "gpt-5.6-luna");
    assert.equal(runtime.state.runModel(runId)?.requestedModel, "gpt-astra");
    assert.equal(runtime.state.runModel(runId)?.effort, null, "a reroute does not confirm effective effort");
  } finally {
    runtime.requestStop();
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
