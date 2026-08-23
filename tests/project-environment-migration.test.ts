import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseProjectEnvironment,
  ProjectEnvironmentStore,
  readOrCreateEnvironmentKey,
} from "../src/project-environment.js";
import { ProjectEnvironmentMigrationCoordinator } from "../src/project-environment-coordinator.js";
import {
  currentEnvironmentVerification,
  discoverLegacyEnvironmentMigrations,
  importLegacyConnections,
  readPinnedLegacyManifest,
  recordEnvironmentMigrationVerification,
} from "../src/project-environment-migration.js";
import type { RunnerAction, RunnerJob } from "../src/project-runner-client.js";
import { ProjectRunnerClient } from "../src/project-runner-client.js";
import { ProjectRunnerServer } from "../src/project-runner-server.js";

function listen(server: ReturnType<typeof createServer>, socket: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, reject) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const encoded = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(encoded.length),
  });
  response.end(encoded);
}

function repository(path: string): string {
  mkdirSync(path);
  execFileSync("git", ["init", "--initial-branch=main", path]);
  execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", path, "config", "user.email", "test@example.test"]);
  writeFileSync(join(path, "Dockerfile"), "FROM scratch\n");
  execFileSync("git", ["-C", path, "add", "."]);
  execFileSync("git", ["-C", path, "commit", "-m", "fixture"]);
  return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

test("legacy raw Connections become one encrypted environment without logging values", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-environment-migration-"));
  const socket = join(root, "broker.sock");
  const repo = join(root, "repo");
  repository(repo);
  mkdirSync(join(repo, ".summing"));
  const manifestPath = join(repo, ".summing", "integrations.json");
  const bootstrapPath = join(root, "project.env");
  const markerPath = join(root, "state", "imported.json");
  const storeRoot = join(root, "environments");
  const secret = "secret value#\"\twith\\slashes";
  writeFileSync(bootstrapPath, "DRY_RUN=true\nLOG_LEVEL=info\n", { mode: 0o640 });
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    integrations: [{
      id: "openai",
      provider: "openai",
      environment: "production",
      auth: "api_key",
      mode: "raw",
      capabilities: [],
      scopes: [],
      actions: ["run"],
      secrets: [{ name: "api-key" }],
      runtime: [{ name: "api-key", env: "OPENAI_API_KEY" }],
    }],
  }));
  execFileSync("git", ["-C", repo, "add", ".summing/integrations.json"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "legacy manifest"]);
  const pinnedRevision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const pinnedManifest = readPinnedLegacyManifest(repo, pinnedRevision);
  writeFileSync(manifestPath, "{}\n", "utf8");
  let leases = 0;
  let releases = 0;
  let requestedActions: unknown = null;
  const broker = createServer((request, response) => {
    void (async () => {
      const payload = JSON.parse((await body(request)).toString("utf8") || "null") as {
        integrations?: Array<{ actions?: unknown }>;
      };
      if (request.method === "POST" && request.url === "/v1/leases") {
        leases += 1;
        requestedActions = payload.integrations?.[0]?.actions;
        json(response, 201, {
          lease: {
            id: randomUUID(),
            projectId: "legacy-demo",
            jobId: (payload as { jobId?: string }).jobId,
            environment: { OPENAI_API_KEY: secret },
            gatewayTokens: {},
          },
        });
        return;
      }
      if (request.method === "DELETE" && request.url?.startsWith("/v1/leases/")) {
        releases += 1;
        json(response, 200, null);
        return;
      }
      json(response, 404, { error: "not found" });
    })();
  });
  try {
    await listen(broker, socket);
    const store = new ProjectEnvironmentStore(storeRoot, Buffer.alloc(32, 4));
    const first = await importLegacyConnections({
      projectId: "legacy-demo",
      workspaceId: "repo",
      manifestPath,
      brokerSocket: socket,
      bootstrapPath,
      markerPath,
      store,
      manifestText: pinnedManifest,
    });
    assert.equal(first.status, "migrated");
    assert.deepEqual(first.marker.integrationIds, ["openai@production"]);
    assert.deepEqual(requestedActions, ["dry-run"]);
    assert.equal(store.get("legacy-demo", "repo").revision, 2);
    assert.equal(
      store.get("legacy-demo", "repo").text.includes("OPENAI_API_KEY="),
      true,
    );
    assert.equal(
      store.get("legacy-demo", "repo").text.includes("DRY_RUN="),
      false,
    );
    assert.equal(
      (await importLegacyConnections({
        projectId: "legacy-demo",
        workspaceId: "repo",
        manifestPath,
        brokerSocket: join(root, "missing.sock"),
        bootstrapPath,
        markerPath,
        store,
        manifestText: pinnedManifest,
      })).status,
      "already-migrated",
    );
    assert.equal(leases, 1);
    assert.equal(releases, 1);
    assert.doesNotMatch(readFileSync(join(storeRoot, "legacy-demo--repo.json"), "utf8"), /secret value/);
    assert.doesNotMatch(readFileSync(markerPath, "utf8"), /secret value/);
    assert.equal(
      parseProjectEnvironment(store.get("legacy-demo", "repo").text).values.get("OPENAI_API_KEY"),
      secret,
    );
  } finally {
    await close(broker);
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy schedules are discoverable until cutover is finalized", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-environment-discovery-"));
  const configRoot = join(root, "projects");
  const scheduleRoot = join(root, "schedules");
  const dataRoot = join(root, "jobs");
  const repo = join(root, "repo");
  mkdirSync(configRoot);
  mkdirSync(scheduleRoot);
  mkdirSync(dataRoot);
  mkdirSync(repo);
  writeFileSync(join(configRoot, "legacy-demo.json"), JSON.stringify({
    configPath: join(root, "config.json"),
    dataPath: join(root, "data"),
    envPath: join(root, "project.env"),
  }), { mode: 0o640 });
  writeFileSync(join(scheduleRoot, "legacy-demo.json"), JSON.stringify({
    projectId: "legacy-demo",
    workspaceId: "repo",
    repository: repo,
    revision: "a".repeat(40),
  }), { mode: 0o640 });
  try {
    const targets = discoverLegacyEnvironmentMigrations(configRoot, scheduleRoot, dataRoot);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.bootstrapPath, join(root, "project.env"));
    mkdirSync(targets[0]!.stateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(targets[0]!.stateRoot, "finalized.json"), JSON.stringify({
      version: 1,
      projectId: "legacy-demo",
      workspaceId: "repo",
      legacyBrokerDataPreserved: true,
    }), { mode: 0o600 });
    assert.deepEqual(discoverLegacyEnvironmentMigrations(configRoot, scheduleRoot, dataRoot), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summing-owned coordinator hands pinned Git data to a repository-blind runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-environment-coordinator-"));
  const repo = join(root, "repo");
  const configRoot = join(root, "projects");
  const scheduleRoot = join(root, "schedules");
  const dataRoot = join(root, "runner-data");
  const runnerSocket = join(root, "runner.sock");
  const brokerSocket = join(root, "broker.sock");
  const bootstrapPath = join(root, "project.env");
  const fakeDocker = join(root, "docker");
  const appData = join(root, "app-data");
  repository(repo);
  mkdirSync(join(repo, ".summing"));
  writeFileSync(join(repo, ".summing", "integrations.json"), JSON.stringify({
    version: 1,
    integrations: [{
      id: "openai",
      provider: "openai",
      environment: "production",
      auth: "api_key",
      mode: "raw",
      capabilities: [],
      scopes: [],
      actions: ["run"],
      secrets: [{ name: "api-key" }],
      runtime: [{ name: "api-key", env: "OPENAI_API_KEY" }],
    }],
  }));
  execFileSync("git", ["-C", repo, "add", ".summing/integrations.json"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "legacy manifest"]);
  const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  mkdirSync(configRoot);
  mkdirSync(scheduleRoot);
  writeFileSync(join(configRoot, "legacy-demo.json"), JSON.stringify({
    configPath: join(root, "app.json"),
    dataPath: appData,
    envPath: bootstrapPath,
    network: true,
  }), { mode: 0o640 });
  writeFileSync(join(scheduleRoot, "legacy-demo.json"), JSON.stringify({
    projectId: "legacy-demo",
    workspaceId: "repo",
    repository: repo,
    revision,
  }), { mode: 0o640 });
  writeFileSync(bootstrapPath, "DRY_RUN=true\nLOG_LEVEL=info\n", { mode: 0o640 });
  writeFileSync(join(root, "app.json"), "{}\n", { mode: 0o640 });
  writeFileSync(fakeDocker, `#!/bin/sh
if [ "$1" = image ]; then printf '%s\n' 'sha256:migration-test-image'; exit 0; fi
exit 0
`, { mode: 0o700 });

  let releases = 0;
  const broker = createServer((request, response) => {
    void (async () => {
      const payload = JSON.parse((await body(request)).toString("utf8") || "null") as {
        projectId?: string;
        jobId?: string;
      };
      if (request.method === "POST" && request.url === "/v1/leases") {
        json(response, 201, {
          lease: {
            id: randomUUID(),
            projectId: payload.projectId,
            jobId: payload.jobId,
            environment: { OPENAI_API_KEY: "coordinator-secret-value" },
            gatewayTokens: {},
          },
        });
        return;
      }
      if (request.method === "DELETE" && request.url?.startsWith("/v1/leases/")) {
        releases += 1;
        json(response, 200, null);
        return;
      }
      json(response, 404, { error: "not found" });
    })();
  });

  const discovered = discoverLegacyEnvironmentMigrations(configRoot, scheduleRoot, dataRoot);
  const runnerTargets = discovered.map((target) => ({
    ...target,
    repository: join(root, "runner-cannot-read-this-repository"),
    manifestPath: join(root, "runner-cannot-read-this-manifest.json"),
  }));
  const runner = new ProjectRunnerServer(
    runnerSocket,
    dataRoot,
    configRoot,
    fakeDocker,
    Buffer.alloc(32, 9),
    false,
    runnerTargets,
    brokerSocket,
  );
  try {
    await listen(broker, brokerSocket);
    await runner.start();
    const client = new ProjectRunnerClient(runnerSocket);
    assert.equal(await client.available(), false);
    await new ProjectEnvironmentMigrationCoordinator({
      runnerSocket,
      configRoot,
      scheduleRoot,
      dataRoot,
      retryMs: 10,
      verificationTimeoutMs: 5_000,
    }).run(new AbortController().signal);

    assert.equal(await client.available(), true);
    assert.equal(
      parseProjectEnvironment((await client.environment("legacy-demo", "repo")).text)
        .values.get("OPENAI_API_KEY"),
      "coordinator-secret-value",
    );
    assert.equal(releases, 1);
    assert.equal(existsSync(join(root, "runner-cannot-read-this-repository")), false);
    const marker = JSON.parse(readFileSync(join(
      dataRoot,
      "migrations/connections-to-environment/legacy-demo--repo/verified.json",
    ), "utf8")) as { environmentRevision: number };
    assert.equal(marker.environmentRevision, 2);
  } finally {
    await runner.close();
    await close(broker);
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration verification requires completed jobs on one current environment revision", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-environment-verification-"));
  const repo = join(root, "repo");
  const markerPath = join(root, "state", "verified.json");
  const revision = repository(repo);
  const store = new ProjectEnvironmentStore(join(root, "environments"), Buffer.alloc(32, 5));
  store.save("legacy-demo", "repo", "LOG_LEVEL=info\n", 0);
  store.save("legacy-demo", "repo", "LOG_LEVEL=info\nOPENAI_API_KEY=hidden\n", 1);
  const job = (action: RunnerAction, environmentRevision: number, status: RunnerJob["status"] = "completed") => ({
    id: randomUUID(),
    projectId: "legacy-demo",
    workspaceId: "repo",
    action,
    revision,
    status,
    createdAt: new Date().toISOString(),
    environmentRevision,
  } satisfies RunnerJob);
  try {
    const result = recordEnvironmentMigrationVerification({
      projectId: "legacy-demo",
      workspaceId: "repo",
      revision,
      markerPath,
      store,
      validateJob: job("validate", 2),
      dryRunJob: job("dry-run", 2),
    });
    assert.equal(result.status, "verified");
    assert.equal(result.marker.environmentRevision, 2);
    assert.equal(existsSync(markerPath), true);
    assert.ok(currentEnvironmentVerification(markerPath, "legacy-demo", "repo", revision, store));

    store.save("legacy-demo", "repo", "LOG_LEVEL=debug\nOPENAI_API_KEY=hidden\n", 2);
    assert.equal(currentEnvironmentVerification(markerPath, "legacy-demo", "repo", revision, store), null);
    assert.throws(() => recordEnvironmentMigrationVerification({
      projectId: "legacy-demo",
      workspaceId: "repo",
      revision,
      markerPath,
      store,
      validateJob: job("validate", 3, "failed"),
      dryRunJob: job("dry-run", 3),
    }), /validate job cannot verify/);
    const repeated = recordEnvironmentMigrationVerification({
      projectId: "legacy-demo",
      workspaceId: "repo",
      revision,
      markerPath,
      store,
      validateJob: job("validate", 3),
      dryRunJob: job("dry-run", 3),
    });
    assert.equal(repeated.status, "verified");
    assert.equal(repeated.marker.environmentRevision, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner can bootstrap a private key in its writable state directory", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-environment-bootstrap-key-"));
  const path = join(root, "environment.key");
  try {
    const first = readOrCreateEnvironmentKey(path);
    const second = readOrCreateEnvironmentKey(path);
    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
    assert.equal(statSync(path).mode & 0o777, 0o400);
    chmodSync(path, 0o644);
    assert.throws(() => readOrCreateEnvironmentKey(path), /private regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
