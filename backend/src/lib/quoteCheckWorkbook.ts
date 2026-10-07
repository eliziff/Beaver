import JSZip from "jszip";
import type { checkQuotes } from "./quoteCheck";
import type { DocumentScope, DocumentStore } from "./documentStore";
import { escapeXmlText } from "./text";
import { reject } from "./applicationError";
import { renderXlsxWorkbook } from "./chat/tools/documentOps";

type Result = Awaited<ReturnType<typeof checkQuotes>>;
export type QuoteAnalysis = Record<string, string>;
const json = (value: unknown) => JSON.stringify(value ?? null);
const isIncompleteCheck = (result: Result) => result.quotes.length < result.total || result.mode.includes("incomplete");
// Excel limits a cell to 32,767 characters. Continuation rows retain the complete value.
function chunks(value: string, limit = 30_000): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + limit, value.length);
    if (end < value.length && /[\uDC00-\uDFFF]/u.test(value[end])) end--;
    result.push(value.slice(offset, end)); offset = end;
  }
  return result.length ? result : [""];
}

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

/** ALR's display order: draft context and citation beside the checked source; diagnostics remain secondary. */
export async function quoteCheckWorkbook(filename: string, result: Result, analysis?: QuoteAnalysis) {
  const incomplete = isIncompleteCheck(result);
  const mode = result.mode.startsWith("mechanical") ? "Mechanical quotation check"
    : result.mode.startsWith("assisted") ? "Quotation check with explicit citation links" : result.mode;
  const known = new Set(result.quotes.map(({ id }) => id));
  if (analysis && Object.entries(analysis).some(([id, text]) => !known.has(id) || typeof text !== "string"))
    reject(400, "Explanations must refer to quotation IDs in this check.");
  const statuses: Record<string, string> = { verified: "Text verified", mismatch: "Text differs",
    unresolved: "Citation needed", unavailable: "Source unavailable" };
  // One entry per cited source a quotation was checked against, each with that source's own result.
  const display = result.quotes.flatMap((quote, index) => quote.checks.flatMap((check) => {
    const { source, locator, comparison } = check.receipt ?? {};
    const candidate = quote.candidates.find(({ id }) => id === check.candidateId);
    const location = locator ? `${locator.kind[0].toUpperCase()}${locator.kind.slice(1)} ${locator.value}${locator.endValue ? `–${locator.endValue}` : ""}` : "";
    const citation = [...new Set([source?.title, source?.citation,
      !source ? candidate?.citation ?? "" : "", location].filter(Boolean))].join("\n");
    const context = quote.context.includes(quote.quote) ? quote.context : `${quote.context}\n\n${quote.quote}`;
    const changes = comparison?.changes.map(({ kind, authored, source }) =>
      `${kind === "insert" ? "Source includes" : kind === "delete" ? "Draft adds" : "Changed"}: ${authored ? `“${authored}”` : ""}${authored && source ? " → " : ""}${source ? `“${source}”` : ""}`).join("\n") ?? "";
    const sourceText = comparison?.candidate ? `${comparison.candidateOnly ? "Closest candidate — not a verified match\n\n" : ""}${comparison.candidate}${changes ? `\n\n${changes}` : ""}`
      : "No source comparison available.";
    const values = [quote.pageNumbers.length ? `Page ${quote.pageNumbers.join(", ")}` : "—", context,
      citation || "No linked citation", `${statuses[check.status] ?? check.status}\n\n${check.detail}`,
      sourceText, ...(analysis ? [analysis[quote.id] ?? ""] : [])].map((value) => chunks(value, 1200));
    return Array.from({ length: Math.max(...values.map((value) => value.length)) }, (_, part) => ({
      quote, check, part, values: [String(index + 1), ...values.map((value) => value[part] ?? "")],
    }));
  }));
  const receiptRows = result.quotes.flatMap((quote, quoteIndex) => chunks(json(quote)).map((text, index) =>
    [String(quoteIndex + 1), quote.id, String(index + 1), text]));
  const tables = [{ name: "Quote check", columns: ["Quote", "Draft location", "Quotation and context", "Citation",
    incomplete ? "Mechanical result — incomplete" : "Mechanical result", "Source comparison", ...(analysis ? ["AI analysis"] : [])],
    widths: [8, 13, 64, 38, 27, 64, ...(analysis ? [54] : [])], rows: display.map(({ values }) => values) },
    { name: "Summary", columns: ["Quote check", filename], widths: [27, 85], rows: [
      ["Mode", `${mode}${incomplete ? " — incomplete" : ""}`],
      ["Total quotations", String(result.total)], ["Checked quotations", String(result.quotes.length)],
      ...Object.entries(result.counts).map(([status, count]) => [statuses[status] ?? status, String(count)]),
      ["Reading the report", "Read the draft context and linked citation beside the source comparison. Red and green text identifies changed draft and source words. Repeated quote numbers continue a long entry."],
      ["Scope", "Text comparison does not establish whether a proposition or argument is supported. AI analysis, when present, is separate from the mechanical findings."],
      ["Complete evidence", "Unhide Evidence and Citation units for complete receipts and citation-splitter data. Join Part rows in order for long JSON records."]] },
    { name: "Evidence", columns: ["Quote", "Quote ID", "Part", "Exact receipt JSON"], widths: [8, 30, 8, 100], rows: receiptRows },
    { name: "Citation units", columns: ["Unit ID", "Part", "Exact splitter JSON"], widths: [30, 8, 100],
      rows: result.citationUnits.flatMap((unit) => chunks(json(unit)).map((text, index) =>
        [unit.unitId, String(index + 1), text])) }];
  const statusStyles: Record<string, number> = { verified: 6, mismatch: 7, unresolved: 8, unavailable: 9 };
  const colors = ["FFFFFF", "F6F7F8", "17212B", "E7F3EA", "FCEAEC", "FFF3D6", "EEF0F3"];
  const font = (color: string, extra = "") => `<font><sz val="11"/><color rgb="FF${color}"/><name val="Arial"/>${extra}</font>`;
  const xf = (fontId: number, fillId: number, center = false) =>
    `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="${center ? "center" : "top"}"${center ? ' horizontal="center"' : ""} wrapText="1"/></xf>`;
  // Styles: body, alternate, heading, identifier, link, alternate link, verified, differs, unresolved, unavailable.
  const styles: XlsxStyles = { fills: colors, fonts: [font("263341"), font("FFFFFF", "<b/>"), font("263341", "<b/>"),
    font("245785", '<u val="single"/>'), font("1F603D", "<b/>"), font("9B2432", "<b/>"), font("795A13", "<b/>")],
    cellXfs: [xf(0, 2), xf(0, 3), xf(1, 4, true), xf(2, 3, true), xf(3, 2), xf(3, 3), xf(4, 5), xf(5, 6), xf(6, 7), xf(0, 8)] };
  type Span = { start: number; end: number; color: string; strike?: boolean };
  const runs = (text: string, spans: Span[]) => {
    if (!spans.length) return undefined;
    const out: XlsxRun[] = [];
    let cursor = 0;
    for (const span of spans.sort((a, b) => a.start - b.start)) {
      if (span.start < cursor) continue;
      out.push({ text: text.slice(cursor, span.start), font: "" },
        { text: text.slice(span.start, span.end), font: `<b/><color rgb="FF${span.color}"/>${span.strike ? "<strike/>" : ""}` });
      cursor = span.end;
    }
    out.push({ text: text.slice(cursor), font: "" });
    return out;
  };
  const sheets = tables.map((table, index): XlsxSheet => {
    const height = (values?: string[]) => {
      const lines = values ? Math.max(...values.map((value, col) => value.split("\n").reduce((sum, line) =>
        sum + Math.max(1, Math.ceil(line.length / (table.widths[col] - 3))), 0))) : 1;
      return Math.min(409, Math.max(index === 0 ? 86 : 30, lines * 14 + 14));
    };
    const rows = table.rows.map((values, rowIndex): XlsxCell[] => {
      const entry = index === 0 ? display[rowIndex] : undefined;
      const alternate = entry ? Number(entry.values[0]) % 2 === 0 : (rowIndex + 2) % 2 === 0;
      return values.map((value, column): XlsxCell => {
        const cell: XlsxCell = { value, style: alternate ? 1 : 0 };
        if (!entry) return cell;
        const { quote, check, part } = entry, url = check.receipt?.source.url;
        if (column === 0) cell.style = 3;
        if (column === 3 && url) { cell.style = alternate ? 5 : 4; if (!part && /^https?:\/\//iu.test(url)) cell.link = url; }
        if (column === 4) cell.style = statusStyles[check.status] ?? 0;
        if (column === 2) {
          const at = value.indexOf(quote.quote);
          if (at >= 0 && quote.quote) cell.runs = runs(value, [{ start: at, end: at + quote.quote.length, color: "A34E13" }]);
        }
        if (column === 5) {
          const spans: Span[] = [];
          for (const change of check.receipt?.comparison.changes ?? []) {
            for (const [text, color, strike] of [[change.authored, "9B2432", true], [change.source, "1F603D", false]] as const) {
              const start = value.lastIndexOf(`“${text}”`);
              if (text && start >= 0) spans.push({ start, end: start + text.length + 2, color, strike });
            }
          }
          cell.runs = runs(value, spans);
        }
        return cell;
      });
    });
    return { name: table.name, rows: [table.columns.map((value) => ({ value, style: 2 })), ...rows], widths: table.widths,
      frozenHeader: index !== 1, view: ' showGridLines="0" zoomScale="85"',
      heights: [34, ...table.rows.map((values) => height(values))], autoFilter: index === 0, hidden: index >= 2 };
  });
  return Buffer.from(await styledXlsx(`${filename} — Quote check`, sheets, styles));
}

export async function saveQuoteCheckWorkbook(documents: Pick<DocumentStore, "metadata" | "create">,
  scope: DocumentScope, inputDocumentId: string, result: Result, analysis?: QuoteAnalysis, inputVersionId?: string) {
  const input = await documents.metadata(scope, inputDocumentId) ?? reject(404, "The input document is no longer available.");
  const filename = `${input.filename.replace(/\.[^.]+$/u, "")} — Quote check${isIncompleteCheck(result) ? " (incomplete)" : ""}.xlsx`;
  return documents.create(scope, { filename, fileType: "xlsx",
    projectId: input.project_id, folderId: input.folder_id,
    bytes: await quoteCheckWorkbook(input.filename, result, analysis),
    parts: [{ name: "quote-check-receipt.json", bytes: Buffer.from(json({ inputDocumentId,
      inputVersionId, result, ...(analysis ? { analysis } : {}) })) }],
  });
}
