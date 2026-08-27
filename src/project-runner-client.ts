import { request } from "node:http";
import type { ProjectEnvironmentDocument } from "./project-environment.js";
import type {
  EnvironmentVerificationMarker,
} from "./project-environment-migration.js";
import type { RunnerService, RunnerServiceAction } from "./project-service.js";

export type {
  RunnerService,
  RunnerServiceAction,
  RunnerServiceDesiredState,
  RunnerServiceRevision,
  RunnerServiceStatus,
} from "./project-service.js";

export type RunnerAction = "build" | "validate" | "dry-run" | "run" | "provision";
export type RunnerSchedulableAction = Exclude<RunnerAction, "provision">;
export type RunnerJobTrigger = "manual" | "schedule" | "replay";

export interface RunnerSubmissionMetadata {
  trigger?: RunnerJobTrigger;
  scheduleId?: string;
  scheduledFor?: string;
  idempotencyKey?: string;
  provisionId?: string;
}

export type RunnerJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed"
  | "interrupted";

export interface RunnerJob {
  id: string;
  releaseId?: string;
  projectId: string;
  workspaceId: string;
  action: RunnerAction;
  revision: string;
  archiveSha256?: string;
  configSha256?: string;
  environmentSha256?: string;
  imageId?: string;
  replayOfJobId?: string;
  trigger?: RunnerJobTrigger;
  scheduleId?: string;
  scheduledFor?: string;
  idempotencyKey?: string;
  status: RunnerJobStatus;
  createdAt: string;
  startedAt?: string;
  cancelRequestedAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  artifactCount?: number;
  portalMessageCount?: number;
  environmentRevision?: number;
  provisionId?: string;
  provisionedVariables?: string[];
  consumedVariables?: string[];
  resultingEnvironmentRevision?: number;
}

export interface RunnerPortalMessage {
  id: string;
  type: "text" | "document" | "video";
  text: string;
  artifact: string | null;
  portalKey?: string | null;
}

export interface RunnerPortalMessageBatch {
  projectId: string;
  workspaceId: string;
  jobId: string;
  messages: RunnerPortalMessage[];
  createdAt: string;
}

export interface RunnerArtifact {
  name: string;
  bytes: number;
  contentType: string;
}

export interface RunnerArtifactContent extends RunnerArtifact {
  content: string;
}

export interface RunnerArtifactData extends RunnerArtifact {
  data: Uint8Array;
}

export interface RunnerArtifactDeletion extends RunnerArtifact {
  jobId: string;
  deletedAt: string;
}

export interface RunnerEnvironmentMigration {
  projectId: string;
  workspaceId: string;
  environmentRevision: number;
  variableNames: string[];
  verified: EnvironmentVerificationMarker | null;
}

export interface RunnerProjectRegistration {
  projectId: string;
  workspaceIds: string[];
  source: "managed" | "static";
}

export interface RunnerHealth {
  ok: boolean;
  version: string;
  protocolVersion: number;
  queued: number;
  running: number;
  maxParallelJobs: number;
  runTimeoutHours: number;
  servicePortRange: [number, number];
}

export class ProjectRunnerClientError extends Error {
  constructor(message: string, readonly status = 503) {
    super(message);
  }
}

export class ProjectRunnerClient {
  constructor(readonly socketPath: string) {}

