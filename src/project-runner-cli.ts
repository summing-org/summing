import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { GitInspector } from "./git-inspector.js";
import {
  ProjectRunnerClient,
  type RunnerSchedulableAction,
} from "./project-runner-client.js";

interface ScheduleConfig {
  projectId: string;
  workspaceId?: string;
  action: RunnerSchedulableAction;
  repository: string;
  revision: string;
  runnerSocket?: string;
}

const ACTIONS = new Set<RunnerSchedulableAction>(["build", "validate", "dry-run", "run"]);

async function main(): Promise<void> {
  const path = process.argv[2] ?? "";
  if (!path || !isAbsolute(path)) {
    throw new Error("usage: project-runner-cli <absolute-schedule-config.json>");
  }
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as Partial<ScheduleConfig>;
  const projectId = String(value.projectId ?? "");
  const workspaceId = String(value.workspaceId ?? "repo");
  const action = String(value.action ?? "") as RunnerSchedulableAction;
  const repository = String(value.repository ?? "");
  const revision = String(value.revision ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(projectId)) throw new Error("invalid projectId");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(workspaceId)) throw new Error("invalid workspaceId");
  if (!ACTIONS.has(action)) {
    throw new Error("invalid action");
  }
  if (!isAbsolute(repository)) throw new Error("repository must be absolute");
  const inspector = new GitInspector(repository);
  const resolved = await inspector.resolveRevision(revision);
  const archive = await inspector.archive(resolved);
  const client = new ProjectRunnerClient(
    String(
      value.runnerSocket || process.env.SUMMING_RUNNER_SOCKET ||
        "/run/summing-project-runner/runner.sock",
    ),
  );
  const job = await client.submit(projectId, workspaceId, action, resolved, archive);
  process.stdout.write(`${job.id}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
