import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "./config.js";
import {
  NodeRecoveryManager,
  parseNodeRecoveryKey,
  unwrapNodeRecoveryKey,
  wrapNodeRecoveryKey,
  type NodeRecoveryInspection,
  type NodeRecoveryTeamSpaceReference,
} from "./node-recovery.js";
import {
  NodeRecoveryStore,
  type NodeRecoveryJobRecord,
} from "./node-recovery-store.js";
import {
  LocalObjectStore,
  createObjectStore,
  type ObjectStore,
} from "./object-store.js";
import type { ProjectCatalog } from "./project-catalog.js";
import { ProjectRunnerClient } from "./project-runner-client.js";
import type { StateStore } from "./state-store.js";

export interface NodeRecoveryAdmin {
  overview(): Record<string, unknown>;
  startExport(input: {
    includeSecrets: boolean;
    confirmation?: string;
  }): NodeRecoveryJobRecord & { recoveryKey: string };
  startRestore(input: { bundleKey: string; recoveryKey: string }): NodeRecoveryJobRecord;
  confirmRestore(id: string): NodeRecoveryJobRecord;
}

function publicJob(job: NodeRecoveryJobRecord): NodeRecoveryJobRecord {
  return {
    ...job,
    request: {
      ...job.request,
      ...(job.request.wrappedRecoveryKey ? { wrappedRecoveryKey: "[stored]" } : {}),
    },
  };
}

function inspectionSummary(inspection: NodeRecoveryInspection): Record<string, unknown> {
  const sessionStates = { resumable: 0, archive_only: 0, broken_dependency: 0 };
  for (const session of inspection.inventory.sessions) sessionStates[session.state] += 1;
  return {
    backupId: inspection.backupId,
    nodeId: inspection.nodeId,
    createdAt: inspection.createdAt,
    summingVersion: inspection.summingVersion,
    includeSecrets: inspection.includeSecrets,
    ready: inspection.ready,
    components: inspection.components.map((component) => ({
      id: component.id,
      kind: component.kind,
      size: component.size,
      files: component.files,
      required: component.required,
      verified: component.verified,
    })),
    counts: {
      conversations: inspection.inventory.conversations,
      runs: inspection.inventory.runs,
      projects: inspection.inventory.projects,
      workspaces: inspection.inventory.workspaces.length,
      sessions: inspection.inventory.sessions.length,
      teamSpaceReferences: inspection.inventory.teamSpaces.length,
    },
    sessionStates,
    workspaces: inspection.inventory.workspaces,
    teamSpaces: inspection.inventory.teamSpaces,
    reconnectRequired: inspection.restore.reconnectRequired,
    excluded: inspection.restore.excluded,
    warnings: inspection.warnings,
  };
}

export class NodeRecoveryService implements NodeRecoveryAdmin {
  readonly store: NodeRecoveryStore;
  readonly objectStore: ObjectStore;
  readonly manager: NodeRecoveryManager;
  readonly configurationError: string;
  private timer: NodeJS.Timeout | null = null;
  private processing: Promise<void> | null = null;
  private closing = false;

  constructor(
    readonly config: RuntimeConfig,
    state: StateStore,
    projects: ProjectCatalog,
    teamSpaceBundles: () => NodeRecoveryTeamSpaceReference[] = () => [],
  ) {
    this.store = new NodeRecoveryStore(join(config.dataDir, "node-recovery.sqlite3"));
    let objectStore: ObjectStore;
    let configurationError = "";
    try {
      objectStore = createObjectStore(config.knowledgeSync);
    } catch (error) {
      configurationError = error instanceof Error ? error.message : String(error);
      objectStore = new LocalObjectStore(config.knowledgeSync.localObjectRoot);
    }
    this.objectStore = objectStore;
    this.configurationError = configurationError;
    const runner = new ProjectRunnerClient(config.runnerSocket);
    this.manager = new NodeRecoveryManager(
      config,
      state,
      projects,
      objectStore,
      teamSpaceBundles,
      (projectId, workspaceId) => runner.environment(projectId, workspaceId),
    );
  }

