//! Target-neutral engine operations. The Node addon (`node.rs`) and the browser
//! WebAssembly module (`wasi.rs`) are thin bindings over these functions.

use legal_structure::{
    analyze_instrument, analyze_native_markup, authority_references_in_text,
    caselaw_citation_lookup_key, citation_lookup_key, citation_occurrences_in_text,
    classify_citator_excerpt, document_fingerprint, docx_structure_lint, grounded_prose_errors,
    has_citation_in_text, journal_document_structure, journal_text_document_structure,
    marked_quote_spans, provider_citations_in_text, provider_text_document_structure,
    quote_repair_suggestion, text_fragment_plan, utf16_prefix_ceil, AuthoritativeTableCell,
    DocumentFingerprint, DocumentKind, DocumentOrigin, DocumentQuery, DocumentStructure,
    FollowDirection, JournalPageLabel, NativeMarkupInput, ProviderTextInput, VisibleEvidenceText,
};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;

pub type CoreResult<T> = Result<T, String>;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StructureRequest {
    Instrument {
        text: String,
        id: String,
        #[serde(default)]
        table_cells: Vec<AuthoritativeTableCell>,
        reconstruct_lineation: bool,
    },
    ProviderText {
        input: ProviderTextInput,
    },
    NativeMarkup {
        input: NativeMarkupInput,
    },
    Journal {
        article_id: usize,
        url: Option<String>,
        filename: Option<String>,
        text: Option<String>,
        #[serde(default)]
        page_rows: Vec<JournalPageLabel>,
    },
}

pub(crate) enum NativeProduct {
    Structure(DocumentStructure),
    #[cfg(feature = "legalpdf")]
    Pdf(legalpdf::PdfDocument),
}

pub struct NativeDocument {
    pub(crate) product: NativeProduct,
    pub(crate) query: DocumentQuery,
}

impl NativeDocument {
    fn new(product: NativeProduct) -> Self {
        Self { product, query: DocumentQuery::new() }
    }

    pub fn structure(&self) -> &DocumentStructure {
        match &self.product {
            NativeProduct::Structure(structure) => structure,
            #[cfg(feature = "legalpdf")]
            NativeProduct::Pdf(document) => document.structure(),
        }
    }
}

fn native_error(error: legal_structure::EngineError) -> String {
    error.to_string()
}

pub fn native_build_features() -> &'static str {
    if cfg!(feature = "allocation-diagnostics") {
        "legalpdf,diagnostics,allocation-diagnostics"
    } else if cfg!(feature = "diagnostics") {
        "legalpdf,diagnostics"
    } else if cfg!(feature = "legalpdf") {
        "legalpdf"
    } else {
        ""
    }
}

fn document_kind(value: &str) -> CoreResult<DocumentKind> {
    match value {
        "paragraph" => Ok(DocumentKind::Paragraph),
        "page" => Ok(DocumentKind::Page),
        "section" => Ok(DocumentKind::Section),
        "footnote" => Ok(DocumentKind::Footnote),
        "table" => Ok(DocumentKind::Table),
        "row" => Ok(DocumentKind::Row),
        "cell" => Ok(DocumentKind::Cell),
        _ => Err("invalid document block kind".to_owned()),
    }
}

fn follow_direction(value: &str) -> CoreResult<FollowDirection> {
    match value {
        "none" => Ok(FollowDirection::None),
        "out" => Ok(FollowDirection::Out),
        "in" => Ok(FollowDirection::In),
        "both" => Ok(FollowDirection::Both),
        _ => Err("invalid reference direction".to_owned()),
    }
}

pub fn derive_document_structure(request: StructureRequest) -> CoreResult<NativeDocument> {
    let structure = match request {
        StructureRequest::Instrument {
            text,
            id,
            table_cells,
            reconstruct_lineation,
        } => analyze_instrument(text, id, &table_cells, reconstruct_lineation)
            .map_err(native_error)?,
        StructureRequest::ProviderText { input } => {
            provider_text_document_structure(input).map_err(native_error)?
        }
        StructureRequest::NativeMarkup { input } => {
            analyze_native_markup(input).map_err(native_error)?
        }
        StructureRequest::Journal {
            article_id,
            url,
            filename,
            text,
            page_rows,
        } => if let Some(filename) = filename {
            let file = File::open(filename).map_err(|error| error.to_string())?;
            journal_document_structure(article_id, url, BufReader::new(file), &page_rows)
        } else if let Some(text) = text {
            journal_text_document_structure(article_id, url, text, &page_rows)
        } else {
            return Err("journal request requires filename or text".to_owned());
        }
        .map_err(native_error)?,
    };
    Ok(NativeDocument::new(NativeProduct::Structure(structure)))
}

pub fn derive_document_fingerprint(request: StructureRequest) -> CoreResult<DocumentFingerprint> {
    Ok(document_fingerprint(derive_document_structure(request)?.structure()))
}

pub fn docx_structure_lint_json(document: &NativeDocument) -> CoreResult<impl Serialize> {
    #[cfg(feature = "legalpdf")]
    {
        if matches!(document.product, NativeProduct::Pdf(_)) {
            return Err("DOCX lint requires a structured document".to_owned());
        }
    }
    docx_structure_lint(document.structure()).map_err(native_error)
}

pub fn document_text(document: &NativeDocument, limit: Option<u32>) -> &str {
    let text = document.structure().query_text();
    limit.map_or(text, |limit| utf16_prefix_ceil(text, limit as usize))
}

pub fn document_text_bytes(document: &NativeDocument) -> u32 {
    document.structure().query_text().len() as u32
}

pub fn document_revision(document: &NativeDocument) -> &str {
    &document.structure().revision
}

pub fn read_document_text_window(
    document: &NativeDocument,
    offset: u32,
    start_char: u32,
    limit: u32,
) -> impl Serialize + '_ {
    document.query.text_window(
        document.structure(),
        offset as usize,
        start_char as usize,
        limit as usize,
    )
}

