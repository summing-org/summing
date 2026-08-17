import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitInspector } from "../src/git-inspector.js";
import { ProjectRunnerClient } from "../src/project-runner-client.js";
import { ProjectRunnerServer } from "../src/project-runner-server.js";

async function completedJob(
  client: ProjectRunnerClient,
  projectId: string,
  workspaceId: string,
  jobId: string,
): Promise<Awaited<ReturnType<ProjectRunnerClient["jobs"]>>[number]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const job = (await client.jobs(projectId, workspaceId)).find((candidate) => candidate.id === jobId);
    assert.ok(job);
    if (
      job.status !== "queued" &&
      job.status !== "running" &&
      job.status !== "cancelling"
    ) return job;
    if (Date.now() > deadline) throw new Error("runner job timed out");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

function seedTerminalJobHistory(
  runs: string,
  revision: string,
): { malformedId: string; queuedId: string } {
  const malformedId = randomUUID();
  const queuedId = randomUUID();
  mkdirSync(join(runs, malformedId));
  writeFileSync(join(runs, malformedId, "job.json"), "operator recovery note\n");
  mkdirSync(join(runs, queuedId));
  writeFileSync(join(runs, queuedId, "job.json"), JSON.stringify({
    id: queuedId,
    projectId: "demo",
    workspaceId: "repo",
    action: "run",
    revision,
    status: "queued",
    createdAt: new Date(0).toISOString(),
  }));
  for (let index = 0; index < 105; index += 1) {
    const id = randomUUID();
    const directory = join(runs, id);
    mkdirSync(directory);
    writeFileSync(join(directory, "job.json"), JSON.stringify({
      id,
      projectId: "demo",
      workspaceId: "repo",
      action: "dry-run",
      revision,
      status: "failed",
      error: "historical migration verification failure",
      createdAt: new Date(index).toISOString(),
      completedAt: new Date(index + 1).toISOString(),
    }));
  }
  return { malformedId, queuedId };
}

