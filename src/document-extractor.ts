import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";

export interface ExtractedBlock {
  blockKind: string;
  ordinal: number;
  text: string;
  locator: Record<string, unknown>;
  structure: Record<string, unknown>;
}

export interface SearchChunkDraft {
  normalizedHash: string;
  text: string;
  blockOrdinals: number[];
  metadata: Record<string, unknown>;
}

const MAX_OFFICE_ARCHIVE_ENTRIES = 10_000;
const MAX_OFFICE_UNCOMPRESSED_BYTES = 500_000_000;

async function safeOfficeArchive(filePath: string): Promise<JSZip> {
  const archive = await JSZip.loadAsync(await readFile(filePath));
  const entries = Object.values(archive.files);
  if (entries.length > MAX_OFFICE_ARCHIVE_ENTRIES) {
    throw new Error(`office archive has too many entries: ${entries.length}`);
  }
  const uncompressed = entries.reduce((total, entry) => {
    const size = Number((entry as unknown as { _data?: { uncompressedSize?: number } })
      ._data?.uncompressedSize ?? 0);
    return total + Math.max(0, size);
  }, 0);
  if (uncompressed > MAX_OFFICE_UNCOMPRESSED_BYTES) {
    throw new Error(`office archive expands beyond ${MAX_OFFICE_UNCOMPRESSED_BYTES} bytes`);
  }
  return archive;
}

function xmlText(value: string): string {
  return value
    .replace(/<a:br\s*\/>|<w:br\s*\/>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function normalizedHash(text: string): string {
  return createHash("sha256")
    .update(text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase())
    .digest("hex");
}

function textBlocks(text: string, kind: string, locator: Record<string, unknown>): ExtractedBlock[] {
  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  return paragraphs.map((paragraph, index) => ({
    blockKind: kind,
    ordinal: index,
    text: paragraph,
    locator: { ...locator, paragraph: index + 1 },
    structure: {},
  }));
}

function inferredPdfTables(
  items: Array<{ text: string; x: number; y: number; width: number; height: number }>,
): Array<{ rows: Array<Array<{ text: string; x: number; y: number; width: number; height: number }>> }> {
  const rows: typeof items[] = [];
  for (const item of [...items].sort((left, right) => right.y - left.y || left.x - right.x)) {
    const row = rows.find((candidate) => Math.abs((candidate[0]?.y ?? item.y) - item.y) <= 2);
    if (row) row.push(item);
    else rows.push([item]);
  }
  const tabular = rows
    .map((row) => row.sort((left, right) => left.x - right.x))
    .filter((row) => row.length >= 2);
  return tabular.length >= 2 ? [{ rows: tabular }] : [];
}

async function pdfBlocks(filePath: string): Promise<ExtractedBlock[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(filePath));
  const document = await pdfjs.getDocument({ data }).promise;
  const blocks: ExtractedBlock[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items.flatMap((item) => {
      if (!("str" in item)) return [];
      const transform = item.transform;
      return [{
        text: String(item.str),
        x: Number(transform[4] ?? 0),
        y: Number(transform[5] ?? 0),
        width: Number(item.width ?? 0),
        height: Number(item.height ?? 0),
      }];
    });
    const text = items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
    blocks.push({
      blockKind: text ? "pdf-page" : "pdf-scan",
      ordinal: pageNumber - 1,
      text,
      locator: { page: pageNumber },
      structure: {
        items,
        tables: inferredPdfTables(items),
        requiresOcr: !text,
        requiresVision: !text,
      },
    });
  }
  return blocks;
}

async function docxBlocks(filePath: string): Promise<ExtractedBlock[]> {
  const archive = await safeOfficeArchive(filePath);
  const [raw, html] = await Promise.all([
    mammoth.extractRawText({ path: filePath }),
    mammoth.convertToHtml({ path: filePath }),
  ]);
  const blocks = textBlocks(raw.value, "docx-paragraph", {});
  const documentXml = await archive.file("word/document.xml")?.async("string") ?? "";
  const formulas = [...documentXml.matchAll(/<m:oMath(?:Para)?[\s\S]*?<\/m:oMath(?:Para)?>/g)]
    .map((match) => match[0]);
  if (formulas.length > 0 || /<w:tbl\b/.test(documentXml)) {
    blocks.push({
      blockKind: "docx-structure",
      ordinal: blocks.length,
      text: formulas.map(xmlText).filter(Boolean).join("\n"),
      locator: {},
      structure: {
        html: html.value,
        formulasOmml: formulas,
        images: Object.keys(archive.files).filter((name) => name.startsWith("word/media/")),
        tableCount: (documentXml.match(/<w:tbl\b/g) ?? []).length,
        conversionMessages: [...raw.messages, ...html.messages],
      },
    });
  }
  return blocks;
}

async function workbookBlocks(filePath: string, format: string): Promise<ExtractedBlock[]> {
  if (format === ".ods") return odsBlocks(filePath);
  if (format === ".xls") throw new Error("Legacy XLS is not supported; convert the document to XLSX or ODS");
  await safeOfficeArchive(filePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const blocks: ExtractedBlock[] = [];
  workbook.eachSheet((sheet, sheetIndex) => {
    const cells: Array<Record<string, unknown>> = [];
    const csvRows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const rowValues: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const formulaValue = cell.value && typeof cell.value === "object" && "formula" in cell.value
          ? cell.value
          : null;
        const value = formulaValue ? formulaValue.result ?? null : cell.value ?? null;
        cells.push({
          address: cell.address,
          value,
          formula: formulaValue?.formula ?? null,
          formatted: cell.text || null,
          type: cell.type,
          numberFormat: cell.numFmt || null,
        });
        rowValues[Number(cell.col) - 1] = cell.text;
      });
      csvRows.push(rowValues.map((value) => JSON.stringify(value ?? "")).join(","));
    });
    blocks.push({
      blockKind: "spreadsheet-sheet",
      ordinal: sheetIndex - 1,
      text: csvRows.join("\n"),
      locator: { sheet: sheet.name },
      structure: {
        range: sheet.dimensions ? `${sheet.dimensions.top}:${sheet.dimensions.bottom}` : "",
        cells,
        merges: sheet.model.merges ?? [],
      },
    });
  });
  if (!blocks.length) throw new Error("Spreadsheet contains no readable sheets");
  return blocks;
}

