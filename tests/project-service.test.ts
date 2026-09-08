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

test("worker heartbeat uses only a bounded relative data path and explicit time limit", () => {
  const definition = (fields: Record<string, unknown>) => serviceDefinition(JSON.stringify({ version: 1, services: { worker: fields } }), "worker");
  assert.equal(definition({ heartbeatPath: "health/heartbeat" }).heartbeatTimeoutSeconds, 180);
  assert.equal(definition({ heartbeatPath: "heartbeat", heartbeatTimeoutSeconds: 30 }).heartbeatTimeoutSeconds, 30);
  for (const path of ["/etc/passwd", "../heartbeat", "health/../heartbeat", ".", "health//heartbeat"]) {
    assert.throws(() => definition({ heartbeatPath: path }), /safe relative path/);
  }
  assert.throws(() => definition({ heartbeatTimeoutSeconds: 30 }), /requires heartbeatPath/);
  assert.throws(() => definition({ heartbeatPath: "heartbeat", heartbeatTimeoutSeconds: 1 }), /10 to 3600/);
});
