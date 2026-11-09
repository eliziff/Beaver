//! Target-neutral engine operations. The Node addon (`node.rs`) and the browser
//! WebAssembly module (`wasi.rs`) are thin bindings over these functions.

use legal_structure::{analyze_instrument, analyze_native_markup, authority_references_in_text, citation_lookup_key, citation_occurrences_in_text, document_fingerprint, docx_structure_lint, has_citation_in_text, journal_document_structure, journal_text_document_structure, provider_citations_in_text, provider_text_document_structure, utf16_prefix_ceil, AuthoritativeTableCell, DocumentFingerprint, Derivation, DocumentQuery, DocumentStructure, FollowDirection, JournalPageLabel, NativeMarkupInput, NodeKind, ProviderTextInput};
use legal_structure_features::{grounded_prose_errors, marked_quote_spans, quote_repair_suggestion, OutlineEntry, VisibleEvidenceText};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;

pub type CoreResult<T> = Result<T, String>;

/// A failed call as JavaScript is given it: what went wrong and, for a PDF's parse, the kind of failure the parser
/// named, its message the one a reader is told and its detail what went wrong.
#[derive(Clone, Debug, Serialize)]
pub struct Failure {
    pub message: String,
    #[cfg(feature = "legalpdf")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<legal_pdf_core::FailureKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self { message, #[cfg(feature = "legalpdf")] kind: None, detail: None }
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

#[cfg(feature = "legalpdf")]
impl From<legalpdf::Error> for Failure {
    fn from(error: legalpdf::Error) -> Self {
        let kind = error.kind();
        let detail = match error {
            legalpdf::Error::Failure { detail, .. } => detail,
            error => error.to_string(),
        };
        Self { message: kind.message().to_owned(), kind: Some(kind), detail: Some(detail) }
    }
}

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
    /// A CourtListener opinion read whole: every rendition, the case's citations and its cluster's fields.
    Opinion {
        record: legal_structure::opinion::OpinionRecord,
        url: Option<String>,
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
    /// What locating quotations has read of the document, kept for the quotations located in it after where the
    /// caller asks (`keep`): a quicker check of each later quotation for the memory the readings hold (some 250 MiB
    /// for the Criminal Code).
    quotes: std::sync::Mutex<legal_structure_features::QuoteLocator>,
}

impl NativeDocument {
    pub(crate) fn new(product: NativeProduct) -> Self {
        Self { product, query: DocumentQuery::new(), quotes: Default::default() }
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

fn document_kind(value: &str) -> CoreResult<NodeKind> {
    NodeKind::named(value).ok_or_else(|| "invalid document block kind".to_owned())
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
        StructureRequest::Opinion { record, url } => legal_structure::opinion::opinion_structure(&record, url),
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
    start_char: Option<u32>,
) -> impl Serialize + '_ {
    document.query.text_range_window(
        document.structure(),
        start as usize,
        end as usize,
        offset.map(|value| value as usize),
        limit as usize,
        start_char.map(|value| value as usize),
    )
}

pub fn document_fingerprint_of(document: &NativeDocument) -> DocumentFingerprint {
    match &document.product {
        NativeProduct::Structure(structure) => document_fingerprint(structure),
        #[cfg(feature = "legalpdf")]
        NativeProduct::Pdf(document) => document.fingerprint(),
    }
}

/// The nodes the query serves, in its order, each as a reader takes it (`DocumentStructure::reading`); with `kind`, those
/// it serves as that kind (a paragraph's prose among them); with `end`, those starting before it.
pub fn document_anchors(document: &NativeDocument, kind: Option<String>, end: Option<u32>) -> CoreResult<impl Serialize + '_> {
    let structure = document.structure();
    let kind = kind.as_deref().map(document_kind).transpose()?;
    Ok(document
        .query
        .blocks(structure, kind)
        .map(|node| structure.reading(node))
        .filter(|reading| end.is_none_or(|end| reading.span.start < end as usize))
        .collect::<Vec<_>>())
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
pub fn document_outline(document: &NativeDocument) -> Vec<OutlineEntry> {
    let pdf = !matches!(document.product, NativeProduct::Structure(_));
    legal_structure_features::document_outline(document.structure(), pdf)
}

pub fn document_table_cells(document: &NativeDocument) -> impl Serialize + '_ {
    document.query.table_cells(document.structure())
}

pub fn citation_lookup_key_of(text: &str) -> String {
    citation_lookup_key(text)
}

pub fn document_reading_order(request: &str) -> Result<Vec<(usize, usize)>, String> {
    let units = serde_json::from_str::<Vec<legal_structure_features::ReadingOrderUnit>>(request)
        .map_err(|error| error.to_string())?;
    Ok(legal_structure_features::document_reading_order(&units))
}

/// The pages a text's full citations of reported cases cite ("[1986] 1 SCR 103" cites 103).
pub fn reporter_pages(text: &str) -> Vec<String> {
    use legal_structure::citations::{extract, Authority, Form, Format, Options};
    extract(text, &Options { resolve: false, ..Options::default() }).into_iter()
        .filter(|citation| citation.form == Form::Full && citation.authority == Authority::Case && citation.format == Some(Format::Reporter))
        .filter_map(|citation| citation.fields.page)
        .collect()
}

/// The first pages of the reports `citations` cite, each once: a page map's anchors.
pub fn reporter_start_pages(citations: &[String]) -> Vec<u32> {
    let mut pages: Vec<u32> = citations.iter().flat_map(|citation| reporter_pages(citation))
        .filter_map(|page| page.trim().parse().ok()).filter(|page| *page > 0).collect();
    pages.sort_unstable();
    pages.dedup();
    pages
}

pub fn citation_engine_call(method: &str, request: serde_json::Value) -> Result<serde_json::Value, String> {
    legal_structure::citations::api::call_value(method, request).map_err(|error| error.to_string())
}

/// Each quotation located in a document's text and, with `compare`, compared with it, with what grounded_prose_errors
/// says of the quotation against the passage it was found in (the whole text where it was not), the evidence named by
/// its id.
pub fn quote_locate_document(
    document: &NativeDocument,
    source: legal_structure_features::QuoteSource,
    quotes: &[legal_structure_features::QuoteToLocate],
    compare: bool,
    keep: bool,
) -> CoreResult<Vec<serde_json::Value>> {
    let text = document_text(document, None);
    let blocks = legal_structure_features::document_quote_blocks(document.structure(), &document.query, source);
    let located = if keep {
        legal_structure_features::locate_source_quotes_kept(&mut document.quotes.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
            source, text, &blocks, quotes, compare)
    } else {
        legal_structure_features::locate_source_quotes(source, text, &blocks, quotes, compare)
    };
    Ok(located.into_iter().zip(quotes).map(|(located, item)| {
        if !compare {
            return serde_json::to_value(&located).expect("a located quotation serializes");
        }
        let id = item.id.clone().unwrap_or_default();
        let evidence = if located.found.text.is_empty() { text } else { located.found.text.as_str() };
        let errors = grounded_prose_errors(&format!("\u{201c}{}\u{201d}", item.quote), std::slice::from_ref(&id),
            &[VisibleEvidenceText { evidence_id: id.clone(), text: evidence.to_owned(), labels: Vec::new() }]);
        let mut value = serde_json::to_value(&located).expect("a located quotation serializes");
        value["errors"] = serde_json::json!(errors);
        value
    }).collect())
}

pub fn citation_lookup_keys(texts: &[String]) -> Vec<String> {
    texts.iter().map(|text| citation_lookup_key(text)).collect()
}

/// A citation's exact aliases and authored forms in the A2AJ store's inventory (a2aj.rs alias_groups).
#[derive(Serialize)]
pub struct AliasGroup {
    pub(crate) keys: Vec<String>,
    pub(crate) forms: Vec<String>,
    pub(crate) ambiguous: bool,
}

/// Each citation's own key alone: its aliases where no store is installed, or the engine reads none.
pub fn own_alias_groups(citations: &[String]) -> Vec<AliasGroup> {
    citations.iter().map(|citation| {
        let key = citation_lookup_key(citation);
        AliasGroup { keys: if key.is_empty() { Vec::new() } else { vec![key] }, forms: Vec::new(), ambiguous: false }
    }).collect()
}

/// What the lookup keys are made by: the key version and the alias table, which keys a decision's every citation by
/// one identity, so keys stored under another table are made again.
pub fn citation_key_version() -> String {
    use sha2::{Digest, Sha256};
    let table = Sha256::digest(legal_structure::citations::aliases::COMPILED);
    format!("{}:{}", legal_structure::citations::key::KEY_VERSION, table[..6].iter().map(|byte| format!("{byte:02x}")).collect::<String>())
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

pub fn has_citation(text: &str) -> CoreResult<bool> {
    has_citation_in_text(text).map_err(|error| error.to_string())
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

pub fn lookup_structure_block(
    document: &NativeDocument,
    locator: serde_json::Value,
    context_blocks: u32,
) -> CoreResult<impl Serialize + '_> {
    let selector = match locator {
        serde_json::Value::String(locator) => legal_structure::GraphScopeSeed::Locator(locator),
        value => serde_json::from_value::<legal_structure::GraphScopeSeed>(value)
            .map_err(|error| error.to_string())?,
    };
    Ok(document.query.structure_selection(document.structure(), &selector, context_blocks as usize))
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
    seed: &legal_structure::GraphScopeSeed,
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
                seed,
                follow,
                depth as usize,
                include_descendants,
                include_units,
            )
        }))
}

