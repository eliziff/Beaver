use legal_structure::{
    a2aj_document_structure, analyze_instrument, analyze_native_markup,
    caselaw_citation_lookup_key, citation_lookup_key, citations_in_text, classify_citator_excerpt,
    derive_document_structure, document_fingerprint, docx_structure_lint, grounded_prose_errors,
    has_citation_in_text, journal_document_structure, journal_text_document_structure,
    marked_quote_spans, normalize_document_locator, parse_address, phrase_spans,
    provider_citations_in_text, quote_repair_suggestion, text_fragment_directives,
    tokenize_source_text, A2ajInput, AuthoritativeTableCell, DocumentFingerprint, DocumentInput,
    DocumentKind, DocumentOrigin, DocumentQuery, DocumentStructure, FollowDirection,
    InstrumentCrossReferenceGraph, JournalPageLabel, NativeMarkupInput, PhraseOptions,
    VisibleEvidenceText,
};
#[cfg(feature = "legalpdf")]
use napi::bindgen_prelude::Buffer;
use napi::{
    bindgen_prelude::{AsyncTask, External, ExternalRef},
    Env, Error, Task, Unknown,
};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StructureRequest {
    Evidence {
        input: DocumentInput,
    },
    Instrument {
        text: String,
        id: String,
        #[serde(default)]
        table_cells: Vec<AuthoritativeTableCell>,
        reconstruct_lineation: bool,
    },
    A2aj {
        input: A2ajInput,
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
        page_rows: Vec<serde_json::Value>,
    },
}

fn page_labels(rows: Vec<serde_json::Value>) -> Vec<JournalPageLabel> {
    rows.into_iter()
        .filter_map(|row| {
            let pdf_page = row.get("pdf_page")?.as_u64()?.try_into().ok()?;
            let label = match row.get("page_label")? {
                serde_json::Value::String(value) => value.clone(),
                value @ (serde_json::Value::Number(_) | serde_json::Value::Bool(_)) => {
                    value.to_string()
                }
                _ => return None,
            };
            Some(JournalPageLabel { label, pdf_page })
        })
        .collect()
}

enum NativeProduct {
    Structure(DocumentStructure),
    #[cfg(feature = "legalpdf")]
    Docx {
        structure: DocumentStructure,
        table_cells: Vec<AuthoritativeTableCell>,
    },
    #[cfg(feature = "legalpdf")]
    Pdf(legalpdf::PdfDocumentResult),
}

pub struct NativeDocument {
    product: NativeProduct,
    query: DocumentQuery,
}

impl NativeDocument {
    fn query(&self) -> &DocumentQuery {
        &self.query
    }

    fn cross_references(&self) -> Option<&InstrumentCrossReferenceGraph> {
        self.structure().cross_references.as_ref()
    }

    fn structure(&self) -> &DocumentStructure {
        match &self.product {
            NativeProduct::Structure(structure) => structure,
            #[cfg(feature = "legalpdf")]
            NativeProduct::Docx { structure, .. } => structure,
            #[cfg(feature = "legalpdf")]
            NativeProduct::Pdf(document) => document.structure(),
        }
    }
}

fn js_value(env: Env, value: &impl Serialize) -> napi::Result<Unknown<'static>> {
    env.to_js_value(value)
}

fn document_kind(value: &str) -> napi::Result<DocumentKind> {
    match value {
        "paragraph" => Ok(DocumentKind::Paragraph),
        "page" => Ok(DocumentKind::Page),
        "section" => Ok(DocumentKind::Section),
        "footnote" => Ok(DocumentKind::Footnote),
        "table" => Ok(DocumentKind::Table),
        "row" => Ok(DocumentKind::Row),
        "cell" => Ok(DocumentKind::Cell),
        _ => Err(Error::from_reason("invalid document block kind")),
    }
}

fn follow_direction(value: &str) -> napi::Result<FollowDirection> {
    match value {
        "none" => Ok(FollowDirection::None),
        "out" => Ok(FollowDirection::Out),
        "in" => Ok(FollowDirection::In),
        "both" => Ok(FollowDirection::Both),
        _ => Err(Error::from_reason("invalid reference direction")),
    }
}

