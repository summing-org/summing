import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { dirname, resolve } from "node:path";
import {
  parseProjectEnvironment,
  ProjectEnvironmentError,
  ProjectEnvironmentStore,
} from "./project-environment.js";
import type { RunnerJob } from "./project-runner-client.js";

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const JOB_ID = /^[0-9a-f-]{36}$/;
const MAXIMUM_RESPONSE_BYTES = 2_000_000;

interface LegacyIntegration {
  id?: unknown;
  auth?: unknown;
  mode?: unknown;
  actions?: unknown;
  [name: string]: unknown;
}

interface LegacyManifest {
  version?: unknown;
  integrations?: unknown;
}

interface LegacyLease {
  id: string;
  projectId: string;
  jobId: string;
  environment: Record<string, string>;
  gatewayTokens: Record<string, string>;
}

export interface EnvironmentMigrationMarker {
  version: 1;
  projectId: string;
  workspaceId: string;
  environmentRevision: number;
  integrationIds: string[];
  variableNames: string[];
  migratedAt: string;
}

export interface EnvironmentVerificationMarker {
  version: 1;
  projectId: string;
  workspaceId: string;
  revision: string;
  validateJobId: string;
  dryRunJobId: string;
  environmentRevision: number;
  verifiedAt: string;
}

export interface ImportLegacyConnectionsOptions {
  projectId: string;
  workspaceId: string;
  manifestPath: string;
  brokerSocket: string;
  bootstrapPath: string;
  markerPath: string;
  store: ProjectEnvironmentStore;
  manifestText?: string;
}

export interface RecordEnvironmentVerificationOptions {
  projectId: string;
  workspaceId: string;
  revision: string;
  markerPath: string;
  store: ProjectEnvironmentStore;
  validateJob: RunnerJob;
  dryRunJob: RunnerJob;
}

export interface LegacyEnvironmentMigrationTarget {
  projectId: string;
  workspaceId: string;
  repository: string;
  revision: string;
  manifestPath: string;
  bootstrapPath: string;
  stateRoot: string;
}

export class ProjectEnvironmentMigrationError extends Error {}

function regularJson(path: string, field: string): Record<string, unknown> {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > 1_000_000 ||
    (metadata.mode & 0o007) !== 0
  ) {
    throw new ProjectEnvironmentMigrationError(`${field} must be a non-public regular JSON file`);
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new ProjectEnvironmentMigrationError(`${field} is malformed`);
  }
}

export function discoverLegacyEnvironmentMigrations(
  configRoot: string,
  scheduleRoot: string,
  dataRoot: string,
  inspectFinalizedState = true,
): LegacyEnvironmentMigrationTarget[] {
  if (!existsSync(scheduleRoot)) return [];
  const schedules = readdirSync(scheduleRoot)
    .filter((name) => /^[a-z0-9][a-z0-9._-]{0,63}\.json$/.test(name))
    .sort();
  const targets: LegacyEnvironmentMigrationTarget[] = [];
  const scopes = new Set<string>();
  for (const name of schedules) {
    const schedule = regularJson(resolve(scheduleRoot, name), `schedule ${name}`);
    const projectId = String(schedule.projectId ?? "");
    const workspaceId = String(schedule.workspaceId ?? "repo");
    const repository = String(schedule.repository ?? "");
    const revision = String(schedule.revision ?? "");
    if (
      !IDENTIFIER.test(projectId) ||
      !IDENTIFIER.test(workspaceId) ||
      !repository.startsWith("/") ||
      !/^[0-9a-f]{40}$/.test(revision)
    ) {
      throw new ProjectEnvironmentMigrationError(`schedule ${name} cannot drive environment migration`);
    }
    const projectPath = resolve(configRoot, `${projectId}.json`);
    if (!existsSync(projectPath)) continue;
    const project = regularJson(projectPath, `runner project ${projectId}`);
    const bootstrapPath = typeof project.envPath === "string" ? project.envPath : "";
    if (!bootstrapPath) continue;
    if (!bootstrapPath.startsWith("/")) {
      throw new ProjectEnvironmentMigrationError(`runner project ${projectId} has an invalid legacy envPath`);
    }
    const scope = `${projectId}:${workspaceId}`;
    if (scopes.has(scope)) {
      throw new ProjectEnvironmentMigrationError(`multiple schedules define legacy migration scope ${scope}`);
    }
    scopes.add(scope);
    const stateRoot = resolve(
      dataRoot,
      "migrations",
      "connections-to-environment",
      `${projectId}--${workspaceId}`,
    );
    const finalizedPath = resolve(stateRoot, "finalized.json");
    if (inspectFinalizedState && existsSync(finalizedPath)) {
      const finalized = privateJson<Record<string, unknown>>(finalizedPath);
      if (
        finalized.version !== 1 ||
        finalized.projectId !== projectId ||
        finalized.workspaceId !== workspaceId ||
        finalized.legacyBrokerDataPreserved !== true
      ) {
        throw new ProjectEnvironmentMigrationError(`finalized migration marker is invalid for ${scope}`);
      }
      continue;
    }
    targets.push({
      projectId,
      workspaceId,
      repository: resolve(repository),
      revision,
      manifestPath: resolve(repository, ".summing", "integrations.json"),
      bootstrapPath: resolve(bootstrapPath),
      stateRoot,
    });
  }
  return targets;
}