pub fn document_has_origin(document: &NativeDocument, origin: &str) -> CoreResult<bool> {
    let origin = match origin {
        "native" => Derivation::Native,
        "heuristic" => Derivation::Heuristic,
        _ => return Err("invalid document origin".to_owned()),
    };
    Ok(document.query.has_origin(document.structure(), origin))
}

#[cfg(feature = "docx")]
pub use docx::*;
#[cfg(feature = "legalpdf")]
pub use pdf::*;

/// Supplies this engine to the PDF and DOCX parsers, which are built without it so that an
/// engine edit does not recompile them.
pub fn install_structure_analysis() {
    #[cfg(feature = "docx")]
    legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
}

#[cfg(feature = "docx")]
mod docx {
    use super::*;

    fn docx_supra_bytes(bytes: &[u8]) -> CoreResult<&[u8]> {
        if bytes.is_empty() || bytes.len() > legalpdf::MAX_DOCX_SUPRA_BYTES {
            return Err("DOCX is empty or exceeds the read limit".to_owned());
        }
        Ok(bytes)
    }

    pub fn fix_docx_supra_cross_references(bytes: &[u8]) -> CoreResult<legalpdf::DocxSupraCleanup> {
        legalpdf::fix_docx_supra_cross_references(docx_supra_bytes(bytes)?)
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

    pub fn docx_authority_text_units(bytes: &[u8]) -> CoreResult<impl Serialize> {
        legalpdf::docx_to_toa_text_units(bytes).map_err(|error| error.to_string())
    }
}

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

