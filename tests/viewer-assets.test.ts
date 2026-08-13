import assert from "node:assert/strict";
import test from "node:test";
import { VIEWER_HTML, VIEWER_JS } from "../src/viewer-assets.js";

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
});