pub fn read_document_text_range(
    document: &NativeDocument,
    start: u32,
    end: u32,
    offset: Option<u32>,
    limit: u32,
) -> impl Serialize + '_ {
    document.query.text_range_window(
        document.structure(),
        start as usize,
        end as usize,
        offset.map(|value| value as usize),
        limit as usize,
    )
}

pub fn document_fingerprint_of(document: &NativeDocument) -> DocumentFingerprint {
    match &document.product {
        NativeProduct::Structure(structure) => document_fingerprint(structure),
        #[cfg(feature = "legalpdf")]
        NativeProduct::Pdf(document) => document.fingerprint(),
    }
}

pub fn document_anchors(document: &NativeDocument, end: Option<u32>) -> impl Serialize + '_ {
    document
        .query
        .anchors(document.structure(), end.map(|value| value as usize))
        .collect::<Vec<_>>()
}

pub fn legal_source_viewer<'a>(
    document: &'a NativeDocument,
    primary_kind: &str,
    limit: Option<u32>,
) -> CoreResult<impl Serialize + 'a> {
    Ok(document.query.viewer(
        document.structure(),
        document_kind(primary_kind)?,
        limit.map_or(u32::MAX as usize, |value| value as usize),
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutLine {
    /// "heading", "list_item" or "paragraph".
    kind: &'static str,
    /// Nesting from the enumerator grammar: I. is 0, A. under it 1, 1. under that 2.
    level: usize,
    /// The enumerator ("(a)", "II.") when the grammar found one.
    #[serde(skip_serializing_if = "Option::is_none")]
    marker: Option<String>,
    /// The line after its enumerator.
    text: String,
}

/// An enumerator's style: "(a)" and "a." differ, as do I. and A. A lone I, V or X is
/// a Roman numeral unless letters of that case came first.
fn enumerator_style(marker: &str, seen: &[(bool, u8)]) -> Option<(bool, u8)> {
    let paren = marker.starts_with('(');
    let body = marker.trim_start_matches('(').trim_end_matches(['.', ')']);
    let roman = |upper: bool| body.chars().all(|c| if upper { "IVXLCDM".contains(c) } else { "ivxlcdm".contains(c) });
    let style = if body.chars().all(|c| c.is_ascii_digit() || c == '.') { 0 }
        else if roman(true) && !(body.len() == 1 && seen.contains(&(paren, 1)) && !seen.contains(&(paren, 3))) { 3 }
        else if roman(false) && !(body.len() == 1 && seen.contains(&(paren, 2)) && !seen.contains(&(paren, 4))) { 4 }
        else if body.chars().count() == 1 && body.chars().all(char::is_uppercase) { 1 }
        else if body.chars().count() == 1 && body.chars().all(char::is_lowercase) { 2 }
        else { return None };
    Some((paren, style))
}

/// Nesting by first appearance: the first enumerator style is level 0, the next new one 1.
fn style_level(seen: &mut Vec<(bool, u8)>, style: (bool, u8)) -> usize {
    seen.iter().position(|value| *value == style).unwrap_or_else(|| { seen.push(style); seen.len() - 1 })
}

/// Lays out plain source text one line at a time. The enumerator grammar finds list
/// items; a short title-case or capitalised line without a citation is a heading (the
/// test the PDF parser applies to headings). Levels follow the order enumerator styles
/// first appear in: headings across the document, list items within each list.
#[cfg(feature = "legalpdf")]
pub fn text_layout(text: &str) -> Vec<LayoutLine> {
    let markers = legal_structure::detect_structure_candidate_runs(text).into_iter()
        .flat_map(|run| { let grammar = run.grammar;
            run.markers.into_iter().map(move |marker| (marker.marker_range.start, (grammar, marker))) })
        .collect::<std::collections::HashMap<_, _>>();
    let (mut layout, mut offset) = (Vec::new(), 0);
    let (mut headings, mut items) = (Vec::new(), Vec::new());
    for line in text.split('\n') {
        let start = offset + line.chars().take_while(|c| c.is_whitespace()).count();
        offset += line.chars().count() + 1;
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        let found = markers.get(&start);
        let numeric = matches!(found, Some((legal_structure::CandidateGrammar::Numeric, _)));
        // The grammar's enumerator, or a heading's own ("II. Analysis").
        let length = match found {
            Some((_, marker)) if !numeric => marker.content_start.saturating_sub(start),
            _ => trimmed.split_whitespace().next()
                .filter(|word| enumerator_style(word, &headings).is_some() && word.ends_with(['.', ')'])
                    && trimmed.split_whitespace().nth(1).is_some())
                .map_or(0, |word| word.chars().count()),
        };
        let marker = (length > 0).then(|| trimmed.chars().take(length).collect::<String>().trim().to_owned());
        let body = trimmed.chars().skip(length).collect::<String>().trim().to_owned();
        let (kind, level) = if !numeric && legal_pdf_support::heading_text_plausible(&body) {
            items.clear();
            ("heading", marker.as_deref().and_then(|value| enumerator_style(value, &headings))
                .map_or(0, |style| style_level(&mut headings, style)))
        } else if let Some(style) = marker.as_deref().filter(|_| found.is_some() && !numeric)
            .and_then(|value| enumerator_style(value, &items)) {
            ("list_item", style_level(&mut items, style))
        } else { items.clear(); ("paragraph", 0) };
        // Paragraph numbers ([12], 12.) stay part of the paragraph's own text.
        let (marker, text) = if kind == "paragraph" { (None, trimmed.to_owned()) } else { (marker, body) };
        layout.push(LayoutLine { kind, level, marker, text });
    }
    layout
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    /// "heading" or "section".
    kind: &'static str,
    /// Headings nest by their own hierarchy; a section sits under the heading before it.
    level: usize,
    title: String,
    /// The node's start in the document's query text.
    start: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_index: Option<usize>,
}

/// A section label as a reader cites it: "sec33.1" is "s 33.1", "part2" "Part 2".
fn section_title(label: &str) -> String {
    for (prefix, name) in [("sec", "s "), ("part", "Part "), ("sched", "Schedule "),
        ("art", "Art "), ("ann", "Annex "), ("app", "Appendix ")] {
        if let Some(rest) = label.strip_prefix(prefix).filter(|rest| !rest.is_empty()) {
            return format!("{name}{rest}");
        }
    }
    label.to_owned()
}

fn outline_entries(structure: &DocumentStructure, sections: bool) -> Vec<OutlineEntry> {
    use legal_structure::NodeKind;
    let nodes = structure.nodes.iter().map(|node| (node.id.as_str(), node))
        .collect::<std::collections::HashMap<_, _>>();
    let depth = |node: &legal_structure::StructureNode, kind: NodeKind| {
        let (mut level, mut parent) = (0, node.parent_id.as_deref());
        while let Some(found) = parent.and_then(|id| nodes.get(id)).filter(|_| level < 16) {
            if found.kind == kind { level += 1; }
            parent = found.parent_id.as_deref();
        }
        level
    };
    structure.nodes.iter().filter_map(|node| {
        let start = node.rendered_range.unwrap_or(node.range).start;
        let page_index = node.page_indexes.first().copied();
        let label = node.label.as_deref()?.split_whitespace().collect::<Vec<_>>().join(" ");
        match node.kind {
            NodeKind::Heading if !label.is_empty() && label.chars().count() <= 200 =>
                Some(OutlineEntry { kind: "heading", level: depth(node, NodeKind::Heading),
                    title: label, start, page_index }),
            NodeKind::Section if sections && depth(node, NodeKind::Section) == 0 => Some(OutlineEntry {
                kind: "section", level: 0, title: section_title(&label), start, page_index }),
            _ => None,
        }
    }).collect()
}

/// The document's own outline: its headings and its top-level sections, in order.
/// A PDF's numbered sections come from the instrument grammar, and only for
/// legislation whose sections each appear once, in order: a contents list or a
/// second language repeats them, and a judgment's numbers are not sections.
pub fn document_outline(document: &NativeDocument, legislation: bool) -> Vec<OutlineEntry> {
    let structure = document.structure();
    let pdf = !matches!(document.product, NativeProduct::Structure(_));
    let mut entries = outline_entries(structure, !pdf);
    if pdf && legislation {
        let instrument = analyze_instrument(structure.query_text().to_owned(), structure.document_id.clone(),
            &[], false).ok();
        let sections = instrument.as_ref().map(|instrument| outline_entries(instrument, true)).unwrap_or_default()
            .into_iter().filter(|entry| entry.kind == "section").collect::<Vec<_>>();
        let number = |title: &str| title.strip_prefix("s ")
            .and_then(|rest| rest.split('.').next()?.parse::<u32>().ok());
        let ordered = !sections.is_empty() && sections.windows(2).all(|pair|
            matches!((number(&pair[0].title), number(&pair[1].title)), (Some(a), Some(b)) if a < b
                || a == b && pair[0].title < pair[1].title));
        if ordered {
            let pages = structure.nodes.iter().filter(|node| node.kind == legal_structure::NodeKind::Page)
                .map(|node| (node.rendered_range.unwrap_or(node.range), node.page_indexes.first().copied()))
                .collect::<Vec<_>>();
            entries.extend(sections.into_iter().map(|entry| OutlineEntry {
                page_index: pages.iter().find(|(range, _)| range.start <= entry.start && entry.start < range.end)
                    .and_then(|(_, page)| *page), ..entry }));
        }
    }
    // A title printed atop every page is a running head, not a heading of the text.
    let mut counts = std::collections::HashMap::<String, usize>::new();
    for entry in entries.iter().filter(|entry| entry.kind == "heading") {
        *counts.entry(entry.title.to_lowercase()).or_default() += 1;
    }
    entries.retain(|entry| entry.kind != "heading" || counts[&entry.title.to_lowercase()] < 3);
    entries.sort_by_key(|entry| entry.start);
    let mut heading = None;
    for entry in &mut entries {
        if entry.kind == "heading" { heading = Some(entry.level); }
        else { entry.level = heading.map_or(0, |level| level + 1); }
    }
    entries
}

pub fn document_table_cells(document: &NativeDocument) -> impl Serialize + '_ {
    document.query.table_cells(document.structure())
}

pub fn citation_lookup_key_of(text: &str) -> String {
    citation_lookup_key(text)
}

pub fn document_reading_order(request: &str) -> Result<Vec<(usize, usize)>, String> {
    let units = serde_json::from_str::<Vec<legal_structure::ReadingOrderUnit>>(request)
        .map_err(|error| error.to_string())?;
    Ok(legal_structure::document_reading_order(&units))
}

pub fn citation_engine_call(method: &str, request: &str) -> Result<serde_json::Value, String> {
    let request = serde_json::from_str(request).map_err(|error| error.to_string())?;
    legal_structure::citations::api::call_value(method, request).map_err(|error| error.to_string())
}

pub fn citation_lookup_keys(texts: &[String]) -> Vec<String> {
    texts.iter().map(|text| citation_lookup_key(text)).collect()
}

pub fn provider_citations(text: &str) -> impl Serialize + '_ {
    provider_citations_in_text(text)
}

