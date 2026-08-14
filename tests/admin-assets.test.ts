import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from "../src/admin-assets.js";

test("administrator Mini App exposes project creation and topic binding UI", () => {
  assert.doesNotThrow(() => new Function(ADMIN_JS));
  assert.match(ADMIN_HTML, /telegram-web-app\.js\?63/);
  assert.match(ADMIN_HTML, /id="createForm"/);
  assert.match(ADMIN_HTML, /id="topicSearch"/);
  assert.match(ADMIN_HTML, /Привязки топиков/);
  assert.match(ADMIN_JS, /\/api\/viewer\/admin\/projects/);
  assert.match(ADMIN_JS, /\/api\/viewer\/admin\/bindings/);
  assert.match(ADMIN_JS, /Перепривязать топик/);
  assert.match(ADMIN_CSS, /@media\(max-width:520px\)/);
  assert.match(ADMIN_CSS, /--accent:#ff2e6b/);
});