async function odsBlocks(filePath: string): Promise<ExtractedBlock[]> {
  const archive = await safeOfficeArchive(filePath);
  const xml = await archive.file("content.xml")?.async("string") ?? "";
  const tables = [...xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)];
  if (!tables.length) throw new Error("ODS contains no readable sheets");
  let cellCount = 0;
  return tables.map((table, tableIndex) => {
    const name = table[1]?.match(/table:name="([^"]+)"/)?.[1] ?? `Sheet ${tableIndex + 1}`;
    const cells: Array<Record<string, unknown>> = [];
    const rows: string[] = [];
    for (const [rowIndex, rowMatch] of [...(table[2] ?? "").matchAll(
      /<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g,
    )].entries()) {
      const rowText: string[] = [];
      let columnIndex = 0;
      for (const cellMatch of (rowMatch[1] ?? "").matchAll(
        /<table:table-cell\b([^>]*)>([\s\S]*?)<\/table:table-cell>/g,
      )) {
        const attributes = cellMatch[1] ?? "";
        const repeat = Math.max(1, Number(attributes.match(/table:number-columns-repeated="(\d+)"/)?.[1] ?? 1));
        if (!Number.isSafeInteger(repeat) || cellCount + repeat > 200_000) {
          throw new Error("ODS exceeds the 200000-cell extraction limit");
        }
        cellCount += repeat;
        const text = xmlText(cellMatch[2] ?? "");
        const formula = attributes.match(/table:formula="([^"]+)"/)?.[1] ?? null;
        const rawValue = attributes.match(/office:value="([^"]+)"/)?.[1]
          ?? attributes.match(/office:string-value="([^"]+)"/)?.[1]
          ?? null;
        for (let offset = 0; offset < repeat; offset += 1) {
          const address = `${String.fromCharCode(65 + Math.min(25, columnIndex))}${rowIndex + 1}`;
          cells.push({ address, value: rawValue, formula, formatted: text, type: "ods", numberFormat: null });
          rowText[columnIndex] = text;
          columnIndex += 1;
        }
      }
      rows.push(rowText.map((value) => JSON.stringify(value ?? "")).join(","));
    }
    return {
      blockKind: "spreadsheet-sheet",
      ordinal: tableIndex,
      text: rows.join("\n"),
      locator: { sheet: name },
      structure: { cells, sourceFormat: "ods" },
    };
  });
}

