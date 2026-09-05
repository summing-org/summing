import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Deferred, Semaphore, waitForCompletion } from "../src/async-primitives.js";
import { ProjectConfig, RuntimeConfig } from "../src/config.js";
import { SummingRuntime } from "../src/runtime.js";
import type { Conversation } from "../src/state-store.js";
import type { TelegramObject } from "../src/telegram-api.js";

interface Controls {
  processAndAcknowledgeTelegramUpdate(update: TelegramObject, offset: number | null): Promise<number>;
  startIntakeWorkers(): void;
  intakeWorkers: Map<string, { promise: Promise<void> }>;
  processors: Map<string, Promise<void>>;
  semaphore: Semaphore;
  startProcessor(conversation: Conversation): void;
  startReviewProcessor(conversation: Conversation, replyTo: number, actor: number): void;
  executeReview(): Promise<void>;
  handleCommand(chat: number, topic: number, message: number, actor: number, type: string, text: string): Promise<void>;
}

function fixture(root: string) {
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  const projects = new Map(["alpha", "beta", "gamma"].map((id) => [id, new ProjectConfig(id, id, "repo", new Map([["repo", { id: "repo", path: repo }]]))]));
  const runtime = new SummingRuntime(new RuntimeConfig(join(root, "data"), join(root, "codex"), join(root, "worktrees"), "token", 1, "codex", 8765, 1, 0.5, "fake", "medium", false, projects));
  const control = runtime as unknown as Controls;
  const messages: string[] = [];
  runtime.telegram.sendMessage = async (_chat, text) => { messages.push(text); return messages.length; };
  runtime.telegram.sendChatAction = async () => {};
  runtime.telegram.editMessage = async () => {};
  runtime.telegram.deleteMessage = async () => {};
  runtime.telegram.downloadFile = async () => ({ data: Uint8Array.of(1, 2, 3), filePath: "voice.ogg", fileSize: 3 });
  control.startProcessor = () => {};
  return { runtime, control, messages };
}

function update(id: number, topic: number, text?: string): TelegramObject {
  return { update_id: id, message: { message_id: id, message_thread_id: topic, chat: { id: -100, type: "supergroup", is_forum: true }, from: { id: 1 },
    ...(text ? { text } : { voice: { file_id: `file-${id}`, mime_type: "audio/ogg", file_size: 3 } }) } };
}

async function drain(control: Controls) {
  while (control.intakeWorkers.size) await Promise.all([...control.intakeWorkers.values()].map((item) => item.promise));
}

test("slow audio acknowledges durably without blocking other topics; intake is bounded and ordered", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-intake-"));
  const { runtime, control, messages } = fixture(root);
  const topics = ["alpha", "beta", "gamma"].map((project, index) => runtime.state.bind(-100, index + 1, project, "repo"));
  const release = new Deferred<void>();
  const started = new Deferred<void>();
  let calls = 0;
  runtime.transcriber.transcribe = async () => { calls++; if (calls === 2) started.resolve(); await release.promise; return "hello audio"; };
  try {
    await control.processAndAcknowledgeTelegramUpdate(update(10, 1), null);
    await control.processAndAcknowledgeTelegramUpdate(update(11, 2), 11);
    await started.promise;
    await control.processAndAcknowledgeTelegramUpdate(update(12, 3), 12);
    await control.processAndAcknowledgeTelegramUpdate(update(13, 1, "after audio"), 13);
    await control.processAndAcknowledgeTelegramUpdate(update(14, 3, "/help"), 14);
    assert.equal(runtime.state.telegramOffset(), 15);
    assert.equal(runtime.state.telegramIntakes().length, 4);
    assert.equal(control.intakeWorkers.size, 2);
    assert.equal(calls, 2);
    assert.ok(messages.length > 0, "help is processed during transcription");
    assert.equal(runtime.state.pendingAll(topics[0]!.id).length, 0);
    release.resolve();
    await drain(control);
    assert.equal(calls, 3);
    assert.deepEqual(runtime.state.pendingAll(topics[0]!.id).map((item) => item.telegramMessageId), [10, 13]);
    assert.equal(runtime.state.telegramIntakes().length, 0);
  } finally { release.resolve(); runtime.requestStop(); await drain(control); runtime.state.close(); await runtime.telegram.close(); rmSync(root, { recursive: true, force: true }); }
});

