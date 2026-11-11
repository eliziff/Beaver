//! The engine's documents and the operations on them that do more than call a reader: what dispatch.rs, the one
//! surface the Node addon and the browser's WebAssembly module share, calls beside the readers themselves.

use legal_structure::{
    analyze_instrument, analyze_native_markup, docx_structure_lint, journal_document_structure, journal_text_document_structure,
    provider_text_document_structure, utf16_prefix_ceil, AuthoritativeTableCell, DocumentQuery, DocumentStructure,
    FollowDirection, JournalPageLabel, NativeMarkupInput, NodeKind, ProviderTextInput,
};
use legal_structure_features::{grounded_prose_errors, VisibleEvidenceText};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;

pub type CoreResult<T> = Result<T, String>;

/// A failed call as JavaScript is given it: what went wrong and, for a PDF's parse, the kind of failure the parser
/// named, its message the one a reader is told and its detail what went wrong.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub struct Failure {
    pub message: String,
    #[cfg(feature = "legalpdf")]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "binding-types", ts(optional))]
    pub kind: Option<legalpdf::FailureKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "binding-types", ts(optional))]
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
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(optional_fields = nullable))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StructureRequest {
    Instrument {
        text: String,
        id: String,
        #[serde(default)]
        #[cfg_attr(feature = "binding-types", ts(as = "Option<Vec<AuthoritativeTableCell>>", optional))]
        table_cells: Vec<AuthoritativeTableCell>,
        reconstruct_lineation: bool,
    },
    ProviderText { input: ProviderTextInput },
    NativeMarkup { input: NativeMarkupInput },
    /// A CourtListener opinion read whole: every rendition, the case's citations and its cluster's fields.
    Opinion { record: legal_structure::opinion::OpinionRecord, url: Option<String> },
    Journal {
        article_id: usize,
        url: Option<String>,
        filename: Option<String>,
        text: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "binding-types", ts(as = "Option<Vec<JournalPageLabel>>", optional))]
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

    /// A structure the engine read, as its document.
    pub(crate) fn of(structure: DocumentStructure) -> Self {
        Self::new(NativeProduct::Structure(structure))
    }

    pub fn structure(&self) -> &DocumentStructure {
        match &self.product {
            NativeProduct::Structure(structure) => structure,
            #[cfg(feature = "legalpdf")]
            NativeProduct::Pdf(document) => document.structure(),
        }
    }
}

pub fn native_build_features() -> &'static str {
    if cfg!(feature = "legalpdf") { "legalpdf" } else { "" }
}

pub fn derive_document_structure(request: StructureRequest) -> CoreResult<NativeDocument> {
    let structure = match request {
        StructureRequest::Instrument { text, id, table_cells, reconstruct_lineation } =>
            analyze_instrument(text, id, &table_cells, reconstruct_lineation).map_err(|error| error.to_string())?,
        StructureRequest::ProviderText { input } => provider_text_document_structure(input).map_err(|error| error.to_string())?,
        StructureRequest::NativeMarkup { input } => analyze_native_markup(input).map_err(|error| error.to_string())?,
        StructureRequest::Opinion { record, url } => legal_structure::opinion::opinion_structure(&record, url),
        StructureRequest::Journal { article_id, url, filename, text, page_rows } => if let Some(filename) = filename {
            let file = File::open(filename).map_err(|error| error.to_string())?;
            journal_document_structure(article_id, url, BufReader::new(file), &page_rows)
        } else if let Some(text) = text {
            journal_text_document_structure(article_id, url, text, &page_rows)
        } else {
            return Err("journal request requires filename or text".to_owned());
        }
        .map_err(|error| error.to_string())?,
    };
    Ok(NativeDocument::of(structure))
}

