import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { sha256File } from "./object-store.js";

const MAGIC = Buffer.from("SUMMING-NODE-COMPONENT-V1\n", "utf8");
const CIPHER = "aes-256-gcm";
const MAX_HEADER_BYTES = 64 * 1024;

export interface NodeRecoveryArchiveSource {
  sourcePath: string;
  archivePath: string;
  optional?: boolean;
  excludeSegments?: readonly string[];
  excludeSecretFiles?: boolean;
}

export interface NodeRecoveryArchiveEntry {
  path: string;
  type: "directory" | "file" | "symlink";
  size: number;
  mode: number;
  mtimeMs: number;
  sha256: string;
  linkTarget: string;
}

export interface EncryptedNodeRecoveryComponent {
  sha256: string;
  size: number;
  iv: string;
  tag: string;
  entries: number;
  files: number;
  plaintextBytes: number;
  warnings: string[];
}

export interface InspectedNodeRecoveryComponent {
  entries: number;
  files: number;
  plaintextBytes: number;
  warnings: string[];
}

function safeArchivePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("\0")) throw new Error("node recovery archive path is empty");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("node recovery archive path is unsafe");
  }
  return parts.join("/");
}

function safeLinkTarget(archivePath: string, value: string): string {
  if (!value || value.includes("\0") || value.startsWith("/") || value.includes("\\")) {
    throw new Error("node recovery symlink target is unsafe");
  }
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(archivePath), value));
  if (resolvedTarget === ".." || resolvedTarget.startsWith("../") || resolvedTarget.startsWith("/")) {
    throw new Error("node recovery symlink escapes its component");
  }
  return value;
}

function secretFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") ||
    /(?:^|[._-])(?:secret|credentials?|token|password)(?:[._-]|$)/i.test(name) ||
    /\.(?:key|pem|p12|pfx)$/i.test(name);
}

async function fileDigest(path: string): Promise<string> {
  return (await sha256File(path)).sha256;
}

async function collectEntries(
  sources: readonly NodeRecoveryArchiveSource[],
): Promise<{ entries: Array<NodeRecoveryArchiveEntry & { sourcePath: string }>; warnings: string[] }> {
  const entries: Array<NodeRecoveryArchiveEntry & { sourcePath: string }> = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const visit = async (
    sourcePath: string,
    archivePath: string,
    source: NodeRecoveryArchiveSource,
  ): Promise<void> => {
    let stat;
    try {
      stat = lstatSync(sourcePath);
    } catch (error) {
      if (source.optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
        warnings.push(`optional source is missing: ${archivePath}`);
        return;
      }
      throw error;
    }
    const safePath = safeArchivePath(archivePath);
    if (seen.has(safePath)) throw new Error(`duplicate node recovery archive path: ${safePath}`);
    const name = safePath.split("/").at(-1)!;
    const segments = new Set(source.excludeSegments ?? []);
    if (segments.has(name) || (source.excludeSecretFiles && secretFile(name))) {
      warnings.push(`excluded from node recovery: ${safePath}`);
      return;
    }

    if (stat.isSymbolicLink()) {
      const target = safeLinkTarget(safePath, readlinkSync(sourcePath));
      seen.add(safePath);
      entries.push({
        sourcePath,
        path: safePath,
        type: "symlink",
        size: 0,
        mode: stat.mode & 0o777,
        mtimeMs: stat.mtimeMs,
        sha256: "",
        linkTarget: target,
      });
      return;
    }
    if (stat.isDirectory()) {
      seen.add(safePath);
      entries.push({
        sourcePath,
        path: safePath,
        type: "directory",
        size: 0,
        mode: stat.mode & 0o777,
        mtimeMs: stat.mtimeMs,
        sha256: "",
        linkTarget: "",
      });
      for (const child of readdirSync(sourcePath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        await visit(join(sourcePath, child.name), posix.join(safePath, child.name), {
          ...source,
          optional: false,
        });
      }
      return;
    }
    if (!stat.isFile()) {
      warnings.push(`unsupported filesystem entry omitted: ${safePath}`);
      return;
    }
    seen.add(safePath);
    entries.push({
      sourcePath,
      path: safePath,
      type: "file",
      size: stat.size,
      mode: stat.mode & 0o777,
      mtimeMs: stat.mtimeMs,
      sha256: await fileDigest(sourcePath),
      linkTarget: "",
    });
  };

  for (const source of sources) {
    await visit(resolve(source.sourcePath), safeArchivePath(source.archivePath), source);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { entries, warnings };
}

function writeChunk(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      stream.removeListener("error", onError);
    };
    stream.once("error", onError);
    stream.write(chunk, () => {
      cleanup();
      resolveWrite();
    });
  });
}

