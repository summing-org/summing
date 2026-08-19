import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readOrCreateEnvironmentKey } from "./project-environment.js";
import { discoverLegacyEnvironmentMigrations } from "./project-environment-migration.js";
import { ProjectRunnerServer } from "./project-runner-server.js";

async function main(): Promise<void> {
  const socketPath = process.env.SUMMING_RUNNER_SOCKET ||
    "/run/summing-project-runner/runner.sock";
  const dataRoot = process.env.SUMMING_RUNNER_DATA ||
    "/var/lib/summing-project-runner/jobs";
  const configRoot = process.env.SUMMING_RUNNER_CONFIG ||
    "/etc/summing-project-runner/projects";
  const managedDataRoot = process.env.SUMMING_RUNNER_MANAGED_DATA ||
    "/var/lib/summing-project-runs";
  const scheduleRoot = process.env.SUMMING_RUNNER_SCHEDULES || resolve(configRoot, "..", "schedules");
  const configuredKeyPath = String(process.env.SUMMING_RUNNER_ENV_KEY ?? "").trim();
  const installedKeyPath = "/etc/summing-project-runner/environment.key";
  const keyPath = configuredKeyPath || (
    existsSync(installedKeyPath)
      ? installedKeyPath
      : resolve(dataRoot, "..", "environment.key")
  );
  const key = readOrCreateEnvironmentKey(keyPath);
  const migrations = discoverLegacyEnvironmentMigrations(configRoot, scheduleRoot, dataRoot);

  const server = new ProjectRunnerServer(
    socketPath,
    dataRoot,
    configRoot,
    process.env.SUMMING_RUNNER_DOCKER || "/usr/bin/docker",
    key,
    migrations.length === 0,
    migrations,
    process.env.SUMMING_SECRETS_RUNTIME_SOCKET || "/run/summing-secrets/runtime.sock",
    managedDataRoot,
  );
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolveSignalPromise) => {
    resolveSignal = resolveSignalPromise;
  });
  const stop = (): void => resolveSignal();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await server.start();
    await signal;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await server.close();
    key.fill(0);
  }
}

main().catch((error) => {
  console.error("fatal project runner error", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
