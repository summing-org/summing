import assert from "node:assert/strict";
import test from "node:test";
import { convertHeicToJpeg } from "../src/heic-converter.js";

test("HEIC conversion runs in its isolated worker and rejects invalid input", async () => {
  await assert.rejects(
    convertHeicToJpeg(new Uint8Array([1, 2, 3])),
    /not a HEIC image/,
  );
});
