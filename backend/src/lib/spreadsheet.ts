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

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  const value = typeof cell.w === "string" && cell.w.length > 0 ? cell.w
    : cell.v == null ? "" : String(cell.v);
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

interface RenderedSheet {
  text: string;
  tableCells: SpreadsheetCellSpan[];
}

function renderSheet(
  { utils }: XlsxModule,
  table: number,
  sheetName: string,
  ws: XLSX.WorkSheet,
  includeCells: boolean,
): RenderedSheet | null {
  const mergeAnchors = new Map<
    string,
    {
      range: string;
      startRow: number;
      endRow: number;
      startColumn: number;
      endColumn: number;
      columnSpan: number;
      rowSpan: number;
    }
  >();
  for (const merge of ws["!merges"] ?? []) {
    mergeAnchors.set(utils.encode_cell(merge.s), {
      range: utils.encode_range(merge),
      startRow: merge.s.r,
      endRow: merge.e.r,
      startColumn: merge.s.c,
      endColumn: merge.e.c,
      columnSpan: merge.e.c - merge.s.c + 1,
      rowSpan: merge.e.r - merge.s.r + 1,
    });
  }

  // Track only columns with visible anchor content. Formatting-only used
  // ranges and empty columns must not inflate the model projection.
  const rowsByNumber = new Map<number, {
    rowNumber: number;
    cells: Map<number, { address: string; text: string; value: string }>;
  }>();
  const occupiedColumns = new Set<number>();
  const addresses = new Set([
    ...Object.keys(ws).filter((key) => !key.startsWith("!")),
    ...mergeAnchors.keys(),
  ]);
  for (const address of addresses) {
    const { r: row, c: column } = utils.decode_cell(address);
    let isCovered = false;
    for (const [anchor, merge] of mergeAnchors) {
      if (anchor !== address &&
          row >= merge.startRow && row <= merge.endRow &&
          column >= merge.startColumn && column <= merge.endColumn) {
        isCovered = true;
        break;
      }
    }
    if (isCovered) continue;
    const value = cellText(ws[address]);
    const merge = mergeAnchors.get(address);
    const text = merge
      ? value
        ? `${value} ⟨merged ${merge.range}⟩`
        : `⟨merged ${merge.range}⟩`
      : value;
    if (!text) continue;
    const rowEntry = rowsByNumber.get(row) ?? {
      rowNumber: row + 1,
      cells: new Map<number, { address: string; text: string; value: string }>(),
    };
    rowEntry.cells.set(column, { address, text, value });
    rowsByNumber.set(row, rowEntry);
    occupiedColumns.add(column);
  }
  const rows = [...rowsByNumber.values()].sort(
    (left, right) => left.rowNumber - right.rowNumber,
  );
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

  for (const { rowNumber, cells } of rows) {
    let line = `| ${rowNumber} | `;
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
            row: rowNumber,
            column: column + 1,
            address: cell.address,
            displayValue: cell.value,
            ...(merge?.columnSpan && merge.columnSpan > 1
              ? { columnSpan: merge.columnSpan }
              : {}),
            ...(merge?.rowSpan && merge.rowSpan > 1
              ? { rowSpan: merge.rowSpan }
              : {}),
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

async function spreadsheetProjection(
  buffer: Buffer,
  fileType: string,
  includeCells: boolean,
): Promise<SpreadsheetLlmStructure> {
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
  const workbook = xlsx.read(buffer, { type: "buffer" });
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
  const sheets: RenderedSheet[] = [];
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const rendered = renderSheet(
      xlsx, sheets.length + 1, sheetName, worksheet, includeCells);
    if (rendered) sheets.push(rendered);
  }

  let text = "";
  const tableCells: SpreadsheetCellSpan[] = [];
  for (const sheet of sheets) {
    const separator = text ? "\n\n" : "";
    const shift = text.length + separator.length;
    text += separator + sheet.text;
    tableCells.push(
      ...sheet.tableCells.map((cell) => ({
        ...cell,
        start: cell.start + shift,
        end: cell.end + shift,
      })),
    );
  }
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES)
    throw new Error("Spreadsheet projection output exceeds the read limit");
  return { text: text.trim(), tableCells };
}

export const spreadsheetToLLMStructure = (buffer: Buffer, fileType = "xlsx") =>
  spreadsheetProjection(buffer, fileType, true);

export const spreadsheetToLLMText = async (buffer: Buffer, fileType = "xlsx") =>
  (await spreadsheetProjection(buffer, fileType, false)).text;
