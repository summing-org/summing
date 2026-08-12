import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

function fixture(): { root: string; configPath: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "summate-config-"));
  const workspace = join(root, "workspace");
  const configPath = join(root, "config.toml");
  mkdirSync(workspace);
  writeFileSync(
    configPath,
    `[agent]
max_parallel_conversations = 3
stream_interval_sec = 0.75
network_access = true
participant_batch_sec = 25
participant_rate_limit_messages = 8
participant_rate_limit_window_sec = 90

[health]
port = 9876

[projects.demo]
name = "Demo"
default_workspace = "app"

[projects.demo.workspaces.app]
path = "${workspace}"
`,
  );
  return { root, configPath, workspace };
}

test("loads the explicit project model", () => {
  const { root, configPath, workspace } = fixture();
  try {
    const config = loadConfig({
      SUMMATE_DATA_DIR: join(root, "data"),
      SUMMATE_CONFIG: configPath,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_OWNER_ID: "42",
    });
    assert.equal(config.telegramOwnerId, 42);
    assert.equal(config.maxParallelConversations, 3);
    assert.equal(config.participantBatchSeconds, 25);
    assert.equal(config.participantMessagesPerWindow, 8);
    assert.equal(config.participantRateLimitWindowSeconds, 90);
    assert.equal(config.project("demo").workspace().path, workspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails loudly without an owner", () => {
  const { root, configPath } = fixture();
  try {
    assert.throws(
      () =>
        loadConfig({
          SUMMATE_DATA_DIR: join(root, "data"),
          SUMMATE_CONFIG: configPath,
          TELEGRAM_BOT_TOKEN: "test-token",
        }),
      (error) => error instanceof ConfigError && error.message.includes("TELEGRAM_OWNER_ID"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
