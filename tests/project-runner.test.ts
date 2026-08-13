import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      envPath: join(root, "app.env"),
      dataPath: appData,
    }),
  );
  writeFileSync(join(root, "app.json"), "{}\n");
  writeFileSync(join(root, "app.env"), "OPENAI_API_KEY=test\n");
  writeFileSync(
    fakeDocker,
    `#!/bin/sh
if [ "$1" = image ]; then exit 1; fi
if [ "$1" = run ]; then
  printf '%s\n' "$@" > "${dockerArgs}"
  job=""
  for value in "$@"; do
    case "$value" in SUMMING_JOB_ID=*) job="\${value#*=}" ;; esac
  done
  if [ -n "$job" ]; then
    mkdir -p "${appData}/dry-runs/$job"
    printf '{"status":"completed"}\n' > "${appData}/dry-runs/$job/manifest.json"
    printf '<html>report</html>\n' > "${appData}/dry-runs/$job/report.html"
  fi
fi
exit 0
`,
  );
  chmodSync(fakeDocker, 0o700);
  const server = new ProjectRunnerServer(socket, dataRoot, configRoot, fakeDocker);
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
      '{"status":"completed"}\n',
    );
    await assert.rejects(
      client.artifact("demo", dryRun.id, "../app.env"),
      /invalid artifact name/,
    );
    const args = readFileSync(dockerArgs, "utf8");
    assert.match(args, new RegExp(`SUMMING_JOB_ID=${dryRun.id}`));
    assert.match(args, new RegExp(`SUMMING_REVISION=${revision}`));
    assert.match(args, new RegExp(`DRY_RUN_ARTIFACT_DIR=/app/data/dry-runs/${dryRun.id}`));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
