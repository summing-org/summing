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
import { convertHeicToJpeg, type HeicConverter } from "./heic-converter.js";
import { TelegramAPI, TelegramError, type TelegramObject } from "./telegram-api.js";

export type AttachmentKind = "document" | "audio" | "image";

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

const IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

const IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const HEIC_EXTENSIONS = new Set([".heic", ".heif"]);
const HEIC_MIME_TYPES = new Set([
  "image/heic",
  "image/heic-sequence",
  "image/heif",
  "image/heif-sequence",
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
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heic-sequence": ".heic",
    "image/heif": ".heif",
    "image/heif-sequence": ".heif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "text/plain": ".txt",
  };
  return extensions[normalized] ?? "";
}

function largestTelegramPhoto(message: TelegramObject): TelegramObject | null {
  if (!Array.isArray(message.photo)) return null;
  let largest: TelegramObject | null = null;
  for (const item of message.photo) {
    const photo = record(item);
    if (!photo || typeof photo.file_id !== "string") continue;
    const pixels = Number(photo.width ?? 0) * Number(photo.height ?? 0);
    const largestPixels = Number(largest?.width ?? 0) * Number(largest?.height ?? 0);
    const size = Number(photo.file_size ?? 0);
    const largestSize = Number(largest?.file_size ?? 0);
    if (!largest || pixels > largestPixels || (pixels === largestPixels && size > largestSize)) {
      largest = photo;
    }
  }
  return largest;
}

function isHeic(fileName: string, mimeType: string): boolean {
  return HEIC_MIME_TYPES.has(mimeType) || HEIC_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function jpegFileName(fileName: string): string {
  const extension = extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  return safeFileName(`${stem || "photo"}.jpg`, "photo.jpg");
}

export function telegramAttachment(message: TelegramObject): TelegramFileCandidate | null {
  const messageId = Number(message.message_id ?? 0);
  const voice = record(message.voice);
  const audio = record(message.audio);
  const document = record(message.document);
  const photo = largestTelegramPhoto(message);
  const value = voice ?? audio ?? document ?? photo;
  if (!value || typeof value.file_id !== "string") return null;
  const nativeImage = Boolean(photo && value === photo);
  const mimeType = nativeImage
    ? "image/jpeg"
    : String(value.mime_type ?? "application/octet-stream").trim().toLowerCase();
  const originalName = String(value.file_name ?? "").trim();
  const extension = extname(originalName).toLowerCase() || inferExtension(mimeType) ||
    (nativeImage ? ".jpg" : "");
  const nativeAudio = Boolean(voice || audio);
  const kind: AttachmentKind =
    nativeAudio || mimeType.startsWith("audio/") || AUDIO_EXTENSIONS.has(extension)
      ? "audio"
      : nativeImage || IMAGE_MIME_TYPES.has(mimeType) || IMAGE_EXTENSIONS.has(extension)
        ? "image"
        : "document";
  const fallbackPrefix = kind === "audio" ? "audio" : kind === "image" ? "photo" : "document";
  const fallback = `${fallbackPrefix}-${messageId || "telegram"}${extension}`;
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
    readonly heicConverter: HeicConverter = convertHeicToJpeg,
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
    let data = downloaded.data;
    let mimeType = candidate.mimeType;
    let candidateName = candidate.fileName;
    if (candidate.kind === "image" && isHeic(candidate.fileName, candidate.mimeType)) {
      try {
        data = await this.heicConverter(downloaded.data);
      } catch {
        throw new AttachmentError(
          "Не удалось преобразовать HEIC/HEIF в JPEG. Попробуйте отправить фото через «Фото или видео».",
        );
      }
      mimeType = "image/jpeg";
      candidateName = jpegFileName(candidate.fileName);
    }
    if (data.byteLength > this.maximumBytes) {
      throw new AttachmentError("Файл слишком большой: Telegram-бот может обработать не более 20 МБ.");
    }
    const extension = extname(candidateName) || extname(downloaded.filePath);
    const fileName = safeFileName(candidateName, `telegram-file${extension}`);
    this.ensurePrivateDirectory(this.spoolRoot);
    const conversationDir = resolve(this.spoolRoot, conversationId);
    this.ensurePrivateDirectory(conversationDir);
    const path = resolve(conversationDir, `${randomUUID()}-${fileName}`);
    writeFileSync(path, data, { flag: "wx", mode: 0o600 });
    return {
      kind: candidate.kind,
      fileName,
      mimeType,
      filePath: path,
      size: data.byteLength,
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
