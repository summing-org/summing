import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RunnerPortalMessageError,
  RunnerPortalMessageStore,
} from "../src/runner-portal-messages.js";

test("captures a bounded generic batch of runner portal messages", () => {
  const root = mkdtempSync(join(tmpdir(), "summing-runner-portal-messages-"));
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts);
  writeFileSync(join(artifacts, "report.html"), "<html>report</html>");
  writeFileSync(join(artifacts, "video-01.mp4"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(artifacts, "portal-messages.json"), JSON.stringify({
    schemaVersion: 1,
    messages: [
      { id: "status", type: "text", text: "Dry-run completed." },
      {
        id: "report",
        type: "document",
        text: "Информационный dry-run готов.",
        artifact: "report.html",
        portalKey: "reports",
      },
      {
        id: "native-video",
        type: "video",
        text: "Live-run video is ready.",
        artifact: "video-01.mp4",
      },
    ],
  }));
  const store = new RunnerPortalMessageStore(
    root,
    () => new Date("2026-08-20T08:00:00.000Z"),
  );
  try {
    const captured = store.capture({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "768d307d-1234-4567-89ab-123456789012",
      artifactDirectory: artifacts,
      allowedArtifacts: new Map([
        ["report.html", "text/html"],
        ["video-01.mp4", "video/mp4"],
      ]),
    });
    assert.deepEqual(captured?.messages, [
      { id: "status", type: "text", text: "Dry-run completed.", artifact: null },
      {
        id: "report",
        type: "document",
        text: "Информационный dry-run готов.",
        artifact: "report.html",
        portalKey: "reports",
      },
      {
        id: "native-video",
        type: "video",
        text: "Live-run video is ready.",
        artifact: "video-01.mp4",
      },
    ]);
    assert.deepEqual(store.capture({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "768d307d-1234-4567-89ab-123456789012",
      artifactDirectory: artifacts,
      allowedArtifacts: new Map([
        ["report.html", "text/html"],
        ["video-01.mp4", "video/mp4"],
      ]),
    }), captured);
    writeFileSync(join(artifacts, "portal-messages.json"), JSON.stringify({
      schemaVersion: 1,
      messages: [{ id: "unsafe", type: "document", artifact: "secrets.env" }],
    }));
    assert.throws(() => store.capture({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "868d307d-1234-4567-89ab-123456789012",
      artifactDirectory: artifacts,
      allowedArtifacts: new Map([["report.html", "text/html"]]),
    }), RunnerPortalMessageError);

    writeFileSync(join(artifacts, "portal-messages.json"), JSON.stringify({
      schemaVersion: 1,
      messages: [{ id: "wrong-type", type: "document", artifact: "video-01.mp4" }],
    }));
    assert.throws(() => store.capture({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "968d307d-1234-4567-89ab-123456789012",
      artifactDirectory: artifacts,
      allowedArtifacts: new Map([["video-01.mp4", "video/mp4"]]),
    }), /must use the video message type/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
