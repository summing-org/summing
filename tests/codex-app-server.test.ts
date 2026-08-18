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
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  CodexAppServer,
  type DynamicToolNamespaceSpec,
  type JsonRecord,
} from "../src/codex-app-server.js";

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

test("advertises dynamic tools and answers host-side tool calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-codex-tools-"));
  const executable = join(root, "fake-codex.mjs");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 900 && message.result) {
    send({ method: "test/tool-result", params: message.result });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: {
      thread: { id: "thread-tools" },
      runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots,
    } });
    setTimeout(() => send({
      id: 900,
      method: "item/tool/call",
      params: {
        threadId: "thread-tools",
        turnId: "turn-tools",
        callId: "call-tools",
        namespace: "runner",
        tool: "inspect",
        arguments: {},
      },
    }), 20);
    return;
  }
  if (message.id) send({ id: message.id, result: { ok: true } });
});
`,
  );
  chmodSync(executable, 0o755);
  const tools: DynamicToolNamespaceSpec[] = [{
    type: "namespace",
    name: "runner",
    description: "Runner state",
    tools: [{
      type: "function",
      name: "inspect",
      description: "Inspect state",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }],
  }];
  const client = new CodexAppServer(executable, join(root, "home"));
  try {
    await client.start();
    const eventPromise = once(client, "event");
    await client.startThread("/tmp/project", "", {
      readableRoots: ["/tmp/project"],
      dynamicTools: tools,
      dynamicToolHandler: async (call) => ({
        success: call.tool === "inspect" && call.namespace === "runner",
        contentItems: [{ type: "inputText", text: JSON.stringify({ active: [] }) }],
      }),
    });
    const [event] = await eventPromise;
    assert.equal(event.method, "test/tool-result");
    assert.equal(event.params.success, true);
    assert.deepEqual(event.params.contentItems, [{
      type: "inputText",
      text: '{"active":[]}',
    }]);
  } finally {
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
  const resolverDirectory = join(binaryFixture, "run", "systemd", "resolve");
  mkdirSync(resolverDirectory, { recursive: true });
  const resolverTarget = join(resolverDirectory, "stub-resolv.conf");
  writeFileSync(resolverTarget, "nameserver 127.0.0.53\n", "utf8");
  const resolverConfig = join(binaryFixture, "resolv.conf");
  symlinkSync(resolverTarget, resolverConfig);
  const canonicalReleaseBin = realpathSync(releaseBin);
  const canonicalNodeBin = dirname(realpathSync(process.execPath));
  const canonicalNodeInstallation =
    basename(canonicalNodeBin) === "bin" ? dirname(canonicalNodeBin) : canonicalNodeBin;
  const canonicalResolverConfig = realpathSync(resolverConfig);
  context.after(() => rmSync(binaryFixture, { recursive: true, force: true }));
  const client = new FakeCodex(launcher, "/tmp/codex-test", resolverConfig);
  const permissionOptions = {
    deniedPaths: ["workspace/deep/secrets/.env"],
    networkAccess: true,
    gitMetadataRoots: [
      "/tmp/project-git",
      "/tmp/project-git/worktrees/project-workspace",
    ],
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
    localImagePaths: [
      "/tmp/project/workspace/.summing-runtime/attachments/photo.jpg",
      "/tmp/project/workspace/.summing-runtime/attachments/photo.jpg",
    ],
    outputSchema,
  });
  assert.deepEqual([threadId, turnId], ["thread-1", "turn-1"]);
  const threadParams = client.calls[0]?.[1] ?? {};
  assert.equal(Object.hasOwn(threadParams, "sandbox"), false);
  assert.equal(threadParams.permissions, "summing-project");
  assert.deepEqual(threadParams.runtimeWorkspaceRoots, [
    "/tmp/project",
    "/tmp/project-git",
    "/tmp/project-git/worktrees/project-workspace",
  ]);
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
          },
          [canonicalResolverConfig]: "read",
          [canonicalNodeInstallation]: "read",
          "/tmp/project/workspace": "write",
          "/tmp/project/workspace/.git": "read",
          "/tmp/project/workspace/.summing-runtime": "read",
          "/tmp/project/workspace/.summing-runtime/memory": "write",
          "/tmp/project/workspace/.summing-runtime/tmp": "write",
          "/tmp/project/workspace/.summing-runtime/attachments": "read",
          "/tmp/project/workspace/.summing-runtime/outbox": "write",
          "/tmp/project-git": "write",
          "/tmp/project-git/hooks": "deny",
          "/tmp/project-git/config": "read",
          "/tmp/project-git/config.worktree": "read",
          "/tmp/project-git/worktrees/project-workspace": "write",
          "/tmp/project-git/worktrees/project-workspace/hooks": "deny",
          "/tmp/project-git/worktrees/project-workspace/config": "read",
          "/tmp/project-git/worktrees/project-workspace/config.worktree": "read",
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
  assert.deepEqual(turnParams.runtimeWorkspaceRoots, [
    "/tmp/project",
    "/tmp/project-git",
    "/tmp/project-git/worktrees/project-workspace",
  ]);
  assert.deepEqual(turnParams.outputSchema, outputSchema);
  assert.deepEqual(turnParams.input, [
    { type: "text", text: "inspect" },
    {
      type: "localImage",
      path: "/tmp/project/workspace/.summing-runtime/attachments/photo.jpg",
    },
  ]);
  assert.equal(Object.hasOwn(turnParams, "environments"), false);

  await client.resumeThread(threadId, "/tmp/project/workspace", permissionOptions);
  const resumeParams = client.calls[2]?.[1] ?? {};
  assert.equal(resumeParams.permissions, "summing-project");
  assert.deepEqual(resumeParams.runtimeWorkspaceRoots, [
    "/tmp/project",
    "/tmp/project-git",
    "/tmp/project-git/worktrees/project-workspace",
  ]);

  await client.startThread("/tmp/project/workspace", "", {
    deniedPaths: ["workspace/deep/secrets/.env"],
    disableEnvironments: true,
    networkAccess: true,
    gitMetadataRoots: ["/tmp/project-git"],
    readableRoots: ["/tmp/project"],
    readOnly: true,
    ephemeral: true,
  });
  const readOnlyParams = client.calls[3]?.[1] ?? {};
  assert.equal(readOnlyParams.permissions, "summing-project-readonly");
  assert.deepEqual(readOnlyParams.environments, []);
  assert.equal(readOnlyParams.ephemeral, true);
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
          },
          "/tmp/project/.git": "deny",
          "/tmp/project/workspace/.summing-runtime": "deny",
          "/tmp/project/workspace/.summing-runtime/attachments": "read",
          "/tmp/project/workspace/deep/secrets/.env": "deny",
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

  await client.startTurn(threadId, "inspect read-only", "/tmp/project/workspace", {
    ...permissionOptions,
    readOnly: true,
  });
  const readOnlyTurnParams = client.calls[4]?.[1] ?? {};
  assert.deepEqual(readOnlyTurnParams.runtimeWorkspaceRoots, ["/tmp/project"]);

  await client.startThread("/tmp/empty-project", "", {
    networkAccess: false,
    readableRoots: ["/tmp/empty-project"],
  });
  const emptyThreadParams = client.calls[5]?.[1] ?? {};
  const emptyConfig = emptyThreadParams.config as JsonRecord;
  const emptyProfiles = emptyConfig.permissions as JsonRecord;
  const emptyProfile = emptyProfiles["summing-project"] as JsonRecord;
  const emptyFilesystem = emptyProfile.filesystem as JsonRecord;
  const emptyWorkspaceRules = emptyFilesystem[":workspace_roots"] as JsonRecord;
  assert.deepEqual(emptyWorkspaceRules, {
    ".": "read",
  });
  assert.equal(emptyFilesystem["/tmp/empty-project"], "write");
  assert.equal(emptyFilesystem["/tmp/empty-project/.git"], "read");
  assert.equal(emptyFilesystem["/tmp/empty-project/.summing-runtime"], "read");
  assert.equal(emptyFilesystem["/tmp/empty-project/.summing-runtime/memory"], "write");
  assert.equal(emptyFilesystem["/tmp/empty-project/.summing-runtime/tmp"], "write");
  assert.equal(emptyFilesystem["/tmp/empty-project/.summing-runtime/attachments"], "read");
  assert.equal(emptyFilesystem["/tmp/empty-project/.summing-runtime/outbox"], "write");
  const writeProfile = ((threadParams.config as JsonRecord).permissions as JsonRecord)[
    "summing-project"
  ] as JsonRecord;
  const writeFilesystem = writeProfile.filesystem as JsonRecord;
  assert.equal(writeFilesystem[canonicalNodeInstallation], "read");
  assert.equal(writeFilesystem[canonicalResolverConfig], "read");
  assert.equal(writeFilesystem["/tmp/project-git"], "write");
  assert.equal(writeFilesystem["/tmp/project-git/hooks"], "deny");
  assert.equal(writeFilesystem["/tmp/project-git/config"], "read");
  assert.equal(writeFilesystem["/tmp/project-git/worktrees/project-workspace"], "write");
  assert.equal(
    writeFilesystem["/tmp/project-git/worktrees/project-workspace/config.worktree"],
    "read",
  );
  assert.equal(
    Object.keys(writeFilesystem).some((path) => path.includes("project-git/.summing-runtime")),
    false,
  );
  assert.equal(emptyFilesystem[canonicalResolverConfig], undefined);
  const readOnlyProfile = ((readOnlyParams.config as JsonRecord).permissions as JsonRecord)[
    "summing-project-readonly"
  ] as JsonRecord;
  const readOnlyFilesystem = readOnlyProfile.filesystem as JsonRecord;
  assert.equal(readOnlyFilesystem[canonicalResolverConfig], undefined);

  await client.unsubscribeThread("thread-1");
  assert.deepEqual(client.calls.at(-1), ["thread/unsubscribe", { threadId: "thread-1" }]);
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
