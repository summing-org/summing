import { spawn } from "node:child_process";
import {
  createDecipheriv,
  createCipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { RuntimeConfig } from "./config.js";
import { GitInspector, type RepositorySummary } from "./git-inspector.js";
import {
  createEncryptedNodeRecoveryComponent,
  extractEncryptedNodeRecoveryComponent,
  inspectEncryptedNodeRecoveryComponent,
  type NodeRecoveryArchiveSource,
} from "./node-recovery-archive.js";
import type { ObjectStore } from "./object-store.js";
import { sha256File } from "./object-store.js";
import type { ProjectCatalog } from "./project-catalog.js";
import type { Conversation, StateStore } from "./state-store.js";
import { SUMMING_VERSION } from "./version.js";

const FORMAT = "summing-node-recovery";
const FORMAT_VERSION = 1;
const CIPHER = "aes-256-gcm";
const MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAXIMUM_GIT_METADATA_BYTES = 64 * 1024 * 1024;
const GENERATED_WORKSPACE_SEGMENTS = ["node_modules", "dist", ".cache", ".next", ".turbo"];
const CONNECTOR_CORE_TABLES_TO_CLEAR = [
  "team_source_connectors",
  "team_consents",
  "team_sync_runs",
  "team_sync_checkpoints",
  "team_sync_stages",
  "team_sync_unknown_authors",
  "team_event_revisions",
  "team_ingestion_jobs",
  "team_sync_outbox",
  "content_object_refs",
  "content_objects",
  "document_blocks",
  "search_chunk_blocks",
  "search_chunks",
  "chunk_embeddings",
  "semantic_embeddings",
  "team_knowledge_evidence_refs",
  "knowledge_transfers",
  "imported_knowledge_sources",
] as const;

export type NodeRecoverySessionState = "resumable" | "archive_only" | "broken_dependency";

export interface NodeRecoveryTeamSpaceReference {
  spaceId: string;
  title: string;
  bundleKey: string;
  mode: string;
  createdAt: number;
}

export interface NodeRecoveryProjectEnvironment {
  projectId: string;
  workspaceId: string;
  text: string;
  revision: number;
  updatedAt: string | null;
}

export interface NodeRecoverySecretSources {
  configPath: string;
  environmentPath: string;
}

export interface NodeRecoveryWorkspaceRecord {
  id: string;
  projectId: string;
  workspaceId: string;
  originalPath: string;
  kind: "project" | "conversation-worktree" | "discovered";
  conversationIds: string[];
  git: RepositorySummary | null;
  componentId: string;
  state: "captured" | "missing" | "not-git" | "failed";
  warnings: string[];
}

export interface NodeRecoverySessionRecord {
  threadId: string;
  relativePath: string;
  conversationIds: string[];
  workspaceId: string;
  state: NodeRecoverySessionState;
  reason: string;
}

export interface NodeRecoveryComponentManifest {
  id: string;
  kind: "node-state" | "codex-sessions" | "run-artifacts" | "attachments" | "workspace" | "config" | "secrets";
  key: string;
  sha256: string;
  size: number;
  iv: string;
  tag: string;
  entries: number;
  files: number;
  plaintextBytes: number;
  required: boolean;
  warnings: string[];
}

export interface NodeRecoveryManifest {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  backupId: string;
  nodeId: string;
  nodeLabel: string;
  createdAt: string;
  summingVersion: string;
  includeSecrets: boolean;
  components: NodeRecoveryComponentManifest[];
  inventory: {
    conversations: number;
    runs: number;
    projects: number;
    workspaces: NodeRecoveryWorkspaceRecord[];
    sessions: NodeRecoverySessionRecord[];
    teamSpaces: NodeRecoveryTeamSpaceReference[];
  };
  restore: {
    reconnectRequired: string[];
    excluded: string[];
    mappings: Array<{ componentId: string; archivePath: string; destination: string }>;
  };
  warnings: string[];
  hmac: string;
}

export interface NodeRecoveryExportResult {
  backupId: string;
  bundleKey: string;
  recoveryKey: string;
  componentCount: number;
  encryptedBytes: number;
  includeSecrets: boolean;
  warnings: string[];
}

export interface NodeRecoveryInspection {
  backupId: string;
  bundleKey: string;
  nodeId: string;
  createdAt: string;
  summingVersion: string;
  includeSecrets: boolean;
  components: Array<NodeRecoveryComponentManifest & { verified: true }>;
  inventory: NodeRecoveryManifest["inventory"];
  restore: NodeRecoveryManifest["restore"];
  warnings: string[];
  ready: boolean;
}

interface WorkspaceCandidate {
  id: string;
  projectId: string;
  workspaceId: string;
  path: string;
  kind: NodeRecoveryWorkspaceRecord["kind"];
  conversationIds: string[];
}

interface CapturedWorkspace {
  record: NodeRecoveryWorkspaceRecord;
  sources: NodeRecoveryArchiveSource[];
  temporaryRoot: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function manifestBody(manifest: NodeRecoveryManifest): Omit<NodeRecoveryManifest, "hmac"> {
  const { hmac: _hmac, ...body } = manifest;
  return body;
}

function deriveKey(master: Buffer, backupId: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from(backupId), Buffer.from(purpose), 32));
}

