//! WebAssembly (WASI) binding over `engine` for the browser runtime.
//!
//! One C-ABI entry point takes `[u32 json length][json][bytes]` and returns
//! `[u32 length][u8 ok][u32 json length][json][bytes]`. The JSON names the
//! operation by its Node-API name. Documents stay in this module behind numeric
//! handles, as `External` values do in the Node addon.

use crate::engine::{self, CoreResult, NativeDocument};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static DOCUMENTS: RefCell<(u32, HashMap<u32, NativeDocument>)> = RefCell::new((0, HashMap::new()));
}

fn store(document: NativeDocument) -> Value {
    DOCUMENTS.with(|documents| {
        let mut documents = documents.borrow_mut();
        documents.0 += 1;
        let handle = documents.0;
        documents.1.insert(handle, document);
        json!({ "handle": handle })
    })
}

fn with_document<T>(handle: u32, operation: impl FnOnce(&NativeDocument) -> CoreResult<T>) -> CoreResult<T> {
    DOCUMENTS.with(|documents| {
        let documents = documents.borrow();
        operation(documents.1.get(&handle).ok_or("document handle was released")?)
    })
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

fn dispatch(op: &str, call: &Call, bytes: &[u8]) -> CoreResult<(Value, Vec<u8>)> {
    let done = |output: CoreResult<Value>| output.map(|output| (output, Vec::new()));
    let doc = || call.document();
    match op {
        "nativeBuildFeatures" => done(value(engine::native_build_features())),
        "releaseDocument" => {
            let handle = doc()?;
            DOCUMENTS.with(|documents| documents.borrow_mut().1.remove(&handle));
            done(Ok(Value::Null))
        }
        "deriveDocumentStructure" => done(engine::derive_document_structure(call.get("request")?).map(store)),
        "deriveDocumentFingerprint" => done(engine::derive_document_fingerprint(call.get("request")?).and_then(value)),
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
        "hasDocxSupraReferences" => done(engine::has_docx_supra_references(bytes).and_then(value)),
        "deriveDocxDocument" => done(engine::derive_docx_document(
            bytes, call.get("id")?, call.get::<Option<bool>>("drafting")?.unwrap_or(false)).map(store)),
        "docxText" => done(engine::docx_text(
            bytes, call.get::<Option<bool>>("drafting")?.unwrap_or(false), call.get("limit")?).and_then(value)),
        "docxAuthorityTextUnits" => done(engine::docx_authority_text_units(bytes).and_then(value)),
        "derivePdfDocument" => done(engine::derive_pdf_document(bytes, &call.get("request")?).map(store)),
        "preparePdfDocument" => done(engine::prepare_pdf_document(bytes, &call.get("request")?).and_then(value)),
        "restorePdfDocument" => done(engine::restore_pdf_document(&call.get("request")?)
            .map(|document| document.map(store).unwrap_or(Value::Null))),
        "pdfDocumentSummary" => done(with_document(doc()?, |d| engine::pdf_document_summary(d).and_then(value))),
        "pdfRecognizedText" => done(with_document(doc()?, |d|
            engine::pdf_recognized_text(d, call.get("pages")?).and_then(value))),
        "pdfAuthorityTextUnits" => done(with_document(doc()?, |d|
            engine::pdf_authority_text_units(d).and_then(value))),
        "pdfPassageGeometryPages" => {
            let job = with_document(doc()?, |d| engine::pdf_passage_pages_job(d, call.get("targets")?))?;
            done(job.compute(bytes))
        }
        "pdfLookupUnitSpans" => done(with_document(doc()?, |d|
            engine::pdf_lookup_unit_spans(d, &call.get::<Vec<String>>("ids")?).and_then(value))),
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
            d, call.get("start")?, call.get("end")?, call.get("offset")?, call.get("limit")?)))),
        "documentFingerprint" => done(with_document(doc()?, |d| value(engine::document_fingerprint_of(d)))),
        "documentAnchors" => done(with_document(doc()?, |d| value(engine::document_anchors(d, call.get("end")?)))),
        "legalSourceViewer" => done(with_document(doc()?, |d| engine::legal_source_viewer(
            d, &call.get::<String>("primaryKind")?, call.get("limit")?).and_then(value))),
        "documentTableCells" => done(with_document(doc()?, |d| value(engine::document_table_cells(d)))),
        "citationLookupKey" => done(value(engine::citation_lookup_key_of(&call.get::<String>("text")?))),
        "citationLookupKeys" => done(value(engine::citation_lookup_keys(&call.get::<Vec<String>>("texts")?))),
        "providerCitationsInText" => done(value(engine::provider_citations(&call.get::<String>("text")?))),
        "citationOccurrencesInText" => done(value(engine::citation_occurrences(&call.get::<String>("text")?))),
        "authorityReferencesInText" => done(value(engine::authority_references(&call.get::<String>("text")?))),
        "caselawCitationLookupKey" => done(engine::caselaw_lookup_key(&call.get::<String>("text")?).and_then(value)),
        "hasCitationInText" => done(engine::has_citation(&call.get::<String>("text")?).and_then(value)),
        "classifyCitatorExcerpt" => done(value(engine::citator_excerpt(&call.get::<String>("text")?))),
        "classifyCitatorExcerpts" => done(value(engine::citator_excerpts(&call.get::<Vec<String>>("texts")?))),
        "groundedProseErrors" => done(engine::prose_errors(
            &call.get::<String>("text")?, &call.get::<Vec<String>>("citedEvidenceIds")?,
            call.get("visibleEvidence")?).and_then(value)),
        "quoteRepairSuggestion" => done(value(engine::quote_repair(
            &call.get::<String>("claim")?, &call.get::<Vec<String>>("spans")?))),
        "markedQuoteSpans" => done(value(engine::quote_spans(&call.get::<String>("text")?))),
        "readDocumentRange" => done(with_document(doc()?, |d| engine::read_document_range(
            d, &call.get::<String>("kind")?, &call.get::<String>("from")?, &call.get::<String>("to")?,
            call.get("contextBlocks")?).and_then(value))),
        "smallestContainingDocumentBlock" => done(with_document(doc()?, |d| value(
            engine::smallest_containing_document_block(d, call.get("start")?, call.get("end")?)))),
        "textFragmentPlan" => done(with_document(doc()?, |d| value(engine::document_text_fragment_plan(
            d, &call.get::<String>("blockText")?, &call.get::<Vec<String>>("quotes")?, call.get("pdf")?,
            call.get("publisherMayAnnotateLegalReference")?, call.get("splitHtmlSourceBlocks")?)))),
        "textFragmentPlanStandalone" => done(value(engine::text_fragment_plan_standalone(
            &call.get::<String>("blockText")?, &call.get::<Vec<String>>("quotes")?, call.get("pdf")?,
            call.get("publisherMayAnnotateLegalReference")?, call.get("splitHtmlSourceBlocks")?))),
        "documentParagraphRangeDirective" => done(with_document(doc()?, |d| value(
            engine::document_paragraph_range_directive(d, &call.get::<String>("start")?, &call.get::<String>("end")?)))),
        "lookupStructureBlock" => done(with_document(doc()?, |d| value(engine::lookup_structure_block(
            d, &call.get::<String>("locator")?, call.get("contextBlocks")?)))),
        "resolveDocumentAddressSpans" => done(with_document(doc()?, |d| engine::resolve_document_address_spans(
            d, &call.get::<String>("spec")?, &call.get::<String>("follow")?, call.get("depth")?).and_then(value))),
        "graphScope" => done(with_document(doc()?, |d| engine::graph_scope(
            d, &call.get::<String>("seedLabel")?, &call.get::<String>("follow")?, call.get("depth")?,
            call.get("includeDescendants")?, call.get("includeUnits")?).and_then(value))),
        "documentHasOrigin" => done(with_document(doc()?, |d|
            engine::document_has_origin(d, &call.get::<String>("origin")?).and_then(value))),
        _ => Err(format!("unknown engine operation {op}")),
    }
}

