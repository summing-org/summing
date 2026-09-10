import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectRunnerClient, type RunnerJob } from "../src/project-runner-client.js";
import { ProjectRunnerServer } from "../src/project-runner-server.js";

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("runner condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runner-timeout-"));
  const configRoot = join(root, "config");
  const dataRoot = join(root, "data");
  const socket = join(root, "runner.sock");
  mkdirSync(configRoot);
  mkdirSync(join(root, "source"));
  writeFileSync(join(root, "source", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(root, "app.json"), "{}\n");
  for (const project of ["demo", "other"]) {
    writeFileSync(join(configRoot, `${project}.json`), JSON.stringify({
      configPath: join(root, "app.json"), dataPath: join(root, project), network: false,
    }));
  }
  const archive = execFileSync("/usr/bin/tar", ["-cf", "-", "-C", join(root, "source"), "."]);
  const docker = join(root, "docker");
  // A detached worker represents the container: killing the attached CLI cannot
  // kill it, and it writes its final artifact only when Docker stops it.
  writeFileSync(join(root, "worker.cjs"), `
const fs = require('node:fs');
const [pidFile, artifactDir] = process.argv.slice(2);
fs.writeFileSync(pidFile, String(process.pid));
const timer = setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  fs.writeFileSync(artifactDir + '/report.html', '<p>saved on shutdown: test-api-secret-987654</p>');
  fs.writeFileSync(artifactDir + '/scenario-generation.json', JSON.stringify({responseId: 'response-original', secret: 'test-api-secret-987654'}));
  setTimeout(() => { fs.unlinkSync(pidFile); clearInterval(timer); }, 120);
});
`);
  writeFileSync(docker, `#!${process.execPath}
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
const name = args[0] === 'run' ? args[args.indexOf('--name') + 1] : args.at(-1);
const pidFile = root + '/' + name + '.pid';
const blocked = fs.existsSync(root + '/block-cleanup') && name.startsWith('summing-demo-');
fs.appendFileSync(root + '/calls', JSON.stringify({command: args[0], name, at: Date.now()}) + '\\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  if (args[0] === 'image') return;
  if (args[0] === 'run') {
    if (!name.startsWith('summing-demo-') || fs.existsSync(root + '/submitted')) return;
    fs.writeFileSync(root + '/submitted', name);
    const id = args.find(arg => arg.startsWith('SUMMING_JOB_ID=')).split('=')[1];
    const dir = root + '/demo/dry-runs/' + id;
    fs.writeFileSync(dir + '/manifest.json', JSON.stringify({saved: true}));
    const worker = spawn(process.execPath, [root + '/worker.cjs', pidFile, dir], {detached: true, stdio: 'ignore'});
    worker.unref();
    setInterval(() => {}, 1000);
  }
  if (args[0] === 'stop') {
    fs.writeFileSync(root + '/stopping', name);
    while (fs.existsSync(root + '/hold-stop')) await sleep(10);
    if (blocked || fs.existsSync(root + '/fail-stop')) process.exit(1);
    if (fs.existsSync(pidFile)) {
      process.kill(Number(fs.readFileSync(pidFile)), 'SIGTERM');
      while (fs.existsSync(pidFile)) await sleep(10);
    }
  }
  if (args[0] === 'rm') {
    if (blocked) { console.error('Docker daemon unavailable'); process.exit(1); }
    if (!fs.existsSync(pidFile)) {
      console.error('Error response from daemon: No such container: ' + name);
      process.exit(1);
    }
    process.kill(Number(fs.readFileSync(pidFile)), 'SIGKILL');
    fs.unlinkSync(pidFile);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`, { mode: 0o700 });
  const createServer = () => new ProjectRunnerServer(socket, dataRoot, configRoot, docker,
    Buffer.alloc(32, 4), true, [], undefined, undefined, 2, 12, 20_000, 29_999, 1);
  let server = createServer();
  const client = new ProjectRunnerClient(socket);
  const job = async (id: string, project = "demo", workspace = "repo"): Promise<RunnerJob> => {
    const record = (await client.jobs(project, workspace)).find(candidate => candidate.id === id);
    assert.ok(record);
    return record;
  };
  return {
    root, dataRoot, client, job,
    calls: () => readFileSync(join(root, "calls"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as { command: string; name: string; at: number }),
    start: async () => {
      await server.start();
      await client.saveEnvironment("demo", "repo", "API_TOKEN=test-api-secret-987654\n", 0);
    },
    restart: async () => { await server.close(); server = createServer(); await server.start(); },
    submit: (project = "demo", workspace = "repo") => client.submit(project, workspace, "dry-run", "a".repeat(40), archive),
    terminal: async (id: string, project = "demo", workspace = "repo") => {
      await eventually(async () => ["completed", "failed", "cancelled", "interrupted"].includes((await job(id, project, workspace)).status));
      return job(id, project, workspace);
    },
    close: async () => {
      rmSync(join(root, "hold-stop"), { force: true });
      await server.close();
      for (const file of readdirSync(root).filter(file => file.endsWith(".pid"))) {
        try { process.kill(Number(readFileSync(join(root, file))), "SIGKILL"); } catch { /* already exited */ }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("timeout stops the independent container, keeps final artifacts, then releases the project queue", async () => {
  const f = fixture();
  try {
    await f.start();
    const first = await f.submit();
    await eventually(() => existsSync(join(f.root, "submitted")));
    const next = await f.submit("demo", "second-workspace");
    const failed = await f.terminal(first.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.terminationReason, "timeout");
    assert.equal(failed.timeoutMs, 1_000);
    assert.ok(failed.timedOutAt);
    assert.ok(failed.containerStoppedAt);
    assert.equal(failed.containerCleanupPending, false);
    assert.equal(failed.exitCode, undefined);
    assert.equal(existsSync(join(f.root, `summing-demo-${first.id.slice(0, 8)}.pid`)), false);
    assert.match((await f.client.artifact("demo", first.id, "report.html")).content, /saved on shutdown: \[REDACTED\]/);
    const journal = await f.client.artifact("demo", first.id, "scenario-generation.json");
    assert.match(journal.content, /response-original/);
    assert.doesNotMatch(journal.content, /test-api-secret/);
    assert.equal((await f.terminal(next.id, "demo", "second-workspace")).status, "completed");
    const calls = f.calls();
    const removal = calls.findIndex(call => call.command === "rm" && call.name.endsWith(first.id.slice(0, 8)));
    const nextRun = calls.findIndex(call => call.command === "run" && call.name.endsWith(next.id.slice(0, 8)));
    assert.ok(removal >= 0 && nextRun > removal);
    assert.match(await f.client.log("demo", first.id), /TIMEOUT.*1000 ms/);
  } finally { await f.close(); }
});

test("timeout forces removal when graceful stop fails", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "fail-stop"), "");
    await f.start();
    const first = await f.submit();
    const failed = await f.terminal(first.id);
    assert.equal(failed.terminationReason, "timeout");
    assert.equal(failed.containerCleanupPending, false);
    assert.ok(failed.containerStoppedAt);
    assert.equal(existsSync(join(f.root, `summing-demo-${first.id.slice(0, 8)}.pid`)), false);
    assert.equal((await f.client.artifact("demo", first.id, "manifest.json")).content, '{"saved":true}');
  } finally { await f.close(); }
});

test("cancellation during timeout cleanup cannot replace the timeout cause", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "hold-stop"), "");
    await f.start();
    const first = await f.submit();
    await eventually(() => existsSync(join(f.root, "stopping")));
    await f.client.cancel("demo", "repo", first.id);
    rmSync(join(f.root, "hold-stop"));
    const failed = await f.terminal(first.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.terminationReason, "timeout");
    assert.equal(failed.containerCleanupPending, false);
  } finally { await f.close(); }
});