export function parseNodeRecoveryKey(value: string): Buffer {
  const normalized = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64url");
  if (key.length !== 32) throw new Error("node recovery key must contain exactly 32 bytes");
  return key;
}

function localWrappingKey(path: string): Buffer {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256) {
    throw new Error("node recovery wrapping key must be a small regular file");
  }
  const raw = readFileSync(path);
  const text = raw.toString("utf8").trim();
  const key = /^[a-f0-9]{64}$/i.test(text) ? Buffer.from(text, "hex") : raw;
  if (key.length !== 32) throw new Error("node recovery wrapping key must contain exactly 32 bytes");
  return key;
}

export function wrapNodeRecoveryKey(path: string, jobId: string, recoveryKey: Buffer): string {
  if (recoveryKey.length !== 32) throw new Error("node recovery key must contain exactly 32 bytes");
  const local = localWrappingKey(path);
  const key = deriveKey(local, jobId, "summing-node-recovery-key-wrap-v1");
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  try {
    const ciphertext = Buffer.concat([cipher.update(recoveryKey), cipher.final()]);
    return JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  } finally {
    local.fill(0);
    key.fill(0);
  }
}

export function unwrapNodeRecoveryKey(path: string, jobId: string, wrapped: string): Buffer {
  let envelope: { version?: unknown; iv?: unknown; tag?: unknown; ciphertext?: unknown };
  try {
    envelope = JSON.parse(wrapped) as typeof envelope;
  } catch {
    throw new Error("node recovery key envelope is invalid");
  }
  if (envelope.version !== 1) throw new Error("node recovery key envelope is unsupported");
  const local = localWrappingKey(path);
  const key = deriveKey(local, jobId, "summing-node-recovery-key-wrap-v1");
  try {
    const iv = Buffer.from(String(envelope.iv ?? ""), "base64");
    const tag = Buffer.from(String(envelope.tag ?? ""), "base64");
    const ciphertext = Buffer.from(String(envelope.ciphertext ?? ""), "base64");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length !== 32) {
      throw new Error("node recovery key envelope is invalid");
    }
    const decipher = createDecipheriv(CIPHER, key, iv);
    decipher.setAuthTag(tag);
    const clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (clear.length !== 32) throw new Error("node recovery key envelope is invalid");
    return clear;
  } finally {
    local.fill(0);
    key.fill(0);
  }
}

function safeObjectKey(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error("node recovery object key is invalid");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("node recovery object key is invalid");
  }
  return parts.join("/");
}

function recoveryRoot(prefix: string, nodeId: string, backupId: string): string {
  return [prefix.replace(/^\/+|\/+$/g, ""), "node-recovery", nodeId, backupId]
    .filter(Boolean)
    .join("/");
}

function sanitizedNodeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128) || "summing-node";
}

function isWithin(root: string, target: string): boolean {
  const canonicalRoot = resolve(root);
  const canonicalTarget = resolve(target);
  return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(`${canonicalRoot}${sep}`);
}

function regularFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function recoveryWorkDirectory(root: string, prefix: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, prefix));
}

function countRows(path: string, table: string): number {
  if (!regularFile(path)) return 0;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: unknown };
    return Number(row.count ?? 0);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function discoverSessionFiles(codexHome: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (path: string): void => {
    let metadata;
    try { metadata = lstatSync(path); } catch { return; }
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      for (const child of readdirSync(path)) visit(join(path, child));
      return;
    }
    if (!metadata.isFile() || !path.endsWith(".jsonl")) return;
    const threadId = basename(path, ".jsonl");
    if (/^[0-9a-f-]{16,64}$/i.test(threadId)) found.set(threadId, path);
  };
  visit(join(codexHome, "sessions"));
  visit(join(codexHome, "archived_sessions"));
  return found;
}

function command(
  executable: string,
  args: string[],
  cwd: string,
  outputPath?: string,
  maximumBytes = MAXIMUM_GIT_METADATA_BYTES,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolveCommand, reject) => {
    const output = outputPath ? createWriteStream(outputPath, { mode: 0o600 }) : null;
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let failedForSize = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        failedForSize = true;
        child.kill("SIGKILL");
        return;
      }
      if (output) output.write(chunk);
      else chunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      output?.destroy();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const finish = (): void => {
        if (failedForSize) reject(new Error(`Git recovery output exceeds ${maximumBytes} bytes`));
        else if (code !== 0) reject(new Error(stderr.trim() || `command failed: ${executable}`));
        else resolveCommand({ stdout: Buffer.concat(chunks), stderr });
      };
      if (output) output.end(finish);
      else finish();
    });
  });
}

function nulPaths(value: Buffer): string[] {
  return value.toString("utf8").split("\0").filter(Boolean).map((path) => {
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "..")) {
      throw new Error("Git returned an unsafe untracked path");
    }
    return path;
  });
}

