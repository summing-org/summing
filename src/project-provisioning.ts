import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  isProjectEnvironmentVariable,
  parseProjectEnvironment,
  type ParsedEnvironment,
} from "./project-environment.js";

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MANIFEST_PATH = ".summing/provisioning.json";
const MAXIMUM_MANIFEST_BYTES = 128_000;
const MAXIMUM_RESULT_BYTES = 256_000;
const MAXIMUM_SECRET_BYTES = 65_536;

export interface ProvisioningOutput {
  name: string;
  environment: string;
  minimumLength: number;
  maximumLength: number;
}

export interface ProvisioningProfile {
  id: string;
  outputs: ProvisioningOutput[];
  consume: string[];
}

export interface ProvisioningResult {
  profile: string;
  secrets: ReadonlyMap<string, string>;
}

export class ProjectProvisioningError extends Error {}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectProvisioningError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const accepted = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !accepted.has(key));
  if (unsupported.length > 0) {
    throw new ProjectProvisioningError(`${field} contains unsupported fields: ${unsupported.join(", ")}`);
  }
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number") {
    throw new ProjectProvisioningError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new ProjectProvisioningError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function parseOutput(value: unknown, profileId: string, index: number): ProvisioningOutput {
  const field = `provisioning profile '${profileId}' output ${index + 1}`;
  const source = object(value, field);
  exactKeys(source, ["name", "environment", "minimumLength", "maximumLength"], field);
  const name = typeof source.name === "string" ? source.name : "";
  const environment = typeof source.environment === "string" ? source.environment : "";
  if (!SECRET_NAME.test(name)) {
    throw new ProjectProvisioningError(`${field} name is invalid`);
  }
  if (!isProjectEnvironmentVariable(environment)) {
    throw new ProjectProvisioningError(`${field} environment variable is invalid or runner-owned`);
  }
  const minimumLength = boundedInteger(
    source.minimumLength,
    1,
    1,
    MAXIMUM_SECRET_BYTES,
    `${field} minimumLength`,
  );
  const maximumLength = boundedInteger(
    source.maximumLength,
    MAXIMUM_SECRET_BYTES,
    1,
    MAXIMUM_SECRET_BYTES,
    `${field} maximumLength`,
  );
  if (minimumLength > maximumLength) {
    throw new ProjectProvisioningError(`${field} minimumLength exceeds maximumLength`);
  }
  return { name, environment, minimumLength, maximumLength };
}

function parseProfile(value: unknown, index: number): ProvisioningProfile {
  const field = `provisioning profile ${index + 1}`;
  const source = object(value, field);
  exactKeys(source, ["id", "outputs", "consume"], field);
  const id = typeof source.id === "string" ? source.id : "";
  if (!PROFILE_ID.test(id)) throw new ProjectProvisioningError(`${field} id is invalid`);
  if (!Array.isArray(source.outputs) || source.outputs.length === 0 || source.outputs.length > 32) {
    throw new ProjectProvisioningError(`provisioning profile '${id}' must declare 1-32 outputs`);
  }
  const outputs = source.outputs.map((output, outputIndex) => parseOutput(output, id, outputIndex));
  if (new Set(outputs.map((output) => output.name)).size !== outputs.length) {
    throw new ProjectProvisioningError(`provisioning profile '${id}' has duplicate output names`);
  }
  if (new Set(outputs.map((output) => output.environment)).size !== outputs.length) {
    throw new ProjectProvisioningError(`provisioning profile '${id}' has duplicate output variables`);
  }
  const rawConsume = source.consume ?? [];
  if (!Array.isArray(rawConsume) || rawConsume.length > 32) {
    throw new ProjectProvisioningError(`provisioning profile '${id}' consume must contain at most 32 variables`);
  }
  const consume = rawConsume.map((value) => typeof value === "string" ? value : "");
  if (consume.some((name) => !isProjectEnvironmentVariable(name))) {
    throw new ProjectProvisioningError(
      `provisioning profile '${id}' consumes an invalid or runner-owned variable`,
    );
  }
  if (new Set(consume).size !== consume.length) {
    throw new ProjectProvisioningError(`provisioning profile '${id}' has duplicate consumed variables`);
  }
  const outputVariables = new Set(outputs.map((output) => output.environment));
  if (consume.some((name) => outputVariables.has(name))) {
    throw new ProjectProvisioningError(
      `provisioning profile '${id}' cannot consume an output variable`,
    );
  }
  return { id, outputs, consume };
}

function privateRegularFile(path: string, maximumBytes: number, field: string): void {
  if (!existsSync(path)) throw new ProjectProvisioningError(`${field} is missing`);
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes
  ) {
    throw new ProjectProvisioningError(`${field} must be one bounded regular file`);
  }
}

