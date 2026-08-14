import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_PUBLIC_KEY_BYTES = 16_384;
const MAX_STATE_BYTES = 512_000;
const MAX_AUDIT_ENTRIES = 200;

export type RepositoryDiagnosticCode =
  | "ok"
  | "missing-origin"
  | "legacy-ssh-command"
  | "unsafe-config"
  | "dns-failure"
  | "network-failure"
  | "timeout"
  | "host-key-changed"
  | "authentication-failed"
  | "repository-not-found"
  | "write-denied"
  | "protected-branch"
  | "unknown";

export interface RepositoryVerificationRecord {
  remote: string;
  head: string;
  read: boolean;
  write: boolean;
  emptyRemote: boolean;
  checkedAt: string;
  code: RepositoryDiagnosticCode;
  message: string;
  fingerprint: string;
}

export interface RepositoryRemoteChange {
  previous: string;
  replacement: string;
  changedAt: string;
  changedBy: number;
}

export interface RepositoryAuditEntry {
  at: string;
  actor: number;
  action: string;
  outcome: "success" | "error";
  remote: string;
  previousRemote: string;
  branch: string;
  head: string;
  code: RepositoryDiagnosticCode;
  message: string;
}

export interface RepositoryExperienceState {
  verification: RepositoryVerificationRecord | null;
  rotationVerification: RepositoryVerificationRecord | null;
  previousRemote: RepositoryRemoteChange | null;
  audit: RepositoryAuditEntry[];
}

export interface RepositorySshCredential {
  identityFile: string;
  knownHostsFile: string;
}

export interface ManagedRepositoryCredential extends RepositorySshCredential {
  publicKey: string;
  fingerprint: string;
}

export interface RepositoryRotationCandidate extends ManagedRepositoryCredential {
  preparedAt: string;
}

export class RepositoryCredentialError extends Error {}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function command(executable: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64_000) stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveCommand({ code: code ?? 1, stdout, stderr });
    });
  });
}

function identifier(value: string, field: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new RepositoryCredentialError(`${field} has an invalid identifier`);
  }
  return value;
}

async function secureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new RepositoryCredentialError(`refusing unsafe credential directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function existingSecureDirectory(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new RepositoryCredentialError(`refusing unsafe credential directory: ${path}`);
    }
    await chmod(path, 0o700);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function regularFile(path: string, required: boolean): Promise<boolean> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new RepositoryCredentialError(`refusing unsafe credential file: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return false;
    throw error;
  }
}

function commandFailure(result: CommandResult, fallback: string): RepositoryCredentialError {
  const detail = result.stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return new RepositoryCredentialError(detail ? `${fallback}: ${detail}` : fallback);
}

export class RepositoryCredentialStore {
  readonly root: string;

  constructor(readonly dataDir: string) {
    this.root = resolve(dataDir, "repository-credentials");
  }

  async inspect(projectId: string, workspaceId: string): Promise<ManagedRepositoryCredential | null> {
    const paths = this.paths(projectId, workspaceId);
    for (const directory of [this.root, paths.projectDirectory, paths.directory]) {
      if (!(await existingSecureDirectory(directory))) return null;
    }
    const privateExists = await regularFile(paths.identityFile, false);
    const publicExists = await regularFile(paths.publicKeyFile, false);
    if (!privateExists && !publicExists) return null;
    if (!privateExists) {
      throw new RepositoryCredentialError("repository deploy key is incomplete: private key is missing");
    }
    await chmod(paths.identityFile, 0o600);
    if (!publicExists) await this.restorePublicKey(paths.identityFile, paths.publicKeyFile);
    await chmod(paths.publicKeyFile, 0o644);
    await this.ensureKnownHosts(paths.knownHostsFile);
    return this.readCredential(paths);
  }

