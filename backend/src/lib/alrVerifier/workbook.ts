// The "[CHECKED] <stem>.xlsx" workbook: sheet FootnoteReferences with ALR's display columns, raw
// diagnostic columns, colours and links, and the export-detail policy. Ported from
// alr_quote_verifier.py write_workbook, apply_cell_formatting and finalize_workbook_export; the look
// is the Python app's as it writes it (no rich quote highlighting reaches its files).
import { styledXlsx, type XlsxCell, type XlsxStyles } from "../quoteCheckWorkbook";
import { anchorLink } from "./quoteChecks";
import { REF_FIELDS } from "./references";
import type { AlrRow } from "./rows";
import type { ExportDetail } from "./settings";
import { isUsableLink, splitUrl } from "./urls";

export const DIVIDER = "Automatic  Checking  System ►";
const DISPLAY = ["Footnote #", "Footnote Text", "Quotes and proposition", "Citation", DIVIDER, "Corrected quote"];
export const DIAGNOSTIC_COLUMNS = ["footnote_id", "footnote_internal_id", "citation_part_index", "citation_part_kind",
  "citation_part_corrected", "citation_part_link", "citation_part_anchor_text", "short_form", "bare_citation",
  "citation_with_style", "pinpoint_fragments", "page_pinpoints", "first_page", "has_quotes", "quote_count",
  "quotes_list_json", "quote_check_status", "quote_corrected_citation", "quote_check_notes", "quote_match_pinpoint",
  "quote_match_link", "matched_source", "matched_source_fragment", "alternate_matched_source_fragment",
  "journal_match_info", ...REF_FIELDS] as const;
const WIDTHS: Record<string, number> = { Document: 34, "Footnote #": 12, "Footnote Text": 60, "Quotes and proposition": 70,
  Citation: 60, [DIVIDER]: 12, "Corrected quote": 55, citation_part_anchor_text: 80, ref_chain_origin_citation_part_text: 80 };

const compactPinpoint = (summary: string) => (summary ?? "").replace(/\s*\[\+(\d+)\s+more instances\]/gu, " +$1 more").trim();
function statusPrefix(row: AlrRow) {
  const status = row.quote_check_status.trim().toUpperCase();
  const at = () => { const pinpoint = compactPinpoint(row.quote_match_pinpoint); return !pinpoint || /unknown/iu.test(pinpoint) ? " at [unknown]" : ` at ${pinpoint}`; };
  if (status === "OG_PINPOINT_MATCH") return `✓Perfect Match${at()}✓`;
  if (status === "OG_PINPOINT_PARTIAL") {
    const alt = row._alternate_quote_check_notes.trim();
    return `~Partial Match${at()}~${alt ? ` - ✓Perfect Match found at: ${compactPinpoint(alt)}✓` : ""}`;
  }
  if (status === "NO_MATCH") {
    if (!row.citation_part_link.trim()) return "";
    const notes = row.quote_check_notes;
    if (notes.includes("too short for full-document fuzzy checking")) return "❌Short quote in long source; exact search found no match❌";
    if (notes.includes("No source text found")) return "❌Unable to grab source text❌";
    return "❌No match found❌";
  }
  if (/^ALT_PINPOINT(LESS)?_MATCH_(CANLII|A2AJ)$/u.test(status)) return `✓Perfect Match${at()}✓`;
  if (/^ALT_PINPOINT(LESS)?_PARTIAL_(CANLII|A2AJ)$/u.test(status)) return `~Partial Match${at()}~`;
  return "";
}
/** The "Corrected quote" cell: the status, then the quotation as the source words it. */
export function correctedDisplay(row: AlrRow) {
  if (row.has_quotes !== "YES") return "";
  const prefix = statusPrefix(row);
  if (!prefix) return "";
  if (prefix.startsWith("❌") && prefix.endsWith("❌")) return prefix;
  const body = row.quote_corrected_citation.trim();
  if (row.quote_check_status === "OG_PINPOINT_PARTIAL" && row._alternate_quote_check_notes.trim()) {
    const lines = [prefix.split(" - ")[0].replace(/^~|~$/gu, "").replace("Match", "match")];
    if (body) lines.push(body);
    lines.push("", `Perfect match found at ${compactPinpoint(row._alternate_quote_check_notes)}`);
    if (row._alternate_quote_corrected_citation.trim()) lines.push(row._alternate_quote_corrected_citation.trim());
    return lines.join("\n").trim();
  }
  return `${prefix}\n${body}`.trim();
}

