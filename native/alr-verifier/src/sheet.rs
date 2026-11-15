//! Sheet FootnoteReferences written from the rows: the desktop app's columns, formats and display text, and for
//! display-json the signature its diagnostics file is paired with it by.

use crate::rows::{slice, Row};
use crate::workbook::{self, Align, Cell, CellFormat, Font, Run, Sheet, Value, Workbook};
use crate::{References, Request, Written};
use legal_structure::trim_javascript_whitespace as js_trim;
use legal_structure_features::quote_spans;
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::LazyLock;

const DIVIDER: &str = "Automatic  Checking  System ►";
const DISPLAY: [&str; 6] = ["Footnote #", "Footnote Text", "Quotes and proposition", "Citation", DIVIDER, "Corrected quote"];
const ANALYSIS: &str = "AI analysis";
const DIAGNOSTIC: [&str; 35] = ["footnote_id", "footnote_internal_id", "citation_part_index", "citation_part_kind",
    "citation_part_corrected", "citation_part_link", "citation_part_anchor_text", "short_form", "bare_citation",
    "citation_with_style", "pinpoint_fragments", "page_pinpoints", "first_page", "has_quotes", "quote_count",
    "quotes_list_json", "quote_check_status", "quote_corrected_citation", "quote_check_notes", "quote_match_pinpoint",
    "quote_match_link", "matched_source", "matched_source_fragment", "alternate_matched_source_fragment",
    "journal_match_info", "ref_kind", "ref_target_footnote_id", "ref_target_citation_part_index", "ref_target_citation_part_text",
    "ref_target_footnote_full", "ref_chain_origin_footnote_id", "ref_chain_origin_citation_part_index",
    "ref_chain_origin_citation_part_text", "ref_resolution_notes", "ref_chain_path"];

fn usable(link: &str) -> bool {
    static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://[^/\s]").unwrap());
    LINK.is_match(js_trim(link))
}

/// A font of the cells': Calibri 13 pt, its colour opaque or the theme's text colour; a run's is never the theme's body
/// font, so no run falls back to a viewer's own.
fn font(color: Option<&'static str>, bold: bool, underline: bool, theme: bool) -> Font {
    Font { size: Some(13.0), color, bold, underline, theme }
}

/// The desktop app's workbook formats (its styles.xml): Calibri 13 pt, a body cell's at the top and wrapped, a number's
/// and the header's in the middle.
fn formats() -> BTreeMap<&'static str, CellFormat> {
    let body = || font(None, false, false, true);
    let link = || font(Some("0000FF"), false, true, false);
    let top = |fill, font| CellFormat { font, fill, align: Some(Align::Top), wrap: true };
    let middle = |font, fill, wrap| CellFormat { font, fill: Some(fill), align: Some(Align::Center), wrap };
    BTreeMap::from([("body", top(None, body())), ("light", top(Some("F3F3F3"), body())), ("link", top(None, link())),
        ("linkLight", top(Some("F3F3F3"), link())), ("oddNumber", middle(font(Some("FFFFFF"), false, false, false), "0C343D", false)),
        ("evenNumber", middle(font(Some("000000"), false, false, false), "FF9000", false)),
        ("divider", middle(font(Some("FFFFFF"), true, false, false), "0C343D", false)), ("red", top(Some("FFC7CE"), body())),
        ("grey", top(Some("C3C3C3"), body())), ("green", top(Some("C6EFCE"), body())),
        ("header", middle(font(Some("FFFFFF"), true, false, false), "0C343D", true))])
}

fn width(name: &str) -> f64 {
    match name {
        "Footnote #" | DIVIDER => 12.0,
        "Footnote Text" | "Citation" => 60.0,
        "Quotes and proposition" => 70.0,
        "Corrected quote" | ANALYSIS => 55.0,
        "citation_part_anchor_text" | "ref_chain_origin_citation_part_text" => 80.0,
        _ => 15.0,
    }
}

fn compact(summary: &str) -> String {
    static MORE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\[\+(\d+)\s+more instances\]").unwrap());
    js_trim(&MORE.replace_all(summary, " +$1 more")).to_owned()
}