pub fn citation_occurrences(text: &str) -> impl Serialize {
    citation_occurrences_in_text(text)
}

pub fn authority_references(text: &str) -> impl Serialize {
    authority_references_in_text(text)
}

pub fn caselaw_lookup_key(text: &str) -> CoreResult<String> {
    caselaw_citation_lookup_key(text).map_err(|error| error.to_string())
}

pub fn has_citation(text: &str) -> CoreResult<bool> {
    has_citation_in_text(text).map_err(|error| error.to_string())
}

pub fn citator_excerpt(text: &str) -> impl Serialize {
    classify_citator_excerpt(text)
}

pub fn citator_excerpts(texts: &[String]) -> impl Serialize {
    texts
        .iter()
        .map(|text| classify_citator_excerpt(text))
        .collect::<Vec<_>>()
}

pub fn prose_errors(
    text: &str,
    cited_evidence_ids: &[String],
    visible_evidence: serde_json::Value,
) -> CoreResult<Vec<String>> {
    let visible: Vec<VisibleEvidenceText> =
        serde_json::from_value(visible_evidence).map_err(|error| error.to_string())?;
    Ok(grounded_prose_errors(text, cited_evidence_ids, &visible))
}

pub fn quote_repair(claim: &str, spans: &[String]) -> Option<String> {
    quote_repair_suggestion(claim, spans)
}

