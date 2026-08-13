import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    const pending = runtime.state.pendingAll(conversation.id);
    assert.equal(pending.length, 3);
    assert.match(pending[0]?.text ?? "", /Транскрипция аудио «voice\.ogg»/);
    assert.match(pending[0]?.text ?? "", /Нужно проверить этот архив/);
    assert.deepEqual(pending[0]?.attachments, []);
    assert.equal(pending[1]?.text, "Посмотри эту программу");
    assert.deepEqual(pending[1]?.attachments.map((item) => item.fileName), ["source.zip"]);
    assert.match(pending[2]?.text ?? "", /Изучи приложенный файл «source\.zip»/);
  } finally {
    runtime.state.close();
    await runtime.telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});
