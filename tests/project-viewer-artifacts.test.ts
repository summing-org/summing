import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { ProjectCatalog } from "../src/project-catalog.js";
import { ProjectViewerServer } from "../src/project-viewer.js";
import { StateStore } from "../src/state-store.js";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function repository(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "README.md"), "fixture\n");
  git(path, "init", "--initial-branch=main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.com");
  git(path, "add", "README.md");
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
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
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

test("viewer exposes short-lived authorized HTTPS downloads instead of blob URLs", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-viewer-artifact-download-"));
  const workspace = join(root, "workspace");
  repository(workspace);
  const port = await freePort();
  const configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    `[viewer]\nport = ${port}\n\n[projects.demo]\nname = "Demo"\ndefault_workspace = "repo"\n\n[projects.demo.workspaces.repo]\npath = "${workspace}"\n`,
  );
  const config = loadConfig({
    SUMMING_DATA_DIR: join(root, "data"),
    SUMMING_CONFIG: configPath,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_OWNER_ID: "42",
  });
  const state = new StateStore(join(config.dataDir, "state.sqlite3"));
  const projects = new ProjectCatalog(config, state);
  const conversation = state.bind(42, 1, "demo", "repo");
  const viewer = new ProjectViewerServer(config, state, projects);
  const jobId = "25b42bab-c0f5-4801-9a21-edaaeff2b408";
  Object.assign(viewer.runner, {
    artifacts: async (projectId: string, requestedJobId: string) => {
      assert.deepEqual([projectId, requestedJobId], ["demo", jobId]);
      return [
        { name: "report.html", bytes: 42, contentType: "text/html" },
        { name: "photo-01.jpg", bytes: 4, contentType: "image/jpeg" },
      ];
    },
    artifactData: async (projectId: string, requestedJobId: string, name: string) => {
      assert.deepEqual([projectId, requestedJobId], ["demo", jobId]);
      return name === "report.html"
        ? {
            name,
            bytes: 42,
            contentType: "text/html",
            data: new TextEncoder().encode("<!doctype html><title>Dry run</title>"),
          }
        : {
            name,
            bytes: 4,
            contentType: "image/jpeg",
            data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
          };
    },
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const headers = { "x-telegram-init-data": signedInitData("bot-token", 42) };

  try {
    await viewer.start();
    const listed = await fetch(
      `${endpoint}/api/viewer/job-artifacts?conversation=${conversation.id}&job=${jobId}`,
      { headers },
    );
    assert.equal(listed.status, 200);
    const payload = await listed.json() as {
      artifacts: Array<{
        downloadExpiresAt: string;
        downloadUrl: string;
        name: string;
      }>;
    };
    assert.equal(payload.artifacts.length, 2);
    const artifact = payload.artifacts.find((candidate) => candidate.name === "report.html")!;
    assert.equal(artifact.name, "report.html");
    assert.match(artifact.downloadExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(
      artifact.downloadUrl,
      /^\/artifacts\/(?:[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+\/report\.html$/,
    );
    assert.doesNotMatch(artifact.downloadUrl, /tg-|conversation|query_id|hash=/);

    const downloaded = await fetch(new URL(artifact.downloadUrl, endpoint));
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(
      downloaded.headers.get("content-disposition"),
      `attachment; filename="report.html"; filename*=UTF-8''report.html`,
    );
    assert.equal(downloaded.headers.get("cache-control"), "private, no-store");
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await downloaded.text(), "<!doctype html><title>Dry run</title>");

    const photo = payload.artifacts.find((candidate) => candidate.name === "photo-01.jpg")!;
    const downloadedPhoto = await fetch(new URL(photo.downloadUrl, endpoint));
    assert.equal(downloadedPhoto.status, 200);
    assert.equal(downloadedPhoto.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(
      [...new Uint8Array(await downloadedPhoto.arrayBuffer())],
      [0xff, 0xd8, 0xff, 0xd9],
    );

    const wrongName = await fetch(
      new URL(artifact.downloadUrl.replace(/report\.html$/, "errors.json"), endpoint),
    );
    assert.equal(wrongName.status, 404);

    const [path, prefix, token, name] = artifact.downloadUrl.split("/");
    assert.deepEqual([path, prefix], ["", "artifacts"]);
    const last = token!.at(-1);
    const tamperedToken = `${token!.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    const tampered = await fetch(new URL(`/artifacts/${tamperedToken}/${name}`, endpoint));
    assert.equal(tampered.status, 401);

    const inaccessible = viewer.auth.createArtifactDownloadGrant({
      conversationId: conversation.id,
      jobId,
      name: "report.html",
      userId: 99,
    });
    const forbidden = await fetch(
      new URL(`/artifacts/${inaccessible.token}/report.html`, endpoint),
    );
    assert.equal(forbidden.status, 403);
  } finally {
    await viewer.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});
