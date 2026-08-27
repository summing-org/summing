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
  const native = [
    { id: "native-photo", type: "photo", artifact: "photo-01.jpg", contentType: "image/jpeg" },
    { id: "native-audio", type: "audio", artifact: "audio-01.mp3", contentType: "audio/mpeg" },
    { id: "native-video", type: "video", artifact: "video-01.mp4", contentType: "video/mp4" },
    { id: "native-animation", type: "animation", artifact: "animation-01.gif", contentType: "image/gif" },
    { id: "native-voice", type: "voice", artifact: "voice-01.ogg", contentType: "audio/ogg" },
  ] as const;
  for (const item of native) writeFileSync(join(artifacts, item.artifact), Buffer.from([0, 1, 2, 3]));
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
      ...native.map((item) => ({
        id: item.id,
        type: item.type,
        text: `${item.type} ready`,
        artifact: item.artifact,
      })),
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
        ...native.map((item) => [item.artifact, item.contentType] as const),
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
      ...native.map((item) => ({
        id: item.id,
        type: item.type,
        text: `${item.type} ready`,
        artifact: item.artifact,
      })),
    ]);
    assert.deepEqual(store.capture({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "768d307d-1234-4567-89ab-123456789012",
      artifactDirectory: artifacts,
      allowedArtifacts: new Map([
        ["report.html", "text/html"],
        ...native.map((item) => [item.artifact, item.contentType] as const),
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
      messages: [{ id: "wrong-type", type: "photo", artifact: "video-01.mp4" }],
    }));
    assert.throws(() => store.capture({
      projectId: "ash-telegrams",
      workspaceId: "repo",
      jobId: "968d307d-1234-4567-89ab-123456789012",
      artifactDirectory: artifacts,
      allowedArtifacts: new Map([["video-01.mp4", "video/mp4"]]),
    }), /portal photo artifact MIME type is not supported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