fn analyze_request(request: serde_json::Value) -> napi::Result<NativeDocument> {
    let request: StructureRequest =
        serde_json::from_value(request).map_err(|error| Error::from_reason(error.to_string()))?;
    let structure = match request {
        StructureRequest::Evidence { input } => {
            derive_document_structure(input).map_err(native_error)?
        }
        StructureRequest::Instrument {
            text,
            id,
            table_cells,
            reconstruct_lineation,
        } => analyze_instrument(text, id, &table_cells, reconstruct_lineation)
            .map_err(native_error)?,
        StructureRequest::A2aj { input } => a2aj_document_structure(input).map_err(native_error)?,
        StructureRequest::NativeMarkup { input } => {
            analyze_native_markup(input).map_err(native_error)?
        }
        StructureRequest::Journal {
            article_id,
            url,
            filename,
            text,
            page_rows,
        } => {
            let labels = page_labels(page_rows);
            if let Some(filename) = filename {
                let file =
                    File::open(filename).map_err(|error| Error::from_reason(error.to_string()))?;
                journal_document_structure(article_id, url, BufReader::new(file), &labels)
            } else if let Some(text) = text {
                journal_text_document_structure(article_id, url, text, &labels)
            } else {
                return Err(Error::from_reason(
                    "journal request requires filename or text",
                ));
            }
            .map_err(native_error)?
        }
    };
    Ok(NativeDocument {
        product: NativeProduct::Structure(structure),
        query: DocumentQuery::new(),
    })
}

pub struct DeriveDocumentTask {
    request: serde_json::Value,
}

impl Task for DeriveDocumentTask {
    type Output = NativeDocument;
    type JsValue = ExternalRef<NativeDocument>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        analyze_request(std::mem::take(&mut self.request))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        ExternalRef::new(&env, output)
    }
}

#[napi(js_name = "deriveDocumentStructure")]
pub fn derive_document_structure_node(request: serde_json::Value) -> AsyncTask<DeriveDocumentTask> {
    AsyncTask::new(DeriveDocumentTask { request })
}

pub struct DeriveDocumentFingerprintTask {
    request: serde_json::Value,
}

impl Task for DeriveDocumentFingerprintTask {
    type Output = DocumentFingerprint;
    type JsValue = Unknown<'static>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let document = analyze_request(std::mem::take(&mut self.request))?;
        Ok(document_fingerprint(document.structure()))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        js_value(env, &output)
    }
}

#[napi(js_name = "deriveDocumentFingerprint")]
pub fn derive_document_fingerprint_node(
    request: serde_json::Value,
) -> AsyncTask<DeriveDocumentFingerprintTask> {
    AsyncTask::new(DeriveDocumentFingerprintTask { request })
}

#[cfg(feature = "legalpdf")]
mod legalpdf_exports {
    use super::*;

    pub struct DeriveDocxDocumentTask {
        bytes: Buffer,
        id: String,
    }

    #[napi(object)]
    pub struct DocxSupraReasonsNode {
        #[napi(js_name = "restarted_numbering")]
        pub restarted_numbering: bool,
        #[napi(js_name = "unsafe_or_split_fields")]
        pub unsafe_or_split_fields: u32,
    }

    #[napi(object)]
    pub struct DocxSupraCleanupNode {
        pub bytes: Buffer,
        pub detected: u32,
        pub converted: u32,
        #[napi(js_name = "already_linked")]
        pub already_linked: u32,
        #[napi(js_name = "review_required")]
        pub review_required: u32,
        #[napi(js_name = "bookmarks_added")]
        pub bookmarks_added: u32,
        pub reasons: DocxSupraReasonsNode,
    }

    impl From<legalpdf::DocxSupraCleanup> for DocxSupraCleanupNode {
        fn from(result: legalpdf::DocxSupraCleanup) -> Self {
            Self {
                bytes: result.bytes.into(),
                detected: result.detected as u32,
                converted: result.converted as u32,
                already_linked: result.already_linked as u32,
                review_required: result.review_required as u32,
                bookmarks_added: result.bookmarks_added as u32,
                reasons: DocxSupraReasonsNode {
                    restarted_numbering: result.restarted_numbering,
                    unsafe_or_split_fields: result.unsafe_or_split_fields as u32,
                },
            }
        }
    }

