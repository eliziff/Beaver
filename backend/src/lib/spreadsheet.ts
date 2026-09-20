import { z } from "zod/v4";
import type * as XLSX from "xlsx";
import { assertBoundedZip, loadZip } from "./zip";

/**
 * A native spreadsheet cell projected onto the compact model-facing text.
 * The typed grid is authoritative; Markdown is only one cheap serialization.
 */
export interface SpreadsheetCellSpan {
  table: number;
  tableName: string;
  row: number;
  column: number;
  address: string;
  displayValue: string;
  type?: XLSX.ExcelDataType;
  value?: XLSX.CellObject["v"];
  formula?: string;
  numberFormat?: XLSX.CellObject["z"];
  start: number;
  end: number;
  columnSpan?: number;
  rowSpan?: number;
}

export interface SpreadsheetLlmStructure {
  text: string;
  tableCells: SpreadsheetCellSpan[];
}

// SheetJS is ~1 MB of parser loaded from a pinned CDN tarball; keep it out of
// the boot graph and off every request that never touches a spreadsheet.
type XlsxModule = typeof import("xlsx");
let xlsxModule: Promise<XlsxModule> | null = null;
const MAX_SHEETS = 256, MAX_CELLS = 500_000, MAX_MERGE_CHECKS = 10_000_000;
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_ENTRIES = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const scalar = z.union([z.string().max(32_767), z.number().finite(), z.boolean(), z.null()]);
const nativeCell = z.object({ t: z.enum(["s", "n", "b"]), v: scalar.optional(),
  f: z.string().min(1).max(8_192).optional(), z: z.string().max(256).optional() }).strict()
  .refine(cell => cell.v !== undefined || !!cell.f, "A cell needs a value or formula")
  .refine(cell => !cell.f?.startsWith("="), "SheetJS formulas omit the leading equals sign")
  .refine(cell => cell.v == null || typeof cell.v === ({ n: "number", s: "string", b: "boolean" }[cell.t]),
    "Cell type and value disagree");
export const workbookSheetsSchema = z.array(z.object({
  name: z.string().min(1).max(100), columns: z.array(z.string().max(32_767)).max(16_384).optional(),
  rows: z.array(z.array(z.union([scalar, nativeCell])).max(16_384)).max(100_000),
})).min(1).max(256).refine(sheets => sheets.reduce((n, sheet) =>
  n + (sheet.columns?.length ?? 0) + sheet.rows.reduce((n, row) => n + row.length, 0), 0) <= 500_000,
  "Workbook exceeds the cell limit");

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  const display = typeof cell.w === "string" && cell.w.length ? cell.w : cell.v == null ? "" : String(cell.v);
  const value = cell.f ? `=${cell.f} ⟨${cell.t}; cached:${JSON.stringify(cell.v ?? null)}⟩`
    : display && cell.t !== "s" ? `${display} ⟨${cell.t}:${JSON.stringify(cell.v)}⟩`
    : display.startsWith("=") ? `${display} ⟨s⟩` : display;
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function renderSheet({ utils }: XlsxModule, table: number, sheetName: string,
  ws: XLSX.WorkSheet, includeCells: boolean): SpreadsheetLlmStructure | null {
  const mergeAnchors = new Map<string, XLSX.Range>();
  for (const merge of ws["!merges"] ?? []) {
    mergeAnchors.set(utils.encode_cell(merge.s), merge);
  }

  // Track only columns with visible anchor content. Formatting-only used
  // ranges and empty columns must not inflate the model projection.
  const rowsByNumber = new Map<number,
    Map<number, { address: string; text: string; value: string }>>();
  const occupiedColumns = new Set<number>();
  const addresses = new Set([
    ...Object.keys(ws).filter((key) => !key.startsWith("!")),
    ...mergeAnchors.keys(),
  ]);
  for (const address of addresses) {
    const { r: row, c: column } = utils.decode_cell(address);
    const covered = [...mergeAnchors].some(([anchor, merge]) => anchor !== address &&
      row >= merge.s.r && row <= merge.e.r && column >= merge.s.c && column <= merge.e.c);
    if (covered) continue;
    const original = ws[address];
    // SheetJS represents an uncached numeric formula as a stub with a synthetic zero.
    if (original?.f && original.t === "z") { original.t = "n"; delete original.v; delete original.w; }
    const value = cellText(original);
    const merge = mergeAnchors.get(address);
    const text = merge
      ? `${value ? `${value} ` : ""}⟨merged ${utils.encode_range(merge)}⟩` : value;
    if (!text) continue;
    const cells = rowsByNumber.get(row) ??
      new Map<number, { address: string; text: string; value: string }>();
    cells.set(column, { address, text, value });
    rowsByNumber.set(row, cells);
    occupiedColumns.add(column);
  }
  const rows = [...rowsByNumber].sort(([left], [right]) => left - right);
  if (!rows.length || !occupiedColumns.size) return null;

  const columns = [...occupiedColumns].sort((a, b) => a - b);
  const colLetters = columns.map((column) => utils.encode_col(column));
  const lines = [
    `## Sheet: ${sheetName}`,
    "",
    `| Row | ${colLetters.join(" | ")} |`,
    `| --- | ${columns.map(() => "---").join(" | ")} |`,
  ];
  const tableCells: SpreadsheetCellSpan[] = [];
  let cursor = lines.join("\n").length + 1;

  for (const [row, cells] of rows) {
    let line = `| ${row + 1} | `;
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const cell = cells.get(column);
      if (cell) {
        const start = includeCells ? cursor + line.length : 0;
        line += cell.text;
        if (includeCells) {
          const merge = mergeAnchors.get(cell.address);
          tableCells.push({
            table,
            tableName: sheetName,
            row: row + 1,
            column: column + 1,
            address: cell.address,
            displayValue: cell.value,
            type: ws[cell.address]?.t, value: ws[cell.address]?.v,
            formula: ws[cell.address]?.f, numberFormat: ws[cell.address]?.z,
            ...(merge && merge.e.c > merge.s.c ? { columnSpan: merge.e.c - merge.s.c + 1 } : {}),
            ...(merge && merge.e.r > merge.s.r ? { rowSpan: merge.e.r - merge.s.r + 1 } : {}),
            start,
            end: cursor + line.length,
          });
        }
      }
      line += index === columns.length - 1 ? " |" : " | ";
    }
    lines.push(line);
    cursor += line.length + 1;
  }
  return { text: lines.join("\n"), tableCells };
}