export function readProvisioningProfile(sourceRoot: string, profileId: string): ProvisioningProfile {
  if (!PROFILE_ID.test(profileId)) throw new ProjectProvisioningError("provisioning profile id is invalid");
  const root = realpathSync(sourceRoot);
  const path = resolve(root, MANIFEST_PATH);
  privateRegularFile(path, MAXIMUM_MANIFEST_BYTES, "provisioning manifest");
  if (realpathSync(path) !== path) {
    throw new ProjectProvisioningError("provisioning manifest must not traverse symlinks");
  }
  let source: Record<string, unknown>;
  try {
    source = object(JSON.parse(readFileSync(path, "utf8")), "provisioning manifest");
  } catch (error) {
    if (error instanceof ProjectProvisioningError) throw error;
    throw new ProjectProvisioningError("provisioning manifest is malformed");
  }
  exactKeys(source, ["version", "profiles"], "provisioning manifest");
  if (source.version !== 1) {
    throw new ProjectProvisioningError("provisioning manifest version is unsupported");
  }
  if (!Array.isArray(source.profiles) || source.profiles.length === 0 || source.profiles.length > 64) {
    throw new ProjectProvisioningError("provisioning manifest must declare 1-64 profiles");
  }
  const profiles = source.profiles.map(parseProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new ProjectProvisioningError("provisioning manifest has duplicate profile ids");
  }
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new ProjectProvisioningError(`provisioning profile '${profileId}' was not found`);
  return profile;
}

export function readProvisioningResult(path: string, profile: ProvisioningProfile): ProvisioningResult {
  privateRegularFile(path, MAXIMUM_RESULT_BYTES, "provisioning result");
  const metadata = lstatSync(path);
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new ProjectProvisioningError("provisioning result must have mode 0600");
  }
  let source: Record<string, unknown>;
  try {
    source = object(JSON.parse(readFileSync(path, "utf8")), "provisioning result");
  } catch (error) {
    if (error instanceof ProjectProvisioningError) throw error;
    throw new ProjectProvisioningError("provisioning result is malformed");
  }
  exactKeys(source, ["version", "profile", "secrets"], "provisioning result");
  if (source.version !== 1 || source.profile !== profile.id) {
    throw new ProjectProvisioningError("provisioning result does not match the selected profile");
  }
  const rawSecrets = object(source.secrets, "provisioning result secrets");
  const expectedNames = new Set(profile.outputs.map((output) => output.name));
  const actualNames = Object.keys(rawSecrets);
  if (
    actualNames.length !== expectedNames.size ||
    actualNames.some((name) => !expectedNames.has(name))
  ) {
    throw new ProjectProvisioningError("provisioning result secret names do not match the manifest");
  }
  const secrets = new Map<string, string>();
  for (const output of profile.outputs) {
    const secret = rawSecrets[output.name];
    if (typeof secret !== "string" || /[\0\r\n]/.test(secret)) {
      throw new ProjectProvisioningError(`provisioning output '${output.name}' is not a single-line string`);
    }
    const bytes = Buffer.byteLength(secret);
    if (bytes < output.minimumLength || bytes > output.maximumLength) {
      throw new ProjectProvisioningError(
        `provisioning output '${output.name}' must contain ${output.minimumLength}-${output.maximumLength} bytes`,
      );
    }
    secrets.set(output.name, secret);
  }
  return { profile: profile.id, secrets };
}

function assignmentName(line: string): string | null {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match?.[1] ?? null;
}

function encodedValue(value: string): string {
  return JSON.stringify(value);
}

export function provisionedEnvironmentText(
  currentText: string,
  baseline: ParsedEnvironment,
  profile: ProvisioningProfile,
  secrets: ReadonlyMap<string, string>,
): string {
  const current = parseProjectEnvironment(currentText);
  const affected = new Set([
    ...profile.outputs.map((output) => output.environment),
    ...profile.consume,
  ]);
  for (const name of affected) {
    if (current.values.get(name) !== baseline.values.get(name)) {
      throw new ProjectProvisioningError(
        `project environment variable '${name}' changed while provisioning was running`,
      );
    }
  }
  const replacements = new Map(
    profile.outputs.map((output) => [output.environment, secrets.get(output.name)!]),
  );
  const consumed = new Set(profile.consume);
  const written = new Set<string>();
  const lines: string[] = [];
  for (const line of currentText.replace(/\r\n?/g, "\n").split("\n")) {
    const name = assignmentName(line);
    if (name && consumed.has(name)) continue;
    if (name && replacements.has(name)) {
      if (!written.has(name)) {
        lines.push(`${name}=${encodedValue(replacements.get(name)!)}`);
        written.add(name);
      }
      continue;
    }
    lines.push(line);
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  for (const [name, value] of replacements) {
    if (!written.has(name)) lines.push(`${name}=${encodedValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}
