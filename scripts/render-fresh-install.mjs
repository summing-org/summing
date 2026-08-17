#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) fail("installer renderer arguments must be --name value pairs");
    values.set(name.slice(2), value);
  }
  for (const required of ["input", "env-output", "config-output", "caddy-output"]) {
    if (!values.has(required)) fail(`missing --${required}`);
  }
  return Object.fromEntries(values);
}

function record(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function text(value, name, pattern, optional = false) {
  const result = String(value ?? "").trim();
  if (!result && optional) return "";
  if (!result || !pattern.test(result)) fail(`${name} is invalid`);
  return result;
}

function boolean(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(`${name} must be boolean`);
  return value;
}

function integer(value, name, minimum, maximum) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    fail(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function secret(value, name, minimum = 20, optional = false) {
  const result = String(value ?? "");
  if (!result && optional) return "";
  if (
    result.length < minimum ||
    result.length > 4096 ||
    /[\s\0-\x1f\x7f]/.test(result)
  ) {
    fail(`${name} must be a non-whitespace secret of at least ${minimum} characters`);
  }
  return result;
}

function url(value, name, optional = false) {
  const result = String(value ?? "").trim();
  if (!result && optional) return "";
  let parsed;
  try {
    parsed = new URL(result);
  } catch {
    fail(`${name} must be an HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    fail(`${name} must be an HTTPS URL without credentials or a fragment`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function hostname(value, name, optional = false) {
  const result = String(value ?? "").trim().toLowerCase();
  if (!result && optional) return "";
  if (
    result.length > 253 ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(result)
  ) {
    fail(`${name} must be a DNS hostname`);
  }
  return result;
}

function safeEnv(name, value) {
  const rendered = String(value);
  if (!/^[\x21-\x7e]*$/.test(rendered)) fail(`${name} contains characters unsupported by systemd EnvironmentFile`);
  return `${name}=${rendered}`;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function assertPrivateInput(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail("installer input must be one regular non-symlinked file");
  }
  if ((stat.mode & 0o077) !== 0) fail("installer input permissions must be 0600 or stricter");
}

function atomicWrite(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile()) fail(`refusing unsafe output path: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode });
  const descriptor = openSync(temporary, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function render(input) {
  const telegram = record(input.telegram, "telegram");
  const openai = record(input.openai, "openai");
  const viewer = record(input.viewer ?? {}, "viewer");
  const runtime = record(input.runtime ?? {}, "runtime");
  const transcription = record(input.transcription ?? {}, "transcription");
  const knowledge = record(input.knowledge ?? {}, "knowledge");
  const objectStore = record(knowledge.objectStore ?? {}, "knowledge.objectStore");

  const installationId = text(
    input.installationId,
    "installationId",
    /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/,
  );
  const botToken = secret(telegram.botToken, "telegram.botToken", 20);
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) fail("telegram.botToken has an invalid Bot API shape");
  const ownerId = integer(telegram.ownerId, "telegram.ownerId", 1, Number.MAX_SAFE_INTEGER);
  const openaiApiKey = secret(openai.apiKey, "openai.apiKey", 20);
  const viewerDomain = hostname(viewer.domain, "viewer.domain");
  const viewerLocalToken = secret(viewer.localToken, "viewer.localToken", 32);
  const timezone = text(runtime.timezone ?? "Europe/Moscow", "runtime.timezone", /^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/);
  const maximumParallel = integer(runtime.maxParallelConversations ?? 2, "runtime.maxParallelConversations", 1, 32);
  const provider = text(transcription.provider ?? "openai", "transcription.provider", /^(?:openai|groq)$/);
  const transcriptionModel = text(
    transcription.model ?? (provider === "groq" ? "whisper-large-v3-turbo" : "gpt-transcribe"),
    "transcription.model",
    /^[A-Za-z0-9._-]{2,100}$/,
  );
  const groqApiKey = secret(transcription.groqApiKey, "transcription.groqApiKey", 20, provider !== "groq");

  const knowledgeEnabled = boolean(knowledge.enabled, "knowledge.enabled", true);
  const termsReviewed = boolean(knowledge.telegramTermsReviewed, "knowledge.telegramTermsReviewed", false);
  const bucket = text(objectStore.bucket, "knowledge.objectStore.bucket", /^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/, !knowledgeEnabled);
  const region = text(objectStore.region ?? "us-east-1", "knowledge.objectStore.region", /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/);
  const prefix = text(objectStore.prefix ?? installationId, "knowledge.objectStore.prefix", /^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$/);
  const endpoint = url(objectStore.endpoint, "knowledge.objectStore.endpoint", true);
  const accessKeyId = secret(objectStore.accessKeyId, "knowledge.objectStore.accessKeyId", 8, !knowledgeEnabled);
  const secretAccessKey = secret(objectStore.secretAccessKey, "knowledge.objectStore.secretAccessKey", 16, !knowledgeEnabled);
  const forcePathStyle = boolean(objectStore.forcePathStyle, "knowledge.objectStore.forcePathStyle", false);
  const sse = text(objectStore.sse ?? "AES256", "knowledge.objectStore.sse", /^(?:AES256|aws:kms)$/);
  const kmsKeyId = secret(objectStore.kmsKeyId, "knowledge.objectStore.kmsKeyId", 3, sse !== "aws:kms");
  if (knowledgeEnabled && !termsReviewed) {
    fail("knowledge.telegramTermsReviewed must be true before enabling knowledge sync");
  }

  const publicUrl = viewerDomain ? `https://${viewerDomain}` : "";
  const env = [
    safeEnv("SUMMING_INSTALLATION_ID", installationId),
    safeEnv("SUMMING_DATA_DIR", "/var/lib/summing/data"),
    safeEnv("SUMMING_CONFIG", "/var/lib/summing/data/config.toml"),
    safeEnv("SUMMING_WORKTREE_ROOT", "/var/lib/summing/data/worktrees"),
    safeEnv("CODEX_HOME", "/var/lib/summing/data/codex"),
    safeEnv("CODEX_BIN", "/usr/local/bin/codex"),
    safeEnv("TELEGRAM_BOT_TOKEN", botToken),
    safeEnv("TELEGRAM_OWNER_ID", ownerId),
    safeEnv("SUMMING_VIEWER_URL", publicUrl),
    safeEnv("SUMMING_VIEWER_LOCAL_TOKEN", viewerLocalToken),
    safeEnv("SUMMING_RUNNER_SOCKET", "/run/summing-runner/runner.sock"),
    safeEnv("SUMMING_DEPLOY_REQUEST", "/var/lib/summing/deploy/request.json"),
    safeEnv("SUMMING_DEPLOY_STATE", "/var/lib/summing/deploy/state.json"),
    safeEnv("TRANSCRIPTION_PROVIDER", provider),
    safeEnv("TRANSCRIPTION_MODEL", transcriptionModel),
    safeEnv("OPENAI_API_KEY", openaiApiKey),
    safeEnv("GROQ_API_KEY", groqApiKey),
    safeEnv("SUMMING_OBJECT_STORE", knowledgeEnabled ? "s3" : "local"),
    safeEnv("SUMMING_TELEGRAM_TERMS_REVIEWED", termsReviewed),
    safeEnv("SUMMING_S3_ENDPOINT", endpoint),
    safeEnv("SUMMING_S3_REGION", region),
    safeEnv("SUMMING_S3_BUCKET", bucket),
    safeEnv("SUMMING_S3_PREFIX", prefix),
    safeEnv("SUMMING_S3_ACCESS_KEY_ID", accessKeyId),
    safeEnv("SUMMING_S3_SECRET_ACCESS_KEY", secretAccessKey),
    safeEnv("SUMMING_S3_FORCE_PATH_STYLE", forcePathStyle),
    safeEnv("SUMMING_S3_SSE", sse),
    safeEnv("SUMMING_S3_KMS_KEY_ID", kmsKeyId),
    safeEnv("SUMMING_MTPROTO_KEY", "/etc/summing/mtproto.key"),
    safeEnv("SUMMING_KB_TRANSFER_KEY", "/etc/summing/kb-transfer.key"),
    safeEnv("SUMMING_DOCUMENT_VISION_MODEL", "gpt-5.4-nano"),
    safeEnv("NODE_ENV", "production"),
  ].join("\n") + "\n";

  const config = `[agent]
model = ""
effort = "medium"
max_parallel_conversations = ${maximumParallel}
stream_interval_sec = 1.0
participant_rate_limit_messages = 12
participant_rate_limit_window_sec = 60
network_access = true

[team_memory]
enabled = true
model_egress_enabled = false
understanding_quiet_sec = 20
understanding_max_wait_sec = 90
understanding_max_events = 40
orientation_event_threshold = 50
intervention_cooldown_sec = 3600
raw_retention_days = 365
announce_on_join = true

[knowledge_sync]
enabled = ${knowledgeEnabled}
telegram_terms_reviewed = ${termsReviewed}
object_store = ${tomlString(knowledgeEnabled ? "s3" : "local")}
spool_root = "/var/lib/summing/data/knowledge-spool"
spool_max_bytes = 8000000000
mtproto_master_key = "/etc/summing/mtproto.key"
transfer_key = "/etc/summing/kb-transfer.key"
embedding_model = "text-embedding-3-small"
embedding_dimensions = 1536
embedding_batch_size = 64
document_vision_model = "gpt-5.4-nano"
s3_region = ${tomlString(region)}
s3_prefix = ${tomlString(prefix)}
s3_sse = ${tomlString(sse)}

[codex_usage]
profile_enabled = true
refresh_interval_sec = 900
timezone = ${tomlString(timezone)}

[transcription]
provider = ${tomlString(provider)}
model = ${tomlString(transcriptionModel)}
max_file_bytes = 20000000

[health]
port = 8765

[viewer]
port = 8766
public_url = ${tomlString(publicUrl)}
auth_max_age_sec = 900
runner_socket = "/run/summing-runner/runner.sock"

[projects.summing]
name = "SUMMING"
default_workspace = "repo"
self_change = true

[projects.summing.workspaces.repo]
path = "/opt/summing"
`;

  const caddy = viewerDomain
    ? `${viewerDomain} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8766
}
`
    : "";
  return { installationId, knowledgeEnabled, publicUrl, env, config, caddy };
}

try {
  const args = parseArguments(process.argv.slice(2));
  assertPrivateInput(args.input);
  const input = JSON.parse(readFileSync(args.input, "utf8"));
  const rendered = render(record(input, "installer input"));
  atomicWrite(args["env-output"], rendered.env, 0o640);
  atomicWrite(args["config-output"], rendered.config, 0o600);
  atomicWrite(args["caddy-output"], rendered.caddy, 0o600);
  process.stdout.write(JSON.stringify({
    installationId: rendered.installationId,
    knowledgeEnabled: rendered.knowledgeEnabled,
    viewerUrl: rendered.publicUrl,
  }) + "\n");
} catch (error) {
  process.stderr.write(`fresh install configuration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
