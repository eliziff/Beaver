//! Node-API bindings over `core`. Async tasks run the same operations off the JS thread.

use crate::engine::{self, NativeDocument, StructureRequest};
#[cfg(feature = "legalpdf")]
use napi::bindgen_prelude::Buffer;
use napi::{
    bindgen_prelude::{AsyncTask, External, ExternalRef},
    Env, Error, Task, Unknown,
};
use napi_derive::napi;
use serde::Serialize;

fn js_value(env: Env, value: &impl Serialize) -> napi::Result<Unknown<'static>> {
    env.to_js_value(value)
}

fn reason(error: String) -> Error {
    Error::from_reason(error)
}

#[napi(js_name = "nativeBuildFeatures")]
pub fn native_build_features_node() -> &'static str {
    engine::native_build_features()
}

pub struct DeriveDocumentTask {
    request: Option<StructureRequest>,
}

impl Task for DeriveDocumentTask {
    type Output = NativeDocument;
    type JsValue = ExternalRef<NativeDocument>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        engine::derive_document_structure(
            self.request
                .take()
                .ok_or_else(|| Error::from_reason("document task already consumed"))?,
        )
        .map_err(reason)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        ExternalRef::new(&env, output)
    }
}

#[napi(js_name = "deriveDocumentStructure")]
pub fn derive_document_structure_node(
    env: Env,
    request: Unknown<'_>,
) -> napi::Result<AsyncTask<DeriveDocumentTask>> {
    Ok(AsyncTask::new(DeriveDocumentTask {
        request: Some(env.from_js_value(request)?),
    }))
}

pub struct DeriveDocumentFingerprintTask {
    request: Option<StructureRequest>,
}

impl Task for DeriveDocumentFingerprintTask {
    type Output = legal_structure::DocumentFingerprint;
    type JsValue = Unknown<'static>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        engine::derive_document_fingerprint(
            self.request
                .take()
                .ok_or_else(|| Error::from_reason("fingerprint task already consumed"))?,
        )
        .map_err(reason)
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        js_value(env, &output)
    }
}

#[napi(js_name = "deriveDocumentFingerprint")]
pub fn derive_document_fingerprint_node(
    env: Env,
    request: Unknown<'_>,
) -> napi::Result<AsyncTask<DeriveDocumentFingerprintTask>> {
    Ok(AsyncTask::new(DeriveDocumentFingerprintTask {
        request: Some(env.from_js_value(request)?),
    }))
}

#[cfg(feature = "legalpdf")]
mod legalpdf_exports {
    use super::*;

    pub struct DeriveDocxDocumentTask {
        bytes: Buffer,
        id: String,
        drafting: bool,
    }

    pub struct DocxTextTask {
        bytes: Buffer,
        drafting: bool,
        limit: Option<u32>,
    }

    pub struct DocxAuthorityTextUnitsTask {
        bytes: Buffer,
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
        bytes: Buffer,
    }

