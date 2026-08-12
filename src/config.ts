import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class ConfigError extends Error {}

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
  const dataDir = expandPath(env.SUMMATE_DATA_DIR || "~/Summate/data", "SUMMATE_DATA_DIR");
  const configPath = expandPath(
    env.SUMMATE_CONFIG || `${dataDir}/config.toml`,
    "SUMMATE_CONFIG",
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
  const health = table(raw.health) ?? {};
  const codexHome = expandPath(env.CODEX_HOME || `${dataDir}/codex`, "CODEX_HOME");
  const worktreeRoot = expandPath(
    env.SUMMATE_WORKTREE_ROOT || `${dataDir}/worktrees`,
    "SUMMATE_WORKTREE_ROOT",
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
  );
}
