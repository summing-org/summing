import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9_]{0,127}$/;
const HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);
const RUNNER_ACTIONS = new Set(["dry-run", "run"]);
const MAXIMUM_MANIFEST_BYTES = 128_000;

export type IntegrationAuthType = "api_key" | "none" | "oauth2";
export type IntegrationMode = "gateway" | "lease" | "raw";
export type IntegrationAction = "dry-run" | "run";

export interface IntegrationSecretField {
  name: string;
}

export interface IntegrationRuntimeCredential {
  name: string;
  env: string;
}

export interface IntegrationGatewayPolicy {
  methods: string[];
  pathPrefixes: string[];
}

export interface IntegrationDeclaration {
  id: string;
  provider: string;
  environment: string;
  auth: IntegrationAuthType;
  mode: IntegrationMode;
  capabilities: string[];
  scopes: string[];
  actions: IntegrationAction[];
  secrets: IntegrationSecretField[];
  runtime: IntegrationRuntimeCredential[];
  gateway: IntegrationGatewayPolicy | null;
}

export interface IntegrationManifest {
  version: 1;
  integrations: IntegrationDeclaration[];
}

export class IntegrationManifestError extends Error {}

export function integrationRuntimePrefix(integration: Pick<IntegrationDeclaration, "id" | "environment">): string {
  return `SUMMING_${integration.id}_${integration.environment}`.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationManifestError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!IDENTIFIER.test(text)) {
    throw new IntegrationManifestError(`${field} must match ${IDENTIFIER.source}`);
  }
  return text;
}

function stringArray(value: unknown, field: string, maximum = 64): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new IntegrationManifestError(`${field} must be an array with at most ${maximum} entries`);
  }
  const result = value.map((item) => String(item ?? "").trim());
  if (result.some((item) => !item || item.length > 256)) {
    throw new IntegrationManifestError(`${field} contains an empty or overlong value`);
  }
  if (new Set(result).size !== result.length) {
    throw new IntegrationManifestError(`${field} contains duplicates`);
  }
  return result;
}

function parseSecrets(value: unknown, field: string): IntegrationSecretField[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new IntegrationManifestError(`${field} must be an array with at most 32 entries`);
  }
  const fields = value.map((raw, index) => {
    const item = object(raw, `${field}[${index}]`);
    const name = identifier(item.name, `${field}[${index}].name`);
    return { name };
  });
  if (new Set(fields.map((item) => item.name)).size !== fields.length) {
    throw new IntegrationManifestError(`${field} contains duplicate secret names`);
  }
  return fields;
}

function parseRuntime(value: unknown, field: string): IntegrationRuntimeCredential[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new IntegrationManifestError(`${field} must be an array with at most 32 entries`);
  }
  const fields = value.map((raw, index) => {
    const item = object(raw, `${field}[${index}]`);
    const name = identifier(item.name, `${field}[${index}].name`);
    const env = String(item.env ?? "").trim();
    if (!ENVIRONMENT_VARIABLE.test(env)) {
      throw new IntegrationManifestError(`${field}[${index}].env must be an uppercase environment variable`);
    }
    if (
      env === "PATH" ||
      env === "HOME" ||
      env === "NODE_OPTIONS" ||
      env === "DOCKER_HOST" ||
      env === "CONFIG_PATH" ||
      env === "HISTORY_PATH" ||
      env.startsWith("LD_") ||
      env.startsWith("SUMMING_")
    ) {
      throw new IntegrationManifestError(`${field}[${index}].env is reserved by the runtime`);
    }
    return { name, env };
  });
  if (new Set(fields.map((item) => item.name)).size !== fields.length) {
    throw new IntegrationManifestError(`${field} contains duplicate credential names`);
  }
  if (new Set(fields.map((item) => item.env)).size !== fields.length) {
    throw new IntegrationManifestError(`${field} contains duplicate environment variables`);
  }
  return fields;
}

function parseActions(value: unknown, field: string): IntegrationAction[] {
  const values = value === undefined ? ["run"] : stringArray(value, field, 2);
  if (values.some((item) => !RUNNER_ACTIONS.has(item))) {
    throw new IntegrationManifestError(`${field} supports only dry-run and run`);
  }
  return values as IntegrationAction[];
}

function parseGateway(value: unknown, field: string): IntegrationGatewayPolicy {
  const gateway = object(value, field);
  const methods = stringArray(gateway.methods, `${field}.methods`, 6).map((item) =>
    item.toUpperCase(),
  );
  if (methods.length === 0 || methods.some((method) => !HTTP_METHODS.has(method))) {
    throw new IntegrationManifestError(`${field}.methods contains an unsupported HTTP method`);
  }
  const pathPrefixes = stringArray(gateway.pathPrefixes, `${field}.pathPrefixes`, 32);
  if (
    pathPrefixes.length === 0 ||
    pathPrefixes.some((path) =>
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("..") ||
      path.includes("?") ||
      path.includes("\\")
    )
  ) {
    throw new IntegrationManifestError(
      `${field}.pathPrefixes must contain absolute URL path prefixes without '..' or query strings`,
    );
  }
  return { methods, pathPrefixes };
}