test("cancel or rebind while transcribing cannot enqueue a late result", { timeout: 10_000 }, async () => {
  for (const action of ["cancel", "rebind"]) {
    const root = mkdtempSync(join(tmpdir(), "summing-intake-cancel-"));
    const { runtime, control } = fixture(root);
    const topic = runtime.state.bind(-100, 1, "alpha", "repo");
    const started = new Deferred<void>(); const release = new Deferred<void>();
    runtime.transcriber.transcribe = async () => { started.resolve(); await release.promise; return "must not run"; };
    try {
      await control.processAndAcknowledgeTelegramUpdate(update(10, 1), null);
      await started.promise;
      const path = runtime.state.telegramIntake(10)?.attachment?.filePath;
      assert.ok(path && existsSync(path));
      if (action === "cancel") await control.processAndAcknowledgeTelegramUpdate(update(11, 1, "/cancel"), 11);
      else runtime.state.bind(-100, 1, "beta", "repo");
      release.resolve(); await drain(control);
      assert.equal(runtime.state.pendingAll(topic.id).length, 0);
      assert.equal(runtime.state.telegramIntakes().length, 0);
      assert.equal(existsSync(path!), false);
    } finally { release.resolve(); runtime.requestStop(); await drain(control); runtime.state.close(); await runtime.telegram.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

test("restart resumes a checkpointed audio without redownloading or duplicating agent input", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-intake-restart-"));
  let { runtime, control } = fixture(root);
  const topic = runtime.state.bind(-100, 1, "alpha", "repo");
  const started = new Deferred<void>();
  runtime.transcriber.transcribe = async (_attachment, signal) => {
    started.resolve();
    await new Promise<void>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    return "";
  };
  try {
    await control.processAndAcknowledgeTelegramUpdate(update(10, 1), null);
    await started.promise;
    const path = runtime.state.telegramIntake(10)?.attachment?.filePath;
    runtime.requestStop(); await drain(control);
    assert.ok(path && existsSync(path));
    assert.equal(runtime.state.telegramIntakes().length, 1);
    runtime.state.close(); await runtime.telegram.close();
    ({ runtime, control } = fixture(root));
    runtime.telegram.downloadFile = async () => { throw new Error("must reuse checkpoint"); };
    runtime.transcriber.transcribe = async () => "resumed transcript";
    control.startIntakeWorkers(); await drain(control);
    assert.equal(runtime.state.telegramIntakes().length, 0);
    assert.equal(runtime.state.pendingAll(topic.id).length, 1);
    assert.match(runtime.state.pendingAll(topic.id)[0]!.text, /resumed transcript/);
    assert.equal(existsSync(path!), false);
    await control.processAndAcknowledgeTelegramUpdate(update(10, 1), 10);
    await drain(control);
    assert.equal(runtime.state.pendingAll(topic.id).length, 1, "provider redelivery after intake completion cannot duplicate input");
  } finally { runtime.requestStop(); await drain(control); runtime.state.close(); await runtime.telegram.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a queued review is really removed by cancel before semaphore admission", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-review-cancel-"));
  const { runtime, control } = fixture(root);
  const topic = runtime.state.bind(-100, 1, "alpha", "repo");
  const release = new Deferred<void>(); const entered = new Deferred<void>();
  const held = control.semaphore.run(async () => { entered.resolve(); await release.promise; });
  let calls = 0; control.executeReview = async () => { calls++; };
  try {
    await entered.promise;
    control.startReviewProcessor(topic, 10, 1);
    const queued = control.processors.get(topic.id)!;
    await control.handleCommand(-100, 1, 11, 1, "supergroup", "/cancel");
    await queued;
    assert.equal(calls, 0);
    release.resolve(); await held;
    assert.equal(calls, 0);
  } finally { release.resolve(); await held; runtime.requestStop(); runtime.state.close(); await runtime.telegram.close(); rmSync(root, { recursive: true, force: true }); }
});

test("review completion waits are bounded and cancellable", async () => {
  const controller = new AbortController();
  await assert.rejects(waitForCompletion(new Promise(() => {}), controller.signal, 1), /timeout/);
  const waiting = waitForCompletion(new Promise(() => {}), controller.signal, 60_000);
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
  await waitForCompletion(Promise.resolve(), new AbortController().signal, 60_000);
});

test("cancellation during workspace preparation cannot start a model turn", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-preparation-cancel-"));
  const { runtime, control } = fixture(root);
  const topic = runtime.state.bind(-100, 1, "alpha", "repo");
  const entered = new Deferred<void>();
  let turns = 0;
  runtime.codex.account = async () => ({ account: { type: "chatgpt" } });
  runtime.codex.startTurn = async () => { turns++; return "must-not-start"; };
  runtime.workspaces.runLockKey = async () => "fixture";
  runtime.workspaces.prepare = async (_conversation, _project, _workspace, signal) => {
    entered.resolve();
    return await new Promise<never>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  };
  let processor: Promise<void> | undefined;
  try {
    runtime.state.enqueueInput(topic.id, 10, "test", "followup");
    (SummingRuntime.prototype as unknown as Controls).startProcessor.call(runtime, topic);
    processor = control.processors.get(topic.id)!;
    await entered.promise;
    await control.handleCommand(-100, 1, 11, 1, "supergroup", "/cancel");
    await processor;
    assert.equal(turns, 0);
    assert.equal(runtime.state.projectRun("alpha", "repo", 1)?.status, "interrupted");
  } finally { runtime.requestStop(); await processor; runtime.state.close(); await runtime.telegram.close(); rmSync(root, { recursive: true, force: true }); }
});

test("write access is rechecked after a slow transcription", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-intake-acl-"));
  const { runtime, control } = fixture(root);
  const topic = runtime.state.bind(-100, 1, "alpha", "repo");
  const entered = new Deferred<void>(); const release = new Deferred<void>();
  let allowed = true;
  runtime.projects.isKnownOwner = () => true;
  runtime.projects.canAccess = () => allowed;
  runtime.transcriber.transcribe = async () => { entered.resolve(); await release.promise; return "explain the code"; };
  try {
    const input = update(10, 1);
    (input.message as TelegramObject).from = { id: 2 };
    await control.processAndAcknowledgeTelegramUpdate(input, null);
    await entered.promise; allowed = false; release.resolve();
    await drain(control);
    assert.equal(runtime.state.pendingAll(topic.id)[0]?.access, "read-only");
  } finally { release.resolve(); runtime.requestStop(); await drain(control); runtime.state.close(); await runtime.telegram.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed durable intake write does not acknowledge the Telegram update", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-intake-storage-"));
  const { runtime, control } = fixture(root);
  runtime.state.bind(-100, 1, "alpha", "repo");
  runtime.state.enqueueTelegramIntake = () => { throw new Error("disk full"); };
  try {
    await assert.rejects(control.processAndAcknowledgeTelegramUpdate(update(10, 1), null), /disk full/);
    assert.equal(runtime.state.telegramOffset(), null);
    assert.equal(control.intakeWorkers.size, 0);
  } finally { runtime.requestStop(); runtime.state.close(); await runtime.telegram.close(); rmSync(root, { recursive: true, force: true }); }
});