pub fn docx_structure_lint_json(document: &NativeDocument) -> CoreResult<legal_structure::DocxLintReport> {
    #[cfg(feature = "legalpdf")]
    {
        if matches!(document.product, NativeProduct::Pdf(_)) {
            return Err("DOCX lint requires a structured document".to_owned());
        }
    }
    docx_structure_lint(document.structure()).map_err(|error| error.to_string())
}

pub fn document_text(document: &NativeDocument, limit: Option<u32>) -> &str {
    let text = document.structure().query_text();
    limit.map_or(text, |limit| utf16_prefix_ceil(text, limit as usize))
}

/// The nodes the query serves, in its order, each as a reader takes it (`DocumentStructure::reading`); with `kind`, those
/// it serves as that kind (a paragraph's prose among them); with `end`, those starting before it.
pub fn document_anchors(document: &NativeDocument, kind: Option<NodeKind>, end: Option<u32>) -> Vec<legal_structure::NodeReading<'_>> {
    let structure = document.structure();
    document.query.blocks(structure, kind).map(|node| structure.reading(node))
        .filter(|reading| end.is_none_or(|end| reading.span.start < end as usize)).collect()
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
    let pages = citations.iter().flat_map(|citation| reporter_pages(citation)).filter_map(|page| page.trim().parse().ok());
    pages.filter(|page| *page > 0).collect::<std::collections::BTreeSet<u32>>().into_iter().collect()
}

/// Each quotation located in a document's text and, with `compare`, compared with it, with what grounded_prose_errors
/// says of the quotation against the passage it was found in (the whole text where it was not), the evidence named by
/// its id.
pub fn quote_locate_document(document: &NativeDocument, source: legal_structure_features::QuoteSource,
    quotes: &[legal_structure_features::QuoteToLocate], compare: bool, keep: bool) -> CoreResult<Vec<LocatedQuotation>> {
    let text = document_text(document, None);
    let locate = |locator: &mut legal_structure_features::QuoteLocator| {
        legal_structure_features::locate_document_quotes(locator, document.structure(), &document.query, source, quotes, compare)
    };
    let located = if keep {
        locate(&mut document.quotes.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
    } else {
        locate(&mut Default::default())
    };
    Ok(located.into_iter().zip(quotes).map(|(located, item)| {
        if !compare {
            return LocatedQuotation { located, errors: None };
        }
        let id = item.id.clone().unwrap_or_default();
        let evidence = if located.found.text.is_empty() { text } else { located.found.text.as_str() };
        let evidence = VisibleEvidenceText { evidence_id: id.clone(), text: evidence.to_owned(), labels: Vec::new() };
        let errors = grounded_prose_errors(&format!("\u{201c}{}\u{201d}", item.quote), std::slice::from_ref(&id), &[evidence]);
        LocatedQuotation { located, errors: Some(errors) }
    })
    .collect())
}

/// A quotation located in a document, and where it was compared, the grounding errors its words leave (`errors`).
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub struct LocatedQuotation {
    #[serde(flatten)]
    pub located: legal_structure_features::LocatedQuote,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "binding-types", ts(optional))]
    pub errors: Option<Vec<String>>,
}

pub use legal_structure_features::{citation_key_version, AliasGroup};

/// A block looked up by its locator ("para 12"), or as a graph's seed names it.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(untagged)]
pub enum BlockLocator {
    Locator(String),
    Seed(legal_structure::GraphScopeSeed),
}

pub fn lookup_structure_block(document: &NativeDocument, locator: BlockLocator, context_blocks: u32) -> legal_structure::DocumentLookup<'_> {
    let selector = match locator {
        BlockLocator::Locator(locator) => legal_structure::GraphScopeSeed::Locator(locator),
        BlockLocator::Seed(seed) => seed,
    };
    document.query.structure_selection(document.structure(), &selector, context_blocks as usize)
}

