import { existsSync, lstatSync, readFileSync } from "node:fs";

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);

export interface ProviderAuthentication {
  type: "bearer" | "header" | "none";
  credential: string;
  header: string;
  prefix: string;
}

export interface OAuthProviderConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecretFile: string;
  clientAuthentication: "basic" | "none" | "post";
  allowedScopes: string[];
  extraAuthorizationParameters: Record<string, string>;
}

export interface ProviderGatewayCapability {
  allowedMethods: string[];
  allowedPathPrefixes: string[];
}

export interface ProviderConfig {
  id: string;
  apiBaseUrl: string;
  allowedMethods: string[];
  allowedPathPrefixes: string[];
  gatewayCapabilities: Readonly<Record<string, ProviderGatewayCapability>>;
  authentication: ProviderAuthentication;
  oauth: OAuthProviderConfig | null;
}

function optionalValues(value: unknown, field: string, maximum = 64): string[] {
  if (value === undefined) return [];
  return values(value, field, maximum);
}

function parseGatewayCapabilities(
  value: unknown,
  field: string,
): Readonly<Record<string, ProviderGatewayCapability>> {
  if (value === undefined) return {};
  const raw = object(value, field);
  if (Object.keys(raw).length > 64) {
    throw new ProviderRegistryError(`${field} must contain at most 64 capabilities`);
  }
  const result: Record<string, ProviderGatewayCapability> = {};
  for (const [name, itemValue] of Object.entries(raw)) {
    if (!IDENTIFIER.test(name)) throw new ProviderRegistryError(`${field}.${name} has an invalid name`);
    const item = object(itemValue, `${field}.${name}`);
    const allowedMethods = values(
      item.allowedMethods,
      `${field}.${name}.allowedMethods`,
      6,
    ).map((method) => method.toUpperCase());
    if (allowedMethods.some((method) => !HTTP_METHODS.has(method))) {
      throw new ProviderRegistryError(`${field}.${name}.allowedMethods contains an unsupported method`);
    }
    const allowedPathPrefixes = values(
      item.allowedPathPrefixes,
      `${field}.${name}.allowedPathPrefixes`,
      64,
    );
    if (allowedPathPrefixes.some((path) =>
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("..") ||
      path.includes("?") ||
      path.includes("\\")
    )) {
      throw new ProviderRegistryError(`${field}.${name}.allowedPathPrefixes contains an unsafe path`);
    }
    result[name] = { allowedMethods, allowedPathPrefixes };
  }
  return result;
}