    pub struct FixDocxSuprasTask {
        bytes: Vec<u8>,
    }

    fn docx_supra_bytes(bytes: Buffer) -> napi::Result<Vec<u8>> {
        if bytes.is_empty() || bytes.len() > legalpdf::MAX_DOCX_SUPRA_BYTES {
            return Err(Error::from_reason(
                "DOCX is empty or exceeds the read limit",
            ));
        }
        Ok(bytes.to_vec())
    }

    impl Task for FixDocxSuprasTask {
        type Output = legalpdf::DocxSupraCleanup;
        type JsValue = DocxSupraCleanupNode;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            legalpdf::fix_docx_supra_cross_references(&self.bytes)
                .map_err(|error| Error::from_reason(error.to_string()))
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            Ok(output.into())
        }
    }

    #[napi(js_name = "fixDocxSupraCrossReferences")]
    pub fn fix_docx_supra_cross_references_node(
        bytes: Buffer,
    ) -> napi::Result<AsyncTask<FixDocxSuprasTask>> {
        Ok(AsyncTask::new(FixDocxSuprasTask {
            bytes: docx_supra_bytes(bytes)?,
        }))
    }

    pub struct HasDocxSuprasTask {
        bytes: Vec<u8>,
    }

    impl Task for HasDocxSuprasTask {
        type Output = bool;
        type JsValue = bool;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            legalpdf::has_docx_supra_references(&self.bytes)
                .map_err(|error| Error::from_reason(error.to_string()))
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            Ok(output)
        }
    }

    #[napi(js_name = "hasDocxSupraReferences")]
    pub fn has_docx_supra_references_node(
        bytes: Buffer,
    ) -> napi::Result<AsyncTask<HasDocxSuprasTask>> {
        Ok(AsyncTask::new(HasDocxSuprasTask {
            bytes: docx_supra_bytes(bytes)?,
        }))
    }

    impl Task for DeriveDocxDocumentTask {
        type Output = NativeDocument;
        type JsValue = ExternalRef<NativeDocument>;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            let (structure, table_cells) =
                legalpdf::analyze_docx_bytes(&self.bytes, std::mem::take(&mut self.id))
                    .map_err(|error| Error::from_reason(error.to_string()))?;
            Ok(NativeDocument {
                product: NativeProduct::Docx {
                    structure,
                    table_cells,
                },
                query: DocumentQuery::new(),
            })
        }

        fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            ExternalRef::new(&env, output)
        }
    }

    #[napi(js_name = "deriveDocxDocument")]
    pub fn derive_docx_document_node(
        bytes: Buffer,
        id: String,
    ) -> AsyncTask<DeriveDocxDocumentTask> {
        AsyncTask::new(DeriveDocxDocumentTask { bytes, id })
    }

    pub struct DerivePdfDocumentTask {
        request: serde_json::Value,
    }

    impl Task for DerivePdfDocumentTask {
        type Output = NativeDocument;
        type JsValue = ExternalRef<NativeDocument>;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            if self.request.get("kind").and_then(serde_json::Value::as_str) != Some("pdf") {
                return Err(Error::from_reason(
                    "PDF document request has an invalid kind",
                ));
            }
            let pairing_audit = self
                .request
                .get("pairing_audit")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            legalpdf::derive_pdf_document(&self.request, pairing_audit)
                .map(|document| NativeDocument {
                    product: NativeProduct::Pdf(document),
                    query: DocumentQuery::new(),
                })
                .map_err(|error| Error::from_reason(error.to_string()))
        }

        fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            ExternalRef::new(&env, output)
        }
    }

    #[napi(js_name = "derivePdfDocument")]
    pub fn derive_pdf_document_node(
        request: serde_json::Value,
    ) -> AsyncTask<DerivePdfDocumentTask> {
        AsyncTask::new(DerivePdfDocumentTask { request })
    }

    pub struct PdfPageCountTask {
        path: String,
    }

    impl Task for PdfPageCountTask {
        type Output = u32;
        type JsValue = u32;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            legalpdf::pdf_page_count(std::path::Path::new(&self.path))
                .map_err(|error| Error::from_reason(error.to_string()))
        }

        fn resolve(&mut self, _env: Env, page_count: Self::Output) -> napi::Result<Self::JsValue> {
            Ok(page_count)
        }
    }

    #[napi(js_name = "pdfPageCount")]
    pub fn pdf_page_count_node(path: String) -> AsyncTask<PdfPageCountTask> {
        AsyncTask::new(PdfPageCountTask { path })
    }

    #[napi(js_name = "pdfDocumentSummary")]
    pub fn pdf_document_summary_node(
        env: Env,
        document: &External<NativeDocument>,
    ) -> napi::Result<Unknown<'static>> {
        let NativeProduct::Pdf(document) = &document.product else {
            return Err(Error::from_reason("PDF summary requires a PDF document"));
        };
        js_value(env, &legalpdf::pdf_document_summary(document))
    }
}

