import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServer, type JsonRecord } from "../src/codex-app-server.js";

test("dispatches responses and notifications over JSONL stdio", async () => {
  const root = mkdtempSync(join(tmpdir(), "summate-codex-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id) process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + "\\n");
  if (message.method === "initialized") {
    process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hello" } }) + "\\n");
  }
});
`,
  );
  chmodSync(executable, 0o755);
  const client = new CodexAppServer(executable, join(root, "home"));
  try {
    const eventPromise = once(client, "event");
    await client.start();
    assert.deepEqual(await client.request("ping"), { ok: true });
    const [event] = await eventPromise;
    assert.equal(event.method, "item/agentMessage/delta");
    assert.equal(event.params.delta, "hello");
  } finally {
    await client.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("thread and turn requests use official v2 shapes", async () => {
  class FakeCodex extends CodexAppServer {
    readonly calls: Array<[string, JsonRecord]> = [];

    override async request(method: string, params: JsonRecord = {}): Promise<unknown> {
      this.calls.push([method, params]);
      return method === "thread/start" ? { thread: { id: "thread-1" } } : { turn: { id: "turn-1" } };
    }
  }
  const client = new FakeCodex("codex", "/tmp/codex-test");
  const threadId = await client.startThread("/tmp/workspace");
  const turnId = await client.startTurn(threadId, "inspect", "/tmp/workspace", {
    networkAccess: false,
  });
  assert.deepEqual([threadId, turnId], ["thread-1", "turn-1"]);
  assert.equal(client.calls[0]?.[1].sandbox, "workspace-write");
  assert.deepEqual(client.calls[1]?.[1].sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/tmp/workspace"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
});
