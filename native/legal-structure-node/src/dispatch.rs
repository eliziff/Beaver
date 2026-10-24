//! Every engine operation behind one call, named as the engine's JavaScript surface names it.
//! Node's addon and the browser's WebAssembly runtime both call it, so an operation is
//! written once.
//!
//! A request is `[u32 json length][json {op, args}][bytes]`; the reply is
//! `[u8 ok][u32 json length][json][bytes]`, the json being the result or the error.

use crate::a2aj;
use crate::engine::{self, CoreResult, NativeDocument};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Reports OCR progress, `(recognized, total)` pages.
pub type Progress<'a> = Option<&'a (dyn Fn(usize, usize) + Sync)>;

/// Documents live here behind numeric handles until their holder releases them. Calls run on
/// several threads in Node, so a document is shared, not borrowed from the table.
static DOCUMENTS: Mutex<(u32, BTreeMap<u32, Arc<NativeDocument>>)> = Mutex::new((0, BTreeMap::new()));

fn documents() -> std::sync::MutexGuard<'static, (u32, BTreeMap<u32, Arc<NativeDocument>>)> {
    DOCUMENTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn store(document: NativeDocument) -> Value {
    share(Arc::new(document))
}

/// A handle of its own to a document the engine keeps elsewhere too.
fn share(document: Arc<NativeDocument>) -> Value {
    let mut documents = documents();
    documents.0 += 1;
    let handle = documents.0;
    documents.1.insert(handle, document);
    json!({ "handle": handle })
}

fn with_document<T>(handle: u32, operation: impl FnOnce(&NativeDocument) -> CoreResult<T>) -> CoreResult<T> {
    let document = documents().1.get(&handle).cloned().ok_or("document handle was released")?;
    operation(&document)
}

struct Call {
    args: Value,
}

impl Call {
    fn get<T: DeserializeOwned>(&self, name: &str) -> CoreResult<T> {
        serde_json::from_value(self.args.get(name).cloned().unwrap_or(Value::Null))
            .map_err(|error| format!("invalid argument {name}: {error}"))
    }
    fn document(&self) -> CoreResult<u32> {
        self.get("document")
    }
}

fn value(output: impl Serialize) -> CoreResult<Value> {
    serde_json::to_value(output).map_err(|error| error.to_string())
}

