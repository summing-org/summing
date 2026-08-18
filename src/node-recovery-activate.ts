import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  NodeRecoveryManager,
  parseNodeRecoveryKey,
  type NodeRecoveryProjectEnvironment,
} from "./node-recovery.js";
import { createObjectStore } from "./object-store.js";
import { ProjectCatalog } from "./project-catalog.js";
import { ProjectEnvironmentStore, readEnvironmentKey } from "./project-environment.js";
import { StateStore } from "./state-store.js";

interface Arguments {
  bundleKey: string;
  keyFile: string;
  environmentFile: string;
  stagingRoot: string;
}

interface RollbackEntry {
  destination: string;
  backup: string;
  existed: boolean;
}

interface WorkspaceMetadata {
  id: string;
  originalPath: string;
  state: "captured" | "missing" | "not-git" | "failed";
  git: { branch: string; head: string } | null;
}

function argumentsFrom(values: string[]): Arguments {
  const result: Arguments = {
    bundleKey: "",
    keyFile: "",
    environmentFile: "/etc/summing/summing.env",
    stagingRoot: "/run/summing-node-recovery",
  };
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    const value = values[index + 1] ?? "";
    if (flag === "--bundle") result.bundleKey = value;
    else if (flag === "--key-file") result.keyFile = value;
    else if (flag === "--environment-file") result.environmentFile = value;
    else if (flag === "--staging-root") result.stagingRoot = value;
    else throw new Error(`unknown node recovery activation argument: ${flag}`);
    index += 1;
  }
  if (!result.bundleKey || !result.keyFile) {
    throw new Error("usage: node-recovery-activate --bundle OBJECT_KEY --key-file FILE");
  }
  return result;
}

function regularPrivateFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function environmentValue(raw: string): string {
  const value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).replace(/\\([\\"'])/g, "$1");
  }
  return value.replace(/\\(.)/g, "$1");
}

function loadEnvironmentFile(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("SUMMING environment file must be a regular file");
  }
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const name = separator < 0 ? "" : line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid variable in SUMMING environment file: ${name || "[empty]"}`);
    }
    process.env[name] = environmentValue(line.slice(separator + 1));
  }
}

function within(root: string, path: string): boolean {
  const canonicalRoot = resolve(root);
  const canonicalPath = resolve(path);
  return canonicalPath === canonicalRoot || canonicalPath.startsWith(`${canonicalRoot}${sep}`);
}

function safeRollbackPath(root: string, destination: string): string {
  const canonical = resolve(destination);
  if (!canonical.startsWith("/")) throw new Error("rollback destination must be absolute");
  return join(root, "rootfs", ...canonical.slice(1).split("/"));
}

function backupDestination(
  destination: string,
  rollbackRoot: string,
  entries: Map<string, RollbackEntry>,
): void {
  const canonical = resolve(destination);
  if (entries.has(canonical)) return;
  const backup = safeRollbackPath(rollbackRoot, canonical);
  const existed = existsSync(canonical);
  if (existed) {
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    cpSync(canonical, backup, { recursive: true, dereference: false, preserveTimestamps: true });
  }
  entries.set(canonical, { destination: canonical, backup, existed });
}

function replacePath(
  source: string,
  destination: string,
  rollbackRoot: string,
  entries: Map<string, RollbackEntry>,
): void {
  if (!existsSync(source)) return;
  backupDestination(destination, rollbackRoot, entries);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  cpSync(source, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}

function rollback(entries: Map<string, RollbackEntry>): void {
  for (const entry of [...entries.values()].reverse()) {
    rmSync(entry.destination, { recursive: true, force: true });
    if (!entry.existed) continue;
    mkdirSync(dirname(entry.destination), { recursive: true, mode: 0o700 });
    cpSync(entry.backup, entry.destination, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
}

function git(repository: string, args: string[]): void {
  execFileSync("git", ["-C", repository, ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function restoreWorkspace(
  componentRoot: string,
  metadata: WorkspaceMetadata,
  allowedRoots: string[],
  rollbackRoot: string,
  entries: Map<string, RollbackEntry>,
): string {
  const destination = resolve(metadata.originalPath);
  if (!allowedRoots.some((root) => within(root, destination))) {
    return `workspace ${metadata.id} was not activated because its path is outside managed roots`;
  }
  if (metadata.state === "missing" || metadata.state === "failed") {
    return `workspace ${metadata.id} is ${metadata.state} and was not activated`;
  }
  backupDestination(destination, rollbackRoot, entries);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const payload = join(componentRoot, "payload");
  if (metadata.state === "not-git") {
    const tree = join(payload, "tree");
    if (existsSync(tree)) cpSync(tree, destination, { recursive: true, dereference: false });
    return `workspace ${metadata.id} restored as a non-Git tree`;
  }
  const meta = join(payload, "meta");
  const bundle = join(meta, "repository.bundle");
  if (!metadata.git || !existsSync(bundle)) throw new Error(`workspace ${metadata.id} Git bundle is missing`);
  execFileSync("git", ["clone", "--no-local", bundle, destination], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (metadata.git.branch === "detached") {
    git(destination, ["checkout", "--detach", metadata.git.head]);
  } else {
    git(destination, ["checkout", "-B", metadata.git.branch, metadata.git.head]);
  }
  const stagedPatch = join(meta, "staged.patch");
  if (existsSync(stagedPatch) && statSync(stagedPatch).size > 0) {
    git(destination, ["apply", "--index", "--binary", stagedPatch]);
  }
  const workingPatch = join(meta, "working.patch");
  if (existsSync(workingPatch) && statSync(workingPatch).size > 0) {
    git(destination, ["apply", "--binary", workingPatch]);
  }
  const untracked = join(payload, "untracked");
  if (existsSync(untracked)) {
    for (const child of readdirSync(untracked)) {
      cpSync(join(untracked, child), join(destination, child), {
        recursive: true,
        dereference: false,
        force: false,
        errorOnExist: true,
      });
    }
  }
  return `workspace ${metadata.id} restored at ${destination}`;
}

function ownership(path: string, user: string, group: string, mode?: number): void {
  if (!existsSync(path)) return;
  execFileSync("chown", ["-R", `${user}:${group}`, path], { stdio: "ignore" });
  if (mode !== undefined) chmodSync(path, mode);
}

export async function activateNodeRecovery(input: Arguments): Promise<{
  backupId: string;
  rollbackPath: string;
  messages: string[];
}> {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("node recovery activation must run as root");
  }
  if (!regularPrivateFile(input.keyFile)) {
    throw new Error("node recovery key file must be a private regular file");
  }
  loadEnvironmentFile(input.environmentFile);
  const config = loadConfig(process.env);
  if (config.knowledgeSync.objectStoreBackend !== "s3") {
    throw new Error("node recovery activation requires the S3 object store");
  }
  const recoveryKey = parseNodeRecoveryKey(readFileSync(input.keyFile, "utf8"));
  const state = new StateStore(join(config.dataDir, "state.sqlite3"));
  mkdirSync(resolve(input.stagingRoot), { recursive: true, mode: 0o700 });
  const stageRoot = mkdtempSync(join(resolve(input.stagingRoot), "verified-"));
  let stagedPath = "";
  try {
    const manager = new NodeRecoveryManager(
      config,
      state,
      new ProjectCatalog(config, state),
      createObjectStore(config.knowledgeSync),
    );
    const staged = await manager.stage(input.bundleKey, recoveryKey, stageRoot);
    stagedPath = staged.stagePath;
  } finally {
    recoveryKey.fill(0);
    state.close();
  }

  const plan = JSON.parse(readFileSync(join(stagedPath, "restore-plan.json"), "utf8")) as {
    backupId: string;
    includeSecrets: boolean;
    inventory: { workspaces: WorkspaceMetadata[] };
  };
  if (!/^[0-9a-f-]{36}$/.test(plan.backupId)) throw new Error("staged recovery plan is invalid");
  const rollbackPath = `/var/backups/summing-node-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}-${plan.backupId}`;
  mkdirSync(rollbackPath, { recursive: false, mode: 0o700 });
  const entries = new Map<string, RollbackEntry>();
  const messages: string[] = [];
  const component = (id: string): string => join(stagedPath, "components", id);
  try {
    const nodeState = join(component("node-state"), "payload", "data");
    for (const file of ["state.sqlite3", "runner-control.sqlite3", "node-id"] as const) {
      replacePath(join(nodeState, file), join(config.dataDir, file), rollbackPath, entries);
      rmSync(join(config.dataDir, `${file}-wal`), { force: true });
      rmSync(join(config.dataDir, `${file}-shm`), { force: true });
    }
    for (const directory of ["memory", "projects"] as const) {
      replacePath(join(nodeState, directory), join(config.dataDir, directory), rollbackPath, entries);
    }
    replacePath(
      join(component("codex-sessions"), "payload", "data", "codex", "sessions"),
      join(config.codexHome, "sessions"),
      rollbackPath,
      entries,
    );
    replacePath(
      join(component("codex-sessions"), "payload", "data", "codex", "archived_sessions"),
      join(config.codexHome, "archived_sessions"),
      rollbackPath,
      entries,
    );
    replacePath(
      join(component("codex-sessions"), "payload", "data", "codex", "session_index.jsonl"),
      join(config.codexHome, "session_index.jsonl"),
      rollbackPath,
      entries,
    );
    for (const id of ["run-artifacts", "attachments"] as const) {
      replacePath(
        join(component(id), "payload", "data", id),
        join(config.dataDir, id),
        rollbackPath,
        entries,
      );
    }

    const allowedRoots = [join(config.dataDir, "repositories"), config.worktreeRoot];
    for (const workspace of plan.inventory.workspaces) {
      messages.push(restoreWorkspace(
        component(`workspace-${workspace.id}`),
        workspace,
        allowedRoots,
        rollbackPath,
        entries,
      ));
    }

    if (plan.includeSecrets && existsSync(component("secrets"))) {
      const secrets = join(component("secrets"), "payload");
      const configPath = resolve(process.env.SUMMING_CONFIG || join(config.dataDir, "config.toml"));
      const tdlibRoot = resolve(dirname(config.knowledgeSync.spoolRoot), "tdlib");
      replacePath(join(secrets, "data", "config.toml"), configPath, rollbackPath, entries);
      replacePath(
        join(secrets, "data", "connector-core", "core.sqlite"),
        join(config.dataDir, "core.sqlite"),
        rollbackPath,
        entries,
      );
      replacePath(join(secrets, "data", "tdlib"), tdlibRoot, rollbackPath, entries);
      replacePath(
        join(secrets, "data", "repository-credentials"),
        join(config.dataDir, "repository-credentials"),
        rollbackPath,
        entries,
      );
      for (const file of ["summing.env", "mtproto.key", "kb-transfer.key"] as const) {
        replacePath(join(secrets, "etc", "summing", file), `/etc/summing/${file}`, rollbackPath, entries);
      }
      const environmentsPath = join(secrets, "data", "connector-core", "project-environments.json");
      if (existsSync(environmentsPath)) {
        const environmentRoot = "/var/lib/summing-runner/jobs/environments";
        backupDestination(environmentRoot, rollbackPath, entries);
        const environments = JSON.parse(readFileSync(environmentsPath, "utf8")) as NodeRecoveryProjectEnvironment[];
        if (!Array.isArray(environments)) throw new Error("project environment recovery catalog is invalid");
        const environmentKey = readEnvironmentKey("/etc/summing-runner/environment.key");
        try {
          const environmentStore = new ProjectEnvironmentStore(environmentRoot, environmentKey);
          for (const environment of environments) {
            const current = environmentStore.get(environment.projectId, environment.workspaceId);
            if (current.text === environment.text) continue;
            environmentStore.save(
              environment.projectId,
              environment.workspaceId,
              environment.text,
              current.revision,
            );
          }
        } finally {
          environmentKey.fill(0);
        }
      }
    }

    ownership(config.dataDir, "summing", "summing");
    ownership(config.codexHome, "summing", "summing", 0o700);
    ownership(config.worktreeRoot, "summing", "summing", 0o700);
    ownership("/etc/summing/summing.env", "root", "summing", 0o440);
    ownership("/etc/summing/mtproto.key", "root", "summing", 0o440);
    ownership("/etc/summing/kb-transfer.key", "root", "summing", 0o440);
    ownership("/etc/summing-runner/environment.key", "root", "summing-runner", 0o440);
    ownership("/var/lib/summing-runner/jobs/environments", "summing-runner", "summing-runner", 0o700);
    writeFileSync(join(rollbackPath, "activation.json"), `${JSON.stringify({
      backupId: plan.backupId,
      activatedAt: new Date().toISOString(),
      destinations: [...entries.keys()],
      messages,
    }, null, 2)}\n`, { mode: 0o600 });
    return { backupId: plan.backupId, rollbackPath, messages };
  } catch (error) {
    rollback(entries);
    writeFileSync(join(rollbackPath, "activation-failed.txt"), `${String(error)}\n`, { mode: 0o600 });
    throw error;
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const input = argumentsFrom(process.argv.slice(2));
  const result = await activateNodeRecovery(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry && entry === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`Node recovery activation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
