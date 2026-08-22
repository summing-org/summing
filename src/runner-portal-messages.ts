import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const IDENTIFIER = /^[A-Za-z0-9._-]{1,120}$/;
const MAXIMUM_REQUEST_BYTES = 64_000;
const MAXIMUM_ARTIFACT_BYTES = 8_000_000;
const MAXIMUM_MESSAGES = 20;

export interface RunnerPortalMessage {
  id: string;
  type: "text" | "document";
  text: string;
  artifact: string | null;
}

export interface RunnerPortalMessageBatch {
  projectId: string;
  workspaceId: string;
  jobId: string;
  messages: RunnerPortalMessage[];
  createdAt: string;
}

export class RunnerPortalMessageError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, path);
    const directoryDescriptor = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function jsonObject(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new RunnerPortalMessageError(409, "portal-messages.json is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RunnerPortalMessageError(409, "portal-messages.json must contain an object");
  }
  return parsed as Record<string, unknown>;
}

export class RunnerPortalMessageStore {
  private readonly root: string;

  constructor(dataRoot: string, readonly now: () => Date = () => new Date()) {
    this.root = resolve(dataRoot, "portal-message-batches");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  capture(input: {
    projectId: string;
    workspaceId: string;
    jobId: string;
    artifactDirectory: string;
    allowedArtifacts: ReadonlySet<string>;
  }): RunnerPortalMessageBatch | null {
    const requestPath = resolve(input.artifactDirectory, "portal-messages.json");
    if (!existsSync(requestPath)) return null;
    const metadata = lstatSync(requestPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0 ||
      metadata.size > MAXIMUM_REQUEST_BYTES
    ) {
      throw new RunnerPortalMessageError(409, "portal-messages.json is not a bounded regular file");
    }
    const existing = this.byJob(input.projectId, input.workspaceId, input.jobId);
    if (existing) return existing;
    const raw = jsonObject(requestPath);
    if (
      raw.schemaVersion !== 1 ||
      Object.keys(raw).some((key) => !["schemaVersion", "messages"].includes(key)) ||
      !Array.isArray(raw.messages) ||
      raw.messages.length < 1 ||
      raw.messages.length > MAXIMUM_MESSAGES
    ) {
      throw new RunnerPortalMessageError(409, "portal message batch schema is invalid");
    }
    const identifiers = new Set<string>();
    const messages = raw.messages.map((value): RunnerPortalMessage => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new RunnerPortalMessageError(409, "portal message must be an object");
      }
      const item = value as Record<string, unknown>;
      if (Object.keys(item).some((key) => !["id", "type", "text", "artifact"].includes(key))) {
        throw new RunnerPortalMessageError(409, "portal message contains unsupported fields");
      }
      const id = String(item.id ?? "");
      const type = String(item.type ?? "");
      const text = String(item.text ?? "").trim();
      const artifact = item.artifact === undefined || item.artifact === null
        ? null
        : String(item.artifact);
      if (!IDENTIFIER.test(id) || identifiers.has(id)) {
        throw new RunnerPortalMessageError(409, "portal message id is invalid or duplicated");
      }
      identifiers.add(id);
      if (!new Set(["text", "document"]).has(type)) {
        throw new RunnerPortalMessageError(409, "portal message type is invalid");
      }
      const maximumText = type === "document" ? 900 : 3_500;
      if ((!text && type === "text") || Array.from(text).length > maximumText) {
        throw new RunnerPortalMessageError(409, "portal message text is outside Telegram limits");
      }
      if (type === "text" && artifact !== null) {
        throw new RunnerPortalMessageError(409, "text portal message cannot contain an artifact");
      }
      if (type === "document") {
        if (!artifact || !IDENTIFIER.test(artifact) || !input.allowedArtifacts.has(artifact)) {
          throw new RunnerPortalMessageError(409, "portal document artifact is not allowed");
        }
        const artifactPath = resolve(input.artifactDirectory, artifact);
        if (!existsSync(artifactPath)) {
          throw new RunnerPortalMessageError(409, "portal document artifact is missing");
        }
        const artifactMetadata = lstatSync(artifactPath);
        if (
          artifactMetadata.isSymbolicLink() ||
          !artifactMetadata.isFile() ||
          artifactMetadata.size <= 0 ||
          artifactMetadata.size > MAXIMUM_ARTIFACT_BYTES
        ) {
          throw new RunnerPortalMessageError(409, "portal document artifact is unsafe");
        }
      }
      return { id, type: type as RunnerPortalMessage["type"], text, artifact };
    });
    const batch: RunnerPortalMessageBatch = {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      messages,
      createdAt: this.now().toISOString(),
    };
    atomicJson(this.path(input.projectId, input.workspaceId, input.jobId), batch);
    return batch;
  }

  byJob(projectId: string, workspaceId: string, jobId: string): RunnerPortalMessageBatch | null {
    const path = this.path(projectId, workspaceId, jobId);
    if (!existsSync(path)) return null;
    return jsonObject(path) as unknown as RunnerPortalMessageBatch;
  }

  private path(projectId: string, workspaceId: string, jobId: string): string {
    for (const [name, value] of Object.entries({ projectId, workspaceId, jobId })) {
      if (!IDENTIFIER.test(value)) throw new RunnerPortalMessageError(400, `${name} is invalid`);
    }
    return resolve(this.root, `${projectId}--${workspaceId}--${jobId}.json`);
  }
}