#[napi(js_name = "documentCitedAuthorities")]
pub fn document_cited_authorities_node(
    env: Env,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    match &document.product {
        NativeProduct::Structure(structure) => js_value(env, &structure.cited_authorities),
        #[cfg(feature = "legalpdf")]
        NativeProduct::Docx { structure, .. } => js_value(env, &structure.cited_authorities),
        #[cfg(feature = "legalpdf")]
        NativeProduct::Pdf(_) => js_value(env, &Vec::<serde_json::Value>::new()),
    }
}

#[napi(js_name = "docxStructureLint")]
pub fn docx_structure_lint_node(
    env: Env,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    #[cfg(feature = "legalpdf")]
    {
        if matches!(document.product, NativeProduct::Pdf(_)) {
            return Err(Error::from_reason(
                "DOCX lint requires a structured document",
            ));
        }
    }
    js_value(
        env,
        &docx_structure_lint(document.structure()).map_err(native_error)?,
    )
}

#[cfg(feature = "legalpdf")]
#[napi(js_name = "docxTableCells")]
pub fn docx_table_cells_node(
    env: Env,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    let NativeProduct::Docx { table_cells, .. } = &document.product else {
        return Err(Error::from_reason(
            "DOCX table cells require a DOCX document",
        ));
    };
    js_value(env, table_cells)
}

#[napi(js_name = "documentText")]
pub fn document_text_node(document: &External<NativeDocument>) -> String {
    document.structure().query_text().to_owned()
}

#[napi(js_name = "documentTextBytes")]
pub fn document_text_bytes_node(document: &External<NativeDocument>) -> u32 {
    document.structure().query_text().len() as u32
}

#[napi(js_name = "documentRevision")]
pub fn document_revision_node(document: &External<NativeDocument>) -> String {
    document.structure().revision.clone()
}

#[napi(js_name = "documentAnchors")]
pub fn document_anchors_node(
    env: Env,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    let structure = document.structure();
    js_value(
        env,
        &document.query().anchors(structure).collect::<Vec<_>>(),
    )
}

#[napi(js_name = "normalizeDocumentLocator")]
pub fn normalize_document_locator_node(kind: String, locator: String) -> napi::Result<String> {
    Ok(normalize_document_locator(document_kind(&kind)?, &locator))
}

#[napi(js_name = "tokenizeSourceText")]
pub fn tokenize_source_text_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &tokenize_source_text(&text))
}

#[napi(js_name = "citationLookupKey")]
pub fn citation_lookup_key_node(text: String) -> String {
    citation_lookup_key(&text)
}

#[napi(js_name = "citationsInText")]
pub fn citations_in_text_node(
    env: Env,
    text: String,
    extended_us_fallback: bool,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &citations_in_text(&text, extended_us_fallback))
}

#[napi(js_name = "providerCitationsInText")]
pub fn provider_citations_in_text_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &provider_citations_in_text(&text))
}

#[napi(js_name = "caselawCitationLookupKey")]
pub fn caselaw_citation_lookup_key_node(text: String) -> napi::Result<String> {
    caselaw_citation_lookup_key(&text).map_err(Error::from_reason)
}