    impl Task for FixDocxSuprasTask {
        type Output = legalpdf::DocxSupraCleanup;
        type JsValue = DocxSupraCleanupNode;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            engine::fix_docx_supra_cross_references(&self.bytes).map_err(reason)
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            Ok(output.into())
        }
    }

    #[napi(js_name = "fixDocxSupraCrossReferences")]
    pub fn fix_docx_supra_cross_references_node(
        bytes: Buffer,
    ) -> napi::Result<AsyncTask<FixDocxSuprasTask>> {
        engine::check_docx_supra_bytes(&bytes).map_err(reason)?;
        Ok(AsyncTask::new(FixDocxSuprasTask { bytes }))
    }

    pub struct HasDocxSuprasTask {
        bytes: Buffer,
    }

    impl Task for HasDocxSuprasTask {
        type Output = bool;
        type JsValue = bool;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            engine::has_docx_supra_references(&self.bytes).map_err(reason)
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            Ok(output)
        }
    }

    #[napi(js_name = "hasDocxSupraReferences")]
    pub fn has_docx_supra_references_node(
        bytes: Buffer,
    ) -> napi::Result<AsyncTask<HasDocxSuprasTask>> {
        engine::check_docx_supra_bytes(&bytes).map_err(reason)?;
        Ok(AsyncTask::new(HasDocxSuprasTask { bytes }))
    }

    impl Task for DeriveDocxDocumentTask {
        type Output = NativeDocument;
        type JsValue = ExternalRef<NativeDocument>;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            engine::derive_docx_document(&self.bytes, std::mem::take(&mut self.id), self.drafting)
                .map_err(reason)
        }

        fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            ExternalRef::new(&env, output)
        }
    }

    #[napi(js_name = "deriveDocxDocument")]
    pub fn derive_docx_document_node(
        bytes: Buffer,
        id: String,
        drafting: Option<bool>,
    ) -> AsyncTask<DeriveDocxDocumentTask> {
        AsyncTask::new(DeriveDocxDocumentTask {
            bytes,
            id,
            drafting: drafting.unwrap_or(false),
        })
    }

    impl Task for DocxTextTask {
        type Output = String;
        type JsValue = String;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            engine::docx_text(&self.bytes, self.drafting, self.limit).map_err(reason)
        }

        fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            Ok(output)
        }
    }

    #[napi(js_name = "docxText")]
    pub fn docx_text_node(
        bytes: Buffer,
        drafting: Option<bool>,
        limit: Option<u32>,
    ) -> AsyncTask<DocxTextTask> {
        AsyncTask::new(DocxTextTask {
            bytes,
            drafting: drafting.unwrap_or(false),
            limit,
        })
    }

    impl Task for DocxAuthorityTextUnitsTask {
        type Output = Vec<serde_json::Value>;
        type JsValue = Unknown<'static>;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            engine::docx_authority_text_units(&self.bytes).map_err(reason)
        }

        fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            js_value(env, &output)
        }
    }

    #[napi(js_name = "docxAuthorityTextUnits")]
    pub fn docx_authority_text_units_node(bytes: Buffer) -> AsyncTask<DocxAuthorityTextUnitsTask> {
        AsyncTask::new(DocxAuthorityTextUnitsTask { bytes })
    }

    pub struct DerivePdfDocumentTask {
        bytes: Buffer,
        request: legalpdf::PdfRequest,
    }

    impl Task for DerivePdfDocumentTask {
        type Output = NativeDocument;
        type JsValue = ExternalRef<NativeDocument>;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            engine::derive_pdf_document(&self.bytes, &self.request).map_err(reason)
        }

        fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            ExternalRef::new(&env, output)
        }
    }

    #[napi(js_name = "derivePdfDocument")]
    pub fn derive_pdf_document_node(
        env: Env,
        bytes: Buffer,
        request: Unknown<'_>,
    ) -> napi::Result<AsyncTask<DerivePdfDocumentTask>> {
        Ok(AsyncTask::new(DerivePdfDocumentTask {
            bytes,
            request: env.from_js_value(request)?,
        }))
    }

    pub struct PreparePdfDocumentTask {
        bytes: Buffer,
        request: legalpdf::PdfRequest,
    }

    impl Task for PreparePdfDocumentTask {
        type Output = legalpdf::PdfSummary;
        type JsValue = Unknown<'static>;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            engine::prepare_pdf_document(&self.bytes, &self.request).map_err(reason)
        }

        fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            js_value(env, &output)
        }
    }

    #[napi(js_name = "preparePdfDocument")]
    pub fn prepare_pdf_document_node(
        env: Env,
        bytes: Buffer,
        request: Unknown<'_>,
    ) -> napi::Result<AsyncTask<PreparePdfDocumentTask>> {
        Ok(AsyncTask::new(PreparePdfDocumentTask {
            bytes,
            request: env.from_js_value(request)?,
        }))
    }

    pub struct RestorePdfDocumentTask {
        request: legalpdf::PdfRequest,
    }

    impl Task for RestorePdfDocumentTask {
        type Output = Option<NativeDocument>;
        type JsValue = Option<ExternalRef<NativeDocument>>;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            engine::restore_pdf_document(&self.request).map_err(reason)
        }

        fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            output
                .map(|document| ExternalRef::new(&env, document))
                .transpose()
        }
    }

    #[napi(js_name = "restorePdfDocument")]
    pub fn restore_pdf_document_node(
        env: Env,
        request: Unknown<'_>,
    ) -> napi::Result<AsyncTask<RestorePdfDocumentTask>> {
        Ok(AsyncTask::new(RestorePdfDocumentTask {
            request: env.from_js_value(request)?,
        }))
    }

    #[napi(js_name = "pdfDocumentSummary")]
    pub fn pdf_document_summary_node(
        env: Env,
        document: &External<NativeDocument>,
    ) -> napi::Result<Unknown<'static>> {
        js_value(env, engine::pdf_document_summary(document).map_err(reason)?)
    }

    #[napi(js_name = "pdfRecognizedText")]
    pub fn pdf_recognized_text_node(
        env: Env,
        document: &External<NativeDocument>,
        pages: Option<Vec<u32>>,
    ) -> napi::Result<Unknown<'static>> {
        js_value(env, &engine::pdf_recognized_text(document, pages).map_err(reason)?)
    }

    #[napi(js_name = "pdfAuthorityTextUnits")]
    pub fn pdf_authority_text_units_node(
        env: Env,
        document: &External<NativeDocument>,
    ) -> napi::Result<Unknown<'static>> {
        js_value(env, &engine::pdf_authority_text_units(document).map_err(reason)?)
    }

    pub struct PdfPassagePagesTask {
        bytes: Buffer,
        job: Option<engine::PdfPassagePagesJob>,
    }

    impl Task for PdfPassagePagesTask {
        type Output = serde_json::Value;
        type JsValue = Unknown<'static>;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            self.job
                .take()
                .ok_or_else(|| Error::from_reason("passage task already consumed"))?
                .compute(&self.bytes)
                .map_err(reason)
        }

        fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
            js_value(env, &output)
        }
    }

    #[napi(js_name = "pdfPassageGeometryPages")]
    pub fn pdf_passage_geometry_pages_node(
        env: Env,
        native: &External<NativeDocument>,
        bytes: Buffer,
        targets: Unknown<'_>,
    ) -> napi::Result<AsyncTask<PdfPassagePagesTask>> {
        let job = engine::pdf_passage_pages_job(native, env.from_js_value(targets)?)
            .map_err(reason)?;
        Ok(AsyncTask::new(PdfPassagePagesTask { bytes, job: Some(job) }))
    }

    #[napi(js_name = "pdfLookupUnitSpans")]
    pub fn pdf_lookup_unit_spans_node(
        env: Env,
        document: &External<NativeDocument>,
        ids: Vec<String>,
    ) -> napi::Result<Unknown<'static>> {
        js_value(env, &engine::pdf_lookup_unit_spans(document, &ids).map_err(reason)?)
    }

    #[allow(clippy::too_many_arguments)]
    #[napi(js_name = "queryPdfDocument")]
    pub fn query_pdf_document_node(
        env: Env,
        document: &External<NativeDocument>,
        locator_kind: String,
        locator: String,
        end_locator: Option<String>,
        context_blocks: Option<u32>,
        page: Option<u32>,
        occurrence: Option<u32>,
    ) -> napi::Result<Unknown<'static>> {
        js_value(
            env,
            &engine::query_pdf_document(
                document, locator_kind, locator, end_locator, context_blocks, page, occurrence,
            )
            .map_err(reason)?,
        )
    }
}