  async ensure(projectId: string, workspaceId: string): Promise<ManagedRepositoryCredential> {
    const existing = await this.inspect(projectId, workspaceId);
    if (existing) return existing;

    const paths = this.paths(projectId, workspaceId);
    await this.ensureDirectories(projectId, workspaceId);
    const temporary = await mkdtemp(join(paths.directory, ".generate-"));
    await chmod(temporary, 0o700);
    const temporaryIdentity = join(temporary, "id_ed25519");
    try {
      const generated = await command("/usr/bin/ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        `summing:${projectId}/${workspaceId}`,
        "-f",
        temporaryIdentity,
      ]);
      if (generated.code !== 0) throw commandFailure(generated, "cannot generate repository deploy key");
      await chmod(temporaryIdentity, 0o600);
      await chmod(`${temporaryIdentity}.pub`, 0o644);
      await rename(temporaryIdentity, paths.identityFile);
      await rename(`${temporaryIdentity}.pub`, paths.publicKeyFile);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    await this.ensureKnownHosts(paths.knownHostsFile);
    return this.readCredential(paths);
  }

  async inspectRotation(
    projectId: string,
    workspaceId: string,
  ): Promise<RepositoryRotationCandidate | null> {
    const paths = this.paths(projectId, workspaceId);
    for (const directory of [this.root, paths.projectDirectory, paths.directory]) {
      if (!(await existingSecureDirectory(directory))) return null;
    }
    const privateExists = await regularFile(paths.candidateIdentityFile, false);
    const publicExists = await regularFile(paths.candidatePublicKeyFile, false);
    if (!privateExists && !publicExists) return null;
    if (!privateExists || !publicExists) {
      throw new RepositoryCredentialError("repository rotation key is incomplete");
    }
    await chmod(paths.candidateIdentityFile, 0o600);
    await chmod(paths.candidatePublicKeyFile, 0o644);
    await this.ensureKnownHosts(paths.knownHostsFile);
    const credential = await this.readCredential({
      identityFile: paths.candidateIdentityFile,
      publicKeyFile: paths.candidatePublicKeyFile,
      knownHostsFile: paths.knownHostsFile,
    });
    const status = await lstat(paths.candidatePublicKeyFile);
    return { ...credential, preparedAt: status.birthtime.toISOString() };
  }

  async prepareRotation(
    projectId: string,
    workspaceId: string,
  ): Promise<RepositoryRotationCandidate> {
    await this.ensure(projectId, workspaceId);
    const existing = await this.inspectRotation(projectId, workspaceId);
    if (existing) return existing;
    const paths = this.paths(projectId, workspaceId);
    const temporary = await mkdtemp(join(paths.directory, ".rotate-"));
    await chmod(temporary, 0o700);
    const temporaryIdentity = join(temporary, "id_ed25519.next");
    try {
      const generated = await command("/usr/bin/ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        `summing-next:${projectId}/${workspaceId}`,
        "-f",
        temporaryIdentity,
      ]);
      if (generated.code !== 0) throw commandFailure(generated, "cannot generate replacement deploy key");
      await chmod(temporaryIdentity, 0o600);
      await chmod(`${temporaryIdentity}.pub`, 0o644);
      await rename(temporaryIdentity, paths.candidateIdentityFile);
      await rename(`${temporaryIdentity}.pub`, paths.candidatePublicKeyFile);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    await this.setRotationVerification(projectId, workspaceId, null);
    const candidate = await this.inspectRotation(projectId, workspaceId);
    if (!candidate) throw new RepositoryCredentialError("replacement deploy key was not created");
    return candidate;
  }

  async cancelRotation(projectId: string, workspaceId: string): Promise<void> {
    const paths = this.paths(projectId, workspaceId);
    for (const directory of [this.root, paths.projectDirectory, paths.directory]) {
      if (!(await existingSecureDirectory(directory))) return;
    }
    await rm(paths.candidateIdentityFile, { force: true });
    await rm(paths.candidatePublicKeyFile, { force: true });
    await this.setRotationVerification(projectId, workspaceId, null);
  }

