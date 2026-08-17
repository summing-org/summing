import { resolve } from "node:path";
import { GitInspector } from "./git-inspector.js";
import {
  discoverLegacyEnvironmentMigrations,
  readPinnedLegacyManifest,
  type LegacyEnvironmentMigrationTarget,
} from "./project-environment-migration.js";
import {
  ProjectRunnerClient,
  type RunnerJob,
} from "./project-runner-client.js";

export interface ProjectEnvironmentCoordinatorOptions {
  runnerSocket: string;
  configRoot: string;
  scheduleRoot: string;
  dataRoot: string;
  retryMs?: number;
  verificationTimeoutMs?: number;
}

function interrupted(): Error {
  const error = new Error("environment migration coordination was interrupted");
  error.name = "AbortError";
  return error;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(interrupted());
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolveDelay();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(interrupted());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function completedJob(
  client: ProjectRunnerClient,
  target: LegacyEnvironmentMigrationTarget,
  jobId: string,
  deadline: number,
  signal: AbortSignal,
): Promise<RunnerJob> {
  for (;;) {
    if (signal.aborted) throw interrupted();
    const job = (await client.jobs(target.projectId, target.workspaceId))
      .find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`migration verification job ${jobId} disappeared`);
    if (job.status === "completed") return job;
    if (job.status === "failed" || job.status === "cancelled") {
      throw new Error(`${job.action} migration verification failed${job.error ? `: ${job.error}` : ""}`);
    }
    if (Date.now() >= deadline) throw new Error(`${job.action} migration verification timed out`);
    await delay(1_000, signal);
  }
}

export class ProjectEnvironmentMigrationCoordinator {
  readonly client: ProjectRunnerClient;

  constructor(readonly options: ProjectEnvironmentCoordinatorOptions) {
    this.client = new ProjectRunnerClient(options.runnerSocket);
  }

  async run(signal: AbortSignal): Promise<void> {
    const pending = new Set(discoverLegacyEnvironmentMigrations(
      this.options.configRoot,
      this.options.scheduleRoot,
      this.options.dataRoot,
      false,
    ));
    while (pending.size > 0 && !signal.aborted) {
      for (const target of pending) {
        if (signal.aborted) return;
        try {
          const migration = await this.migrate(target, signal);
          console.info(
            `project environment migration verified: ${target.projectId}/${target.workspaceId} ` +
            `revision ${migration.environmentRevision}`,
          );
          pending.delete(target);
        } catch (error) {
          if (signal.aborted) return;
          console.error(
            `project environment migration pending for ${target.projectId}/${target.workspaceId}:`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (pending.size > 0) await delay(this.options.retryMs ?? 30_000, signal).catch((error) => {
        if (!signal.aborted) throw error;
      });
    }
  }

  private async migrate(
    target: LegacyEnvironmentMigrationTarget,
    signal: AbortSignal,
  ): Promise<{ environmentRevision: number }> {
    const manifest = readPinnedLegacyManifest(target.repository, target.revision);
    const imported = await this.client.importLegacyEnvironmentMigration(
      target.projectId,
      target.workspaceId,
      target.revision,
      manifest,
    );
    if (imported.verified) {
      return { environmentRevision: imported.verified.environmentRevision };
    }
    if (signal.aborted) throw interrupted();

    const inspector = new GitInspector(target.repository);
    const revision = await inspector.resolveRevision(target.revision);
    if (revision !== target.revision) throw new Error("migration schedule revision changed during verification");
    const archive = await inspector.archive(revision);
    const deadline = Date.now() + (this.options.verificationTimeoutMs ?? 1_800_000);
    const validate = await this.client.submit(
      target.projectId,
      target.workspaceId,
      "validate",
      revision,
      archive,
    );
    const completedValidate = await completedJob(
      this.client,
      target,
      validate.id,
      deadline,
      signal,
    );
    const dryRun = await this.client.submit(
      target.projectId,
      target.workspaceId,
      "dry-run",
      revision,
      archive,
    );
    const completedDryRun = await completedJob(
      this.client,
      target,
      dryRun.id,
      deadline,
      signal,
    );
    const verified = await this.client.verifyLegacyEnvironmentMigration(
      target.projectId,
      target.workspaceId,
      revision,
      completedValidate.id,
      completedDryRun.id,
    );
    return { environmentRevision: verified.environmentRevision };
  }
}

export function productionEnvironmentMigrationCoordinator(
  runnerSocket: string,
): ProjectEnvironmentMigrationCoordinator {
  const dataRoot = process.env.SUMMING_RUNNER_DATA || "/var/lib/summing-runner/jobs";
  const configRoot = process.env.SUMMING_RUNNER_CONFIG || "/etc/summing-runner/projects";
  return new ProjectEnvironmentMigrationCoordinator({
    runnerSocket,
    dataRoot,
    configRoot,
    scheduleRoot: process.env.SUMMING_RUNNER_SCHEDULES || resolve(configRoot, "..", "schedules"),
  });
}
