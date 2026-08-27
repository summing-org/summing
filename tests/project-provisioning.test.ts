import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseProjectEnvironment } from "../src/project-environment.js";
import {
  provisionedEnvironmentText,
  readProvisioningProfile,
  readProvisioningResult,
} from "../src/project-provisioning.js";

function manifest(): Record<string, unknown> {
  return {
    version: 1,
    profiles: [{
      id: "youtube-primary",
      outputs: [{
        name: "refresh_token",
        environment: "YOUTUBE_REFRESH_TOKEN",
        minimumLength: 20,
        maximumLength: 4_096,
      }],
      consume: ["YOUTUBE_BOOTSTRAP_CODE"],
    }],
  };
}

test("provisioning manifest pins bounded output and consumed environment variables", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-provisioning-manifest-"));
  try {
    mkdirSync(join(root, ".summing"));
    writeFileSync(
      join(root, ".summing", "provisioning.json"),
      `${JSON.stringify(manifest(), null, 2)}\n`,
    );
    assert.deepEqual(readProvisioningProfile(root, "youtube-primary"), {
      id: "youtube-primary",
      outputs: [{
        name: "refresh_token",
        environment: "YOUTUBE_REFRESH_TOKEN",
        minimumLength: 20,
        maximumLength: 4_096,
      }],
      consume: ["YOUTUBE_BOOTSTRAP_CODE"],
    });

    const unsafe = manifest();
    (unsafe.profiles as Array<Record<string, unknown>>)[0]!.outputs = [{
      name: "refresh_token",
      environment: "SUMMING_RUNNER_SOCKET",
    }];
    writeFileSync(join(root, ".summing", "provisioning.json"), JSON.stringify(unsafe));
    assert.throws(
      () => readProvisioningProfile(root, "youtube-primary"),
      /invalid or runner-owned/,
    );

    const wrongTypes = manifest();
    (wrongTypes.profiles as Array<Record<string, unknown>>)[0]!.id = 1;
    writeFileSync(join(root, ".summing", "provisioning.json"), JSON.stringify(wrongTypes));
    assert.throws(() => readProvisioningProfile(root, "youtube-primary"), /id is invalid/);

    const stringLimit = manifest();
    const stringLimitProfile = (stringLimit.profiles as Array<Record<string, unknown>>)[0]!;
    (stringLimitProfile.outputs as Array<Record<string, unknown>>)[0]!.minimumLength = "20";
    writeFileSync(join(root, ".summing", "provisioning.json"), JSON.stringify(stringLimit));
    assert.throws(() => readProvisioningProfile(root, "youtube-primary"), /must be an integer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provisioning result is private, exact, and merged with field-level conflict detection", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-provisioning-result-"));
  const source = join(root, "source");
  const resultPath = join(root, "result.json");
  try {
    mkdirSync(join(source, ".summing"), { recursive: true });
    writeFileSync(
      join(source, ".summing", "provisioning.json"),
      `${JSON.stringify(manifest(), null, 2)}\n`,
    );
    const profile = readProvisioningProfile(source, "youtube-primary");
    writeFileSync(resultPath, `${JSON.stringify({
      version: 1,
      profile: "youtube-primary",
      secrets: { refresh_token: "generated-refresh-token-123456789" },
    })}\n`, { mode: 0o600 });
    chmodSync(resultPath, 0o600);
    const result = readProvisioningResult(resultPath, profile);
    assert.equal(result.secrets.get("refresh_token"), "generated-refresh-token-123456789");

    const baseline = parseProjectEnvironment([
      "# YouTube",
      "YOUTUBE_BOOTSTRAP_CODE=one-shot-code",
      "YOUTUBE_REFRESH_TOKEN=",
      "LOG_LEVEL=info",
      "",
    ].join("\n"));
    const merged = provisionedEnvironmentText(
      [
        "# YouTube",
        "YOUTUBE_BOOTSTRAP_CODE=one-shot-code",
        "YOUTUBE_REFRESH_TOKEN=",
        "LOG_LEVEL=debug",
        "",
      ].join("\n"),
      baseline,
      profile,
      result.secrets,
    );
    assert.doesNotMatch(merged, /YOUTUBE_BOOTSTRAP_CODE/);
    assert.match(merged, /YOUTUBE_REFRESH_TOKEN="generated-refresh-token-123456789"/);
    assert.match(merged, /LOG_LEVEL=debug/);

    assert.throws(
      () => provisionedEnvironmentText(
        "YOUTUBE_BOOTSTRAP_CODE=changed-code\nYOUTUBE_REFRESH_TOKEN=\n",
        baseline,
        profile,
        result.secrets,
      ),
      /changed while provisioning was running/,
    );

    chmodSync(resultPath, 0o644);
    assert.throws(() => readProvisioningResult(resultPath, profile), /mode 0600/);

    chmodSync(resultPath, 0o400);
    assert.throws(() => readProvisioningResult(resultPath, profile), /mode 0600/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provisioning result cannot smuggle undeclared or malformed secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-provisioning-invalid-result-"));
  const source = join(root, "source");
  const resultPath = join(root, "result.json");
  try {
    mkdirSync(join(source, ".summing"), { recursive: true });
    writeFileSync(join(source, ".summing", "provisioning.json"), JSON.stringify(manifest()));
    const profile = readProvisioningProfile(source, "youtube-primary");
    writeFileSync(resultPath, JSON.stringify({
      version: 1,
      profile: "youtube-primary",
      secrets: {
        refresh_token: "generated-refresh-token-123456789",
        access_token: "undeclared-secret-123456789",
      },
    }), { mode: 0o600 });
    chmodSync(resultPath, 0o600);
    assert.throws(() => readProvisioningResult(resultPath, profile), /do not match the manifest/);

    writeFileSync(resultPath, JSON.stringify({
      version: 1,
      profile: "youtube-primary",
      secrets: { refresh_token: "short" },
    }), { mode: 0o600 });
    chmodSync(resultPath, 0o600);
    assert.throws(() => readProvisioningResult(resultPath, profile), /20-4096 bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
