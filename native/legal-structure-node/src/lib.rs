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

enum NativeProduct {
    Structure(DocumentStructure),
    #[cfg(feature = "legalpdf")]
    Pdf(legalpdf::PdfDocument),
}

pub struct NativeDocument {
    product: NativeProduct,
    query: DocumentQuery,
}

impl NativeDocument {
    fn structure(&self) -> &DocumentStructure {
        match &self.product {
            NativeProduct::Structure(structure) => structure,
            #[cfg(feature = "legalpdf")]
            NativeProduct::Pdf(document) => document.structure(),
        }
    }
}

#[napi(js_name = "nativeBuildFeatures")]
pub fn native_build_features_node() -> &'static str {
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

fn analyze_request(request: StructureRequest) -> napi::Result<NativeDocument> {
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
            let file =
                File::open(filename).map_err(|error| Error::from_reason(error.to_string()))?;
            journal_document_structure(article_id, url, BufReader::new(file), &page_rows)
        } else if let Some(text) = text {
            journal_text_document_structure(article_id, url, text, &page_rows)
        } else {
            return Err(Error::from_reason(
                "journal request requires filename or text",
            ));
        }
        .map_err(native_error)?,
    };
    Ok(NativeDocument {
        product: NativeProduct::Structure(structure),
        query: DocumentQuery::new(),
    })
}

pub struct DeriveDocumentTask {
    request: Option<StructureRequest>,
}