    pub fn derive_pdf_document(bytes: &[u8], request: &legalpdf::PdfRequest) -> Result<NativeDocument, Failure> {
        Ok(NativeDocument::new(NativeProduct::Pdf(legalpdf::derive_pdf_document(bytes, request)?)))
    }

    pub fn prepare_pdf_document(
        bytes: &[u8],
        request: &legalpdf::PdfRequest,
        progress: legalpdf::RecognitionProgress<'_>,
    ) -> Result<legalpdf::PdfSummary, Failure> {
        Ok(legalpdf::prepare_pdf_document_reporting(bytes, request, progress)?)
    }

    pub fn restore_pdf_document(request: &legalpdf::PdfRequest) -> Result<Option<NativeDocument>, Failure> {
        Ok(legalpdf::restore_pdf_document(request)?.map(|document| NativeDocument::new(NativeProduct::Pdf(document))))
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
        Ok(Some(document.recognized_pages()
            .filter(|page| pages.as_ref().is_none_or(|pages| pages.contains(&page.number)))
            .collect::<Vec<_>>()))
    }

    pub fn pdf_page_labels(document: &NativeDocument) -> CoreResult<Vec<Option<String>>> {
        Ok(pdf_of(document, "PDF page labels require a PDF document")?.page_labels())
    }

