import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENVIRONMENT_BYTES = 1_000_000;
const RESERVED_VARIABLES = new Set([
  "CONFIG_PATH",
  "DOCKER_HOST",
  "DRY_RUN",
  "DRY_RUN_ARTIFACT_DIR",
  "HISTORY_PATH",
  "HOME",
  "HOSTNAME",
  "NODE_OPTIONS",
  "PATH",
  "PUBLISH_IMMEDIATELY",
]);
const CREDENTIAL_VARIABLE = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|AUTH|CREDENTIALS?|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i;

interface EnvironmentEnvelope {
  version: 1;
  revision: number;
  updatedAt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface ProjectEnvironmentDocument {
  text: string;
  revision: number;
  updatedAt: string | null;
}

export interface ParsedEnvironment {
  normalized: string;
  values: ReadonlyMap<string, string>;
}

export class ProjectEnvironmentError extends Error {}

export class ProjectEnvironmentConflictError extends ProjectEnvironmentError {}

export function isProjectEnvironmentVariable(name: string): boolean {
  return VARIABLE.test(name) &&
    !RESERVED_VARIABLES.has(name) &&
    !name.startsWith("SUMMING_") &&
    !name.startsWith("LD_");
}

function identifier(value: string, field: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new ProjectEnvironmentError(`${field} is invalid`);
  }
  return value;
}

function decodeValue(value: string, lineNumber: number): string {
  if (value.startsWith("\"") || value.startsWith("'")) {
    const quote = value[0]!;
    if (value.length < 2 || !value.endsWith(quote)) {
      throw new ProjectEnvironmentError(`environment line ${lineNumber} has an unclosed quote`);
    }
    const body = value.slice(1, -1);
    if (quote === "'") return body;
    return body.replace(/\\([nrt\\"])/g, (_match, character: string) => {
      if (character === "n") return "\n";
      if (character === "r") return "\r";
      if (character === "t") return "\t";
      return character;
    });
  }
  return value;
}

export function parseProjectEnvironment(input: string): ParsedEnvironment {
  if (input.includes("\0")) throw new ProjectEnvironmentError("environment contains a NUL byte");
  const unix = input.replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(unix) > MAX_ENVIRONMENT_BYTES) {
    throw new ProjectEnvironmentError("environment exceeds 1 MB");
  }
  const values = new Map<string, string>();
  const lines = unix.split("\n");
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const separator = assignment.indexOf("=");
    const name = separator < 0 ? "" : assignment.slice(0, separator).trim();
    if (separator < 0 || !VARIABLE.test(name)) {
      throw new ProjectEnvironmentError(`environment line ${index + 1} is not NAME=value`);
    }
    if (!isProjectEnvironmentVariable(name)) {
      throw new ProjectEnvironmentError(`environment variable '${name}' is reserved by the runner`);
    }
    if (values.has(name)) {
      throw new ProjectEnvironmentError(`environment variable '${name}' is duplicated`);
    }
    const value = decodeValue(assignment.slice(separator + 1), index + 1);
    if (/[\r\n\0]/.test(value)) {
      throw new ProjectEnvironmentError(`environment line ${index + 1} contains a multiline value`);
    }
    values.set(name, value);
  }
  const normalized = unix && !unix.endsWith("\n") ? `${unix}\n` : unix;
  return { normalized, values };
}

function bootstrapEnvironment(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) return true;
      const assignment = line.startsWith("export ") ? line.slice(7).trimStart() : line;
      const separator = assignment.indexOf("=");
      if (separator < 0) return true;
      const name = assignment.slice(0, separator).trim();
      return !(
        RESERVED_VARIABLES.has(name) ||
        name.startsWith("SUMMING_") ||
        name.startsWith("LD_")
      );
    })
    .join("\n");
}