impl Task for DeriveDocumentTask {
    type Output = NativeDocument;
    type JsValue = ExternalRef<NativeDocument>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        analyze_request(
            self.request
                .take()
                .ok_or_else(|| Error::from_reason("document task already consumed"))?,
        )
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
    type Output = DocumentFingerprint;
    type JsValue = Unknown<'static>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let document = analyze_request(
            self.request
                .take()
                .ok_or_else(|| Error::from_reason("fingerprint task already consumed"))?,
        )?;
        Ok(document_fingerprint(document.structure()))
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
    use std::collections::HashSet;

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

    fn docx_supra_bytes(bytes: Buffer) -> napi::Result<Buffer> {
        if bytes.is_empty() || bytes.len() > legalpdf::MAX_DOCX_SUPRA_BYTES {
            return Err(Error::from_reason(
                "DOCX is empty or exceeds the read limit",
            ));
        }
        Ok(bytes)
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
        bytes: Buffer,
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
            let id = std::mem::take(&mut self.id);
            let structure = if self.drafting {
                legalpdf::analyze_docx_drafting_bytes(&self.bytes, id)
            } else {
                legalpdf::analyze_docx_bytes(&self.bytes, id)
            }
            .map_err(|error| Error::from_reason(error.to_string()))?;
            Ok(NativeDocument {
                product: NativeProduct::Structure(structure),
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
            let mut text = legalpdf::docx_text(&self.bytes, self.drafting)
                .map_err(|error| Error::from_reason(error.to_string()))?;
            if let Some(limit) = self.limit {
                let end = utf16_prefix_ceil(&text, limit as usize).len();
                text.truncate(end);
            }
            Ok(text)
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
            legalpdf::docx_to_toa_text_units(&self.bytes)
                .map_err(|error| Error::from_reason(error.to_string()))
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
            legalpdf::derive_pdf_document(&self.bytes, &self.request)
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
            legalpdf::prepare_pdf_document(&self.bytes, &self.request)
                .map_err(|error| Error::from_reason(error.to_string()))
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
            legalpdf::restore_pdf_document(&self.request)
                .map(|document| {
                    document.map(|document| NativeDocument {
                        product: NativeProduct::Pdf(document),
                        query: DocumentQuery::new(),
                    })
                })
                .map_err(|error| Error::from_reason(error.to_string()))
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
        let NativeProduct::Pdf(document) = &document.product else {
            return Err(Error::from_reason("PDF summary requires a PDF document"));
        };
        js_value(env, &legalpdf::pdf_document_summary(document))
    }

    #[napi(js_name = "pdfAuthorityTextUnits")]
    pub fn pdf_authority_text_units_node(
        env: Env,
        document: &External<NativeDocument>,
    ) -> napi::Result<Unknown<'static>> {
        let NativeProduct::Pdf(document) = &document.product else {
            return Err(Error::from_reason(
                "PDF authority text units require a PDF document",
            ));
        };
        js_value(env, &document.authority_text_units())
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PassageTarget {
        id: String,
        locator_kind: String,
        locator: String,
    }

    struct PassagePlan {
        id: String,
        page: bool,
        status: legalpdf::PdfLookupStatus,
        pages: Vec<u32>,
        lines: Vec<String>,
    }

    // A citation's printed [29] is not necessarily the parser's 29th paragraph.
    // Resolve it to complete native prose nodes, including continuation nodes, not
    // just the line bearing the number. Never choose among duplicate printed labels.
    fn printed_paragraph_plan(document: &legalpdf::PdfDocument, locator: &str)
        -> Option<(legalpdf::PdfLookupStatus, Vec<String>, Vec<u32>)>
    {
        use legal_structure::{NodeKind, ScalarText};
        let text = ScalarText::new(document.structure().query_text());
        let nodes = document.structure().nodes.iter()
            .filter(|node| node.kind == NodeKind::Prose && !node.line_ids.is_empty())
            .collect::<Vec<_>>();
        let labels = nodes.iter().enumerate().filter_map(|(index, node)| {
            let range = node.rendered_range?;
            let value = text.slice_utf16(range.start..range.end)?.trim_start();
            let (number, rest) = value.strip_prefix('[')?.split_once(']')?;
            if !rest.starts_with(char::is_whitespace) || !number.chars().all(|c| c.is_ascii_digit()) { return None; }
            Some((number.parse::<usize>().ok()?, index))
        }).collect::<Vec<_>>();
        if labels.is_empty() { return None; }
        let range = legal_pdf_support::numeric_range("paragraph", locator)
            .or_else(|| legal_pdf_support::parse_ordinal("paragraph", locator).map(|n| (n, n)));
        let Some((from, to)) = range.filter(|(a, b)| a <= b && b - a < 100) else {
            return Some((legalpdf::PdfLookupStatus::Invalid, vec![], vec![]));
        };
        let mut lines = Vec::new();
        let mut pages = Vec::new();
        for number in from..=to {
            let hits = labels.iter().filter(|(label, _)| *label == number).collect::<Vec<_>>();
            if hits.len() != 1 {
                return Some((if hits.is_empty() { legalpdf::PdfLookupStatus::NotFound }
                    else { legalpdf::PdfLookupStatus::Ambiguous }, vec![], vec![]));
            }
            let start = hits[0].1;
            // A following printed paragraph is an explicit end boundary. At EOF,
            // retain only the native paragraph rather than swallowing unnumbered end matter.
            let end = labels.iter().find(|(_, index)| *index > start).map_or(start + 1, |(_, index)| *index);
            for node in &nodes[start..end] {
                lines.extend(node.line_ids.iter().cloned());
                pages.extend(node.page_indexes.iter().map(|index| *index as u32 + 1));
            }
        }
        Some((legalpdf::PdfLookupStatus::Found, lines, pages))
    }

    pub struct PdfPassagePagesTask {
        bytes: Buffer,
        summary: legalpdf::PdfSummary,
        plans: Option<Vec<PassagePlan>>,
    }

    impl Task for PdfPassagePagesTask {
        type Output = serde_json::Value;
        type JsValue = Unknown<'static>;

        fn compute(&mut self) -> napi::Result<Self::Output> {
            let pdf = legal_pdf_extraction::extract_pdf(&self.bytes, None, None)
                .map_err(|error| Error::from_reason(error.to_string()))?;
            let unavailable = pdf
                .metadata
                .pages_needing_ocr
                .iter()
                .copied()
                .chain(pdf.metadata.ocr_routed_pages.iter().copied())
                .collect::<HashSet<_>>();
            let targets = self
                .plans
                .take()
                .unwrap()
                .into_iter()
                .map(|plan| {
                    let selected = plan
                        .lines
                        .iter()
                        .map(String::as_str)
                        .collect::<HashSet<_>>();
                    let selected_pages = pdf
                        .pages
                        .iter()
                        .filter(|page| {
                            page.lines
                                .iter()
                                .any(|line| selected.contains(line.id.as_str()))
                        })
                        .map(|page| page.number)
                        .collect::<HashSet<_>>();
                    let pages = pdf
                        .pages
                        .iter()
                        .filter(|page| {
                            plan.pages.contains(&page.number)
                                || selected_pages.contains(&page.number)
                        })
                        .map(|page| {
                            let available =
                                page.source == "native" && !unavailable.contains(&page.index);
                            let lines = page
                                .lines
                                .iter()
                                .filter(|line| {
                                    (plan.page && selected.is_empty())
                                        || selected.contains(line.id.as_str())
                                })
                                .collect::<Vec<_>>();
                            serde_json::json!({
                                "pageNumber": page.number,
                                "width": page.width,
                                "height": page.height,
                                "source": if available { "native" } else { "unavailable" },
                                "lines": if available { lines.iter().map(|line| serde_json::json!({
                                    "id": line.id,
                                    "rect": line.bbox,
                                    "words": line.words.iter().map(|word| serde_json::json!({
                                        "text": word.text, "rect": word.bbox
                                    })).collect::<Vec<_>>()
                                })).collect::<Vec<_>>() } else { Vec::new() }
                            })
                        })
                        .collect::<Vec<_>>();
                    serde_json::json!({ "id": plan.id, "status": plan.status, "pages": pages })
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
        let NativeProduct::Pdf(document) = &native.product else {
            return Err(Error::from_reason(
                "PDF passage geometry requires a PDF document",
            ));
        };
        let targets: Vec<PassageTarget> = env.from_js_value(targets)?;
        let plans = targets
            .into_iter()
            .map(|target| {
                if target.locator_kind == "paragraph" {
                    if let Some((status, lines, pages)) = printed_paragraph_plan(document, &target.locator) {
                        return PassagePlan { id: target.id, page: false, status, pages, lines };
                    }
                }
                let lookup = document.lookup(&legalpdf::PdfLookupRequest::new(
                    &target.locator_kind,
                    &target.locator,
                ));
                let lines = lookup
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
                if pages.is_empty() && target.locator_kind == "page" {
                    pages.extend(
                        legal_pdf_support::parse_ordinal("page", &target.locator)
                            .filter(|page| *page <= document.page_count())
                            .map(|page| page as u32),
                    );
                }
                PassagePlan {
                    id: target.id,
                    page: target.locator_kind == "page",
                    status: lookup.status,
                    pages,
                    lines,
                }
            })
            .collect();
        Ok(AsyncTask::new(PdfPassagePagesTask {
            bytes,
            summary: document.summary().clone(),
            plans: Some(plans),
        }))
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

#[napi(js_name = "documentText")]
pub fn document_text_node(document: &External<NativeDocument>, limit: Option<u32>) -> &str {
    let text = document.structure().query_text();
    limit.map_or(text, |limit| utf16_prefix_ceil(text, limit as usize))
}

#[napi(js_name = "documentTextBytes")]
pub fn document_text_bytes_node(document: &External<NativeDocument>) -> u32 {
    document.structure().query_text().len() as u32
}

#[napi(js_name = "documentRevision")]
pub fn document_revision_node(document: &External<NativeDocument>) -> &str {
    &document.structure().revision
}

#[napi(js_name = "readDocumentTextWindow")]
pub fn read_document_text_window_node(
    env: Env,
    document: &External<NativeDocument>,
    offset: u32,
    start_char: u32,
    limit: u32,
) -> napi::Result<Unknown<'static>> {
    js_value(
        env,
        &document.query.text_window(
            document.structure(),
            offset as usize,
            start_char as usize,
            limit as usize,
        ),
    )
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
    js_value(
        env,
        &document.query.text_range_window(
            document.structure(),
            start as usize,
            end as usize,
            offset.map(|value| value as usize),
            limit as usize,
        ),
    )
}

#[napi(js_name = "documentFingerprint")]
pub fn document_fingerprint_node(
    env: Env,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    let fingerprint = match &document.product {
        NativeProduct::Structure(structure) => document_fingerprint(structure),
        #[cfg(feature = "legalpdf")]
        NativeProduct::Pdf(document) => document.fingerprint(),
    };
    js_value(env, &fingerprint)
}

#[napi(js_name = "documentAnchors")]
pub fn document_anchors_node(
    env: Env,
    document: &External<NativeDocument>,
    end: Option<u32>,
) -> napi::Result<Unknown<'static>> {
    let structure = document.structure();
    js_value(
        env,
        &document
            .query
            .anchors(structure, end.map(|value| value as usize))
            .collect::<Vec<_>>(),
    )
}

#[napi(js_name = "legalSourceViewer")]
pub fn legal_source_viewer_node(
    env: Env,
    document: &External<NativeDocument>,
    primary_kind: String,
    limit: Option<u32>,
) -> napi::Result<Unknown<'static>> {
    js_value(
        env,
        &document.query.viewer(
            document.structure(),
            document_kind(&primary_kind)?,
            limit.map_or(u32::MAX as usize, |value| value as usize),
        ),
    )
}

#[napi(js_name = "documentTableCells")]
pub fn document_table_cells_node(
    env: Env,
    document: &External<NativeDocument>,
) -> napi::Result<Unknown<'static>> {
    js_value(env, &document.query.table_cells(document.structure()))
}

#[napi(js_name = "citationLookupKey")]
pub fn citation_lookup_key_node(text: String) -> String {
    citation_lookup_key(&text)
}

#[napi(js_name = "citationLookupKeys")]
pub fn citation_lookup_keys_node(texts: Vec<String>) -> Vec<String> {
    texts.iter().map(|text| citation_lookup_key(text)).collect()
}

#[napi(js_name = "providerCitationsInText")]
pub fn provider_citations_in_text_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &provider_citations_in_text(&text))
}

