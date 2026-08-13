import { request } from "node:http";
import type {
  IntegrationAction,
  IntegrationDeclaration,
  IntegrationMode,
} from "./integration-manifest.js";
import type { ConnectionSummary } from "./secret-vault.js";

export interface SecretLeaseRequest {
  projectId: string;
  action: IntegrationAction;
  jobId: string;
  integrations: IntegrationDeclaration[];
}

export interface SecretLease {
  id: string;
  projectId: string;
  jobId: string;
  expiresAt: number;
  environment: Record<string, string>;
  gatewayTokens: Record<string, string>;
}

export interface IntegrationModeOptions {
  integrationId: string;
  environment: string;
  requested: IntegrationMode;
  supported: IntegrationMode[];
  recommended: IntegrationMode;
}

export class SecretBrokerClientError extends Error {}

async function socketCall<T>(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return await new Promise<T>((resolveCall, reject) => {
    const handle = request(
      {
        socketPath,
        method,
        path,
        headers: encoded
          ? { "content-type": "application/json", "content-length": String(encoded.length) }
          : {},
        timeout: 30_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= 2_000_000) chunks.push(chunk);
        });
        response.on("end", () => {
          if (bytes > 2_000_000) {
            reject(new SecretBrokerClientError("secret broker response exceeds 2 MB"));
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          let value: unknown;
          try {
            value = text ? JSON.parse(text) : null;
          } catch {
            value = { error: "secret broker returned malformed JSON" };
          }
          if ((response.statusCode ?? 500) >= 400) {
            const message = value && typeof value === "object" && !Array.isArray(value) &&
              typeof (value as Record<string, unknown>).error === "string"
              ? String((value as Record<string, unknown>).error)
              : `secret broker returned HTTP ${response.statusCode ?? 500}`;
            reject(new SecretBrokerClientError(message));
            return;
          }
          resolveCall(value as T);
        });
      },
    );
    handle.once("timeout", () => handle.destroy(new Error("secret broker request timed out")));
    handle.once("error", (error) => reject(new SecretBrokerClientError(error.message)));
    handle.end(encoded ?? undefined);
  });
}

export class SecretBrokerControlClient {
  constructor(readonly socketPath: string) {}

  async available(): Promise<boolean> {
    try {
      const response = await socketCall<{ ok: boolean }>(this.socketPath, "GET", "/v1/health");
      return response.ok === true;
    } catch {
      return false;
    }
  }

  async connections(projectId: string): Promise<ConnectionSummary[]> {
    const response = await socketCall<{ connections: ConnectionSummary[] }>(
      this.socketPath,
      "GET",
      `/v1/connections?project=${encodeURIComponent(projectId)}`,
    );
    return response.connections;
  }

  async modeOptions(integrations: IntegrationDeclaration[]): Promise<IntegrationModeOptions[]> {
    const response = await socketCall<{ modes: IntegrationModeOptions[] }>(
      this.socketPath,
      "POST",
      "/v1/modes",
      { integrations },
    );
    return response.modes;
  }
}

export class SecretBrokerRuntimeClient {
  constructor(readonly socketPath: string) {}

  async lease(input: SecretLeaseRequest): Promise<SecretLease> {
    const response = await socketCall<{ lease: SecretLease }>(
      this.socketPath,
      "POST",
      "/v1/leases",
      input,
    );
    return response.lease;
  }

  async release(lease: Pick<SecretLease, "id" | "projectId" | "jobId">): Promise<void> {
    await socketCall<null>(
      this.socketPath,
      "DELETE",
      `/v1/leases/${encodeURIComponent(lease.id)}`,
      { projectId: lease.projectId, jobId: lease.jobId },
    );
  }
}