function generatedWorkspacePath(path: string): boolean {
  return path.split("/").some((segment) =>
    segment === ".git" || GENERATED_WORKSPACE_SEGMENTS.includes(segment)
  );
}

async function captureWorkspace(
  candidate: WorkspaceCandidate,
  work: string,
  includeSecrets: boolean,
  maximumBytes: number,
): Promise<CapturedWorkspace> {
  const temporaryRoot = join(work, `workspace-${candidate.id}`);
  mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
  const metadataPath = join(temporaryRoot, "metadata.json");
  const record: NodeRecoveryWorkspaceRecord = {
    id: candidate.id,
    projectId: candidate.projectId,
    workspaceId: candidate.workspaceId,
    originalPath: candidate.path,
    kind: candidate.kind,
    conversationIds: candidate.conversationIds,
    git: null,
    componentId: `workspace-${candidate.id}`,
    state: "missing",
    warnings: [],
  };
  if (!existsSync(candidate.path)) {
    record.warnings.push("workspace path is missing");
    writeJson(metadataPath, record);
    return {
      record,
      temporaryRoot,
      sources: [{ sourcePath: temporaryRoot, archivePath: "payload" }],
    };
  }
  try {
    record.git = await new GitInspector(candidate.path).summary();
  } catch (error) {
    record.state = "not-git";
    record.warnings.push(`workspace is not a readable Git repository: ${String(error)}`.slice(0, 500));
    writeJson(metadataPath, record);
    return {
      record,
      temporaryRoot,
      sources: [
        { sourcePath: temporaryRoot, archivePath: "payload/meta" },
        {
          sourcePath: candidate.path,
          archivePath: "payload/tree",
          excludeSegments: [".git", ...GENERATED_WORKSPACE_SEGMENTS],
          excludeSecretFiles: !includeSecrets,
        },
      ],
    };
  }

  try {
    const bundlePath = join(temporaryRoot, "repository.bundle");
    await command(
      "git",
      ["-C", candidate.path, "bundle", "create", bundlePath, "--all"],
      candidate.path,
      bundlePath,
      maximumBytes,
    );
    await command(
      "git",
      ["-C", candidate.path, "diff", "--binary", "--full-index", "--cached", "HEAD"],
      candidate.path,
      join(temporaryRoot, "staged.patch"),
      maximumBytes,
    );
    await command(
      "git",
      ["-C", candidate.path, "diff", "--binary", "--full-index"],
      candidate.path,
      join(temporaryRoot, "working.patch"),
      maximumBytes,
    );
    const regularUntracked = nulPaths((await command(
      "git",
      ["-C", candidate.path, "ls-files", "--others", "--exclude-standard", "-z"],
      candidate.path,
    )).stdout);
    const ignored = includeSecrets
      ? nulPaths((await command(
          "git",
          ["-C", candidate.path, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
          candidate.path,
        )).stdout)
      : [];
    const untracked = [...new Set([...regularUntracked, ...ignored])]
      .filter((path) => !generatedWorkspacePath(path))
      .sort();
    record.state = "captured";
    const sources: NodeRecoveryArchiveSource[] = [
      { sourcePath: temporaryRoot, archivePath: "payload/meta" },
      ...untracked.map((path) => ({
        sourcePath: join(candidate.path, ...path.split("/")),
        archivePath: `payload/untracked/${path}`,
        excludeSecretFiles: !includeSecrets,
      })),
    ];
    writeJson(metadataPath, { ...record, untracked });
    return { record, temporaryRoot, sources };
  } catch (error) {
    record.state = "failed";
    record.warnings.push(`Git recovery capture failed: ${String(error)}`.slice(0, 500));
    rmSync(temporaryRoot, { recursive: true, force: true });
    mkdirSync(temporaryRoot, { recursive: true, mode: 0o700 });
    writeJson(metadataPath, record);
    return {
      record,
      temporaryRoot,
      sources: [{ sourcePath: temporaryRoot, archivePath: "payload" }],
    };
  }
}

function workspaceCandidates(
  config: RuntimeConfig,
  projects: ProjectCatalog,
  conversations: Conversation[],
): WorkspaceCandidate[] {
  const candidates = new Map<string, WorkspaceCandidate>();
  for (const access of projects.all()) {
    for (const workspace of access.project.workspaces.values()) {
      const path = resolve(workspace.path);
      candidates.set(path, {
        id: createHmac("sha256", "summing-node-recovery-workspace-v1")
          .update(path).digest("hex").slice(0, 16),
        projectId: access.project.id,
        workspaceId: workspace.id,
        path,
        kind: "project",
        conversationIds: [],
      });
    }
  }
  for (const conversation of conversations) {
    if (!conversation.worktreePath) continue;
    const path = resolve(conversation.worktreePath);
    const existing = candidates.get(path);
    if (existing) {
      existing.conversationIds.push(conversation.id);
      continue;
    }
    if (!isWithin(config.worktreeRoot, path)) continue;
    candidates.set(path, {
      id: createHmac("sha256", "summing-node-recovery-worktree-v1")
        .update(path).digest("hex").slice(0, 16),
      projectId: conversation.projectId,
      workspaceId: conversation.workspaceId,
      path,
      kind: "conversation-worktree",
      conversationIds: [conversation.id],
    });
  }

  const addDiscovered = (path: string): void => {
    const resolved = resolve(path);
    if (candidates.has(resolved)) return;
    candidates.set(resolved, {
      id: createHmac("sha256", "summing-node-recovery-discovered-workspace-v1")
        .update(resolved).digest("hex").slice(0, 16),
      projectId: "",
      workspaceId: basename(resolved),
      path: resolved,
      kind: "discovered",
      conversationIds: [],
    });
  };
  const discoverGitDirectories = (root: string, maximumDepth: number): void => {
    const walk = (directory: string, depth: number): void => {
      if (!existsSync(directory)) return;
      let stat;
      try {
        stat = lstatSync(directory);
      } catch {
        return;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      if (existsSync(join(directory, ".git"))) {
        addDiscovered(directory);
        return;
      }
      if (depth >= maximumDepth) return;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (entry.name.startsWith(".")) continue;
        walk(join(directory, entry.name), depth + 1);
      }
    };
    walk(resolve(root), 0);
  };
  discoverGitDirectories(projects.repositoriesRoot, 2);
  discoverGitDirectories(config.worktreeRoot, 2);
  return [...candidates.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function sessionInventory(
  config: RuntimeConfig,
  conversations: Conversation[],
  workspaces: NodeRecoveryWorkspaceRecord[],
): NodeRecoverySessionRecord[] {
  const files = discoverSessionFiles(config.codexHome);
  const bindings = new Map<string, Conversation[]>();
  for (const conversation of conversations) {
    for (const threadId of [
      conversation.codexThreadId,
      conversation.previousCodexThreadId,
      conversation.readOnlyCodexThreadId,
    ]) {
      if (!threadId) continue;
      const values = bindings.get(threadId) ?? [];
      values.push(conversation);
      bindings.set(threadId, values);
    }
  }
  const threadIds = new Set([...files.keys(), ...bindings.keys()]);
  return [...threadIds].sort().map((threadId) => {
    const linked = bindings.get(threadId) ?? [];
    const sessionPath = files.get(threadId) ?? "";
    const workspace = linked.map((conversation) => {
      if (conversation.worktreePath) {
        return workspaces.find((item) => item.originalPath === resolve(conversation.worktreePath!));
      }
      return workspaces.find((item) =>
        item.projectId === conversation.projectId &&
        item.workspaceId === conversation.workspaceId &&
        item.kind === "project"
      );
    }).find(Boolean);
    let state: NodeRecoverySessionState;
    let reason: string;
    if (!sessionPath) {
      state = "broken_dependency";
      reason = "conversation references a Codex thread whose session file is missing";
    } else if (linked.length === 0) {
      state = "archive_only";
      reason = "session is preserved but has no active SUMMING conversation binding";
    } else if (!workspace || workspace.state !== "captured") {
      state = "broken_dependency";
      reason = "session exists but its Git workspace was not captured completely";
    } else {
      state = "resumable";
      reason = "session, conversation binding and Git workspace are present";
    }
    return {
      threadId,
      relativePath: sessionPath ? relative(config.codexHome, sessionPath) : "",
      conversationIds: linked.map((item) => item.id),
      workspaceId: workspace?.id ?? "",
      state,
      reason,
    };
  });
}

async function copyDatabase(sourcePath: string, destinationPath: string): Promise<boolean> {
  if (!regularFile(sourcePath)) return false;
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, destinationPath);
    return true;
  } finally {
    source.close();
  }
}

function scrubTeamState(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'team\\_%' ESCAPE '\\'
    `).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
    }
    db.exec("VACUUM");
  } finally {
    db.close();
  }
}

function scrubConnectorCore(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    for (const table of CONNECTOR_CORE_TABLES_TO_CLEAR) {
      db.exec(`DELETE FROM ${table}`);
    }
    db.exec("VACUUM");
  } finally {
    db.close();
  }
}

function validateManifest(value: unknown, recoveryKey: Buffer): NodeRecoveryManifest {
  const manifest = value as NodeRecoveryManifest;
  if (!manifest || manifest.format !== FORMAT || manifest.version !== FORMAT_VERSION) {
    throw new Error("unsupported node recovery manifest");
  }
  if (!/^[0-9a-f-]{36}$/.test(manifest.backupId) || !/^[0-9a-f-]{36}$/.test(manifest.nodeId)) {
    throw new Error("node recovery manifest identity is invalid");
  }
  if (!Array.isArray(manifest.components) || !manifest.inventory || !manifest.restore) {
    throw new Error("node recovery manifest is incomplete");
  }
  const hmacKey = deriveKey(recoveryKey, manifest.backupId, "summing-node-recovery-manifest-v1");
  try {
    const expected = createHmac("sha256", hmacKey).update(stableJson(manifestBody(manifest))).digest();
    const actual = Buffer.from(String(manifest.hmac ?? ""), "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("node recovery manifest signature is invalid");
    }
  } finally {
    hmacKey.fill(0);
  }
  const ids = new Set<string>();
  for (const component of manifest.components) {
    if (!/^[a-z0-9-]{1,80}$/.test(component.id) || ids.has(component.id)) {
      throw new Error("node recovery component identity is invalid");
    }
    ids.add(component.id);
    safeObjectKey(component.key);
    if (!/^[a-f0-9]{64}$/.test(component.sha256) || !Number.isSafeInteger(component.size) || component.size < 0) {
      throw new Error("node recovery component checksum is invalid");
    }
    if (!Number.isSafeInteger(component.plaintextBytes) || component.plaintextBytes < 0) {
      throw new Error("node recovery component size is invalid");
    }
  }
  return manifest;
}

export class NodeRecoveryManager {
  readonly nodeId: string;

  constructor(
    readonly config: RuntimeConfig,
    readonly state: StateStore,
    readonly projects: ProjectCatalog,
    readonly objectStore: ObjectStore,
    readonly teamSpaceBundles: () => NodeRecoveryTeamSpaceReference[] = () => [],
    readonly projectEnvironment: (
      projectId: string,
      workspaceId: string,
    ) => Promise<Omit<NodeRecoveryProjectEnvironment, "projectId" | "workspaceId">> = async () => ({
      text: "",
      revision: 0,
      updatedAt: null,
    }),
    readonly secretSources: NodeRecoverySecretSources = {
      configPath: resolve(process.env.SUMMING_CONFIG || join(config.dataDir, "config.toml")),
      environmentPath: resolve(process.env.SUMMING_ENV_FILE || "/etc/summing/summing.env"),
    },
  ) {
    const idPath = join(config.dataDir, "node-id");
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    if (!existsSync(idPath)) writeFileSync(idPath, `${randomUUID()}\n`, { mode: 0o600, flag: "wx" });
    if (!regularFile(idPath)) throw new Error("SUMMING node id must be a regular file");
    const value = readFileSync(idPath, "utf8").trim();
    if (!/^[0-9a-f-]{36}$/.test(value)) throw new Error("SUMMING node id is invalid");
    this.nodeId = value;
  }

  private currentTeamSpaceBundles(): NodeRecoveryTeamSpaceReference[] {
    const references = this.teamSpaceBundles();
    for (const space of this.state.listTeamSpaces()) {
      const latest = references
        .filter((reference) => reference.spaceId === space.id)
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      if (!latest) {
        throw new Error(`Team Space '${space.name || space.id}' has no successful export bundle`);
      }
      if (latest.createdAt < space.updatedAt) {
        throw new Error(
          `Team Space '${space.name || space.id}' changed after its last export; pause sync and export it again`,
        );
      }
    }
    return references;
  }

  async export(input: { includeSecrets: boolean; recoveryKey?: Buffer }): Promise<NodeRecoveryExportResult> {
    const recoveryKey = input.recoveryKey ?? randomBytes(32);
    if (recoveryKey.length !== 32) throw new Error("node recovery key must contain exactly 32 bytes");
    const ownsKey = !input.recoveryKey;
    const backupId = randomUUID();
    const root = recoveryRoot(this.config.knowledgeSync.s3Prefix, this.nodeId, backupId);
    const work = recoveryWorkDirectory(
      this.config.knowledgeSync.spoolRoot || tmpdir(),
      "node-recovery-",
    );
    const components: NodeRecoveryComponentManifest[] = [];
    const warnings: string[] = [];
    const mappings: NodeRecoveryManifest["restore"]["mappings"] = [];
    let encryptedBytes = 0;
    const addComponent = async (
      id: string,
      kind: NodeRecoveryComponentManifest["kind"],
      sources: NodeRecoveryArchiveSource[],
      required: boolean,
    ): Promise<void> => {
      const encryptedPath = join(work, `${id}.gz.enc`);
      const key = deriveKey(recoveryKey, backupId, `summing-node-recovery-component:${id}`);
      try {
        const created = await createEncryptedNodeRecoveryComponent(sources, encryptedPath, key);
        encryptedBytes += created.size;
        if (encryptedBytes > this.config.knowledgeSync.spoolMaximumBytes) {
          throw new Error("node recovery bundle exceeds configured spool limit");
        }
        const objectKey = `${root}/components/${id}.gz.enc`;
        await this.objectStore.putFile(objectKey, encryptedPath, {
          format: FORMAT,
          "backup-id": backupId,
          component: id,
          sha256: created.sha256,
        });
        components.push({ id, kind, key: objectKey, required, ...created });
        warnings.push(...created.warnings);
      } finally {
        key.fill(0);
        rmSync(encryptedPath, { force: true });
      }
    };

    try {
      if (this.state.listConversations().some((conversation) => conversation.activeTurnId)) {
        throw new Error("node recovery export requires every active Codex turn to finish");
      }
      let teamSpaces = this.currentTeamSpaceBundles();
      mkdirSync(work, { recursive: true, mode: 0o700 });
      const conversations = this.state.listConversations();
      const candidates = workspaceCandidates(this.config, this.projects, conversations);
      const capturedWorkspaces: CapturedWorkspace[] = [];
      for (const candidate of candidates) {
        capturedWorkspaces.push(await captureWorkspace(
          candidate,
          work,
          input.includeSecrets,
          this.config.knowledgeSync.spoolMaximumBytes,
        ));
      }
      const workspaceRecords = capturedWorkspaces.map((item) => item.record);
      const sessions = sessionInventory(this.config, conversations, workspaceRecords);

      const stateRoot = join(work, "node-state");
      mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const stateBackup = join(stateRoot, "state.sqlite3");
      await this.state.backupTo(stateBackup);
      scrubTeamState(stateBackup);
      writeFileSync(join(stateRoot, "node-id"), `${this.nodeId}\n`, { mode: 0o600 });
      const runnerBackup = join(stateRoot, "runner-control.sqlite3");
      const runnerIncluded = await copyDatabase(
        join(this.config.dataDir, "runner-control.sqlite3"),
        runnerBackup,
      );
      const inventory = {
        capturedAt: new Date().toISOString(),
        nodeId: this.nodeId,
        conversations,
        projects: this.projects.all().map((entry) => ({
          id: entry.project.id,
          name: entry.project.name,
          defaultWorkspaceId: entry.project.defaultWorkspace,
          primaryOwnerId: entry.primaryOwnerId,
          ownerIds: entry.ownerIds,
          managed: entry.managed,
          workspaces: [...entry.project.workspaces.values()],
        })),
        workspaces: workspaceRecords,
        sessions,
      };
      writeJson(join(stateRoot, "inventory.json"), inventory);
      await addComponent("node-state", "node-state", [
        { sourcePath: stateRoot, archivePath: "payload/data" },
        { sourcePath: join(this.config.dataDir, "memory"), archivePath: "payload/data/memory", optional: true },
        { sourcePath: join(this.config.dataDir, "projects"), archivePath: "payload/data/projects", optional: true },
      ], true);
      mappings.push({ componentId: "node-state", archivePath: "payload/data", destination: this.config.dataDir });
      if (!runnerIncluded) warnings.push("runner-control.sqlite3 was not present");

      const configRoot = join(work, "config");
      mkdirSync(configRoot, { recursive: true, mode: 0o700 });
      writeJson(join(configRoot, "runtime-config.json"), {
        version: SUMMING_VERSION,
        dataDir: this.config.dataDir,
        codexHome: this.config.codexHome,
        worktreeRoot: this.config.worktreeRoot,
        telegramOwnerId: this.config.telegramOwnerId,
        viewerPublicUrl: this.config.viewerPublicUrl,
        knowledgeObjectStore: this.config.knowledgeSync.objectStoreBackend,
        s3Endpoint: this.config.knowledgeSync.s3Endpoint,
        s3Region: this.config.knowledgeSync.s3Region,
        s3Bucket: this.config.knowledgeSync.s3Bucket,
        s3Prefix: this.config.knowledgeSync.s3Prefix,
        projects: inventory.projects,
      });
      await addComponent("config", "config", [
        { sourcePath: configRoot, archivePath: "payload/config" },
      ], true);

      const codexSources: NodeRecoveryArchiveSource[] = [
        { sourcePath: join(this.config.codexHome, "sessions"), archivePath: "payload/data/codex/sessions", optional: true },
        { sourcePath: join(this.config.codexHome, "archived_sessions"), archivePath: "payload/data/codex/archived_sessions", optional: true },
        { sourcePath: join(this.config.codexHome, "session_index.jsonl"), archivePath: "payload/data/codex/session_index.jsonl", optional: true },
      ];
      await addComponent("codex-sessions", "codex-sessions", codexSources, false);
      mappings.push({ componentId: "codex-sessions", archivePath: "payload/data/codex", destination: this.config.codexHome });

      for (const [id, kind, path] of [
        ["run-artifacts", "run-artifacts", join(this.config.dataDir, "run-artifacts")],
        ["attachments", "attachments", join(this.config.dataDir, "attachments")],
      ] as const) {
        await addComponent(id, kind, [
          { sourcePath: path, archivePath: `payload/data/${id}`, optional: true },
        ], false);
        mappings.push({ componentId: id, archivePath: `payload/data/${id}`, destination: path });
      }

      for (const captured of capturedWorkspaces) {
        await addComponent(
          captured.record.componentId,
          "workspace",
          captured.sources,
          captured.record.state === "captured",
        );
        mappings.push({
          componentId: captured.record.componentId,
          archivePath: "payload",
          destination: captured.record.originalPath,
        });
      }

      if (input.includeSecrets) {
        const secretRoot = join(work, "secrets");
        mkdirSync(secretRoot, { recursive: true, mode: 0o700 });
        const projectEnvironments: NodeRecoveryProjectEnvironment[] = [];
        for (const project of this.projects.all()) {
          for (const workspace of project.project.workspaces.values()) {
            try {
              projectEnvironments.push({
                projectId: project.project.id,
                workspaceId: workspace.id,
                ...await this.projectEnvironment(project.project.id, workspace.id),
              });
            } catch (error) {
              warnings.push(
                `project environment ${project.project.id}/${workspace.id} was not captured: ${String(error)}`
                  .slice(0, 500),
              );
            }
          }
        }
        writeJson(join(secretRoot, "project-environments.json"), projectEnvironments);
        const coreBackup = join(secretRoot, "core.sqlite");
        if (await copyDatabase(join(this.config.dataDir, "core.sqlite"), coreBackup)) {
          scrubConnectorCore(coreBackup);
        } else {
          warnings.push("knowledge core.sqlite was missing; MTProto connector metadata was not captured");
        }
        const configPath = resolve(this.secretSources.configPath);
        const environmentPath = resolve(this.secretSources.environmentPath);
        const tdlibRoot = resolve(dirname(this.config.knowledgeSync.spoolRoot), "tdlib");
        await addComponent("secrets", "secrets", [
          { sourcePath: secretRoot, archivePath: "payload/data/connector-core", optional: true },
          { sourcePath: configPath, archivePath: "payload/data/config.toml", optional: true },
          { sourcePath: environmentPath, archivePath: "payload/etc/summing/summing.env", optional: true },
          { sourcePath: this.config.knowledgeSync.mtprotoMasterKeyPath, archivePath: "payload/etc/summing/mtproto.key", optional: true },
          { sourcePath: this.config.knowledgeSync.knowledgeTransferKeyPath, archivePath: "payload/etc/summing/kb-transfer.key", optional: true },
          { sourcePath: tdlibRoot, archivePath: "payload/data/tdlib", optional: true },
          { sourcePath: join(this.config.dataDir, "repository-credentials"), archivePath: "payload/data/repository-credentials", optional: true },
        ], false);
        mappings.push(
          { componentId: "secrets", archivePath: "payload/data/config.toml", destination: configPath },
          { componentId: "secrets", archivePath: "payload/etc/summing", destination: "/etc/summing" },
          { componentId: "secrets", archivePath: "payload/data/repository-credentials", destination: join(this.config.dataDir, "repository-credentials") },
          { componentId: "secrets", archivePath: "payload/data/tdlib", destination: tdlibRoot },
          { componentId: "secrets", archivePath: "payload/data/connector-core/core.sqlite", destination: join(this.config.dataDir, "core.sqlite") },
        );
      }

      warnings.push(...workspaceRecords.flatMap((workspace) => workspace.warnings));
      if (this.state.listConversations().some((conversation) => conversation.activeTurnId)) {
        throw new Error("a Codex turn started during node recovery export; retry after it finishes");
      }
      teamSpaces = this.currentTeamSpaceBundles();
      const manifest: NodeRecoveryManifest = {
        format: FORMAT,
        version: FORMAT_VERSION,
        backupId,
        nodeId: this.nodeId,
        nodeLabel: sanitizedNodeLabel(hostname()),
        createdAt: new Date().toISOString(),
        summingVersion: SUMMING_VERSION,
        includeSecrets: input.includeSecrets,
        components,
        inventory: {
          conversations: conversations.length,
          runs: countRows(stateBackup, "runs"),
          projects: this.projects.all().length,
          workspaces: workspaceRecords,
          sessions,
          teamSpaces,
        },
        restore: {
          reconnectRequired: [
            "Codex account authorization",
            "GitHub OAuth and external OAuth grants",
            ...(!input.includeSecrets ? ["Telegram MTProto connectors", "project runtime environments"] : []),
            ...(warnings.some((warning) => warning.startsWith("project environment "))
              ? ["project runtime environments that could not be read from the runner"]
              : []),
          ],
          excluded: [
            "Team Space contents (referenced by bundle key only)",
            "S3 original objects (already content-addressed in object storage)",
            "Codex auth.json and OAuth tokens",
            "generated node_modules, dist and caches",
          ],
          mappings,
        },
        warnings: [...new Set(warnings)],
        hmac: "",
      };
      const hmacKey = deriveKey(recoveryKey, backupId, "summing-node-recovery-manifest-v1");
      try {
        manifest.hmac = createHmac("sha256", hmacKey)
          .update(stableJson(manifestBody(manifest))).digest("hex");
      } finally {
        hmacKey.fill(0);
      }
      const manifestPath = join(work, "manifest.json");
      writeJson(manifestPath, manifest);
      if (statSync(manifestPath).size > MAXIMUM_MANIFEST_BYTES) {
        throw new Error("node recovery manifest exceeds 4 MB");
      }
      const bundleKey = `${root}/manifest.json`;
      await this.objectStore.putFile(bundleKey, manifestPath, {
        format: FORMAT,
        "backup-id": backupId,
        "node-id": this.nodeId,
      });
      return {
        backupId,
        bundleKey,
        recoveryKey: recoveryKey.toString("hex"),
        componentCount: components.length,
        encryptedBytes,
        includeSecrets: input.includeSecrets,
        warnings: manifest.warnings,
      };
    } catch (error) {
      await Promise.allSettled(components.map((component) => this.objectStore.delete(component.key)));
      throw error;
    } finally {
      rmSync(work, { recursive: true, force: true });
      if (ownsKey) recoveryKey.fill(0);
    }
  }

  async inspect(bundleKey: string, recoveryKey: Buffer): Promise<NodeRecoveryInspection> {
    const safeBundleKey = safeObjectKey(bundleKey);
    const work = recoveryWorkDirectory(
      this.config.knowledgeSync.spoolRoot || tmpdir(),
      "node-recovery-inspect-",
    );
    try {
      const manifestPath = join(work, "manifest.json");
      await this.objectStore.getFile(safeBundleKey, manifestPath);
      if (statSync(manifestPath).size > MAXIMUM_MANIFEST_BYTES) {
        throw new Error("node recovery manifest exceeds 4 MB");
      }
      const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")), recoveryKey);
      const verified: NodeRecoveryInspection["components"] = [];
      let totalPlaintext = 0;
      for (const component of manifest.components) {
        totalPlaintext += component.plaintextBytes;
        if (totalPlaintext > this.config.knowledgeSync.spoolMaximumBytes) {
          throw new Error("node recovery bundle exceeds configured restore limit");
        }
        const encryptedPath = join(work, `${component.id}.gz.enc`);
        await this.objectStore.getFile(component.key, encryptedPath);
        const digest = await sha256File(encryptedPath);
        if (digest.sha256 !== component.sha256 || digest.size !== component.size) {
          throw new Error(`node recovery component failed checksum verification: ${component.id}`);
        }
        const key = deriveKey(
          recoveryKey,
          manifest.backupId,
          `summing-node-recovery-component:${component.id}`,
        );
        try {
          const inspected = await inspectEncryptedNodeRecoveryComponent(
            encryptedPath,
            key,
            component.iv,
            component.tag,
            component.plaintextBytes,
          );
          if (
            inspected.entries !== component.entries ||
            inspected.files !== component.files ||
            inspected.plaintextBytes !== component.plaintextBytes
          ) {
            throw new Error(`node recovery component inventory mismatch: ${component.id}`);
          }
        } finally {
          key.fill(0);
        }
        verified.push({ ...component, verified: true });
        rmSync(encryptedPath, { force: true });
      }
      return {
        backupId: manifest.backupId,
        bundleKey: safeBundleKey,
        nodeId: manifest.nodeId,
        createdAt: manifest.createdAt,
        summingVersion: manifest.summingVersion,
        includeSecrets: manifest.includeSecrets,
        components: verified,
        inventory: manifest.inventory,
        restore: manifest.restore,
        warnings: manifest.warnings,
        ready: manifest.components.every((component) => !component.required || component.files > 0),
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  async stage(
    bundleKey: string,
    recoveryKey: Buffer,
    stagingRoot = join(this.config.dataDir, "node-recovery-staging"),
  ): Promise<NodeRecoveryInspection & { stagePath: string }> {
    const inspection = await this.inspect(bundleKey, recoveryKey);
    if (!inspection.ready) throw new Error("node recovery dry-run has blocking missing components");
    const finalPath = join(resolve(stagingRoot), inspection.backupId);
    const partialPath = `${finalPath}.partial-${process.pid}`;
    if (existsSync(finalPath)) throw new Error("node recovery bundle is already staged");
    rmSync(partialPath, { recursive: true, force: true });
    mkdirSync(partialPath, { recursive: true, mode: 0o700 });
    try {
      for (const component of inspection.components) {
        const encryptedPath = join(partialPath, `${component.id}.gz.enc`);
        await this.objectStore.getFile(component.key, encryptedPath);
        const digest = await sha256File(encryptedPath);
        if (digest.sha256 !== component.sha256 || digest.size !== component.size) {
          throw new Error(`node recovery component failed checksum verification: ${component.id}`);
        }
        const key = deriveKey(
          recoveryKey,
          inspection.backupId,
          `summing-node-recovery-component:${component.id}`,
        );
        try {
          await extractEncryptedNodeRecoveryComponent(
            encryptedPath,
            join(partialPath, "components", component.id),
            key,
            component.iv,
            component.tag,
            component.plaintextBytes,
          );
        } finally {
          key.fill(0);
          rmSync(encryptedPath, { force: true });
        }
      }
      writeJson(join(partialPath, "restore-plan.json"), {
        ...inspection,
        stagedAt: new Date().toISOString(),
        activation: "Stop SUMMING and run deploy/activate-node-recovery as root after reviewing mappings.",
      });
      chmodSync(partialPath, 0o700);
      mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
      renameSync(partialPath, finalPath);
      return { ...inspection, stagePath: finalPath };
    } catch (error) {
      rmSync(partialPath, { recursive: true, force: true });
      throw error;
    }
  }
}