function privateJson<T>(path: string): T {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > 1_000_000 ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new ProjectEnvironmentMigrationError(`migration state is not a private regular file: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new ProjectEnvironmentMigrationError(`migration state is malformed: ${path}`);
  }
}

function atomicPrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function validateScope(projectId: string, workspaceId: string): void {
  if (!IDENTIFIER.test(projectId) || !IDENTIFIER.test(workspaceId)) {
    throw new ProjectEnvironmentMigrationError("migration project or workspace id is invalid");
  }
}

function parseMigrationManifest(value: unknown): { integrations: LegacyIntegration[]; ids: string[] } {
  const manifest = value as LegacyManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.integrations) || manifest.integrations.length > 64) {
    throw new ProjectEnvironmentMigrationError("legacy integration manifest has an unsupported shape");
  }
  const raw = manifest.integrations as LegacyIntegration[];
  if (raw.some((integration) => !integration || typeof integration !== "object" || Array.isArray(integration))) {
    throw new ProjectEnvironmentMigrationError("legacy integration manifest contains a non-object declaration");
  }
  const integrations = raw.filter((integration) => integration.auth !== "none");
  if (integrations.length === 0) {
    throw new ProjectEnvironmentMigrationError("legacy integration manifest has no credentials to migrate");
  }
  const ids: string[] = [];
  for (const integration of integrations) {
    const id = String(integration.id ?? "");
    const environment = String(integration.environment ?? "production");
    if (!IDENTIFIER.test(id)) throw new ProjectEnvironmentMigrationError("legacy integration id is invalid");
    if (!IDENTIFIER.test(environment)) {
      throw new ProjectEnvironmentMigrationError(`legacy integration '${id}' has an invalid environment`);
    }
    if (integration.auth !== "api_key" || integration.mode !== "raw") {
      throw new ProjectEnvironmentMigrationError(
        `legacy integration '${id}' is not a raw API-key connection and cannot become dotenv automatically`,
      );
    }
    ids.push(`${id}@${environment}`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new ProjectEnvironmentMigrationError("legacy integration ids are duplicated");
  }
  return {
    integrations: integrations.map((integration) => ({ ...integration, actions: ["dry-run"] })),
    ids: ids.sort(),
  };
}

function migrationManifest(options: ImportLegacyConnectionsOptions): {
  integrations: LegacyIntegration[];
  ids: string[];
} {
  let source: string;
  if (options.manifestText !== undefined) {
    source = options.manifestText;
  } else {
    const metadata = lstatSync(options.manifestPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > 128_000
    ) {
      throw new ProjectEnvironmentMigrationError("legacy integration manifest is not a regular file under 128 KB");
    }
    source = readFileSync(options.manifestPath, "utf8");
  }
  if (Buffer.byteLength(source) > 128_000) {
    throw new ProjectEnvironmentMigrationError("legacy integration manifest exceeds 128 KB");
  }
  let value: LegacyManifest;
  try {
    value = JSON.parse(source) as LegacyManifest;
  } catch {
    throw new ProjectEnvironmentMigrationError("legacy integration manifest is malformed");
  }
  return parseMigrationManifest(value);
}

export function readPinnedLegacyManifest(repository: string, revision: string): string {
  if (!repository.startsWith("/") || !/^[0-9a-f]{40}$/.test(revision)) {
    throw new ProjectEnvironmentMigrationError("pinned legacy manifest source is invalid");
  }
  let source: string;
  try {
    source = execFileSync(
      "/usr/bin/git",
      ["-C", repository, "show", `${revision}:.summing/integrations.json`],
      { encoding: "utf8", maxBuffer: 128_001, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    throw new ProjectEnvironmentMigrationError("pinned legacy integration manifest is unavailable");
  }
  if (Buffer.byteLength(source) > 128_000) {
    throw new ProjectEnvironmentMigrationError("legacy integration manifest exceeds 128 KB");
  }
  try {
    parseMigrationManifest(JSON.parse(source) as unknown);
  } catch (error) {
    if (error instanceof ProjectEnvironmentMigrationError) throw error;
    throw new ProjectEnvironmentMigrationError("legacy integration manifest is malformed");
  }
  return source;
}

function socketJson<T>(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise<T>((resolveCall, reject) => {
    const handle = request(
      {
        socketPath,
        method,
        path,
        headers: encoded
          ? { "content-type": "application/json", "content-length": String(encoded.length) }
          : {},
        timeout: 30_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= MAXIMUM_RESPONSE_BYTES) chunks.push(chunk);
        });
        response.on("end", () => {
          if (bytes > MAXIMUM_RESPONSE_BYTES) {
            reject(new ProjectEnvironmentMigrationError("legacy broker response exceeds 2 MB"));
            return;
          }
          let value: unknown;
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            value = text ? JSON.parse(text) : null;
          } catch {
            value = null;
          }
          const status = response.statusCode ?? 500;
          if (status >= 400) {
            const message = value && typeof value === "object" && !Array.isArray(value) &&
              typeof (value as Record<string, unknown>).error === "string"
              ? String((value as Record<string, unknown>).error)
              : `legacy broker returned HTTP ${status}`;
            reject(new ProjectEnvironmentMigrationError(message));
            return;
          }
          resolveCall(value as T);
        });
      },
    );
    handle.once("timeout", () => handle.destroy(new Error("legacy broker request timed out")));
    handle.once("error", (error) => reject(new ProjectEnvironmentMigrationError(error.message)));
    handle.end(encoded ?? undefined);
  });
}

function quotedDotenvValue(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\t", "\\t")}"`;
}

function existingMarker(
  path: string,
  projectId: string,
  workspaceId: string,
  store: ProjectEnvironmentStore,
): EnvironmentMigrationMarker | null {
  if (!existsSync(path)) return null;
  const marker = privateJson<EnvironmentMigrationMarker>(path);
  if (
    marker.version !== 1 ||
    marker.projectId !== projectId ||
    marker.workspaceId !== workspaceId ||
    !Number.isSafeInteger(marker.environmentRevision) ||
    marker.environmentRevision <= 0 ||
    !Array.isArray(marker.integrationIds) ||
    !Array.isArray(marker.variableNames)
  ) {
    throw new ProjectEnvironmentMigrationError("environment migration marker is invalid");
  }
  const document = store.get(projectId, workspaceId);
  if (document.revision < marker.environmentRevision) {
    throw new ProjectEnvironmentMigrationError("environment migration marker is newer than the encrypted store");
  }
  const values = parseProjectEnvironment(document.text).values;
  if (marker.variableNames.some((name) => !values.has(name))) {
    throw new ProjectEnvironmentMigrationError("encrypted environment no longer contains every migrated variable");
  }
  return marker;
}

export async function importLegacyConnections(
  options: ImportLegacyConnectionsOptions,
): Promise<{ status: "already-migrated" | "migrated"; marker: EnvironmentMigrationMarker }> {
  validateScope(options.projectId, options.workspaceId);
  const currentMarker = existingMarker(
    options.markerPath,
    options.projectId,
    options.workspaceId,
    options.store,
  );
  if (currentMarker) return { status: "already-migrated", marker: currentMarker };

  const manifest = migrationManifest(options);
  const jobId = randomUUID();
  let lease: LegacyLease | null = null;
  try {
    const result = await socketJson<{ lease: LegacyLease }>(
      options.brokerSocket,
      "POST",
      "/v1/leases",
      {
        projectId: options.projectId,
        action: "dry-run",
        jobId,
        integrations: manifest.integrations,
      },
    );
    lease = result.lease;
    if (
      !lease ||
      !JOB_ID.test(lease.id) ||
      lease.projectId !== options.projectId ||
      lease.jobId !== jobId ||
      !lease.environment ||
      typeof lease.environment !== "object" ||
      Array.isArray(lease.environment) ||
      !lease.gatewayTokens ||
      typeof lease.gatewayTokens !== "object" ||
      Array.isArray(lease.gatewayTokens)
    ) {
      throw new ProjectEnvironmentMigrationError("legacy broker returned an invalid migration lease");
    }
    if (Object.keys(lease.gatewayTokens).length > 0) {
      throw new ProjectEnvironmentMigrationError("gateway capabilities cannot be migrated into dotenv");
    }

    const document = options.store.ensure(
      options.projectId,
      options.workspaceId,
      options.bootstrapPath,
    );
    const current = parseProjectEnvironment(document.text);
    const additions = new Map<string, string>();
    for (const [name, value] of Object.entries(lease.environment).sort(([left], [right]) =>
      left.localeCompare(right))) {
      if (!VARIABLE.test(name) || typeof value !== "string" || /[\r\n\0]/.test(value)) {
        throw new ProjectEnvironmentMigrationError(`legacy broker returned invalid dotenv variable '${name}'`);
      }
      try {
        parseProjectEnvironment(`${name}=${quotedDotenvValue(value)}\n`);
      } catch (error) {
        if (error instanceof ProjectEnvironmentError) {
          throw new ProjectEnvironmentMigrationError(error.message);
        }
        throw error;
      }
      const existing = current.values.get(name);
      if (existing !== undefined && existing !== value) {
        throw new ProjectEnvironmentMigrationError(
          `encrypted environment already defines '${name}' with a different value`,
        );
      }
      if (existing === undefined) additions.set(name, value);
    }
    if (Object.keys(lease.environment).length === 0) {
      throw new ProjectEnvironmentMigrationError("legacy broker returned no runtime environment variables");
    }

    const suffix = additions.size === 0
      ? ""
      : `${document.text && !document.text.endsWith("\n") ? "\n" : ""}` +
        `${document.text ? "\n" : ""}# Migrated from legacy Connections\n` +
        [...additions].map(([name, value]) => `${name}=${quotedDotenvValue(value)}`).join("\n") +
        "\n";
    const saved = additions.size === 0
      ? document
      : options.store.save(
        options.projectId,
        options.workspaceId,
        `${document.text}${suffix}`,
        document.revision,
      );
    const marker: EnvironmentMigrationMarker = {
      version: 1,
      projectId: options.projectId,
      workspaceId: options.workspaceId,
      environmentRevision: saved.revision,
      integrationIds: manifest.ids,
      variableNames: Object.keys(lease.environment).sort(),
      migratedAt: new Date().toISOString(),
    };
    atomicPrivateJson(options.markerPath, marker);
    return { status: "migrated", marker };
  } finally {
    if (lease) {
      try {
        await socketJson(
          options.brokerSocket,
          "DELETE",
          `/v1/leases/${encodeURIComponent(lease.id)}`,
          { projectId: lease.projectId, jobId: lease.jobId },
        );
      } catch {
        // The broker expires runtime lease metadata automatically; migration data is already encrypted.
      }
      for (const name of Object.keys(lease.environment)) lease.environment[name] = "";
      for (const name of Object.keys(lease.gatewayTokens)) lease.gatewayTokens[name] = "";
    }
  }
}

function existingVerification(
  markerPath: string,
  projectId: string,
  workspaceId: string,
  revision: string,
  store: ProjectEnvironmentStore,
): EnvironmentVerificationMarker | null {
  if (!existsSync(markerPath)) return null;
  const marker = privateJson<EnvironmentVerificationMarker>(markerPath);
  if (
    marker.version !== 1 ||
    marker.projectId !== projectId ||
    marker.workspaceId !== workspaceId ||
    !/^[0-9a-f]{40}$/.test(marker.revision) ||
    !JOB_ID.test(marker.validateJobId) ||
    !JOB_ID.test(marker.dryRunJobId) ||
    marker.validateJobId === marker.dryRunJobId ||
    !Number.isSafeInteger(marker.environmentRevision) ||
    marker.environmentRevision <= 0
  ) {
    throw new ProjectEnvironmentMigrationError("environment verification marker is invalid");
  }
  const current = store.get(projectId, workspaceId);
  return marker.revision === revision && current.revision === marker.environmentRevision
    ? marker
    : null;
}

export function currentEnvironmentVerification(
  markerPath: string,
  projectId: string,
  workspaceId: string,
  revision: string,
  store: ProjectEnvironmentStore,
): EnvironmentVerificationMarker | null {
  validateScope(projectId, workspaceId);
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new ProjectEnvironmentMigrationError("migration verification revision is invalid");
  }
  return existingVerification(markerPath, projectId, workspaceId, revision, store);
}