  async activateRotation(
    projectId: string,
    workspaceId: string,
  ): Promise<ManagedRepositoryCredential> {
    const paths = this.paths(projectId, workspaceId);
    const [active, candidate] = await Promise.all([
      this.inspect(projectId, workspaceId),
      this.inspectRotation(projectId, workspaceId),
    ]);
    if (!active || !candidate) throw new RepositoryCredentialError("replacement deploy key is not ready");
    const backupIdentity = `${paths.identityFile}.previous`;
    const backupPublic = `${paths.publicKeyFile}.previous`;
    await rm(backupIdentity, { force: true });
    await rm(backupPublic, { force: true });
    try {
      await rename(paths.identityFile, backupIdentity);
      await rename(paths.publicKeyFile, backupPublic);
      await rename(paths.candidateIdentityFile, paths.identityFile);
      await rename(paths.candidatePublicKeyFile, paths.publicKeyFile);
    } catch (error) {
      await rm(paths.identityFile, { force: true });
      await rm(paths.publicKeyFile, { force: true });
      if (await regularFile(backupIdentity, false)) await rename(backupIdentity, paths.identityFile);
      if (await regularFile(backupPublic, false)) await rename(backupPublic, paths.publicKeyFile);
      throw error;
    }
    await rm(backupIdentity, { force: true });
    await rm(backupPublic, { force: true });
    await this.setRotationVerification(projectId, workspaceId, null);
    const activated = await this.inspect(projectId, workspaceId);
    if (!activated) throw new RepositoryCredentialError("replacement deploy key was not activated");
    return activated;
  }

  async state(projectId: string, workspaceId: string): Promise<RepositoryExperienceState> {
    const paths = this.paths(projectId, workspaceId);
    for (const directory of [this.root, paths.projectDirectory, paths.directory]) {
      if (!(await existingSecureDirectory(directory))) return this.emptyState();
    }
    if (!(await regularFile(paths.stateFile, false))) return this.emptyState();
    const status = await lstat(paths.stateFile);
    if (status.size > MAX_STATE_BYTES) throw new RepositoryCredentialError("repository state is unexpectedly large");
    try {
      return this.normalizeState(JSON.parse(await readFile(paths.stateFile, "utf8")));
    } catch (error) {
      if (error instanceof RepositoryCredentialError) throw error;
      throw new RepositoryCredentialError("repository state has an invalid format");
    }
  }

  async setVerification(
    projectId: string,
    workspaceId: string,
    verification: RepositoryVerificationRecord | null,
  ): Promise<void> {
    await this.updateState(projectId, workspaceId, (state) => ({ ...state, verification }));
  }

  async setRotationVerification(
    projectId: string,
    workspaceId: string,
    rotationVerification: RepositoryVerificationRecord | null,
  ): Promise<void> {
    await this.updateState(projectId, workspaceId, (state) => ({ ...state, rotationVerification }));
  }

  async setPreviousRemote(
    projectId: string,
    workspaceId: string,
    previousRemote: RepositoryRemoteChange | null,
  ): Promise<void> {
    await this.updateState(projectId, workspaceId, (state) => ({ ...state, previousRemote }));
  }

  async appendAudit(
    projectId: string,
    workspaceId: string,
    entry: RepositoryAuditEntry,
  ): Promise<void> {
    await this.updateState(projectId, workspaceId, (state) => ({
      ...state,
      audit: [...state.audit, entry].slice(-MAX_AUDIT_ENTRIES),
    }));
  }

  private paths(projectId: string, workspaceId: string): RepositorySshCredential & {
    directory: string;
    projectDirectory: string;
    publicKeyFile: string;
    candidateIdentityFile: string;
    candidatePublicKeyFile: string;
    stateFile: string;
  } {
    const project = identifier(projectId, "project id");
    const workspace = identifier(workspaceId, "workspace id");
    const projectDirectory = join(this.root, project);
    const directory = join(projectDirectory, workspace);
    return {
      directory,
      projectDirectory,
      identityFile: join(directory, "id_ed25519"),
      publicKeyFile: join(directory, "id_ed25519.pub"),
      candidateIdentityFile: join(directory, "id_ed25519.next"),
      candidatePublicKeyFile: join(directory, "id_ed25519.next.pub"),
      knownHostsFile: join(directory, "known_hosts"),
      stateFile: join(directory, "state.json"),
    };
  }