pub fn quote_spans(text: &str) -> impl Serialize {
    marked_quote_spans(text)
}

pub fn read_document_range<'a>(
    document: &'a NativeDocument,
    kind: &str,
    from: &str,
    to: &str,
    context_blocks: u32,
) -> CoreResult<impl Serialize + 'a> {
    Ok(document.query.read_range(
        document.structure(),
        document_kind(kind)?,
        from,
        to,
        context_blocks as usize,
    ))
}

pub fn smallest_containing_document_block(
    document: &NativeDocument,
    start: u32,
    end: u32,
) -> impl Serialize + '_ {
    document
        .query
        .smallest_containing_block(document.structure(), start as usize, end as usize)
}

pub fn document_text_fragment_plan(
    document: &NativeDocument,
    block_text: &str,
    quotes: &[String],
    pdf: bool,
    publisher_may_annotate_legal_reference: bool,
    split_html_source_blocks: bool,
) -> impl Serialize {
    document.query.text_fragment_plan(
        document.structure(),
        block_text,
        quotes,
        pdf,
        publisher_may_annotate_legal_reference,
        split_html_source_blocks,
    )
}

pub fn text_fragment_plan_standalone(
    block_text: &str,
    quotes: &[String],
    pdf: bool,
    publisher_may_annotate_legal_reference: bool,
    split_html_source_blocks: bool,
) -> impl Serialize {
    text_fragment_plan(
        block_text,
        None,
        quotes,
        pdf,
        publisher_may_annotate_legal_reference,
        split_html_source_blocks,
    )
}

pub fn document_paragraph_range_directive(
    document: &NativeDocument,
    start: &str,
    end: &str,
) -> Option<String> {
    document
        .query
        .paragraph_range_directive(document.structure(), start, end)
}

pub fn lookup_structure_block<'a>(
    document: &'a NativeDocument,
    locator: &str,
    context_blocks: u32,
) -> impl Serialize + 'a {
    document
        .query
        .structure_block(document.structure(), locator, context_blocks as usize)
}

pub fn resolve_document_address_spans<'a>(
    document: &'a NativeDocument,
    spec: &str,
    follow: &str,
    depth: u32,
) -> CoreResult<impl Serialize + 'a> {
    Ok(document.query.resolve_address_spans(
        document.structure(),
        spec,
        follow_direction(follow)?,
        depth as usize,
    ))
}

pub fn graph_scope<'a>(
    document: &'a NativeDocument,
    seed_label: &str,
    follow: &str,
    depth: u32,
    include_descendants: bool,
    include_units: bool,
) -> CoreResult<impl Serialize + 'a> {
    let follow = follow_direction(follow)?;
    let structure = document.structure();
    Ok(structure
        .cross_references
        .as_ref()
        .filter(|graph| !graph.document_abstained)
        .and_then(|graph| {
            document.query.graph_scope(
                structure,
                graph,
                seed_label,
                follow,
                depth as usize,
                include_descendants,
                include_units,
            )
        }))
}

pub fn document_has_origin(document: &NativeDocument, origin: &str) -> CoreResult<bool> {
    let origin = match origin {
        "native" => DocumentOrigin::Native,
        "heuristic" => DocumentOrigin::Heuristic,
        _ => return Err("invalid document origin".to_owned()),
    };
    Ok(document.query.has_origin(document.structure(), origin))
}

#[cfg(feature = "legalpdf")]
pub use pdf::*;

#[cfg(feature = "legalpdf")]
mod pdf {
    use super::*;
    use std::collections::HashSet;

