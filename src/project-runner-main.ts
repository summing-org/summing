import { ProjectRunnerServer } from "./project-runner-server.js";

const server = new ProjectRunnerServer(
  process.env.SUMMING_RUNNER_SOCKET || "/run/summing-runner/runner.sock",
  process.env.SUMMING_RUNNER_DATA || "/var/lib/summing-runner/jobs",
  process.env.SUMMING_RUNNER_CONFIG || "/etc/summing-runner/projects",
  process.env.SUMMING_RUNNER_DOCKER || "/usr/bin/docker",
  process.env.SUMMING_SECRETS_RUNTIME_SOCKET || "/run/summing-secrets/runtime.sock",
  process.env.SUMMING_SECRETS_GATEWAY_SOCKET || "/run/summing-secrets/gateway.sock",
);

const stop = (): void => {
  void server.close().finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

server.start().catch((error) => {
  console.error("fatal project runner error", error);
  process.exitCode = 1;
});
