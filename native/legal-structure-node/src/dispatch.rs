//! Every engine operation behind one call, named as the engine's JavaScript surface names it.
//! Node's addon and the browser's WebAssembly runtime both call it, so an operation is
//! written once.
//!
//! A request is `[u32 json length][json {op, args}][bytes]`; the reply is
//! `[u8 ok][u32 json length][json][bytes]`, the json being the result or the failure (`engine::Failure`).

#[cfg(feature = "a2aj")]
use crate::a2aj;
use crate::engine::{self, CoreResult, Failure, NativeDocument};
use crate::source;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
#[cfg(feature = "a2aj")]
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

#[cfg(feature = "a2aj")]
/// An A2AJ document as JavaScript is given it: its metadata, and a handle to each of its readings, its full text's being
/// its provisions' where it has none of its own.
fn found(found: Option<a2aj::Found>) -> Value {
    found.map_or(Value::Null, |found| {
        let mut value = json!(found.metadata);
        value["searchNative"] = share(found.search.unwrap_or_else(|| Arc::clone(&found.native)));
        value["native"] = share(found.native);
        value
    })
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

/// An operation's result, with no bytes.
fn done(output: Result<Value, impl Into<Failure>>) -> Result<(Value, Vec<u8>), Failure> {
    output.map(|output| (output, Vec::new())).map_err(Into::into)
}

#[cfg_attr(not(feature = "legalpdf"), allow(unused_variables))]
fn dispatch(op: &str, call: &Call, bytes: &[u8], progress: Progress) -> Result<(Value, Vec<u8>), Failure> {
    let doc = || call.document();
    match op {
        "nativeBuildFeatures" => done(value(engine::native_build_features())),
        "releaseDocument" => {
            let handle = doc()?;
            documents().1.remove(&handle);
            Ok((Value::Null, Vec::new()))
        }
        "deriveDocumentStructure" => done(engine::derive_document_structure(call.get("request")?).map(store)),
        "deriveDocumentFingerprint" => done(engine::derive_document_fingerprint(call.get("request")?).and_then(value)),
        #[cfg(feature = "docx")]
        "fixDocxSupraCrossReferences" => {
            let mut result = engine::fix_docx_supra_cross_references(bytes)?;
            let bytes = std::mem::take(&mut result.bytes);
            Ok((value(&result)?, bytes))
        }
        #[cfg(feature = "docx")]
        "deriveDocxDocument" => done(engine::derive_docx_document(
            bytes, call.get("id")?, call.get::<Option<bool>>("drafting")?.unwrap_or(false)).map(store)),
        #[cfg(feature = "docx")]
        "docxText" => done(engine::docx_text(
            bytes, call.get::<Option<bool>>("drafting")?.unwrap_or(false), call.get("limit")?).and_then(value)),
        #[cfg(feature = "docx")]
        "docxAuthorityTextUnits" => done(engine::docx_authority_text_units(bytes).and_then(value)),
        #[cfg(feature = "legalpdf")]
        "derivePdfDocument" => done(engine::derive_pdf_document(bytes, &call.get("request")?).map(store)),
        #[cfg(feature = "legalpdf")]
        "preparePdfDocument" => done(value(engine::prepare_pdf_document(bytes, &call.get("request")?, progress)?)),
        #[cfg(feature = "legalpdf")]
        "restorePdfDocument" => done(engine::restore_pdf_document(&call.get("request")?)
            .map(|document| document.map(store).unwrap_or(Value::Null))),
        "openSource" => done(source::open_source(bytes, call.get("request")?)
            .map(|document| document.map(share).unwrap_or(Value::Null))),
        "sourceText" => done(value(source::source_text(bytes, call.get("request")?)?)),
        #[cfg(feature = "legalpdf")]
        "pdfDocumentSummary" => done(with_document(doc()?, |d| engine::pdf_document_summary(d).and_then(value))),
        #[cfg(feature = "legalpdf")]
        "pdfRecognizedText" => done(with_document(doc()?, |d|
            engine::pdf_recognized_text(d, call.get("pages")?).and_then(value))),
        #[cfg(feature = "legalpdf")]
        "pdfPageLabels" => done(with_document(doc()?, |d|
            engine::pdf_page_labels(d).and_then(value))),
        #[cfg(feature = "legalpdf")]
        "pdfPageMap" => {
            let citations = call.get::<Vec<String>>("citations")?;
            done(with_document(doc()?, |d| engine::pdf_page_map(d, &citations).and_then(value)))
        }
        "reporterStartPages" => done(value(engine::reporter_start_pages(&call.get::<Vec<String>>("citations")?))),
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
        "briefOccurrencePages" => done(value(engine::brief_occurrence_pages(&call.get::<Vec<String>>("pages")?,
            &call.get::<Vec<engine::BriefUnit>>("units")?))),
        #[cfg(feature = "legalpdf")]
        "queryPdfDocument" => done(with_document(doc()?, |d| engine::query_pdf_document(d, &call.get("request")?).and_then(value))),
        "docxStructureLint" => done(with_document(doc()?, |d| engine::docx_structure_lint_json(d).and_then(value))),
        "documentText" => done(with_document(doc()?, |d| value(engine::document_text(d, call.get("limit")?)))),
        "documentTextBytes" => done(with_document(doc()?, |d| value(d.structure().query_text().len()))),
        "documentRevision" => done(with_document(doc()?, |d| value(&d.structure().revision))),
        "readDocumentTextWindow" => done(with_document(doc()?, |d| value(d.query.text_window(
            d.structure(), call.get("offset")?, call.get("startChar")?, call.get("limit")?)))),
        "readDocumentTextRange" => done(with_document(doc()?, |d| value(d.query.text_range_window(
            d.structure(), call.get("start")?, call.get("end")?, call.get("offset")?, call.get("limit")?, call.get("startChar")?)))),
        "documentFingerprint" => done(with_document(doc()?, |d| value(engine::document_fingerprint_of(d)))),
        "documentAnchors" => done(with_document(doc()?, |d| engine::document_anchors(d, call.get("kind")?, call.get("end")?).and_then(value))),
        "legalSourceViewer" => done(with_document(doc()?, |d| value(d.query.viewer(d.structure(),
            engine::document_kind(&call.get::<String>("primaryKind")?)?, call.get::<Option<usize>>("limit")?.unwrap_or(u32::MAX as usize))))),
        "statuteOutline" => done(legal_structure::statute_outline(&call.get::<String>("text")?,
            call.get::<Option<bool>>("articles")?.unwrap_or(false)).map_err(|error| error.to_string()).and_then(value)),
        "caseOutline" => done(legal_structure::case_outline(&call.get::<String>("text")?).map_err(|error| error.to_string()).and_then(value)),
        "statuteProvisionSpans" => done(legal_structure::statute_provision_spans(&call.get::<String>("text")?,
            &call.get::<Vec<String>>("labels")?).map_err(|error| error.to_string()).and_then(value)),
        "collapseLabels" => done(value(legal_structure::collapse_labels(&call.get::<Vec<String>>("labels")?, &call.get::<String>("kind")?))),
        "statuteCurrency" => done(value(legal_structure_features::statute_currency(&call.get::<Vec<String>>("pages")?))),
        "filingCover" => done(value(legal_structure::filing_cover(&call.get::<String>("opening")?,
            call.get::<Option<String>>("title")?.as_deref()))),
        "documentCaseOutline" => done(with_document(doc()?, |d|
            legal_structure::case_outline(engine::document_text(d, None)).map_err(|error| error.to_string()).and_then(value))),
        "documentOutline" => done(with_document(doc()?, |d| value(engine::document_outline(d)))),
        "documentTableCells" => done(with_document(doc()?, |d| value(d.query.table_cells(d.structure())))),
        "citationLookupKey" => done(value(legal_structure::citation_lookup_key(&call.get::<String>("text")?))),
        // The same call, which JavaScript runs off its thread.
        "citationEngineCall" | "citationEngineCallAsync" => done(legal_structure::citations::api::call_value(
            &call.get::<String>("method")?, call.get("request")?).map_err(|error| error.to_string())),
        "documentReadingOrder" => done(value(legal_structure_features::document_reading_order(
            &call.get::<Vec<legal_structure_features::ReadingOrderUnit>>("units")?))),
        "citationLookupKeys" => done(value(call.get::<Vec<String>>("texts")?.iter()
            .map(|text| legal_structure::citation_lookup_key(text)).collect::<Vec<_>>())),
        "citationKeyVersion" => done(value(engine::citation_key_version())),
        "providerCitationsInText" => done(value(legal_structure::provider_citations_in_text(&call.get::<String>("text")?))),
        "canliiCaseUrl" => done(value(legal_structure::canlii_case_url(&call.get::<Vec<String>>("citations")?,
            &call.get::<Option<String>>("language")?.unwrap_or_default(), call.get::<Option<String>>("court")?.as_deref()))),
        "canliiLawUrl" => done(value(legal_structure::canlii_law_url(&call.get::<String>("text")?,
            &call.get::<Option<String>>("language")?.unwrap_or_default(),
            call.get::<Option<bool>>("consolidated")?.unwrap_or(false)))),
        // A passage's links on a source's page, planned against the document (legal-structure passage_links).
        "passageLink" => done(with_document(doc()?, |d| value(legal_structure_features::passage_link(
            &d.query, d.structure(), &call.get::<legal_structure_features::PassageLinkRequest>("request")?)))),
        "citedPassageLink" => done(with_document(doc()?, |d| value(legal_structure_features::cited_passage_link(
            &d.query, d.structure(), &call.get::<String>("url")?, &call.get::<Vec<String>>("pinpoints")?)))),
        // The link a passage of an A2AJ document is routed to.
        "sourceLink" => done(with_document(doc()?, |d| value(legal_structure_features::source_link(
            &d.query, d.structure(), &call.get::<legal_structure_features::SourceLinkRequest>("request")?)))),
        "canliiCourtRoute" => done(value(legal_structure::canlii_court_route(&call.get::<String>("court")?))),
        "citationOccurrencesInText" => done(value(legal_structure::citation_occurrences_in_text(&call.get::<String>("text")?))),
        "authorityReferencesInText" => done(value(legal_structure::authority_references_in_text(&call.get::<String>("text")?))),
        "hasCitationInText" => done(legal_structure::has_citation_in_text(&call.get::<String>("text")?)
            .map_err(|error| error.to_string()).and_then(value)),
        "groundedProseErrors" => done(value(legal_structure_features::grounded_prose_errors(
            &call.get::<String>("text")?, &call.get::<Vec<String>>("citedEvidenceIds")?,
            &call.get::<Vec<legal_structure_features::VisibleEvidenceText>>("visibleEvidence")?))),
        "quoteRepairSuggestion" => done(value(legal_structure_features::quote_repair_suggestion(
            &call.get::<String>("claim")?, &call.get::<Vec<String>>("spans")?))),
        "markedQuoteSpans" => done(value(legal_structure_features::marked_quote_spans(&call.get::<String>("text")?))),
        "documentTextUnits" => {
            let sentences = call.get::<bool>("sentences")?;
            done(with_document(doc()?, |d| value(legal_structure::text_units(engine::document_text(d, None), sentences))))
        }
        "journalTitleSearches" => done(value(legal_structure_features::journal_title_searches(&call.get::<String>("citation")?))),
        "journalTitleChoice" => done(value(legal_structure_features::journal_title_choice(
            &call.get::<Vec<legal_structure_features::JournalTitleHit>>("hits")?))),
        "quoteComparison" => done(value(legal_structure_features::quote_text_comparison(
            &call.get::<String>("authored")?, &call.get::<String>("source")?))),
        "editorialQuote" => done(value(legal_structure_features::editorial_quote(
            &call.get::<String>("authored")?, &call.get::<String>("source")?))),
        "verbatimRepair" => done(value(legal_structure_features::verbatim_repair(
            &call.get::<String>("authored")?, &call.get::<String>("source")?))),
        "quoteLocateDocument" => done(with_document(doc()?, |d| engine::quote_locate_document(
            d, call.get::<legal_structure_features::QuoteSource>("source")?,
            &call.get::<Vec<legal_structure_features::QuoteToLocate>>("quotes")?, call.get::<Option<bool>>("compare")?.unwrap_or(true),
            call.get::<Option<bool>>("keep")?.unwrap_or(false)).and_then(value))),
        #[cfg(feature = "a2aj")]
        "a2ajDocument" => done(a2aj::document(&call.get::<PathBuf>("store")?, &call.get("lookup")?).map(found)),
        // The same of a record A2AJ's API answered with, and its other readings: a provision, a listing, the records
        // that answer a citation.
        #[cfg(feature = "a2aj")]
        "a2ajRecord" => done(a2aj::record(&call.get::<Value>("record")?, call.get::<Option<legal_structure_features::a2aj::Language>>("language")?
            .unwrap_or(legal_structure_features::a2aj::Language::En), &call.get::<String>("docType")?).map(found)),
        #[cfg(feature = "a2aj")]
        "a2ajRecordProvision" => done(a2aj::record_provision(&call.get::<Vec<Value>>("records")?, &call.get("lookup")?,
            call.get("excerpt")?).map(|native| native.map_or(Value::Null, share))),
        #[cfg(feature = "a2aj")]
        "a2ajRecordListing" => done(value(a2aj::record_listing(&call.get::<Value>("record")?,
            call.get::<Option<legal_structure_features::a2aj::Language>>("language")?.unwrap_or(legal_structure_features::a2aj::Language::En)))),
        #[cfg(feature = "a2aj")]
        "a2ajRecordMatches" => done(value(a2aj::record_matches(&call.get::<Vec<Value>>("records")?, &call.get("query")?))),
        #[cfg(feature = "a2aj")]
        "a2ajSection" => done(a2aj::section(&call.get::<PathBuf>("store")?, &call.get("lookup")?,
            &call.get::<String>("section")?, call.get("excerpt")?)
            .map(|found| match found {
                Some(Some(native)) => json!({ "status": "found", "native": share(native) }),
                Some(None) => json!({ "status": "missing_provision" }),
                None => json!({ "status": "missing_statute" }),
            })),
        #[cfg(not(feature = "a2aj"))]
        "a2ajAliasGroups" => done(value(engine::own_alias_groups(&call.get::<Vec<String>>("citations")?))),
        #[cfg(feature = "a2aj")]
        "a2ajAliasGroups" => done(a2aj::alias_groups(&call.get::<PathBuf>("store")?,
            &call.get::<Vec<String>>("citations")?).and_then(value)),
        #[cfg(feature = "a2aj")]
        "a2ajNamedCase" => done(a2aj::named_case(&call.get::<PathBuf>("store")?, &call.get("named")?).and_then(value)),
        #[cfg(feature = "a2aj")]
        "a2ajNameKeys" => done(value(call.get::<Vec<String>>("names")?.iter().map(|name| a2aj::name_key(name))
            .collect::<Vec<_>>())),
        // The store's search, its inventory of courts, and its documents read by id (experiments read them so).
        #[cfg(feature = "a2aj")]
        "a2ajSearch" => done(a2aj::search(&call.get::<PathBuf>("store")?, &call.get("search")?).and_then(value)),
        #[cfg(feature = "a2aj")]
        "a2ajFind" => done(a2aj::find_id(&call.get::<PathBuf>("store")?, &call.get("lookup")?).and_then(value)),
        #[cfg(feature = "a2aj")]
        "a2ajCourts" => done(a2aj::courts(&call.get::<PathBuf>("store")?).and_then(value)),
        #[cfg(feature = "a2aj")]
        "a2ajStoreDocuments" => done(a2aj::documents(&call.get::<PathBuf>("store")?, &call.get::<Vec<i64>>("ids")?,
            &call.get::<Option<String>>("docType")?.unwrap_or_else(|| "cases".to_owned()),
            call.get::<Option<legal_structure_features::a2aj::Language>>("language")?.unwrap_or(legal_structure_features::a2aj::Language::En))
            .map(|found| found.map_or(Value::Null, |found| Value::Array(found.into_iter()
                .map(|(id, document)| { let mut value = self::found(Some(document)); value["id"] = id.into(); value }).collect())))),
        #[cfg(feature = "a2aj")]
        "a2ajReads" => done(a2aj::reads(&call.get::<PathBuf>("store")?, &call.get::<Vec<i64>>("ids")?,
            &call.get::<Option<String>>("docType")?.unwrap_or_else(|| "cases".to_owned()),
            call.get::<Option<legal_structure_features::a2aj::Language>>("language")?.unwrap_or(legal_structure_features::a2aj::Language::En)).and_then(value)),
        #[cfg(feature = "a2aj")]
        "citatorNoteUp" => {
            let mut request: legal_structure_features::citator_graph::NoteUpRequest = call.get("request")?;
            let store = call.get::<PathBuf>("store")?;
            request.keys = a2aj::alias_keys(&store, &request.citation)?;
            done(legal_structure_features::citator_graph::note_up(&store, &request)
                .map_err(|error| error.to_string()).and_then(value))
        }
        #[cfg(feature = "a2aj")]
        "citatorMetrics" => done(legal_structure_features::citator_graph::authority_metrics(&call.get::<PathBuf>("store")?,
            &call.get::<Vec<String>>("citations")?).map_err(|error| error.to_string()).and_then(value)),
        "readDocumentRange" => done(with_document(doc()?, |d| value(d.query.read_range(d.structure(),
            engine::document_kind(&call.get::<String>("kind")?)?, &call.get::<String>("from")?, &call.get::<String>("to")?,
            call.get("contextBlocks")?)))),
        "smallestContainingDocumentBlock" => done(with_document(doc()?, |d| value(
            d.query.smallest_containing_block(d.structure(), call.get("start")?, call.get("end")?)))),
        "lookupStructureBlock" => done(with_document(doc()?, |d| engine::lookup_structure_block(
            d, call.get("locator")?, call.get("contextBlocks")?).and_then(value))),
        "resolveDocumentAddressSpans" => done(with_document(doc()?, |d| value(d.query.resolve_address_spans(d.structure(),
            &call.get::<String>("spec")?, engine::follow_direction(&call.get::<String>("follow")?)?, call.get("depth")?)))),
        "graphScope" => done(with_document(doc()?, |d| engine::graph_scope(
            d, &call.get::<legal_structure::GraphScopeSeed>("seed")?, &call.get::<String>("follow")?, call.get("depth")?,
            call.get("includeDescendants")?, call.get("includeUnits")?).and_then(value))),
        "documentHasOrigin" => done(with_document(doc()?, |d|
            engine::document_has_origin(d, &call.get::<String>("origin")?).and_then(value))),
        _ => Err(format!("unknown engine operation {op}").into()),
    }
}

/// Runs one framed request and frames its reply. A panic is reported as the call's error.
pub fn call(request: &[u8], progress: Progress) -> Vec<u8> {
    engine::install_structure_analysis();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(Value, Vec<u8>), Failure> {
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
        Ok(Err(failure)) => (false, serde_json::to_vec(&failure).unwrap_or_default(), Vec::new()),
        Err(panic) => (false, serde_json::to_vec(&Failure::from(panic.downcast_ref::<&str>().map(|text| text.to_string())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "engine panicked".to_owned()))).unwrap_or_default(), Vec::new()),
    };
    let mut reply = Vec::with_capacity(5 + json.len() + bytes.len());
    reply.push(ok as u8);
    reply.extend_from_slice(&(json.len() as u32).to_le_bytes());
    reply.extend_from_slice(&json);
    reply.extend_from_slice(&bytes);
    reply
}
