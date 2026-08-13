import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServer, type JsonRecord } from "../src/codex-app-server.js";

test("dispatches responses and notifications over JSONL stdio", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-codex-"));
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
    const delta =
      process.env.SUMMING_TEST_SECRET || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY
        ? "secret leaked"
        : "hello";
    process.stdout.write(JSON.stringify({ method: "item/agentMessage/delta", params: { delta } }) + "\\n");
  }
});
`,
  );
  chmodSync(executable, 0o755);
  const client = new CodexAppServer(executable, join(root, "home"));
  process.env.SUMMING_TEST_SECRET = "must-not-reach-codex";
  process.env.OPENAI_API_KEY = "must-not-reach-codex";
  process.env.GROQ_API_KEY = "must-not-reach-codex";
  try {
    const eventPromise = once(client, "event");
    await client.start();
    assert.deepEqual(await client.request("ping"), { ok: true });
    const [event] = await eventPromise;
    assert.equal(event.method, "item/agentMessage/delta");
    assert.equal(event.params.delta, "hello");
  } finally {
    delete process.env.SUMMING_TEST_SECRET;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    await client.close(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("thread and turn requests use official v2 shapes", async (context) => {
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
  const binaryFixture = mkdtempSync(join(tmpdir(), "summing-codex-release-"));
  const releaseBin = join(binaryFixture, "release", "bin");
  mkdirSync(releaseBin, { recursive: true });
  const releaseExecutable = join(releaseBin, "codex");
  writeFileSync(releaseExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const launcher = join(binaryFixture, "codex");
  symlinkSync(releaseExecutable, launcher);
  const canonicalReleaseBin = realpathSync(releaseBin);
  context.after(() => rmSync(binaryFixture, { recursive: true, force: true }));
  const client = new FakeCodex(launcher, "/tmp/codex-test");
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
  assert.equal(threadParams.permissions, "summing-project");
  assert.deepEqual(threadParams.runtimeWorkspaceRoots, ["/tmp/project"]);
  assert.equal(Object.hasOwn(threadParams, "environments"), false);
  assert.deepEqual(threadParams.dynamicTools, []);
  assert.deepEqual(threadParams.selectedCapabilityRoots, []);
  assert.deepEqual(threadParams.config, {
    default_permissions: "summing-project",
    permissions: {
      "summing-project": {
        description: "Write the active project worktree and read only its project root",
        filesystem: {
          ":minimal": "read",
          ":workspace_roots": {
            ".": "read",
            workspace: "write",
            ".git": "read",
            "workspace/.summing-runtime": "read",
            "workspace/.summing-runtime/memory": "write",
            "workspace/.summing-runtime/tmp": "write",
            "workspace/.summing-runtime/attachments": "read",
          },
          "/tmp/project-git": "write",
          [canonicalReleaseBin]: "read",
        },
        network: { enabled: true, domains: { "*": "allow" } },
      },
    },
    shell_environment_policy: {
      inherit: "none",
      set: {
        LANG: process.env.LANG ?? "C.UTF-8",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        TEMP: "/tmp/project/workspace/.summing-runtime/tmp",
        TMP: "/tmp/project/workspace/.summing-runtime/tmp",
        TMPDIR: "/tmp/project/workspace/.summing-runtime/tmp",
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
  assert.equal(readOnlyParams.permissions, "summing-project-readonly");
  assert.deepEqual(readOnlyParams.runtimeWorkspaceRoots, ["/tmp/project"]);
  assert.deepEqual(readOnlyParams.config, {
    default_permissions: "summing-project-readonly",
    permissions: {
      "summing-project-readonly": {
        description: "Read project files without writes or network access",
        filesystem: {
          ":minimal": "read",
          ":workspace_roots": {
            ".": "read",
            ".git": "deny",
            "workspace/.summing-runtime": "deny",
            "workspace/.summing-runtime/attachments": "read",
            "workspace/deep/secrets/.env": "deny",
          },
          [canonicalReleaseBin]: "read",
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
  const emptyProfile = emptyProfiles["summing-project"] as JsonRecord;
  const emptyFilesystem = emptyProfile.filesystem as JsonRecord;
  const emptyWorkspaceRules = emptyFilesystem[":workspace_roots"] as JsonRecord;
  assert.deepEqual(emptyWorkspaceRules, {
    ".": "write",
    ".git": "read",
    ".summing-runtime": "read",
    ".summing-runtime/memory": "write",
    ".summing-runtime/tmp": "write",
    ".summing-runtime/attachments": "read",
  });
  assert.equal(
    Object.keys(emptyWorkspaceRules).some((path) => path.endsWith("PROJECT_MEMORY.md")),
    false,
  );
});

test("reads ChatGPT rate limits through the account RPC", async () => {
  class FakeCodex extends CodexAppServer {
    readonly calls: Array<[string, JsonRecord]> = [];

    override async request(method: string, params: JsonRecord = {}): Promise<unknown> {
      this.calls.push([method, params]);
      return { rateLimits: { primary: { usedPercent: 25 } } };
    }
  }

  const client = new FakeCodex("codex", "/tmp/codex-test");
  assert.deepEqual(await client.rateLimits(), {
    rateLimits: { primary: { usedPercent: 25 } },
  });
  assert.deepEqual(client.calls, [["account/rateLimits/read", {}]]);
});

test("refuses shared Codex configuration that could expand project permissions", async () => {
  for (const unsafe of [
    '[mcp_servers.leak]\ncommand = "/usr/bin/false"\n',
    '[hooks.SessionStart]\ncommand = "/usr/bin/false"\n',
    'sandbox_mode = "danger-full-access"\n',
    '[sandbox_workspace_write]\nnetwork_access = true\n',
    'default_permissions = ":danger-full-access"\n',
    '[permissions.summing-project.filesystem]\n":root" = "write"\n',
  ]) {
    const root = mkdtempSync(join(tmpdir(), "summing-codex-config-"));
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
