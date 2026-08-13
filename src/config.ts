import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TRANSCRIPTION_PROVIDERS = new Set(["openai", "groq"]);
const OPENAI_TRANSCRIPTION_MODELS = new Set([
  "gpt-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
]);
const GROQ_TRANSCRIPTION_MODELS = new Set(["whisper-large-v3-turbo", "whisper-large-v3"]);

export class ConfigError extends Error {}

export type TranscriptionProvider = "openai" | "groq";

export interface WorkspaceConfig {
  id: string;
  path: string;
}

export class ProjectConfig {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly defaultWorkspace: string,
    readonly workspaces: ReadonlyMap<string, WorkspaceConfig>,
    readonly selfChange = false,
  ) {}

  workspace(workspaceId = ""): WorkspaceConfig {
    const selected = workspaceId || this.defaultWorkspace;
    const workspace = this.workspaces.get(selected);
    if (!workspace) {
      throw new ConfigError(`project '${this.id}' has no workspace '${selected}'`);
    }
    return workspace;
  }
}

export class RuntimeConfig {
  constructor(
    readonly dataDir: string,
    readonly codexHome: string,
    readonly worktreeRoot: string,
    readonly telegramToken: string,
    readonly telegramOwnerId: number,
    readonly codexBinary: string,
    readonly healthPort: number,
    readonly maxParallelConversations: number,
    readonly streamIntervalSec: number,
    readonly model: string,
    readonly effort: string,
    readonly networkAccess: boolean,
    readonly projects: ReadonlyMap<string, ProjectConfig>,
    readonly participantBatchSeconds = 20,
    readonly participantMessagesPerWindow = 12,
    readonly participantRateLimitWindowSeconds = 60,
    readonly transcriptionProvider: TranscriptionProvider = "openai",
    readonly transcriptionModel = "gpt-transcribe",
    readonly openaiApiKey = "",
    readonly groqApiKey = "",
    readonly maximumAttachmentBytes = 20_000_000,
    readonly viewerPort = 8_766,
    readonly viewerPublicUrl = "",
    readonly viewerAuthMaxAgeSeconds = 900,
    readonly viewerLocalToken = "",
    readonly runnerSocket = "/run/summing-runner/runner.sock",
    readonly deploymentRequestPath = "",
    readonly deploymentStatePath = "",
    readonly codexLimitsProfileEnabled = true,
    readonly codexLimitsRefreshIntervalSeconds = 900,
    readonly codexLimitsTimeZone = "Europe/Moscow",
    readonly connectionsEnabled = false,
    readonly connectionsPublicUrl = "",
    readonly connectionTicketPrivateKeyPath = "",
    readonly secretBrokerControlSocket = "/run/summing-secrets/control.sock",
  ) {}

  project(projectId: string): ProjectConfig {
    const project = this.projects.get(projectId);
    if (!project) throw new ConfigError(`unknown project '${projectId}'`);
    return project;
  }
}

type Table = Record<string, unknown>;

function table(value: unknown): Table | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Table)
    : undefined;
}

export function normalizeIdentifier(value: unknown, field: string): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!ID_PATTERN.test(text)) {
    throw new ConfigError(`${field} must match '${ID_PATTERN.source}'; got ${String(value)}`);
  }
  return text;
}

export function normalizeProjectIdentifier(value: unknown, field: string): string {
  const text = normalizeIdentifier(value, field);
  if (text.includes("..") || text.endsWith(".lock")) {
    throw new ConfigError(
      `${field} must also be a valid Git branch component; '..' and a '.lock' suffix are forbidden`,
    );
  }
  return text;
}

export function telegramUserId(value: unknown, field = "Telegram user id"): number {
  return boundedNumber(value, field, 1, Number.MAX_SAFE_INTEGER, true);
}

function boundedNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  integer: boolean,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new ConfigError(`${field} must be ${integer ? "an integer" : "a number"}`);
  }
  if (parsed < minimum || parsed > maximum) {
    throw new ConfigError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function expandPath(value: unknown, field: string): string {
  let raw = String(value ?? "");
  if (raw === "~" || raw.startsWith("~/")) raw = homedir() + raw.slice(1);
  if (!isAbsolute(raw)) throw new ConfigError(`${field} must be an absolute path`);
  return resolve(raw);
}

function timeZone(value: unknown, field: string): string {
  const name = String(value ?? "").trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name }).format(0);
  } catch {
    throw new ConfigError(`${field} must be a valid IANA time zone`);
  }
  return name;
}