  private async ensureDirectories(projectId: string, workspaceId: string): Promise<void> {
    const project = identifier(projectId, "project id");
    const workspace = identifier(workspaceId, "workspace id");
    await secureDirectory(this.root);
    await secureDirectory(join(this.root, project));
    await secureDirectory(join(this.root, project, workspace));
  }

  private async restorePublicKey(identityFile: string, publicKeyFile: string): Promise<void> {
    const restored = await command("/usr/bin/ssh-keygen", ["-y", "-f", identityFile]);
    if (restored.code !== 0) throw commandFailure(restored, "cannot restore repository public key");
    const publicKey = restored.stdout.trim();
    if (!publicKey.startsWith("ssh-ed25519 ")) {
      throw new RepositoryCredentialError("repository deploy key is not Ed25519");
    }
    await writeFile(publicKeyFile, `${publicKey}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
  }

  private async ensureKnownHosts(path: string): Promise<void> {
    if (!(await regularFile(path, false))) {
      try {
        await writeFile(path, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await regularFile(path, true);
      }
    }
    await chmod(path, 0o600);
  }

  private async readCredential(paths: RepositorySshCredential & { publicKeyFile: string }): Promise<ManagedRepositoryCredential> {
    const status = await lstat(paths.publicKeyFile);
    if (status.size > MAX_PUBLIC_KEY_BYTES) {
      throw new RepositoryCredentialError("repository public key is unexpectedly large");
    }
    const publicKey = (await readFile(paths.publicKeyFile, "utf8")).trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?$/.test(publicKey)) {
      throw new RepositoryCredentialError("repository public key has an invalid format");
    }
    const fingerprintResult = await command("/usr/bin/ssh-keygen", [
      "-l",
      "-E",
      "sha256",
      "-f",
      paths.publicKeyFile,
    ]);
    if (fingerprintResult.code !== 0) {
      throw commandFailure(fingerprintResult, "cannot inspect repository deploy key");
    }
    const fingerprint = fingerprintResult.stdout.match(/\bSHA256:[A-Za-z0-9+/=]+/)?.[0];
    if (!fingerprint) throw new RepositoryCredentialError("repository deploy key fingerprint is missing");
    return {
      identityFile: paths.identityFile,
      knownHostsFile: paths.knownHostsFile,
      publicKey,
      fingerprint,
    };
  }

  private emptyState(): RepositoryExperienceState {
    return { verification: null, rotationVerification: null, previousRemote: null, audit: [] };
  }

  private normalizeState(value: unknown): RepositoryExperienceState {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new RepositoryCredentialError("repository state has an invalid format");
    }
    const record = value as Partial<RepositoryExperienceState>;
    return {
      verification: record.verification && typeof record.verification === "object"
        ? record.verification as RepositoryVerificationRecord
        : null,
      rotationVerification: record.rotationVerification && typeof record.rotationVerification === "object"
        ? record.rotationVerification as RepositoryVerificationRecord
        : null,
      previousRemote: record.previousRemote && typeof record.previousRemote === "object"
        ? record.previousRemote as RepositoryRemoteChange
        : null,
      audit: Array.isArray(record.audit)
        ? record.audit.filter((entry): entry is RepositoryAuditEntry => Boolean(entry && typeof entry === "object")).slice(-MAX_AUDIT_ENTRIES)
        : [],
    };
  }

  private async updateState(
    projectId: string,
    workspaceId: string,
    update: (state: RepositoryExperienceState) => RepositoryExperienceState,
  ): Promise<void> {
    await this.ensureDirectories(projectId, workspaceId);
    const paths = this.paths(projectId, workspaceId);
    const next = update(await this.state(projectId, workspaceId));
    const temporary = join(paths.directory, `.state-${randomUUID()}.json`);
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, paths.stateFile);
    } finally {
      await rm(temporary, { force: true });
    }
    await chmod(paths.stateFile, 0o600);
  }
}
