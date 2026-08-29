import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
): {
  malformedId: string;
  queuedId: string;
  payloadRetainedId: string;
  payloadPrunedId: string;
} {
  const malformedId = randomUUID();
  const queuedId = randomUUID();
  let payloadRetainedId = "";
  let payloadPrunedId = "";
  mkdirSync(join(runs, malformedId));
  writeFileSync(join(runs, malformedId, "job.json"), "operator recovery note\n");
  mkdirSync(join(runs, queuedId));
  writeFileSync(join(runs, queuedId, "job.json"), JSON.stringify({
    id: queuedId,
    projectId: "demo",
    workspaceId: "repo",
    action: "provision",
    provisionId: "rotate-api",
    revision,
    status: "queued",
    createdAt: new Date(0).toISOString(),
  }));
  writeFileSync(
    join(runs, queuedId, `.job-999-${randomUUID()}.tmp`),
    '{"status":"interrupted write"',
  );
  for (const file of ["source.tar", "environment.json", "release-config.json"]) {
    writeFileSync(join(runs, queuedId, file), `${file}\n`, { mode: 0o600 });
  }
  mkdirSync(join(runs, queuedId, "provisioning"));
  writeFileSync(
    join(runs, queuedId, "provisioning", "result.json"),
    '{"generated":"secret"}\n',
    { mode: 0o600 },
  );
  for (let index = 0; index < 105; index += 1) {
    const id = randomUUID();
    if (index === 104) payloadRetainedId = id;
    if (index === 80) payloadPrunedId = id;
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
    for (const file of ["source.tar", "environment.json", "release-config.json"]) {
      writeFileSync(join(directory, file), `${file}\n`, { mode: 0o600 });
    }
  }
  return { malformedId, queuedId, payloadRetainedId, payloadPrunedId };
}

