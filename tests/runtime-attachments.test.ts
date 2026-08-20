import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
import type { RunnerApproval } from "../src/project-runner-client.js";
import { SummingRuntime } from "../src/runtime.js";
import type { TelegramObject } from "../src/telegram-api.js";

test("voice is transcribed through the configured provider while documents remain queued attachments", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-attachments-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  const workspace: WorkspaceConfig = { id: "repo", path: repository };
  const project = new ProjectConfig(
    "demo",
    "Demo",
    "repo",
    new Map([["repo", workspace]]),
  );
  const config = new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "telegram-token",
    1,
    "codex",
    8765,
    2,
    1,
    "",
    "medium",
    true,
    new Map([["demo", project]]),
    20,
    12,
    60,
    "openai",
    "gpt-transcribe",
    "openai-key",
  );
  const runtime = new SummingRuntime(config);
  const conversation = runtime.state.bind(1, 0, "demo", "repo");
  Object.assign(runtime, { startProcessor: (): void => undefined });
  runtime.attachments.download = async (message) => {
    if (message.voice) {
      return {
        kind: "audio",
        fileName: "voice.ogg",
        mimeType: "audio/ogg",
        filePath: join(root, "voice.ogg"),
        size: 4,
      };
    }
    if (message.photo) {
      return {
        kind: "image",
        fileName: "photo-13.jpg",
        mimeType: "image/jpeg",
        filePath: join(root, "photo-13.jpg"),
        size: 8,
      };
    }
    return {
      kind: "document",
      fileName: "source.zip",
      mimeType: "application/zip",
      filePath: join(root, "source.zip"),
      size: 27,
    };
  };
  runtime.transcriber.transcribe = async () => "Нужно проверить этот архив";
  const handleMessage = (
    runtime as unknown as { handleMessage(message: TelegramObject): Promise<void> }
  ).handleMessage.bind(runtime);

  try {
    await handleMessage({
      message_id: 10,
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      voice: { file_id: "voice-id", mime_type: "audio/ogg", file_size: 4 },
    });
    await handleMessage({
      message_id: 11,
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      caption: "Посмотри эту программу",
      document: {
        file_id: "document-id",
        file_name: "source.zip",
        mime_type: "application/zip",
        file_size: 27,
      },
    });
    await handleMessage({
      message_id: 12,
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      document: {
        file_id: "document-without-caption",
        file_name: "source.zip",
        mime_type: "application/zip",
        file_size: 27,
      },
    });
    await handleMessage({
      message_id: 13,
      from: { id: 1 },
      chat: { id: 1, type: "private" },
      caption: "Добавь к фото смартфон",
      photo: [
        { file_id: "photo-small", width: 90, height: 90, file_size: 2 },
        { file_id: "photo-large", width: 1280, height: 960, file_size: 8 },
      ],
    });
    const pending = runtime.state.pendingAll(conversation.id);
    assert.equal(pending.length, 4);
    assert.match(pending[0]?.text ?? "", /Транскрипция аудио «voice\.ogg»/);
    assert.match(pending[0]?.text ?? "", /Нужно проверить этот архив/);
    assert.deepEqual(pending[0]?.attachments, []);
    assert.deepEqual(pending[0]?.audioTranscript, {
      fileName: "voice.ogg",
      text: "Нужно проверить этот архив",
    });
    assert.equal(pending[1]?.text, "Посмотри эту программу");
    assert.deepEqual(pending[1]?.attachments.map((item) => item.fileName), ["source.zip"]);
    assert.match(pending[2]?.text ?? "", /Изучи приложенный файл «source\.zip»/);
    assert.equal(pending[3]?.text, "Добавь к фото смартфон");
    assert.deepEqual(pending[3]?.attachments.map((item) => item.kind), ["image"]);
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a direct reply reuses the stored voice transcript without downloading audio again", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-audio-reply-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  const workspace: WorkspaceConfig = { id: "repo", path: repository };
  const project = new ProjectConfig(
    "demo",
    "Demo",
    "repo",
    new Map([["repo", workspace]]),
  );
  const config = new RuntimeConfig(
    join(root, "data"),
    join(root, "codex"),
    join(root, "worktrees"),
    "telegram-token",
    1,
    "codex",
    8765,
    2,
    1,
    "",
    "medium",
    true,
    new Map([["demo", project]]),
    20,
    12,
    60,
    "openai",
    "gpt-transcribe",
    "openai-key",
  );
  const runtime = new SummingRuntime(config);
  const conversation = runtime.state.bind(-100, 5, "demo", "repo");
  Object.assign(runtime, {
    telegramUsername: "summing_bot",
    startProcessor: (): void => undefined,
  });
  let downloadCalls = 0;
  let transcriptionCalls = 0;
  runtime.attachments.download = async () => {
    downloadCalls += 1;
    return {
      kind: "audio",
      fileName: "voice.ogg",
      mimeType: "audio/ogg",
      filePath: join(root, "voice.ogg"),
      size: 4,
    };
  };
  runtime.transcriber.transcribe = async () => {
    transcriptionCalls += 1;
    return "Антон, создай документ и пришли ссылку";
  };
  const handleMessage = (
    runtime as unknown as { handleMessage(message: TelegramObject): Promise<void> }
  ).handleMessage.bind(runtime);

  try {
    await handleMessage({
      message_id: 20,
      message_thread_id: 5,
      from: { id: 1, first_name: "Owner" },
      chat: { id: -100, type: "supergroup", title: "Team" },
      voice: { file_id: "voice-id", mime_type: "audio/ogg", file_size: 4 },
    });
    runtime.state.consume(runtime.state.pendingAll(conversation.id).map((item) => item.id));

    await handleMessage({
      message_id: 20,
      message_thread_id: 5,
      text: "Чужой Source не должен попасть в reply context",
      from: { id: 2, first_name: "Other" },
      chat: { id: -200, type: "supergroup", title: "Other team" },
    });

    await handleMessage({
      message_id: 21,
      message_thread_id: 5,
      text: "@summing_bot что сказано в этом аудио?",
      from: { id: 1, first_name: "Owner" },
      chat: { id: -100, type: "supergroup", title: "Team" },
      reply_to_message: {
        message_id: 20,
        from: { id: 1, first_name: "Owner" },
        voice: { file_id: "voice-id", mime_type: "audio/ogg", file_size: 4 },
      },
    });

    const replyInput = runtime.state.pendingAll(conversation.id)[0];
    assert.ok(replyInput);
    assert.match(replyInput.text, /"depth": 1/);
    assert.match(replyInput.text, /Транскрипция аудио «voice\.ogg»/);
    assert.match(replyInput.text, /Антон, создай документ и пришли ссылку/);
    assert.doesNotMatch(replyInput.text, /Чужой Source/);
    assert.equal(downloadCalls, 1);
    assert.equal(transcriptionCalls, 1);
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reply to the approval prompt is recorded without intercepting ordinary bot replies", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-approval-feedback-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  const workspace: WorkspaceConfig = { id: "repo", path: repository };
  const project = new ProjectConfig(
    "demo",
    "Demo",
    "repo",
    new Map([["repo", workspace]]),
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
    1,
    "",
    "medium",
    true,
    new Map([["demo", project]]),
  ));
  const approval: RunnerApproval = {
    projectId: "demo",
    workspaceId: "repo",
    jobId: "job-1",
    planId: "plan-1",
    digest: "a".repeat(64),
    reportArtifact: "report.html",
    message: "План plan-1 готов к согласованию.",
    callbackToken: "a".repeat(24),
    status: "changes_requested",
    chatId: -100,
    topicId: 5,
    messageId: 78032,
    authorizedUserId: 7460594016,
    authorizedUserIds: [7460594016],
    decidedBy: null,
    decidedAt: null,
    feedbackRequestedBy: 7460594016,
    feedbackRequestedAt: "2026-08-20T07:34:00.000Z",
    feedbackPromptMessageId: 78060,
    feedbackMessageId: 78061,
    feedbackText: "Нужен лёгкий контент.",
    feedbackBy: 7460594016,
    feedbackAt: "2026-08-20T07:35:04.000Z",
    createdAt: "2026-08-20T06:22:00.000Z",
    updatedAt: "2026-08-20T07:35:04.000Z",
  };
  let recorded: Record<string, unknown> | null = null;
  let editedMessageId = 0;
  const replies: string[] = [];
  runtime.viewer.runner.recordApprovalFeedback = async (input) => {
    recorded = input;
    return approval;
  };
  runtime.runnerControl.notifyApprovalFeedback = async () => true;
  runtime.telegram.editMessageCaption = async (_chatId, messageId) => {
    editedMessageId = messageId;
  };
  runtime.telegram.sendMessage = async (_chatId, text) => {
    replies.push(text);
    return 78062;
  };
  const handleMessage = (
    runtime as unknown as { handleMessage(message: TelegramObject): Promise<void> }
  ).handleMessage.bind(runtime);

  try {
    await handleMessage({
      message_id: 78061,
      message_thread_id: 5,
      text: "Нужен лёгкий контент.",
      from: { id: 7460594016, first_name: "Customer" },
      chat: { id: -100, type: "supergroup", title: "Customer topic" },
      reply_to_message: {
        message_id: 78060,
        from: { id: 123, is_bot: true, username: "hash0_bot" },
        text: "Опишите одним сообщением, что нужно изменить в плане plan-1.",
      },
    });

    assert.deepEqual(recorded, {
      chatId: -100,
      topicId: 5,
      replyToMessageId: 78060,
      messageId: 78061,
      userId: 7460594016,
      text: "Нужен лёгкий контент.",
    });
    assert.equal(editedMessageId, 78032);
    assert.match(replies[0] ?? "", /сохранены и переданы в Project/);
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
