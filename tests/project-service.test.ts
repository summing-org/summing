import assert from "node:assert/strict";
import test from "node:test";
import { serviceDefinition, serviceDefinitions } from "../src/project-service.js";

test("service manifest defines bounded named long-running workloads", () => {
  const manifest = JSON.stringify({
    version: 1,
    services: {
      api: {
        command: ["node", "dist/src/api.js"],
        containerPort: 3_000,
        healthPath: "/health",
        startupTimeoutSeconds: 45,
      },
      worker: {},
    },
  });
  assert.deepEqual(serviceDefinition(manifest, "api"), {
    command: ["node", "dist/src/api.js"],
    containerPort: 3_000,
    healthPath: "/health",
    startupTimeoutSeconds: 45,
  });
  assert.deepEqual(serviceDefinition(manifest, "worker"), {
    command: [],
    containerPort: null,
    healthPath: null,
    startupTimeoutSeconds: 60,
  });
  assert.deepEqual([...serviceDefinitions(manifest).keys()], ["api", "worker"]);
  assert.throws(() => serviceDefinition(manifest, "missing"), /is not declared/);
  assert.throws(
    () => serviceDefinition(JSON.stringify({
      version: 1,
      services: { api: { healthPath: "/health" } },
    }), "api"),
    /requires a containerPort/,
  );
  assert.throws(
    () => serviceDefinition(JSON.stringify({
      version: 1,
      services: { api: { containerPort: 3_000, privileged: true } },
    }), "api"),
    /unsupported fields/,
  );
  assert.throws(
    () => serviceDefinitions(JSON.stringify({
      version: 1,
      services: {
        api: {},
        worker: { command: [] },
      },
    })),
    /service worker command must contain/,
  );
});
