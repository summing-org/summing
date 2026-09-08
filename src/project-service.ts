export const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

export type RunnerServiceDesiredState = "running" | "stopped";
export type RunnerServiceAction = "start" | "stop" | "restart" | "rollback";
export type RunnerServiceStatus =
  | "deploying"
  | "running"
  | "stopped"
  | "unhealthy"
  | "failed";

export interface RunnerServiceRevision {
  deploymentId: string;
  releaseId: string;
  revision: string;
  imageId: string;
  environmentRevision: number;
  deployedAt: string;
}

export interface RunnerService {
  projectId: string;
  workspaceId: string;
  name: string;
  desiredState: RunnerServiceDesiredState;
  status: RunnerServiceStatus;
  current: RunnerServiceRevision | null;
  previous: RunnerServiceRevision | null;
  localEndpoint: string | null;
  error?: string;
  updatedAt: string;
  checkedAt?: string;
  restartCount?: number | null;
}

export interface RunnerServiceDefinition {
  command: string[];
  containerPort: number | null;
  healthPath: string | null;
  startupTimeoutSeconds: number;
  heartbeatPath?: string;
  heartbeatTimeoutSeconds?: number;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], message: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error(message);
}

function parseServiceDefinition(name: string, value: unknown): RunnerServiceDefinition {
  const definition = record(value, `service ${name} must contain an object`);
  exactKeys(
    definition,
    ["command", "containerPort", "healthPath", "startupTimeoutSeconds", "heartbeatPath", "heartbeatTimeoutSeconds"],
    `service ${name} contains unsupported fields`,
  );
  let command: string[] = [];
  if (definition.command !== undefined) {
    if (!Array.isArray(definition.command) || definition.command.length === 0 ||
      definition.command.length > 32 ||
      definition.command.some((part) => typeof part !== "string" || !part || part.length > 1_024)) {
      throw new Error(`service ${name} command must contain 1-32 bounded strings`);
    }
    command = [...definition.command];
  }
  const containerPort = definition.containerPort === undefined
    ? null
    : Number(definition.containerPort);
  if (containerPort !== null &&
    (!Number.isSafeInteger(containerPort) || containerPort < 1 || containerPort > 65_535)) {
    throw new Error(`service ${name} containerPort must be an integer from 1 to 65535`);
  }
  const healthPath = definition.healthPath === undefined
    ? null
    : String(definition.healthPath);
  if (healthPath !== null &&
    (!containerPort || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,255}$/.test(healthPath))) {
    throw new Error(`service ${name} healthPath requires a containerPort and a safe absolute path`);
  }
  const startupTimeoutSeconds = definition.startupTimeoutSeconds === undefined
    ? 60
    : Number(definition.startupTimeoutSeconds);
  if (!Number.isSafeInteger(startupTimeoutSeconds) ||
    startupTimeoutSeconds < 5 || startupTimeoutSeconds > 300) {
    throw new Error(`service ${name} startupTimeoutSeconds must be an integer from 5 to 300`);
  }
  const heartbeatPath = definition.heartbeatPath;
  if (heartbeatPath !== undefined && (typeof heartbeatPath !== "string" ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(heartbeatPath) ||
      heartbeatPath.length > 200 || heartbeatPath.split("/").some((part) => part === "." || part === ".."))) {
    throw new Error(`service ${name} heartbeatPath must be a safe relative path in the service data directory`);
  }
  const heartbeatTimeoutSeconds = Number(definition.heartbeatTimeoutSeconds ?? 180);
  if (!Number.isSafeInteger(heartbeatTimeoutSeconds) || heartbeatTimeoutSeconds < 10 || heartbeatTimeoutSeconds > 3600 ||
      (definition.heartbeatTimeoutSeconds !== undefined && heartbeatPath === undefined)) {
    throw new Error(`service ${name} heartbeatTimeoutSeconds requires heartbeatPath and must be from 10 to 3600`);
  }
  return { command, containerPort, healthPath, startupTimeoutSeconds,
    ...(heartbeatPath === undefined ? {} : { heartbeatPath, heartbeatTimeoutSeconds }) };
}

export function serviceDefinitions(
  manifestText: string,
): ReadonlyMap<string, RunnerServiceDefinition> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error(".summing/services.json is malformed");
  }
  const manifest = record(parsed, ".summing/services.json must contain an object");
  exactKeys(manifest, ["version", "services"], ".summing/services.json contains unsupported fields");
  if (manifest.version !== 1) throw new Error("service manifest version must be 1");
  const services = record(manifest.services, "service manifest must contain services");
  if (Object.keys(services).length === 0 || Object.keys(services).length > 20) {
    throw new Error("service manifest must contain 1-20 services");
  }
  if (Object.keys(services).some((serviceName) => !SERVICE_NAME.test(serviceName))) {
    throw new Error("service manifest contains an invalid service name");
  }
  return new Map(
    Object.entries(services).map(([name, value]) => [name, parseServiceDefinition(name, value)]),
  );
}

export function serviceDefinition(manifestText: string, name: string): RunnerServiceDefinition {
  if (!SERVICE_NAME.test(name)) throw new Error("service name is invalid");
  const definition = serviceDefinitions(manifestText).get(name);
  if (!definition) throw new Error(`service ${name} is not declared in .summing/services.json`);
  return definition;
}
