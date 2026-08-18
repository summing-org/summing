import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEncryptedNodeRecoveryComponent,
  extractEncryptedNodeRecoveryComponent,
  inspectEncryptedNodeRecoveryComponent,
} from "../src/node-recovery-archive.js";

test("node recovery component preserves files, modes and contained symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-node-recovery-archive-"));
  const source = join(root, "source");
  const encrypted = join(root, "component.gz.enc");
  const extracted = join(root, "extracted");
  const key = randomBytes(32);
  try {
    mkdirSync(join(source, "nested"), { recursive: true });
    writeFileSync(join(source, "hello.txt"), "hello recovery\n", { mode: 0o640 });
    writeFileSync(join(source, "nested", "binary.bin"), Buffer.from([0, 1, 2, 255]));
    chmodSync(join(source, "nested", "binary.bin"), 0o600);
    symlinkSync("../hello.txt", join(source, "nested", "hello-link"));

    const created = await createEncryptedNodeRecoveryComponent([
      { sourcePath: source, archivePath: "payload" },
    ], encrypted, key);
    assert.equal(created.files, 2);
    assert.equal(created.entries, 5);
    assert.equal(created.plaintextBytes, 19);
    assert.match(created.sha256, /^[a-f0-9]{64}$/);

    const inspected = await inspectEncryptedNodeRecoveryComponent(
      encrypted,
      key,
      created.iv,
      created.tag,
      1_000_000,
    );
    assert.deepEqual(inspected, {
      entries: 5,
      files: 2,
      plaintextBytes: 19,
      warnings: [],
    });

    const restored = await extractEncryptedNodeRecoveryComponent(
      encrypted,
      extracted,
      key,
      created.iv,
      created.tag,
      1_000_000,
    );
    assert.equal(restored.files, 2);
    assert.equal(readFileSync(join(extracted, "payload", "hello.txt"), "utf8"), "hello recovery\n");
    assert.deepEqual(
      readFileSync(join(extracted, "payload", "nested", "binary.bin")),
      Buffer.from([0, 1, 2, 255]),
    );
    assert.equal(readlinkSync(join(extracted, "payload", "nested", "hello-link")), "../hello.txt");
  } finally {
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("node recovery component rejects wrong keys, tampering and unsafe inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-node-recovery-security-"));
  const source = join(root, "source");
  const encrypted = join(root, "component.gz.enc");
  const key = randomBytes(32);
  try {
    mkdirSync(source);
    writeFileSync(join(source, "value.txt"), "value");
    const created = await createEncryptedNodeRecoveryComponent([
      { sourcePath: source, archivePath: "payload" },
    ], encrypted, key);

    await assert.rejects(
      inspectEncryptedNodeRecoveryComponent(
        encrypted,
        randomBytes(32),
        created.iv,
        created.tag,
        1_000_000,
      ),
    );
    const bytes = readFileSync(encrypted);
    bytes[Math.floor(bytes.length / 2)]! ^= 1;
    writeFileSync(encrypted, bytes);
    await assert.rejects(
      inspectEncryptedNodeRecoveryComponent(
        encrypted,
        key,
        created.iv,
        created.tag,
        1_000_000,
      ),
    );
    await assert.rejects(
      createEncryptedNodeRecoveryComponent([
        { sourcePath: source, archivePath: "../escape" },
      ], join(root, "unsafe.enc"), key),
      /path is unsafe/,
    );

    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync("../../outside", join(source, "escape-link"));
    await assert.rejects(
      createEncryptedNodeRecoveryComponent([
        { sourcePath: source, archivePath: "payload" },
      ], join(root, "symlink.enc"), key),
      /symlink escapes/,
    );
  } finally {
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("node recovery component excludes generated and secret paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-node-recovery-exclusions-"));
  const source = join(root, "source");
  const encrypted = join(root, "component.gz.enc");
  const extracted = join(root, "extracted");
  const key = randomBytes(32);
  try {
    mkdirSync(join(source, "node_modules"), { recursive: true });
    writeFileSync(join(source, "kept.txt"), "kept");
    writeFileSync(join(source, ".env"), "SECRET=value");
    writeFileSync(join(source, "node_modules", "generated.txt"), "generated");
    const created = await createEncryptedNodeRecoveryComponent([
      {
        sourcePath: source,
        archivePath: "payload",
        excludeSegments: ["node_modules"],
        excludeSecretFiles: true,
      },
    ], encrypted, key);
    assert.equal(created.files, 1);
    assert.equal(created.warnings.length, 2);
    await extractEncryptedNodeRecoveryComponent(
      encrypted,
      extracted,
      key,
      created.iv,
      created.tag,
      1_000_000,
    );
    assert.equal(readFileSync(join(extracted, "payload", "kept.txt"), "utf8"), "kept");
    assert.throws(() => readFileSync(join(extracted, "payload", ".env")));
  } finally {
    key.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});