/** Where the "Corrected quote" cell links: the quoted words in the source, else its located pinpoint. */
function correctedTarget(row: AlrRow) {
  const link = row.citation_part_link.trim(), status = row.quote_check_status;
  if (!isUsableLink(link)) return "";
  const verification = row.quote_match_link.trim() || link;
  if (row._corrected_link) return row._corrected_link;
  const alternate = status.startsWith("ALT_PINPOINT") && !status.startsWith("ALT_PINPOINTLESS")
    ? row.quote_check_notes.trim() : row._alternate_quote_check_notes.trim();
  if (alternate) {
    const first = /\b(?:par\d+[A-Za-z]?|sec[^\s,[\]]+)\b/iu.exec(alternate)?.[0] ?? "";
    const target = first ? anchorLink(verification, first) : "";
    if (target) return target;
    if (alternate.toLowerCase().includes("[unknown pinpoint]")) return verification;
  }
  if (status.startsWith("ALT_PINPOINT") && (alternate || status.startsWith("ALT_PINPOINTLESS"))) return splitUrl(verification)[0];
  if (status === "OG_PINPOINT_MATCH" || status === "OG_PINPOINT_PARTIAL") return verification;
  return "";
}

const FONTS = ['<font><name val="Calibri"/><family val="2"/><color theme="1"/><sz val="11"/><scheme val="minor"/></font>',
  '<font><name val="Calibri"/><family val="2"/><color theme="1"/><sz val="13"/><scheme val="minor"/></font>',
  '<font><b val="1"/><color rgb="00FFFFFF"/><sz val="13"/></font>', '<font><color rgb="000000FF"/><sz val="13"/><u val="single"/></font>',
  '<font><color rgb="00FFFFFF"/><sz val="20"/></font>', '<font><color rgb="00000000"/><sz val="20"/></font>',
  '<font><color rgb="00000000"/><sz val="13"/></font>'];
const FILLS = ["0C343D", "FF9000", "F3F3F3", "FFC7CE", "C3C3C3", "C6EFCE"];
const fill = (color: string) => FILLS.indexOf(color) + 2;
const TOP = '<alignment vertical="top" wrapText="1"/>', CENTER = '<alignment horizontal="center" vertical="center"/>';
const XF = (font: number, fillId: number, alignment: string) =>
  `<xf numFmtId="0" fontId="${font}" fillId="${fillId}" borderId="0" applyAlignment="1" pivotButton="0" quotePrefix="0" xfId="0">${alignment}</xf>`;
const S = { body: 1, light: 2, link: 3, linkLight: 4, oddNumber: 5, evenNumber: 6, divider: 7, red: 8, grey: 9, green: 10,
  header: 11, black: 12, blackLight: 13 } as const;
const CELL_XFS = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" pivotButton="0" quotePrefix="0" xfId="0"/>',
  XF(1, 0, TOP), XF(1, fill("F3F3F3"), TOP), XF(3, 0, TOP), XF(3, fill("F3F3F3"), TOP), XF(4, fill("0C343D"), CENTER),
  XF(5, fill("FF9000"), CENTER), XF(2, fill("0C343D"), CENTER), XF(1, fill("FFC7CE"), TOP), XF(1, fill("C3C3C3"), TOP),
  XF(1, fill("C6EFCE"), TOP), XF(2, fill("0C343D"), '<alignment horizontal="center" vertical="center" wrapText="1"/>'),
  XF(6, 0, TOP), XF(6, fill("F3F3F3"), TOP)];
const STYLES: XlsxStyles = { fonts: FONTS, fills: FILLS, cellXfs: CELL_XFS };

