import { lstatSync, openSync, closeSync, readSync } from "node:fs";
import { extname } from "node:path";

export interface SecretDetection {
  kind: string;
}

const KNOWN_PATTERNS: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["stripe-secret", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ["google-api-key", /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ["telegram-bot-token", /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["credential-url", /https?:\/\/[^\s/:@]{1,128}:[^\s/@]{8,256}@/],
];

const ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key)\b\s*[:=]\s*["']?([^\s"'`,;]{20,262144})/gi;
const PLACEHOLDER = /^(?:replace[-_]?me|example|sample|placeholder|your[-_].*|test[-_].*|xxx+|redacted|changeme)$/i;
const TEXT_EXTENSIONS = new Set([
  ".conf", ".env", ".ini", ".json", ".md", ".properties", ".text", ".toml", ".txt", ".yaml", ".yml",
]);

function textLikeFile(fileName: string, mimeType: string): boolean {
  return mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    TEXT_EXTENSIONS.has(extname(fileName).toLowerCase()) ||
    fileName.toLowerCase().startsWith(".env");
}

export function detectSecretText(text: string): SecretDetection[] {
  if (!text) return [];
  if (text.length > 2_000_000) return [{ kind: "unscanned-large-text" }];
  const kinds = new Set<string>();
  for (const [kind, pattern] of KNOWN_PATTERNS) {
    if (pattern.test(text)) kinds.add(kind);
  }
  ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNMENT)) {
    const value = match[1] ?? "";
    if (!PLACEHOLDER.test(value) && /[A-Za-z]/.test(value) && /[0-9_\-./+=]/.test(value)) {
      kinds.add("credential-assignment");
    }
  }
  return [...kinds].sort().map((kind) => ({ kind }));
}

export function detectSecretFile(
  path: string,
  fileName: string,
  mimeType: string,
  maximumBytes = 1_000_000,
): SecretDetection[] {
  if (!textLikeFile(fileName, mimeType)) return [];
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return [];
  if (metadata.size > maximumBytes) return [{ kind: "unscanned-large-text" }];
  const size = metadata.size;
  const buffer = Buffer.alloc(size);
  const fd = openSync(path, "r");
  try {
    const bytes = readSync(fd, buffer, 0, size, 0);
    const sample = buffer.subarray(0, bytes);
    return detectSecretData(sample, fileName, mimeType, maximumBytes);
  } finally {
    buffer.fill(0);
    closeSync(fd);
  }
}

export function detectSecretData(
  data: Uint8Array,
  fileName: string,
  mimeType: string,
  maximumBytes = 1_000_000,
): SecretDetection[] {
  if (!textLikeFile(fileName, mimeType)) return [];
  if (data.byteLength > maximumBytes) return [{ kind: "unscanned-large-text" }];
  const sample = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (sample.includes(0)) return [{ kind: "unscanned-binary-text" }];
  return detectSecretText(sample.toString("utf8"));
}
