import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
} from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { basename, isAbsolute } from "node:path";
import {
  verifyConnectionTicket,
  type ConnectionTicketPayload,
} from "./connection-ticket.js";
import {
  parseIntegrationManifest,
  type IntegrationAction,
  type IntegrationDeclaration,
} from "./integration-manifest.js";
import {
  ProviderRegistry,
  ProviderRegistryError,
  readProviderClientSecret,
  type ProviderConfig,
} from "./provider-registry.js";
import {
  SECRET_BROKER_CSS,
  SECRET_BROKER_HTML,
  SECRET_BROKER_JS,
} from "./secret-broker-assets.js";
import type {
  IntegrationModeOptions,
  SecretLease,
  SecretLeaseRequest,
} from "./secret-broker-client.js";
import {
  SecretVault,
  SecretVaultError,
  type RawGrant,
  type SecretCredentials,
  type StoredConnection,
} from "./secret-vault.js";

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOB_ID = /^[0-9a-f-]{36}$/;
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

interface GatewayCapability {
  token: string;
  leaseId: string;
  projectId: string;
  jobId: string;
  integration: IntegrationDeclaration;
  expiresAt: number;
}

interface RuntimeLeaseState {
  projectId: string;
  jobId: string;
  expiresAt: number;
  gatewayTokens: string[];
}

interface OAuthState {
  payload: ConnectionTicketPayload;
  verifier: string;
  expiresAt: number;
}

export interface SecretBrokerServerOptions {
  publicHost: string;
  publicPort: number;
  publicUrl: string;
  controlSocket: string;
  runtimeSocket: string;
  gatewaySocket: string;
  controlGroupId?: number;
  runtimeGroupId?: number;
  ticketPublicKey: string | Buffer;
  providers: ProviderRegistry;
  vault: SecretVault;
}

class BrokerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function asset(response: ServerResponse, contentType: string, body: string): void {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function bodyBuffer(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new BrokerHttpError(413, "request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(request: IncomingMessage, maximumBytes = 1_000_000): Promise<unknown> {
  const body = await bodyBuffer(request, maximumBytes);
  try {
    return JSON.parse(body.toString("utf8") || "null");
  } catch {
    throw new BrokerHttpError(400, "request body must be JSON");
  } finally {
    body.fill(0);
  }
}

async function boundedResponseBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new BrokerHttpError(502, "provider response exceeds 12 MB");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        chunk.fill(0);
        await reader.cancel();
        throw new BrokerHttpError(502, "provider response exceeds 12 MB");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function pathWithin(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === normalized || path.startsWith(`${normalized}/`);
}

function bearer(headers: IncomingHttpHeaders): string {
  const authorization = String(headers.authorization ?? "");
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function connectionKey(integration: IntegrationDeclaration): string {
  return `${integration.id}@${integration.environment}`;
}

function rawGrant(value: unknown): RawGrant {
  if (value === "once" || value === "project") return value;
  throw new BrokerHttpError(400, "raw access requires an explicit once or project grant");
}

function exactTicket(
  publicKey: string | Buffer,
  headers: IncomingHttpHeaders,
): ConnectionTicketPayload {
  const token = bearer(headers);
  if (!token || token.length > 32_000) throw new BrokerHttpError(401, "connection ticket is missing");
  let payload: ConnectionTicketPayload;
  try {
    payload = verifyConnectionTicket(publicKey, token);
    payload.integration = parseIntegrationManifest({
      version: 1,
      integrations: [payload.integration],
    }).integrations[0]!;
  } catch (error) {
    throw new BrokerHttpError(401, error instanceof Error ? error.message : "connection ticket is invalid");
  }
  return payload;
}

function safeSocket(path: string): void {
  if (!isAbsolute(path) || basename(path) === "") throw new Error("broker socket path must be absolute");
  if (!existsSync(path)) return;
  const metadata = lstatSync(path);
  if (!metadata.isSocket()) throw new Error(`refusing to replace non-socket ${path}`);
  rmSync(path);
}

function htmlMessage(response: ServerResponse, ok: boolean): void {
  const title = ok ? "Подключение готово" : "Подключение не выполнено";
  const detail = ok
    ? "OAuth credentials зашифрованы. Можно закрыть окно и вернуться в SUMMING."
    : "OAuth provider отклонил запрос или одноразовый state истёк. Откройте Connections заново.";
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui;background:#0a0a0c;color:#eee;padding:32px}main{max-width:620px;margin:auto}h1{color:${ok ? "#8ed6bd" : "#ff759b"}}p{color:#aaa;line-height:1.55}</style><main><h1>${title}</h1><p>${detail}</p></main>`;
  response.writeHead(ok ? 200 : 400, {
    ...SECURITY_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

export class SecretBrokerServer {
  private publicServer: Server | null = null;
  private controlServer: Server | null = null;
  private runtimeServer: Server | null = null;
  private gatewayServer: Server | null = null;
  private readonly gatewayCapabilities = new Map<string, GatewayCapability>();
  private readonly runtimeLeases = new Map<string, RuntimeLeaseState>();
  private readonly oauthStates = new Map<string, OAuthState>();

  constructor(readonly options: SecretBrokerServerOptions) {
    for (const path of [options.controlSocket, options.runtimeSocket, options.gatewaySocket]) {
      if (!isAbsolute(path)) throw new Error("secret broker sockets must be absolute");
    }
    const publicUrl = new URL(options.publicUrl);
    if (publicUrl.protocol !== "https:" && publicUrl.hostname !== "127.0.0.1" && publicUrl.hostname !== "localhost") {
      throw new Error("secret broker public URL must use HTTPS");
    }
  }

  async start(): Promise<void> {
    if (this.publicServer) return;
    this.publicServer = createServer((request, response) => {
      void this.routePublic(request, response).catch((error) => this.report(response, error));
    });
    this.controlServer = createServer((request, response) => {
      void this.routeControl(request, response).catch((error) => this.report(response, error));
    });
    this.runtimeServer = createServer((request, response) => {
      void this.routeRuntime(request, response).catch((error) => this.report(response, error));
    });
    this.gatewayServer = createServer((request, response) => {
      void this.routeGateway(request, response).catch((error) => this.report(response, error));
    });
    try {
      await this.listenTcp(this.publicServer, this.options.publicHost, this.options.publicPort);
      await this.listenSocket(
        this.controlServer,
        this.options.controlSocket,
        this.options.controlGroupId,
      );
      await this.listenSocket(
        this.runtimeServer,
        this.options.runtimeSocket,
        this.options.runtimeGroupId,
      );
      await this.listenSocket(
        this.gatewayServer,
        this.options.gatewaySocket,
        this.options.runtimeGroupId,
      );
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const servers = [this.publicServer, this.controlServer, this.runtimeServer, this.gatewayServer];
    this.publicServer = null;
    this.controlServer = null;
    this.runtimeServer = null;
    this.gatewayServer = null;
    await Promise.all(servers.filter((server): server is Server => server !== null).map(async (server) => {
      if (!server.listening) return;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }));
    for (const path of [this.options.controlSocket, this.options.runtimeSocket, this.options.gatewaySocket]) {
      if (existsSync(path) && lstatSync(path).isSocket()) rmSync(path);
    }
    this.gatewayCapabilities.clear();
    this.runtimeLeases.clear();
    this.oauthStates.clear();
  }

  private async listenTcp(server: Server, host: string, port: number): Promise<void> {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolveListen();
      });
    });
  }

  private async listenSocket(server: Server, path: string, groupId?: number): Promise<void> {
    safeSocket(path);
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        chmodSync(path, 0o660);
        if (groupId !== undefined) chownSync(path, process.getuid?.() ?? 0, groupId);
        resolveListen();
      });
    });
  }

  private async routePublic(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://broker.local");
    if (request.method === "GET" && (url.pathname === "/connections" || url.pathname === "/connections/")) {
      asset(response, "text/html; charset=utf-8", SECRET_BROKER_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/connections/app.css") {
      asset(response, "text/css; charset=utf-8", SECRET_BROKER_CSS);
      return;
    }
    if (request.method === "GET" && url.pathname === "/connections/app.js") {
      asset(response, "text/javascript; charset=utf-8", SECRET_BROKER_JS);
      return;
    }
    if (request.method === "GET" && url.pathname === "/connections/oauth/callback") {
      await this.oauthCallback(url, response);
      return;
    }
    if (!url.pathname.startsWith("/connections/api/")) throw new BrokerHttpError(404, "not found");
    const payload = exactTicket(this.options.ticketPublicKey, request.headers);
    if (request.method === "GET" && url.pathname === "/connections/api/session") {
      const current = this.options.vault.getSummary(
        payload.projectId,
        payload.integration.id,
        payload.integration.environment,
      );
      json(response, 200, {
        projectId: payload.projectId,
        integration: payload.integration,
        connection: payload.integration.auth === "none"
          ? { status: "connected", version: 0, fingerprint: "" }
          : current,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/connections/api/secret") {
      await this.storeApiKey(payload, request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/connections/api/revoke") {
      this.options.vault.consumeTicket(payload.jti, payload.expiresAt);
      const connection = this.options.vault.revoke(
        payload.projectId,
        payload.integration.id,
        payload.integration.environment,
        payload.userId,
      );
      json(response, 200, { connection });
      return;
    }
    if (request.method === "POST" && url.pathname === "/connections/api/raw-grant") {
      if (payload.integration.mode !== "raw") throw new BrokerHttpError(400, "ticket is not for raw access");
      const body = await jsonBody(request) as Record<string, unknown> | null;
      const grant = rawGrant(body?.grant);
      this.options.vault.consumeTicket(payload.jti, payload.expiresAt);
      const connection = this.options.vault.authorizeRaw(
        payload.projectId,
        payload.integration.id,
        payload.integration.environment,
        payload.userId,
        grant,
      );
      json(response, 200, { connection });
      return;
    }
    if (request.method === "POST" && url.pathname === "/connections/api/oauth/start") {
      const authorizationUrl = this.startOAuth(payload);
      json(response, 200, { authorizationUrl });
      return;
    }
    throw new BrokerHttpError(404, "not found");
  }

  private async routeControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://control.local");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/connections") {
      const projectId = url.searchParams.get("project") ?? "";
      if (!PROJECT_ID.test(projectId)) throw new BrokerHttpError(400, "invalid project id");
      json(response, 200, { connections: this.options.vault.list(projectId) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/modes") {
      const raw = await jsonBody(request) as Record<string, unknown> | null;
      const integrations = parseIntegrationManifest({
        version: 1,
        integrations: raw?.integrations,
      }).integrations;
      json(response, 200, { modes: this.modeOptions(integrations) });
      return;
    }
    throw new BrokerHttpError(404, "not found");
  }

  private async routeRuntime(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://runtime.local");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/leases") {
      const lease = await this.createLease(await jsonBody(request) as SecretLeaseRequest);
      json(response, 201, { lease });
      return;
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/v1/leases/")) {
      const leaseId = decodeURIComponent(url.pathname.slice("/v1/leases/".length));
      if (!/^[0-9a-f-]{36}$/.test(leaseId)) throw new BrokerHttpError(400, "invalid lease id");
      const body = await jsonBody(request, 16_384) as Record<string, unknown> | null;
      const state = this.runtimeLeases.get(leaseId);
      if (
        !state ||
        state.projectId !== body?.projectId ||
        state.jobId !== body?.jobId
      ) {
        throw new BrokerHttpError(404, "runtime lease not found");
      }
      for (const token of state.gatewayTokens) this.gatewayCapabilities.delete(token);
      this.runtimeLeases.delete(leaseId);
      response.writeHead(204, { ...SECURITY_HEADERS, "cache-control": "no-store" });
      response.end();
      return;
    }
    throw new BrokerHttpError(404, "not found");
  }

  private async routeGateway(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://gateway.local");
    if (!url.pathname.startsWith("/v1/proxy/")) throw new BrokerHttpError(404, "not found");
    const token = bearer(request.headers);
    const capability = this.gatewayCapabilities.get(token);
    const now = Date.now() / 1_000;
    if (!capability || capability.expiresAt < now) {
      if (token) this.gatewayCapabilities.delete(token);
      throw new BrokerHttpError(401, "gateway capability is invalid or expired");
    }
    const key = decodeURIComponent(url.pathname.slice("/v1/proxy/".length).split("/", 1)[0] ?? "");
    if (key !== connectionKey(capability.integration)) {
      throw new BrokerHttpError(403, "gateway capability does not cover this integration");
    }
    const prefix = `/v1/proxy/${encodeURIComponent(key)}`;
    const outboundPath = url.pathname.slice(prefix.length) || "/";
    await this.proxyProvider(capability, request, response, outboundPath, url.search);
  }

  private ticketProvider(payload: ConnectionTicketPayload): ProviderConfig {
    const provider = this.options.providers.provider(payload.integration.provider);
    this.validateProvider(payload.integration, provider);
    return provider;
  }

  private modeOptions(integrations: IntegrationDeclaration[]): IntegrationModeOptions[] {
    return integrations.map((integration) => {
      const provider = this.options.providers.provider(integration.provider);
      const supported: IntegrationModeOptions["supported"] = [];
      const authCompatible = integration.auth === "none"
        ? provider.authentication.type === "none"
        : integration.auth === "api_key"
          ? provider.authentication.type === "none" || integration.secrets.some((secret) =>
            secret.name === provider.authentication.credential,
          )
          : Boolean(
            provider.oauth &&
            provider.authentication.credential === "access_token" &&
            integration.scopes.every((scope) => provider.oauth!.allowedScopes.includes(scope)),
          );
      const gatewayAvailable = integration.capabilities.length > 0 &&
        authCompatible &&
        integration.capabilities.every((capability) => provider.gatewayCapabilities[capability]);
      if (gatewayAvailable) supported.push("gateway");
      if (integration.auth === "oauth2" && authCompatible) supported.push("lease");
      if (integration.auth === "api_key" && authCompatible) supported.push("raw");
      if (supported.length === 0 && integration.auth === "none" && gatewayAvailable) {
        supported.push("gateway");
      }
      if (supported.length === 0) {
        throw new BrokerHttpError(409, `provider '${provider.id}' has no supported access mode`);
      }
      return {
        integrationId: integration.id,
        environment: integration.environment,
        requested: integration.mode,
        supported,
        recommended: supported.includes("gateway")
          ? "gateway"
          : supported.includes("lease")
            ? "lease"
            : "raw",
      };
    });
  }

  private validateProvider(integration: IntegrationDeclaration, provider: ProviderConfig): void {
    if (integration.auth === "oauth2" && !provider.oauth) {
      throw new BrokerHttpError(400, `provider '${provider.id}' does not support OAuth`);
    }
    if (integration.mode === "lease" && !provider.oauth) {
      throw new BrokerHttpError(400, `provider '${provider.id}' cannot issue OAuth leases`);
    }
    if (integration.auth === "none" && provider.authentication.type !== "none") {
      throw new BrokerHttpError(400, `provider '${provider.id}' requires credentials`);
    }
    if (integration.auth === "api_key" && provider.authentication.type !== "none") {
      if (!integration.secrets.some((field) => field.name === provider.authentication.credential)) {
        throw new BrokerHttpError(400, "provider authentication credential is not declared");
      }
    }
    if (integration.auth === "oauth2" && provider.authentication.credential !== "access_token") {
      throw new BrokerHttpError(400, "OAuth provider must authenticate with access_token");
    }
    if (integration.auth === "oauth2" && provider.oauth) {
      if (integration.scopes.some((scope) => !provider.oauth!.allowedScopes.includes(scope))) {
        throw new BrokerHttpError(400, "integration requests an OAuth scope outside provider policy");
      }
    }
    if (integration.mode === "gateway") {
      const unsupported = integration.capabilities.filter((capability) =>
        !provider.gatewayCapabilities[capability],
      );
      if (unsupported.length > 0) {
        throw new BrokerHttpError(
          400,
          `provider '${provider.id}' has no SUMMING gateway capability: ${unsupported.join(", ")}`,
        );
      }
      const policy = integration.gateway!;
      const capabilityPolicies = integration.capabilities.map((capability) =>
        provider.gatewayCapabilities[capability]!,
      );
      if (
        policy.methods.some((method) =>
          !capabilityPolicies.some((capability) => capability.allowedMethods.includes(method)),
        )
      ) {
        throw new BrokerHttpError(400, "integration HTTP method exceeds its named gateway capabilities");
      }
      if (
        policy.pathPrefixes.some((path) =>
          !capabilityPolicies.some((capability) =>
            capability.allowedPathPrefixes.some((trusted) => pathWithin(path, trusted)),
          ),
        )
      ) {
        throw new BrokerHttpError(400, "integration path exceeds its named gateway capabilities");
      }
      if (policy.methods.some((method) => !provider.allowedMethods.includes(method))) {
        throw new BrokerHttpError(400, "integration HTTP method exceeds provider policy");
      }
      if (
        policy.pathPrefixes.some((path) =>
          !provider.allowedPathPrefixes.some((trusted) => pathWithin(path, trusted)),
        )
      ) {
        throw new BrokerHttpError(400, "integration path exceeds provider policy");
      }
    }
  }

  private async storeApiKey(
    payload: ConnectionTicketPayload,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (payload.integration.auth !== "api_key") throw new BrokerHttpError(400, "ticket is not for an API key");
    this.ticketProvider(payload);
    const raw = await jsonBody(request) as Record<string, unknown> | null;
    const values = raw?.values;
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      throw new BrokerHttpError(400, "values must be an object");
    }
    const declared = new Set(payload.integration.secrets.map((field) => field.name));
    const credentials: SecretCredentials = {};
    for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
      if (!declared.has(name) || typeof value !== "string" || !value || value.length > 262_144) {
        throw new BrokerHttpError(400, "secret fields do not match the integration declaration");
      }
      credentials[name] = value;
    }
    if ([...declared].some((name) => !(name in credentials))) {
      throw new BrokerHttpError(400, "one or more required secret fields are missing");
    }
    const first = String(credentials[payload.integration.secrets[0]!.name]);
    const fingerprint = first.length >= 4 ? `…${first.slice(-4)}` : "configured";
    const grant = payload.integration.mode === "raw" ? rawGrant(raw?.grant) : null;
    if (payload.integration.mode !== "raw" && raw?.grant !== undefined) {
      throw new BrokerHttpError(400, "raw grant is allowed only for raw-mode integrations");
    }
    try {
      this.options.vault.consumeTicket(payload.jti, payload.expiresAt);
      const connection = this.options.vault.put({
        projectId: payload.projectId,
        integrationId: payload.integration.id,
        environment: payload.integration.environment,
        provider: payload.integration.provider,
        auth: payload.integration.auth,
        scopes: payload.integration.scopes,
        createdBy: payload.userId,
        fingerprint,
        rawGrant: grant,
      }, credentials);
      json(response, 201, { connection });
    } finally {
      for (const name of Object.keys(credentials)) credentials[name] = "";
    }
  }

  private startOAuth(payload: ConnectionTicketPayload): string {
    if (payload.integration.auth !== "oauth2") throw new BrokerHttpError(400, "ticket is not for OAuth");
    if (!(payload.integration.mode === "lease" || payload.integration.mode === "gateway")) {
      throw new BrokerHttpError(400, "OAuth supports lease or gateway mode only");
    }
    const provider = this.ticketProvider(payload);
    const oauth = provider.oauth!;
    this.options.vault.consumeTicket(payload.jti, payload.expiresAt);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const expiresAt = Math.min(payload.expiresAt, Math.floor(Date.now() / 1_000) + 600);
    this.oauthStates.set(state, { payload, verifier, expiresAt });
    const target = new URL(oauth.authorizationEndpoint);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("client_id", oauth.clientId);
    target.searchParams.set("redirect_uri", `${this.options.publicUrl.replace(/\/$/, "")}/connections/oauth/callback`);
    target.searchParams.set("state", state);
    target.searchParams.set("code_challenge", challenge);
    target.searchParams.set("code_challenge_method", "S256");
    if (payload.integration.scopes.length) target.searchParams.set("scope", payload.integration.scopes.join(" "));
    for (const [name, value] of Object.entries(oauth.extraAuthorizationParameters)) {
      target.searchParams.set(name, value);
    }
    return target.toString();
  }

  private async oauthCallback(url: URL, response: ServerResponse): Promise<void> {
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const pending = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    if (!code || code.length > 8_192 || !pending || pending.expiresAt < Date.now() / 1_000) {
      htmlMessage(response, false);
      return;
    }
    try {
      const provider = this.ticketProvider(pending.payload);
      const credentials = await this.exchangeOAuth(provider, {
        grant_type: "authorization_code",
        code,
        redirect_uri: `${this.options.publicUrl.replace(/\/$/, "")}/connections/oauth/callback`,
        code_verifier: pending.verifier,
      });
      const expiresAt = typeof credentials.expires_at === "number" ? credentials.expires_at : null;
      try {
        this.options.vault.put({
          projectId: pending.payload.projectId,
          integrationId: pending.payload.integration.id,
          environment: pending.payload.integration.environment,
          provider: pending.payload.integration.provider,
          auth: "oauth2",
          scopes: pending.payload.integration.scopes,
          createdBy: pending.payload.userId,
          expiresAt,
          fingerprint: "OAuth",
        }, credentials);
      } finally {
        for (const name of Object.keys(credentials)) credentials[name] = "";
      }
      htmlMessage(response, true);
    } catch {
      htmlMessage(response, false);
    } finally {
      pending.verifier = "";
    }
  }

  private async createLease(raw: SecretLeaseRequest): Promise<SecretLease> {
    if (!PROJECT_ID.test(String(raw?.projectId ?? ""))) throw new BrokerHttpError(400, "invalid project id");
    if (!JOB_ID.test(String(raw?.jobId ?? ""))) throw new BrokerHttpError(400, "invalid job id");
    if (!(raw.action === "dry-run" || raw.action === "run")) throw new BrokerHttpError(400, "invalid lease action");
    const integrations = parseIntegrationManifest({
      version: 1,
      integrations: raw.integrations,
    }).integrations.filter((integration) => integration.actions.includes(raw.action));
    const now = Math.floor(Date.now() / 1_000);
    const expiresAt = now + (raw.action === "run" ? 14_400 : 1_800);
    const lease: SecretLease = {
      id: randomUUID(),
      projectId: raw.projectId,
      jobId: raw.jobId,
      expiresAt,
      environment: {},
      gatewayTokens: {},
    };
    const createdCapabilities: string[] = [];
    try {
      for (const integration of integrations) {
      const provider = this.options.providers.provider(integration.provider);
      this.validateProvider(integration, provider);
      let stored: StoredConnection | null = null;
      try {
        if (integration.auth !== "none") {
          stored = this.options.vault.get(raw.projectId, integration.id, integration.environment);
          if (stored.summary.provider !== integration.provider || stored.summary.auth !== integration.auth) {
            throw new BrokerHttpError(409, `connection ${connectionKey(integration)} does not match manifest`);
          }
          if (integration.scopes.some((scope) => !stored!.summary.scopes.includes(scope))) {
            throw new BrokerHttpError(409, `connection ${connectionKey(integration)} lacks required scopes`);
          }
          if (integration.mode === "lease" && integration.auth === "oauth2") {
            stored = await this.refreshOAuthIfNeeded(stored, provider);
          }
        }
        const key = connectionKey(integration);
        if (integration.mode === "gateway") {
          const token = randomBytes(32).toString("base64url");
          this.gatewayCapabilities.set(token, {
            token,
            leaseId: lease.id,
            projectId: raw.projectId,
            jobId: raw.jobId,
            integration,
            expiresAt,
          });
          createdCapabilities.push(token);
          lease.gatewayTokens[key] = token;
          if (stored) this.options.vault.markUsed(stored.summary, raw.jobId);
          continue;
        }
        if (!stored) throw new BrokerHttpError(409, `connection ${key} has no credential`);
        if (integration.mode === "raw") {
          this.options.vault.consumeRawGrant(stored.summary, raw.jobId);
        } else {
          this.options.vault.markUsed(stored.summary, raw.jobId);
          const credentialExpiry = Number(stored.credentials.expires_at ?? stored.summary.expiresAt ?? 0);
          if (credentialExpiry > 0) lease.expiresAt = Math.min(lease.expiresAt, credentialExpiry);
        }
        for (const output of integration.runtime) {
          const value = stored.credentials[output.name];
          const runtimeValue = String(value ?? "");
          if (
            (typeof value !== "string" && typeof value !== "number") ||
            /[\r\n\0]/.test(runtimeValue) ||
            Buffer.byteLength(runtimeValue) > 65_536
          ) {
            throw new BrokerHttpError(409, `connection ${key} cannot provide runtime credential '${output.name}'`);
          }
          lease.environment[output.env] = runtimeValue;
        }
      } finally {
        if (stored) {
          for (const name of Object.keys(stored.credentials)) stored.credentials[name] = "";
        }
      }
      }
    } catch (error) {
      for (const name of Object.keys(lease.environment)) lease.environment[name] = "";
      for (const name of Object.keys(lease.gatewayTokens)) lease.gatewayTokens[name] = "";
      for (const token of createdCapabilities) this.gatewayCapabilities.delete(token);
      throw error;
    }
    this.runtimeLeases.set(lease.id, {
      projectId: lease.projectId,
      jobId: lease.jobId,
      expiresAt: lease.expiresAt,
      gatewayTokens: createdCapabilities,
    });
    this.pruneCapabilities(now);
    return lease;
  }

  private pruneCapabilities(now: number): void {
    for (const [token, capability] of this.gatewayCapabilities) {
      if (capability.expiresAt < now) this.gatewayCapabilities.delete(token);
    }
    for (const [state, pending] of this.oauthStates) {
      if (pending.expiresAt < now) {
        pending.verifier = "";
        this.oauthStates.delete(state);
      }
    }
    for (const [leaseId, lease] of this.runtimeLeases) {
      if (lease.expiresAt < now) this.runtimeLeases.delete(leaseId);
    }
  }

  private async proxyProvider(
    capability: GatewayCapability,
    request: IncomingMessage,
    response: ServerResponse,
    outboundPath: string,
    query: string,
  ): Promise<void> {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(outboundPath);
    } catch {
      throw new BrokerHttpError(400, "gateway path is malformed");
    }
    if (!decodedPath.startsWith("/") || decodedPath.startsWith("//") || decodedPath.includes("..") || decodedPath.includes("\\")) {
      throw new BrokerHttpError(400, "gateway path is unsafe");
    }
    const integration = capability.integration;
    const method = String(request.method ?? "GET").toUpperCase();
    if (!integration.gateway!.methods.includes(method)) throw new BrokerHttpError(403, "HTTP method is outside capability");
    if (!integration.gateway!.pathPrefixes.some((prefix) => pathWithin(decodedPath, prefix))) {
      throw new BrokerHttpError(403, "URL path is outside capability");
    }
    const provider = this.options.providers.provider(integration.provider);
    this.validateProvider(integration, provider);
    let stored: StoredConnection | null = null;
    if (integration.auth !== "none") {
      stored = this.options.vault.get(capability.projectId, integration.id, integration.environment);
      if (integration.auth === "oauth2") stored = await this.refreshOAuthIfNeeded(stored, provider);
    }
    const target = new URL(provider.apiBaseUrl);
    target.pathname = `${target.pathname.replace(/\/$/, "")}${decodedPath}`;
    target.search = query;
    const headers = new Headers();
    for (const [name, raw] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (
        lower === "accept" ||
        lower === "content-type" ||
        lower === "idempotency-key" ||
        lower === "user-agent"
      ) {
        headers.set(lower, Array.isArray(raw) ? raw.join(",") : String(raw ?? ""));
      }
    }
    const auth = provider.authentication;
    if (auth.type !== "none") {
      const credential = stored?.credentials[auth.credential];
      if (typeof credential !== "string" || !credential) throw new BrokerHttpError(409, "provider credential is unavailable");
      headers.set(auth.header, `${auth.prefix}${credential}`);
    }
    const body = method === "GET" || method === "HEAD" ? undefined : await bodyBuffer(request, 8_000_000);
    let upstream: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      };
      if (body) init.body = new Uint8Array(body);
      upstream = await fetch(target, init);
    } catch {
      throw new BrokerHttpError(502, "provider request failed");
    } finally {
      body?.fill(0);
      if (stored) for (const name of Object.keys(stored.credentials)) stored.credentials[name] = "";
    }
    const responseBody = await boundedResponseBody(upstream, 12_000_000);
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    response.writeHead(upstream.status, {
      ...SECURITY_HEADERS,
      "content-type": contentType,
      "content-length": responseBody.length,
      "cache-control": "no-store",
    });
    response.once("close", () => responseBody.fill(0));
    response.end(responseBody, () => responseBody.fill(0));
  }

  private async refreshOAuthIfNeeded(
    stored: StoredConnection,
    provider: ProviderConfig,
  ): Promise<StoredConnection> {
    const expiresAt = Number(stored.credentials.expires_at ?? stored.summary.expiresAt ?? 0);
    if (!expiresAt || expiresAt > Date.now() / 1_000 + 60) return stored;
    const refreshToken = stored.credentials.refresh_token;
    if (typeof refreshToken !== "string" || !refreshToken) {
      throw new BrokerHttpError(409, "OAuth access token expired and no refresh token is available");
    }
    const refreshed = await this.exchangeOAuth(provider, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    try {
      if (!("refresh_token" in refreshed)) refreshed.refresh_token = refreshToken;
      const next = this.options.vault.put({
        projectId: stored.summary.projectId,
        integrationId: stored.summary.integrationId,
        environment: stored.summary.environment,
        provider: stored.summary.provider,
        auth: "oauth2",
        scopes: stored.summary.scopes,
        createdBy: stored.summary.createdBy,
        expiresAt: typeof refreshed.expires_at === "number" ? refreshed.expires_at : null,
        fingerprint: "OAuth",
      }, refreshed);
      for (const name of Object.keys(stored.credentials)) stored.credentials[name] = "";
      return { summary: next, credentials: refreshed };
    } catch (error) {
      for (const name of Object.keys(refreshed)) refreshed[name] = "";
      throw error;
    }
  }

  private async exchangeOAuth(
    provider: ProviderConfig,
    parameters: Record<string, string>,
  ): Promise<SecretCredentials> {
    const oauth = provider.oauth;
    if (!oauth) throw new BrokerHttpError(400, "OAuth provider is not configured");
    const body = new URLSearchParams({ ...parameters, client_id: oauth.clientId });
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    });
    let clientSecret = "";
    if (oauth.clientAuthentication !== "none") clientSecret = readProviderClientSecret(provider);
    if (oauth.clientAuthentication === "basic") {
      headers.set("authorization", `Basic ${Buffer.from(`${oauth.clientId}:${clientSecret}`).toString("base64")}`);
    } else if (oauth.clientAuthentication === "post") {
      body.set("client_secret", clientSecret);
    }
    let response: Response;
    try {
      response = await fetch(oauth.tokenEndpoint, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new BrokerHttpError(502, "OAuth token endpoint is unavailable");
    } finally {
      clientSecret = "";
    }
    const text = await response.text();
    if (!response.ok || text.length > 1_000_000) throw new BrokerHttpError(502, "OAuth token exchange failed");
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new BrokerHttpError(502, "OAuth token endpoint returned malformed JSON");
    }
    const accessToken = raw.access_token;
    if (typeof accessToken !== "string" || !accessToken) throw new BrokerHttpError(502, "OAuth response lacks access_token");
    const credentials: SecretCredentials = { access_token: accessToken };
    for (const name of ["refresh_token", "token_type", "scope"] as const) {
      if (typeof raw[name] === "string" && raw[name]) credentials[name] = raw[name];
    }
    const expiresIn = Number(raw.expires_in ?? 0);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      credentials.expires_at = Math.floor(Date.now() / 1_000 + expiresIn);
    }
    return credentials;
  }

  private report(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof BrokerHttpError) {
      json(response, error.status, { error: error.message });
      return;
    }
    if (
      error instanceof SecretVaultError ||
      error instanceof ProviderRegistryError
    ) {
      json(response, 409, { error: error.message });
      return;
    }
    console.error("secret broker request failed", error instanceof Error ? error.name : "unknown error");
    json(response, 500, { error: "internal secret broker error" });
  }
}
