import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitInspector } from "../src/git-inspector.js";
import { ProjectRunnerClient } from "../src/project-runner-client.js";
import { ProjectRunnerServer } from "../src/project-runner-server.js";

test("queues an immutable archive and builds it through the isolated runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-test-"));
  const repository = join(root, "repo");
  const configRoot = join(root, "config");
  const dataRoot = join(root, "data");
  const socket = join(root, "runner.sock");
  const runtimeSocket = join(root, "broker-runtime.sock");
  const fakeDocker = join(root, "docker");
  const dockerArgs = join(root, "docker.args");
  const appData = join(root, "app-data");
  mkdirSync(repository);
  mkdirSync(join(repository, ".summing"));
  mkdirSync(configRoot);
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  writeFileSync(join(repository, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repository, ".summing", "integrations.json"), JSON.stringify({
    version: 1,
    integrations: [{
      id: "mail",
      provider: "resend",
      environment: "production",
      auth: "api_key",
      mode: "raw",
      capabilities: [],
      scopes: [],
      actions: ["dry-run"],
      secrets: [{ name: "api_key" }],
      runtime: [{ name: "api_key", env: "RESEND_API_KEY" }],
    }],
  }));
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "image"]);
  writeFileSync(
    join(configRoot, "demo.json"),
    JSON.stringify({
      configPath: join(root, "app.json"),
      envPath: join(root, "app.env"),
      dataPath: appData,
    }),
  );
  writeFileSync(join(root, "app.json"), "{}\n");
  writeFileSync(join(root, "app.env"), "LOG_LEVEL=test\n", { mode: 0o640 });
  writeFileSync(
    fakeDocker,
    `#!/bin/sh
if [ "$1" = image ]; then exit 1; fi
if [ "$1" = run ]; then
  printf '%s\n' "$@" > "${dockerArgs}"
  job=""
  runtime_env=""
  previous=""
  for value in "$@"; do
    case "$value" in SUMMING_JOB_ID=*) job="\${value#*=}" ;; esac
    if [ "$previous" = "--env-file" ]; then runtime_env="$value"; fi
    previous="$value"
  done
  secret=$(sed -n 's/^RESEND_API_KEY=//p' "$runtime_env")
  printf 'application said key=%s\n' "$secret"
  if [ -n "$job" ]; then
    mkdir -p "${appData}/dry-runs/$job"
    printf '{"status":"completed","key":"%s"}\n' "$secret" > "${appData}/dry-runs/$job/manifest.json"
    printf '<html>report</html>\n' > "${appData}/dry-runs/$job/report.html"
  fi
fi
exit 0
`,
  );
  chmodSync(fakeDocker, 0o700);
  let leaseReleases = 0;
  const runtime = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "DELETE") {
        leaseReleases += 1;
        response.writeHead(204);
        response.end();
        return;
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        projectId: string;
        jobId: string;
      };
      const body = JSON.stringify({ lease: {
        id: "00000000-0000-4000-8000-000000000099",
        projectId: input.projectId,
        jobId: input.jobId,
        expiresAt: Math.floor(Date.now() / 1_000) + 1_800,
        environment: { RESEND_API_KEY: "raw-runtime-secret-123456789" },
        gatewayTokens: {},
      } });
      response.writeHead(201, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    runtime.once("error", reject);
    runtime.listen(runtimeSocket, resolveListen);
  });
  const server = new ProjectRunnerServer(
    socket,
    dataRoot,
    configRoot,
    fakeDocker,
    runtimeSocket,
    join(root, "broker-gateway.sock"),
  );
  try {
    await server.start();
    const inspector = new GitInspector(repository);
    const revision = await inspector.resolveRevision("HEAD");
    const client = new ProjectRunnerClient(socket);
    const job = await client.submit("demo", "build", revision, await inspector.archive(revision));
    const deadline = Date.now() + 5_000;
    let completed = job;
    while (completed.status === "queued" || completed.status === "running") {
      if (Date.now() > deadline) throw new Error("runner job timed out");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      completed = (await client.jobs("demo")).find((candidate) => candidate.id === job.id)!;
    }
    assert.equal(completed.status, "completed");
    assert.match(await client.log("demo", job.id), /build demo@/);

    const dryRun = await client.submit("demo", "dry-run", revision, await inspector.archive(revision));
    const dryRunDeadline = Date.now() + 5_000;
    let dryRunCompleted = dryRun;
    while (dryRunCompleted.status === "queued" || dryRunCompleted.status === "running") {
      if (Date.now() > dryRunDeadline) throw new Error("runner dry-run timed out");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      dryRunCompleted = (await client.jobs("demo")).find((candidate) => candidate.id === dryRun.id)!;
    }
    assert.equal(dryRunCompleted.status, "completed");
    assert.equal(dryRunCompleted.artifactCount, 2);
    assert.deepEqual(
      (await client.artifacts("demo", dryRun.id)).map((artifact) => artifact.name),
      ["manifest.json", "report.html"],
    );
    assert.equal(
      (await client.artifact("demo", dryRun.id, "manifest.json")).content,
      '{"status":"completed","key":"[REDACTED]"}\n',
    );
    assert.doesNotMatch(await client.log("demo", dryRun.id), /raw-runtime-secret/);
    assert.match(await client.log("demo", dryRun.id), /application said key=\[REDACTED\]/);
    await assert.rejects(
      client.artifact("demo", dryRun.id, "../app.env"),
      /invalid artifact name/,
    );
    const args = readFileSync(dockerArgs, "utf8");
    assert.match(args, new RegExp(`SUMMING_JOB_ID=${dryRun.id}`));
    assert.match(args, new RegExp(`SUMMING_REVISION=${revision}`));
    assert.match(args, new RegExp(`DRY_RUN_ARTIFACT_DIR=/app/data/dry-runs/${dryRun.id}`));
    const envFiles = args.split("\n").filter((value, index, all) => all[index - 1] === "--env-file");
    assert.equal(envFiles.length, 2);
    assert.equal(existsSync(envFiles[1]!), false);
    assert.equal(leaseReleases, 1);

    writeFileSync(join(root, "app.env"), "OPENAI_API_KEY=legacy-secret-must-not-run\n");
    const rejected = await client.submit("demo", "validate", revision, await inspector.archive(revision));
    const rejectedDeadline = Date.now() + 5_000;
    let rejectedCompleted = rejected;
    while (rejectedCompleted.status === "queued" || rejectedCompleted.status === "running") {
      if (Date.now() > rejectedDeadline) throw new Error("runner validation timed out");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      rejectedCompleted = (await client.jobs("demo")).find((candidate) => candidate.id === rejected.id)!;
    }
    assert.equal(rejectedCompleted.status, "failed");
    assert.match(rejectedCompleted.error ?? "", /OPENAI_API_KEY.*use Connections/);
    assert.doesNotMatch(await client.log("demo", rejected.id), /legacy-secret-must-not-run/);
  } finally {
    await server.close();
    await new Promise<void>((resolveClose) => runtime.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});
