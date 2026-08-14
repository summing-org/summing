import { request } from "node:http";
import type { ProjectEnvironmentDocument } from "./project-environment.js";

export type RunnerAction = "build" | "validate" | "dry-run" | "run";
export type RunnerJobStatus = "queued" | "running" | "completed" | "failed";

export interface RunnerJob {
  id: string;
  projectId: string;
  workspaceId: string;
  action: RunnerAction;
  revision: string;
  status: RunnerJobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  artifactCount?: number;
  environmentRevision?: number;
}

export interface RunnerArtifact {
  name: string;
  bytes: number;
  contentType: string;
}

export interface RunnerArtifactContent extends RunnerArtifact {
  content: string;
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

  async available(): Promise<boolean> {
    try {
      const result = await this.call<{ ok: boolean }>("GET", "/health");
      return result.ok === true;
    } catch {
      return false;
    }
  }

  async submit(
    projectId: string,
    workspaceId: string,
    action: RunnerAction,
    revision: string,
    archive: Buffer,
  ): Promise<RunnerJob> {
    const query = new URLSearchParams({ project: projectId, workspace: workspaceId, action, revision });
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
}