pub fn graph_scope<'a>(document: &'a NativeDocument, seed: &legal_structure::GraphScopeSeed, follow: FollowDirection, depth: u32,
    include_descendants: bool, include_units: bool) -> Option<legal_structure::GraphScope<'a>> {
    let structure = document.structure();
    let graph = structure.cross_references.as_ref().filter(|graph| !graph.document_abstained)?;
    document.query.graph_scope(structure, graph, seed, follow, depth as usize, include_descendants, include_units)
}

/// Supplies this engine to the PDF and DOCX parsers, which are built without it so that an engine edit does not recompile
/// them. The addon supplies it as it loads, the browser's module before its first call.
pub fn install_structure_analysis() {
    #[cfg(feature = "docx")]
    legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
}

#[cfg(feature = "legalpdf")]
pub use pdf::*;

#[cfg(feature = "legalpdf")]
mod pdf {
    use super::*;
    use legalpdf::PdfPageBinding;

    /// The PDF a document was read from; none for a document of another format.
    pub fn pdf(document: &NativeDocument) -> CoreResult<&legalpdf::PdfDocument> {
        match &document.product {
            NativeProduct::Pdf(document) => Ok(document),
            _ => Err("This operation requires a PDF document".to_owned()),
        }
    }

    pub fn pdf_recognized_text(document: &NativeDocument, pages: Option<Vec<u32>>)
        -> CoreResult<Option<Vec<&legal_structure::layout::Page>>> {
        let document = pdf(document)?;
        if pages.as_ref().is_some_and(|pages| pages.is_empty() || pages.len() > 16 || pages.contains(&0)) {
            return Err("Request between 1 and 16 PDF text pages".to_owned());
        }
        // Filter before serializing: a viewport read must not copy the whole scan into JS.
        Ok(Some(document.recognized_pages().filter(|page| pages.as_ref().is_none_or(|pages| pages.contains(&page.number))).collect()))
    }

    /// The document's page map (`PdfDocument::page_map`), anchored on the first pages of the reports `citations` cite.
    pub fn pdf_page_map(document: &NativeDocument, citations: &[String]) -> CoreResult<Vec<PdfPageBinding>> {
        let starts = super::reporter_start_pages(citations);
        let is_citation = |text: &str, page: &str| super::reporter_pages(text).iter().any(|cited| cited == page);
        Ok(legalpdf::page_map(pdf(document)?, &starts, &is_citation))
    }

    /// The PDF pages (from 1) each printed page label names by the document's page map, anchored on the reports
    /// `citations` cite (`printed_pages`); none for a label the map does not resolve.
    pub fn pdf_printed_pages(document: &NativeDocument, citations: &[String], labels: &[String]) -> CoreResult<Vec<Vec<u32>>> {
        let map = pdf_page_map(document, citations)?;
        Ok(labels.iter().map(|label| printed_pages(label, &map)).collect())
    }

    /// Each passage placed on the PDF's pages (`PdfDocument::passage_geometry`). With `citations`, a page locator that
    /// names no pages of its own is a printed page: the PDF's pages the page map, anchored on the reports they cite,
    /// gives it.
    pub fn passage_geometry(document: &NativeDocument, mut targets: Vec<legalpdf::PassageTarget>, citations: Option<Vec<String>>)
        -> CoreResult<legalpdf::PassageGeometry> {
        let printed = |target: &legalpdf::PassageTarget| target.locator_kind == "page" && target.physical_pages.is_none();
        if let Some(citations) = citations.filter(|_| targets.iter().any(printed)) {
            let map = pdf_page_map(document, &citations)?;
            for target in targets.iter_mut().filter(|target| printed(target)) {
                target.physical_pages = Some(printed_pages(&target.locator, &map));
            }
        }
        Ok(pdf(document)?.passage_geometry(&document.query, targets))
    }