export async function alrWorkbook(rows: AlrRow[], exportDetail: ExportDetail, identifier = "") {
  const multi = rows.some((row) => row.source_doc);
  const display = multi ? ["Document", ...DISPLAY] : DISPLAY;
  const diagnostics = exportDetail === "display" || exportDetail === "display-json" ? [] : [...DIAGNOSTIC_COLUMNS];
  const header = rows.length ? [...display, ...diagnostics] : ["(no rows)"];
  const at = (name: string) => display.indexOf(name);
  let previousNote: string | null = null, previousProposition: string | null = null;
  const cells = rows.map((row): XlsxCell[] => {
    const odd = row.footnote_internal_id % 2 === 1;
    const plain = odd ? S.body : S.light;
    const values: XlsxCell[] = display.map((): XlsxCell => ({ value: "", style: plain }));
    const document = row.source_doc ?? "";
    if (multi) values[at("Document")].value = document;
    values[at("Footnote #")] = { value: row.footnote_display_id || String(row.footnote_id), style: odd ? S.oddNumber : S.evenNumber };
    // A note's text and proposition appear once, on its first part's row.
    const noteKey = JSON.stringify([document, row.footnote_full]), propositionKey = JSON.stringify([document, row.proposition_text]);
    values[at("Footnote Text")].value = previousNote === noteKey ? "" : row.footnote_full;
    values[at("Quotes and proposition")].value = previousProposition === propositionKey ? "" : row.proposition_text;
    previousNote = noteKey; previousProposition = propositionKey;
    const link = row.citation_part_link.trim(), citation = values[at("Citation")];
    citation.value = row.citation_part_text;
    if (isUsableLink(link)) { citation.link = link; citation.style = odd ? S.link : S.linkLight; if (!row.citation_part_text.trim()) citation.value = link; }
    values[at(DIVIDER)] = { value: "", style: S.divider };
    const corrected = values[at("Corrected quote")], text = correctedDisplay(row);
    corrected.value = text;
    const target = isUsableLink(link) ? correctedTarget(row) : "";
    if (target) {
      corrected.link = target;
      const marker = text.indexOf("Perfect match found at");
      if (row.quote_check_status === "OG_PINPOINT_PARTIAL" && marker > 0 && text.includes("Partial match at")) {
        corrected.runs = [{ text: text.slice(0, marker), font: '<color rgb="FF000000"/><sz val="13"/>' },
          { text: text.slice(marker), font: '<color rgb="FF0000FF"/><sz val="13"/><u val="single"/>' }];
        corrected.style = odd ? S.black : S.blackLight;
      } else corrected.style = odd ? S.link : S.linkLight;
    }
    const raw = row as unknown as Record<string, string | number>;
    return [...values, ...diagnostics.map((name): XlsxCell => {
      const value = raw[name] ?? "";
      const status = name === "quote_check_status" ? String(value) : "";
      const style = status.startsWith("ALT_") || status === "OG_PINPOINT_MATCH" || status === "OG_PINPOINT_PARTIAL" ? S.green
        : status === "NO_MATCH" ? S.red : name === "ref_kind" && (value === "IBID" || value === "SUPRA") ? S.grey : S.body;
      return { value: typeof value === "number" ? value : String(value), style };
    })];
  });
  const widths = header.map((name) => WIDTHS[name] ?? 15);
  const hiddenFrom = exportDetail === "diagnostic-hidden" && diagnostics.length ? display.length + 1 : null;
  return styledXlsx("FootnoteReferences", [{ name: "FootnoteReferences", widths, hiddenFrom, hideUnused: true,
    frozenHeader: true, rows: [header.map((value) => ({ value, style: S.header })), ...cells] }], STYLES, identifier);
}

async function sha256(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The workbook and, for display-json, the diagnostics sidecar it is paired with. */
export async function exportWorkbook(rows: AlrRow[], workbookName: string, exportDetail: ExportDetail) {
  if (exportDetail !== "display-json") return { workbook: await alrWorkbook(rows, exportDetail), sidecar: null };
  const signature = (await sha256(["alr-sidecar-v1", workbookName, String(rows.length), `${Date.now()}${performance.now()}`].join("|"))).slice(0, 20);
  const workbook = await alrWorkbook(rows, exportDetail, `alr-sidecar:${signature}`);
  return { workbook, sidecar: { schema: "alr_quote_verifier_diagnostics_v1", xlsx_file: workbookName, xlsx_signature: signature,
    exported_at: new Date().toISOString().slice(0, 19), footnote_rows: rows } };
}
export const sidecarName = (workbookName: string) => workbookName.replace(/\.xlsx$/iu, "") + ".diagnostics.json";