export async function createEncryptedNodeRecoveryComponent(
  sources: readonly NodeRecoveryArchiveSource[],
  outputPath: string,
  key: Buffer,
): Promise<EncryptedNodeRecoveryComponent> {
  if (key.length !== 32) throw new Error("node recovery component key must contain 32 bytes");
  const collected = await collectEntries(sources);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(outputPath, { mode: 0o600 });
  const piping = pipeline(gzip, cipher, output);
  let plaintextBytes = 0;
  try {
    await writeChunk(gzip, MAGIC);
    for (const entry of collected.entries) {
      const { sourcePath: _sourcePath, ...header } = entry;
      const body = Buffer.from(JSON.stringify(header), "utf8");
      if (body.length > MAX_HEADER_BYTES) throw new Error("node recovery archive header is too large");
      const size = Buffer.allocUnsafe(4);
      size.writeUInt32BE(body.length);
      await writeChunk(gzip, size);
      await writeChunk(gzip, body);
      if (entry.type !== "file") continue;
      plaintextBytes += entry.size;
      for await (const chunk of createReadStream(entry.sourcePath)) {
        await writeChunk(gzip, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }
    gzip.end();
    await piping;
    const digest = await sha256File(outputPath);
    return {
      ...digest,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      entries: collected.entries.length,
      files: collected.entries.filter((entry) => entry.type === "file").length,
      plaintextBytes,
      warnings: collected.warnings,
    };
  } catch (error) {
    gzip.destroy();
    cipher.destroy();
    output.destroy();
    await piping.catch(() => undefined);
    rmSync(outputPath, { force: true });
    throw error;
  }
}

function readExact(
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number,
): "ok" | "eof" {
  let cursor = 0;
  while (cursor < length) {
    const bytes = readSync(descriptor, buffer, offset + cursor, length - cursor, null);
    if (bytes === 0) {
      if (cursor === 0) return "eof";
      throw new Error("node recovery archive is truncated");
    }
    cursor += bytes;
  }
  return "ok";
}

function writeAll(descriptor: number, buffer: Buffer, length: number): void {
  let cursor = 0;
  while (cursor < length) {
    cursor += writeSync(descriptor, buffer, cursor, length - cursor);
  }
}

function safeExtractionTarget(root: string, archivePath: string): string {
  const safePath = safeArchivePath(archivePath);
  const target = resolve(root, ...safePath.split("/"));
  const canonicalRoot = resolve(root);
  if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("node recovery archive entry escapes extraction root");
  }
  return target;
}

function parseArchive(
  path: string,
  maximumBytes: number,
  extractionRoot?: string,
): InspectedNodeRecoveryComponent {
  const descriptor = openSync(path, "r");
  const warnings: string[] = [];
  let entries = 0;
  let files = 0;
  let plaintextBytes = 0;
  try {
    const magic = Buffer.alloc(MAGIC.length);
    if (readExact(descriptor, magic, 0, magic.length) === "eof" || !magic.equals(MAGIC)) {
      throw new Error("node recovery component archive has an invalid header");
    }
    while (true) {
      const sizeBuffer = Buffer.alloc(4);
      if (readExact(descriptor, sizeBuffer, 0, sizeBuffer.length) === "eof") break;
      const headerBytes = sizeBuffer.readUInt32BE(0);
      if (headerBytes <= 0 || headerBytes > MAX_HEADER_BYTES) {
        throw new Error("node recovery archive entry header is invalid");
      }
      const headerBuffer = Buffer.alloc(headerBytes);
      if (readExact(descriptor, headerBuffer, 0, headerBytes) === "eof") {
        throw new Error("node recovery archive entry header is truncated");
      }
      const entry = JSON.parse(headerBuffer.toString("utf8")) as NodeRecoveryArchiveEntry;
      if (!entry || !["directory", "file", "symlink"].includes(entry.type)) {
        throw new Error("node recovery archive entry type is invalid");
      }
      safeArchivePath(entry.path);
      const target = extractionRoot ? safeExtractionTarget(extractionRoot, entry.path) : "";
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > maximumBytes) {
        throw new Error("node recovery archive entry size is invalid");
      }
      if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
        throw new Error("node recovery archive entry mode is invalid");
      }
      if (!Number.isFinite(entry.mtimeMs) || entry.mtimeMs < 0) {
        throw new Error("node recovery archive entry timestamp is invalid");
      }
      entries += 1;
      if (entry.type === "directory") {
        if (entry.size !== 0) throw new Error("node recovery directory entry has content");
        if (target) mkdirSync(target, { recursive: true, mode: entry.mode || 0o700 });
        continue;
      }
      if (entry.type === "symlink") {
        if (entry.size !== 0) throw new Error("node recovery symlink entry has content");
        const linkTarget = safeLinkTarget(entry.path, entry.linkTarget);
        if (target) {
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          if (existsSync(target)) throw new Error(`node recovery archive path already exists: ${entry.path}`);
          symlinkSync(linkTarget, target);
        }
        continue;
      }
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error("node recovery file entry checksum is invalid");
      }
      plaintextBytes += entry.size;
      if (plaintextBytes > maximumBytes) throw new Error("node recovery component exceeds its size limit");
      files += 1;
      const hash = createHash("sha256");
      let remaining = entry.size;
      let outputDescriptor: number | null = null;
      if (target) {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        outputDescriptor = openSync(target, "wx", entry.mode || 0o600);
      }
      try {
        const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, remaining)));
        while (remaining > 0) {
          const expected = Math.min(chunk.length, remaining);
          if (readExact(descriptor, chunk, 0, expected) === "eof") {
            throw new Error("node recovery file entry is truncated");
          }
          hash.update(chunk.subarray(0, expected));
          if (outputDescriptor !== null) writeAll(outputDescriptor, chunk, expected);
          remaining -= expected;
        }
      } finally {
        if (outputDescriptor !== null) closeSync(outputDescriptor);
      }
      if (hash.digest("hex") !== entry.sha256) {
        throw new Error(`node recovery file checksum mismatch: ${entry.path}`);
      }
      if (target) chmodSync(target, entry.mode || 0o600);
    }
    return { entries, files, plaintextBytes, warnings };
  } finally {
    closeSync(descriptor);
  }
}