async function pptxBlocks(filePath: string): Promise<ExtractedBlock[]> {
  const archive = await safeOfficeArchive(filePath);
  const slideNames = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
  const blocks: ExtractedBlock[] = [];
  for (const [index, name] of slideNames.entries()) {
    const xml = await archive.file(name)!.async("string");
    const notesName = `ppt/notesSlides/notesSlide${index + 1}.xml`;
    const notesXml = await archive.file(notesName)?.async("string") ?? "";
    const formulas = [...xml.matchAll(/<m:oMath[\s\S]*?<\/m:oMath>/g)].map((item) => item[0]);
    blocks.push({
      blockKind: "presentation-slide",
      ordinal: index,
      text: xmlText(xml),
      locator: { slide: index + 1 },
      structure: {
        notes: xmlText(notesXml),
        formulasOmml: formulas,
        tableCount: (xml.match(/<a:tbl\b/g) ?? []).length,
        images: Object.keys(archive.files).filter((entry) => entry.startsWith("ppt/media/")),
      },
    });
  }
  return blocks;
}

export async function extractDocument(
  filePath: string,
  fileName: string,
  mimeType = "",
): Promise<ExtractedBlock[]> {
  const extension = extname(fileName).toLowerCase();
  if (mimeType === "application/pdf" || extension === ".pdf") return pdfBlocks(filePath);
  if (extension === ".docx" || mimeType.includes("wordprocessingml")) return docxBlocks(filePath);
  if ([".xlsx", ".xls", ".ods"].includes(extension) || mimeType.includes("spreadsheet")) {
    return workbookBlocks(filePath, extension === ".ods" || mimeType.includes("opendocument.spreadsheet") ? ".ods" : extension);
  }
  if (extension === ".pptx" || mimeType.includes("presentationml")) return pptxBlocks(filePath);
  if (mimeType.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".heic"].includes(extension)) {
    return [{
      blockKind: "image",
      ordinal: 0,
      text: "",
      locator: {},
      structure: { requiresOcr: true, requiresVision: true },
    }];
  }
  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
    return [{
      blockKind: mimeType.startsWith("audio/") ? "audio" : "video",
      ordinal: 0,
      text: "",
      locator: {},
      structure: { requiresTranscription: true },
    }];
  }
  const value = await readFile(filePath, "utf8");
  return textBlocks(value, "text-paragraph", {});
}

export function buildSearchChunks(
  blocks: ExtractedBlock[],
  maximumCharacters = 6_000,
): SearchChunkDraft[] {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 2) {
    throw new Error("maximumCharacters must be an integer of at least 2");
  }
  const chunks: SearchChunkDraft[] = [];
  let text = "";
  let ordinals: number[] = [];
  const flush = (): void => {
    const content = text.trim();
    if (!content) return;
    chunks.push({
      normalizedHash: normalizedHash(content),
      text: content,
      blockOrdinals: ordinals,
      metadata: { firstBlock: ordinals[0] ?? null, lastBlock: ordinals.at(-1) ?? null },
    });
    text = "";
    ordinals = [];
  };
  for (const block of blocks) {
    let remaining = block.text.trim();
    while (remaining) {
      if (text && text.length + 2 + remaining.length > maximumCharacters) flush();
      let end = Math.min(remaining.length, maximumCharacters);
      // Preserve astral Unicode characters at chunk boundaries.
      if (end < remaining.length && /[\uD800-\uDBFF]/u.test(remaining[end - 1]!)) end--;
      text += `${text ? "\n\n" : ""}${remaining.slice(0, end)}`;
      ordinals.push(block.ordinal);
      remaining = remaining.slice(end);
      if (remaining) flush();
    }
  }
  flush();
  return chunks;
}