fn status_prefix(row: &Row) -> String {
    static MATCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ALT_PINPOINT(LESS)?_MATCH_").unwrap());
    static PARTIAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ALT_PINPOINT(LESS)?_PARTIAL_").unwrap());
    let status = row.checked.quote_check_status.as_str();
    let pinpoint = compact(&row.checked.quote_match_pinpoint);
    let at = if pinpoint.is_empty() || pinpoint.to_lowercase().contains("unknown") { " at [unknown]".to_owned() } else { format!(" at {pinpoint}") };
    if status == "OG_PINPOINT_MATCH" || MATCH.is_match(status) { return format!("✓Perfect Match{at}✓"); }
    let alternate = compact(row.checked._alternate_quote_check_notes.as_deref().unwrap_or(""));
    if status == "OG_PINPOINT_PARTIAL" {
        return format!("~Partial Match{at}~{}", if alternate.is_empty() { String::new() } else { format!(" - ✓Perfect Match found at: {alternate}✓") });
    }
    if PARTIAL.is_match(status) { return format!("~Partial Match{at}~"); }
    if status != "NO_MATCH" || !usable(&row.citation_part_link) { return String::new(); }
    let notes = &row.checked.quote_check_notes;
    (if notes.contains("too short for full-document fuzzy checking") { "❌Short quote in long source; exact search found no match❌" }
    else if notes.contains("No source text found") { "❌Unable to grab source text❌" } else { "❌No match found❌" }).to_owned()
}