  start(): void {
    this.closing = false;
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.processing) await this.processing.catch(() => undefined);
    this.store.close();
  }

  overview(): Record<string, unknown> {
    const configured =
      this.config.knowledgeSync.objectStoreBackend === "s3" &&
      Boolean(this.config.knowledgeSync.s3Bucket) &&
      existsSync(this.config.knowledgeSync.knowledgeTransferKeyPath) &&
      !this.configurationError;
    return {
      configured,
      objectStore: this.objectStore.backend,
      bucket: this.config.knowledgeSync.s3Bucket,
      prefix: this.config.knowledgeSync.s3Prefix,
      nodeId: this.manager.nodeId,
      configurationError: this.configurationError,
      jobs: this.store.list().map(publicJob),
    };
  }

  startExport(input: {
    includeSecrets: boolean;
    confirmation?: string;
  }): NodeRecoveryJobRecord & { recoveryKey: string } {
    this.requirePortableObjectStore();
    if (input.includeSecrets && input.confirmation !== "INCLUDE SECRETS") {
      throw new Error("type INCLUDE SECRETS to include node secrets");
    }
    const id = randomUUID();
    const recoveryKey = randomBytes(32);
    try {
      const job = this.store.create({
        id,
        kind: "export",
        request: {
          includeSecrets: input.includeSecrets,
          wrappedRecoveryKey: wrapNodeRecoveryKey(
            this.config.knowledgeSync.knowledgeTransferKeyPath,
            id,
            recoveryKey,
          ),
        },
      });
      this.schedule(0);
      return { ...publicJob(job), recoveryKey: recoveryKey.toString("hex") };
    } finally {
      recoveryKey.fill(0);
    }
  }

  startRestore(input: { bundleKey: string; recoveryKey: string }): NodeRecoveryJobRecord {
    this.requirePortableObjectStore();
    const bundleKey = input.bundleKey.trim();
    if (!bundleKey) throw new Error("node recovery manifest object key is required");
    const id = randomUUID();
    const recoveryKey = parseNodeRecoveryKey(input.recoveryKey);
    try {
      const job = this.store.create({
        id,
        kind: "restore",
        bundleKey,
        request: {
          bundleKey,
          confirmed: false,
          wrappedRecoveryKey: wrapNodeRecoveryKey(
            this.config.knowledgeSync.knowledgeTransferKeyPath,
            id,
            recoveryKey,
          ),
        },
      });
      this.schedule(0);
      return publicJob(job);
    } finally {
      recoveryKey.fill(0);
    }
  }

  confirmRestore(id: string): NodeRecoveryJobRecord {
    const job = this.store.confirmRestore(id);
    this.schedule(0);
    return publicJob(job);
  }

  private requirePortableObjectStore(): void {
    if (this.configurationError) throw new Error(this.configurationError);
    if (this.objectStore.backend !== "s3") {
      throw new Error("node recovery requires an S3 object store so the bundle survives node loss");
    }
    if (!existsSync(this.config.knowledgeSync.knowledgeTransferKeyPath)) {
      throw new Error("node recovery wrapping key is not provisioned");
    }
  }

  private schedule(delay: number): void {
    if (this.closing || this.processing || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.processing = this.processQueue()
        .catch((error) => console.error("node recovery queue failed", error))
        .finally(() => {
          this.processing = null;
          if (!this.closing && this.store.list().some((job) => job.state === "queued")) {
            this.schedule(250);
          }
        });
    }, delay);
    this.timer.unref();
  }

  private async processQueue(): Promise<void> {
    while (!this.closing) {
      const job = this.store.claimNext();
      if (!job) return;
      try {
        const wrapped = String(job.request.wrappedRecoveryKey ?? "");
        const recoveryKey = unwrapNodeRecoveryKey(
          this.config.knowledgeSync.knowledgeTransferKeyPath,
          job.id,
          wrapped,
        );
        try {
          if (job.kind === "export") {
            const result = await this.manager.export({
              includeSecrets: job.request.includeSecrets === true,
              recoveryKey,
            });
            const { recoveryKey: _recoveryKey, ...stored } = result;
            this.store.succeed(job.id, stored, result.bundleKey);
            continue;
          }
          const bundleKey = String(job.request.bundleKey ?? job.bundleKey).trim();
          if (job.request.confirmed === true) {
            const staged = await this.manager.stage(bundleKey, recoveryKey);
            this.store.succeed(job.id, {
              ...inspectionSummary(staged),
              stagePath: staged.stagePath,
              activationRequired: true,
            }, bundleKey);
          } else {
            const inspection = await this.manager.inspect(bundleKey, recoveryKey);
            this.store.awaitConfirmation(job.id, inspectionSummary(inspection), bundleKey);
          }
        } finally {
          recoveryKey.fill(0);
        }
      } catch (error) {
        this.store.fail(job.id, error);
      }
    }
  }
}
