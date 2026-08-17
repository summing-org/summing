import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import type { KnowledgeSyncConfig } from "./config.js";
import type { KnowledgeSyncStore } from "./knowledge-sync-store.js";

export interface StoredObject {
  key: string;
  backend: "local" | "s3";
  size: number;
}

export interface ObjectStore {
  readonly backend: "local" | "s3";
  putFile(key: string, filePath: string, metadata: Record<string, string>): Promise<StoredObject>;
  getFile(key: string, destinationPath: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

function objectPath(root: string, key: string): string {
  const normalized = key.replace(/^\/+/, "");
  const path = resolve(root, normalized);
  if (path !== root && !path.startsWith(`${resolve(root)}/`)) {
    throw new Error("object key escapes the configured local root");
  }
  return path;
}

export class LocalObjectStore implements ObjectStore {
  readonly backend = "local" as const;

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  async putFile(
    key: string,
    filePath: string,
    _metadata: Record<string, string>,
  ): Promise<StoredObject> {
    const destination = objectPath(this.root, key);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (!await this.exists(key)) {
      const temporary = `${destination}.upload-${process.pid}-${Date.now()}`;
      await pipeline(createReadStream(filePath), createWriteStream(temporary, { mode: 0o600 }));
      try {
        renameSync(temporary, destination);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* another writer won */ }
        if (!await this.exists(key)) throw error;
      }
    }
    return { key, backend: this.backend, size: statSync(filePath).size };
  }

  async getFile(key: string, destinationPath: string): Promise<void> {
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await pipeline(createReadStream(objectPath(this.root, key)), createWriteStream(destinationPath, { mode: 0o600 }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      return statSync(objectPath(this.root, key)).isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try { unlinkSync(objectPath(this.root, key)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class S3ObjectStore implements ObjectStore {
  readonly backend = "s3" as const;
  private readonly client: S3Client;

  constructor(readonly config: KnowledgeSyncConfig) {
    if (!config.s3Bucket) throw new Error("SUMMING_S3_BUCKET is required for the S3 object store");
    this.client = new S3Client({
      region: config.s3Region,
      ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
      forcePathStyle: config.s3ForcePathStyle,
      ...(config.s3AccessKeyId && config.s3SecretAccessKey
        ? {
            credentials: {
              accessKeyId: config.s3AccessKeyId,
              secretAccessKey: config.s3SecretAccessKey,
            },
          }
        : {}),
    });
  }

  async putFile(
    key: string,
    filePath: string,
    metadata: Record<string, string>,
  ): Promise<StoredObject> {
    const size = statSync(filePath).size;
    if (!await this.exists(key)) {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.s3Bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        Metadata: metadata,
        ServerSideEncryption: this.config.s3Sse as ServerSideEncryption,
        ...(this.config.s3Sse === "aws:kms" && this.config.s3KmsKeyId
          ? { SSEKMSKeyId: this.config.s3KmsKeyId }
          : {}),
      }));
    }
    return { key, backend: this.backend, size };
  }

  async getFile(key: string, destinationPath: string): Promise<void> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.config.s3Bucket,
      Key: key,
    }));
    if (!response.Body) throw new Error(`S3 object ${key} has no body`);
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(destinationPath, { mode: 0o600 }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.config.s3Bucket, Key: key }));
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.s3Bucket, Key: key }));
  }
}

export function createObjectStore(config: KnowledgeSyncConfig): ObjectStore {
  return config.objectStoreBackend === "s3"
    ? new S3ObjectStore(config)
    : new LocalObjectStore(config.localObjectRoot);
}

export async function sha256File(filePath: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), size };
}

export class ContentAddressedObjects {
  constructor(
    readonly store: ObjectStore,
    readonly metadata: KnowledgeSyncStore,
    readonly prefix = "summing",
  ) {}

  async ingest(input: {
    sourceId: string;
    refType: string;
    refId: string;
    filePath: string;
    fileName: string;
    mimeType: string;
    telegramUserId?: number;
  }): Promise<{ sha256: string; objectKey: string; size: number }> {
    const { sha256, size } = await sha256File(input.filePath);
    const objectKey = [this.prefix, "sha256", sha256.slice(0, 2), sha256]
      .filter(Boolean)
      .join("/");
    if (!this.metadata.contentObject(sha256)) {
      await this.store.putFile(objectKey, input.filePath, {
        sha256,
        "original-name": encodeURIComponent(input.fileName).slice(0, 1_024),
        "mime-type": input.mimeType.slice(0, 255),
      });
    }
    this.metadata.recordContentObject({
      sha256,
      objectKey,
      size,
      mimeType: input.mimeType,
      fileName: input.fileName,
      backend: this.store.backend,
      sourceId: input.sourceId,
      refType: input.refType,
      refId: input.refId,
      ...(input.telegramUserId ? { telegramUserId: input.telegramUserId } : {}),
    });
    return { sha256, objectKey, size };
  }
}