fn corrected_display(row: &Row) -> String {
    let prefix = if row.has_quotes == "YES" { status_prefix(row) } else { String::new() };
    if prefix.is_empty() || prefix.starts_with('❌') { return prefix; }
    let checked = &row.checked;
    let body = js_trim(&checked.quote_corrected_citation);
    let alternate = js_trim(checked._alternate_quote_check_notes.as_deref().unwrap_or(""));
    let notes = js_trim(&checked.quote_check_notes);
    let location = if checked.quote_check_status.starts_with("ALT_") { js_trim(&checked.quote_match_pinpoint) } else { "" };
    let warning = if !location.is_empty() && notes.starts_with(location) { js_trim(&notes[location.len()..]) } else { notes };
    if checked.quote_check_status != "OG_PINPOINT_PARTIAL" || alternate.is_empty() {
        return js_trim(&[prefix.as_str(), body, warning].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n")).to_owned();
    }
    // A partial match at the pinpoint, then where the quotation is found word for word.
    let alternate_body = js_trim(checked._alternate_quote_corrected_citation.as_deref().unwrap_or(""));
    let head = prefix.split(" - ").next().unwrap_or("");
    let head = head.strip_prefix('~').unwrap_or(head);
    let head = head.strip_suffix('~').unwrap_or(head).replace("Match", "match");
    let mut lines = vec![head];
    if !body.is_empty() { lines.push(body.to_owned()); }
    lines.push(String::new());
    lines.push(format!("Perfect match found at {}", compact(alternate)));
    if !alternate_body.is_empty() { lines.push(alternate_body.to_owned()); }
    js_trim(&lines.join("\n")).to_owned()
}

/// The quotations in a proposition, bold in the colour of the row's note number.
fn quote_runs(text: &str, quotes: &[String], odd: bool) -> Option<Vec<Run>> {
    let mut runs = Vec::new();
    let mut cursor = 0;
    let plain = || font(None, false, false, false);
    // Where the engine finds the quotations in the proposition, none inside or across another.
    for [start, end] in quote_spans(text, quotes) {
        if cursor < start { runs.push(Run { text: slice(text, cursor, start), font: plain() }); }
        runs.push(Run { text: slice(text, start, end), font: font(Some(if odd { "0B5394" } else { "FF9000" }), true, false, false) });
        cursor = end;
    }
    if !runs.is_empty() && cursor < text.encode_utf16().count() { runs.push(Run { text: slice(text, cursor, usize::MAX), font: plain() }); }
    (!runs.is_empty()).then_some(runs)
}

/// A partial match beside a perfect one found elsewhere: plain, then the perfect match as the cell's link.
fn alternate_runs(text: &str) -> Option<Vec<Run>> {
    let at = text.find("Perfect match found at").filter(|&at| at > 0 && text.contains("Partial match at"))?;
    Some(vec![Run { text: text[..at].to_owned(), font: font(Some("000000"), false, false, false) },
        Run { text: text[at..].to_owned(), font: font(Some("0000FF"), false, true, false) }])
}

fn text(value: impl Into<String>, format: &'static str) -> Cell { Cell { value: Value::Text(value.into()), format: Some(format), link: None, runs: None } }

/// A diagnostic column's value as the row holds it: a number as a number.
fn diagnostic(row: &Row, name: &str) -> Value {
    let checked = &row.checked;
    let number = |value: &serde_json::Value| value.as_f64().map_or_else(|| Value::Text(value.as_str().unwrap_or("").to_owned()), Value::Number);
    Value::Text(match name {
        "footnote_id" => return Value::Number(row.footnote_id as f64),
        "footnote_internal_id" => return Value::Number(row.footnote_internal_id as f64),
        "citation_part_index" => return Value::Number(row.citation_part_index as f64),
        "quote_count" => return Value::Number(row.quote_count as f64),
        "ref_target_citation_part_index" => return number(&row.ref_target_citation_part_index),
        "ref_chain_origin_citation_part_index" => return number(&row.ref_chain_origin_citation_part_index),
        "citation_part_kind" => row.citation_part_kind.clone(),
        "citation_part_corrected" => row.citation_part_corrected.clone(),
        "citation_part_link" => row.citation_part_link.clone(),
        "citation_part_anchor_text" => row.citation_part_anchor_text.clone(),
        "short_form" => row.short_form.clone(),
        "bare_citation" => row.bare_citation.clone(),
        "citation_with_style" => row.citation_with_style.clone(),
        "pinpoint_fragments" => row.pinpoint_fragments.clone(),
        "page_pinpoints" => row.page_pinpoints.clone(),
        "first_page" => row.first_page.clone(),
        "has_quotes" => row.has_quotes.to_owned(),
        "quotes_list_json" => row.quotes_list_json.clone(),
        "quote_check_status" => checked.quote_check_status.clone(),
        "quote_corrected_citation" => checked.quote_corrected_citation.clone(),
        "quote_check_notes" => checked.quote_check_notes.clone(),
        "quote_match_pinpoint" => checked.quote_match_pinpoint.clone(),
        "quote_match_link" => checked.quote_match_link.clone(),
        "matched_source" => checked.matched_source.clone(),
        "matched_source_fragment" => checked.matched_source_fragment.clone(),
        "alternate_matched_source_fragment" => checked.alternate_matched_source_fragment.clone(),
        "journal_match_info" => row.journal_match_info.to_owned(),
        "ref_kind" => row.ref_kind.clone(),
        "ref_target_footnote_id" => row.ref_target_footnote_id.clone(),
        "ref_target_citation_part_text" => row.ref_target_citation_part_text.clone(),
        "ref_target_footnote_full" => row.ref_target_footnote_full.clone(),
        "ref_chain_origin_footnote_id" => row.ref_chain_origin_footnote_id.clone(),
        "ref_chain_origin_citation_part_text" => row.ref_chain_origin_citation_part_text.clone(),
        "ref_resolution_notes" => row.ref_resolution_notes.clone(),
        _ => row.ref_chain_path.clone(),
    })
}

/// The sheet's package.
fn package(rows: &[Row], detail: &str, identifier: Option<String>, analysis: Option<&BTreeMap<String, String>>) -> Result<Vec<u8>, String> {
    let diagnostics: &[&str] = if detail == "display" || detail == "display-json" { &[] } else { &DIAGNOSTIC };
    let mut display = DISPLAY.to_vec();
    if analysis.is_some() { display.push(ANALYSIS); }
    let header = if rows.is_empty() { vec!["(no rows)"] } else { display.iter().chain(diagnostics).copied().collect() };
    let (mut previous_note, mut previous_proposition) = ("", "");
    let mut cells = vec![header.iter().map(|name| text(*name, "header")).collect::<Vec<_>>()];
    for row in rows {
        let odd = row.footnote_internal_id % 2 == 1;
        let plain = if odd { "body" } else { "light" };
        let link = js_trim(&row.citation_part_link).to_owned();
        let linked = usable(&link);
        let warning = row.citation_part_warning.clone().unwrap_or_default();
        let citation = format!("{}{}", if row.citation_part_text.is_empty() { &link } else { &row.citation_part_text },
            if warning.is_empty() { String::new() } else { format!("\n{warning}") });
        // A note's text and proposition appear once, on its first part's row.
        let note = if previous_note == row.footnote_full { "" } else { row.footnote_full.as_str() };
        let proposition = if previous_proposition == row.proposition_text { "" } else { row.proposition_text.as_str() };
        (previous_note, previous_proposition) = (row.footnote_full.as_str(), row.proposition_text.as_str());
        let corrected = corrected_display(row);
        let status_linked = linked && !corrected.is_empty() && !corrected.starts_with('❌');
        let quote_link = if usable(&row.checked.quote_match_link) { row.checked.quote_match_link.clone() } else { link.clone() };
        let alternate = (row.checked.quote_check_status == "OG_PINPOINT_PARTIAL").then(|| alternate_runs(&corrected)).flatten();
        let mut line = vec![text(row.footnote_display_id.clone(), if odd { "oddNumber" } else { "evenNumber" }), text(note, plain),
            Cell { runs: quote_runs(proposition, &row.quotes, odd), ..text(proposition, plain) },
            if linked { Cell { link: Some(link.clone()), ..text(citation, if !warning.is_empty() { "red" } else if odd { "link" } else { "linkLight" }) } }
            else { text(citation, if warning.is_empty() { plain } else { "red" }) },
            text("", "divider"),
            if status_linked { match alternate {
                Some(runs) => Cell { link: Some(quote_link), runs: Some(runs), ..text(corrected, plain) },
                None => Cell { link: Some(quote_link), ..text(corrected, if odd { "link" } else { "linkLight" }) },
            } } else { text(corrected, plain) }];
        // A note's analysis, separate from the mechanical findings, appears once with its proposition.
        if let Some(analysis) = analysis {
            let said = if proposition.is_empty() { String::new() } else {
                row._quote_ids.iter().filter_map(|id| analysis.get(id).cloned()).collect::<Vec<_>>().join("\n\n") };
            line.push(text(said, plain));
        }
        for name in diagnostics {
            let status = if *name == "quote_check_status" { row.checked.quote_check_status.as_str() } else { "" };
            let format = if status.starts_with("ALT_") || status.starts_with("OG_PINPOINT") { "green" } else if status == "NO_MATCH" { "red" }
                else if *name == "ref_kind" && (row.ref_kind == "IBID" || row.ref_kind == "SUPRA") { "grey" } else { "body" };
            line.push(Cell { value: diagnostic(row, name), format: Some(format), link: None, runs: None });
        }
        cells.push(line);
    }
    workbook::write(&Workbook { title: "FootnoteReferences", identifier, formats: formats(), sheets: vec![Sheet {
        name: "FootnoteReferences", widths: header.iter().map(|name| width(name)).collect(),
        hidden_from: (detail == "diagnostic-hidden" && !diagnostics.is_empty()).then_some(display.len() as u16),
        hide_unused: true, frozen_header: true, rows: cells }] })
}

/// "[CHECKED] <stem>.xlsx", its rows and, for display-json, the signature its diagnostics file is paired with it by.
pub(crate) fn written(request: &Request, rows: Vec<Row>) -> Result<Written, String> {
    use sha2::{Digest, Sha256};
    let stem = request.filename.rfind('.').filter(|&at| !request.filename[at + 1..].is_empty()).map_or(&request.filename[..], |at| &request.filename[..at]);
    let name = format!("[CHECKED] {stem}.xlsx");
    let detail = request.options.export_detail.as_deref().unwrap_or("diagnostic-hidden");
    let kind = |value: &str| rows.iter().filter(|row| row.ref_kind == value).collect::<Vec<_>>();
    let (ibid, supra) = (kind("IBID"), kind("SUPRA"));
    let references = References { ibid: ibid.len(), supra: supra.len(),
        linked: ibid.iter().chain(&supra).filter(|row| !row.citation_part_link.is_empty()).count() };
    let signature = (detail == "display-json").then(|| {
        let digest = Sha256::digest(["alr-sidecar-v1", name.as_str(), rows.len().to_string().as_str(), request.stamp.as_str()].join("|"));
        digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>()[..20].to_owned()
    });
    let workbook = package(&rows, detail, signature.as_ref().map(|signature| format!("alr-sidecar:{signature}")),
        request.options.analysis.as_ref())?;
    Ok(Written { name, workbook, rows, references, signature })
}
