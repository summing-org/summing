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
  assert.doesNotMatch(VIEWER_HTML, /data-tab="settings"/);
  assert.match(VIEWER_HTML, /data-tab="environment"/);
  assert.match(VIEWER_HTML, /Энвы репозитория/);
  assert.match(VIEWER_HTML, /id="environmentText"/);
  assert.doesNotMatch(VIEWER_HTML, /Обновиться сейчас/);
  assert.doesNotMatch(VIEWER_JS, /\/api\/viewer\/deployment/);
  assert.match(VIEWER_HTML, /id="artifactPanel"/);
  assert.match(VIEWER_HTML, /data-tab="runs">Правки агента</);
  assert.match(VIEWER_HTML, /data-tab="launch">Раннер</);
  assert.match(VIEWER_HTML, /ДИАГНОСТИКА/);
  assert.match(VIEWER_HTML, /Очередь раннера/);
  assert.match(VIEWER_HTML, /Запусками и расписаниями управляет агент/);
  assert.doesNotMatch(VIEWER_HTML, /data-action=/);
  assert.doesNotMatch(VIEWER_JS, /function enqueue/);
  assert.match(VIEWER_HTML, /id="cancelJob"[^>]*>Остановить</);
  assert.match(VIEWER_HTML, /id="artifactReport"[^>]+sandbox/);
  assert.match(VIEWER_HTML, /href="\/logo\.svg"/);
  assert.match(VIEWER_LOGO_SVG, /fill="#FF3366"/);
  assert.match(VIEWER_CSS, /--accent:#ff2e6b/);
  assert.match(VIEWER_CSS, /--primary:#7c9bb7/);
  assert.match(VIEWER_CSS, /data-theme="light"/);
  assert.match(VIEWER_JS, /\/api\/viewer\/job-artifacts/);
  assert.match(VIEWER_JS, /\/api\/viewer\/jobs\/cancel/);
  assert.match(VIEWER_JS, /cancelling:"останавливается"/);
  assert.match(VIEWER_JS, /data-download/);
  assert.match(VIEWER_JS, /renderEditorialPlan/);
  assert.match(VIEWER_JS, /\/api\/viewer\/environment/);
  assert.match(VIEWER_JS, /expectedRevision/);
  assert.match(VIEWER_JS, /state\.session\.environmentAccess/);
  assert.match(VIEWER_JS, /activeTab\.offsetLeft/);
});
