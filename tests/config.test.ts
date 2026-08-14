import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

function fixture(): { root: string; configPath: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "summing-config-"));
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

[team_memory]
enabled = true
model_egress_enabled = true
synthesis_batch_sec = 45
max_batch_events = 80
orientation_event_threshold = 25
intervention_cooldown_sec = 7200
raw_retention_days = 180
announce_on_join = false

[codex_usage]
profile_enabled = false
refresh_interval_sec = 600
timezone = "UTC"

[transcription]
provider = "openai"
model = "gpt-transcribe"
max_file_bytes = 123456

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
      SUMMING_DATA_DIR: join(root, "data"),
      SUMMING_CONFIG: configPath,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_OWNER_ID: "42",
      OPENAI_API_KEY: "openai-test-key",
      SUMMING_DEPLOY_REQUEST: join(root, "deploy", "request.json"),
      SUMMING_DEPLOY_STATE: join(root, "deploy", "state.json"),
    });
    assert.equal(config.telegramOwnerId, 42);
    assert.equal(config.maxParallelConversations, 3);
    assert.equal(config.participantBatchSeconds, 25);
    assert.equal(config.participantMessagesPerWindow, 8);
    assert.equal(config.participantRateLimitWindowSeconds, 90);
    assert.equal(config.teamMemoryEnabled, true);
    assert.equal(config.teamModelEgressEnabled, true);
    assert.equal(config.teamSynthesisBatchSeconds, 45);
    assert.equal(config.teamSynthesisMaxEvents, 80);
    assert.equal(config.teamOrientationEventThreshold, 25);
    assert.equal(config.teamInterventionCooldownSeconds, 7_200);
    assert.equal(config.teamRawRetentionDays, 180);
    assert.equal(config.teamAnnounceOnJoin, false);
    assert.equal(config.codexLimitsProfileEnabled, false);
    assert.equal(config.codexLimitsRefreshIntervalSeconds, 600);
    assert.equal(config.codexLimitsTimeZone, "UTC");
    assert.equal(config.transcriptionProvider, "openai");
    assert.equal(config.openaiApiKey, "openai-test-key");
    assert.equal(config.transcriptionModel, "gpt-transcribe");
    assert.equal(config.maximumAttachmentBytes, 123_456);
    assert.equal(config.deploymentRequestPath, join(root, "deploy", "request.json"));
    assert.equal(config.deploymentStatePath, join(root, "deploy", "state.json"));
    assert.equal(config.project("demo").workspace().path, workspace);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment control stays disabled unless both absolute paths are configured", () => {
  const { root, configPath } = fixture();
  try {
    const disabled = loadConfig({
      SUMMING_DATA_DIR: join(root, "data"),
      SUMMING_CONFIG: configPath,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_OWNER_ID: "42",
    });
    assert.equal(disabled.deploymentRequestPath, "");
    assert.equal(disabled.deploymentStatePath, "");
    assert.throws(
      () => loadConfig({
        SUMMING_DATA_DIR: join(root, "data"),
        SUMMING_CONFIG: configPath,
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_OWNER_ID: "42",
        SUMMING_DEPLOY_REQUEST: "relative/request.json",
      }),
      (error) => error instanceof ConfigError && error.message.includes("SUMMING_DEPLOY_REQUEST"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("background Team Space model egress is opt-in", () => {
  const { root, configPath } = fixture();
  try {
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace("model_egress_enabled = true\n", ""),
    );
    const config = loadConfig({
      SUMMING_DATA_DIR: join(root, "data"),
      SUMMING_CONFIG: configPath,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_OWNER_ID: "42",
    });
    assert.equal(config.teamModelEgressEnabled, false);
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
          SUMMING_DATA_DIR: join(root, "data"),
          SUMMING_CONFIG: configPath,
          TELEGRAM_BOT_TOKEN: "test-token",
        }),
      (error) => error instanceof ConfigError && error.message.includes("TELEGRAM_OWNER_ID"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supports Groq Whisper as an explicit transcription provider", () => {
  const { root, configPath } = fixture();
  try {
    const config = loadConfig({
      SUMMING_DATA_DIR: join(root, "data"),
      SUMMING_CONFIG: configPath,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_OWNER_ID: "42",
      TRANSCRIPTION_PROVIDER: "groq",
      GROQ_API_KEY: "groq-test-key",
    });
    assert.equal(config.transcriptionProvider, "groq");
    assert.equal(config.transcriptionModel, "whisper-large-v3-turbo");
    assert.equal(config.groqApiKey, "groq-test-key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a transcription model that is unsupported by its provider", () => {
  const { root, configPath } = fixture();
  try {
    assert.throws(
      () =>
        loadConfig({
          SUMMING_DATA_DIR: join(root, "data"),
          SUMMING_CONFIG: configPath,
          TELEGRAM_BOT_TOKEN: "test-token",
          TELEGRAM_OWNER_ID: "42",
          TRANSCRIPTION_PROVIDER: "groq",
          TRANSCRIPTION_MODEL: "gpt-transcribe",
        }),
      (error) => error instanceof ConfigError && error.message.includes("transcription.model"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
