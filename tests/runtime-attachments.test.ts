import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectConfig, RuntimeConfig, type WorkspaceConfig } from "../src/config.js";
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

test("a Project portal captures an inbound attachment without reply, mention, or agent turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runtime-portal-attachment-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  const workspace: WorkspaceConfig = { id: "repo", path: repository };
  const project = new ProjectConfig("demo", "Demo", "repo", new Map([["repo", workspace]]));
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
  runtime.state.bind(-100, 5, "demo", "repo", "observer", {
    portalKey: "releases",
  });
  let processorStarts = 0;
  let replies = 0;
  Object.assign(runtime, {
    telegramBotId: 500,
    telegramUsername: "summing_bot",
    startProcessor: (): void => {
      processorStarts += 1;
    },
  });
  runtime.telegram.sendMessage = async () => {
    replies += 1;
    return 1;
  };
  const inboundPath = join(root, "release-notes.txt");
  writeFileSync(inboundPath, "customer release notes");
  runtime.attachments.download = async () => ({
    kind: "document",
    fileName: "release-notes.txt",
    mimeType: "text/plain",
    filePath: inboundPath,
    size: 22,
  });
  const handleMessage = (
    runtime as unknown as { handleMessage(message: TelegramObject): Promise<void> }
  ).handleMessage.bind(runtime);

  try {
    await handleMessage({
      message_id: 70,
      message_thread_id: 5,
      from: { id: 42, first_name: "Customer" },
      chat: { id: -100, type: "supergroup", title: "Customer portal", is_forum: true },
      document: {
        file_id: "release-notes-file",
        file_name: "release-notes.txt",
        mime_type: "text/plain",
        file_size: 22,
      },
    });
    await handleMessage({
      message_id: 71,
      message_thread_id: 5,
      text: "@summing_bot use these notes",
      from: { id: 42, first_name: "Customer" },
      chat: { id: -100, type: "supergroup", title: "Customer portal", is_forum: true },
    });
    assert.equal(processorStarts, 0);
    assert.equal(replies, 0);
    const source = runtime.state.teamSourceForProvider("telegram", "-100", "5");
    assert.ok(source);
    const attachment = runtime.state.recentTeamEvents(source.spaceId, source.id)
      .flatMap((event) => event.attachments)
      .find((item) => item.providerFileId === "release-notes-file");
    assert.match(attachment?.artifactId ?? "", /^[0-9a-f-]{36}$/);
    const artifact = runtime.projectPortalArtifacts.read(attachment!.artifactId!);
    assert.equal(new TextDecoder().decode(artifact.data), "customer release notes");
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