    fn pdf_of<'a>(document: &'a NativeDocument, message: &str) -> CoreResult<&'a legalpdf::PdfDocument> {
        match &document.product {
            NativeProduct::Pdf(document) => Ok(document),
            _ => Err(message.to_owned()),
        }
    }

    fn docx_supra_bytes(bytes: &[u8]) -> CoreResult<&[u8]> {
        if bytes.is_empty() || bytes.len() > legalpdf::MAX_DOCX_SUPRA_BYTES {
            return Err("DOCX is empty or exceeds the read limit".to_owned());
        }
        Ok(bytes)
    }

    pub fn check_docx_supra_bytes(bytes: &[u8]) -> CoreResult<()> {
        docx_supra_bytes(bytes).map(|_| ())
    }

    pub fn fix_docx_supra_cross_references(bytes: &[u8]) -> CoreResult<legalpdf::DocxSupraCleanup> {
        legalpdf::fix_docx_supra_cross_references(docx_supra_bytes(bytes)?)
            .map_err(|error| error.to_string())
    }

    pub fn has_docx_supra_references(bytes: &[u8]) -> CoreResult<bool> {
        legalpdf::has_docx_supra_references(docx_supra_bytes(bytes)?)
            .map_err(|error| error.to_string())
    }

    pub fn derive_docx_document(bytes: &[u8], id: String, drafting: bool) -> CoreResult<NativeDocument> {
        let structure = if drafting {
            legalpdf::analyze_docx_drafting_bytes(bytes, id)
        } else {
            legalpdf::analyze_docx_bytes(bytes, id)
        }
        .map_err(|error| error.to_string())?;
        Ok(NativeDocument::new(NativeProduct::Structure(structure)))
    }

    pub fn docx_text(bytes: &[u8], drafting: bool, limit: Option<u32>) -> CoreResult<String> {
        let mut text = legalpdf::docx_text(bytes, drafting).map_err(|error| error.to_string())?;
        if let Some(limit) = limit {
            let end = utf16_prefix_ceil(&text, limit as usize).len();
            text.truncate(end);
        }
        Ok(text)
    }

    pub fn docx_authority_text_units(bytes: &[u8]) -> CoreResult<Vec<serde_json::Value>> {
        legalpdf::docx_to_toa_text_units(bytes).map_err(|error| error.to_string())
    }

    pub fn derive_pdf_document(bytes: &[u8], request: &legalpdf::PdfRequest) -> CoreResult<NativeDocument> {
        legalpdf::derive_pdf_document(bytes, request)
            .map(|document| NativeDocument::new(NativeProduct::Pdf(document)))
            .map_err(|error| error.to_string())
    }

    pub fn prepare_pdf_document(bytes: &[u8], request: &legalpdf::PdfRequest) -> CoreResult<legalpdf::PdfSummary> {
        legalpdf::prepare_pdf_document(bytes, request).map_err(|error| error.to_string())
    }

    pub fn restore_pdf_document(request: &legalpdf::PdfRequest) -> CoreResult<Option<NativeDocument>> {
        legalpdf::restore_pdf_document(request)
            .map(|document| document.map(|document| NativeDocument::new(NativeProduct::Pdf(document))))
            .map_err(|error| error.to_string())
    }

    pub fn pdf_document_summary(document: &NativeDocument) -> CoreResult<&legalpdf::PdfSummary> {
        Ok(legalpdf::pdf_document_summary(pdf_of(document, "PDF summary requires a PDF document")?))
    }

    pub fn pdf_recognized_text(
        document: &NativeDocument,
        pages: Option<Vec<u32>>,
    ) -> CoreResult<impl Serialize + '_> {
        let document = pdf_of(document, "PDF text geometry requires a PDF document")?;
        if let Some(pages) = &pages {
            if pages.is_empty() || pages.len() > 16 || pages.contains(&0) {
                return Err("Request between 1 and 16 PDF text pages".to_owned());
            }
        }
        // Filter before serializing: a viewport read must not copy the whole scan into JS.
        Ok(document.has_recognized_geometry().then(|| {
            document.recognized_pages().iter()
                .filter(|page| pages.as_ref().is_none_or(|pages| pages.contains(&page.page_number)))
                .collect::<Vec<_>>()
        }))
    }

    pub fn pdf_page_labels(document: &NativeDocument) -> CoreResult<Vec<Option<String>>> {
        let document = pdf_of(document, "PDF page labels require a PDF document")?;
        let mut labels = vec![None; document.summary().page_count];
        for node in &document.structure().nodes {
            if node.kind != legal_structure::NodeKind::Page {
                continue;
            }
            if let (Some(index), Some(label)) = (
                node.page_indexes.first(),
                node.aliases.as_ref().and_then(|aliases| aliases.first()),
            ) {
                if let Some(slot) = labels.get_mut(*index) {
                    *slot = Some(label.clone());
                }
            }
        }
        Ok(labels)
    }

    pub fn pdf_authority_text_units(document: &NativeDocument) -> CoreResult<impl Serialize + '_> {
        Ok(pdf_of(document, "PDF authority text units require a PDF document")?.authority_text_units())
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PassageTarget {
        id: String,
        #[serde(default)]
        physical_pages: Option<Vec<u32>>,
        locator_kind: String,
        locator: String,
    }

    struct PassagePlan {
        id: String,
        page: bool,
        status: legalpdf::PdfLookupStatus,
        pages: Vec<u32>,
        lines: Vec<String>,
        paragraph: Option<String>,
    }

    // Printed paragraph numbers are addresses, not structural ordinal positions.
    // Split on the actual native lines: a prose node can contain several numbered
    // paragraphs, and one printed paragraph can contain several prose nodes.
    // Parallel-language columns print one paragraph number per column. A line
    // belongs to the column holding its centre, which mirrored margins preserve.
    fn in_column(column: [f64; 4], line: [f64; 4]) -> bool {
        let centre = (line[0] + line[2]) / 2.0;
        centre > column[0] && centre < column[2]
    }

    fn printed_paragraph_plan<'a>(
        lines: &[(&'a str, &'a str, u32, [f64; 4])],
        paragraphs: &[Vec<String>],
        locator: &str,
    ) -> Option<(legalpdf::PdfLookupStatus, HashSet<&'a str>)> {
        use legalpdf::PdfLookupStatus as Status;
        let labels = lines.iter().enumerate().filter_map(|(index, (_, text, ..))| {
            let (number, rest) = text.trim_start().strip_prefix('[')?.split_once(']')?;
            if (!rest.is_empty() && !rest.starts_with(char::is_whitespace)) ||
                !number.chars().all(|c| c.is_ascii_digit()) { return None; }
            Some((number.parse::<usize>().ok()?, index))
        }).collect::<Vec<_>>();
        if labels.is_empty() { return None; }
        let range = legal_pdf_support::numeric_range("paragraph", locator)
            .or_else(|| legal_pdf_support::parse_ordinal("paragraph", locator).map(|n| (n, n)));
        let Some((from, to)) = range.filter(|(a, b)| a <= b && b - a < 100) else {
            return Some((Status::Invalid, HashSet::new()));
        };
        let mut selected = HashSet::new();
        for number in from..=to {
            let hits = labels.iter().filter(|(label, _)| *label == number)
                .map(|(_, index)| *index).collect::<Vec<_>>();
            // The same number printed once per column is one address, not two
            // paragraphs; a repeat in the same column or on another page is not.
            if hits.is_empty() || hits.iter().any(|&hit| hits.iter().any(|&other| other != hit &&
                (lines[other].2 != lines[hit].2 || in_column(lines[hit].3, lines[other].3)))) {
                return Some((if hits.is_empty() { Status::NotFound } else { Status::Ambiguous }, HashSet::new()));
            }
            for start in hits {
                // A detached number and the first line of its text share a row;
                // the column is both. A parallel translation never shares a row.
                let mut column = lines[start].3;
                if let Some(next) = lines.get(start + 1).filter(|next| next.2 == lines[start].2
                    && next.3[1] < column[3] && column[1] < next.3[3]) {
                    column = [column[0].min(next.3[0]), column[1], column[2].max(next.3[2]), column[3]];
                }
                if let Some((_, end)) = labels.iter()
                    .find(|(_, index)| *index > start && in_column(column, lines[*index].3)) {
                    selected.extend(lines[start..*end].iter()
                        .filter(|line| in_column(column, line.3)).map(|(id, ..)| *id));
                } else {
                    // At EOF use the native owner, not unbounded end matter.
                    let owner = paragraphs.iter().find(|ids| ids.iter().any(|id| id == lines[start].0));
                    selected.extend(lines[start..].iter().filter(|(id, ..)|
                        owner.is_some_and(|ids| ids.iter().any(|value| value == id))).map(|(id, ..)| *id));
                }
            }
        }
        Some((Status::Found, selected))
    }

    // Detached paragraph labels sit outside the body, unlike reporter page
    // numbers. Their aligned body rows bound both columns in parallel text.
    // Use these native witnesses even when the structure profile has no prose
    // nodes; a structural ordinal is not a substitute for a printed address.
    fn marginal_paragraph_plan<'a>(
        pages: &'a [legal_pdf_support::PdfTextPage],
        locator: &str,
    ) -> Option<(legalpdf::PdfLookupStatus, HashSet<&'a str>)> {
        use legalpdf::PdfLookupStatus as Status;
        let body_bounds = pages.iter().map(|page| {
            page.lines.iter().filter(|line| line.rect[2] - line.rect[0] > page.width * 0.20
                && line.text.chars().any(char::is_alphabetic))
                .map(|line| line.rect).reduce(|a, b| [a[0].min(b[0]), a[1].min(b[1]),
                    a[2].max(b[2]), a[3].max(b[3])])
        }).collect::<Vec<_>>();
        let mut labels = Vec::new();
        for (page_index, page) in pages.iter().enumerate() {
            let Some(bounds) = body_bounds[page_index] else { continue };
            for line in &page.lines {
                let text = line.text.trim();
                let text = text.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(text);
                if text.is_empty() || text.len() > 5 || !text.bytes().all(|b| b.is_ascii_digit()) {
                    continue;
                }
                let height = line.rect[3] - line.rect[1];
                let gap = (bounds[0] - line.rect[2]).max(line.rect[0] - bounds[2]);
                if gap < height * 0.5 || gap > height * 8.0 { continue; }
                let row = page.lines.iter().filter(|peer|
                    peer.rect[2] - peer.rect[0] > page.width * 0.20
                    && peer.text.chars().any(char::is_alphabetic)
                    && (peer.rect[1] - line.rect[1]).abs() <= height * 0.6)
                    .map(|peer| peer.rect[1]).min_by(f64::total_cmp);
                if let Some(y) = row {
                    labels.push((text.parse::<usize>().ok()?, page_index, y));
                }
            }
        }
        labels.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.total_cmp(&b.2)));
        // One isolated margin number could be a note. Require a numbering run.
        if !labels.windows(3).any(|w| w[0].0 + 1 == w[1].0 && w[1].0 + 1 == w[2].0) {
            return None;
        }
        let range = legal_pdf_support::numeric_range("paragraph", locator)
            .or_else(|| legal_pdf_support::parse_ordinal("paragraph", locator).map(|n| (n, n)));
        let Some((from, to)) = range.filter(|(a, b)| a <= b && b - a < 100) else {
            return Some((Status::Invalid, HashSet::new()));
        };
        let mut selected = HashSet::new();
        for number in from..=to {
            let hits = labels.iter().enumerate().filter(|(_, label)| label.0 == number)
                .map(|(index, _)| index).collect::<Vec<_>>();
            if hits.len() != 1 {
                return Some((if hits.is_empty() { Status::NotFound } else { Status::Ambiguous }, HashSet::new()));
            }
            let (_, start_page, start_y) = labels[hits[0]];
            let Some(&(_, end_page, end_y)) = labels.get(hits[0] + 1).filter(|next| next.0 == number + 1) else {
                // No witnessed end: do not sweep in end matter or a numbering restart.
                return Some((Status::Unavailable, HashSet::new()));
            };
            for page_index in start_page..=end_page {
                let Some(bounds) = body_bounds[page_index] else {
                    return Some((Status::Unavailable, HashSet::new()));
                };
                let top = if page_index == start_page { start_y - 0.5 } else { bounds[1] };
                let bottom = if page_index == end_page { end_y - 0.5 } else { bounds[3] };
                let lines = pages[page_index].lines.iter().filter(|line|
                    line.rect[0] >= bounds[0] - 0.5 && line.rect[2] <= bounds[2] + 0.5
                    && line.rect[1] >= top && line.rect[1] < bottom).collect::<Vec<_>>();
                // A separated heading immediately before the next numbered
                // paragraph belongs to that following section, not this passage.
                let heading_top = (page_index == end_page).then(|| lines.iter().filter(|line| {
                    let Some((prefix, text)) = line.text.trim().split_once(". ") else { return false };
                    if legal_pdf_support::enumerator_interpretations(prefix, ".").is_empty()
                        || !legal_pdf_support::heading_text_plausible(text) { return false; }
                    let height = line.rect[3] - line.rect[1];
                    let prior_bottom = lines.iter().filter(|prior| prior.rect[3] < line.rect[1])
                        .map(|prior| prior.rect[3]).max_by(f64::total_cmp);
                    prior_bottom.is_some_and(|y| line.rect[1] - y > height * 0.5)
                        && end_y - line.rect[3] > height * 0.5
                }).map(|line| line.rect[1]).min_by(f64::total_cmp)).flatten();
                selected.extend(lines.iter().filter(|line|
                    heading_top.is_none_or(|y| line.rect[1] < y - 0.5)).map(|line| line.id.as_str()));
            }
        }
        Some((Status::Found, selected))
    }

    /// "[12]", "(12)", "12." or "12)": a printed paragraph number; a margin
    /// number may also stand bare.
    fn printed_label_number(text: &str, bare: bool) -> Option<usize> {
        let text = text.trim();
        let digits = text.strip_prefix('[').and_then(|rest| rest.strip_suffix(']'))
            .or_else(|| text.strip_prefix('(').and_then(|rest| rest.strip_suffix(')')))
            .or_else(|| text.strip_suffix(['.', ')']))
            .or(bare.then_some(text))?.trim();
        (!digits.is_empty() && digits.len() <= 5 && digits.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| digits.parse().ok()).flatten()
    }

    /// Whether the cited paragraph numbers are printed on the passage: each
    /// endpoint opens one of its lines, or stands in the margin beside one.
    fn printed_paragraph_witnessed<'a>(
        pages: impl Iterator<Item = &'a legal_pdf_support::PdfTextPage>,
        selected: &HashSet<&str>,
        locator: &str,
    ) -> bool {
        let Some((from, to)) = legal_pdf_support::numeric_range("paragraph", locator)
            .or_else(|| legal_pdf_support::parse_ordinal("paragraph", locator).map(|n| (n, n)))
        else { return false };
        let mut missing = HashSet::from([from, to]);
        for page in pages {
            let lines = page.lines.iter().filter(|line| selected.contains(line.id.as_str()))
                .collect::<Vec<_>>();
            for line in &lines {
                // A label opens the line: "[12] Text", "12. Text" or "(12) Text".
                let opening = line.words.first().map(|word| word.text.as_str()).unwrap_or_default();
                let opening = if opening == "[" || opening == "(" {
                    line.words.iter().take(3).map(|word| word.text.as_str()).collect::<String>()
                } else { opening.to_owned() };
                if let Some(number) = printed_label_number(&opening, false) { missing.remove(&number); }
            }
            for word in page.lines.iter().flat_map(|line| &line.words) {
                let Some(number) = printed_label_number(&word.text, true).filter(|n| missing.contains(n)) else { continue };
                let [left, top, right, bottom] = word.rect;
                if top <= page.height * 0.05 || bottom >= page.height * 0.95 { continue; }
                if lines.iter().any(|line| {
                    let [text_left, text_top, text_right, text_bottom] = line.rect;
                    let overlap = bottom.min(text_bottom) - top.max(text_top);
                    let gap = if right <= text_left { text_left - right }
                        else if left >= text_right { left - text_right } else { -1.0 };
                    (0.0..=80.0).contains(&gap)
                        && overlap >= 0.45 * (bottom - top).min(text_bottom - text_top)
                }) { missing.remove(&number); }
            }
        }
        missing.is_empty()
    }

    /// Passage planning and geometry share the prepared extraction witnesses.
    pub struct PdfPassagePagesJob {
        summary: legalpdf::PdfSummary,
        pages: std::sync::Arc<Vec<legal_pdf_support::PdfTextPage>>,
        plans: Vec<PassagePlan>,
        paragraphs: Vec<Vec<String>>,
    }

    pub fn pdf_passage_pages_job(
        native: &NativeDocument,
        targets: Vec<PassageTarget>,
    ) -> CoreResult<PdfPassagePagesJob> {
        let document = pdf_of(native, "PDF passage geometry requires a PDF document")?;
        let plans = targets
            .into_iter()
            .map(|target| {
                let lookup = document.lookup(&legalpdf::PdfLookupRequest::new(
                    &target.locator_kind,
                    &target.locator,
                ));
                let mut lines: Vec<String> = lookup
                    .matches
                    .iter()
                    .filter_map(|id| {
                        document
                            .structure()
                            .nodes
                            .iter()
                            .find(|node| &node.id == id)
                    })
                    .flat_map(|node| node.line_ids.iter().cloned())
                    .collect();
                let mut pages = lookup
                    .units
                    .iter()
                    .flat_map(|unit| unit.page_numbers.iter().copied())
                    .collect::<Vec<_>>();
                let mut status = lookup.status;
                if target.locator_kind == "page" {
                    if let Some(physical) = target.physical_pages {
                        pages = physical.into_iter().filter(|page| *page > 0 &&
                            (*page as usize) <= document.page_count()).collect();
                        lines.clear();
                        status = if pages.is_empty() { legalpdf::PdfLookupStatus::NotFound }
                            else { legalpdf::PdfLookupStatus::Found };
                    }
                }
                PassagePlan {
                    id: target.id,
                    page: target.locator_kind == "page",
                    status,
                    pages,
                    lines,
                    paragraph: (target.locator_kind == "paragraph").then_some(target.locator),
                }
            })
            .collect();
        Ok(PdfPassagePagesJob {
            summary: document.summary().clone(),
            pages: document.passage_pages(),
            plans,
            paragraphs: document.structure().nodes.iter().filter(|node|
                matches!(node.kind, legal_structure::NodeKind::Prose | legal_structure::NodeKind::Heading))
                .map(|node| node.line_ids.clone()).collect(),
        })
    }

    impl PdfPassagePagesJob {
        pub fn compute(self) -> CoreResult<serde_json::Value> {
            let unavailable = self.summary.pages_needing_ocr.iter().copied()
                .chain(self.summary.ocr_routed_pages.iter().copied()).collect::<HashSet<_>>();
            let prose_ids = self.paragraphs.iter().flatten().map(String::as_str).collect::<HashSet<_>>();
            let prose_lines = self.pages.iter().flat_map(|page| page.lines.iter()
                .filter(|line| prose_ids.contains(line.id.as_str()))
                .map(|line| (line.id.as_str(), line.text.as_str(), page.page_number, line.rect)))
                .collect::<Vec<_>>();
            let targets = self
                .plans
                .into_iter()
                .map(|plan| {
                    let printed = plan.paragraph.as_ref().and_then(|locator|
                        marginal_paragraph_plan(&self.pages, locator).or_else(||
                            printed_paragraph_plan(&prose_lines, &self.paragraphs, locator)));
                    let structural = printed.is_none();
                    let (status, selected) = printed.unwrap_or_else(|| (plan.status,
                        plan.lines.iter().map(String::as_str).collect::<HashSet<_>>()));
                    let selected_pages = self
                        .pages
                        .iter()
                        .filter(|page| {
                            page.lines
                                .iter()
                                .any(|line| selected.contains(line.id.as_str()))
                        })
                        .map(|page| page.page_number)
                        .collect::<HashSet<_>>();
                    let pages = self
                        .pages
                        .iter()
                        .filter(|page| {
                            (structural && plan.pages.contains(&page.page_number))
                                || selected_pages.contains(&page.page_number)
                        })
                        .map(|page| {
                            let available =
                                page.source == "native" && !unavailable.contains(&((page.page_number - 1) as usize));
                            let lines = page
                                .lines
                                .iter()
                                .filter(|line| {
                                    (plan.page && selected.is_empty())
                                        || selected.contains(line.id.as_str())
                                })
                                .collect::<Vec<_>>();
                            serde_json::json!({
                                "pageNumber": page.page_number,
                                "width": page.width,
                                "height": page.height,
                                "source": if available { "native" } else { "unavailable" },
                                "lines": if available { lines.iter().map(|line| serde_json::json!({
                                    "id": line.id,
                                    "rect": line.rect,
                                    "words": line.words.iter().map(|word| serde_json::json!({
                                        "text": word.text, "rect": word.rect
                                    })).collect::<Vec<_>>()
                                })).collect::<Vec<_>>() } else { Vec::new() }
                            })
                        })
                        .collect::<Vec<_>>();
                    let mut target = serde_json::json!({ "id": plan.id, "status": status, "pages": pages });
                    if let Some(locator) = &plan.paragraph {
                        let pages = self.pages.iter().filter(|page| page.source == "native"
                            && !unavailable.contains(&((page.page_number - 1) as usize))
                            && (structural && plan.pages.contains(&page.page_number)
                                || selected_pages.contains(&page.page_number)));
                        target["printed"] = printed_paragraph_witnessed(pages, &selected, locator).into();
                    }
                    target
                })
                .collect::<Vec<_>>();
            Ok(serde_json::json!({
                "schemaVersion": "legalpdf.passage-pages.v1",
                "sourceSha256": self.summary.sha256,
                "parserVersion": self.summary.parser_version,
                "coordinateSpace": "visible_crop_box",
                "coordinateOrigin": "top_left",
                "rotationApplied": true,
                "targets": targets,
            }))
        }
    }

    pub(crate) fn pdf_lookup_unit_spans_of(
        structure: &DocumentStructure,
        ids: &[String],
    ) -> std::collections::BTreeMap<String, legal_structure::ScalarRange> {
        let nodes: std::collections::HashMap<_, _> = structure
            .nodes
            .iter()
            .filter_map(|node| node.rendered_range.map(|span| (node.id.as_str(), span)))
            .collect();
        let notes: std::collections::HashMap<_, _> = structure
            .notes
            .iter()
            .map(|note| (note.id.as_str(), note.node_id.as_str()))
            .collect();
        ids.iter()
            .filter_map(|id| {
                nodes
                    .get(id.as_str())
                    .or_else(|| notes.get(id.as_str()).and_then(|node| nodes.get(node)))
                    .map(|span| (id.clone(), *span))
            })
            .collect()
    }

    pub fn pdf_lookup_unit_spans(
        document: &NativeDocument,
        ids: &[String],
    ) -> CoreResult<std::collections::BTreeMap<String, legal_structure::ScalarRange>> {
        let pdf = pdf_of(document, "PDF query requires a PDF document")?;
        Ok(pdf_lookup_unit_spans_of(pdf.structure(), ids))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn query_pdf_document(
        document: &NativeDocument,
        locator_kind: String,
        locator: String,
        end_locator: Option<String>,
        context_blocks: Option<u32>,
        page: Option<u32>,
        occurrence: Option<u32>,
    ) -> CoreResult<impl Serialize> {
        let pdf = pdf_of(document, "PDF query requires a PDF document")?;
        Ok(legalpdf::query_pdf_document(
            pdf,
            &legalpdf::PdfLookupRequest {
                locator_kind,
                locator,
                end_locator,
                context_blocks: context_blocks.unwrap_or(0) as usize,
                page,
                occurrence: occurrence.map(|value| value as usize),
            },
        ))
    }
}

