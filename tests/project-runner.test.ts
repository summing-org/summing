import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GitInspector } from "../src/git-inspector.js";
import { ProjectRunnerClient } from "../src/project-runner-client.js";
import { ProjectRunnerServer } from "../src/project-runner-server.js";

test("queues an immutable archive and builds it through the isolated runner", async () => {
  const root = mkdtempSync(join("/private/tmp", "summate-runner-test-"));
  const repository = join(root, "repo");
  const configRoot = join(root, "config");
  const dataRoot = join(root, "data");
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
    join(configRoot, "demo.json"),
    JSON.stringify({
      configPath: join(root, "app.json"),
      envPath: join(root, "app.env"),
      dataPath: join(root, "app-data"),
    }),
  );
  writeFileSync(
    fakeDocker,
    "#!/bin/sh\nif [ \"$1\" = image ]; then exit 1; fi\nexit 0\n",
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
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
