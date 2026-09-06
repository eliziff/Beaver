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

/** ALR's display order: draft context and citation beside the checked source; diagnostics remain secondary. */
export async function quoteCheckWorkbook(filename: string, result: Result, analysis?: QuoteAnalysis) {
  const incomplete = isIncompleteCheck(result);
  const mode = result.mode.startsWith("mechanical") ? "Mechanical quotation check"
    : result.mode.startsWith("assisted") ? "Quotation check with explicit citation links" : result.mode;
  const known = new Set(result.quotes.map(({ id }) => id));
  if (analysis && Object.entries(analysis).some(([id, text]) => !known.has(id) || typeof text !== "string"))
    reject(400, "Explanations must refer to quotation IDs in this check.");
  const statuses: Record<string, string> = { verified: "Text verified", mismatch: "Text differs",
    ambiguous: "Citation ambiguous", unresolved: "Citation needed", unavailable: "Source unavailable" };
  const display = result.quotes.flatMap((quote, index) => {
    const { source, locator, comparison } = quote.receipt ?? {};
    const location = locator ? `${locator.kind[0].toUpperCase()}${locator.kind.slice(1)} ${locator.value}${locator.endValue ? `–${locator.endValue}` : ""}` : "";
    const citation = [...new Set([source?.title, source?.citation,
      !source ? quote.candidates.map(({ citation }) => citation).join("\n") : "", location].filter(Boolean))].join("\n");
    const context = quote.context.includes(quote.quote) ? quote.context : `${quote.context}\n\n${quote.quote}`;
    const changes = comparison?.changes.map(({ kind, authored, source }) =>
      `${kind === "insert" ? "Source includes" : kind === "delete" ? "Draft adds" : "Changed"}: ${authored ? `“${authored}”` : ""}${authored && source ? " → " : ""}${source ? `“${source}”` : ""}`).join("\n") ?? "";
    const sourceText = comparison?.candidate ? `${comparison.candidateOnly ? "Closest candidate — not a verified match\n\n" : ""}${comparison.candidate}${changes ? `\n\n${changes}` : ""}`
      : "No source comparison available.";
    const values = [quote.pageNumbers.length ? `Page ${quote.pageNumbers.join(", ")}` : "—", context,
      citation || "No linked citation", `${statuses[quote.status] ?? quote.status}\n\n${quote.detail}`,
      sourceText, ...(analysis ? [analysis[quote.id] ?? ""] : [])].map((value) => chunks(value, 1200));
    return Array.from({ length: Math.max(...values.map((value) => value.length)) }, (_, part) => ({
      quote, part, values: [String(index + 1), ...values.map((value) => value[part] ?? "")],
    }));
  });
  const receiptRows = result.quotes.flatMap((quote, quoteIndex) => chunks(json(quote)).map((text, index) =>
    [String(quoteIndex + 1), quote.id, String(index + 1), text]));
  const sheets = [{ name: "Quote check", columns: ["Quote", "Draft location", "Quotation and context", "Citation",
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
  const zip = await JSZip.loadAsync(await renderXlsxWorkbook(`${filename} — Quote check`, sheets));
  const statusStyles: Record<string, number> = { verified: 6, mismatch: 7, ambiguous: 8, unresolved: 8, unavailable: 9 };
  const colors = ["FFFFFF", "F6F7F8", "17212B", "E7F3EA", "FCEAEC", "FFF3D6", "EEF0F3"];
  const font = (color: string, extra = "") => `<font><sz val="11"/><color rgb="FF${color}"/><name val="Arial"/>${extra}</font>`;
  const fonts = [font("263341"), font("FFFFFF", "<b/>"), font("263341", "<b/>"),
    font("245785", '<u val="single"/>'), font("1F603D", "<b/>"), font("9B2432", "<b/>"), font("795A13", "<b/>")];
  const xf = (fontId: number, fillId: number, center = false) =>
    `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="${center ? "center" : "top"}"${center ? ' horizontal="center"' : ""} wrapText="1"/></xf>`;
  // Styles: body, alternate, heading, identifier, link, alternate link, verified, differs, unresolved, unavailable.
  const styles = [xf(0, 2), xf(0, 3), xf(1, 4, true), xf(2, 3, true), xf(3, 2), xf(3, 3),
    xf(4, 5), xf(5, 6), xf(6, 7), xf(0, 8)];
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${colors.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${colors.map((color) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`).join("")}</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1">${xf(0, 0)}</cellStyleXfs><cellXfs count="${styles.length}">${styles.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  for (let index = 0; index < sheets.length; index++) {
    const sheet = sheets[index], name = `xl/worksheets/sheet${index + 1}.xml`;
    let xml = (await zip.file(name)!.async("nodebuffer")).toString("utf8");
    const widths = sheet.widths.map((width, col) => `<col min="${col + 1}" max="${col + 1}" width="${width}" customWidth="1"/>`).join("");
    xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/u,
      `<sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="85">${index === 1 ? "" : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'}</sheetView></sheetViews>`)
      .replace("<sheetData>", `<cols>${widths}</cols><sheetData>`)
      .replace(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/gu, (_, rowText, cells: string) => {
        const row = Number(rowText), entry = display[row - 2], values = sheet.rows[row - 2];
        const lines = values ? Math.max(...values.map((value, col) => value.split("\n").reduce((sum, line) =>
          sum + Math.max(1, Math.ceil(line.length / (sheet.widths[col] - 3))), 0))) : 1;
        const height = row === 1 ? 34 : Math.min(409, Math.max(index === 0 ? 86 : 30, lines * 14 + 14));
        const styled = cells.replace(/<c r="([A-Z]+)(\d+)"/gu, (cell, column: string) => {
          const alternate = index === 0 ? Number(entry?.values[0]) % 2 === 0 : row % 2 === 0;
          const style = row === 1 ? 2 : index === 0 && column === "A" ? 3
            : index === 0 && column === "D" && entry?.quote.receipt?.source.url ? (alternate ? 5 : 4)
            : index === 0 && column === "E" ? (statusStyles[entry?.quote.status] ?? 0)
            : alternate ? 1 : 0;
          return `${cell} s="${style}"`;
        });
        return `<row r="${row}" ht="${height}" customHeight="1">${styled}</row>`;
      });
    if (index === 0) {
      const links: Array<{ ref: string; url: string }> = [];
      display.forEach(({ quote, part, values }, rowIndex) => {
        const row = rowIndex + 2;
        if (quote.receipt?.source.url && /^https?:\/\//iu.test(quote.receipt.source.url) && !part)
          links.push({ ref: `D${row}`, url: quote.receipt.source.url });
        const richCell = (column: string, text: string, spans: Array<{ start: number; end: number; color: string; strike?: boolean }>) => {
          if (!spans.length) return;
          let cursor = 0, rich = "";
          const run = (value: string, properties = "") => `<r>${properties ? `<rPr>${properties}</rPr>` : ""}<t xml:space="preserve">${escapeXmlText(value)}</t></r>`;
          for (const span of spans.sort((a, b) => a.start - b.start)) {
            if (span.start < cursor) continue;
            rich += run(text.slice(cursor, span.start)) + run(text.slice(span.start, span.end),
              `<b/><color rgb="FF${span.color}"/>${span.strike ? "<strike/>" : ""}`);
            cursor = span.end;
          }
          rich += run(text.slice(cursor));
          xml = xml.replace(new RegExp(`<c r="${column}${row}"([^>]*)>[\\s\\S]*?<\\/c>`, "u"), (_, attributes: string) =>
            `<c r="${column}${row}"${attributes.replace(/ t="[^"]*"/u, "")} t="inlineStr"><is>${rich}</is></c>`);
        };
        const at = values[2].indexOf(quote.quote);
        if (at >= 0 && quote.quote) richCell("C", values[2], [{ start: at, end: at + quote.quote.length, color: "A34E13" }]);
        const spans: Array<{ start: number; end: number; color: string; strike?: boolean }> = [];
        const sourceText = values[5];
        for (const change of quote.receipt?.comparison.changes ?? []) {
          for (const [text, color, strike] of [[change.authored, "9B2432", true], [change.source, "1F603D", false]] as const) {
            const start = sourceText.lastIndexOf(`“${text}”`);
            if (text && start >= 0) spans.push({ start, end: start + text.length + 2, color, strike });
          }
        }
        richCell("F", sourceText, spans);
      });
      xml = xml.replace("</sheetData>", `</sheetData><autoFilter ref="A1:${analysis ? "G" : "F"}${Math.max(1, display.length + 1)}"/>`);
      if (links.length) {
        xml = xml.replace(/(?=<printOptions|<pageMargins|<pageSetup|<ignoredErrors|<\/worksheet>)/u, `<hyperlinks>${links.map(({ ref }, i) =>
          `<hyperlink ref="${ref}" r:id="quoteLink${i}"/>`).join("")}</hyperlinks>`);
        zip.file("xl/worksheets/_rels/sheet1.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map(({ url }, i) =>
          `<Relationship Id="quoteLink${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXmlText(url).replace(/"/gu, "&quot;")}" TargetMode="External"/>`).join("")}</Relationships>`);
      }
    }
    zip.file(name, Buffer.from(xml, "utf8"));
  }
  const workbook = await zip.file("xl/workbook.xml")!.async("string");
  zip.file("xl/workbook.xml", workbook.replace(/<sheet name="(?:Evidence|Citation units)"/gu, (sheet) => `${sheet} state="hidden"`));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
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
