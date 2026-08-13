import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProviderRegistry } from "./provider-registry.js";
import { SecretBrokerServer } from "./secret-broker-server.js";
import { readMasterKey, SecretVault } from "./secret-vault.js";

function integer(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
  return parsed;
}

function optionalGroup(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a numeric group id`);
  return parsed;
}

async function main(): Promise<void> {
  const publicUrl = String(process.env.SUMMING_CONNECTIONS_URL ?? "").trim();
  if (!publicUrl) throw new Error("SUMMING_CONNECTIONS_URL is required");
  const dataRoot = resolve(process.env.SUMMING_SECRETS_DATA || "/var/lib/summing-secrets");
  const masterKey = readMasterKey(
    resolve(process.env.SUMMING_SECRETS_MASTER_KEY_FILE || "/etc/summing-secrets/master.key"),
  );
  const vault = new SecretVault(resolve(dataRoot, "secrets.sqlite3"), masterKey);
  masterKey.fill(0);
  const controlGroupId = optionalGroup(process.env.SUMMING_CONTROL_GID, "SUMMING_CONTROL_GID");
  const runtimeGroupId = optionalGroup(process.env.SUMMING_RUNNER_GID, "SUMMING_RUNNER_GID");
  const server = new SecretBrokerServer({
    publicHost: process.env.SUMMING_SECRETS_HOST || "127.0.0.1",
    publicPort: integer(process.env.SUMMING_SECRETS_PORT, 8_767, "SUMMING_SECRETS_PORT"),
    publicUrl,
    controlSocket:
      process.env.SUMMING_SECRETS_CONTROL_SOCKET || "/run/summing-secrets/control.sock",
    runtimeSocket:
      process.env.SUMMING_SECRETS_RUNTIME_SOCKET || "/run/summing-secrets/runtime.sock",
    gatewaySocket:
      process.env.SUMMING_SECRETS_GATEWAY_SOCKET || "/run/summing-secrets/gateway.sock",
    ...(controlGroupId === undefined ? {} : { controlGroupId }),
    ...(runtimeGroupId === undefined ? {} : { runtimeGroupId }),
    ticketPublicKey: readFileSync(
      resolve(process.env.SUMMING_CONNECTION_TICKET_PUBLIC_KEY || "/etc/summing-secrets/ticket-public.pem"),
    ),
    providers: ProviderRegistry.load(
      resolve(process.env.SUMMING_PROVIDER_REGISTRY || "/etc/summing-secrets/providers.json"),
    ),
    vault,
  });
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolveSignalPromise) => {
    resolveSignal = resolveSignalPromise;
  });
  const onSignal = (): void => resolveSignal();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await server.start();
    await signal;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await server.close();
    vault.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
