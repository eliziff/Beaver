// One workbook row per citation part, in the Python app's key order (build_audit_data); keys that
// start with "_" are working state and never reach the workbook.
import { citations } from "./engine";
import type { AlrDocument, InlineQuote } from "./document";
import type { PartRow } from "./parts";
import { canliiPdfToHtml } from "./urls";

export type AlrRow = {
  footnote_id: number; footnote_internal_id: number; footnote_display_id: string; citation_part_index: number;
  citation_part_kind: string; citation_part_text: string; citation_part_corrected: string; citation_part_link: string;
  citation_part_anchor_text: string; short_form: string; bare_citation: string; citation_with_style: string;
  pinpoint_fragments: string; page_pinpoints: string; first_page: string; footnote_full: string; proposition_text: string;
  has_quotes: "YES" | "NO"; quote_count: number; quotes_list_json: string; quote_check_status: string;
  quote_corrected_citation: string; quote_check_notes: string; quote_match_pinpoint: string; quote_match_link: string;
  matched_source: string; matched_source_fragment: string; alternate_matched_source_fragment: string;
  journal_match_info: string;
  ref_kind: string; ref_target_footnote_id: string; ref_target_citation_part_index: number | "";
  ref_target_citation_part_text: string; ref_target_footnote_full: string; ref_chain_origin_footnote_id: string;
  ref_chain_origin_citation_part_index: number | ""; ref_chain_origin_citation_part_text: string;
  ref_resolution_notes: string; ref_chain_path: string;
  source_doc?: string;
  _author_provided_link: string; _ref_link_resolution: string; _journal_article_id: string; _journal_link_resolved: boolean;
  _quote_source_tag: string; _alternate_quote_check_notes: string; _alternate_quote_corrected_citation: string;
  _missing_source_key: string; _corrected_link?: string; _check_link?: string;
  _origin?: { kind: string; bare_citation: string; link: string; short_form: string; pinpoint_fragments: string;
    journal_article_id: string; journal_link_resolved: boolean };
};

/** The first page a reported citation starts at ("[1962] SCR 746" → 746), "" when none is written. */
export function firstPage(text: string) {
  const found = citations(text ?? "").find((citation) => citation.form === "full" && citation.fields.year &&
    citation.fields.page && (citation.format === "reporter" || citation.format === "publication"));
  return found?.fields.page ?? "";
}

/** A list as Python's json.dumps writes it (", " between items; non-ASCII escaped unless asked). */
export function pythonJson(values: ReadonlyArray<string | number>, ascii = true) {
  const text = `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  // Per UTF-16 unit, so astral characters become surrogate pairs as Python writes them.
  return ascii ? text.replace(/[^\x00-\x7f]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")) : text;
}
export function quoteList(quotes: readonly InlineQuote[]) {
  return pythonJson(quotes.map((quote) => (quote.inner || quote.raw).trim()), false);
}

export function buildRows(document: AlrDocument, parts: PartRow[]): AlrRow[] {
  return parts.map(({ footnoteId: id, index, part, refLinkResolution }) => {
    const quotes = document.quotes.get(id) ?? [];
    return {
      footnote_id: id, footnote_internal_id: id, footnote_display_id: document.displayIds.get(id) ?? String(id),
      citation_part_index: index, citation_part_kind: part.kind, citation_part_text: part.verbatim,
      citation_part_corrected: part.corrected, citation_part_link: canliiPdfToHtml(part.link), citation_part_anchor_text: "",
      short_form: part.shortForm, bare_citation: part.bareCitation, citation_with_style: part.citationWithStyle,
      pinpoint_fragments: pythonJson(part.pinpointFragments), page_pinpoints: pythonJson(part.pagePinpoints),
      first_page: firstPage(part.citationWithStyle || part.bareCitation), footnote_full: document.footnotes.get(id) ?? "",
      proposition_text: document.propositions.get(id) ?? "", has_quotes: quotes.length ? "YES" : "NO",
      quote_count: quotes.length, quotes_list_json: quoteList(quotes), quote_check_status: "",
      quote_corrected_citation: "", quote_check_notes: "", quote_match_pinpoint: "", quote_match_link: "",
      matched_source: "", matched_source_fragment: "", alternate_matched_source_fragment: "", journal_match_info: "",
      ref_kind: "", ref_target_footnote_id: "", ref_target_citation_part_index: "", ref_target_citation_part_text: "",
      ref_target_footnote_full: "", ref_chain_origin_footnote_id: "", ref_chain_origin_citation_part_index: "",
      ref_chain_origin_citation_part_text: "", ref_resolution_notes: "", ref_chain_path: "",
      _author_provided_link: part.authorProvidedLink, _ref_link_resolution: refLinkResolution, _journal_article_id: "",
      _journal_link_resolved: false, _quote_source_tag: "", _alternate_quote_check_notes: "",
      _alternate_quote_corrected_citation: "", _missing_source_key: "",
    };
  });
}
