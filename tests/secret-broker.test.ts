import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { issueConnectionTicket } from "../src/connection-ticket.js";
import { parseIntegrationManifest } from "../src/integration-manifest.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import {
  SecretBrokerControlClient,
  SecretBrokerRuntimeClient,
} from "../src/secret-broker-client.js";
import { SecretBrokerServer } from "../src/secret-broker-server.js";
import { SecretVault } from "../src/secret-vault.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function socketRequest(
  socketPath: string,
  path: string,
  token: string,
  body = "",
): Promise<{ status: number; body: string }> {
  return await new Promise((resolveRequest, reject) => {
    const request = httpRequest({
      socketPath,
      method: body ? "POST" : "GET",
      path,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolveRequest({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(body || undefined);
  });
}

const apiKeyIntegration = parseIntegrationManifest({
  version: 1,
  integrations: [{
    id: "mail",
    provider: "resend",
    environment: "production",
    auth: "api_key",
    mode: "gateway",
    capabilities: ["email.send"],
    scopes: [],
    actions: ["run"],
    secrets: [{ name: "api_key" }],
    gateway: { methods: ["POST"], pathPrefixes: ["/emails"] },
  }],
}).integrations[0]!;

const oauthIntegration = parseIntegrationManifest({
  version: 1,
  integrations: [{
    id: "source-control",
    provider: "github",
    environment: "production",
    auth: "oauth2",
    mode: "gateway",
    capabilities: ["repository.read"],
    scopes: ["repo"],
    actions: ["run"],
    gateway: { methods: ["GET"], pathPrefixes: ["/repos"] },
  }],
}).integrations[0]!;

const rawIntegration = parseIntegrationManifest({
  version: 1,
  integrations: [{
    id: "raw-mail",
    provider: "resend",
    environment: "production",
    auth: "api_key",
    mode: "raw",
    capabilities: ["email.send"],
    scopes: [],
    actions: ["run"],
    secrets: [{ name: "api_key" }],
    runtime: [{ name: "api_key", env: "RESEND_API_KEY" }],
  }],
}).integrations[0]!;

const oauthLeaseIntegration = parseIntegrationManifest({
  version: 1,
  integrations: [{
    id: "source-control-lease",
    provider: "github",
    environment: "production",
    auth: "oauth2",
    mode: "lease",
    capabilities: [],
    scopes: ["repo"],
    actions: ["run"],
    runtime: [{ name: "access_token", env: "GITHUB_TOKEN" }],
  }],
}).integrations[0]!;

test("broker keeps API keys out of metadata and turns them into scoped gateway capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-broker-"));
  const port = await freePort();
  const clientSecretPath = join(root, "github-client-secret");
  writeFileSync(clientSecretPath, "oauth-client-secret\n", { mode: 0o600 });
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const vaultKey = randomBytes(32);
  const vault = new SecretVault(join(root, "secrets.sqlite3"), vaultKey);
  vaultKey.fill(0);
  const providers = ProviderRegistry.from({ providers: {
    resend: {
      apiBaseUrl: "https://api.resend.test",
      allowedMethods: ["POST"],
      allowedPathPrefixes: ["/emails", "/domains"],
      gatewayCapabilities: {
        "email.send": { allowedMethods: ["POST"], allowedPathPrefixes: ["/emails"] },
      },
      authentication: { type: "bearer", credential: "api_key" },
    },
    github: {
      apiBaseUrl: "https://api.github.test",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/repos"],
      gatewayCapabilities: {
        "repository.read": { allowedMethods: ["GET"], allowedPathPrefixes: ["/repos"] },
      },
      authentication: { type: "bearer", credential: "access_token" },
      oauth: {
        authorizationEndpoint: "https://github.test/oauth/authorize",
        tokenEndpoint: "https://github.test/oauth/token",
        clientId: "client-id",
        clientSecretFile: clientSecretPath,
        clientAuthentication: "basic",
        allowedScopes: ["repo"],
      },
    },
  } });
  const controlSocket = join(root, "control.sock");
  const runtimeSocket = join(root, "runtime.sock");
  const gatewaySocket = join(root, "gateway.sock");
  const endpoint = `http://127.0.0.1:${port}`;
  const broker = new SecretBrokerServer({
    publicHost: "127.0.0.1",
    publicPort: port,
    publicUrl: endpoint,
    controlSocket,
    runtimeSocket,
    gatewaySocket,
    ticketPublicKey: publicKey,
    providers,
    vault,
  });
  const originalFetch = globalThis.fetch;
  const providerRequests: Array<{ url: string; authorization: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(endpoint)) return originalFetch(input, init);
    if (url === "https://api.resend.test/emails") {
      providerRequests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      return new Response('{"id":"email-1"}', {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://github.test/oauth/token") {
      return new Response(JSON.stringify({
        access_token: "oauth-access-token",
        refresh_token: "oauth-refresh-token",
        expires_in: 3600,
      }), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    await broker.start();
    const ticket = issueConnectionTicket(privateKey, 42, "demo", apiKeyIntegration);
    const session = await originalFetch(`${endpoint}/connections/api/session`, {
      headers: { authorization: `Bearer ${ticket}` },
    });
    assert.equal(session.status, 200);
    assert.doesNotMatch(await session.text(), /secret-api-key-value/);

    const stored = await originalFetch(`${endpoint}/connections/api/secret`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ticket}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ values: { api_key: "secret-api-key-value-123456789" } }),
    });
    assert.equal(stored.status, 201, await stored.text());
    const replayed = await originalFetch(`${endpoint}/connections/api/secret`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ticket}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ values: { api_key: "another-secret-value-123456" } }),
    });
    assert.equal(replayed.status, 409);

    const control = new SecretBrokerControlClient(controlSocket);
    assert.equal(await control.available(), true);
    const metadata = await control.connections("demo");
    assert.equal(metadata[0]?.fingerprint, "…6789");
    assert.doesNotMatch(JSON.stringify(metadata), /secret-api-key-value/);
    const rawModes = await control.modeOptions([rawIntegration]);
    assert.deepEqual(rawModes[0]?.supported, ["gateway", "raw"]);
    assert.equal(rawModes[0]?.recommended, "gateway");

    const runtime = new SecretBrokerRuntimeClient(runtimeSocket);
    const lease = await runtime.lease({
      projectId: "demo",
      action: "run",
      jobId: "00000000-0000-4000-8000-000000000000",
      integrations: [apiKeyIntegration],
    });
    assert.equal("files" in lease, false);
    const capability = lease.gatewayTokens["mail@production"];
    assert.ok(capability);
    assert.notEqual(capability, "secret-api-key-value-123456789");
    const proxied = await socketRequest(
      gatewaySocket,
      "/v1/proxy/mail%40production/emails",
      capability!,
      '{"from":"system@example.test"}',
    );
    assert.equal(proxied.status, 201, proxied.body);
    assert.deepEqual(providerRequests, [{
      url: "https://api.resend.test/emails",
      authorization: "Bearer secret-api-key-value-123456789",
    }]);
    const denied = await socketRequest(
      gatewaySocket,
      "/v1/proxy/mail%40production/admin",
      capability!,
      "{}",
    );
    assert.equal(denied.status, 403);
    const lookalike = await socketRequest(
      gatewaySocket,
      "/v1/proxy/mail%40production/emails-admin",
      capability!,
      "{}",
    );
    assert.equal(lookalike.status, 403);

    await runtime.release(lease);
    const released = await socketRequest(
      gatewaySocket,
      "/v1/proxy/mail%40production/emails",
      capability!,
      "{}",
    );
    assert.equal(released.status, 401);

    const overclaimed = parseIntegrationManifest({
      version: 1,
      integrations: [{
        ...apiKeyIntegration,
        id: "overclaimed-mail",
        gateway: { methods: ["POST"], pathPrefixes: ["/domains"] },
      }],
    }).integrations[0]!;
    const overclaimedTicket = issueConnectionTicket(privateKey, 42, "demo", overclaimed);
    const overclaimedStore = await originalFetch(`${endpoint}/connections/api/secret`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${overclaimedTicket}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ values: { api_key: "overclaimed-secret-123456789" } }),
    });
    assert.equal(overclaimedStore.status, 400);
    assert.match(await overclaimedStore.text(), /named gateway capabilities/);

    const rawTicket = issueConnectionTicket(privateKey, 42, "demo", rawIntegration);
    const rawStored = await originalFetch(`${endpoint}/connections/api/secret`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawTicket}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        values: { api_key: "raw-api-key-value-123456789" },
        grant: "once",
      }),
    });
    assert.equal(rawStored.status, 201, await rawStored.text());
    const rawLease = await runtime.lease({
      projectId: "demo",
      action: "run",
      jobId: "00000000-0000-4000-8000-000000000002",
      integrations: [rawIntegration],
    });
    assert.equal(rawLease.environment.RESEND_API_KEY, "raw-api-key-value-123456789");
    await assert.rejects(
      runtime.lease({
        projectId: "demo",
        action: "run",
        jobId: "00000000-0000-4000-8000-000000000003",
        integrations: [rawIntegration],
      }),
      /raw credential access is not authorized/,
    );
    const rawGrantTicket = issueConnectionTicket(privateKey, 42, "demo", rawIntegration);
    const rawGranted = await originalFetch(`${endpoint}/connections/api/raw-grant`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawGrantTicket}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ grant: "project" }),
    });
    assert.equal(rawGranted.status, 200, await rawGranted.text());
    const persistentRawLease = await runtime.lease({
      projectId: "demo",
      action: "run",
      jobId: "00000000-0000-4000-8000-000000000004",
      integrations: [rawIntegration],
    });
    assert.equal(persistentRawLease.environment.RESEND_API_KEY, "raw-api-key-value-123456789");
    assert.equal(vault.getSummary("demo", "raw-mail", "production")?.rawGrant, "project");

    const oauthTicket = issueConnectionTicket(privateKey, 42, "demo", oauthIntegration);
    const started = await originalFetch(`${endpoint}/connections/api/oauth/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${oauthTicket}` },
    });
    assert.equal(started.status, 200);
    const authorizationUrl = new URL((await started.json() as { authorizationUrl: string }).authorizationUrl);
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorizationUrl.searchParams.get("scope"), "repo");
    const callback = await originalFetch(
      `${endpoint}/connections/oauth/callback?code=oauth-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`,
    );
    assert.equal(callback.status, 200, await callback.text());
    assert.equal(
      vault.getSummary("demo", "source-control", "production")?.status,
      "connected",
    );

    const oauthLeaseTicket = issueConnectionTicket(privateKey, 42, "demo", oauthLeaseIntegration);
    const leaseStarted = await originalFetch(`${endpoint}/connections/api/oauth/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${oauthLeaseTicket}` },
    });
    assert.equal(leaseStarted.status, 200);
    const leaseAuthorizationUrl = new URL(
      (await leaseStarted.json() as { authorizationUrl: string }).authorizationUrl,
    );
    const leaseCallback = await originalFetch(
      `${endpoint}/connections/oauth/callback?code=oauth-code&state=${encodeURIComponent(leaseAuthorizationUrl.searchParams.get("state")!)}`,
    );
    assert.equal(leaseCallback.status, 200, await leaseCallback.text());
    const oauthLease = await runtime.lease({
      projectId: "demo",
      action: "run",
      jobId: "00000000-0000-4000-8000-000000000005",
      integrations: [oauthLeaseIntegration],
    });
    assert.equal(oauthLease.environment.GITHUB_TOKEN, "oauth-access-token");
    assert.doesNotMatch(JSON.stringify(oauthLease), /oauth-refresh-token/);
  } finally {
    globalThis.fetch = originalFetch;
    await broker.close();
    vault.close();
    rmSync(root, { recursive: true, force: true });
  }
});