  private call<T>(
    method: string,
    path: string,
    body?: Buffer,
    contentType = "application/json",
  ): Promise<T> {
    return new Promise((resolveCall, reject) => {
      const requestHandle = request(
        {
          socketPath: this.socketPath,
          agent: false,
          method,
          path,
          headers: body
            ? { "content-type": contentType, "content-length": String(body.length) }
            : {},
          timeout: 120_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          let tooLarge = false;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes <= 12_000_000) chunks.push(chunk);
            else tooLarge = true;
          });
          response.on("end", () => {
            if (tooLarge) {
              reject(new ProjectRunnerClientError("runner response exceeds 12 MB"));
              return;
            }
            const raw = Buffer.concat(chunks).toString("utf8");
            let value: unknown;
            try {
              value = raw ? JSON.parse(raw) : null;
            } catch {
              value = { error: raw || `runner returned HTTP ${response.statusCode ?? 500}` };
            }
            if ((response.statusCode ?? 500) >= 400) {
              const message =
                value && typeof value === "object" && !Array.isArray(value) &&
                typeof (value as Record<string, unknown>).error === "string"
                  ? String((value as Record<string, unknown>).error)
                  : `runner returned HTTP ${response.statusCode ?? 500}`;
              reject(new ProjectRunnerClientError(message, response.statusCode ?? 500));
              return;
            }
            resolveCall(value as T);
          });
        },
      );
      requestHandle.once("timeout", () => requestHandle.destroy(new Error("runner request timed out")));
      requestHandle.once("error", (error) => reject(new ProjectRunnerClientError(error.message)));
      if (body) requestHandle.end(body);
      else requestHandle.end();
    });
  }

  private callBinary(path: string, maximumBytes = 20_000_000): Promise<{
    data: Uint8Array;
    contentType: string;
  }> {
    return new Promise((resolveCall, reject) => {
      const requestHandle = request(
        {
          socketPath: this.socketPath,
          agent: false,
          method: "GET",
          path,
          timeout: 120_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          let tooLarge = false;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes <= maximumBytes) chunks.push(chunk);
            else tooLarge = true;
          });
          response.on("end", () => {
            if (tooLarge) {
              reject(new ProjectRunnerClientError(`runner artifact exceeds ${maximumBytes} bytes`, 413));
              return;
            }
            const data = Buffer.concat(chunks);
            if ((response.statusCode ?? 500) >= 400) {
              let message = data.toString("utf8") || `runner returned HTTP ${response.statusCode ?? 500}`;
              try {
                const parsed = JSON.parse(message) as { error?: unknown };
                if (typeof parsed.error === "string") message = parsed.error;
              } catch {
                // Preserve the bounded response text when it is not JSON.
              }
              reject(new ProjectRunnerClientError(message, response.statusCode ?? 500));
              return;
            }
            resolveCall({
              data: Uint8Array.from(data),
              contentType: String(response.headers["content-type"] ?? "application/octet-stream"),
            });
          });
        },
      );
      requestHandle.once("timeout", () => requestHandle.destroy(new Error("runner request timed out")));
      requestHandle.once("error", (error) => reject(new ProjectRunnerClientError(error.message)));
      requestHandle.end();
    });
  }

  async available(): Promise<boolean> {
    try {
      return (await this.health()).ok === true;
    } catch {
      return false;
    }
  }

  async health(): Promise<RunnerHealth> {
    return await this.call<RunnerHealth>("GET", "/health");
  }

  async registerProject(
    projectId: string,
    workspaceIds: readonly string[],
  ): Promise<RunnerProjectRegistration> {
    const query = new URLSearchParams({ project: projectId });
    const body = Buffer.from(JSON.stringify({ workspaceIds }), "utf8");
    const result = await this.call<{ project: RunnerProjectRegistration }>(
      "PUT",
      `/projects?${query.toString()}`,
      body,
    );
    return result.project;
  }

  async registeredProject(projectId: string): Promise<RunnerProjectRegistration> {
    const query = new URLSearchParams({ project: projectId });
    const result = await this.call<{ project: RunnerProjectRegistration }>(
      "GET",
      `/projects?${query.toString()}`,
    );
    return result.project;
  }

  async submit(
    projectId: string,
    workspaceId: string,
    action: RunnerAction,
    revision: string,
    archive: Buffer,
    metadata: RunnerSubmissionMetadata = {},
  ): Promise<RunnerJob> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId, action, revision });
    if (metadata.trigger) query.set("trigger", metadata.trigger);
    if (metadata.scheduleId) query.set("schedule", metadata.scheduleId);
    if (metadata.scheduledFor) query.set("scheduled_for", metadata.scheduledFor);
    if (metadata.idempotencyKey) query.set("idempotency_key", metadata.idempotencyKey);
    if (metadata.provisionId) query.set("provision", metadata.provisionId);
    const result = await this.call<{ job: RunnerJob }>(
      "POST",
      `/jobs?${query.toString()}`,
      archive,
      "application/x-tar",
    );
    return result.job;
  }

  async jobs(projectId: string, workspaceId: string): Promise<RunnerJob[]> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId });
    const result = await this.call<{ jobs: RunnerJob[] }>(
      "GET",
      `/jobs?${query.toString()}`,
    );
    return result.jobs;
  }

  async replay(
    projectId: string,
    workspaceId: string,
    jobId: string,
    idempotencyKey: string,
  ): Promise<RunnerJob> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId, job: jobId });
    query.set("idempotency_key", idempotencyKey);
    const result = await this.call<{ job: RunnerJob }>(
      "POST",
      `/jobs/replay?${query.toString()}`,
    );
    return result.job;
  }

  async cancel(projectId: string, workspaceId: string, jobId: string): Promise<RunnerJob> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId, job: jobId });
    const result = await this.call<{ job: RunnerJob }>(
      "POST",
      `/jobs/cancel?${query.toString()}`,
    );
    return result.job;
  }

  async services(projectId: string, workspaceId: string): Promise<RunnerService[]> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId });
    const result = await this.call<{ services: RunnerService[] }>(
      "GET",
      `/services?${query.toString()}`,
    );
    return result.services;
  }

  async deployService(
    projectId: string,
    workspaceId: string,
    name: string,
    releaseId: string,
    idempotencyKey: string,
  ): Promise<RunnerService> {
    const body = Buffer.from(JSON.stringify({ name, releaseId, idempotencyKey }), "utf8");
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId });
    const result = await this.call<{ service: RunnerService }>(
      "POST",
      `/services/deploy?${query.toString()}`,
      body,
    );
    return result.service;
  }

  async serviceAction(
    projectId: string,
    workspaceId: string,
    name: string,
    action: RunnerServiceAction,
    idempotencyKey: string,
  ): Promise<RunnerService> {
    const body = Buffer.from(JSON.stringify({ name, action, idempotencyKey }), "utf8");
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId });
    const result = await this.call<{ service: RunnerService }>(
      "POST",
      `/services/action?${query.toString()}`,
      body,
    );
    return result.service;
  }

  async serviceLog(projectId: string, workspaceId: string, name: string): Promise<string> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId, name });
    const result = await this.call<{ log: string }>(
      "GET",
      `/service-log?${query.toString()}`,
    );
    return result.log;
  }

  async log(projectId: string, jobId: string): Promise<string> {
    const query = new URLSearchParams({ project: projectId, job: jobId });
    const result = await this.call<{ log: string }>("GET", `/logs?${query.toString()}`);
    return result.log;
  }

  async artifacts(projectId: string, jobId: string): Promise<RunnerArtifact[]> {
    const query = new URLSearchParams({ project: projectId, job: jobId });
    const result = await this.call<{ artifacts: RunnerArtifact[] }>(
      "GET",
      `/artifacts?${query.toString()}`,
    );
    return result.artifacts;
  }

  async artifact(projectId: string, jobId: string, name: string): Promise<RunnerArtifactContent> {
    const query = new URLSearchParams({ project: projectId, job: jobId, name });
    const result = await this.call<{ artifact: RunnerArtifactContent }>(
      "GET",
      `/artifact?${query.toString()}`,
    );
    return result.artifact;
  }

  async artifactData(projectId: string, jobId: string, name: string): Promise<RunnerArtifactData> {
    const query = new URLSearchParams({ project: projectId, job: jobId, name });
    const result = await this.callBinary(`/artifact/data?${query.toString()}`);
    return {
      name,
      bytes: result.data.byteLength,
      contentType: result.contentType,
      data: result.data,
    };
  }

  async portalMessages(
    projectId: string,
    workspaceId: string,
    jobId: string,
  ): Promise<RunnerPortalMessageBatch> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId, job: jobId });
    const result = await this.call<{ batch: RunnerPortalMessageBatch }>(
      "GET",
      `/portal/messages?${query.toString()}`,
    );
    return result.batch;
  }


  async deleteArtifact(
    projectId: string,
    workspaceId: string,
    jobId: string,
    name: string,
  ): Promise<RunnerArtifactDeletion> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId, job: jobId, name });
    const result = await this.call<{ deleted: RunnerArtifactDeletion }>(
      "DELETE",
      `/artifact?${query.toString()}`,
    );
    return result.deleted;
  }

  async environment(projectId: string, workspaceId: string): Promise<ProjectEnvironmentDocument> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId });
    const result = await this.call<{ environment: ProjectEnvironmentDocument }>(
      "GET",
      `/environment?${query.toString()}`,
    );
    return result.environment;
  }

  async saveEnvironment(
    projectId: string,
    workspaceId: string,
    text: string,
    expectedRevision: number,
  ): Promise<ProjectEnvironmentDocument> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId });
    const body = Buffer.from(JSON.stringify({ text, expectedRevision }), "utf8");
    const result = await this.call<{ environment: ProjectEnvironmentDocument }>(
      "PUT",
      `/environment?${query.toString()}`,
      body,
    );
    return result.environment;
  }

  async importLegacyEnvironmentMigration(
    projectId: string,
    workspaceId: string,
    revision: string,
    manifest: string,
  ): Promise<RunnerEnvironmentMigration> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId, revision });
    const body = Buffer.from(JSON.stringify({ manifest }), "utf8");
    const result = await this.call<{ migration: RunnerEnvironmentMigration }>(
      "POST",
      `/migration/import?${query.toString()}`,
      body,
    );
    return result.migration;
  }

  async verifyLegacyEnvironmentMigration(
    projectId: string,
    workspaceId: string,
    revision: string,
    validateJobId: string,
    dryRunJobId: string,
  ): Promise<EnvironmentVerificationMarker> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId, revision });
    const body = Buffer.from(JSON.stringify({ validateJobId, dryRunJobId }), "utf8");
    const result = await this.call<{ verification: EnvironmentVerificationMarker & { status: string } }>(
      "POST",
      `/migration/verify?${query.toString()}`,
      body,
    );
    return result.verification;
  }
}