#[napi(js_name = "docxStructureLint")]
pub fn docx_structure_lint_node(
    env: Env,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::docx_structure_lint_json(document).map_err(reason)?)
}

#[napi(js_name = "documentText")]
pub fn document_text_node(document: &External<NativeDocument>, limit: Option<u32>) -> &str {
    engine::document_text(document, limit)
}

#[napi(js_name = "documentTextBytes")]
pub fn document_text_bytes_node(document: &External<NativeDocument>) -> u32 {
    engine::document_text_bytes(document)
}

#[napi(js_name = "documentRevision")]
pub fn document_revision_node(document: &External<NativeDocument>) -> &str {
    engine::document_revision(document)
}

#[napi(js_name = "readDocumentTextWindow")]
pub fn read_document_text_window_node(
    env: Env,
    document: &External<NativeDocument>,
    offset: u32,
    start_char: u32,
    limit: u32,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::read_document_text_window(document, offset, start_char, limit))
}

#[napi(js_name = "readDocumentTextRange")]
pub fn read_document_text_range_node(
    env: Env,
    document: &External<NativeDocument>,
    start: u32,
    end: u32,
    offset: Option<u32>,
    limit: u32,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::read_document_text_range(document, start, end, offset, limit))
}

#[napi(js_name = "documentFingerprint")]
pub fn document_fingerprint_node(
    env: Env,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::document_fingerprint_of(document))
}

#[napi(js_name = "documentAnchors")]
pub fn document_anchors_node(
    env: Env,
    document: &External<NativeDocument>,
    end: Option<u32>,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::document_anchors(document, end))
}

#[napi(js_name = "legalSourceViewer")]
pub fn legal_source_viewer_node(
    env: Env,
    document: &External<NativeDocument>,
    primary_kind: String,
    limit: Option<u32>,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::legal_source_viewer(document, &primary_kind, limit).map_err(reason)?)
}

#[napi(js_name = "documentTableCells")]
pub fn document_table_cells_node(
    env: Env,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::document_table_cells(document))
}

#[napi(js_name = "citationLookupKey")]
pub fn citation_lookup_key_node(text: String) -> String {
    engine::citation_lookup_key_of(&text)
}

#[napi(js_name = "citationLookupKeys")]
pub fn citation_lookup_keys_node(texts: Vec<String>) -> Vec<String> {
    engine::citation_lookup_keys(&texts)
}

