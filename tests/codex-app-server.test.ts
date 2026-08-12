import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  if (message.method === "initialize" && message.params?.capabilities?.experimentalApi !== true) {
    process.stdout.write(JSON.stringify({ id: message.id, error: { message: "experimental API required" } }) + "\\n");
    return;
  }
  if (message.id) process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + "\\n");
  if (message.method === "initialized") {
    const delta = process.env.SUMMATE_TEST_SECRET ? "secret leaked" : "hello";
    process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta } }) + "\\n");
  }
});
`,
  );
  chmodSync(executable, 0o755);
  const client = new CodexAppServer(executable, join(root, "home"));
  process.env.SUMMATE_TEST_SECRET = "must-not-reach-codex";
  try {
    const eventPromise = once(client, "event");
    await client.start();
    assert.deepEqual(await client.request("ping"), { ok: true });
    const [event] = await eventPromise;
    assert.equal(event.method, "item/agentMessage/delta");
    assert.equal(event.params.delta, "hello");
  } finally {
    delete process.env.SUMMATE_TEST_SECRET;
    await client.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("thread and turn requests use official v2 shapes", async () => {
  class FakeCodex extends CodexAppServer {
    readonly calls: Array<[string, JsonRecord]> = [];

    override async request(method: string, params: JsonRecord = {}): Promise<unknown> {
      this.calls.push([method, params]);
      return method === "thread/start"
        ? {
            thread: { id: "thread-1" },
            runtimeWorkspaceRoots: params.runtimeWorkspaceRoots,
          }
        : { turn: { id: "turn-1" } };
    }
  }
  const client = new FakeCodex("codex", "/tmp/codex-test");
  const permissionOptions = {
    deniedPaths: ["workspace/deep/secrets/.env"],
    networkAccess: true,
    gitMetadataRoots: ["/tmp/project-git"],
    readableRoots: ["/tmp/project"],
  };
  const threadId = await client.startThread("/tmp/project/workspace", "", permissionOptions);
  const outputSchema = {
    type: "object",
    properties: { should_reply: { type: "boolean" } },
    required: ["should_reply"],
    additionalProperties: false,
  };
  const turnId = await client.startTurn(threadId, "inspect", "/tmp/project/workspace", {
    ...permissionOptions,
    outputSchema,
  });
  assert.deepEqual([threadId, turnId], ["thread-1", "turn-1"]);
  const threadParams = client.calls[0]?.[1] ?? {};
  assert.equal(Object.hasOwn(threadParams, "sandbox"), false);
  assert.equal(threadParams.permissions, "summate-project");
  assert.deepEqual(threadParams.runtimeWorkspaceRoots, ["/tmp/project"]);
  assert.equal(Object.hasOwn(threadParams, "environments"), false);
  assert.deepEqual(threadParams.dynamicTools, []);
  assert.deepEqual(threadParams.selectedCapabilityRoots, []);
  assert.deepEqual(threadParams.config, {
    default_permissions: "summate-project",
    permissions: {
      "summate-project": {
        description: "Write the active project worktree and read only its project root",
        filesystem: {
          ":minimal": "read",
          ":workspace_roots": {
            ".": "read",
            workspace: "write",
            ".git": "read",
            "workspace/.summate-runtime": "read",
            "workspace/.summate-runtime/memory": "write",
            "workspace/.summate-runtime/tmp": "write",
          },
          "/tmp/project-git": "write",
        },
        network: { enabled: true, domains: { "*": "allow" } },
      },
    },
    shell_environment_policy: {
      inherit: "none",
      set: {
        LANG: process.env.LANG ?? "C.UTF-8",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        TEMP: "/tmp/project/workspace/.summate-runtime/tmp",
        TMP: "/tmp/project/workspace/.summate-runtime/tmp",
        TMPDIR: "/tmp/project/workspace/.summate-runtime/tmp",
      },
    },
    projects: {
      "/tmp/project": { trust_level: "untrusted" },
      "/tmp/project/workspace": { trust_level: "untrusted" },
    },
    features: {
      apps: false,
      browser_use: false,
      browser_use_external: false,
      browser_use_full_cdp_access: false,
      computer_use: false,
      hooks: false,
      image_generation: false,
      in_app_browser: false,
      memories: false,
      plugins: false,
      remote_plugin: false,
      multi_agent: false,
      skill_search: false,
      skill_mcp_dependency_install: false,
      workspace_dependencies: false,
    },
  });
  const turnParams = client.calls[1]?.[1] ?? {};
  assert.equal(Object.hasOwn(turnParams, "sandboxPolicy"), false);
  assert.equal(Object.hasOwn(turnParams, "permissions"), false);
  assert.deepEqual(turnParams.runtimeWorkspaceRoots, ["/tmp/project"]);
  assert.deepEqual(turnParams.outputSchema, outputSchema);
  assert.equal(Object.hasOwn(turnParams, "environments"), false);

  await client.startThread("/tmp/project/workspace", "", {
    deniedPaths: ["workspace/deep/secrets/.env"],
    networkAccess: true,
    gitMetadataRoots: ["/tmp/project-git"],
    readableRoots: ["/tmp/project"],
    readOnly: true,
  });
  const readOnlyParams = client.calls[2]?.[1] ?? {};
  assert.equal(readOnlyParams.permissions, "summate-project-readonly");
  assert.deepEqual(readOnlyParams.runtimeWorkspaceRoots, ["/tmp/project"]);
  assert.deepEqual(readOnlyParams.config, {
    default_permissions: "summate-project-readonly",
    permissions: {
      "summate-project-readonly": {
        description: "Read project files without writes or network access",
        filesystem: {
          ":minimal": "read",
          ":workspace_roots": {
            ".": "read",
            ".git": "deny",
            "workspace/.summate-runtime": "deny",
            "workspace/deep/secrets/.env": "deny",
          },
        },
        network: { enabled: false },
      },
    },
    shell_environment_policy: {
      inherit: "none",
      set: {
        LANG: process.env.LANG ?? "C.UTF-8",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      },
    },
    projects: {
      "/tmp/project": { trust_level: "untrusted" },
      "/tmp/project/workspace": { trust_level: "untrusted" },
    },
    features: {
      apps: false,
      browser_use: false,
      browser_use_external: false,
      browser_use_full_cdp_access: false,
      computer_use: false,
      hooks: false,
      image_generation: false,
      in_app_browser: false,
      memories: false,
      plugins: false,
      remote_plugin: false,
      multi_agent: false,
      skill_search: false,
      skill_mcp_dependency_install: false,
      workspace_dependencies: false,
    },
    web_search: "disabled",
  });

  await client.startThread("/tmp/empty-project", "", {
    networkAccess: false,
    readableRoots: ["/tmp/empty-project"],
  });
  const emptyThreadParams = client.calls[3]?.[1] ?? {};
  const emptyConfig = emptyThreadParams.config as JsonRecord;
  const emptyProfiles = emptyConfig.permissions as JsonRecord;
  const emptyProfile = emptyProfiles["summate-project"] as JsonRecord;
  const emptyFilesystem = emptyProfile.filesystem as JsonRecord;
  const emptyWorkspaceRules = emptyFilesystem[":workspace_roots"] as JsonRecord;
  assert.deepEqual(emptyWorkspaceRules, {
    ".": "write",
    ".git": "read",
    ".summate-runtime": "read",
    ".summate-runtime/memory": "write",
    ".summate-runtime/tmp": "write",
  });
  assert.equal(
    Object.keys(emptyWorkspaceRules).some((path) => path.endsWith("PROJECT_MEMORY.md")),
    false,
  );
});

test("refuses shared Codex configuration that could expand project permissions", async () => {
  for (const unsafe of [
    '[mcp_servers.leak]\ncommand = "/usr/bin/false"\n',
    '[hooks.SessionStart]\ncommand = "/usr/bin/false"\n',
    'sandbox_mode = "danger-full-access"\n',
    '[sandbox_workspace_write]\nnetwork_access = true\n',
    'default_permissions = ":danger-full-access"\n',
    '[permissions.summate-project.filesystem]\n":root" = "write"\n',
  ]) {
    const root = mkdtempSync(join(tmpdir(), "summate-codex-config-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), unsafe, "utf8");
    const client = new CodexAppServer("codex", home);
    try {
      await assert.rejects(client.start(), /dedicated auth-only CODEX_HOME/);
    } finally {
      await client.close(true);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