async function decryptAndInflate(
  encryptedPath: string,
  archivePath: string,
  key: Buffer,
  iv: string,
  tag: string,
  maximumBytes: number,
): Promise<void> {
  if (key.length !== 32) throw new Error("node recovery component key must contain 32 bytes");
  const ivBytes = Buffer.from(iv, "base64");
  const tagBytes = Buffer.from(tag, "base64");
  if (ivBytes.length !== 12 || tagBytes.length !== 16) {
    throw new Error("node recovery component encryption envelope is invalid");
  }
  const decipher = createDecipheriv(CIPHER, key, ivBytes);
  decipher.setAuthTag(tagBytes);
  let inflatedBytes = 0;
  const archiveLimit = Math.min(
    Number.MAX_SAFE_INTEGER,
    maximumBytes + Math.max(64 * 1024 * 1024, Math.ceil(maximumBytes / 20)),
  );
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      inflatedBytes += chunk.length;
      callback(
        inflatedBytes > archiveLimit
          ? new Error("node recovery component archive exceeds its size limit")
          : null,
        chunk,
      );
    },
  });
  await pipeline(
    createReadStream(encryptedPath),
    decipher,
    createGunzip(),
    limiter,
    createWriteStream(archivePath, { mode: 0o600 }),
  );
}

export async function inspectEncryptedNodeRecoveryComponent(
  encryptedPath: string,
  key: Buffer,
  iv: string,
  tag: string,
  maximumBytes: number,
): Promise<InspectedNodeRecoveryComponent> {
  const archivePath = `${encryptedPath}.clear-${process.pid}`;
  try {
    await decryptAndInflate(encryptedPath, archivePath, key, iv, tag, maximumBytes);
    return parseArchive(archivePath, maximumBytes);
  } finally {
    rmSync(archivePath, { force: true });
  }
}

export async function extractEncryptedNodeRecoveryComponent(
  encryptedPath: string,
  outputRoot: string,
  key: Buffer,
  iv: string,
  tag: string,
  maximumBytes: number,
): Promise<InspectedNodeRecoveryComponent> {
  const archivePath = `${encryptedPath}.clear-${process.pid}`;
  if (existsSync(outputRoot)) {
    throw new Error("node recovery extraction target already exists");
  }
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  try {
    await decryptAndInflate(encryptedPath, archivePath, key, iv, tag, maximumBytes);
    return parseArchive(archivePath, maximumBytes, outputRoot);
  } catch (error) {
    rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(archivePath, { force: true });
  }
}
