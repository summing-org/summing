import type { ProjectConfig } from "./config.js";
import type { ProjectCatalog } from "./project-catalog.js";
import type {
  ProjectRunnerClient,
  RunnerProjectRegistration,
} from "./project-runner-client.js";

export interface ManagedProjectRunnerClient {
  registerProject(
    projectId: string,
    workspaceIds: readonly string[],
  ): Promise<RunnerProjectRegistration>;
}

export class ManagedProjectRunnerRegistry {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private reconciling: Promise<void> | null = null;
  private readonly failures = new Map<string, string>();

  constructor(
    readonly runner: ManagedProjectRunnerClient | ProjectRunnerClient,
    readonly projects: ProjectCatalog,
    readonly retryMilliseconds = 30_000,
  ) {}

  async start(): Promise<void> {
    if (this.stopped) return;
    await this.reconcileAll();
    this.schedule();
  }

  async register(project: ProjectConfig): Promise<void> {
    try {
      await this.runner.registerProject(project.id, [...project.workspaces.keys()]);
      if (this.failures.delete(project.id)) {
        console.info(`project runner registration recovered for ${project.id}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.failures.get(project.id) !== message) {
        console.warn(`project runner registration pending for ${project.id}: ${message}`);
      }
      this.failures.set(project.id, message);
    }
  }

  async reconcileAll(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    const work = Promise.all(
      this.projects.all()
        .filter((entry) => entry.managed)
        .map((entry) => this.register(entry.project)),
    ).then(() => {});
    this.reconciling = work;
    try {
      await work;
    } finally {
      if (this.reconciling === work) this.reconciling = null;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcileAll().finally(() => this.schedule());
    }, this.retryMilliseconds);
    this.timer.unref();
  }
}