    /// The document's page map (`PdfDocument::page_map`), anchored on the first pages of the reports `citations` cite.
    pub fn pdf_page_map(document: &NativeDocument, citations: &[String]) -> CoreResult<Vec<legalpdf::PdfPageBinding>> {
        let starts = super::reporter_start_pages(citations);
        let is_citation = |text: &str, page: &str| super::reporter_pages(text).iter().any(|cited| cited == page);
        Ok(legalpdf::page_map(pdf_of(document, "PDF page maps require a PDF document")?, &starts, &is_citation))
    }

    /// Every page's text in page order, as a page lookup returns it, in one read.
    pub fn pdf_page_texts(document: &NativeDocument) -> CoreResult<Vec<String>> {
        Ok(pdf_of(document, "PDF page text requires a PDF document")?.page_texts())
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
        /// The quotations to place in the passage: each whole, or the part of its text a selection names.
        #[serde(default)]
        exact_quotes: Vec<String>,
        #[serde(default)]
        quote_selections: Vec<QuoteSelection>,
    }

    /// A quotation's text and the part of it (UTF-16) that is placed: its words in their context.
    #[derive(Deserialize)]
    pub struct QuoteSelection {
        text: String,
        start: usize,
        end: usize,
    }

    struct PassagePlan {
        id: String,
        locator_kind: String,
        locator: String,
        page: bool,
        status: legalpdf::PdfLookupStatus,
        pages: Vec<u32>,
        ranges: Vec<legal_structure::ScalarRange>,
        paragraph: Option<String>,
        quotes: Vec<QuoteSelection>,
    }

