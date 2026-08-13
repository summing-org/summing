import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyConnectionTicket } from "../src/connection-ticket.js";
import { loadConfig } from "../src/config.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { ProjectViewerServer } from "../src/project-viewer.js";
import type { ConnectionSummary } from "../src/secret-vault.js";
import { StateStore } from "../src/state-store.js";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function repository(path: string): void {
  mkdirSync(join(path, ".summing"), { recursive: true });
  writeFileSync(join(path, "README.md"), "fixture\n");
  writeFileSync(join(path, ".summing", "integrations.json"), JSON.stringify({
    version: 1,
    integrations: [{
      id: "mail",
      provider: "resend",
      environment: "production",
      auth: "api_key",
      mode: "raw",
      capabilities: ["email.send"],
      scopes: [],
      actions: ["dry-run", "run"],
      secrets: [{ name: "api_key" }],
      runtime: [{ name: "api_key", env: "RESEND_API_KEY" }],
    }],
  }));
  git(path, "init", "--initial-branch=main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.com");
  git(path, "add", "README.md", ".summing/integrations.json");
  git(path, "commit", "-m", "fixture");
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function signedInitData(token: string, userId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1_000)),
    query_id: `query-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "Viewer" }),
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

test("viewer lists masked connection state, issues a scoped ticket, and blocks missing run access", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-viewer-connections-"));
  const workspace = join(root, "workspace");
  repository(workspace);
  const port = await freePort();
  const configPath = join(root, "config.toml");
  const privateKeyPath = join(root, "connection-ticket-private.pem");
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  writeFileSync(configPath, `[viewer]\nport = ${port}\n\n[projects.demo]\nname = "Demo"\ndefault_workspace = "repo"\n\n[projects.demo.workspaces.repo]\npath = "${workspace}"\n`);
  const config = loadConfig({
    SUMMING_DATA_DIR: join(root, "data"),
    SUMMING_CONFIG: configPath,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_OWNER_ID: "42",
    SUMMING_CONNECTIONS_URL: "https://connect.example.test",
    SUMMING_CONNECTION_TICKET_PRIVATE_KEY: privateKeyPath,
    SUMMING_SECRETS_CONTROL_SOCKET: join(root, "control.sock"),
    SUMMING_RUNNER_SOCKET: join(root, "runner.sock"),
  });
  const state = new StateStore(join(config.dataDir, "state.sqlite3"));
  const projects = new ProjectCatalog(config, state);
  const conversation = state.bind(42, 1, "demo", "repo");
  const viewer = new ProjectViewerServer(config, state, projects);
  let connections: ConnectionSummary[] = [];
  let submissions = 0;
  Object.assign(viewer.secrets, {
    available: async () => true,
    connections: async () => connections,
    modeOptions: async () => [{
      integrationId: "mail",
      environment: "production",
      requested: "raw",
      supported: ["gateway", "raw"],
      recommended: "gateway",
    }],
  });
  Object.assign(viewer.runner, {
    available: async () => true,
    submit: async () => {
      submissions += 1;
      return {
        id: "00000000-0000-4000-8000-000000000001",
        projectId: "demo",
        action: "run",
        revision: "a".repeat(40),
        status: "queued",
        createdAt: "2026-08-13T00:00:00Z",
      };
    },
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const headers = {
    "x-telegram-init-data": signedInitData("bot-token", 42),
  };

  try {
    await viewer.start();
    const listed = await fetch(
      `${endpoint}/api/viewer/connections?conversation=${conversation.id}`,
      { headers },
    );
    assert.equal(listed.status, 200);
    const listedPayload = await listed.json() as {
      available: boolean;
      integrations: Array<{ id: string; mode: string }>;
      connections: ConnectionSummary[];
      modes: Array<{ recommended: string }>;
    };
    assert.equal(listedPayload.available, true);
    assert.deepEqual(listedPayload.integrations.map((item) => [item.id, item.mode]), [["mail", "raw"]]);
    assert.deepEqual(listedPayload.connections, []);
    assert.equal(listedPayload.modes[0]?.recommended, "gateway");

    const blocked = await fetch(`${endpoint}/api/viewer/jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ conversation: conversation.id, action: "run" }),
    });
    assert.equal(blocked.status, 409);
    assert.match(await blocked.text(), /missing connections: mail@production/);
    assert.equal(submissions, 0);

    const issued = await fetch(`${endpoint}/api/viewer/connection-ticket`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        conversation: conversation.id,
        integration: "mail",
        environment: "production",
      }),
    });
    const issuedText = await issued.text();
    assert.equal(issued.status, 201, issuedText);
    const issuedPayload = JSON.parse(issuedText) as { url: string; expiresIn: number };
    const connectionUrl = new URL(issuedPayload.url);
    assert.equal(connectionUrl.origin, "https://connect.example.test");
    assert.equal(connectionUrl.search, "");
    const ticket = new URLSearchParams(connectionUrl.hash.slice(1)).get("ticket");
    assert.ok(ticket);
    const ticketPayload = verifyConnectionTicket(publicKey, ticket!);
    assert.equal(ticketPayload.userId, 42);
    assert.equal(ticketPayload.projectId, "demo");
    assert.equal(ticketPayload.integration.id, "mail");
    assert.equal(ticketPayload.integration.mode, "raw");

    const now = Date.now() / 1_000;
    connections = [{
      id: "connection-1",
      projectId: "demo",
      integrationId: "mail",
      environment: "production",
      provider: "resend",
      auth: "api_key",
      scopes: [],
      status: "connected",
      version: 1,
      createdBy: 42,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      lastUsedAt: null,
      fingerprint: "…6789",
      rawGrant: "once",
    }];
    const allowed = await fetch(`${endpoint}/api/viewer/jobs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ conversation: conversation.id, action: "run" }),
    });
    assert.equal(allowed.status, 202, await allowed.text());
    assert.equal(submissions, 1);
  } finally {
    await viewer.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