    /// The PDF pages (from 1) a printed page or range of pages ("138-39", "138–40") names: only where the map numbers
    /// every page it needs once and can be trusted. A map with an ambiguous page, or whose pages are not the PDF's in
    /// order, resolves none; one with unnumbered pages only where they open the PDF and every page after them takes its
    /// number from a report's first page, for unknown pages can hide a repeated folio.
    pub fn printed_pages(label: &str, map: &[PdfPageBinding]) -> Vec<u32> {
        static RANGE: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new(r"^\s*(\d+)(?:\s*[-\u{2013}\u{2014}]\s*(\d+))?\s*$").unwrap());
        let resolved = |page: &PdfPageBinding| page.status == "resolved";
        let Some(first_resolved) = map.iter().position(resolved) else { return Vec::new() };
        if map.iter().enumerate().any(|(index, page)| page.pdf_page as usize != index + 1 || page.status == "ambiguous") {
            return Vec::new();
        }
        if !map.iter().all(resolved)
            && (map[..first_resolved].iter().any(|page| page.status != "unknown")
                || map[first_resolved..].iter().any(|page| !resolved(page) || page.source.as_deref() != Some("reporter")))
        {
            return Vec::new();
        }
        let once = |label: &str| {
            let mut pages = map.iter().filter(|page| !label.is_empty() && page.label.as_deref() == Some(label)).map(|page| page.pdf_page);
            match (pages.next(), pages.next()) {
                (Some(page), None) => Some(page),
                _ => None,
            }
        };
        let Some(range) = RANGE.captures(label) else { return once(label.trim()).into_iter().collect() };
        let start = &range[1];
        // A range's end may be written short: "138-39" ends at 139.
        let end = range.get(2).map_or(start, |end| end.as_str());
        let end = if end.len() < start.len() { format!("{}{end}", &start[..start.len() - end.len()]) } else { end.to_owned() };
        let (Ok(first), Ok(last)) = (start.parse::<u64>(), end.parse::<u64>()) else { return Vec::new() };
        if last < first || last - first > 2000 {
            return Vec::new();
        }
        let mut pages = Vec::new();
        for number in first..=last {
            let Some(page) = once(&number.to_string()) else { return Vec::new() };
            if !pages.contains(&page) {
                pages.push(page);
            }
        }
        pages
    }
}

#[cfg(all(test, feature = "legalpdf"))]
mod tests {
    use super::printed_pages;
    use legalpdf::PdfPageBinding;

    /// A page map as the engine returns one: each page its label as printed.
    fn map(labels: &[Option<&str>]) -> Vec<PdfPageBinding> {
        labels
            .iter()
            .enumerate()
            .map(|(index, label)| PdfPageBinding {
                pdf_page: index as u32 + 1,
                observed: label.map(str::to_owned),
                label: label.map(str::to_owned),
                source: label.map(|_| "detected".to_owned()),
                status: if label.is_some() {
                    "resolved"
                } else {
                    "unknown"
                }
                .to_owned(),
                numbers: Vec::new(),
            })
            .collect()
    }

    #[test]
    fn printed_pages_resolve_only_unique_complete_bindings() {
        let repeated = map(&[Some("5"), Some("6"), Some("5")]);
        assert!(printed_pages("5", &repeated).is_empty());
        assert!(printed_pages("5\u{2013}6", &repeated).is_empty());
        assert!(printed_pages("2", &map(&[None, Some("2"), None])).is_empty());
        assert!(printed_pages("150", &map(&[None, None])).is_empty());
        let labels = map(&[Some("138"), Some("139"), Some("140")]);
        assert_eq!(printed_pages("138-39", &labels), [1, 2]);
        assert_eq!(printed_pages("138-40", &labels), [1, 2, 3]);
        assert!(printed_pages("138-7", &labels).is_empty());
        assert!(printed_pages("138-39", &map(&[Some("138"), Some("139"), None])).is_empty());
        assert!(printed_pages("138-39", &map(&[Some("138"), Some("139"), Some("139")])).is_empty());
        assert!(printed_pages("100000000000000000000", &labels).is_empty());
    }
}