#[napi(js_name = "providerCitationsInText")]
pub fn provider_citations_in_text_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::provider_citations(&text))
}

#[napi(js_name = "citationOccurrencesInText")]
pub fn citation_occurrences_in_text_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::citation_occurrences(&text))
}

#[napi(js_name = "authorityReferencesInText")]
pub fn authority_references_in_text_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::authority_references(&text))
}

#[napi(js_name = "caselawCitationLookupKey")]
pub fn caselaw_citation_lookup_key_node(text: String) -> napi::Result<String> {
    engine::caselaw_lookup_key(&text).map_err(reason)
}

#[napi(catch_unwind, js_name = "hasCitationInText")]
pub fn has_citation_in_text_node(text: String) -> napi::Result<bool> {
    engine::has_citation(&text).map_err(reason)
}

#[napi(js_name = "classifyCitatorExcerpt")]
pub fn classify_citator_excerpt_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::citator_excerpt(&text))
}

#[napi(js_name = "classifyCitatorExcerpts")]
pub fn classify_citator_excerpts_node(
    env: Env,
    texts: Vec<String>,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::citator_excerpts(&texts))
}

#[napi(js_name = "groundedProseErrors")]
pub fn grounded_prose_errors_node(
    text: String,
    cited_evidence_ids: Vec<String>,
    visible_evidence: serde_json::Value,
) -> napi::Result<Vec<String>> {
    engine::prose_errors(&text, &cited_evidence_ids, visible_evidence).map_err(reason)
}

#[napi(js_name = "quoteRepairSuggestion")]
pub fn quote_repair_suggestion_node(claim: String, spans: Vec<String>) -> Option<String> {
    engine::quote_repair(&claim, &spans)
}

#[napi(js_name = "markedQuoteSpans")]
pub fn marked_quote_spans_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::quote_spans(&text))
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
    js_value(
        env,
        &engine::read_document_range(document, &kind, &from, &to, context_blocks).map_err(reason)?,
    )
}

#[napi(js_name = "smallestContainingDocumentBlock")]
pub fn smallest_containing_document_block_node(
    env: Env,
    document: &External<NativeDocument>,
    start: u32,
    end: u32,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::smallest_containing_document_block(document, start, end))
}

#[napi(js_name = "textFragmentPlan")]
pub fn text_fragment_plan_node(
    env: Env,
    block_text: String,
    quotes: Vec<String>,
    pdf: bool,
    publisher_may_annotate_legal_reference: bool,
    split_html_source_blocks: bool,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    js_value(
        env,
        &engine::document_text_fragment_plan(
            document,
            &block_text,
            &quotes,
            pdf,
            publisher_may_annotate_legal_reference,
            split_html_source_blocks,
        ),
    )
}

#[napi(js_name = "textFragmentPlanStandalone")]
pub fn text_fragment_plan_standalone_node(
    env: Env,
    block_text: String,
    quotes: Vec<String>,
    pdf: bool,
    publisher_may_annotate_legal_reference: bool,
    split_html_source_blocks: bool,
) -> napi::Result<Unknown<'static>> {
    js_value(
        env,
        &engine::text_fragment_plan_standalone(
            &block_text,
            &quotes,
            pdf,
            publisher_may_annotate_legal_reference,
            split_html_source_blocks,
        ),
    )
}

#[napi(js_name = "documentParagraphRangeDirective")]
pub fn document_paragraph_range_directive_node(
    document: &External<NativeDocument>,
    start: String,
    end: String,
) -> Option<String> {
    engine::document_paragraph_range_directive(document, &start, &end)
}

#[napi(js_name = "lookupStructureBlock")]
pub fn lookup_structure_block_node(
    env: Env,
    document: &External<NativeDocument>,
    locator: String,
    context_blocks: u32,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &engine::lookup_structure_block(document, &locator, context_blocks))
}

#[napi(js_name = "resolveDocumentAddressSpans")]
pub fn resolve_document_address_spans_node(
    env: Env,
    document: &External<NativeDocument>,
    spec: String,
    follow: String,
    depth: u32,
) -> napi::Result<Unknown<'static>> {
    js_value(
        env,
        &engine::resolve_document_address_spans(document, &spec, &follow, depth).map_err(reason)?,
    )
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
    js_value(
        env,
        &engine::graph_scope(document, &seed_label, &follow, depth, include_descendants, include_units)
            .map_err(reason)?,
    )
}

#[napi(js_name = "documentHasOrigin")]
pub fn document_has_origin_node(
    document: &External<NativeDocument>,
    origin: String,
) -> napi::Result<bool> {
    engine::document_has_origin(document, &origin).map_err(reason)
}
