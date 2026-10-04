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
    FollowDirection, JournalPageLabel, NativeMarkupInput, OutlineEntry, PrintedStatute,
    ProviderTextInput, VisibleEvidenceText,
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
    /// A PDF's body read by the instrument grammar, once, when a section is asked for.
    instrument: std::sync::OnceLock<Option<PrintedStatute>>,
}

impl NativeDocument {
    fn new(product: NativeProduct) -> Self {
        Self { product, query: DocumentQuery::new(), instrument: std::sync::OnceLock::new() }
    }

    fn instrument(&self) -> Option<&PrintedStatute> {
        self.instrument.get_or_init(|| self.read_instrument()).as_ref()
    }

    #[cfg(feature = "legalpdf")]
    fn read_instrument(&self) -> Option<PrintedStatute> {
        self.read_printed(None)
    }

    /// One instrument of a PDF that prints several, read on its own.
    #[cfg(feature = "legalpdf")]
    fn instrument_within(&self, instrument: &str) -> Option<PrintedStatute> {
        self.read_printed(Some(instrument))
    }

    #[cfg(feature = "legalpdf")]
    fn read_printed(&self, instrument: Option<&str>) -> Option<PrintedStatute> {
        let NativeProduct::Pdf(pdf) = &self.product else { return None };
        let pages = pdf.passage_pages();
        let lines = pages.iter().flat_map(|page| page.lines.iter().map(move |line| (line.id.as_str(),
            legal_structure::PrintedLine { id: &line.id, text: &line.text, rect: line.rect, page: page.page_number })))
            .collect::<std::collections::HashMap<_, _>>();
        match instrument {
            Some(instrument) => PrintedStatute::read_within(pdf.structure(), &lines, pages.len(), instrument),
            None => PrintedStatute::read(pdf.structure(), &lines, pages.len()),
        }
    }

    #[cfg(not(feature = "legalpdf"))]
    fn read_instrument(&self) -> Option<PrintedStatute> {
        None
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

/// A statute's outline from its text: its parts, headings and provisions with their marginal
/// notes, each with its span (UTF-16) covering everything under it.
pub fn statute_outline(text: &str, articles: bool) -> CoreResult<Vec<legal_structure::StatuteOutlineEntry>> {
    legal_structure::statute_outline(text, articles).map_err(native_error)
}

/// A judgment's outline from its text: its headings by level, its numbered paragraphs, the lists
/// within them, and the matter around its reasons, each with its span (UTF-16).
pub fn case_outline(text: &str) -> CoreResult<Vec<legal_structure::CaseOutlineEntry>> {
    legal_structure::case_outline(text).map_err(native_error)
}

/// The document's own outline: its headings and its top-level sections, in order.
/// A PDF's numbered sections come from the reading of its body as a statute, for legislation.
pub fn document_outline(document: &NativeDocument, legislation: bool) -> Vec<OutlineEntry> {
    let pdf = !matches!(document.product, NativeProduct::Structure(_));
    legal_structure::document_outline(document.structure(), pdf,
        document.instrument().filter(|_| pdf && legislation))
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

/// Supplies this engine to the PDF and DOCX parsers, which are built without it so that an
/// engine edit does not recompile them.
pub fn install_structure_analysis() {
    #[cfg(feature = "legalpdf")]
    legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
}

#[cfg(feature = "legalpdf")]
mod pdf {
    use super::*;
    use legal_pdf_support::{marginal_paragraph_plan, printed_paragraph_plan, printed_paragraph_witnessed};
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

    pub fn prepare_pdf_document(
        bytes: &[u8],
        request: &legalpdf::PdfRequest,
        progress: legalpdf::RecognitionProgress<'_>,
    ) -> CoreResult<legalpdf::PdfSummary> {
        legalpdf::prepare_pdf_document_reporting(bytes, request, progress)
            .map_err(|error| error.to_string())
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

    /// Every page's text in page order, as a page lookup returns it, in one read.
    pub fn pdf_page_texts(document: &NativeDocument) -> CoreResult<Vec<&str>> {
        Ok(pdf_of(document, "PDF page text requires a PDF document")?.page_texts())
    }

    /// A provision where the reading of the PDF's body as a statute places it.
    fn instrument_section(
        native: &NativeDocument,
        within: Option<&PrintedStatute>,
        kind: &str,
        locator: &str,
    ) -> Option<(legalpdf::PdfLookupStatus, Vec<String>, Vec<u32>)> {
        use legalpdf::PdfLookupStatus as Status;
        Some(match within.or_else(|| native.instrument())?.provision(native.structure(), kind, locator)? {
            legal_structure::ProvisionPlacement::Found { lines, pages } => (Status::Found, lines, pages),
            legal_structure::ProvisionPlacement::Ambiguous => (Status::Ambiguous, Vec::new(), Vec::new()),
        })
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
        /// The instrument the locator is of, where the PDF prints several ("Canadian Charter of
        /// Rights and Freedoms" in "The Constitution Acts 1867 to 1982").
        #[serde(default)]
        instrument: Option<String>,
    }

    struct PassagePlan {
        id: String,
        page: bool,
        status: legalpdf::PdfLookupStatus,
        pages: Vec<u32>,
        lines: Vec<String>,
        paragraph: Option<String>,
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
        // Each instrument a target names is read on its own, once.
        let mut readings = std::collections::HashMap::<String, Option<PrintedStatute>>::new();
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
                // A statute's provisions are placed by the reading of its body as a statute.
                if legal_structure::PrintedStatute::places(&target.locator_kind) {
                    let within = target.instrument.as_ref().and_then(|instrument| readings.entry(instrument.clone())
                        .or_insert_with(|| native.instrument_within(instrument)).as_ref());
                    if let Some((found, found_lines, found_pages)) = instrument_section(native, within, &target.locator_kind, &target.locator) {
                        (status, lines, pages) = (found, found_lines, found_pages);
                    }
                }
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
            // A scan not yet read has no geometry; a recognized page's lines are its own.
            let unavailable = self.summary.pages_needing_ocr.iter().copied()
                .chain(self.summary.ocr_routed_pages.iter().copied())
                .filter(|index| self.pages.get(*index).is_none_or(|page| page.source == "native"))
                .collect::<HashSet<_>>();
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
                                !unavailable.contains(&((page.page_number - 1) as usize));
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
                        let pages = self.pages.iter().filter(|page| !unavailable.contains(&((page.page_number - 1) as usize))
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