    /// Words as a quotation's are matched in a passage's: case, width and apostrophe forms folded.
    fn passage_words(text: &str) -> Vec<String> {
        use unicode_normalization::UnicodeNormalization;
        static WORD: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new(r"[\p{L}\p{N}]+(?:['\u{2019}][\p{L}\p{N}]+)*").unwrap());
        let folded = text.nfkc().collect::<String>().to_lowercase();
        WORD.find_iter(&folded).map(|word| word.as_str().replace('\u{2019}', "'")).collect()
    }

    /// A unit of a Word brief whose citations are placed on the pages of a PDF saved from it: whether it is a note, its
    /// text, and its citations, each by its id, its span of the text (UTF-16) and its own text.
    #[derive(Deserialize)]
    pub struct BriefUnit {
        note: bool,
        text: String,
        occurrences: Vec<BriefOccurrence>,
    }

    #[derive(Deserialize)]
    pub struct BriefOccurrence {
        id: String,
        start: usize,
        end: usize,
        text: String,
    }

    /// The page (from 1) of each citation of a Word brief in a PDF saved from it (`pages`, each page's text), by the
    /// citation's id. The brief's words are read in order, its body and its notes each onward from their last match, so a
    /// repeated citation keeps its place: a citation is found with the four words before and after it, then with those
    /// before or those after, from where its stream left off and then from the start; the citation alone is tried last,
    /// and is not read on from, for it also matches the brief's own table of authorities, which lies past every later
    /// citation. A citation that cannot be placed has none.
    pub fn brief_occurrence_pages(pages: &[String], units: &[BriefUnit]) -> std::collections::BTreeMap<String, u32> {
        let words: Vec<(String, u32)> = pages.iter().enumerate()
            .flat_map(|(at, text)| passage_words(text).into_iter().map(move |word| (word, at as u32 + 1))).collect();
        let mut positions = std::collections::HashMap::<&str, Vec<usize>>::new();
        for (at, (word, _)) in words.iter().enumerate() {
            positions.entry(word.as_str()).or_default().push(at);
        }
        let find = |needle: &[String], from: usize| positions.get(needle.first()?.as_str())?.iter().copied()
            .find(|&at| at >= from && needle.iter().enumerate().all(|(offset, word)| words.get(at + offset).is_some_and(|(read, _)| read == word)));
        let mut cursors = [0usize; 2];
        let mut placed = std::collections::BTreeMap::new();
        for unit in units {
            let text = legal_structure::ScalarText::new(&unit.text);
            let stream = usize::from(unit.note);
            for occurrence in &unit.occurrences {
                let before = passage_words(text.slice_utf16(0..occurrence.start).unwrap_or(""));
                let before = before[before.len().saturating_sub(4)..].to_vec();
                let core = passage_words(&occurrence.text);
                let after = passage_words(text.slice_utf16(occurrence.end..text.utf16_len()).unwrap_or(""))
                    .into_iter().take(4).collect::<Vec<_>>();
                let cursor = cursors[stream];
                let contexts = [([&before[..], &core[..], &after[..]].concat(), before.len()), ([&before[..], &core[..]].concat(), before.len()),
                    ([&core[..], &after[..]].concat(), 0)];
                let attempts = contexts.iter().map(|(needle, skip)| (needle, *skip, cursor, false))
                    .chain(contexts.iter().map(|(needle, skip)| (needle, *skip, 0, false)))
                    .chain([(&core, 0, cursor, true)]);
                for (needle, skip, from, alone) in attempts {
                    let Some(at) = (needle.len() > 1).then(|| find(needle, from)).flatten() else { continue };
                    placed.insert(occurrence.id.clone(), words[at + skip].1);
                    if !alone {
                        cursors[stream] = at + needle.len();
                    }
                    break;
                }
            }
        }
        placed
    }

    /// Where a quotation stands in a passage's pages (`pages`, as the passage gives them), its words read once in its
    /// context and found once among the passage's words in order, a page apart at most: its rectangle on each line it
    /// crosses, page by page. A passage not found, or a quotation found other than once, places none.
    fn quote_geometry(pages: &[serde_json::Value], status: legalpdf::PdfLookupStatus, quote: &QuoteSelection) -> serde_json::Value {
        use legalpdf::PdfLookupStatus as Status;
        let context = legal_structure::ScalarText::new(&quote.text);
        let slice = |start: usize, end: usize| context.slice_utf16(start..end).unwrap_or("");
        let text = slice(quote.start, quote.end);
        let none = |status: Status| serde_json::json!({ "text": text, "status": status, "rects": [] });
        if status != Status::Found {
            return none(status);
        }
        let needle = passage_words(&quote.text);
        if needle.len() < 2 {
            return none(Status::Invalid);
        }
        let (before, selected) = (passage_words(slice(0, quote.start)), passage_words(text));
        let after = passage_words(slice(quote.end, context.utf16_len()));
        if selected.is_empty() || [&before[..], &selected[..], &after[..]].concat() != needle {
            return none(Status::Invalid);
        }
        let mut words = Vec::new();
        for page in pages.iter().filter(|page| page["source"] == "native") {
            let number = page["pageNumber"].as_u64().unwrap_or(0);
            for line in page["lines"].as_array().into_iter().flatten() {
                for word in line["words"].as_array().into_iter().flatten() {
                    for value in passage_words(word["text"].as_str().unwrap_or("")) {
                        words.push((value, number, line["id"].as_str().unwrap_or(""), &word["rect"]));
                    }
                }
            }
        }
        let hits = (0..words.len()).filter(|&start| needle.iter().enumerate().all(|(offset, value)| {
            words.get(start + offset).is_some_and(|current: &(String, u64, &str, &serde_json::Value)|
                &current.0 == value && (offset == 0 || current.1 <= words[start + offset - 1].1 + 1))
        })).collect::<Vec<_>>();
        if hits.len() != 1 {
            return none(if hits.is_empty() { Status::NotFound } else { Status::Ambiguous });
        }
        // One quotation can span pages: one mark, its fragments a page each, a line's rectangle the union of its words'.
        let mut fragments: Vec<(u64, Vec<(&str, [f64; 4])>)> = Vec::new();
        let first = hits[0] + before.len();
        for (_, number, line, rect) in &words[first..first + selected.len()] {
            let rect: [f64; 4] = serde_json::from_value((*rect).clone()).unwrap_or_default();
            let at = fragments.iter().position(|(page, _)| page == number).unwrap_or_else(|| {
                fragments.push((*number, Vec::new()));
                fragments.len() - 1
            });
            let lines = &mut fragments[at].1;
            match lines.iter_mut().find(|(id, _)| id == line) {
                Some((_, union)) => *union = [union[0].min(rect[0]), union[1].min(rect[1]), union[2].max(rect[2]), union[3].max(rect[3])],
                None => lines.push((line, rect)),
            }
        }
        let fragments = fragments.into_iter().map(|(number, lines)| serde_json::json!({
            "pageNumber": number, "rects": lines.into_iter().map(|(_, rect)| rect).collect::<Vec<_>>() })).collect::<Vec<_>>();
        serde_json::json!({ "text": text, "status": Status::Found, "pageNumber": fragments[0]["pageNumber"],
            "rects": fragments[0]["rects"], "fragments": fragments })
    }

    /// Passage planning and geometry share the prepared extraction witnesses.
    pub struct PdfPassagePagesJob {
        summary: legalpdf::PdfSummary,
        pages: std::sync::Arc<Vec<legal_structure::layout::Page>>,
        plans: Vec<PassagePlan>,
        fragments: Vec<legal_structure::SourceFragment>,
    }

    pub fn pdf_passage_pages_job(
        native: &NativeDocument,
        targets: Vec<PassageTarget>,
    ) -> CoreResult<PdfPassagePagesJob> {
        let document = pdf_of(native, "PDF passage geometry requires a PDF document")?;
        let plans = targets
            .into_iter()
            .map(|target| {
                let lookup = document.lookup(&legalpdf::PdfLookupRequest {
                    instrument: target.instrument.clone(),
                    ..legalpdf::PdfLookupRequest::new(&target.locator_kind, &target.locator)
                });
                let mut ranges: Vec<legal_structure::ScalarRange> = lookup
                    .matches
                    .iter()
                    .filter_map(|id| {
                        document
                            .structure()
                            .nodes
                            .iter()
                            .find(|node| &node.id == id)
                    })
                    .flat_map(|node| {
                        if (matches!(node.kind, legal_structure::NodeKind::Heading | legal_structure::NodeKind::Section)
                            || node.role == Some(legal_structure::PrimaryRole::Heading)) && !node.extent.is_empty() { &node.extent[..] }
                        else if !node.ranges.is_empty() { &node.ranges[..] }
                        else { std::slice::from_ref(&node.range) }
                    }).copied()
                    .collect();
                let mut pages = lookup
                    .units
                    .iter()
                    .flat_map(|unit| unit.pages.iter().copied())
                    .collect::<Vec<_>>();
                let mut status = lookup.status;
                // A locator naming more than one place places none.
                if status == legalpdf::PdfLookupStatus::Ambiguous {
                    ranges.clear();
                }
                if target.locator_kind == "paragraph" {
                    (status, ranges) = document.paragraph_source_ranges(&target.locator);
                    pages.clear();
                }
                if target.locator_kind == "page" {
                    if let Some(physical) = target.physical_pages {
                        pages = physical.into_iter().filter(|page| *page > 0 &&
                            (*page as usize) <= document.page_count()).collect();
                        ranges.clear();
                        status = if pages.is_empty() { legalpdf::PdfLookupStatus::NotFound }
                            else { legalpdf::PdfLookupStatus::Found };
                    }
                }
                PassagePlan {
                    id: target.id,
                    page: target.locator_kind == "page",
                    status,
                    pages,
                    ranges,
                    paragraph: (target.locator_kind == "paragraph").then(|| target.locator.clone()),
                    locator_kind: target.locator_kind,
                    locator: target.locator,
                    quotes: target.exact_quotes.into_iter()
                        .map(|text| QuoteSelection { end: legal_structure::utf16_len(&text), text, start: 0 })
                        .chain(target.quote_selections).collect(),
                }
            })
            .collect();
        Ok(PdfPassagePagesJob {
            summary: document.summary().clone(),
            pages: document.passage_pages(),
            fragments: document.structure().source_fragments.clone(),
            plans,
        })
    }

    impl PdfPassagePagesJob {
        pub fn compute(self) -> CoreResult<serde_json::Value> {
            // A scan not yet read has no geometry. A page whose own layer reads poorly (a signature's scribble over it) and
            // waits on recognition has its lines, read and placed as the structure took them.
            let unavailable = self.summary.pages_needing_ocr.iter().copied()
                .chain(self.summary.ocr_routed_pages.iter().copied())
                .filter(|index| self.pages.get(*index).is_none_or(|page| page.lines.is_empty()))
                .collect::<HashSet<_>>();
            let targets = self
                .plans
                .into_iter()
                .map(|mut plan| {
                    legal_structure::ScalarRange::normalize_union(&mut plan.ranges);
                    let status = plan.status;
                    let mut selected = std::collections::HashMap::<&str, Vec<legal_structure::ScalarRange>>::new();
                    for fragment in &self.fragments {
                        let ranges = selected.entry(fragment.id.as_str()).or_default();
                        let start = plan.ranges.partition_point(|range| range.end <= fragment.range.start);
                        for range in plan.ranges[start..].iter().take_while(|range| range.start < fragment.range.end) {
                            let start = range.start.max(fragment.range.start);
                            let end = range.end.min(fragment.range.end);
                            if start < end { ranges.push(legal_structure::ScalarRange {
                                start: start - fragment.range.start, end: end - fragment.range.start }); }
                        }
                        legal_structure::ScalarRange::normalize_union(ranges);
                    }
                    selected.retain(|_, ranges| !ranges.is_empty());
                    let selected_pages = self.fragments.iter().filter(|fragment| selected.contains_key(fragment.id.as_str()))
                        .map(|fragment| fragment.page_index as u32 + 1).collect::<HashSet<_>>();
                    let pages = self.pages.iter().filter(|page|
                        plan.pages.contains(&page.number) || selected_pages.contains(&page.number))
                        .map(|page| {
                            let available = !unavailable.contains(&((page.number - 1) as usize))
                                && (plan.page || self.fragments.iter().filter(|fragment|
                                    fragment.page_index as u32 + 1 == page.number && selected.contains_key(fragment.id.as_str()))
                                    .all(|fragment| page.lines.iter().any(|line| line.id == fragment.id)));
                            let mut lines = Vec::new();
                            if available {
                                for line in &page.lines {
                                    if plan.page {
                                        // A page request owns its entire physical text surface.
                                        lines.push(serde_json::json!({ "id": line.id, "rect": line.bbox,
                                            "words": line.words.iter()
                                                .map(|word| serde_json::json!({ "text": word.text, "rect": word.bbox }))
                                                .collect::<Vec<_>>() }));
                                        continue;
                                    }
                                    for range in selected.get(line.id.as_str()).into_iter().flatten() {
                                        let source = legal_structure::ScalarText::new(&line.text);
                                        // (A line the extraction gives no word boxes stands in its own: "Q Have you ever heard of a -- the use of a";
                                        // a line recognition read with none is marked by none.)
                                        if line.words.is_empty() {
                                            if page.source != "native" { continue; }
                                            lines.push(serde_json::json!({
                                                "id": format!("{}:{}-{}", line.id, range.start, range.end),
                                                "rect": line.bbox,
                                                "words": [{ "text": source.slice_utf16(range.start..range.end), "rect": line.bbox }] }));
                                            continue;
                                        }
                                        let words = line.words.iter().filter_map(|word| {
                                            // Physical word witnesses use Unicode scalars; source fragments use UTF-16.
                                            let start = source.utf16_at_scalar(word.start)?.max(range.start);
                                            let end = source.utf16_at_scalar(word.end)?.min(range.end);
                                            if start >= end { return None; }
                                            let text = source.slice_utf16(start..end)?;
                                            Some((word, text, legal_structure::ScalarRange { start, end }))
                                        }).collect::<Vec<_>>();
                                        // (A mark no word box covers costs that mark, not the page its line stands on.)
                                        let Some((first, _, _)) = words.first() else { continue; };
                                        let rect = words.iter().skip(1).fold(first.bbox, |rect, (word, _, _)| [
                                            rect[0].min(word.bbox[0]), rect[1].min(word.bbox[1]),
                                            rect[2].max(word.bbox[2]), rect[3].max(word.bbox[3])]);
                                        lines.push(serde_json::json!({
                                            "id": format!("{}:{}-{}", line.id, range.start, range.end),
                                            "rect": rect,
                                            "words": words.iter().map(|(word, text, _)| serde_json::json!({
                                                "text": text, "rect": word.bbox })).collect::<Vec<_>>() }));
                                    }
                                }
                            }
                            if !available { lines.clear(); }
                            serde_json::json!({ "pageNumber": page.number,
                                "width": page.width, "height": page.height,
                                "source": if available { "native" } else { "unavailable" }, "lines": lines })
                        }).collect::<Vec<_>>();
                    let complete_geometry = pages.iter().all(|page| page["source"] == "native")
                        && selected_pages.iter().all(|number| pages.iter().any(|page| page["pageNumber"] == *number));
                    // A passage found with no page it can be read on (a text, its every page unread or holding no line of it) is
                    // unavailable, and so is every quotation in it.
                    let readable = if status == legalpdf::PdfLookupStatus::Found && pages.iter().all(|page| page["source"] == "unavailable"
                        || (!plan.page && page["lines"].as_array().is_none_or(Vec::is_empty))) {
                        legalpdf::PdfLookupStatus::Unavailable
                    } else {
                        status
                    };
                    let quotes = plan.quotes.iter().map(|quote| quote_geometry(&pages, readable, quote)).collect::<Vec<_>>();
                    // Each page as the passage is marked on it: the rectangle of each of its lines on the page (none for a
                    // page asked for whole), and the start of its words (2,000 UTF-16 units at most).
                    let pages = pages.into_iter().map(|mut page| {
                        let lines = page["lines"].take();
                        let lines = lines.as_array().map(Vec::as_slice).unwrap_or_default();
                        let words = lines.iter().flat_map(|line| line["words"].as_array().into_iter().flatten())
                            .filter_map(|word| word["text"].as_str()).collect::<Vec<_>>().join(" ");
                        let mut width = 0;
                        let text = words.chars().take_while(|c| { width += c.len_utf16(); width <= 2_000 }).collect::<String>();
                        let rects = if plan.page { Vec::new() } else { lines.iter().map(|line| line["rect"].clone()).collect() };
                        let object = page.as_object_mut().expect("a page is an object");
                        object.remove("lines");
                        object.insert("text".to_owned(), text.into());
                        object.insert("passageRects".to_owned(), rects.into());
                        page
                    }).collect::<Vec<_>>();
                    let mut target = serde_json::json!({ "id": plan.id, "locatorKind": plan.locator_kind, "locator": plan.locator,
                        "status": readable, "pages": pages, "quotes": quotes });
                    if plan.paragraph.is_some() {
                        target["printed"] = (status == legalpdf::PdfLookupStatus::Found && complete_geometry && !selected_pages.is_empty() &&
                            selected_pages.iter().all(|page| !unavailable.contains(&((*page - 1) as usize)))).into();
                    }
                    target
                })
                .collect::<Vec<_>>();
            Ok(serde_json::json!({
                "schemaVersion": "legalpdf.passage-geometry.v1",
                "sourceSha256": self.summary.sha256,
                "parserVersion": self.summary.parser_version,
                "coordinateSpace": "visible_crop_box",
                "coordinateOrigin": "top_left",
                "rotationApplied": true,
                "targets": targets,
            }))
        }
    }

    pub fn query_pdf_document(document: &NativeDocument, request: &legalpdf::PdfLookupRequest) -> CoreResult<impl Serialize> {
        Ok(legalpdf::query_pdf_document(pdf_of(document, "PDF query requires a PDF document")?, request))
    }
}