#[cfg(all(test, feature = "legalpdf"))]
mod pdf_evidence_tests {
    use super::*;
    use legal_structure::{Derivation, NodeKind, Note, NoteKindV2, ScalarRange, StructureNode};

    #[test]
    fn lookup_spans_preserve_rendered_offsets_and_footnote_identity() {
        let mut structure = analyze_instrument(
            "Repeated\n\nRepeated".to_owned(),
            "pdf".to_owned(),
            &[],
            false,
        )
        .unwrap();
        let span = ScalarRange { start: 10, end: 18 };
        let mut node = StructureNode::new(
            "heading-2".to_owned(),
            NodeKind::Heading,
            ScalarRange { start: 0, end: 8 },
            "native",
            Derivation::Native,
            None,
        );
        node.rendered_range = Some(span);
        structure.nodes = vec![node];
        structure.notes.push(Note {
            id: "pair-2".to_owned(),
            node_id: "heading-2".to_owned(),
            kind: NoteKindV2::Footnote,
            label_range: span,
            body_range: span,
            references: vec![],
            primary_reference: None,
        });
        let spans = pdf_lookup_unit_spans_of(
            &structure,
            &[
                "heading-2".to_owned(),
                "pair-2".to_owned(),
                "missing".to_owned(),
            ],
        );
        assert_eq!(spans.len(), 2);
        assert_eq!(spans["heading-2"], span);
        assert_eq!(spans["pair-2"], span);
    }
}
