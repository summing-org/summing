import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProjectRunnerServer } from "../src/project-runner-server.js";
import { ProjectRunnerClient } from "../src/project-runner-client.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "service-recovery-"));
  const data = join(root, "data"), config = join(root, "config"), dockerState = join(root, "docker-state");
  const appData = join(root, "app-data"), serviceRoot = join(data, "projects", "demo", "services", "repo", "worker");
  for (const path of [config, dockerState, serviceRoot]) mkdirSync(path, { recursive: true });
  writeFileSync(join(config, "demo.json"), JSON.stringify({ configSourcePaths: ["config.json"], dataPath: appData, network: false }));
  const docker = join(root, "docker");
  writeFileSync(docker, `#!/bin/sh
set -eu
state='${dockerState}'
command="$1"
shift
printf '%s\\n' "$command $*" >> "$state/commands"
name=''
for argument in "$@"; do name="$argument"; done
case "$command" in
  container)
    [ -f "$state/$name.exists" ] || exit 1
    case "$*" in *RestartCount*) printf '3\\n'; exit 0 ;; esac
    if [ -f "$state/$name.running" ]; then printf 'true\\n'; else printf 'false\\n'; fi
    ;;
  start|restart)
    [ -f "$state/$name.exists" ] || exit 1
    : > "$state/$name.running"
    ;;
  stop) rm -f "$state/$name.running" ;;
  rm) rm -f "$state/$name.running" "$state/$name.exists" ;;
  run)
    previous=''
    for argument in "$@"; do
      if [ "$previous" = '--name' ]; then name="$argument"; break; fi
      previous="$argument"
    done
    : > "$state/$name.exists"
    : > "$state/$name.running"
    ;;
  *) exit 1 ;;
esac
`);
  chmodSync(docker, 0o700);
  const deployment = (revision: string) => {
    const deploymentId = randomUUID();
    const dir = join(serviceRoot, "deployments", deploymentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "release-config.json"), "{}", { mode: 0o600 });
    return { deploymentId, releaseId: randomUUID(), revision: revision.repeat(40), imageId: "sha256:test-image",
      environmentRevision: 0, deployedAt: new Date().toISOString(), containerName: `summing-svc-demo-repo-worker-${deploymentId.slice(0, 8)}`,
      hostPort: null, containerPort: null, healthPath: null, command: ["worker"], startupTimeoutSeconds: 5,
      configSha256: createHash("sha256").update("{}").digest("hex") };
  };
  const old = deployment("a"), candidate = deployment("b");
  const operation = { action: "deploy", releaseId: candidate.releaseId, idempotencyKey: "a".repeat(64) };
  const state: any = { version: 1, projectId: "demo", workspaceId: "repo", name: "worker", desiredState: "running",
    status: "deploying", activeDeploymentId: old.deploymentId, deployments: [candidate, old], updatedAt: new Date().toISOString(),
    pendingOperation: { operation, targetDeploymentId: candidate.deploymentId, previousDeploymentId: old.deploymentId,
      previousDesiredState: "running", phase: "prepared" } };
  const statePath = join(serviceRoot, "service.json");
  const save = () => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  const container = (item: typeof old, running: boolean) => {
    writeFileSync(join(dockerState, `${item.containerName}.exists`), "");
    if (running) writeFileSync(join(dockerState, `${item.containerName}.running`), "");
  };
  let server: ProjectRunnerServer | null = null;
  const client = new ProjectRunnerClient(join(root, "runner.sock"));
  return { root, state, old, candidate, operation, save, container, appData, dockerState,
    async start() {
      save();
      server = new ProjectRunnerServer(join(root, "runner.sock"), data, config, docker, Buffer.alloc(32, 17));
      await server.start();
    },
    client,
    stored: () => JSON.parse(readFileSync(statePath, "utf8")),
    async close() { await server?.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const phase of ["prepared", "applying", "verifying", "restoring"]) {
  test(`service deployment recovers its durable ${phase} phase without changing Release`, async () => {
    const f = fixture();
    try {
      f.state.pendingOperation.phase = phase;
      f.container(f.old, phase === "prepared");
      if (phase === "verifying" || phase === "restoring") f.container(f.candidate, true);
      await f.start();
      const view = (await f.client.services("demo", "repo"))[0]!;
      assert.equal(view.status, "running");
      assert.equal(view.current?.revision, phase === "verifying" ? f.candidate.revision : f.old.revision);
      assert.equal(f.stored().pendingOperation, undefined);
      assert.equal(f.stored().lastOperation.idempotencyKey, f.operation.idempotencyKey);
      const commands = readFileSync(join(f.dockerState, "commands"), "utf8");
      assert.doesNotMatch(commands, /^run /m, "recovery must not deploy a different candidate");
      const repeated = await f.client.deployService("demo", "repo", "worker", f.candidate.releaseId, f.operation.idempotencyKey);
      assert.equal(repeated.current?.deploymentId, view.current?.deploymentId, "same request must not redeploy");
    } finally { await f.close(); }
  });
}

test("legacy interrupted deployment restores the old container and preserves an explicitly stopped service", async () => {
  for (const stopped of [false, true]) {
    const f = fixture();
    try {
      f.container(f.old, false);
      if (stopped) {
        f.state.desiredState = "stopped";
        f.state.pendingOperation.previousDesiredState = "stopped";
      } else {
        delete f.state.pendingOperation;
        f.state.activeDeploymentId = f.candidate.deploymentId;
      }
      await f.start();
      const view = (await f.client.services("demo", "repo"))[0]!;
      assert.equal(view.status, stopped ? "stopped" : "running");
      assert.equal(view.current?.deploymentId, f.old.deploymentId);
      assert.equal(existsSync(join(f.dockerState, `${f.old.containerName}.running`)), !stopped);
    } finally { await f.close(); }
  }
});

test("first interrupted deployment fails safely and a pending start recreates an exact retained container", async () => {
  const first = fixture();
  try {
    first.state.activeDeploymentId = null;
    first.state.deployments = [first.candidate];
    first.state.pendingOperation.previousDeploymentId = null;
    await first.start();
    assert.equal((await first.client.services("demo", "repo"))[0]?.status, "failed");
    assert.equal(first.stored().pendingOperation, undefined);
  } finally { await first.close(); }
  const f = fixture();
  try {
    f.state.deployments = [f.old];
    f.state.pendingOperation = { operation: { action: "start", idempotencyKey: "c".repeat(64) },
      targetDeploymentId: f.old.deploymentId, previousDeploymentId: f.old.deploymentId,
      previousDesiredState: "stopped", phase: "applying" };
    await f.start();
    assert.equal((await f.client.services("demo", "repo"))[0]?.status, "running");
    assert.match(readFileSync(join(f.dockerState, "commands"), "utf8"), /sha256:test-image/);
  } finally { await f.close(); }
});

test("pending stop and rollback finish on restart without reviving the wrong container", async () => {
  for (const action of ["stop", "rollback"]) {
    const f = fixture();
    try {
      f.container(f.old, false); f.container(f.candidate, true);
      f.state.activeDeploymentId = f.candidate.deploymentId;
      f.state.pendingOperation = { operation: { action, idempotencyKey: "d".repeat(64) },
        targetDeploymentId: action === "stop" ? f.candidate.deploymentId : f.old.deploymentId,
        previousDeploymentId: f.candidate.deploymentId, previousDesiredState: "running", phase: "applying" };
      await f.start();
      const view = (await f.client.services("demo", "repo"))[0]!;
      assert.equal(view.status, action === "stop" ? "stopped" : "running");
      assert.equal(view.current?.deploymentId, action === "stop" ? f.candidate.deploymentId : f.old.deploymentId);
      assert.equal(existsSync(join(f.dockerState, `${f.candidate.containerName}.running`)), false);
    } finally { await f.close(); }
  }
});

test("worker heartbeat health checks detect stale files and reject links outside its data directory", async () => {
  const f = fixture();
  try {
    delete f.state.pendingOperation;
    f.state.status = "running";
    f.state.deployments = [{ ...f.old, heartbeatPath: "heartbeat", heartbeatTimeoutSeconds: 30 }];
    f.container(f.old, true);
    const root = join(f.appData, "services", "repo", "worker");
    mkdirSync(root, { recursive: true });
    const heartbeat = join(root, "heartbeat");
    writeFileSync(heartbeat, "alive");
    await f.start();
    let view = (await f.client.services("demo", "repo"))[0]!;
    assert.equal(view.status, "running"); assert.equal(view.restartCount, 3); assert.ok(view.checkedAt);
    utimesSync(heartbeat, new Date(0), new Date(0));
    assert.equal((await f.client.services("demo", "repo"))[0]?.status, "unhealthy");
    rmSync(heartbeat);
    const external = join(f.root, "outside"); writeFileSync(external, "alive"); symlinkSync(external, heartbeat);
    assert.equal((await f.client.services("demo", "repo"))[0]?.status, "unhealthy");
  } finally { await f.close(); }
});

test("an explicit stop remains available after compensation cannot restore a damaged old snapshot", async () => {
  const f = fixture();
  try {
    f.container(f.old, true);
    const path = join(f.root, "data", "projects", "demo", "services", "repo", "worker", "deployments", f.old.deploymentId, "release-config.json");
    writeFileSync(path, "tampered", { mode: 0o600 });
    await f.start();
    assert.ok(f.stored().pendingOperation, "failed recovery keeps its journal");
    assert.equal((await f.client.services("demo", "repo"))[0]?.status, "failed");
    const stopped = await f.client.serviceAction("demo", "repo", "worker", "stop", "e".repeat(64));
    assert.equal(stopped.status, "stopped");
    assert.equal(f.stored().pendingOperation, undefined);
    assert.equal(existsSync(join(f.dockerState, `${f.old.containerName}.running`)), false);
  } finally { await f.close(); }
});
