import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { buildSearchChunks, extractDocument } from "../src/document-extractor.js";

test("ODS format is taken from the original name or MIME, not the spool path", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-ods-"));
  try {
    const path = join(root, "hash-pid-timestamp");
    const zip = new JSZip();
    const xml = '<office:document-content><office:body><office:spreadsheet><table:table table:name="Budget"><table:table-row><table:table-cell office:value-type="string"><text:p>Server</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>';
    zip.file("content.xml", xml);
    writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
    for (const [name, mime] of [["budget.ods", ""], ["opaque", "application/vnd.oasis.opendocument.spreadsheet"]]) {
      const blocks = await extractDocument(path, name!, mime!);
      assert.equal(blocks.length, 1);
      assert.match(blocks[0]!.text, /Server/);
      assert.equal(blocks[0]!.locator.sheet, "Budget");
    }
    zip.file("content.xml", xml.replace("<table:table-cell ", '<table:table-cell table:number-columns-repeated="999999999" '));
    writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
    await assert.rejects(extractDocument(path, "budget.ods"), /limit/);
    await assert.rejects(extractDocument(path, "legacy.xls"), /XLSX|ODS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("search chunks bound a single oversized block and preserve Unicode and provenance", () => {
  const block = { blockKind: "text", ordinal: 7, text: "x".repeat(60_001), locator: {}, structure: {} };
  const chunks = buildSearchChunks([block], 6_000);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 6_000));
  assert.equal(chunks.map((chunk) => chunk.text).join(""), block.text);
  assert.ok(chunks.every((chunk) => chunk.blockOrdinals.includes(7)));
  const unicode = buildSearchChunks([{ ...block, text: "😀".repeat(17) }], 3);
  assert.equal(unicode.map((chunk) => chunk.text).join(""), "😀".repeat(17));
  assert.ok(unicode.every((chunk) => chunk.text === "😀" && chunk.text.length <= 3));
  for (const limit of [0, 1, -1, NaN, Infinity, 1.5]) assert.throws(() => buildSearchChunks([block], limit));
});

test("spreadsheet extraction preserves formulas, cached values and sheet locators", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-xlsx-"));
  try {
    const path = join(root, "budget.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Budget");
    sheet.addRow(["Item", "Price", "Qty", "Total"]);
    sheet.addRow(["Server", 100, 2, { formula: "B2*C2", result: 200 }]);
    await workbook.xlsx.writeFile(path);

    const blocks = await extractDocument(path, "budget.xlsx");
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0]?.locator, { sheet: "Budget" });
    const cells = blocks[0]?.structure.cells as Array<Record<string, unknown>>;
    assert.deepEqual(
      cells.find((cell) => cell.address === "D2"),
      {
        address: "D2",
        value: 200,
        formula: "B2*C2",
        formatted: "200",
        type: 6,
        numberFormat: null,
      },
    );
    const chunks = buildSearchChunks(blocks);
    assert.equal(chunks.length, 1);
    assert.match(chunks[0]!.text, /Server/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("image extraction records an OCR and vision requirement without inventing text", async () => {
  const root = mkdtempSync(join(tmpdir(), "summing-image-block-"));
  try {
    const blocks = await extractDocument(join(root, "missing.png"), "scan.png", "image/png");
    assert.equal(blocks[0]?.text, "");
    assert.deepEqual(blocks[0]?.structure, { requiresOcr: true, requiresVision: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