#[napi(js_name = "hasCitationInText")]
pub fn has_citation_in_text_node(text: String) -> bool {
    has_citation_in_text(&text)
}

#[napi(js_name = "classifyCitatorExcerpt")]
pub fn classify_citator_excerpt_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &classify_citator_excerpt(&text))
}

#[napi(js_name = "groundedProseErrors")]
pub fn grounded_prose_errors_node(
    text: String,
    cited_evidence_ids: Vec<String>,
    visible_evidence: serde_json::Value,
) -> napi::Result<Vec<String>> {
    let visible: Vec<VisibleEvidenceText> = serde_json::from_value(visible_evidence)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    Ok(grounded_prose_errors(&text, &cited_evidence_ids, &visible))
}

#[napi(js_name = "quoteRepairSuggestion")]
pub fn quote_repair_suggestion_node(claim: String, spans: Vec<String>) -> Option<String> {
    quote_repair_suggestion(&claim, &spans)
}

#[napi(js_name = "markedQuoteSpans")]
pub fn marked_quote_spans_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &marked_quote_spans(&text))
}

#[napi(js_name = "readDocumentRange")]
pub fn read_document_range_node(
    env: Env,
    document: &External<NativeDocument>,
    kind: String,
    from: String,
    to: String,
    context_blocks: u32,
) -> napi::Result<Unknown<'static>> {
    let structure = document.structure();
    js_value(
        env,
        &document.query().read_range(
            structure,
            document_kind(&kind)?,
            &from,
            &to,
            context_blocks as usize,
        ),
    )
}

#[napi(js_name = "smallestContainingDocumentBlock")]
pub fn smallest_containing_document_block_node(
    env: Env,
    document: &External<NativeDocument>,
    start: u32,
    end: u32,
) -> napi::Result<Unknown<'static>> {
    js_value(
        env,
        &document.query().smallest_containing_block(
            document.structure(),
            start as usize,
            end as usize,
        ),
    )
}

#[napi(js_name = "textPhraseSpans")]
pub fn text_phrase_spans_node(
    env: Env,
    text: String,
    words: Vec<String>,
    start: Option<u32>,
    end: Option<u32>,
    same_line: Option<bool>,
    limit: Option<u32>,
) -> napi::Result<Unknown<'static>> {
    js_value(
        env,
        &phrase_spans(
            &text,
            &words,
            PhraseOptions {
                start: start.map(|value| value as usize),
                end: end.map(|value| value as usize),
                same_line: same_line.unwrap_or(false),
                limit: limit.map(|value| value as usize),
            },
        ),
    )
}

#[napi(js_name = "textFragmentDirectives")]
pub fn text_fragment_directives_node(
    block_text: String,
    quotes: Vec<String>,
    page_scoped: bool,
    document_text: Option<String>,
    document: Option<&External<NativeDocument>>,
) -> Vec<String> {
    document.map_or_else(
        || text_fragment_directives(&block_text, document_text.as_deref(), &quotes, page_scoped),
        |document| {
            document.query().text_fragment_directives(
                document.structure(),
                &block_text,
                &quotes,
                page_scoped,
            )
        },
    )
}

#[napi(js_name = "documentParagraphRangeDirective")]
pub fn document_paragraph_range_directive_node(
    document: &External<NativeDocument>,
    start: String,
    end: String,
) -> Option<String> {
    document
        .query()
        .paragraph_range_directive(document.structure(), &start, &end)
}

#[napi(js_name = "documentPageMap")]
pub fn document_page_map_node(
    env: Env,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &document.query().page_map(document.structure()))
}

#[napi(js_name = "resolveDocumentPage")]
pub fn resolve_document_page_node(
    env: Env,
    document: &External<NativeDocument>,
    requested: String,
) -> napi::Result<Unknown<'static>> {
    js_value(
        env,
        &document
            .query()
            .resolve_page(document.structure(), &requested),
    )
}

