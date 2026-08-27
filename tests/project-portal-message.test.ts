import assert from "node:assert/strict";
import test from "node:test";
import {
  isProjectPortalAttachmentKind,
  isProjectPortalMessageKind,
  PROJECT_PORTAL_MESSAGE_KINDS,
  projectPortalMaximumArtifactBytes,
  projectPortalMimeTypeAllowed,
} from "../src/project-portal-message.js";

test("Project portal media kinds share exhaustive MIME and size invariants", () => {
  assert.deepEqual(PROJECT_PORTAL_MESSAGE_KINDS, [
    "text",
    "document",
    "photo",
    "audio",
    "video",
    "animation",
    "voice",
  ]);
  assert.equal(isProjectPortalMessageKind("photo"), true);
  assert.equal(isProjectPortalMessageKind("sticker"), false);
  assert.equal(isProjectPortalAttachmentKind("text"), false);
  assert.equal(isProjectPortalAttachmentKind("animation"), true);

  assert.equal(projectPortalMimeTypeAllowed("document", "application/pdf"), true);
  assert.equal(projectPortalMimeTypeAllowed("photo", "image/jpeg"), true);
  assert.equal(projectPortalMimeTypeAllowed("photo", "video/mp4"), false);
  assert.equal(projectPortalMimeTypeAllowed("audio", "audio/mpeg"), true);
  assert.equal(projectPortalMimeTypeAllowed("video", "video/mp4"), true);
  assert.equal(projectPortalMimeTypeAllowed("animation", "image/gif"), true);
  assert.equal(projectPortalMimeTypeAllowed("voice", "audio/ogg"), true);

  assert.equal(projectPortalMaximumArtifactBytes("document"), 8_000_000);
  assert.equal(projectPortalMaximumArtifactBytes("photo"), 10_000_000);
  assert.equal(projectPortalMaximumArtifactBytes("video"), 20_000_000);
});