export function recordEnvironmentMigrationVerification(
  options: RecordEnvironmentVerificationOptions,
): { status: "already-verified" | "verified"; marker: EnvironmentVerificationMarker } {
  validateScope(options.projectId, options.workspaceId);
  if (!/^[0-9a-f]{40}$/.test(options.revision)) {
    throw new ProjectEnvironmentMigrationError("migration verification revision is invalid");
  }
  const existing = existingVerification(
    options.markerPath,
    options.projectId,
    options.workspaceId,
    options.revision,
    options.store,
  );
  if (existing) return { status: "already-verified", marker: existing };

  const validate = options.validateJob;
  const dryRun = options.dryRunJob;
  for (const [action, job] of [["validate", validate], ["dry-run", dryRun]] as const) {
    if (
      !JOB_ID.test(job.id) ||
      job.projectId !== options.projectId ||
      job.workspaceId !== options.workspaceId ||
      job.action !== action ||
      job.revision !== options.revision ||
      job.status !== "completed"
    ) {
      throw new ProjectEnvironmentMigrationError(`${action} job cannot verify the environment migration`);
    }
  }
  if (
    !Number.isSafeInteger(validate.environmentRevision) ||
    validate.environmentRevision !== dryRun.environmentRevision
  ) {
    throw new ProjectEnvironmentMigrationError("verification jobs did not use one environment revision");
  }
  const current = options.store.get(options.projectId, options.workspaceId);
  if (current.revision !== validate.environmentRevision) {
    throw new ProjectEnvironmentMigrationError(
      "environment changed during migration verification; Validate and Dry run must be repeated",
    );
  }
  const marker: EnvironmentVerificationMarker = {
    version: 1,
    projectId: options.projectId,
    workspaceId: options.workspaceId,
    revision: options.revision,
    validateJobId: validate.id,
    dryRunJobId: dryRun.id,
    environmentRevision: validate.environmentRevision!,
    verifiedAt: new Date().toISOString(),
  };
  atomicPrivateJson(options.markerPath, marker);
  return { status: "verified", marker };
}
