import JSZip from "jszip";
import type { checkQuotes } from "./quoteCheck";
import type { AuthoritiesDraft } from "./authoritiesDomain";
import type { DocumentScope, DocumentStore } from "./documentStore";
import { escapeXmlText } from "./text";
import { reject } from "./applicationError";
import { renderXlsxWorkbook } from "./chat/tools/documentOps";

type Result = Awaited<ReturnType<typeof checkQuotes>>;
export type QuoteAnalysis = Record<string, string>;
const json = (value: unknown) => JSON.stringify(value ?? null);
const isIncompleteCheck = (result: Result) => result.quotes.length < result.total || result.mode.includes("incomplete");
/** A run of differently formatted text in one cell; `font` is the run's rPr content. */
export type XlsxRun = { text: string; font: string };
export type XlsxCell = { value: string | number; style?: number; link?: string; runs?: XlsxRun[] };
export type XlsxSheet = {
  name: string;
  /** The header row first. */
  rows: XlsxCell[][];
  widths: number[];
  /** Columns from this (1-based) one on are hidden. */
  hiddenFrom?: number | null;
  /** Hide the empty grid right of the last column. */
  hideUnused?: boolean;
  frozenHeader?: boolean;
  /** Extra sheetView attributes, e.g. ` showGridLines="0" zoomScale="85"`. */
  view?: string;
  heights?: Array<number | null>;
  autoFilter?: boolean;
  hidden?: boolean;
};
/** Fonts and cell formats as SpreadsheetML; fills as RGB colours (fill ids from 2 in this order). */
export type XlsxStyles = { fonts: string[]; fills: string[]; cellXfs: string[] };

// What XML cannot hold is left out (control characters, U+FFFE, U+FFFF, half a surrogate pair): one makes the
// whole workbook unreadable.
const xmlChars = (value: string) => value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF\uD800-\uDFFF]/gu, "");
const cellText = (value: string) => `<t${/^\s|\s$/u.test(value) ? ' xml:space="preserve"' : ""}>${
  escapeXmlText(xmlChars(value))}</t>`;