fn dispatch(op: &str, call: &Call, bytes: &[u8], progress: Progress) -> CoreResult<(Value, Vec<u8>)> {
    let done = |output: CoreResult<Value>| output.map(|output| (output, Vec::new()));
    let doc = || call.document();
    match op {
        "nativeBuildFeatures" => done(value(engine::native_build_features())),
        "structureCompositionBlocks" => done(legal_structure::structure_composition_blocks(call.get("request")?).and_then(value)),
        "applyStructureComposition" => done(legal_structure::apply_structure_composition(call.get("request")?).and_then(value)),
        "resolveCompositionAnnotations" => done(legal_structure::resolve_composition_annotations(call.get("request")?).and_then(value)),
        "releaseDocument" => {
            let handle = doc()?;
            documents().1.remove(&handle);
            done(Ok(Value::Null))
        }
        "deriveDocumentStructure" => done(engine::derive_document_structure(call.get("request")?).map(store)),
        "deriveDocumentFingerprint" => done(engine::derive_document_fingerprint(call.get("request")?).and_then(value)),
        #[cfg(feature = "legalpdf")]
        "fixDocxSupraCrossReferences" => {
            let result = engine::fix_docx_supra_cross_references(bytes)?;
            Ok((json!({
                "detected": result.detected, "converted": result.converted,
                "already_linked": result.already_linked, "review_required": result.review_required,
                "bookmarks_added": result.bookmarks_added,
                "reasons": { "restarted_numbering": result.restarted_numbering,
                    "unsafe_or_split_fields": result.unsafe_or_split_fields },
            }), result.bytes))
        }
        #[cfg(feature = "legalpdf")]
        "hasDocxSupraReferences" => done(engine::has_docx_supra_references(bytes).and_then(value)),
        #[cfg(feature = "legalpdf")]
        "deriveDocxDocument" => done(engine::derive_docx_document(
            bytes, call.get("id")?, call.get::<Option<bool>>("drafting")?.unwrap_or(false)).map(store)),
        #[cfg(feature = "legalpdf")]
        "docxText" => done(engine::docx_text(
            bytes, call.get::<Option<bool>>("drafting")?.unwrap_or(false), call.get("limit")?).and_then(value)),
        #[cfg(feature = "legalpdf")]
        "docxAuthorityTextUnits" => done(engine::docx_authority_text_units(bytes).and_then(value)),
        #[cfg(feature = "legalpdf")]
        "derivePdfDocument" => done(engine::derive_pdf_document(bytes, &call.get("request")?).map(store)),
        #[cfg(feature = "legalpdf")]
        "preparePdfDocument" => done(engine::prepare_pdf_document(bytes, &call.get("request")?, progress).and_then(value)),
        #[cfg(feature = "legalpdf")]
        "restorePdfDocument" => done(engine::restore_pdf_document(&call.get("request")?)
            .map(|document| document.map(store).unwrap_or(Value::Null))),
        #[cfg(feature = "legalpdf")]
        "pdfDocumentSummary" => done(with_document(doc()?, |d| engine::pdf_document_summary(d).and_then(value))),
        #[cfg(feature = "legalpdf")]
        "pdfRecognizedText" => done(with_document(doc()?, |d|
            engine::pdf_recognized_text(d, call.get("pages")?).and_then(value))),
        #[cfg(feature = "legalpdf")]
        "pdfPageLabels" => done(with_document(doc()?, |d|
            engine::pdf_page_labels(d).and_then(value))),
        #[cfg(feature = "legalpdf")]
        "pdfPageTexts" => done(with_document(doc()?, |d| engine::pdf_page_texts(d).and_then(value))),
        #[cfg(feature = "legalpdf")]
        "pdfAuthorityTextUnits" => done(with_document(doc()?, |d|
            engine::pdf_authority_text_units(d).and_then(value))),
        #[cfg(feature = "legalpdf")]
        "pdfPassageGeometryPages" => {
            let job = with_document(doc()?, |d| engine::pdf_passage_pages_job(d, call.get("targets")?))?;
            done(job.compute())
        }
        #[cfg(feature = "legalpdf")]
        "pdfLookupUnitSpans" => done(with_document(doc()?, |d|
            engine::pdf_lookup_unit_spans(d, &call.get::<Vec<String>>("ids")?).and_then(value))),
        #[cfg(feature = "legalpdf")]
        "queryPdfDocument" => done(with_document(doc()?, |d| engine::query_pdf_document(
            d, call.get("locatorKind")?, call.get("locator")?, call.get("endLocator")?,
            call.get("contextBlocks")?, call.get("page")?, call.get("occurrence")?).and_then(value))),
        "docxStructureLint" => done(with_document(doc()?, |d| engine::docx_structure_lint_json(d).and_then(value))),
        "documentText" => done(with_document(doc()?, |d| value(engine::document_text(d, call.get("limit")?)))),
        "documentTextBytes" => done(with_document(doc()?, |d| value(engine::document_text_bytes(d)))),
        "documentRevision" => done(with_document(doc()?, |d| value(engine::document_revision(d)))),
        "readDocumentTextWindow" => done(with_document(doc()?, |d| value(engine::read_document_text_window(
            d, call.get("offset")?, call.get("startChar")?, call.get("limit")?)))),
        "readDocumentTextRange" => done(with_document(doc()?, |d| value(engine::read_document_text_range(
            d, call.get("start")?, call.get("end")?, call.get("offset")?, call.get("limit")?, call.get("startChar")?)))),
        "documentFingerprint" => done(with_document(doc()?, |d| value(engine::document_fingerprint_of(d)))),
        "documentAnchors" => done(with_document(doc()?, |d| value(engine::document_anchors(d, call.get("end")?)))),
        "legalSourceViewer" => done(with_document(doc()?, |d| engine::legal_source_viewer(
            d, &call.get::<String>("primaryKind")?, call.get("limit")?).and_then(value))),
        "statuteOutline" => done(engine::statute_outline(&call.get::<String>("text")?,
            call.get::<Option<bool>>("articles")?.unwrap_or(false)).and_then(value)),
        "caseOutline" => done(engine::case_outline(&call.get::<String>("text")?).and_then(value)),
        "statuteProvisionSpans" => done(legal_structure::statute_provision_spans(&call.get::<String>("text")?,
            &call.get::<Vec<String>>("labels")?).map_err(|error| error.to_string()).and_then(value)),
        "statuteCurrency" => done(value(legal_structure::statute_currency(&call.get::<Vec<String>>("pages")?))),
        "filingCover" => done(value(legal_structure::filing_cover(&call.get::<String>("opening")?,
            call.get::<Option<String>>("title")?.as_deref()))),
        "documentCaseOutline" => done(with_document(doc()?, |d|
            engine::case_outline(engine::document_text(d, None)).and_then(value))),
        "documentOutline" => done(with_document(doc()?, |d| value(engine::document_outline(
            d, call.get::<Option<bool>>("legislation")?.unwrap_or(false))))),
        "sourceMarkup" => done(with_document(doc()?, |d| value(engine::source_markup(d)))),
        "sourceParagraphMarkers" => done(with_document(doc()?, |d| value(engine::source_paragraph_markers(d)))),
        "sourceParagraphMarker" => done(with_document(doc()?, |d| value(engine::source_paragraph_marker(d, call.get("markupStart")?)))),
        "sourceOpinionComponents" => done(with_document(doc()?, |d| value(engine::source_opinion_components(d)))),
        "documentTableCells" => done(with_document(doc()?, |d| value(engine::document_table_cells(d)))),
        "citationLookupKey" => done(value(engine::citation_lookup_key_of(&call.get::<String>("text")?))),
        // The same call, which JavaScript runs off its thread.
        "citationEngineCall" | "citationEngineCallAsync" => done(engine::citation_engine_call(
            &call.get::<String>("method")?, &call.get::<String>("request")?)),
        "documentReadingOrder" => done(engine::document_reading_order(&call.get::<String>("request")?).and_then(value)),
        "citationLookupKeys" => done(value(engine::citation_lookup_keys(&call.get::<Vec<String>>("texts")?))),
        "providerCitationsInText" => done(value(engine::provider_citations(&call.get::<String>("text")?))),
        "canliiCaseUrl" => done(value(legal_structure::canlii_case_url(&call.get::<Vec<String>>("citations")?,
            &call.get::<Option<String>>("language")?.unwrap_or_default(), call.get::<Option<String>>("court")?.as_deref()))),
        "canliiLawUrl" => done(value(legal_structure::canlii_law_url(&call.get::<String>("text")?,
            &call.get::<Option<String>>("language")?.unwrap_or_default(),
            call.get::<Option<bool>>("consolidated")?.unwrap_or(false)))),
        // A passage's links on a source's page, planned against the document (legal-structure passage_links).
        "passageLink" => done(with_document(doc()?, |d| value(legal_structure::passage_link(
            &d.query, d.structure(), &call.get::<legal_structure::PassageLinkRequest>("request")?)))),
        "citedPassageLink" => done(with_document(doc()?, |d| value(legal_structure::cited_passage_link(
            &d.query, d.structure(), &call.get::<String>("url")?, &call.get::<Vec<String>>("pinpoints")?)))),
        // Every link a passage of an A2AJ document can take, and the one routed best.
        "sourceLinks" => done(with_document(doc()?, |d| value(legal_structure::source_links(
            &d.query, d.structure(), &call.get::<legal_structure::SourceLinksRequest>("request")?)))),
        "lawWebLink" => done(with_document(doc()?, |d| value(legal_structure::law_web_link(&d.query, d.structure(),
            &call.get::<String>("citation")?, &call.get::<String>("docType")?, &call.get::<String>("blockText")?,
            &call.get::<Vec<String>>("quotes")?)))),
        "canliiCourtRoute" => done(value(legal_structure::canlii_court_route(&call.get::<String>("court")?))),
        "citationOccurrencesInText" => done(value(engine::citation_occurrences(&call.get::<String>("text")?))),
        "authorityReferencesInText" => done(value(engine::authority_references(&call.get::<String>("text")?))),
        "caselawCitationLookupKey" => done(engine::caselaw_lookup_key(&call.get::<String>("text")?).and_then(value)),
        "hasCitationInText" => done(engine::has_citation(&call.get::<String>("text")?).and_then(value)),
        "groundedProseErrors" => done(engine::prose_errors(
            &call.get::<String>("text")?, &call.get::<Vec<String>>("citedEvidenceIds")?,
            call.get("visibleEvidence")?).and_then(value)),
        "quoteRepairSuggestion" => done(value(engine::quote_repair(
            &call.get::<String>("claim")?, &call.get::<Vec<String>>("spans")?))),
        "markedQuoteSpans" => done(value(engine::quote_spans(&call.get::<String>("text")?))),
        "textUnits" => done(value(legal_structure::text_units(&call.get::<String>("text")?,
            call.get::<bool>("sentences")?))),
        "journalTitleSearches" => done(value(legal_structure::journal_title_searches(&call.get::<String>("citation")?))),
        "journalTitleChoice" => done(value(legal_structure::journal_title_choice(
            &call.get::<Vec<legal_structure::JournalTitleHit>>("hits")?))),
        "quoteComparison" => done(value(legal_structure::quote_text_comparison(
            &call.get::<String>("authored")?, &call.get::<String>("source")?))),
        "editorialQuote" => done(value(legal_structure::editorial_quote(
            &call.get::<String>("authored")?, &call.get::<String>("source")?))),
        "verbatimRepair" => done(value(legal_structure::verbatim_repair(
            &call.get::<String>("authored")?, &call.get::<String>("source")?))),
        "quoteLocateDocument" => done(with_document(doc()?, |d| engine::quote_locate_document(
            d, call.get::<legal_structure::QuoteSource>("source")?,
            &call.get::<Vec<legal_structure::QuoteToLocate>>("quotes")?, call.get::<Option<bool>>("compare")?.unwrap_or(true)).and_then(value))),
        "a2ajDocument" => done(a2aj::document(&call.get::<PathBuf>("store")?, &call.get("lookup")?)
            .map(|found| found.map_or(Value::Null, |found| json!({ "metadata": found.metadata,
                "native": share(found.native), "searchNative": found.search.map(share) })))),
        "a2ajSection" => done(a2aj::section(&call.get::<PathBuf>("store")?, &call.get("lookup")?,
            &call.get::<String>("section")?, call.get("excerpt")?)
            .map(|found| found.map_or(Value::Null, |native| json!({ "native": native.map(share) })))),
        "a2ajAliasGroups" => done(a2aj::alias_groups(&call.get::<PathBuf>("store")?,
            &call.get::<Vec<String>>("citations")?).and_then(value)),
        "a2ajNamedCase" => done(a2aj::named_case(&call.get::<PathBuf>("store")?, &call.get("named")?).and_then(value)),
        "a2ajNameKeys" => done(value(call.get::<Vec<String>>("names")?.iter().map(|name| a2aj::name_key(name))
            .collect::<Vec<_>>())),
        "citatorNoteUp" => {
            let mut request: legal_structure::citator_graph::NoteUpRequest = call.get("request")?;
            let store = call.get::<PathBuf>("store")?;
            request.keys = a2aj::alias_keys(&store, &request.citation)?;
            done(legal_structure::citator_graph::note_up(&store, &request)
                .map_err(|error| error.to_string()).and_then(value))
        }
        "citatorMetrics" => done(legal_structure::citator_graph::authority_metrics(&call.get::<PathBuf>("store")?,
            &call.get::<Vec<String>>("citations")?).map_err(|error| error.to_string()).and_then(value)),
        "readDocumentRange" => done(with_document(doc()?, |d| engine::read_document_range(
            d, &call.get::<String>("kind")?, &call.get::<String>("from")?, &call.get::<String>("to")?,
            call.get("contextBlocks")?).and_then(value))),
        "smallestContainingDocumentBlock" => done(with_document(doc()?, |d| value(
            engine::smallest_containing_document_block(d, call.get("start")?, call.get("end")?)))),
        "lookupStructureBlock" => done(with_document(doc()?, |d| engine::lookup_structure_block(
            d, call.get("locator")?, call.get("contextBlocks")?).and_then(value))),
        "resolveDocumentAddressSpans" => done(with_document(doc()?, |d| engine::resolve_document_address_spans(
            d, &call.get::<String>("spec")?, &call.get::<String>("follow")?, call.get("depth")?).and_then(value))),
        "graphScope" => done(with_document(doc()?, |d| engine::graph_scope(
            d, &call.get::<legal_structure::GraphScopeSeed>("seed")?, &call.get::<String>("follow")?, call.get("depth")?,
            call.get("includeDescendants")?, call.get("includeUnits")?).and_then(value))),
        "documentHasOrigin" => done(with_document(doc()?, |d|
            engine::document_has_origin(d, &call.get::<String>("origin")?).and_then(value))),
        _ => Err(format!("unknown engine operation {op}")),
    }
}