export function environmentRedactions(values: ReadonlyMap<string, string>): string[] {
  return [...values.entries()]
    .filter(([name, value]) => value.length >= 4 && (CREDENTIAL_VARIABLE.test(name) || value.length >= 12))
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

export function runtimeEnvironmentText(values: ReadonlyMap<string, string>): string {
  if (values.size === 0) return "";
  return `${[...values.entries()].map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
}

export function readEnvironmentKey(path: string): Buffer {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > 256 ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new ProjectEnvironmentError("runner environment key must be one private regular file");
  }
  const encoded = readFileSync(path, "utf8").trim();
  const key = /^[0-9a-f]{64}$/i.test(encoded)
    ? Buffer.from(encoded, "hex")
    : Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new ProjectEnvironmentError("runner environment key must contain 32 bytes");
  return key;
}

export function readOrCreateEnvironmentKey(path: string): Buffer {
  if (existsSync(path)) return readEnvironmentKey(path);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new ProjectEnvironmentError("runner environment key directory must be private");
  }
  const key = randomBytes(32);
  try {
    try {
      writeFileSync(path, `${key.toString("hex")}\n`, { flag: "wx", mode: 0o400 });
      chmodSync(path, 0o400);
      return Buffer.from(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return readEnvironmentKey(path);
      throw error;
    }
  } finally {
    key.fill(0);
  }
}

export class ProjectEnvironmentStore {
  readonly root: string;

  constructor(root: string, private readonly key: Buffer) {
    if (key.length !== 32) throw new ProjectEnvironmentError("environment store key must contain 32 bytes");
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
  }

  get(projectId: string, workspaceId: string): ProjectEnvironmentDocument {
    const path = this.documentPath(projectId, workspaceId);
    if (!existsSync(path)) return { text: "", revision: 0, updatedAt: null };
    const envelope = this.readEnvelope(path);
    return {
      text: this.decrypt(envelope, this.aad(projectId, workspaceId, envelope)),
      revision: envelope.revision,
      updatedAt: envelope.updatedAt,
    };
  }

  ensure(
    projectId: string,
    workspaceId: string,
    bootstrapPath?: string,
  ): ProjectEnvironmentDocument {
    const current = this.get(projectId, workspaceId);
    if (current.revision !== 0 || !bootstrapPath || !existsSync(bootstrapPath)) return current;
    const metadata = lstatSync(bootstrapPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > MAX_ENVIRONMENT_BYTES ||
      (metadata.mode & 0o007) !== 0
    ) {
      throw new ProjectEnvironmentError("bootstrap environment must be a non-public regular file under 1 MB");
    }
    return this.save(
      projectId,
      workspaceId,
      bootstrapEnvironment(readFileSync(bootstrapPath, "utf8")),
      0,
    );
  }

  save(
    projectId: string,
    workspaceId: string,
    input: string,
    expectedRevision: number,
  ): ProjectEnvironmentDocument {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ProjectEnvironmentError("expected environment revision is invalid");
    }
    const current = this.get(projectId, workspaceId);
    if (current.revision !== expectedRevision) {
      throw new ProjectEnvironmentConflictError(
        `environment changed from revision ${expectedRevision} to ${current.revision}; reload before saving`,
      );
    }
    const parsed = parseProjectEnvironment(input);
    const revision = current.revision + 1;
    const updatedAt = new Date().toISOString();
    const envelope = this.encrypt(projectId, workspaceId, revision, updatedAt, parsed.normalized);
    const path = this.documentPath(projectId, workspaceId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return { text: parsed.normalized, revision, updatedAt };
  }

  writeJobSnapshot(
    projectId: string,
    workspaceId: string,
    jobId: string,
    destination: string,
    bootstrapPath?: string,
  ): number {
    const document = this.ensure(projectId, workspaceId, bootstrapPath);
    if (!document.text) return document.revision;
    const updatedAt = document.updatedAt ?? new Date(0).toISOString();
    const envelope = this.encrypt(
      projectId,
      `${workspaceId}:${jobId}`,
      document.revision,
      updatedAt,
      document.text,
    );
    writeFileSync(destination, `${JSON.stringify(envelope)}\n`, { flag: "wx", mode: 0o600 });
    return document.revision;
  }

  readJobSnapshot(
    projectId: string,
    workspaceId: string,
    jobId: string,
    path: string,
  ): ParsedEnvironment {
    const envelope = this.readEnvelope(path);
    return parseProjectEnvironment(
      this.decrypt(envelope, this.aad(projectId, `${workspaceId}:${jobId}`, envelope)),
    );
  }

  private documentPath(projectId: string, workspaceId: string): string {
    return resolve(
      this.root,
      `${identifier(projectId, "project id")}--${identifier(workspaceId, "workspace id")}.json`,
    );
  }

  private readEnvelope(path: string): EnvironmentEnvelope {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > 1_500_000 ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new ProjectEnvironmentError("encrypted environment is not a private regular file");
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new ProjectEnvironmentError("encrypted environment is malformed");
    }
    const envelope = value as Partial<EnvironmentEnvelope>;
    if (
      envelope.version !== 1 ||
      !Number.isSafeInteger(envelope.revision) ||
      Number(envelope.revision) <= 0 ||
      typeof envelope.updatedAt !== "string" ||
      typeof envelope.iv !== "string" ||
      typeof envelope.tag !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new ProjectEnvironmentError("encrypted environment envelope is invalid");
    }
    return envelope as EnvironmentEnvelope;
  }

  private aad(projectId: string, workspaceId: string, envelope: Pick<EnvironmentEnvelope, "revision" | "updatedAt">): Buffer {
    return Buffer.from(
      `summing-env:v1:${projectId}:${workspaceId}:${envelope.revision}:${envelope.updatedAt}`,
      "utf8",
    );
  }

  private encrypt(
    projectId: string,
    workspaceId: string,
    revision: number,
    updatedAt: string,
    plaintext: string,
  ): EnvironmentEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const envelope = { revision, updatedAt };
    cipher.setAAD(this.aad(projectId, workspaceId, envelope));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      version: 1,
      revision,
      updatedAt,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  private decrypt(envelope: EnvironmentEnvelope, aad: Buffer): string {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new ProjectEnvironmentError("encrypted environment authentication failed");
    }
  }
}