test("failed cleanup survives restart and automatically unblocks its project without resubmitting the paid job", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  try {
    writeFileSync(join(f.root, "block-cleanup"), "");
    await f.start();
    const first = await f.submit();
    const failed = await f.terminal(first.id);
    assert.equal(failed.terminationReason, "timeout");
    assert.equal(failed.containerCleanupPending, true);
    assert.match(failed.containerCleanupError ?? "", /removal was not confirmed/);
    assert.deepEqual((await f.client.health()).blockedProjects, ["demo"]);
    const queued = await f.submit("demo", "second-workspace");
    const other = await f.submit("other");
    assert.equal((await f.terminal(other.id, "other")).status, "completed");
    assert.equal((await f.job(queued.id, "demo", "second-workspace")).status, "queued");
    await assert.rejects(f.client.artifact("demo", first.id, "manifest.json"), /awaiting container cleanup/);
    const snapshot = join(f.dataRoot, "projects", "demo", "runs", first.id, "environment.json");
    assert.equal(existsSync(snapshot), true);
    await f.restart();
    await eventually(() => f.calls().filter(call => call.command === "rm" && call.name.endsWith(first.id.slice(0, 8))).length >= 2);
    assert.equal((await f.job(first.id)).containerCleanupPending, true);
    const next = await f.submit();
    assert.equal((await f.job(next.id)).status, "queued");
    rmSync(join(f.root, "block-cleanup"));
    t.mock.timers.tick(30_000);
    await eventually(async () => !(await f.job(first.id)).containerCleanupPending);
    const recovered = await f.job(first.id);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.terminationReason, "timeout");
    assert.equal(recovered.containerCleanupError, undefined);
    assert.deepEqual((await f.client.health()).blockedProjects, []);
    assert.equal(f.calls().filter(call => call.command === "run" && call.name.endsWith(first.id.slice(0, 8))).length, 1);
    assert.match((await f.client.artifact("demo", first.id, "report.html")).content, /\[REDACTED\]/);
    assert.equal((await f.terminal(next.id)).status, "completed");
  } finally { await f.close(); }
});