function loadProjects(value: unknown): ReadonlyMap<string, ProjectConfig> {
  const raw = table(value);
  if (!raw || Object.keys(raw).length === 0) {
    throw new ConfigError("config.toml must define at least one [projects.<id>] table");
  }
  const projects = new Map<string, ProjectConfig>();
  for (const [rawProjectId, rawProjectValue] of Object.entries(raw)) {
    const projectId = normalizeProjectIdentifier(rawProjectId, "project id");
    const project = table(rawProjectValue);
    if (!project) throw new ConfigError(`projects.${projectId} must be a table`);
    const rawWorkspaces = table(project.workspaces);
    if (!rawWorkspaces || Object.keys(rawWorkspaces).length === 0) {
      throw new ConfigError(`projects.${projectId} must define at least one workspace`);
    }
    const workspaces = new Map<string, WorkspaceConfig>();
    for (const [rawWorkspaceId, rawWorkspaceValue] of Object.entries(rawWorkspaces)) {
      const workspaceId = normalizeIdentifier(rawWorkspaceId, "workspace id");
      const workspace = table(rawWorkspaceValue);
      if (!workspace) {
        throw new ConfigError(`projects.${projectId}.workspaces.${workspaceId} must be a table`);
      }
      workspaces.set(workspaceId, {
        id: workspaceId,
        path: expandPath(
          workspace.path,
          `projects.${projectId}.workspaces.${workspaceId}.path`,
        ),
      });
    }
    const firstWorkspace = workspaces.keys().next().value as string;
    const defaultWorkspace = normalizeIdentifier(
      project.default_workspace || firstWorkspace,
      `projects.${projectId}.default_workspace`,
    );
    if (!workspaces.has(defaultWorkspace)) {
      throw new ConfigError(
        `projects.${projectId}.default_workspace references an unknown workspace`,
      );
    }
    projects.set(
      projectId,
      new ProjectConfig(
        projectId,
        String(project.name || projectId).trim(),
        defaultWorkspace,
        workspaces,
        Boolean(project.self_change ?? false),
      ),
    );
  }
  return projects;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const dataDir = expandPath(env.SUMMING_DATA_DIR || "~/summing/data", "SUMMING_DATA_DIR");
  const configPath = expandPath(
    env.SUMMING_CONFIG || `${dataDir}/config.toml`,
    "SUMMING_CONFIG",
  );
  try {
    if (!statSync(configPath).isFile()) throw new Error("not a file");
  } catch {
    throw new ConfigError(
      `configuration file does not exist: ${configPath}; copy config.example.toml`,
    );
  }

  let raw: Table;
  try {
    raw = parse(readFileSync(configPath, "utf8")) as Table;
  } catch (error) {
    throw new ConfigError(`cannot read ${configPath}: ${String(error)}`);
  }

  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) throw new ConfigError("TELEGRAM_BOT_TOKEN is required");
  const ownerId = telegramUserId(env.TELEGRAM_OWNER_ID, "TELEGRAM_OWNER_ID");
  const agent = table(raw.agent) ?? {};
  const transcription = table(raw.transcription) ?? {};
  const codexUsage = table(raw.codex_usage) ?? {};
  const health = table(raw.health) ?? {};
  const viewer = table(raw.viewer) ?? {};
  const connections = table(raw.connections) ?? {};
  const codexHome = expandPath(env.CODEX_HOME || `${dataDir}/codex`, "CODEX_HOME");
  const worktreeRoot = expandPath(
    env.SUMMING_WORKTREE_ROOT || `${dataDir}/worktrees`,
    "SUMMING_WORKTREE_ROOT",
  );
  const configuredTranscriptionProvider = String(transcription.provider || "openai").trim();
  const transcriptionProvider = String(
    env.TRANSCRIPTION_PROVIDER || configuredTranscriptionProvider,
  ).trim();
  if (!TRANSCRIPTION_PROVIDERS.has(transcriptionProvider)) {
    throw new ConfigError("transcription.provider must be 'openai' or 'groq'");
  }
  const defaultTranscriptionModel =
    transcriptionProvider === "groq" ? "whisper-large-v3-turbo" : "gpt-transcribe";
  const configuredTranscriptionModel =
    transcriptionProvider === configuredTranscriptionProvider
      ? String(transcription.model || "").trim()
      : "";
  const transcriptionModel = String(
    env.TRANSCRIPTION_MODEL ||
      configuredTranscriptionModel ||
      defaultTranscriptionModel,
  ).trim();
  const allowedModels =
    transcriptionProvider === "groq"
      ? GROQ_TRANSCRIPTION_MODELS
      : OPENAI_TRANSCRIPTION_MODELS;
  if (!allowedModels.has(transcriptionModel)) {
    throw new ConfigError(
      `transcription.model '${transcriptionModel}' is not supported by ${transcriptionProvider}`,
    );
  }

  const viewerPublicUrl = String(
    env.SUMMING_VIEWER_URL || viewer.public_url || "",
  ).trim().replace(/\/$/, "");
  if (viewerPublicUrl && !viewerPublicUrl.startsWith("https://")) {
    throw new ConfigError("viewer.public_url must use HTTPS");
  }
  const connectionsPublicUrl = String(
    env.SUMMING_CONNECTIONS_URL || connections.public_url || "",
  ).trim().replace(/\/$/, "");
  if (connectionsPublicUrl && !connectionsPublicUrl.startsWith("https://")) {
    throw new ConfigError("connections.public_url must use HTTPS");
  }
  const ticketPrivateKeyRaw = String(
    env.SUMMING_CONNECTION_TICKET_PRIVATE_KEY || connections.ticket_private_key || "",
  ).trim();
  const connectionsEnabled = Boolean(connectionsPublicUrl || ticketPrivateKeyRaw);
  if (connectionsEnabled && (!connectionsPublicUrl || !ticketPrivateKeyRaw)) {
    throw new ConfigError(
      "connections.public_url and connections.ticket_private_key must be configured together",
    );
  }
  const ticketPrivateKey = ticketPrivateKeyRaw
    ? expandPath(ticketPrivateKeyRaw, "connections.ticket_private_key")
    : "";
  const brokerControlSocket = expandPath(
    env.SUMMING_SECRETS_CONTROL_SOCKET ||
      connections.control_socket ||
      "/run/summing-secrets/control.sock",
    "connections.control_socket",
  );

  return new RuntimeConfig(
    dataDir,
    codexHome,
    worktreeRoot,
    token,
    ownerId,
    String(env.CODEX_BIN || agent.codex_binary || "codex"),
    boundedNumber(health.port ?? 8765, "health.port", 1, 65_535, true),
    boundedNumber(
      agent.max_parallel_conversations ?? 4,
      "agent.max_parallel_conversations",
      1,
      32,
      true,
    ),
    boundedNumber(agent.stream_interval_sec ?? 1, "agent.stream_interval_sec", 0.5, 10, false),
    String(agent.model || "").trim(),
    String(agent.effort || "medium").trim(),
    Boolean(agent.network_access ?? true),
    loadProjects(raw.projects),
    boundedNumber(
      agent.participant_batch_sec ?? 20,
      "agent.participant_batch_sec",
      5,
      120,
      false,
    ),
    boundedNumber(
      agent.participant_rate_limit_messages ?? 12,
      "agent.participant_rate_limit_messages",
      1,
      100,
      true,
    ),
    boundedNumber(
      agent.participant_rate_limit_window_sec ?? 60,
      "agent.participant_rate_limit_window_sec",
      10,
      3_600,
      false,
    ),
    transcriptionProvider as TranscriptionProvider,
    transcriptionModel,
    String(env.OPENAI_API_KEY || "").trim(),
    String(env.GROQ_API_KEY || "").trim(),
    boundedNumber(
      transcription.max_file_bytes ?? 20_000_000,
      "transcription.max_file_bytes",
      1,
      20_000_000,
      true,
    ),
    boundedNumber(viewer.port ?? 8_766, "viewer.port", 1, 65_535, true),
    viewerPublicUrl,
    boundedNumber(
      viewer.auth_max_age_sec ?? 900,
      "viewer.auth_max_age_sec",
      60,
      86_400,
      true,
    ),
    String(env.SUMMING_VIEWER_LOCAL_TOKEN || "").trim(),
    expandPath(
      env.SUMMING_RUNNER_SOCKET || viewer.runner_socket || "/run/summing-runner/runner.sock",
      "viewer.runner_socket",
    ),
    env.SUMMING_DEPLOY_REQUEST
      ? expandPath(env.SUMMING_DEPLOY_REQUEST, "SUMMING_DEPLOY_REQUEST")
      : "",
    env.SUMMING_DEPLOY_STATE
      ? expandPath(env.SUMMING_DEPLOY_STATE, "SUMMING_DEPLOY_STATE")
      : "",
    Boolean(codexUsage.profile_enabled ?? true),
    boundedNumber(
      codexUsage.refresh_interval_sec ?? 900,
      "codex_usage.refresh_interval_sec",
      60,
      86_400,
      true,
    ),
    timeZone(codexUsage.timezone ?? "Europe/Moscow", "codex_usage.timezone"),
    connectionsEnabled,
    connectionsPublicUrl,
    ticketPrivateKey,
    brokerControlSocket,
  );
}