fn frame(ok: bool, json: &[u8], bytes: &[u8]) -> *mut u8 {
    let length = 1 + 4 + json.len() + bytes.len();
    let mut out = Vec::with_capacity(4 + length);
    out.extend_from_slice(&(length as u32).to_le_bytes());
    out.push(ok as u8);
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(json);
    out.extend_from_slice(bytes);
    let mut out = out.into_boxed_slice();
    let pointer = out.as_mut_ptr();
    std::mem::forget(out);
    pointer
}

#[no_mangle]
pub extern "C" fn authorities_alloc(length: usize) -> *mut u8 {
    let mut buffer = vec![0u8; length].into_boxed_slice();
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// # Safety
/// `pointer` and `length` must come from `authorities_alloc` or a returned frame
/// (whose length is its four-byte prefix plus four).
#[no_mangle]
pub unsafe extern "C" fn authorities_free(pointer: *mut u8, length: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer, length)));
}

/// # Safety
/// `pointer` must address `length` initialized bytes from `authorities_alloc`.
#[no_mangle]
pub unsafe extern "C" fn authorities_call(pointer: *const u8, length: usize) -> *mut u8 {
    let input = std::slice::from_raw_parts(pointer, length);
    let result = std::panic::catch_unwind(|| -> CoreResult<(Value, Vec<u8>)> {
        let header = input.get(..4).ok_or("truncated engine request")?;
        let json_length = u32::from_le_bytes(header.try_into().unwrap()) as usize;
        let json = input.get(4..4 + json_length).ok_or("truncated engine request")?;
        let request: Value = serde_json::from_slice(json).map_err(|error| error.to_string())?;
        let op = request.get("op").and_then(Value::as_str).ok_or("engine request lacks op")?.to_owned();
        let call = Call { args: request.get("args").cloned().unwrap_or(Value::Null) };
        dispatch(&op, &call, &input[4 + json_length..])
    });
    match result {
        Ok(Ok((output, bytes))) => frame(true, &serde_json::to_vec(&output).unwrap_or_default(), &bytes),
        Ok(Err(error)) => frame(false, error.as_bytes(), &[]),
        Err(panic) => {
            let message = panic.downcast_ref::<&str>().map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "engine panicked".to_owned());
            frame(false, message.as_bytes(), &[])
        }
    }
}
