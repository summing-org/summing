import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    if (job.status !== "queued" && job.status !== "running") return job;
    if (Date.now() > deadline) throw new Error("runner job timed out");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
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
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "image"]);
  writeFileSync(
    join(configRoot, "demo.json"),
    JSON.stringify({
      configPath: join(root, "app.json"),
      dataPath: appData,
      environmentBootstrap: { repo: join(root, "app.env") },
      network: true,
    }),
  );
  writeFileSync(join(root, "app.json"), "{}\n");
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
    assert.equal((await completedJob(client, "demo", "repo", build.id)).status, "completed");

    const dryRun = await client.submit("demo", "repo", "dry-run", revision, archive);
    const dryRunCompleted = await completedJob(client, "demo", "repo", dryRun.id);
    assert.equal(dryRunCompleted.status, "completed");
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
    assert.doesNotMatch(await client.log("demo", dryRun.id), /rotated-runtime-secret/);
    assert.match(await client.log("demo", dryRun.id), /application said key=\[REDACTED\]/);
    const args = readFileSync(dockerArgs, "utf8");
    assert.match(args, new RegExp(`SUMMING_JOB_ID=${dryRun.id}`));
    const envFiles = args.split("\n").filter((value, index, all) => all[index - 1] === "--env-file");
    assert.equal(envFiles.length, 1);
    assert.equal(existsSync(envFiles[0]!), false);
    assert.equal(existsSync(join(dataRoot, "projects", "demo", "runs", dryRun.id, "environment.json")), false);

    const validate = await client.submit("demo", "repo", "validate", revision, archive);
    assert.equal((await completedJob(client, "demo", "repo", validate.id)).status, "completed");
    assert.match(readFileSync(dockerArgs, "utf8"), /--network\nnone/);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