async function spreadsheetProjection(buffer: Buffer, fileType: string,
  includeCells: boolean): Promise<SpreadsheetLlmStructure> {
  fileType = fileType.trim().toLowerCase();
  if (!buffer.length || buffer.length > MAX_INPUT_BYTES)
    throw new Error("Spreadsheet input exceeds the read limit");
  if (["xlsx", "xlsm"].includes(fileType)) {
    if (buffer.length > MAX_COMPRESSED_BYTES)
      throw new Error("Compressed document exceeds the read limit");
    assertBoundedZip(await loadZip(buffer), "Spreadsheet", {
      maxEntries: MAX_PACKAGE_ENTRIES, maxExpandedBytes: MAX_EXPANDED_BYTES,
    });
  }
  const xlsx = await (xlsxModule ??= import("xlsx"));
  const workbook = xlsx.read(buffer, { type: "buffer", cellFormula: true, cellNF: true, sheetStubs: true });
  if (workbook.SheetNames.length > MAX_SHEETS)
    throw new Error("Spreadsheet contains too many sheets");
  let cells = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const populated = Object.keys(sheet).filter((key) => !key.startsWith("!")).length;
    const merges = sheet["!merges"]?.length ?? 0;
    cells += populated + merges;
    if (cells > MAX_CELLS || (populated + merges) * merges > MAX_MERGE_CHECKS)
      throw new Error("Spreadsheet is too complex to render safely");
  }
  let text = "", table = 0;
  const tableCells: SpreadsheetCellSpan[] = [];
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const sheet = renderSheet(xlsx, table + 1, sheetName, worksheet, includeCells);
    if (!sheet) continue;
    table += 1;
    const separator = text ? "\n\n" : "";
    const shift = text.length + separator.length;
    text += separator + sheet.text;
    tableCells.push(...sheet.tableCells.map((cell) =>
      ({ ...cell, start: cell.start + shift, end: cell.end + shift })));
  }
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES)
    throw new Error("Spreadsheet projection output exceeds the read limit");
  return { text: text.trim(), tableCells };
}

export const spreadsheetToLLMStructure = (buffer: Buffer, fileType = "xlsx") =>
  spreadsheetProjection(buffer, fileType, true);

export const spreadsheetToLLMText = async (buffer: Buffer, fileType = "xlsx") =>
  (await spreadsheetProjection(buffer, fileType, false)).text;
