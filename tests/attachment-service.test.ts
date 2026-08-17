import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AttachmentService,
  GroqWhisperTranscriber,
  OpenAITranscriber,
  telegramAttachment,
  type StoredAttachment,
} from "../src/attachment-service.js";
import { TelegramAPI } from "../src/telegram-api.js";

test("recognizes Telegram documents, audio, photos, and image documents", () => {
  assert.equal(
    telegramAttachment({
      message_id: 1,
      document: {
        file_id: "zip",
        file_name: "../source.zip",
        mime_type: "application/zip",
        file_size: 27,
      },
    })?.kind,
    "document",
  );
  assert.deepEqual(
    telegramAttachment({
      message_id: 2,
      voice: { file_id: "voice", mime_type: "audio/ogg", file_size: 42 },
    }),
    {
      kind: "audio",
      fileId: "voice",
      fileName: "audio-2.ogg",
      mimeType: "audio/ogg",
      announcedSize: 42,
    },
  );
  assert.equal(
    telegramAttachment({
      message_id: 3,
      document: { file_id: "mp3", file_name: "memo.mp3", mime_type: "application/octet-stream" },
    })?.kind,
    "audio",
  );
  assert.deepEqual(
    telegramAttachment({
      message_id: 4,
      photo: [
        { file_id: "small", width: 90, height: 90, file_size: 400 },
        { file_id: "large", width: 1280, height: 960, file_size: 7_000 },
      ],
    }),
    {
      kind: "image",
      fileId: "large",
      fileName: "photo-4.jpg",
      mimeType: "image/jpeg",
      announcedSize: 7_000,
    },
  );
  assert.equal(
    telegramAttachment({
      message_id: 5,
      document: {
        file_id: "iphone-photo",
        file_name: "IMG_2410.HEIC",
        mime_type: "image/heic",
      },
    })?.kind,
    "image",
  );
});

test("stores Telegram attachments in the private spool and removes them", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-attachments-"));
  const telegram = new TelegramAPI("token");
  telegram.downloadFile = async () => ({
    data: new Uint8Array([80, 75, 3, 4]),
    filePath: "documents/archive.zip",
    fileSize: 4,
  });
  const service = new AttachmentService(telegram, root, 20);
  try {
    const attachment = await service.download(
      {
        message_id: 7,
        document: {
          file_id: "file",
          file_name: "../../project.zip",
          mime_type: "application/zip",
          file_size: 4,
        },
      },
      "tg-safe",
    );
    assert.ok(attachment);
    assert.equal(attachment.fileName, "project.zip");
    assert.equal(attachment.size, 4);
    assert.ok(existsSync(attachment.filePath));
    service.remove([attachment]);
    assert.equal(existsSync(attachment.filePath), false);
  } finally {
    await telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("converts HEIC image documents to JPEG before storing them", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-heic-attachments-"));
  const telegram = new TelegramAPI("token");
  telegram.downloadFile = async () => ({
    data: new Uint8Array([0, 0, 0, 24]),
    filePath: "documents/IMG_2410.HEIC",
    fileSize: 4,
  });
  let converterInput: number[] = [];
  const service = new AttachmentService(telegram, root, 20, async (data) => {
    converterInput = [...data];
    return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  });
  try {
    const attachment = await service.download(
      {
        message_id: 8,
        document: {
          file_id: "heic-file",
          file_name: "IMG_2410.HEIC",
          mime_type: "image/heic",
          file_size: 4,
        },
      },
      "tg-heic",
    );
    assert.ok(attachment);
    assert.deepEqual(converterInput, [0, 0, 0, 24]);
    assert.equal(attachment.kind, "image");
    assert.equal(attachment.fileName, "IMG_2410.jpg");
    assert.equal(attachment.mimeType, "image/jpeg");
    assert.equal(attachment.size, 4);
  } finally {
    await telegram.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenAI transcription uses the official multipart endpoint and exact default model", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-openai-"));
  const path = join(root, "voice.ogg");
  const attachment: StoredAttachment = {
    kind: "audio",
    fileName: "voice.ogg",
    mimeType: "audio/ogg",
    filePath: path,
    size: 4,
  };
  await import("node:fs/promises").then((fs) => fs.writeFile(path, new Uint8Array([1, 2, 3, 4])));
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let authorization = "";
  let model = "";
  let uploadedName = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = String(new Headers(init?.headers).get("authorization"));
    const form = init?.body as FormData;
    model = String(form.get("model"));
    uploadedName = (form.get("file") as File).name;
    return Response.json({ text: "Привет из голосового сообщения" });
  };
  try {
    const transcriber = new OpenAITranscriber("openai-secret");
    assert.equal(
      await transcriber.transcribe(attachment),
      "Привет из голосового сообщения",
    );
    assert.equal(requestUrl, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(authorization, "Bearer openai-secret");
    assert.equal(model, "gpt-transcribe");
    assert.equal(uploadedName, "voice.ogg");
    await assert.rejects(
      new OpenAITranscriber("").transcribe(attachment),
      /OPENAI_API_KEY/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Groq Whisper remains available as an optional transcriber", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-groq-"));
  const path = join(root, "voice.ogg");
  const attachment: StoredAttachment = {
    kind: "audio",
    fileName: "voice.ogg",
    mimeType: "audio/ogg",
    filePath: path,
    size: 4,
  };
  await import("node:fs/promises").then((fs) => fs.writeFile(path, new Uint8Array([1, 2, 3, 4])));
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let model = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    model = String((init?.body as FormData).get("model"));
    return Response.json({ text: "Groq transcript" });
  };
  try {
    assert.equal(
      await new GroqWhisperTranscriber("groq-secret").transcribe(attachment),
      "Groq transcript",
    );
    assert.equal(requestUrl, "https://api.groq.com/openai/v1/audio/transcriptions");
    assert.equal(model, "whisper-large-v3-turbo");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
