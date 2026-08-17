import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildSearchChunks, extractDocument } from "../src/document-extractor.js";

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
