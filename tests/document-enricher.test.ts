import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIDocumentEnricher } from "../src/document-enricher.js";

test("vision enrichment keeps OCR coordinates and caption in the canonical block", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-document-enricher-"));
  const path = join(root, "scan.png");
  writeFileSync(path, Buffer.from("fake-image"));
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      output: [{
        content: [{
          type: "output_text",
          text: JSON.stringify({
            pages: [{
              page: 1,
              caption: "Скан счёта",
              text: "Итого 1200 ₽",
              regions: [{ text: "1200 ₽", x: 0.6, y: 0.8, width: 0.2, height: 0.05 }],
            }],
          }),
        }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new OpenAIDocumentEnricher("test-key", "gpt-test").enrich(
      path,
      "scan.png",
      "image/png",
      [{
        blockKind: "image",
        ordinal: 0,
        text: "",
        locator: {},
        structure: { requiresOcr: true, requiresVision: true },
      }],
    );
    assert.match(JSON.stringify(requestBody), /input_image/);
    assert.equal(result[0]?.text, "Скан счёта\n\nИтого 1200 ₽");
    assert.equal(result[0]?.structure.requiresOcr, false);
    assert.deepEqual(result[0]?.structure.ocrRegions, [
      { text: "1200 ₽", x: 0.6, y: 0.8, width: 0.2, height: 0.05 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("audio enrichment stores the transcript as canonical text", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-audio-enricher-"));
  const path = join(root, "voice.ogg");
  writeFileSync(path, Buffer.from("fake-audio"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ text: "Обсудим релиз завтра." }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    const result = await new OpenAIDocumentEnricher("test-key", "gpt-test").enrich(
      path,
      "voice.ogg",
      "audio/ogg",
      [{
        blockKind: "audio",
        ordinal: 0,
        text: "",
        locator: {},
        structure: { requiresTranscription: true },
      }],
    );
    assert.equal(result[0]?.text, "Обсудим релиз завтра.");
    assert.equal(result[0]?.structure.requiresTranscription, false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
