import assert from "node:assert/strict";
import test from "node:test";
import {
  VIEWER_CSS,
  VIEWER_HTML,
  VIEWER_JS,
  VIEWER_LOGO_SVG,
} from "../src/viewer-assets.js";

test("Project Viewer bounds Telegram authorization and network waits", () => {
  assert.doesNotThrow(() => new Function(VIEWER_JS));
  assert.match(VIEWER_HTML, /telegram-web-app\.js\?63/);
  assert.match(VIEWER_JS, /REQUEST_TIMEOUT_MS=15000/);
  assert.match(VIEWER_JS, /new AbortController\(\)/);
  assert.match(VIEWER_JS, /Telegram не передал данные авторизации/);
  assert.match(VIEWER_JS, /Повторить/);
  assert.match(VIEWER_HTML, /data-tab="settings"/);
  assert.match(VIEWER_HTML, /Обновиться сейчас/);
  assert.match(VIEWER_JS, /\/api\/viewer\/deployment/);
  assert.match(VIEWER_JS, /state\.session\.administrator&&state\.session\.deploymentAvailable/);
  assert.match(VIEWER_HTML, /id="artifactPanel"/);
  assert.match(VIEWER_HTML, /id="artifactReport"[^>]+sandbox/);
  assert.match(VIEWER_HTML, /href="\/logo\.svg"/);
  assert.match(VIEWER_LOGO_SVG, /fill="#FF3366"/);
  assert.match(VIEWER_CSS, /--accent:#ff2e6b/);
  assert.match(VIEWER_CSS, /--primary:#7c9bb7/);
  assert.match(VIEWER_CSS, /data-theme="light"/);
  assert.match(VIEWER_JS, /\/api\/viewer\/job-artifacts/);
  assert.match(VIEWER_JS, /data-download/);
  assert.match(VIEWER_JS, /renderEditorialPlan/);
});