test("runner snapshots an encrypted workspace environment and injects one temporary env-file", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-test-"));
  const repository = join(root, "repo");
  const configRoot = join(root, "config");
  const dataRoot = join(root, "data");
  const socket = join(root, "runner.sock");
  const fakeDocker = join(root, "docker");
  const dockerArgs = join(root, "docker.args");
  const imageBuilt = join(root, "image-built");
  const failLiveRun = join(root, "fail-live-run");
  const appData = join(root, "app-data");
  mkdirSync(repository);
  mkdirSync(configRoot);
  mkdirSync(join(repository, ".summing"));
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  writeFileSync(join(repository, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repository, "app.json"), "{}\n");
  writeFileSync(join(repository, ".summing", "provisioning.json"), JSON.stringify({
    version: 1,
    profiles: [{
      id: "rotate-api",
      outputs: [{
        name: "rotated_token",
        environment: "ROTATED_TOKEN",
        minimumLength: 20,
        maximumLength: 200,
      }],
      consume: ["BOOTSTRAP_CODE"],
    }, {
      id: "invalid-result",
      outputs: [{
        name: "invalid_token",
        environment: "INVALID_TOKEN",
        minimumLength: 20,
        maximumLength: 200,
      }],
      consume: [],
    }],
  }));
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
if [ "$1" = image ]; then
  if [ -f "${imageBuilt}" ]; then printf '%s\n' 'sha256:runner-test-image'; exit 0; fi
  exit 1
fi
if [ "$1" = build ]; then : > "${imageBuilt}"; exit 0; fi
if [ "$1" = run ]; then
  printf '%s\n' "$@" > "${dockerArgs}"
  job=""
  runtime_env=""
  previous=""
  provision=""
  provision_dir=""
  live=false
  for value in "$@"; do
    case "$value" in SUMMING_JOB_ID=*) job="\${value#*=}" ;; esac
    case "$value" in SUMMING_PROVISION_ID=*) provision="\${value#*=}" ;; esac
    case "$value" in DRY_RUN=false) live=true ;; esac
    if [ "$previous" = "--env-file" ]; then runtime_env="$value"; fi
    if [ "$previous" = "--volume" ]; then
      case "$value" in *:/run/summing-provision) provision_dir="\${value%:*}" ;; esac
    fi
    previous="$value"
  done
  secret=$(sed -n 's/^API_TOKEN=//p' "$runtime_env")
  printf 'application said key=%s\n' "$secret"
  if [ -n "$provision" ]; then
    generated="generated-rotated-secret-123456789"
    printf 'application accidentally said generated=%s\n' "$generated"
    if [ "$provision" = invalid-result ]; then
      printf '{"version":1,"profile":"%s","secrets":{"invalid_token":"%s"}}\n' "$provision" "$generated" > "$provision_dir/result.json"
      chmod 644 "$provision_dir/result.json"
    else
      printf '{"version":1,"profile":"%s","secrets":{"rotated_token":"%s"}}\n' "$provision" "$generated" > "$provision_dir/result.json"
      chmod 600 "$provision_dir/result.json"
    fi
    exit 0
  fi
  if [ -n "$job" ]; then
    mkdir -p "${appData}/dry-runs/$job"
    printf '{"status":"completed","key":"%s"}\n' "$secret" > "${appData}/dry-runs/$job/manifest.json"
    if [ "$live" = true ]; then
      printf 'fake-photo' > "${appData}/dry-runs/$job/photo-01.jpg"
      printf 'fake-audio' > "${appData}/dry-runs/$job/audio-01.mp3"
      printf 'fake-mp4' > "${appData}/dry-runs/$job/video-01.mp4"
      printf 'fake-animation' > "${appData}/dry-runs/$job/animation-01.gif"
      printf 'fake-voice' > "${appData}/dry-runs/$job/voice-01.ogg"
      printf '{"schemaVersion":1,"messages":[{"id":"live-photo","type":"photo","text":"Photo ready.","artifact":"photo-01.jpg"},{"id":"live-audio","type":"audio","text":"Audio ready.","artifact":"audio-01.mp3"},{"id":"live-video","type":"video","text":"Video ready.","artifact":"video-01.mp4"},{"id":"live-animation","type":"animation","text":"Animation ready.","artifact":"animation-01.gif"},{"id":"live-voice","type":"voice","text":"Voice ready.","artifact":"voice-01.ogg"}]}\n' > "${appData}/dry-runs/$job/portal-messages.json"
      if [ -f "${failLiveRun}" ]; then exit 7; fi
    else
      printf '<html>report</html>\n' > "${appData}/dry-runs/$job/report.html"
      printf '{"schemaVersion":1,"messages":[{"id":"dry-run-report","type":"document","text":"Informational dry-run report is ready.","artifact":"report.html"}]}\n' > "${appData}/dry-runs/$job/portal-messages.json"
    fi
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
    assert.deepEqual(await client.health(), {
      ok: true,
      version: readFileSync(join(process.cwd(), "VERSION"), "utf8").trim(),
      protocolVersion: 6,
      queued: 0,
      running: 0,
      maxParallelJobs: 2,
      runTimeoutHours: 12,
      servicePortRange: [20_000, 29_999],
    });

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
      [
        "LOG_LEVEL=info",
        "API_TOKEN=rotated-runtime-secret-987654321",
        "BOOTSTRAP_CODE=one-shot-bootstrap-secret",
        "ROTATED_TOKEN=",
        "",
      ].join("\n"),
      1,
    );
    assert.equal(saved.revision, 2);
    await assert.rejects(
      client.saveEnvironment("demo", "repo", "API_TOKEN=stale\n", 1),
      /changed from revision 1 to 2/,
    );

    const idempotencyKey = "b".repeat(64);
    const [build, duplicateBuild] = await Promise.all([
      client.submit("demo", "repo", "build", revision, archive, { idempotencyKey }),
      client.submit("demo", "repo", "build", revision, archive, { idempotencyKey }),
    ]);
    assert.equal(duplicateBuild.id, build.id);
    assert.equal(build.idempotencyKey, idempotencyKey);
    const buildCompleted = await completedJob(client, "demo", "repo", build.id);
    assert.equal(buildCompleted.status, "completed");
    assert.equal(buildCompleted.trigger, "manual");
    await assert.rejects(
      client.submit("demo", "repo", "validate", revision, archive, { idempotencyKey }),
      /idempotency key was reused for a different runner job/,
    );

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
    assert.equal(dryRunCompleted.releaseId, dryRun.id);
    assert.match(dryRunCompleted.archiveSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(dryRunCompleted.configSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(dryRunCompleted.environmentSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(dryRunCompleted.imageId, "sha256:runner-test-image");
    assert.equal(dryRunCompleted.artifactCount, 3);
    assert.equal(dryRunCompleted.portalMessageCount, 1);
    assert.deepEqual(
      (await client.artifacts("demo", dryRun.id)).map((artifact) => artifact.name),
      ["manifest.json", "report.html", "portal-messages.json"],
    );
    assert.equal(
      (await client.artifact("demo", dryRun.id, "manifest.json")).content,
      '{"status":"completed","key":"[REDACTED]"}\n',
    );
    const portalMessages = await client.portalMessages("demo", "repo", dryRun.id);
    assert.deepEqual(portalMessages.messages, [{
      id: "dry-run-report",
      type: "document",
      text: "Informational dry-run report is ready.",
      artifact: "report.html",
    }]);

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
      ["report.html", "portal-messages.json"],
    );
    await client.deleteArtifact("demo", "repo", dryRun.id, "report.html");
    await client.deleteArtifact("demo", "repo", dryRun.id, "portal-messages.json");
    assert.deepEqual(await client.artifacts("demo", dryRun.id), []);
    assert.equal(
      (await client.jobs("demo", "repo")).find((job) => job.id === dryRun.id)?.artifactCount,
      0,
    );
    assert.equal(
      readdirSync(join(dataRoot, "artifact-trash", "demo", dryRun.id)).length,
      3,
    );
    assert.doesNotMatch(await client.log("demo", dryRun.id), /rotated-runtime-secret/);
    assert.match(await client.log("demo", dryRun.id), /application said key=\[REDACTED\]/);
    const args = readFileSync(dockerArgs, "utf8");
    assert.match(args, new RegExp(`SUMMING_JOB_ID=${dryRun.id}`));
    assert.match(args, /SUMMING_PORTAL_TRANSPORT=true/);
    assert.match(args, /SUMMING_PROJECT_DATA_PATH=\/app\/data/);
    assert.match(
      args,
      new RegExp(`/projects/demo/runs/${dryRun.id}/release-config\\.json:/run/config\\.json:ro`),
    );
    assert.doesNotMatch(args, /missing\.json:\/run\/config\.json/);
    const envFiles = args.split("\n").filter((value, index, all) => all[index - 1] === "--env-file");
    assert.equal(envFiles.length, 1);
    assert.equal(existsSync(envFiles[0]!), false);
    const releaseDirectory = join(dataRoot, "projects", "demo", "runs", dryRun.id);
    assert.equal(existsSync(join(releaseDirectory, "source.tar")), true);
    assert.equal(existsSync(join(releaseDirectory, "environment.json")), true);
    assert.equal(existsSync(join(releaseDirectory, "release-config.json")), true);

    const liveRun = await client.submit("demo", "repo", "run", revision, archive);
    const liveRunCompleted = await completedJob(client, "demo", "repo", liveRun.id);
    assert.equal(liveRunCompleted.status, "completed");
    assert.equal(liveRunCompleted.artifactCount, 7);
    assert.equal(liveRunCompleted.portalMessageCount, 5);
    assert.deepEqual(
      (await client.artifacts("demo", liveRun.id)).map((artifact) => artifact.name).sort(),
      [
        "animation-01.gif",
        "audio-01.mp3",
        "manifest.json",
        "photo-01.jpg",
        "portal-messages.json",
        "video-01.mp4",
        "voice-01.ogg",
      ],
    );
    assert.deepEqual((await client.portalMessages("demo", "repo", liveRun.id)).messages, [{
      id: "live-photo",
      type: "photo",
      text: "Photo ready.",
      artifact: "photo-01.jpg",
    }, {
      id: "live-audio",
      type: "audio",
      text: "Audio ready.",
      artifact: "audio-01.mp3",
    }, {
      id: "live-video",
      type: "video",
      text: "Video ready.",
      artifact: "video-01.mp4",
    }, {
      id: "live-animation",
      type: "animation",
      text: "Animation ready.",
      artifact: "animation-01.gif",
    }, {
      id: "live-voice",
      type: "voice",
      text: "Voice ready.",
      artifact: "voice-01.ogg",
    }]);
    const liveVideo = await client.artifactData("demo", liveRun.id, "video-01.mp4");
    assert.equal(liveVideo.contentType, "video/mp4");
    assert.equal(Buffer.from(liveVideo.data).toString("utf8"), "fake-mp4");
    await assert.rejects(
      client.artifact("demo", liveRun.id, "video-01.mp4"),
      /binary artifact is not available as text/,
    );
    const liveArgs = readFileSync(dockerArgs, "utf8");
    assert.match(liveArgs, new RegExp(`SUMMING_JOB_ID=${liveRun.id}`));
    assert.match(liveArgs, /DRY_RUN=false/);
    assert.match(liveArgs, /SUMMING_PORTAL_TRANSPORT=true/);
    assert.match(liveArgs, new RegExp(`DRY_RUN_ARTIFACT_DIR=/app/data/dry-runs/${liveRun.id}`));

    writeFileSync(failLiveRun, "fail\n");
    const failedLiveRun = await client.submit("demo", "repo", "run", revision, archive);
    const failedLiveRunCompleted = await completedJob(
      client,
      "demo",
      "repo",
      failedLiveRun.id,
    );
    assert.equal(failedLiveRunCompleted.status, "failed");
    assert.equal(failedLiveRunCompleted.exitCode, 7);
    assert.equal(failedLiveRunCompleted.artifactCount, 7);
    assert.equal(failedLiveRunCompleted.portalMessageCount, 5);
    assert.equal(
      (await client.portalMessages("demo", "repo", failedLiveRun.id)).messages.length,
      5,
    );
    rmSync(failLiveRun);

    await assert.rejects(
      client.submit("demo", "repo", "provision", revision, archive, {
        trigger: "schedule",
        scheduleId: randomUUID(),
        scheduledFor: "2026-08-17T07:00:00.000Z",
        provisionId: "rotate-api",
      }),
    );
    await assert.rejects(
      client.submit("demo", "repo", "dry-run", revision, archive, {
        provisionId: "rotate-api",
      }),
    );

    const provision = await client.submit(
      "demo",
      "repo",
      "provision",
      revision,
      archive,
      { provisionId: "rotate-api" },
    );
    const provisionCompleted = await completedJob(client, "demo", "repo", provision.id);
    assert.equal(provisionCompleted.status, "completed");
    assert.equal(provisionCompleted.releaseId, undefined);
    assert.equal(provisionCompleted.environmentRevision, 2);
    assert.equal(provisionCompleted.resultingEnvironmentRevision, 3);
    assert.deepEqual(provisionCompleted.provisionedVariables, ["ROTATED_TOKEN"]);
    assert.deepEqual(provisionCompleted.consumedVariables, ["BOOTSTRAP_CODE"]);
    const provisionedEnvironment = await client.environment("demo", "repo");
    assert.equal(provisionedEnvironment.revision, 3);
    assert.match(provisionedEnvironment.text, /ROTATED_TOKEN="generated-rotated-secret-123456789"/);
    assert.doesNotMatch(provisionedEnvironment.text, /BOOTSTRAP_CODE/);
    assert.doesNotMatch(await client.log("demo", provision.id), /generated-rotated-secret/);
    assert.match(await client.log("demo", provision.id), /workload output is suppressed/);
    assert.match(await client.log("demo", provision.id), /profile=rotate-api/);
    const encryptedAfterProvision = readFileSync(
      join(dataRoot, "environments", readdirSync(join(dataRoot, "environments"))[0]!),
      "utf8",
    );
    assert.doesNotMatch(encryptedAfterProvision, /generated-rotated-secret/);
    assert.doesNotMatch(
      readFileSync(join(dataRoot, "projects", "demo", "runs", provision.id, "job.json"), "utf8"),
      /generated-rotated-secret/,
    );
    assert.equal(
      existsSync(join(dataRoot, "projects", "demo", "runs", provision.id, "provisioning")),
      false,
    );
    for (const file of ["source.tar", "environment.json", "release-config.json"]) {
      assert.equal(
        existsSync(join(dataRoot, "projects", "demo", "runs", provision.id, file)),
        false,
      );
    }
    await assert.rejects(
      client.replay("demo", "repo", provision.id, "f".repeat(64)),
      /not replayable/,
    );

    const invalidProvision = await client.submit(
      "demo",
      "repo",
      "provision",
      revision,
      archive,
      { provisionId: "invalid-result" },
    );
    const invalidProvisionCompleted = await completedJob(
      client,
      "demo",
      "repo",
      invalidProvision.id,
    );
    assert.equal(invalidProvisionCompleted.status, "failed");
    assert.match(invalidProvisionCompleted.error ?? "", /mode 0600/);
    assert.equal((await client.environment("demo", "repo")).revision, 3);
    assert.doesNotMatch(await client.log("demo", invalidProvision.id), /generated-rotated-secret/);
    assert.equal(
      existsSync(join(dataRoot, "projects", "demo", "runs", invalidProvision.id, "provisioning")),
      false,
    );
    for (const file of ["source.tar", "environment.json", "release-config.json"]) {
      assert.equal(
        existsSync(join(dataRoot, "projects", "demo", "runs", invalidProvision.id, file)),
        false,
      );
    }

    const replayKey = "c".repeat(64);
    const replay = await client.replay("demo", "repo", dryRun.id, replayKey);
    const replayCompleted = await completedJob(client, "demo", "repo", replay.id);
    assert.equal(replayCompleted.status, "completed");
    assert.equal(replayCompleted.trigger, "replay");
    assert.equal(replayCompleted.replayOfJobId, dryRun.id);
    assert.equal(replayCompleted.releaseId, dryRun.id);
    assert.equal(replayCompleted.environmentRevision, dryRunCompleted.environmentRevision);
    assert.equal(replayCompleted.archiveSha256, dryRunCompleted.archiveSha256);
    assert.equal(replayCompleted.configSha256, dryRunCompleted.configSha256);
    assert.equal(replayCompleted.environmentSha256, dryRunCompleted.environmentSha256);
    assert.equal(replayCompleted.imageId, dryRunCompleted.imageId);
    assert.equal((await client.replay("demo", "repo", dryRun.id, replayKey)).id, replay.id);
    assert.match(await client.log("demo", replay.id), new RegExp(`replay-of=${dryRun.id}`));
    assert.equal(
      readFileSync(
        join(dataRoot, "projects", "demo", "runs", replay.id, "release-config.json"),
        "utf8",
      ),
      "{}\n",
    );
    await assert.rejects(
      client.replay("demo", "another-workspace", dryRun.id, "d".repeat(64)),
      /workspace|configured/,
    );
    writeFileSync(join(releaseDirectory, "release-config.json"), "{\"tampered\":true}\n");
    await assert.rejects(
      client.replay("demo", "repo", dryRun.id, "e".repeat(64)),
      /integrity check failed/,
    );
    writeFileSync(join(releaseDirectory, "release-config.json"), "{}\n", { mode: 0o600 });

    const runs = join(dataRoot, "projects", "demo", "runs");
    const {
      malformedId,
      queuedId,
      payloadRetainedId,
      payloadPrunedId,
    } = seedTerminalJobHistory(runs, revision);

    const validate = await client.submit("demo", "repo", "validate", revision, archive);
    assert.equal((await completedJob(client, "demo", "repo", validate.id)).status, "completed");
    const validationArgs = readFileSync(dockerArgs, "utf8");
    assert.match(validationArgs, /--network\nnone/);
    assert.match(validationArgs, /dist\/src\/main\.js\n--validate/);
    assert.equal(readdirSync(runs).length, 102);
    assert.equal(existsSync(join(runs, validate.id)), true);
    assert.equal(existsSync(join(runs, dryRun.id)), true);
    assert.equal(existsSync(join(runs, malformedId)), true);
    assert.equal(existsSync(join(runs, queuedId)), true);
    assert.equal(existsSync(join(releaseDirectory, "source.tar")), true);
    assert.equal(existsSync(join(runs, payloadRetainedId, "source.tar")), true);
    assert.equal(existsSync(join(runs, payloadPrunedId)), true);
    assert.equal(existsSync(join(runs, payloadPrunedId, "source.tar")), false);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner persists a constrained managed project registration and enforces its workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-registration-"));
  const configRoot = join(root, "static-config");
  const dataRoot = join(root, "data");
  const managedDataRoot = join(root, "managed-data");
  const socket = join(root, "runner.sock");
  mkdirSync(configRoot);
  let server = new ProjectRunnerServer(
    socket,
    dataRoot,
    configRoot,
    join(root, "unused-docker"),
    Buffer.alloc(32, 11),
    true,
    [],
    join(root, "migration.sock"),
    managedDataRoot,
  );
  try {
    await server.start();
    let client = new ProjectRunnerClient(socket);
    await assert.rejects(client.registeredProject("managed-demo"), /not configured/);
    assert.deepEqual(
      await client.registerProject("managed-demo", ["repo", "frontend"]),
      {
        projectId: "managed-demo",
        workspaceIds: ["repo", "frontend"],
        source: "managed",
      },
    );
    const stored = JSON.parse(
      readFileSync(join(dataRoot, "managed-projects", "managed-demo.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(stored.configSourcePaths, ["config.json", "config.example.json"]);
    assert.equal(stored.dataPath, join(managedDataRoot, "managed-demo", "data"));
    assert.equal(stored.network, true);
    assert.deepEqual(await client.registeredProject("managed-demo"), {
      projectId: "managed-demo",
      workspaceIds: ["repo", "frontend"],
      source: "managed",
    });
    await server.close();
    server = new ProjectRunnerServer(
      socket,
      dataRoot,
      configRoot,
      join(root, "unused-docker"),
      Buffer.alloc(32, 11),
      true,
      [],
      join(root, "migration.sock"),
      managedDataRoot,
    );
    await server.start();
    client = new ProjectRunnerClient(socket);
    assert.deepEqual(await client.registeredProject("managed-demo"), {
      projectId: "managed-demo",
      workspaceIds: ["repo", "frontend"],
      source: "managed",
    });
    assert.equal((await client.environment("managed-demo", "repo")).revision, 0);
    await assert.rejects(
      client.environment("managed-demo", "unknown"),
      /workspace is not configured/,
    );
    await assert.rejects(
      client.registerProject("../escape", ["repo"]),
      /invalid runner project id/,
    );

    writeFileSync(join(configRoot, "static-demo.json"), JSON.stringify({
      configSourcePaths: ["config.json"],
      dataPath: join(root, "static-data"),
      network: false,
    }));
    assert.deepEqual(await client.registerProject("static-demo", ["repo"]), {
      projectId: "static-demo",
      workspaceIds: ["repo"],
      source: "static",
    });
    assert.equal(existsSync(join(dataRoot, "managed-projects", "static-demo.json")), false);

    stored.dataPath = join(root, "attacker-selected-data");
    writeFileSync(
      join(dataRoot, "managed-projects", "managed-demo.json"),
      JSON.stringify(stored),
    );
    await assert.rejects(
      client.registeredProject("managed-demo"),
      /internal runner error/,
    );
    stored.dataPath = join(managedDataRoot, "managed-demo", "data");
    stored.envPath = join(root, "attacker-selected-env");
    writeFileSync(
      join(dataRoot, "managed-projects", "managed-demo.json"),
      JSON.stringify(stored),
    );
    await assert.rejects(
      client.registeredProject("managed-demo"),
      /internal runner error/,
    );
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed projects may omit snapshot config while static projects remain strict", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-optional-config-"));
  const repository = join(root, "repo");
  const configRoot = join(root, "static-config");
  const dataRoot = join(root, "data");
  const managedDataRoot = join(root, "managed-data");
  const socket = join(root, "runner.sock");
  const fakeDocker = join(root, "docker");
  mkdirSync(repository);
  mkdirSync(configRoot);
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  writeFileSync(join(repository, "Dockerfile"), "FROM scratch\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "image"]);
  writeFileSync(
    fakeDocker,
    `#!/bin/sh
if [ "$1" = image ]; then
  printf '%s\n' 'sha256:optional-config-test-image'
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
    Buffer.alloc(32, 12),
    true,
    [],
    join(root, "migration.sock"),
    managedDataRoot,
  );
  try {
    await server.start();
    const client = new ProjectRunnerClient(socket);
    await client.registerProject("managed-demo", ["repo"]);
    const inspector = new GitInspector(repository);
    const revision = await inspector.resolveRevision("HEAD");
    const archive = await inspector.archive(revision);
    const managedJob = await client.submit("managed-demo", "repo", "validate", revision, archive);
    const managedCompleted = await completedJob(client, "managed-demo", "repo", managedJob.id);
    assert.equal(managedCompleted.status, "completed");
    assert.equal(
      readFileSync(
        join(dataRoot, "projects", "managed-demo", "runs", managedJob.id, "release-config.json"),
        "utf8",
      ),
      "{}\n",
    );

    writeFileSync(join(configRoot, "static-demo.json"), JSON.stringify({
      configSourcePaths: ["config.json"],
      dataPath: join(root, "static-data"),
      network: false,
    }));
    await client.registerProject("static-demo", ["repo"]);
    const staticJob = await client.submit("static-demo", "repo", "validate", revision, archive);
    const staticCompleted = await completedJob(client, "static-demo", "repo", staticJob.id);
    assert.equal(staticCompleted.status, "failed");
    assert.match(staticCompleted.error ?? "", /project config is missing from source snapshot/);
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

test("runner executes independent projects in parallel and serializes each project", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-parallel-"));
  const repository = join(root, "repo");
  const configRoot = join(root, "config");
  const dataRoot = join(root, "data");
  const socket = join(root, "runner.sock");
  const fakeDocker = join(root, "docker");
  const markers = join(root, "markers");
  const appConfig = join(root, "app.json");
  mkdirSync(repository);
  mkdirSync(configRoot);
  mkdirSync(markers);
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  writeFileSync(join(repository, "Dockerfile"), "FROM scratch\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "image"]);
  writeFileSync(appConfig, "{}\n");
  for (const project of ["alpha", "beta"]) {
    writeFileSync(join(configRoot, `${project}.json`), JSON.stringify({
      configPath: appConfig,
      dataPath: join(root, `${project}-data`),
      network: false,
    }));
  }
  writeFileSync(fakeDocker, `#!/bin/sh
if [ "$1" = image ]; then printf '%s\n' 'sha256:parallel-test-image'; exit 0; fi
if [ "$1" = run ]; then
  name=""
  previous=""
  for value in "$@"; do
    if [ "$previous" = "--name" ]; then name="$value"; fi
    previous="$value"
  done
  : > "${markers}/$name"
  sleep 1
fi
exit 0
`, { mode: 0o700 });
  const server = new ProjectRunnerServer(
    socket,
    dataRoot,
    configRoot,
    fakeDocker,
    Buffer.alloc(32, 10),
  );
  try {
    await server.start();
    const inspector = new GitInspector(repository);
    const revision = await inspector.resolveRevision("HEAD");
    const archive = await inspector.archive(revision);
    const client = new ProjectRunnerClient(socket);
    const alpha = await client.submit("alpha", "repo", "run", revision, archive);
    const alphaMarker = join(markers, `summing-alpha-${alpha.id.slice(0, 8)}`);
    const alphaDeadline = Date.now() + 5_000;
    while (!existsSync(alphaMarker)) {
      if (Date.now() > alphaDeadline) throw new Error("first project did not start");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }

    const alphaQueued = await client.submit("alpha", "repo", "run", revision, archive);
    const beta = await client.submit("beta", "repo", "run", revision, archive);
    const betaMarker = join(markers, `summing-beta-${beta.id.slice(0, 8)}`);
    const betaDeadline = Date.now() + 5_000;
    while (!existsSync(betaMarker)) {
      if (Date.now() > betaDeadline) throw new Error("independent project did not start");
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }

    assert.equal(
      existsSync(join(markers, `summing-alpha-${alphaQueued.id.slice(0, 8)}`)),
      false,
    );
    assert.equal(
      (await client.jobs("alpha", "repo")).find((job) => job.id === alphaQueued.id)?.status,
      "queued",
    );
    assert.deepEqual(
      (({ running, queued, maxParallelJobs }) => ({ running, queued, maxParallelJobs }))(
        await client.health(),
      ),
      { running: 2, queued: 1, maxParallelJobs: 2 },
    );

    await Promise.all([
      completedJob(client, "alpha", "repo", alpha.id),
      completedJob(client, "beta", "repo", beta.id),
    ]);
    assert.equal(
      (await completedJob(client, "alpha", "repo", alphaQueued.id)).status,
      "completed",
    );
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

test("runner marks unfinished jobs interrupted on startup and retains recovery evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-retention-"));
  const dataRoot = join(root, "data");
  const runs = join(dataRoot, "projects", "demo", "runs");
  const revision = "a".repeat(40);
  mkdirSync(runs, { recursive: true });
  try {
    const {
      malformedId,
      queuedId,
      payloadRetainedId,
      payloadPrunedId,
    } = seedTerminalJobHistory(runs, revision);
    const queuedMetadata = join(runs, queuedId, "job.json");
    const queuedMetadataInode = lstatSync(queuedMetadata).ino;

    new ProjectRunnerServer(
      join(root, "runner.sock"),
      dataRoot,
      join(root, "config"),
      "/bin/false",
      Buffer.alloc(32, 5),
    );

    assert.equal(readdirSync(runs).length, 101);
    assert.equal(existsSync(join(runs, queuedId)), true);
    assert.equal(existsSync(join(runs, malformedId)), true);
    assert.equal(existsSync(join(runs, payloadRetainedId, "source.tar")), true);
    assert.equal(existsSync(join(runs, payloadPrunedId)), true);
    assert.equal(existsSync(join(runs, payloadPrunedId, "source.tar")), false);
    assert.notEqual(lstatSync(queuedMetadata).ino, queuedMetadataInode);
    const recovered = JSON.parse(
      readFileSync(queuedMetadata, "utf8"),
    ) as { status: string; error: string; completedAt?: string };
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.error, "runner restarted before the job completed");
    assert.ok(recovered.completedAt);
    assert.match(readFileSync(join(runs, queuedId, "job.log"), "utf8"), /not restarted automatically/);
    assert.equal(existsSync(join(runs, queuedId, "provisioning")), false);
    for (const file of ["source.tar", "environment.json", "release-config.json"]) {
      assert.equal(existsSync(join(runs, queuedId, file)), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner deploys retained Releases as persistent services with restart and rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-service-"));
  const repository = join(root, "repo");
  const configRoot = join(root, "config");
  const dataRoot = join(root, "data");
  const appData = join(root, "app-data");
  const socket = join(root, "runner.sock");
  const dockerState = join(root, "docker-state");
  const fakeDocker = join(root, "docker");
  mkdirSync(repository, { recursive: true });
  mkdirSync(configRoot);
  mkdirSync(dockerState);
  mkdirSync(join(repository, ".summing"));
  writeFileSync(join(repository, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(repository, "config.json"), "{}\n");
  writeFileSync(join(repository, ".summing", "services.json"), JSON.stringify({
    version: 1,
    services: {
      api: { command: ["node", "dist/src/api.js"], containerPort: 3_000 },
      worker: { command: ["node", "dist/src/worker.js"], startupTimeoutSeconds: 5 },
    },
  }));
  execFileSync("git", ["init", "--initial-branch=master", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", ["-C", repository, "commit", "-m", "service v1"]);
  writeFileSync(join(configRoot, "demo.json"), JSON.stringify({
    configSourcePaths: ["config.json"],
    dataPath: appData,
    network: true,
  }));
  writeFileSync(fakeDocker, `#!/bin/sh
set -eu
state='${dockerState}'
command="$1"
shift
printf '%s\n' "$command" "$@" >> "$state/docker-args"
case "$command" in
  image)
    if [ "$1" = inspect ] && [ -f "$state/image-built" ]; then
      printf '%s\n' 'sha256:service-test-image'
      exit 0
    fi
    exit 1
    ;;
  build)
    : > "$state/image-built"
    exit 0
    ;;
  run)
    detached=false
    name=''
    previous=''
    for argument in "$@"; do
      if [ "$argument" = '--detach' ]; then detached=true; fi
      if [ "$previous" = '--name' ]; then name="$argument"; fi
      previous="$argument"
    done
    if [ "$detached" = true ]; then
      if [ -f "$state/fail-next-service" ]; then
        rm -f "$state/fail-next-service"
        exit 17
      fi
      : > "$state/$name.exists"
      : > "$state/$name.running"
      printf '%s\n' "$name"
    fi
    exit 0
    ;;
  container)
    name=''
    for argument in "$@"; do name="$argument"; done
    if [ ! -f "$state/$name.exists" ]; then exit 1; fi
    if [ -f "$state/$name.running" ]; then printf '%s\n' true; else printf '%s\n' false; fi
    ;;
  stop)
    name=''
    for argument in "$@"; do name="$argument"; done
    rm -f "$state/$name.running"
    ;;
  start|restart)
    name=''
    for argument in "$@"; do name="$argument"; done
    if [ ! -f "$state/$name.exists" ]; then exit 1; fi
    : > "$state/$name.running"
    ;;
  rm)
    name=''
    for argument in "$@"; do name="$argument"; done
    rm -f "$state/$name.exists" "$state/$name.running"
    ;;
  logs)
    printf '%s\n' 'persistent worker log'
    ;;
  *) exit 1 ;;