test("runner snapshots an encrypted workspace environment and injects one temporary env-file", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-test-"));
  const repository = join(root, "repo");
  const configRoot = join(root, "config");
  const dataRoot = join(root, "data");
  const socket = join(root, "runner.sock");
  const fakeDocker = join(root, "docker");
  const dockerArgs = join(root, "docker.args");
  const appData = join(root, "app-data");
  mkdirSync(repository);
  mkdirSync(configRoot);
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  writeFileSync(join(repository, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repository, "app.json"), "{}\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "image"]);
  writeFileSync(
    join(configRoot, "demo.json"),
    JSON.stringify({
      configSourcePaths: ["missing.json", "app.json"],
      dataPath: appData,
      environmentBootstrap: { repo: join(root, "app.env") },
      network: true,
    }),
  );
  writeFileSync(
    join(root, "app.env"),
    "DRY_RUN=true\nLOG_LEVEL=test\nAPI_TOKEN=bootstrap-secret-123456789\n",
    { mode: 0o640 },
  );
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
  secret=$(sed -n 's/^API_TOKEN=//p' "$runtime_env")
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
  const server = new ProjectRunnerServer(
    socket,
    dataRoot,
    configRoot,
    fakeDocker,
    Buffer.alloc(32, 7),
  );
  try {
    await server.start();
    const inspector = new GitInspector(repository);
    const revision = await inspector.resolveRevision("HEAD");
    const archive = await inspector.archive(revision);
    const client = new ProjectRunnerClient(socket);

    const imported = await client.environment("demo", "repo");
    assert.equal(imported.revision, 1);
    assert.doesNotMatch(imported.text, /^DRY_RUN=/m);
    assert.match(imported.text, /API_TOKEN=bootstrap-secret/);
    const encrypted = readFileSync(
      join(dataRoot, "environments", readdirSync(join(dataRoot, "environments"))[0]!),
      "utf8",
    );
    assert.doesNotMatch(encrypted, /bootstrap-secret/);

    const saved = await client.saveEnvironment(
      "demo",
      "repo",
      "LOG_LEVEL=info\nAPI_TOKEN=rotated-runtime-secret-987654321\n",
      1,
    );
    assert.equal(saved.revision, 2);
    await assert.rejects(
      client.saveEnvironment("demo", "repo", "API_TOKEN=stale\n", 1),
      /changed from revision 1 to 2/,
    );

    const build = await client.submit("demo", "repo", "build", revision, archive);
    const buildCompleted = await completedJob(client, "demo", "repo", build.id);
    assert.equal(buildCompleted.status, "completed");
    assert.equal(buildCompleted.trigger, "manual");

    const scheduleId = randomUUID();
    const scheduledFor = "2026-08-17T06:00:00.000Z";
    const dryRun = await client.submit("demo", "repo", "dry-run", revision, archive, {
      trigger: "schedule",
      scheduleId,
      scheduledFor,
    });
    const dryRunCompleted = await completedJob(client, "demo", "repo", dryRun.id);
    assert.equal(dryRunCompleted.status, "completed");
    assert.equal(dryRunCompleted.trigger, "schedule");
    assert.equal(dryRunCompleted.scheduleId, scheduleId);
    assert.equal(dryRunCompleted.scheduledFor, scheduledFor);
    assert.equal(dryRunCompleted.environmentRevision, 2);
    assert.equal(dryRunCompleted.artifactCount, 2);
    assert.deepEqual(
      (await client.artifacts("demo", dryRun.id)).map((artifact) => artifact.name),
      ["manifest.json", "report.html"],
    );
    assert.equal(
      (await client.artifact("demo", dryRun.id, "manifest.json")).content,
      '{"status":"completed","key":"[REDACTED]"}\n',
    );
    await assert.rejects(
      client.deleteArtifact("demo", "another-workspace", dryRun.id, "manifest.json"),
      /not available for this workspace/,
    );
    const deletedManifest = await client.deleteArtifact(
      "demo",
      "repo",
      dryRun.id,
      "manifest.json",
    );
    assert.equal(deletedManifest.name, "manifest.json");
    assert.deepEqual(
      (await client.artifacts("demo", dryRun.id)).map((artifact) => artifact.name),
      ["report.html"],
    );
    await client.deleteArtifact("demo", "repo", dryRun.id, "report.html");
    assert.deepEqual(await client.artifacts("demo", dryRun.id), []);
    assert.equal(
      (await client.jobs("demo", "repo")).find((job) => job.id === dryRun.id)?.artifactCount,
      0,
    );
    assert.equal(
      readdirSync(join(dataRoot, "artifact-trash", "demo", dryRun.id)).length,
      2,
    );
    assert.doesNotMatch(await client.log("demo", dryRun.id), /rotated-runtime-secret/);
    assert.match(await client.log("demo", dryRun.id), /application said key=\[REDACTED\]/);
    const args = readFileSync(dockerArgs, "utf8");
    assert.match(args, new RegExp(`SUMMING_JOB_ID=${dryRun.id}`));
    assert.match(
      args,
      new RegExp(`/projects/demo/runs/${dryRun.id}/source/app\\.json:/run/config\\.json:ro`),
    );
    assert.doesNotMatch(args, /missing\.json:\/run\/config\.json/);
    const envFiles = args.split("\n").filter((value, index, all) => all[index - 1] === "--env-file");
    assert.equal(envFiles.length, 1);
    assert.equal(existsSync(envFiles[0]!), false);
    assert.equal(existsSync(join(dataRoot, "projects", "demo", "runs", dryRun.id, "environment.json")), false);

    const runs = join(dataRoot, "projects", "demo", "runs");
    const { malformedId, queuedId } = seedTerminalJobHistory(runs, revision);

    const validate = await client.submit("demo", "repo", "validate", revision, archive);
    assert.equal((await completedJob(client, "demo", "repo", validate.id)).status, "completed");
    assert.match(readFileSync(dockerArgs, "utf8"), /--network\nnone/);
    assert.equal(readdirSync(runs).length, 102);
    assert.equal(existsSync(join(runs, validate.id)), true);
    assert.equal(existsSync(join(runs, dryRun.id)), true);
    assert.equal(existsSync(join(runs, malformedId)), true);
    assert.equal(existsSync(join(runs, queuedId)), true);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner cancels queued jobs and force-removes a running job container", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-cancel-"));
  const repository = join(root, "repo");
  const configRoot = join(root, "config");
  const dataRoot = join(root, "data");
  const socket = join(root, "runner.sock");
  const fakeDocker = join(root, "docker");
  const dockerCalls = join(root, "docker.calls");
  const runningMarker = join(root, "running");
  const appConfig = join(root, "app.json");
  const appData = join(root, "app-data");
  mkdirSync(repository);
  mkdirSync(configRoot);
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  writeFileSync(join(repository, "Dockerfile"), "FROM scratch\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "image"]);
  writeFileSync(appConfig, "{}\n");
  writeFileSync(
    join(configRoot, "demo.json"),
    JSON.stringify({ configPath: appConfig, dataPath: appData, network: false }),
  );
  writeFileSync(
    fakeDocker,
    `#!/bin/sh
printf '%s\n' "$*" >> "${dockerCalls}"
if [ "$1" = image ]; then exit 0; fi
if [ "$1" = run ]; then
  : > "${runningMarker}"
  trap 'exit 143' TERM INT
  while :; do sleep 1; done
fi
exit 0
`,
    { mode: 0o700 },
  );
  const server = new ProjectRunnerServer(
    socket,
    dataRoot,
    configRoot,
    fakeDocker,
    Buffer.alloc(32, 9),
  );
  try {
    await server.start();
    const inspector = new GitInspector(repository);
    const revision = await inspector.resolveRevision("HEAD");
    const archive = await inspector.archive(revision);
    const client = new ProjectRunnerClient(socket);
    const running = await client.submit("demo", "repo", "run", revision, archive);
    const runningDeadline = Date.now() + 5_000;
    while (!existsSync(runningMarker)) {
      if (Date.now() > runningDeadline) throw new Error("runner did not start the live job");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }

    const queued = await client.submit("demo", "repo", "run", revision, archive);
    assert.equal((await client.cancel("demo", "repo", queued.id)).status, "cancelled");
    assert.equal(
      (await client.jobs("demo", "repo")).find((job) => job.id === queued.id)?.status,
      "cancelled",
    );

    assert.equal((await client.cancel("demo", "repo", running.id)).status, "cancelling");
    const cancelled = await completedJob(client, "demo", "repo", running.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error, "cancelled by user");
    assert.ok(cancelled.cancelRequestedAt);
    assert.ok(cancelled.completedAt);
    assert.match(await client.log("demo", running.id), /cancellation requested/);
    assert.match(await client.log("demo", running.id), /CANCELLED by user/);
    assert.match(
      readFileSync(dockerCalls, "utf8"),
      new RegExp(`rm --force summing-demo-${running.id.slice(0, 8)}`),
    );
    assert.equal((await client.cancel("demo", "repo", running.id)).status, "cancelled");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner rejects unsafe or ambiguous project config sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-config-source-"));
  const configRoot = join(root, "config");
  const socket = join(root, "runner.sock");
  mkdirSync(configRoot);
  const server = new ProjectRunnerServer(
    socket,
    join(root, "data"),
    configRoot,
    "/bin/false",
    Buffer.alloc(32, 8),
  );
  const reported: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]): void => {
    reported.push(values.map(String).join(" "));
  };
  try {
    await server.start();
    const client = new ProjectRunnerClient(socket);
    const writeConfig = (value: Record<string, unknown>): void => writeFileSync(
      join(configRoot, "demo.json"),
      JSON.stringify({ dataPath: join(root, "app-data"), ...value }),
    );

    writeConfig({ configSourcePaths: ["../app.json"] });
    await assert.rejects(client.environment("demo", "repo"), /internal runner error/);
    assert.match(reported.pop() ?? "", /must be a safe relative path/);

    writeConfig({ configSourcePaths: ["app.json", "app.json"] });
    await assert.rejects(client.environment("demo", "repo"), /internal runner error/);
    assert.match(reported.pop() ?? "", /must not contain duplicates/);

    writeConfig({ configPath: join(root, "app.json"), configSourcePaths: ["app.json"] });
    await assert.rejects(client.environment("demo", "repo"), /internal runner error/);
    assert.match(reported.pop() ?? "", /exactly one of configPath or configSourcePaths is required/);
  } finally {
    console.error = originalConsoleError;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner bounds terminal job history on startup without deleting active or malformed state", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-retention-"));
  const dataRoot = join(root, "data");
  const runs = join(dataRoot, "projects", "demo", "runs");
  const revision = "a".repeat(40);
  mkdirSync(runs, { recursive: true });
  try {
    const { malformedId, queuedId } = seedTerminalJobHistory(runs, revision);

    new ProjectRunnerServer(
      join(root, "runner.sock"),
      dataRoot,
      join(root, "config"),
      "/bin/false",
      Buffer.alloc(32, 5),
    );

    assert.equal(readdirSync(runs).length, 102);
    assert.equal(existsSync(join(runs, queuedId)), true);
    assert.equal(existsSync(join(runs, malformedId)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
