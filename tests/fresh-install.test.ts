import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const asset = (path: string): string => readFileSync(join(root, path), "utf8");

function manifest(termsReviewed = true): Record<string, unknown> {
  return {
    installationId: "summing-production",
    telegram: {
      botToken: `123456789:${"telegram-secret".repeat(3)}`,
      ownerId: 123456789,
    },
    openai: { apiKey: `sk-${"openai-secret".repeat(3)}` },
    viewer: {
      domain: "assist.example.com",
      localToken: "viewer-local-token-0123456789abcdef",
    },
    runtime: { timezone: "Europe/Moscow", maxParallelConversations: 3 },
    transcription: { provider: "openai", model: "gpt-transcribe" },
    knowledge: {
      enabled: true,
      telegramTermsReviewed: termsReviewed,
      objectStore: {
        endpoint: "https://fsn1.example-object-storage.com",
        region: "fsn1",
        bucket: "summing-production",
        prefix: "summing-production",
        accessKeyId: "s3-access-key",
        secretAccessKey: "s3-secret-access-key-value",
        forcePathStyle: true,
        sse: "AES256",
      },
    },
  };
}

test("fresh-install renderer validates one private manifest and never prints secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "summing-fresh-render-"));
  try {
    const input = join(directory, "input.json");
    const env = join(directory, "summing.env");
    const config = join(directory, "config.toml");
    const caddy = join(directory, "Caddyfile");
    const value = manifest();
    writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
    chmodSync(input, 0o600);
    const result = spawnSync(process.execPath, [
      join(root, "scripts/render-fresh-install.mjs"),
      "--input", input,
      "--env-output", env,
      "--config-output", config,
      "--caddy-output", caddy,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /telegram-secret|openai-secret|s3-secret-access/);
    assert.deepEqual(JSON.parse(result.stdout), {
      installationId: "summing-production",
      knowledgeEnabled: true,
      viewerUrl: "https://assist.example.com",
    });
    assert.match(assetFrom(env), /^TELEGRAM_BOT_TOKEN=123456789:/m);
    assert.match(assetFrom(env), /^SUMMING_OBJECT_STORE=s3$/m);
    assert.match(assetFrom(env), /^SUMMING_TELEGRAM_TERMS_REVIEWED=true$/m);
    assert.match(assetFrom(config), /\[knowledge_sync\][\s\S]*object_store = "s3"/);
    assert.match(assetFrom(caddy), /^assist\.example\.com \{/);
    assert.equal(statSync(env).mode & 0o777, 0o640);
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.equal(statSync(caddy).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fresh-install renderer enforces the legal gate before writing output", () => {
  const directory = mkdtempSync(join(tmpdir(), "summing-fresh-legal-"));
  try {
    const input = join(directory, "input.json");
    const env = join(directory, "summing.env");
    writeFileSync(input, JSON.stringify(manifest(false)), { mode: 0o600 });
    chmodSync(input, 0o600);
    const result = spawnSync(process.execPath, [
      join(root, "scripts/render-fresh-install.mjs"),
      "--input", input,
      "--env-output", env,
      "--config-output", join(directory, "config.toml"),
      "--caddy-output", join(directory, "Caddyfile"),
    ], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /telegramTermsReviewed must be true/);
    assert.equal(statOrNull(env), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provisioning and secure bootstrap assets keep application secrets out of metadata", () => {
  const cloudInit = asset("deploy/cloud-init.yaml");
  const bootstrapPath = join(root, "deploy/secure-bootstrap");
  const installerPath = join(root, "deploy/install-fresh");
  const provisionerPath = join(root, "deploy/provision-host");
  const bootstrap = asset("deploy/secure-bootstrap");
  const installer = asset("deploy/install-fresh");
  const provisioner = asset("deploy/provision-host");
  const recoveryPath = join(root, "deploy/restore-node-recovery");
  const recovery = asset("deploy/restore-node-recovery");
  for (const path of [bootstrapPath, installerPath, provisionerPath, recoveryPath]) {
    const syntax = spawnSync("bash", ["-n", path], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.notEqual(statSync(path).mode & 0o111, 0, `${path} must be executable`);
  }
  assert.match(cloudInit, /\n  - caddy\n/);
  assert.match(cloudInit, /\/etc\/summing\/provisioned/);
  assert.match(cloudInit, /usermod --home \/var\/lib\/summing --shell \/usr\/sbin\/nologin summing/);
  assert.match(cloudInit, /ufw allow 443\/tcp/);
  assert.doesNotMatch(cloudInit, /TELEGRAM_BOT_TOKEN=|OPENAI_API_KEY=|SUMMING_S3_SECRET_ACCESS_KEY=/);
  assert.match(bootstrap, /Refusing clean install over existing durable state/);
  assert.match(bootstrap, /Trusted cloud-init provisioning marker is missing or unsafe/);
  assert.match(bootstrap, /git init --bare "\$\{bundle_verify_dir\}"/);
  assert.match(bootstrap, /git -C "\$\{bundle_verify_dir\}" bundle verify/);
  assert.match(bootstrap, /install -o summing -g summing -m 0600 "\$\{bundle\}" "\$\{staged_bundle\}"/);
  assert.match(bootstrap, /sudo -u summing git clone --no-local "\$\{staged_bundle\}"/);
  assert.match(bootstrap, /caddy validate --config "\$\{caddy_candidate\}" --adapter caddyfile/);
  assert.match(bootstrap, /"  HostName \$\{source_hostname\}"/);
  assert.match(bootstrap, /SUMMING_DEPLOY_EXPECTED_REMOTE=\$\{origin\}/);
  assert.match(bootstrap, /consume_install_inputs/);
  assert.match(bootstrap, /trap consume_install_inputs EXIT/);
  assert.match(bootstrap, /mktemp \/run\/summing-Caddyfile\.XXXXXX/);
  assert.match(bootstrap, /mktemp \/run\/summing-install-summary\.XXXXXX/);
  assert.match(bootstrap, /curl --fail --silent --show-error http:\/\/127\.0\.0\.1:8765\/health/);
  assert.doesNotMatch(bootstrap, /rm\s+-rf/);
  assert.match(installer, /Refusing to install from a checkout with tracked changes/);
  assert.match(installer, /scripts\/render-fresh-install\.mjs/);
  assert.match(installer, /requires Node\.js 24 or newer/);
  assert.match(installer, /--provision/);
  assert.match(installer, /--identity/);
  assert.match(installer, /--port/);
  assert.match(installer, /StrictHostKeyChecking=accept-new/);
  assert.match(installer, /deploy\/provision-host/);
  assert.match(installer, /"\$\{target\}" bash "\$\{provision_dir\}\/provision-host"/);
  assert.match(installer, /remote_args=\(\s+bash\s+"\$\{remote_dir\}\/secure-bootstrap"/);
  assert.match(installer, /cleanup_install_inputs/);
  assert.match(installer, /reboot_and_wait/);
  assert.doesNotMatch(installer, /StrictHostKeyChecking=no/);
  assert.match(installer, /git bundle create "\$\{bundle\}" HEAD/);
  assert.match(installer, /cloud-init status --wait/);
  assert.match(installer, /--consume-inputs/);
  assert.match(installer, /ssh -G "\$\{source_alias\}"/);
  assert.match(installer, /--source-hostname "\$\{source_hostname\}"/);
  assert.match(provisioner, /Host provisioning requires Ubuntu 24\.04/);
  assert.match(provisioner, /Host provisioning requires x86_64/);
  assert.match(provisioner, /Refusing to provision over existing SUMMING state/);
  assert.match(provisioner, /install -d -o summing -g summing -m 0750 \/var\/lib\/summing/);
  assert.match(provisioner, /usermod --home \/var\/lib\/summing --shell \/usr\/sbin\/nologin summing/);
  assert.match(provisioner, /node_version=v24\.18\.0/);
  assert.match(provisioner, /SHASUMS256\.txt/);
  assert.match(provisioner, /ufw allow "\$\{ssh_port\}\/tcp"/);
  assert.match(provisioner, /\/etc\/summing\/provisioned/);
  assert.doesNotMatch(
    provisioner,
    /TELEGRAM_BOT_TOKEN|OPENAI_API_KEY|SUMMING_S3_SECRET_ACCESS_KEY/,
  );
  assert.match(asset("deploy/activate.sh"), /\/usr\/local\/sbin\/restore-node-recovery/);
  assert.match(recovery, /read -r -s recovery_key <\/dev\/tty/);
  assert.match(
    recovery,
    /systemctl stop summing\.service summing-project-runner\.service/,
  );
  assert.match(recovery, /dist\/src\/node-recovery-activate\.js/);
  assert.match(recovery, /services remain stopped for inspection/);
  assert.doesNotMatch(recovery, /rm\s+-rf/);
});

test("Hetzner provisioning uses protected Ubuntu 24.04 and restricted SSH", () => {
  const main = asset("infra/hetzner/main.tf");
  const variables = asset("infra/hetzner/variables.tf");
  assert.match(main, /source\s+=\s+"hetznercloud\/hcloud"/);
  assert.match(main, /version\s+=\s+"~> 1\.68"/);
  assert.match(main, /image\s+=\s+"ubuntu-24\.04"/);
  assert.match(main, /user_data\s+=\s+file\(/);
  assert.match(main, /delete_protection\s+=\s+true/);
  assert.match(main, /rebuild_protection\s+=\s+true/);
  assert.match(variables, /cidr != "0\.0\.0\.0\/0"/);
  assert.match(variables, /cidr != "::\/0"/);
  assert.doesNotMatch(main + variables, /telegram|openai|secret_access_key/i);
});

test("SSH provisioning entry points reject unsafe ports before any remote action", () => {
  const installer = spawnSync("bash", [
    join(root, "deploy/install-fresh"),
    "--target", "root@example.com",
    "--secrets", "/does/not/exist",
    "--port", "0",
    "--yes",
  ], { encoding: "utf8" });
  assert.equal(installer.status, 2);
  assert.match(installer.stderr, /between 1 and 65535/);
  assert.doesNotMatch(installer.stderr, /SSH did not become ready/);

  const provisioner = spawnSync("bash", [
    join(root, "deploy/provision-host"),
    "--ssh-port", "65536",
  ], { encoding: "utf8" });
  assert.equal(provisioner.status, 2);
  assert.match(provisioner.stderr, /between 1 and 65535/);
});

function assetFrom(path: string): string {
  return readFileSync(path, "utf8");
}

function statOrNull(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