esac
`);
  chmodSync(fakeDocker, 0o700);
  let server = new ProjectRunnerServer(
    socket,
    dataRoot,
    configRoot,
    fakeDocker,
    Buffer.alloc(32, 17),
  );
  try {
    await server.start();
    let client = new ProjectRunnerClient(socket);
    const inspector = new GitInspector(repository);
    const firstRevision = await inspector.resolveRevision("HEAD");
    const firstReleaseJob = await client.submit(
      "demo",
      "repo",
      "validate",
      firstRevision,
      await inspector.archive(firstRevision),
    );
    const firstRelease = await completedJob(client, "demo", "repo", firstReleaseJob.id);
    assert.equal(firstRelease.status, "completed");
    assert.match(
      await client.log("demo", firstRelease.id),
      /service manifest and image validated; startup is deferred/,
    );
    assert.doesNotMatch(readFileSync(join(dockerState, "docker-args"), "utf8"), /dist\/src\/main\.js/);
    const deployed = await client.deployService(
      "demo",
      "repo",
      "worker",
      firstRelease.id,
      "a".repeat(64),
    );
    assert.equal(deployed.status, "running");
    assert.equal(deployed.desiredState, "running");
    assert.equal(deployed.current?.releaseId, firstRelease.releaseId);
    assert.equal(deployed.localEndpoint, null);
    const api = await client.deployService(
      "demo",
      "repo",
      "api",
      firstRelease.id,
      "1".repeat(64),
    );
    assert.match(api.localEndpoint ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    const apiPort = new URL(api.localEndpoint!).port;
    assert.match(readFileSync(join(dockerState, "docker-args"), "utf8"), new RegExp(
      `127\\.0\\.0\\.1:${apiPort}:3000`,
    ));
    assert.deepEqual((await client.services("demo", "repo")).map((item) => item.name).sort(), [
      "api",
      "worker",
    ]);
    assert.match(await client.serviceLog("demo", "repo", "worker"), /persistent worker log/);
    assert.equal((await client.serviceAction(
      "demo", "repo", "worker", "restart", "b".repeat(64),
    )).status, "running");
    assert.equal((await client.serviceAction(
      "demo", "repo", "worker", "stop", "c".repeat(64),
    )).status, "stopped");
    assert.equal((await client.serviceAction(
      "demo", "repo", "worker", "start", "d".repeat(64),
    )).status, "running");

    writeFileSync(join(repository, "VERSION.txt"), "v2\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "service v2"]);
    const secondRevision = await inspector.resolveRevision("HEAD");
    const secondReleaseJob = await client.submit(
      "demo",
      "repo",
      "validate",
      secondRevision,
      await inspector.archive(secondRevision),
    );
    const secondRelease = await completedJob(client, "demo", "repo", secondReleaseJob.id);
    const upgraded = await client.deployService(
      "demo",
      "repo",
      "worker",
      secondRelease.id,
      "e".repeat(64),
    );
    assert.equal(upgraded.current?.revision, secondRevision);
    assert.equal(upgraded.previous?.revision, firstRevision);
    const rolledBack = await client.serviceAction(
      "demo",
      "repo",
      "worker",
      "rollback",
      "f".repeat(64),
    );
    assert.equal(rolledBack.current?.revision, firstRevision);
    assert.equal(rolledBack.previous?.revision, secondRevision);
    writeFileSync(join(dockerState, "fail-next-service"), "1\n");
    await assert.rejects(
      client.deployService(
        "demo",
        "repo",
        "worker",
        secondRelease.id,
        "9".repeat(64),
      ),
      /service deployment failed/,
    );
    const restored = (await client.services("demo", "repo")).find((item) => item.name === "worker");
    assert.equal(restored?.status, "running");
    assert.equal(restored?.current?.revision, firstRevision);
    assert.match(restored?.error ?? "", /start exited with code 17/);

    await server.close();
    server = new ProjectRunnerServer(
      socket,
      dataRoot,
      configRoot,
      fakeDocker,
      Buffer.alloc(32, 17),
    );
    await server.start();
    client = new ProjectRunnerClient(socket);
    const recovered = await client.services("demo", "repo");
    assert.equal(recovered.find((item) => item.name === "worker")?.status, "running");
    assert.equal(recovered.find((item) => item.name === "worker")?.current?.revision, firstRevision);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