export class ProviderRegistryError extends Error {}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRegistryError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function secureUrl(value: unknown, field: string): string {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new ProviderRegistryError(`${field} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ProviderRegistryError(`${field} must be an HTTPS URL without credentials or fragment`);
  }
  return url.toString().replace(/\/$/, "");
}

function values(value: unknown, field: string, maximum = 64): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new ProviderRegistryError(`${field} must be a non-empty array with at most ${maximum} entries`);
  }
  const result = value.map((item) => String(item ?? "").trim());
  if (result.some((item) => !item || item.length > 256) || new Set(result).size !== result.length) {
    throw new ProviderRegistryError(`${field} contains an invalid or duplicate entry`);
  }
  return result;
}

function parseAuthentication(value: unknown, field: string): ProviderAuthentication {
  const raw = object(value, field);
  const type = String(raw.type ?? "") as ProviderAuthentication["type"];
  if (!(type === "bearer" || type === "header" || type === "none")) {
    throw new ProviderRegistryError(`${field}.type must be bearer, header, or none`);
  }
  const credential = String(raw.credential ?? (type === "bearer" ? "access_token" : "")).trim();
  const header = String(raw.header ?? (type === "bearer" ? "authorization" : "")).trim().toLowerCase();
  const prefix = String(raw.prefix ?? (type === "bearer" ? "Bearer " : "")).slice(0, 64);
  if (type !== "none") {
    if (!IDENTIFIER.test(credential) || !/^[a-z0-9-]{1,64}$/.test(header)) {
      throw new ProviderRegistryError(`${field} has an invalid credential or header name`);
    }
    if (
      ["connection", "content-length", "cookie", "host", "set-cookie", "transfer-encoding"].includes(header) ||
      header.startsWith("proxy-") ||
      !/^[\x20-\x7e]*$/.test(prefix)
    ) {
      throw new ProviderRegistryError(`${field} uses a forbidden authentication header or prefix`);
    }
  }
  return { type, credential, header, prefix };
}

function parseOAuth(value: unknown, field: string): OAuthProviderConfig | null {
  if (value === undefined) return null;
  const raw = object(value, field);
  const clientAuthentication = String(raw.clientAuthentication ?? "basic") as
    OAuthProviderConfig["clientAuthentication"];
  if (!(clientAuthentication === "basic" || clientAuthentication === "post" || clientAuthentication === "none")) {
    throw new ProviderRegistryError(`${field}.clientAuthentication must be basic, post, or none`);
  }
  const clientId = String(raw.clientId ?? "").trim();
  const clientSecretFile = String(raw.clientSecretFile ?? "").trim();
  if (!clientId || clientId.length > 512) throw new ProviderRegistryError(`${field}.clientId is required`);
  if (clientAuthentication !== "none" && !clientSecretFile.startsWith("/")) {
    throw new ProviderRegistryError(`${field}.clientSecretFile must be absolute`);
  }
  const allowedScopes = raw.allowedScopes === undefined ? [] : values(raw.allowedScopes, `${field}.allowedScopes`);
  const extraRaw = raw.extraAuthorizationParameters === undefined
    ? {}
    : object(raw.extraAuthorizationParameters, `${field}.extraAuthorizationParameters`);
  const extraAuthorizationParameters: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(extraRaw)) {
    const item = String(rawValue ?? "");
    if (!/^[A-Za-z0-9_.~-]{1,64}$/.test(name) || item.length > 512) {
      throw new ProviderRegistryError(`${field}.extraAuthorizationParameters is invalid`);
    }
    if (["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"].includes(name)) {
      throw new ProviderRegistryError(`${field}.extraAuthorizationParameters cannot override OAuth protocol fields`);
    }
    extraAuthorizationParameters[name] = item;
  }
  return {
    authorizationEndpoint: secureUrl(raw.authorizationEndpoint, `${field}.authorizationEndpoint`),
    tokenEndpoint: secureUrl(raw.tokenEndpoint, `${field}.tokenEndpoint`),
    clientId,
    clientSecretFile,
    clientAuthentication,
    allowedScopes,
    extraAuthorizationParameters,
  };
}

function parseProvider(id: string, value: unknown): ProviderConfig {
  if (!IDENTIFIER.test(id)) throw new ProviderRegistryError(`provider id '${id}' is invalid`);
  const field = `providers.${id}`;
  const raw = object(value, field);
  const methods = optionalValues(raw.allowedMethods, `${field}.allowedMethods`, 6).map((item) => item.toUpperCase());
  if (methods.some((method) => !HTTP_METHODS.has(method))) {
    throw new ProviderRegistryError(`${field}.allowedMethods contains an unsupported method`);
  }
  const pathPrefixes = optionalValues(raw.allowedPathPrefixes, `${field}.allowedPathPrefixes`, 64);
  if (pathPrefixes.some((path) =>
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("..") ||
    path.includes("?") ||
    path.includes("\\")
  )) {
    throw new ProviderRegistryError(`${field}.allowedPathPrefixes contains an unsafe path`);
  }
  return {
    id,
    apiBaseUrl: secureUrl(raw.apiBaseUrl, `${field}.apiBaseUrl`),
    allowedMethods: methods,
    allowedPathPrefixes: pathPrefixes,
    gatewayCapabilities: parseGatewayCapabilities(
      raw.gatewayCapabilities,
      `${field}.gatewayCapabilities`,
    ),
    authentication: parseAuthentication(raw.authentication, `${field}.authentication`),
    oauth: parseOAuth(raw.oauth, `${field}.oauth`),
  };
}

export class ProviderRegistry {
  private constructor(private readonly providers: ReadonlyMap<string, ProviderConfig>) {}

  static load(path: string): ProviderRegistry {
    if (!existsSync(path)) throw new ProviderRegistryError(`provider registry is missing: ${path}`);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_000_000) {
      throw new ProviderRegistryError("provider registry must be a regular JSON file under 1 MB");
    }
    let raw: Record<string, unknown>;
    try {
      raw = object(JSON.parse(readFileSync(path, "utf8")), "registry");
    } catch (error) {
      if (error instanceof ProviderRegistryError) throw error;
      throw new ProviderRegistryError(`provider registry is not valid JSON: ${String(error)}`);
    }
    const providersRaw = object(raw.providers, "providers");
    const providers = new Map<string, ProviderConfig>();
    for (const [id, value] of Object.entries(providersRaw)) providers.set(id, parseProvider(id, value));
    return new ProviderRegistry(providers);
  }

  static from(value: unknown): ProviderRegistry {
    const raw = object(value, "registry");
    const providersRaw = object(raw.providers, "providers");
    const providers = new Map<string, ProviderConfig>();
    for (const [id, item] of Object.entries(providersRaw)) providers.set(id, parseProvider(id, item));
    return new ProviderRegistry(providers);
  }

  provider(id: string): ProviderConfig {
    const provider = this.providers.get(id);
    if (!provider) throw new ProviderRegistryError(`provider '${id}' is not configured`);
    return provider;
  }

  all(): ProviderConfig[] {
    return [...this.providers.values()];
  }
}

export function readProviderClientSecret(provider: ProviderConfig): string {
  const path = provider.oauth?.clientSecretFile ?? "";
  if (!path) return "";
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 16_384 ||
    (metadata.mode & 0o007) !== 0
  ) {
    throw new ProviderRegistryError(`OAuth client secret file is invalid for '${provider.id}'`);
  }
  const secret = readFileSync(path, "utf8").trim();
  if (!secret) throw new ProviderRegistryError(`OAuth client secret is empty for '${provider.id}'`);
  return secret;
}