function parseIntegration(value: unknown, index: number): IntegrationDeclaration {
  const field = `integrations[${index}]`;
  const item = object(value, field);
  const id = identifier(item.id, `${field}.id`);
  const provider = identifier(item.provider, `${field}.provider`);
  const environment = identifier(item.environment ?? "production", `${field}.environment`);
  const auth = String(item.auth ?? "").trim() as IntegrationAuthType;
  if (!(auth === "api_key" || auth === "none" || auth === "oauth2")) {
    throw new IntegrationManifestError(`${field}.auth must be api_key, oauth2, or none`);
  }
  const mode = String(item.mode ?? "").trim() as IntegrationMode;
  if (!(mode === "gateway" || mode === "lease" || mode === "raw")) {
    throw new IntegrationManifestError(`${field}.mode must be gateway, lease, or raw`);
  }
  const capabilities = stringArray(item.capabilities, `${field}.capabilities`).map((capability, capabilityIndex) =>
    identifier(capability, `${field}.capabilities[${capabilityIndex}]`),
  );
  const scopes = stringArray(item.scopes, `${field}.scopes`);
  const actions = parseActions(item.actions, `${field}.actions`);
  const secrets = parseSecrets(item.secrets, `${field}.secrets`);
  const runtime = parseRuntime(item.runtime, `${field}.runtime`);
  if (auth === "api_key" && secrets.length === 0) {
    throw new IntegrationManifestError(`${field}.secrets is required for api_key auth`);
  }
  if (auth !== "api_key" && secrets.length > 0) {
    throw new IntegrationManifestError(`${field}.secrets is allowed only for api_key auth`);
  }
  if (mode === "raw") {
    if (auth !== "api_key") {
      throw new IntegrationManifestError(`${field}: raw mode currently supports api_key auth only`);
    }
    if (runtime.length === 0 || runtime.some((entry) => !secrets.some((secret) => secret.name === entry.name))) {
      throw new IntegrationManifestError(`${field}.runtime must map declared raw secret names to environment variables`);
    }
  }
  if (mode === "lease") {
    if (auth !== "oauth2") {
      throw new IntegrationManifestError(`${field}: lease mode currently supports oauth2 access tokens only`);
    }
    if (
      runtime.length === 0 ||
      runtime.some((entry) => !["access_token", "token_type", "expires_at"].includes(entry.name))
    ) {
      throw new IntegrationManifestError(`${field}.runtime may lease only OAuth access-token metadata`);
    }
  }
  if (mode === "gateway" && capabilities.length === 0) {
    throw new IntegrationManifestError(`${field}.capabilities is required in gateway mode`);
  }
  if (mode === "gateway" && runtime.length > 0) {
    throw new IntegrationManifestError(`${field}.runtime is forbidden in gateway mode`);
  }
  if (mode !== "gateway" && item.gateway !== undefined && item.gateway !== null) {
    throw new IntegrationManifestError(`${field}.gateway is allowed only in gateway mode`);
  }
  const gateway = mode === "gateway" ? parseGateway(item.gateway, `${field}.gateway`) : null;
  return {
    id,
    provider,
    environment,
    auth,
    mode,
    capabilities,
    scopes,
    actions,
    secrets,
    runtime,
    gateway,
  };
}

export function parseIntegrationManifest(value: unknown): IntegrationManifest {
  const root = object(value, "manifest");
  if (root.version !== 1) throw new IntegrationManifestError("manifest.version must be 1");
  if (!Array.isArray(root.integrations) || root.integrations.length > 64) {
    throw new IntegrationManifestError("manifest.integrations must contain at most 64 entries");
  }
  const integrations = root.integrations.map(parseIntegration);
  const keys = integrations.map((item) => `${item.id}:${item.environment}`);
  if (new Set(keys).size !== keys.length) {
    throw new IntegrationManifestError("integration id/environment pairs must be unique");
  }
  const runtimePrefixes = integrations.map(integrationRuntimePrefix);
  if (new Set(runtimePrefixes).size !== runtimePrefixes.length) {
    throw new IntegrationManifestError("integration ids/environments collide as runtime variable prefixes");
  }
  const runtimeEnvironments = integrations.flatMap((integration) =>
    integration.runtime.map((entry) => entry.env),
  );
  if (new Set(runtimeEnvironments).size !== runtimeEnvironments.length) {
    throw new IntegrationManifestError("integration runtime environment variables must be globally unique");
  }
  return { version: 1, integrations };
}

export function loadIntegrationManifest(root: string): IntegrationManifest {
  const path = resolve(root, ".summing", "integrations.json");
  if (!existsSync(path)) return { version: 1, integrations: [] };
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new IntegrationManifestError(".summing/integrations.json must be a regular file");
  }
  if (metadata.size > MAXIMUM_MANIFEST_BYTES) {
    throw new IntegrationManifestError(".summing/integrations.json exceeds 128 KB");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new IntegrationManifestError(
      `.summing/integrations.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseIntegrationManifest(value);
}