test("cancel retries pending cleanup without changing the original failed job or launching another container", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "block-cleanup"), "");
    await f.start();
    const first = await f.submit();
    const failed = await f.terminal(first.id);
    rmSync(join(f.root, "block-cleanup"));
    const cleaned = await f.client.cancel("demo", "repo", first.id);
    assert.equal(cleaned.status, "failed");
    assert.equal(cleaned.error, failed.error);
    assert.equal(cleaned.terminationReason, "timeout");
    assert.equal(cleaned.timedOutAt, failed.timedOutAt);
    assert.equal(cleaned.containerCleanupPending, false);
    assert.equal(f.calls().filter(call => call.command === "run").length, 1);
  } finally { await f.close(); }
});

test("startup keeps an old pending cleanup job and its encrypted snapshot beyond retention limits", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-cleanup-retention-"));
  const dataRoot = join(root, "data");
  const runs = join(dataRoot, "projects", "demo", "runs");
  const pendingId = "00000000-0000-0000-0000-000000000000";
  mkdirSync(runs, { recursive: true });
  try {
    for (let i = 0; i <= 105; i++) {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
      const directory = join(runs, id);
      mkdirSync(directory);
      writeFileSync(join(directory, "job.json"), JSON.stringify({
        id, projectId: "demo", workspaceId: "repo", action: "dry-run", status: "failed",
        revision: "a".repeat(40), createdAt: new Date(i * 1_000).toISOString(),
        containerCleanupPending: i === 0,
      }));
      for (const file of ["source.tar", "environment.json", "release-config.json"]) {
        writeFileSync(join(directory, file), "retained payload");
      }
    }
    new ProjectRunnerServer(join(root, "runner.sock"), dataRoot, join(root, "config"), "/bin/false", Buffer.alloc(32, 1));
    assert.equal(readdirSync(runs).length, 101);
    for (const file of ["job.json", "source.tar", "environment.json", "release-config.json"]) {
      assert.equal(existsSync(join(runs, pendingId, file)), true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
