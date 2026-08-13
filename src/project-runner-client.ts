import { request } from "node:http";

export type RunnerAction = "build" | "validate" | "dry-run" | "run";
export type RunnerJobStatus = "queued" | "running" | "completed" | "failed";

export interface RunnerJob {
  id: string;
  projectId: string;
  action: RunnerAction;
  revision: string;
  status: RunnerJobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  error?: string;
  artifactCount?: number;
}

export interface RunnerArtifact {
  name: string;
  bytes: number;
  contentType: string;
}

export interface RunnerArtifactContent extends RunnerArtifact {
  content: string;
}

export class ProjectRunnerClientError extends Error {}

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
              reject(new ProjectRunnerClientError(message));
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
    action: RunnerAction,
    revision: string,
    archive: Buffer,
  ): Promise<RunnerJob> {
    const query = new URLSearchParams({ project: projectId, action, revision });
    const result = await this.call<{ job: RunnerJob }>(
      "POST",
      `/jobs?${query.toString()}`,
      archive,
      "application/x-tar",
    );
    return result.job;
  }

  async jobs(projectId: string): Promise<RunnerJob[]> {
    const result = await this.call<{ jobs: RunnerJob[] }>(
      "GET",
      `/jobs?project=${encodeURIComponent(projectId)}`,
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
}
