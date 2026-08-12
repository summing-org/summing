import { ProjectRunnerServer } from "./project-runner-server.js";

const server = new ProjectRunnerServer(
  process.env.SUMMATE_RUNNER_SOCKET || "/run/summate-runner/runner.sock",
  process.env.SUMMATE_RUNNER_DATA || "/var/lib/summate-runner/jobs",
  process.env.SUMMATE_RUNNER_CONFIG || "/etc/summate-runner/projects",
  process.env.SUMMATE_RUNNER_DOCKER || "/usr/bin/docker",
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