// Excel opens no workbook with a cell over 32,767 characters: a longer value is cut there, and says so.
const CELL_LIMIT = 32_767, CUT = " […] (cut here: an Excel cell holds 32,767 characters)";
function withinCell(runs: XlsxRun[]): XlsxRun[] {
  if (runs.reduce((sum, { text }) => sum + xmlChars(text).length, 0) <= CELL_LIMIT) return runs;
  let room = CELL_LIMIT - CUT.length;
  const kept = runs.flatMap((run) => {
    const text = xmlChars(run.text).slice(0, Math.max(0, room));
    room -= text.length;
    return text ? [{ ...run, text }] : [];
  });
  kept[kept.length - 1] = { ...kept[kept.length - 1], text: kept[kept.length - 1].text + CUT };
  return kept;
}
export function columnLetter(index: number) {
  let name = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A formatted workbook: the package from the shared renderer, each sheet's cells, styles, links,
 *  rich text, widths, hidden columns and frozen header written here. Strings are inline. */
export async function styledXlsx(title: string, sheets: XlsxSheet[], styles: XlsxStyles, identifier = "") {
  const zip = await JSZip.loadAsync(await renderXlsxWorkbook(title, sheets.map(({ name }) => ({ name, rows: [[""]] }))));
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="${styles.fonts.length}">${styles.fonts.join("")}</fonts><fills count="${styles.fills.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${styles.fills.map((color) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`).join("")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${styles.cellXfs.length}">${styles.cellXfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  for (const [index, sheet] of sheets.entries()) {
    const links: Array<{ ref: string; url: string }> = [];
    const width = Math.max(1, ...sheet.rows.map((row) => row.length));
    const columns = sheet.widths.map((value, column) => `<col min="${column + 1}" max="${column + 1}" width="${value}" customWidth="1"${
      sheet.hiddenFrom && column + 1 >= sheet.hiddenFrom ? ' hidden="1"' : ""}/>`).join("") +
      (sheet.hideUnused && width < 16384 ? `<col min="${width + 1}" max="16384" width="13" customWidth="1" hidden="1" outlineLevel="1"/>` : "");
    const data = sheet.rows.map((cells, rowIndex) => {
      const row = rowIndex + 1, height = sheet.heights?.[rowIndex];
      return `<row r="${row}"${height ? ` ht="${height}" customHeight="1"` : ""}>${cells.map((cell, column) => {
        const ref = `${columnLetter(column + 1)}${row}`, style = cell.style ? ` s="${cell.style}"` : "";
        if (cell.link && /^https?:\/\//iu.test(cell.link)) links.push({ ref, url: cell.link });
        if (typeof cell.value === "number") return `<c r="${ref}"${style}><v>${cell.value}</v></c>`;
        const inline = cell.runs?.length ? withinCell(cell.runs).map((run) => `<r>${run.font ? `<rPr>${run.font}</rPr>` : ""}${cellText(run.text)}</r>`).join("")
          : cell.value ? cellText(withinCell([{ text: cell.value, font: "" }])[0].text) : "";
        return `<c r="${ref}"${style} t="inlineStr">${inline ? `<is>${inline}</is>` : ""}</c>`;
      }).join("")}</row>`;
    }).join("");
    const last = `${columnLetter(width)}${Math.max(1, sheet.rows.length)}`;
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"${sheet.view ?? ""}>${sheet.frozenHeader ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : ""}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${columns ? `<cols>${columns}</cols>` : ""}<sheetData>${data}</sheetData>${sheet.autoFilter ? `<autoFilter ref="A1:${last}"/>` : ""}${links.length ? `<hyperlinks>${links.map(({ ref }, i) => `<hyperlink ref="${ref}" r:id="link${i}"/>`).join("")}</hyperlinks>` : ""}<pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/></worksheet>`);
    const rels = `xl/worksheets/_rels/sheet${index + 1}.xml.rels`;
    if (links.length) zip.file(rels, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map(({ url }, i) => `<Relationship Id="link${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXmlText(xmlChars(url)).replace(/"/gu, "&quot;")}" TargetMode="External"/>`).join("")}</Relationships>`);
    else zip.remove(rels);
  }
  const hidden = new Set(sheets.filter((sheet) => sheet.hidden).map((sheet) => sheet.name));
  if (hidden.size) {
    const workbook = await zip.file("xl/workbook.xml")!.async("string");
    zip.file("xl/workbook.xml", workbook.replace(/<sheet name="([^"]*)"/gu, (sheet, name: string) =>
      hidden.has(name) ? `${sheet} state="hidden"` : sheet));
  }
  if (identifier) {
    const core = await zip.file("docProps/core.xml")?.async("string");
    if (core) zip.file("docProps/core.xml", core.replace(/<\/cp:coreProperties>/u,
      `<dc:identifier>${escapeXmlText(xmlChars(identifier))}</dc:identifier></cp:coreProperties>`));
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** A quote check's "[CHECKED]" workbook (the verifier's: quoteVerification/checkedWorkbook.ts), saved beside its input
 *  with the check's receipt. */
export async function saveQuoteCheckWorkbook(documents: Pick<DocumentStore, "metadata" | "create">,
  scope: DocumentScope, inputDocumentId: string, draft: AuthoritiesDraft, result: Result, analysis?: QuoteAnalysis,
  inputVersionId?: string, signal?: AbortSignal) {
  const input = await documents.metadata(scope, inputDocumentId) ?? reject(404, "The input document is no longer available.");
  const { verificationResults } = await import("./quoteVerification/verifier");
  const written = await verificationResults(input.filename, draft, result, { options: analysis ? { analysis } : {}, signal });
  return documents.create(scope, { filename: isIncompleteCheck(result) ? written.name.replace(/\.xlsx$/u, " (incomplete).xlsx") : written.name,
    fileType: "xlsx", projectId: input.project_id, folderId: input.folder_id, bytes: Buffer.from(written.workbook),
    parts: [{ name: "quote-check-receipt.json", bytes: Buffer.from(json({ inputDocumentId,
      inputVersionId, result, ...(analysis ? { analysis } : {}) })) }],
  });
}