#[napi(js_name = "lookupStructureBlock")]
pub fn lookup_structure_block_node(
    env: Env,
    document: &External<NativeDocument>,
    locator: String,
    context_blocks: u32,
) -> napi::Result<Unknown<'static>> {
    js_value(
        env,
        &document
            .query()
            .structure_block(document.structure(), &locator, context_blocks as usize),
    )
}

#[napi(js_name = "parseDocumentAddress")]
pub fn parse_document_address_node(env: Env, spec: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &parse_address(&spec))
}

#[napi(js_name = "graphScope")]
pub fn graph_scope_node(
    env: Env,
    document: &External<NativeDocument>,
    seed_label: String,
    follow: String,
    depth: u32,
    include_descendants: bool,
    include_units: bool,
) -> napi::Result<Unknown<'static>> {
    let follow = follow_direction(&follow)?;
    js_value(
        env,
        &document
            .cross_references()
            .filter(|graph| !graph.document_abstained)
            .and_then(|graph| {
                document.query().graph_scope(
                    document.structure(),
                    graph,
                    &seed_label,
                    follow,
                    depth as usize,
                    include_descendants,
                    include_units,
                )
            }),
    )
}

#[napi(js_name = "documentHasOrigin")]
pub fn document_has_origin_node(
    document: &External<NativeDocument>,
    origin: String,
) -> napi::Result<bool> {
    let origin = match origin.as_str() {
        "native" => DocumentOrigin::Native,
        "heuristic" => DocumentOrigin::Heuristic,
        _ => return Err(Error::from_reason("invalid document origin")),
    };
    Ok(document.query().has_origin(document.structure(), origin))
}

#[cfg(feature = "legalpdf")]
#[napi(js_name = "queryPdfDocument")]
pub fn query_pdf_document_node(
    env: Env,
    document: &External<NativeDocument>,
    query: serde_json::Value,
) -> napi::Result<Unknown<'static>> {
    let NativeProduct::Pdf(pdf) = &document.product else {
        return Err(Error::from_reason("PDF query requires a PDF document"));
    };
    let result = legalpdf::query_pdf_document(pdf, &query)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    js_value(env, &result)
}

macro_rules! js_task {
    ($name:ident { $($field:ident: $ty:ty),+ $(,)? }, $compute:expr) => {
        pub struct $name { $($field: $ty),+ }
        impl Task for $name {
            type Output = serde_json::Value;
            type JsValue = Unknown<'static>;
            fn compute(&mut self) -> napi::Result<Self::Output> { $compute(self).map_err(native_error) }
            fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
                js_value(env, &output)
            }
        }
    };
}

js_task!(
    DeleteAndRenumberTask {
        source: String,
        target: String,
        reconstruct_lineation: bool
    },
    |task: &mut DeleteAndRenumberTask| {
        legal_structure::delete_provision_and_renumber_siblings(
            &task.source,
            &task.target,
            task.reconstruct_lineation,
        )
    }
);

#[napi(js_name = "deleteProvisionAndRenumberSiblings")]
pub fn delete_provision_and_renumber_siblings_node(
    source: String,
    target: String,
    reconstruct_lineation: Option<bool>,
) -> AsyncTask<DeleteAndRenumberTask> {
    AsyncTask::new(DeleteAndRenumberTask {
        source,
        target,
        reconstruct_lineation: reconstruct_lineation.unwrap_or(true),
    })
}

js_task!(
    ConsolidateAmendmentTask {
        source: String,
        amendment: String,
        reconstruct_lineation: bool
    },
    |task: &mut ConsolidateAmendmentTask| {
        legal_structure::consolidate_amendment(
            &task.source,
            &task.amendment,
            task.reconstruct_lineation,
        )
    }
);

#[napi(js_name = "consolidateAmendment")]
pub fn consolidate_amendment_node(
    source: String,
    amendment: String,
    reconstruct_lineation: Option<bool>,
) -> AsyncTask<ConsolidateAmendmentTask> {
    AsyncTask::new(ConsolidateAmendmentTask {
        source,
        amendment,
        reconstruct_lineation: reconstruct_lineation.unwrap_or(true),
    })
}

fn native_error(error: legal_structure::EngineError) -> Error {
    Error::from_reason(error.to_string())
}