/// Runs one framed request and frames its reply. A panic is reported as the call's error.
pub fn call(request: &[u8], progress: Progress) -> Vec<u8> {
    engine::install_structure_analysis();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> CoreResult<(Value, Vec<u8>)> {
        let header = request.get(..4).ok_or("truncated engine request")?;
        let json_length = u32::from_le_bytes(header.try_into().unwrap()) as usize;
        let json = request.get(4..4 + json_length).ok_or("truncated engine request")?;
        let parsed: Value = serde_json::from_slice(json).map_err(|error| error.to_string())?;
        let op = parsed.get("op").and_then(Value::as_str).ok_or("engine request lacks op")?.to_owned();
        let call = Call { args: parsed.get("args").cloned().unwrap_or(Value::Null) };
        dispatch(&op, &call, &request[4 + json_length..], progress)
    }));
    let (ok, json, bytes) = match result {
        Ok(Ok((output, bytes))) => (true, serde_json::to_vec(&output).unwrap_or_default(), bytes),
        Ok(Err(error)) => (false, error.into_bytes(), Vec::new()),
        Err(panic) => (false, panic.downcast_ref::<&str>().map(|text| text.to_string())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "engine panicked".to_owned()).into_bytes(), Vec::new()),
    };
    let mut reply = Vec::with_capacity(5 + json.len() + bytes.len());
    reply.push(ok as u8);
    reply.extend_from_slice(&(json.len() as u32).to_le_bytes());
    reply.extend_from_slice(&json);
    reply.extend_from_slice(&bytes);
    reply
}
