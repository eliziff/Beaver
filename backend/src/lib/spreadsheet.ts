import type * as XLSX from "xlsx";
import type { TableCellSpan } from "./legalTextSkeleton";

/**
 * A native spreadsheet cell projected onto the compact model-facing text.
 * The typed grid is authoritative; Markdown is only one cheap serialization.
 */
export interface SpreadsheetCellSpan extends TableCellSpan {
  tableName: string;
  address: string;
  displayValue: string;
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
function loadXlsx(): Promise<XlsxModule> {
  return (xlsxModule ??= import("xlsx"));
}

function cellDisplayText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  if (typeof cell.w === "string" && cell.w.length > 0) return cell.w;
  if (cell.v == null) return "";
  return String(cell.v);
}

function sanitizeCellText(value: string): string {
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
    const isCovered = [...mergeAnchors.entries()].some(
      ([anchor, merge]) =>
        anchor !== address &&
        row >= merge.startRow &&
        row <= merge.endRow &&
        column >= merge.startColumn &&
        column <= merge.endColumn,
    );
    if (isCovered) continue;
    const value = sanitizeCellText(cellDisplayText(ws[address]));
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
        const start = cursor + line.length;
        line += cell.text;
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
      line += index === columns.length - 1 ? " |" : " | ";
    }
    lines.push(line);
    cursor += line.length + 1;
  }
  return { text: lines.join("\n"), tableCells };
}

export async function spreadsheetToLLMStructure(
  buffer: Buffer,
): Promise<SpreadsheetLlmStructure> {
  const xlsx = await loadXlsx();
  const workbook = xlsx.read(buffer, { type: "buffer" });
  const sheets: RenderedSheet[] = [];
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const rendered = renderSheet(xlsx, sheets.length + 1, sheetName, worksheet);
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
  return { text: text.trim(), tableCells };
}

export async function spreadsheetToLLMText(buffer: Buffer): Promise<string> {
  return (await spreadsheetToLLMStructure(buffer)).text;
}
