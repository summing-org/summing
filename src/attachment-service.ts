import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";
import { TelegramAPI, TelegramError, type TelegramObject } from "./telegram-api.js";

export type AttachmentKind = "document" | "audio";

export interface StoredAttachment {
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  filePath: string;
  size: number;
}

interface TelegramFileCandidate {
  kind: AttachmentKind;
  fileId: string;
  fileName: string;
  mimeType: string;
  announcedSize: number;
}

export class AttachmentError extends Error {}

export interface AudioTranscriber {
  transcribe(attachment: StoredAttachment): Promise<string>;
}

const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".ogg",
  ".wav",
  ".webm",
]);

function record(value: unknown): TelegramObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as TelegramObject)
    : null;
}

function safeFileName(raw: string, fallback: string): string {
  const source = basename(raw.trim() || fallback).normalize("NFKC");
  const cleaned = source
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[\\/:*?\"<>|]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 160)
    .trim();
  return cleaned || fallback;
}

function inferExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";", 1)[0] ?? "";
  const extensions: Record<string, string> = {
    "audio/flac": ".flac",
    "audio/m4a": ".m4a",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "text/plain": ".txt",
  };
  return extensions[normalized] ?? "";
}

export function telegramAttachment(message: TelegramObject): TelegramFileCandidate | null {
  const messageId = Number(message.message_id ?? 0);
  const voice = record(message.voice);
  const audio = record(message.audio);
  const document = record(message.document);
  const value = voice ?? audio ?? document;
  if (!value || typeof value.file_id !== "string") return null;
  const mimeType = String(value.mime_type ?? "application/octet-stream").trim().toLowerCase();
  const originalName = String(value.file_name ?? "").trim();
  const extension = extname(originalName).toLowerCase() || inferExtension(mimeType);
  const nativeAudio = Boolean(voice || audio);
  const kind: AttachmentKind = nativeAudio || mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)
    ? "audio"
    : "document";
  const fallback = `${kind === "audio" ? "audio" : "document"}-${messageId || "telegram"}${extension}`;
  return {
    kind,
    fileId: value.file_id,
    fileName: safeFileName(originalName, fallback),
    mimeType,
    announcedSize: Number(value.file_size ?? 0),
  };
}

export class AttachmentService {
  readonly spoolRoot: string;

  constructor(
    readonly telegram: TelegramAPI,
    readonly dataDir: string,
    readonly maximumBytes = 20_000_000,
  ) {
    this.spoolRoot = resolve(dataDir, "attachments");
  }

  async download(message: TelegramObject, conversationId: string): Promise<StoredAttachment | null> {
    const candidate = telegramAttachment(message);
    if (!candidate) return null;
    if (
      Number.isFinite(candidate.announcedSize) &&
      candidate.announcedSize > this.maximumBytes
    ) {
      throw new AttachmentError("Файл слишком большой: Telegram-бот может скачать не более 20 МБ.");
    }
    let downloaded: Awaited<ReturnType<TelegramAPI["downloadFile"]>>;
    try {
      downloaded = await this.telegram.downloadFile(candidate.fileId, this.maximumBytes);
    } catch (error) {
      if (error instanceof TelegramError && error.message.includes("download limit")) {
        throw new AttachmentError("Файл слишком большой: Telegram-бот может скачать не более 20 МБ.");
      }
      throw error;
    }
    const extension = extname(candidate.fileName) || extname(downloaded.filePath);
    const fileName = safeFileName(candidate.fileName, `telegram-file${extension}`);
    this.ensurePrivateDirectory(this.spoolRoot);
    const conversationDir = resolve(this.spoolRoot, conversationId);
    this.ensurePrivateDirectory(conversationDir);
    const path = resolve(conversationDir, `${randomUUID()}-${fileName}`);
    writeFileSync(path, downloaded.data, { flag: "wx", mode: 0o600 });
    return {
      kind: candidate.kind,
      fileName,
      mimeType: candidate.mimeType,
      filePath: path,
      size: downloaded.fileSize,
    };
  }

  private ensurePrivateDirectory(path: string): void {
    if (existsSync(path)) {
      const existing = lstatSync(path);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new AttachmentError(`Небезопасный каталог вложений: ${path}`);
      }
    } else {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    try {
      chmodSync(path, 0o700);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
  }

  remove(attachments: Iterable<StoredAttachment>): void {
    for (const attachment of attachments) {
      const path = resolve(attachment.filePath);
      const withinRoot = relative(this.spoolRoot, path);
      if (withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || withinRoot.startsWith("/")) {
        continue;
      }
      try {
        if (existsSync(path) && lstatSync(path).isFile()) rmSync(path);
      } catch (error) {
        console.warn(`could not remove attachment spool file ${path}`, error);
      }
    }
  }
}

abstract class MultipartAudioTranscriber implements AudioTranscriber {
  constructor(
    readonly apiKey: string,
    readonly model: string,
    readonly endpoint: string,
    readonly providerName: string,
    readonly apiKeyName: string,
  ) {}

  async transcribe(attachment: StoredAttachment): Promise<string> {
    if (!this.apiKey) {
      throw new AttachmentError(
        `Транскрипция аудио через ${this.providerName} не настроена: ` +
          `администратору нужно добавить ${this.apiKeyName} ` +
          "в /etc/summing/summing.env и перезапустить сервис.",
      );
    }
    const form = new FormData();
    form.append(
      "file",
      new Blob([readFileSync(attachment.filePath)], { type: attachment.mimeType }),
      attachment.fileName,
    );
    form.append("model", this.model);
    form.append("response_format", "json");
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      throw new AttachmentError(`Не удалось связаться с ${this.providerName} API.`);
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    const body = record(result);
    if (!response.ok) {
      const apiError = record(body?.error);
      const detail =
        typeof apiError?.message === "string" ? `: ${apiError.message.slice(0, 500)}` : "";
      throw new AttachmentError(`${this.providerName} не смог транскрибировать аудио${detail}`);
    }
    const transcript = typeof body?.text === "string" ? body.text.trim() : "";
    if (!transcript) {
      throw new AttachmentError(`${this.providerName} вернул пустую транскрипцию аудио.`);
    }
    return transcript;
  }
}

export class OpenAITranscriber extends MultipartAudioTranscriber {
  constructor(
    apiKey: string,
    model = "gpt-transcribe",
    endpoint = "https://api.openai.com/v1/audio/transcriptions",
  ) {
    super(apiKey, model, endpoint, "OpenAI", "OPENAI_API_KEY");
  }
}

export class GroqWhisperTranscriber extends MultipartAudioTranscriber {
  constructor(
    apiKey: string,
    model = "whisper-large-v3-turbo",
    endpoint = "https://api.groq.com/openai/v1/audio/transcriptions",
  ) {
    super(apiKey, model, endpoint, "Groq", "GROQ_API_KEY");
  }
}