#[napi(js_name = "citationOccurrencesInText")]
pub fn citation_occurrences_in_text_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &citation_occurrences_in_text(&text))
}

#[napi(js_name = "authorityReferencesInText")]
pub fn authority_references_in_text_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &authority_references_in_text(&text))
}

#[napi(js_name = "caselawCitationLookupKey")]
pub fn caselaw_citation_lookup_key_node(text: String) -> napi::Result<String> {
    caselaw_citation_lookup_key(&text).map_err(Error::from_reason)
}

#[napi(catch_unwind, js_name = "hasCitationInText")]
pub fn has_citation_in_text_node(text: String) -> napi::Result<bool> {
    has_citation_in_text(&text).map_err(Error::from_reason)
}

#[napi(js_name = "classifyCitatorExcerpt")]
pub fn classify_citator_excerpt_node(env: Env, text: String) -> napi::Result<Unknown<'static>> {
    js_value(env, &classify_citator_excerpt(&text))
}

#[napi(js_name = "classifyCitatorExcerpts")]
pub fn classify_citator_excerpts_node(
    env: Env,
    texts: Vec<String>,
) -> napi::Result<Unknown<'static>> {
    js_value(
        env,
        &texts
            .iter()
            .map(|text| classify_citator_excerpt(text))
            .collect::<Vec<_>>(),
    )
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
        &document.query.read_range(
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
        &document.query.smallest_containing_block(
            document.structure(),
            start as usize,
            end as usize,
        ),
    )
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
    let plan = document.query.text_fragment_plan(
        document.structure(),
        &block_text,
        &quotes,
        pdf,
        publisher_may_annotate_legal_reference,
        split_html_source_blocks,
    );
    js_value(env, &plan)
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
        &text_fragment_plan(
            &block_text,
            None,
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
    document
        .query
        .paragraph_range_directive(document.structure(), &start, &end)
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
            .query
            .structure_block(document.structure(), &locator, context_blocks as usize),
    )
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
        &document.query.resolve_address_spans(
            document.structure(),
            &spec,
            follow_direction(&follow)?,
            depth as usize,
        ),
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
    let follow = follow_direction(&follow)?;
    let structure = document.structure();
    js_value(
        env,
        &structure
            .cross_references
            .as_ref()
            .filter(|graph| !graph.document_abstained)
            .and_then(|graph| {
                document.query.graph_scope(
                    structure,
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
    Ok(document.query.has_origin(document.structure(), origin))
}

#[cfg(feature = "legalpdf")]
fn pdf_lookup_unit_spans(
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

#[cfg(feature = "legalpdf")]
#[napi(js_name = "pdfLookupUnitSpans")]
pub fn pdf_lookup_unit_spans_node(
    env: Env,
    document: &External<NativeDocument>,
    ids: Vec<String>,
) -> napi::Result<Unknown<'static>> {
    let NativeProduct::Pdf(pdf) = &document.product else {
        return Err(Error::from_reason("PDF query requires a PDF document"));
    };
    js_value(env, &pdf_lookup_unit_spans(pdf.structure(), &ids))
}

#[cfg(feature = "legalpdf")]
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
    let NativeProduct::Pdf(pdf) = &document.product else {
        return Err(Error::from_reason("PDF query requires a PDF document"));
    };
    js_value(
        env,
        &legalpdf::query_pdf_document(
            pdf,
            &legalpdf::PdfLookupRequest {
                locator_kind,
                locator,
                end_locator,
                context_blocks: context_blocks.unwrap_or(0) as usize,
                page,
                occurrence: occurrence.map(|value| value as usize),
            },
        ),
    )
}

fn native_error(error: legal_structure::EngineError) -> Error {
    Error::from_reason(error.to_string())
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
        let spans = pdf_lookup_unit_spans(
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
