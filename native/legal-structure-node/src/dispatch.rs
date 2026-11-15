//! Every engine operation behind one call, named as the engine's JavaScript surface names it.
//! Node's addon and the browser's WebAssembly runtime both call it, so an operation is
//! written once.
//!
//! A request is `[u32 json length][json {op, args}][bytes]`; the reply is
//! `[u8 ok][u32 json length][json][bytes]`, the json being the result or the failure (`engine::Failure`).

#[cfg(feature = "a2aj")]
use legal_structure_features::a2aj_store as a2aj;
use crate::engine::{self, Failure, NativeDocument};
use crate::source;
use legal_structure::citations as cite;
use serde::de::{DeserializeOwned, Error as _};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
#[cfg(feature = "a2aj")]
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Reports OCR progress, `(recognized, total)` pages.
#[cfg(feature = "docx")]
pub use legalpdf::RecognitionProgress as Progress;
/// An engine without the parser recognizes nothing.
#[cfg(not(feature = "docx"))]
pub type Progress<'a> = Option<&'a (dyn Fn(usize, usize) + Sync)>;

/// Documents live here behind numeric handles until their holder releases them. Calls run on
/// several threads in Node, so a document is shared, not borrowed from the table.
static DOCUMENTS: Mutex<(u32, BTreeMap<u32, Arc<NativeDocument>>)> =
    Mutex::new((0, BTreeMap::new()));

fn documents() -> std::sync::MutexGuard<'static, (u32, BTreeMap<u32, Arc<NativeDocument>>)> {
    DOCUMENTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A document as JavaScript holds it: in a reply, a handle of its own (`{"$document": handle}`), which JavaScript revives
/// as its document and releases when it no longer holds it; in a request, that handle, wherever the request holds it.
/// The engine may keep the document elsewhere too.
pub struct Handle(pub Arc<NativeDocument>);

impl Handle {
    fn new(document: NativeDocument) -> Self {
        Self(Arc::new(document))
    }
}

impl std::ops::Deref for Handle {
    type Target = NativeDocument;
    fn deref(&self) -> &NativeDocument {
        &self.0
    }
}

/// A document as TypeScript holds it: an opaque `NativeDocument`.
#[cfg(feature = "binding-types")]
impl ts_rs::TS for Handle {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;
    fn ident(_: &ts_rs::Config) -> String {
        "NativeDocument".to_owned()
    }
    fn name(config: &ts_rs::Config) -> String {
        Self::ident(config)
    }
    fn inline(_: &ts_rs::Config) -> String {
        "{ readonly $nativeDocument: never }".to_owned()
    }
    fn decl(config: &ts_rs::Config) -> String {
        format!("type NativeDocument = {};", Self::inline(config))
    }
    fn output_path() -> Option<std::path::PathBuf> {
        Some("NativeDocument.ts".into())
    }
}

impl<'de> Deserialize<'de> for Handle {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let handle = u32::deserialize(deserializer)?;
        documents().1.get(&handle).cloned().map(Handle).ok_or_else(|| D::Error::custom("document handle was released"))
    }
}

thread_local! {
    /// The bytes after a request's JSON while its call runs, and those its reply carries after its own.
    static REQUEST_BYTES: Cell<&'static [u8]> = const { Cell::new(&[]) };
    static REPLY_BYTES: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Bytes a request holds: each Uint8Array its arguments hold, which structure-engine.mjs writes as
/// `{"$bytes": [offset, length]}` and puts after the JSON.
#[derive(Clone)]
pub struct Bytes(pub Vec<u8>);

/// Bytes a reply holds, put after its JSON the same way, which structure-engine.mjs revives as the host's buffer.
pub struct Buffer(pub Vec<u8>);

impl std::ops::Deref for Bytes {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.0
    }
}

#[derive(serde::Deserialize, Serialize)]
struct BytesAt {
    #[serde(rename = "$bytes")]
    at: (usize, usize),
}

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let BytesAt { at: (start, length) } = BytesAt::deserialize(deserializer)?;
        let bytes = REQUEST_BYTES.with(|bytes| bytes.get().get(start..start.saturating_add(length)).map(<[u8]>::to_vec));
        bytes.map(Bytes).ok_or_else(|| D::Error::custom("bytes past the request's end"))
    }
}

impl Serialize for Buffer {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let start = REPLY_BYTES.with_borrow_mut(|reply| {
            reply.extend_from_slice(&self.0);
            reply.len() - self.0.len()
        });
        BytesAt { at: (start, self.0.len()) }.serialize(serializer)
    }
}

/// What TypeScript is told of bytes: any Uint8Array in a request, Node's buffer in a reply.
#[cfg(feature = "binding-types")]
macro_rules! bytes_ts {
    ($($type:ty => $name:literal),*) => {$(
        impl ts_rs::TS for $type {
            type WithoutGenerics = Self;
            type OptionInnerType = Self;
            fn name(_: &ts_rs::Config) -> String {
                $name.to_owned()
            }
            fn inline(config: &ts_rs::Config) -> String {
                Self::name(config)
            }
        }
    )*};
}
#[cfg(feature = "binding-types")]
bytes_ts!(Bytes => "Uint8Array", Buffer => "Buffer");

impl Serialize for Handle {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let handle = {
            let mut documents = documents();
            documents.0 += 1;
            let handle = documents.0;
            documents.1.insert(handle, Arc::clone(&self.0));
            handle
        };
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry("$document", &handle)?;
        map.end()
    }
}

/// An A2AJ document as JavaScript is given it: its metadata, and each of its readings, its full text's being its
/// provisions' where it has none of its own.
#[cfg(feature = "a2aj")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreDocument {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "binding-types", ts(optional))]
    id: Option<i64>,
    #[serde(flatten)]
    metadata: legal_structure_features::a2aj::Metadata,
    /// The document's CanLII page, as its metadata read it.
    canlii_url: Option<String>,
    native: Handle,
    search_native: Handle,
}

#[cfg(feature = "a2aj")]
impl StoreDocument {
    fn of(id: Option<i64>, found: a2aj::Found<NativeDocument>) -> Self {
        let search = found.search.unwrap_or_else(|| Arc::clone(&found.native));
        Self {
            id,
            canlii_url: found.metadata.canlii_url.clone(),
            metadata: found.metadata,
            native: Handle(found.native),
            search_native: Handle(search),
        }
    }
}

use legal_structure_features::journal_store as journal;

/// A journal article as JavaScript is given it: its fields and its document.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalDocument {
    #[serde(flatten)]
    article: journal::Article,
    native: Handle,
}

use legal_structure_features::http::{self, Outcome};

/// A decision a publisher abroad holds: its publisher, the id it files it under, its citation, title and page, the one
/// PDF it gives of it, the PDFs it offers, and its document.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeignCase {
    provider: &'static str,
    id: String,
    citation: String,
    title: Option<String>,
    url: String,
    pdf_url: Option<String>,
    attachments: Vec<legal_structure_features::foreign_case::Attachment>,
    native: Handle,
}

use legal_structure_features::courtlistener as court_listener;

/// One opinion of a CourtListener case: its id, type, author, page and PDF, and its document where CourtListener holds a
/// rendition of it.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "CourtListenerOpinionRead"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct CourtListenerOpinion {
    id: Option<u64>,
    kind: Option<String>,
    author: Option<String>,
    url: Option<String>,
    pdf_url: Option<String>,
    native: Option<Handle>,
}

/// A CourtListener case: its cluster's id, name and date, its page, its one PDF, its citations as printed, its opinions.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "CourtListenerCase"))]
#[serde(rename_all = "camelCase")]
pub(crate) struct CourtListenerCase {
    id: u64,
    case_name: Option<String>,
    date_filed: Option<String>,
    url: String,
    pdf_url: Option<String>,
    citations: Vec<String>,
    opinions: Vec<CourtListenerOpinion>,
}

fn court_listener_case(access: &court_listener::Access, id: u64, opinion: Option<u64>) -> Result<Option<CourtListenerCase>, http::Error> {
    let Some(case) = court_listener::case(access, id, opinion)? else { return Ok(None) };
    let opinions = case.opinions.into_iter().map(|opinion| Ok(CourtListenerOpinion { id: opinion.id, kind: opinion.kind,
        author: opinion.author, native: opinion.record.map(|record| engine::derive_document_structure(
            engine::StructureRequest::Opinion { record, url: opinion.url.clone() })).transpose()?.map(Handle::new),
        url: opinion.url, pdf_url: opinion.pdf_url })).collect::<Result<Vec<_>, String>>()?;
    Ok(Some(CourtListenerCase { id: case.id, case_name: case.case_name, date_filed: case.date_filed, url: case.url,
        pdf_url: case.pdf_url, citations: case.citations, opinions }))
}

fn foreign_case(text: &str, only: Option<&str>, saved: Option<&str>) -> Result<Option<ForeignCase>, http::Error> {
    let Some(found) = legal_structure_features::foreign_case::foreign_case(text, only, saved)? else { return Ok(None) };
    let input = found.input;
    let native = crate::source::derived_once(&format!("foreign:{}:{}", found.provider, found.id),
        || engine::derive_document_structure(engine::StructureRequest::NativeMarkup { input }))?;
    Ok(Some(ForeignCase { provider: found.provider, id: found.id, citation: found.citation, title: found.title, url: found.url,
        pdf_url: found.pdf_url, attachments: found.attachments, native: Handle(native) }))
}


/// A value TypeScript is not told the shape of (`unknown`): a PDF's parse request, a record A2AJ's API answered with.
pub struct Untyped<T>(pub T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Untyped<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(Untyped)
    }
}

impl<T: Serialize> Serialize for Untyped<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

#[cfg(feature = "binding-types")]
impl<T> ts_rs::TS for Untyped<T> {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;
    fn name(_: &ts_rs::Config) -> String {
        "unknown".to_owned()
    }
    fn inline(config: &ts_rs::Config) -> String {
        Self::name(config)
    }
}

/// A value read with its type's defaults where the request leaves fields out (its type's serde default): TypeScript's
/// `Partial<T>`.
pub struct Defaulted<T>(pub T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Defaulted<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(Defaulted)
    }
}

#[cfg(feature = "binding-types")]
impl<T: ts_rs::TS> ts_rs::TS for Defaulted<T> {
    type WithoutGenerics = Defaulted<ts_rs::Dummy>;
    type OptionInnerType = Self;
    fn name(config: &ts_rs::Config) -> String {
        format!("Partial<{}>", T::name(config))
    }
    fn inline(config: &ts_rs::Config) -> String {
        format!("Partial<{}>", T::inline(config))
    }
    fn visit_dependencies(visitor: &mut impl ts_rs::TypeVisitor) where Self: 'static {
        T::visit_dependencies(visitor);
    }
    fn visit_generics(visitor: &mut impl ts_rs::TypeVisitor) where Self: 'static {
        T::visit_generics(visitor);
        visitor.visit::<T>();
    }
}

/// A PDF the engine wrote, or a Word document it rewrote: its bytes after the reply's JSON, and what it says of them.
#[cfg(feature = "docx")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub(crate) struct Written {
    bytes: Buffer,
}

/// A Word document an assistant's edits were written into, and what each wrote or why it was left out.
#[cfg(feature = "docx")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub(crate) struct TrackedEdited {
    bytes: Buffer,
    #[serde(flatten)]
    edits: legalpdf::TrackedEdits,
}

#[cfg(feature = "docx")]
fn tracked(mut edits: legalpdf::TrackedEdits) -> TrackedEdited {
    TrackedEdited { bytes: Buffer(std::mem::take(&mut edits.bytes)), edits }
}

/// The new version with the old one's changes tracked, each change, and what the redline leaves unshown.
#[cfg(feature = "docx")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub(crate) struct Compared {
    bytes: Buffer,
    #[serde(flatten)]
    compared: legalpdf::ComparedVersions,
}

/// A Word document the assistant's text ops were written into, with each op's report.
#[cfg(feature = "docx")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub(crate) struct TextOpsWritten {
    bytes: Buffer,
    #[serde(flatten)]
    applied: legalpdf::TextOpsApplied,
}

#[cfg(feature = "legalpdf")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderedPdf {
    bytes: Buffer,
    page_count: usize,
}

#[cfg(feature = "legalpdf")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct FinalPdf {
    bytes: Buffer,
    page_count: usize,
    warnings: Vec<(usize, String)>,
}

#[cfg(feature = "legalpdf")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourcePdf {
    bytes: Buffer,
    page_count: usize,
    outline: Vec<legalpdf::compose::Outline>,
}

#[cfg(feature = "legalpdf")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProvisionsPdf {
    bytes: Buffer,
    page_count: usize,
    starts: Vec<Option<usize>>,
}


#[cfg(feature = "docx")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub(crate) struct SupraCleanup {
    bytes: Buffer,
    #[serde(flatten)]
    cleanup: legalpdf::DocxSupraCleanup,
}

/// A Word document written into: its bytes, whether each write was made, and the ids of the revisions written.
#[cfg(feature = "docx")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub(crate) struct DocxWritten {
    bytes: Buffer,
    written: Vec<bool>,
    revisions: Vec<u32>,
}

#[cfg(feature = "docx")]
fn docx_written(written: legalpdf::DocxSpansWritten) -> DocxWritten {
    DocxWritten { bytes: Buffer(written.bytes), written: written.written, revisions: written.revisions }
}

/// Accepted corrections written as tracked changes by "Beaver", each word they change its own; refused whole where any
/// no longer matches the document.
#[cfg(feature = "docx")]
fn docx_corrected(bytes: &[u8], units: &[legalpdf::DocxUnit], corrections: &[legal_structure_features::BriefCorrection]) -> Result<DocxWritten, String> {
    let refused = || "The accepted correction no longer matches the reviewed Word document.".to_owned();
    let writes = corrections.iter().map(|correction| units.iter().find(|unit| unit.id == correction.unit_id)
        .and_then(|unit| legal_structure_features::correction_words(&unit.text, correction)).ok_or_else(refused))
        .collect::<Result<Vec<_>, _>>()?.into_iter().flatten().map(|word| legalpdf::DocxSpanWrite { unit_id: word.unit_id,
            start: word.start, end: word.end, expected: word.expected, edit: legalpdf::DocxEdit::Replace { replacement: word.replacement } })
        .collect::<Vec<_>>();
    let written = legalpdf::write_docx_spans(bytes, units, &writes, "Beaver").map_err(|error| error.to_string())?;
    if written.written.iter().any(|made| !made) { return Err(refused()); }
    Ok(docx_written(written))
}

/// A source the ALR verifier's run reads: the document the host read for a part.
impl alr_verifier::Source for Handle {
    fn query(&self) -> &legal_structure::DocumentQuery { &self.0.query }
    fn structure(&self) -> &legal_structure::DocumentStructure { self.0.structure() }
    fn canlii(&self) -> Option<&str> { self.0.canlii.as_deref() }
    fn key(&self) -> usize { Arc::as_ptr(&self.0) as usize }
}

/// The ALR verifier's runs waiting on their host's answers, by number; a run its host abandoned gives way to newer ones.
static RUNS: Mutex<(u32, Vec<(u32, alr_verifier::Run<Handle>)>)> = Mutex::new((0, Vec::new()));
const RUNS_KEPT: usize = 8;

/// Where an ALR verifier run stands: asking its host (`run` resumes it), or its workbook written.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrStep"))]
#[serde(tag = "step", rename_all = "camelCase")]
pub(crate) enum AlrStep {
    Ask { run: u32, question: alr_verifier::Question },
    Done { name: String, workbook: Buffer, rows: Vec<alr_verifier::Row>, references: alr_verifier::References, signature: Option<String> },
}

/// A run's next step; one still asking is kept until its answer comes.
fn alr_step(mut run: alr_verifier::Run<Handle>, answer: Option<alr_verifier::Answer<Handle>>, number: Option<u32>) -> Result<AlrStep, String> {
    Ok(match run.resume(answer)? {
        alr_verifier::Step::Done(written) => AlrStep::Done { name: written.name, workbook: Buffer(written.workbook), rows: written.rows,
            references: written.references, signature: written.signature },
        alr_verifier::Step::Ask(question) => {
            let mut runs = RUNS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let number = number.unwrap_or_else(|| { runs.0 += 1; runs.0 });
            runs.1.push((number, run));
            let excess = runs.1.len().saturating_sub(RUNS_KEPT);
            runs.1.drain(..excess);
            AlrStep::Ask { run: number, question }
        }
    })
}

/// Briefs read and waiting on their host's statute lookups, by number, as runs wait (RUNS_KEPT).
static READINGS: Mutex<(u32, Vec<(u32, legal_structure_features::BriefReading)>)> = Mutex::new((0, Vec::new()));

/// A brief read (`reading`, its number for briefReview) and the statutes it names whose pages A2AJ is to confirm.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub(crate) struct BriefStatutes {
    reading: u32,
    statutes: Vec<legal_structure_features::StatuteCandidate>,
}

/// An argument named as JavaScript names it ("start_char" is "startChar").
pub(crate) fn camel(name: &str) -> String {
    let mut parts = name.split('_');
    let first = parts.next().unwrap_or_default().to_owned();
    parts.fold(first, |name, part| {
        let mut chars = part.chars();
        name + &chars.next().map(|first| first.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
    })
}

fn argument<T: DeserializeOwned>(name: &str, value: Option<&Value>) -> Result<T, Failure> {
    T::deserialize(value.unwrap_or(&Value::Null)).map_err(|error| format!("invalid argument {}: {error}", camel(name)).into())
}

fn value(output: impl Serialize) -> Result<Value, Failure> {
    serde_json::to_value(output).map_err(|error| error.to_string().into())
}

/// The engine's operations, each declared once: its name as JavaScript calls it; whether it runs on the caller's thread
/// (`now`), off it (`off`), or off it reporting recognition's progress (`progress`, as `progress` in its body); its
/// arguments in JavaScript's order, a trailing optional one optional there; its reply; and its body, which may use `?`.
/// The dispatch is made from it, and under `binding-types` the table bindings.rs writes for JavaScript and TypeScript
/// (shared/engine-types/operations.mjs and operations.d.ts).
macro_rules! operations {
    ($progress:ident; $(
        $(#[doc = $doc:literal])*
        $(#[cfg($cfg:meta)])*
        $mode:ident $name:literal ($($arg:ident: $type:ty),* $(,)?) -> $reply:ty $body:block
    )*) => {
        fn dispatch(op: &str, args: &[Value], $progress: Progress) -> Result<Value, Failure> {
            match op {
                $($(#[cfg($cfg)])* $name => {
                    #[allow(unused_mut)]
                    let mut _args = args.iter();
                    $(let $arg: $type = argument(stringify!($arg), _args.next())?;)*
                    let reply: $reply = $body;
                    value(reply)
                })*
                _ => Err(format!("unknown engine operation {op}").into()),
            }
        }

        #[cfg(feature = "binding-types")]
        pub(crate) fn operations(table: &mut crate::bindings::Table) -> Result<(), ts_rs::ExportError> {
            $($(#[cfg($cfg)])* {
                table.operation($name, stringify!($mode), &[$($doc),*]);
                $(table.argument::<$type>(stringify!($arg))?;)*
                table.reply::<$reply>()?;
            })*
            Ok(())
        }
    };
}

/// Each key's exact aliases and authored forms in the A2AJ store's inventory; its own key alone where there is no store.
fn alias_groups(store: &std::path::Path, keys: &[String]) -> Result<Vec<engine::AliasGroup>, String> {
    #[cfg(feature = "a2aj")]
    return a2aj::alias_groups(store, keys);
    #[cfg(not(feature = "a2aj"))]
    { let _ = store; Ok(keys.iter().map(|key| engine::AliasGroup::own(key)).collect()) }
}

#[cfg(feature = "a2aj")]
fn language(language: Option<legal_structure_features::a2aj::Language>) -> legal_structure_features::a2aj::Language {
    language.unwrap_or(legal_structure_features::a2aj::Language::En)
}

operations! { progress;
    now "nativeBuildFeatures" () -> String { engine::native_build_features().to_owned() }
    off "deriveDocumentStructure" (request: engine::StructureRequest) -> Handle {
        Handle::new(engine::derive_document_structure(request)?)
    }
    /// Writes into a Word document's units as the reading read them (`units`, each with its reviewed text): each
    /// write's span replaced as a tracked change by `author`, highlighted, or linked; a write the document no longer
    /// holds, or that crosses a tab, a break or a field, is left out and said to be.
    #[cfg(feature = "docx")]
    off "docxWriteSpans" (bytes: Bytes, units: Vec<legalpdf::DocxUnit>, writes: Vec<legalpdf::DocxSpanWrite>, author: String) -> DocxWritten {
        docx_written(legalpdf::write_docx_spans(&bytes, &units, &writes, &author).map_err(|error| error.to_string())?)
    }
    /// The brief with its table of authorities as `delivery` asks: TA marks at the citations `marks` names in `units`,
    /// and the table appended where asked (Word's own fields, a linked list or a ruled table).
    #[cfg(feature = "docx")]
    off "docxTableOfAuthorities" (bytes: Bytes, units: Vec<legalpdf::DocxUnit>, marks: Vec<legalpdf::DocxAuthorityMark>,
        delivery: legalpdf::DocxTableDelivery, linked: Vec<legalpdf::DocxLinkedAuthority>) -> DocxWritten {
        DocxWritten { bytes: Buffer(legalpdf::apply_table_of_authorities(&bytes, &units, &marks, delivery, &linked).map_err(|error| error.to_string())?),
            written: Vec::new(), revisions: Vec::new() }
    }
    /// Accepted corrections written as tracked changes by "Beaver", each word they change its own revision, with the
    /// ids that reject them again; refused whole where any no longer matches the document.
    #[cfg(feature = "docx")]
    off "docxApplyCorrections" (bytes: Bytes, units: Vec<legalpdf::DocxUnit>, corrections: Vec<legal_structure_features::BriefCorrection>) -> DocxWritten {
        docx_corrected(&bytes, &units, &corrections)?
    }
    /// Accepts or rejects the tracked changes `ids` names, in every story; none where any is not one of the document's.
    #[cfg(feature = "docx")]
    off "docxResolveTrackedChanges" (bytes: Bytes, ids: Vec<String>, accept: bool) -> Option<Written> {
        legalpdf::resolve_tracked_changes(&bytes, &ids, accept).map_err(|error| error.to_string())?.map(|bytes| Written { bytes: Buffer(bytes) })
    }
    /// An assistant's edits, each found by its text and context on the document's accepted text (or at its pinned
    /// offsets), written as tracked changes by `author` or directly ("auto"); an edit left out says why.
    #[cfg(feature = "docx")]
    off "docxTrackedEdits" (bytes: Bytes, edits: Vec<legalpdf::EditInput>, author: String, mode: legalpdf::EditMode) -> TrackedEdited {
        tracked(legalpdf::apply_tracked_edits(&bytes, &edits, &author, mode).map_err(|error| error.to_string())?)
    }
    /// Deterministic text ops (case, find and replace, spacing, quotes, dashes, ellipses, spelling flags) run on their
    /// scopes of the accepted text, each change written as its own edit by `author`; with each op's report.
    #[cfg(feature = "docx")]
    off "docxTextOps" (bytes: Bytes, ops: Vec<legalpdf::TextOpRequest>, author: String, mode: legalpdf::EditMode) -> TextOpsWritten {
        let mut applied = legalpdf::apply_text_ops(&bytes, &ops, &author, mode).map_err(|error| error.to_string())?;
        TextOpsWritten { bytes: Buffer(std::mem::take(&mut applied.edits.bytes)), applied }
    }
    /// The new version with what changed from the old one as tracked changes by `author`.
    #[cfg(feature = "docx")]
    off "docxCompareVersions" (before: Bytes, after: Bytes, author: String) -> Compared {
        let mut compared = legalpdf::compare_docx_versions(&before, &after, &author).map_err(|error| error.to_string())?;
        Compared { bytes: Buffer(std::mem::take(&mut compared.bytes)), compared }
    }
    /// New paragraphs inserted as tracked text by `author`, where `insert` puts them.
    #[cfg(feature = "docx")]
    off "docxInsertTrackedBlocks" (bytes: Bytes, insert: legalpdf::BlockInsert, author: String) -> TrackedEdited {
        tracked(legalpdf::insert_tracked_blocks(&bytes, &insert, &author).map_err(|error| error.to_string())?)
    }
    /// The document's accepted text as edits are found on it: its body's paragraphs joined by a newline.
    #[cfg(feature = "docx")]
    off "docxBodyText" (bytes: Bytes) -> String { legalpdf::docx_body_text(&bytes).map_err(|error| error.to_string())? }
    /// Every tracked change in the document's stories, in reading order: its kind ("ins" or "del") and id.
    #[cfg(feature = "docx")]
    off "docxTrackedChangeIds" (bytes: Bytes) -> Vec<(&'static str, String)> {
        legalpdf::docx_tracked_change_ids(&bytes).map_err(|error| error.to_string())?
    }
    /// A Word document's supra references made cross-references, and what was found and changed.
    #[cfg(feature = "docx")]
    off "fixDocxSupraCrossReferences" (bytes: Bytes) -> SupraCleanup {
        let mut cleanup = legalpdf::fix_docx_supra_cross_references(&bytes).map_err(|error| error.to_string())?;
        SupraCleanup { bytes: Buffer(std::mem::take(&mut cleanup.bytes)), cleanup }
    }
    #[cfg(feature = "docx")]
    off "docxAuthorityTextUnits" (bytes: Bytes) -> Vec<legal_structure_model::AuthorityTextUnit> {
        legalpdf::docx_to_toa_text_units(&bytes).map_err(|error| error.to_string())?
    }
    /// The first two pages' native witnesses for source identification; no recognition or structure inference.
    #[cfg(feature = "legalpdf")]
    off "pdfOpening" (bytes: Bytes) -> legalpdf::PdfOpening { legalpdf::pdf_opening(&bytes)? }
    /// `marks` (as decodeAnnotationSet returns them) appended to the PDF as an incremental update: the original bytes
    /// unchanged, then the annotations; with `disarm` (default true) also what the PDF would run, launch, submit or fetch.
    #[cfg(feature = "legalpdf")]
    now "pdfWriteAnnotations" (bytes: Bytes, marks: Vec<legalpdf::AnnotationMark>, namespace: String, disarm: Option<bool>)
        -> Written {
        let written = legalpdf::write_annotations(&bytes, &marks, &namespace, disarm.unwrap_or(true)).map_err(|error| error.to_string())?;
        Written { bytes: Buffer(written) }
    }
    /// A source's own PDF set from its provider's text (assembly/statute.rs): a statute by its provisions, a judgment by
    /// its paragraphs.
    #[cfg(feature = "legalpdf")]
    off "renderSourcePdf" (source: crate::assembly::statute::SourceText) -> SourcePdf {
        let (bytes, page_count, outline, _) = crate::assembly::statute::render_source_pdf(&source)?;
        SourcePdf { bytes: Buffer(bytes), page_count, outline }
    }
    /// A statute's cited provisions (`labels`, each a provision, a part of one or a range) set from its provider's text,
    /// each with everything under it: the PDF and the page each label's provision begins on; null where the text holds
    /// none of them.
    #[cfg(feature = "legalpdf")]
    off "renderStatuteProvisions" (source: crate::assembly::statute::SourceText, labels: Vec<String>) -> Option<ProvisionsPdf> {
        crate::assembly::statute::render_provisions(&source, &labels)?.map(|(bytes, page_count, starts)| ProvisionsPdf { bytes: Buffer(bytes), page_count, starts })
    }
    /// A book of authorities' volumes from its plan and its PDFs' bytes, in the order it names them (assembly/book.rs):
    /// each volume `bytes` long in the reply's bytes.
    #[cfg(feature = "legalpdf")]
    off "renderAuthoritiesBook" (book: crate::assembly::book::PreparedBook) -> Vec<crate::assembly::book::BuiltBook> {
        crate::assembly::book::render_book(book)?
    }
    /// A court record's PDFs (assembly/court.rs): its parts joined, an affidavit with its exhibits, or a record's
    /// volumes; each `bytes` long in the reply's bytes.
    #[cfg(feature = "legalpdf")]
    off "renderCourtRecord" (record: crate::assembly::court::CourtRecord) -> Vec<crate::assembly::court::CourtPdf> {
        crate::assembly::court::render_court_record(&record)?
    }
    /// A filing PDF with its table of authorities, and the PDFs appended after it.
    #[cfg(feature = "legalpdf")]
    off "renderFilingPdf" (filing: Bytes, entries: Vec<crate::assembly::book::FilingEntry>) -> RenderedPdf {
        let (bytes, page_count) = crate::assembly::book::render_filing(&filing, &entries)?;
        RenderedPdf { bytes: Buffer(bytes), page_count }
    }
    /// The brief and its book as one PDF, and each of the plan's links not made, and why.
    #[cfg(feature = "legalpdf")]
    off "renderFinalPdf" (bytes: Bytes, plan: crate::assembly::book::FinalPlan) -> FinalPdf {
        let (bytes, page_count, warnings) = crate::assembly::book::render_final(&plan, &bytes)?;
        FinalPdf { bytes: Buffer(bytes), page_count, warnings }
    }
    /// A PDF read and cached where another engine reopens it by its cache key (a page's parse workers): its summary.
    #[cfg(feature = "legalpdf")]
    progress "preparePdfDocument" (bytes: Bytes, request: Untyped<legalpdf::PdfRequest>) -> legalpdf::PdfSummary {
        legalpdf::read_pdf(Some(&bytes), &request.0, progress)?.ok_or("PDF cache miss after parsing source bytes")?.summary().clone()
    }
    /// The pages a PDF's recognition would read (from 0), as its extraction finds them, its structure not read.
    #[cfg(feature = "legalpdf")]
    off "pdfPagesNeedingOcr" (bytes: Bytes, request: Untyped<legalpdf::PdfRequest>) -> Vec<usize> {
        legalpdf::pages_needing_ocr(&bytes, &request.0)?
    }
    /// The cache key a PDF's reading would be kept under, without reading it (request.expectedSourceSha256 names it).
    #[cfg(feature = "legalpdf")]
    now "pdfCacheKey" (bytes: Option<Bytes>, request: Untyped<legalpdf::PdfRequest>) -> String {
        legalpdf::pdf_cache_key(bytes.as_deref().filter(|bytes| !bytes.is_empty()), &request.0)?
    }
    /// A stored source read as its document by its format's reader: the document the engine keeps for it, or, given its
    /// bytes, read afresh (sourceDocument.ts builds the request); without bytes, null where the engine keeps none.
    /// `progress(recognized, total)` follows a PDF's text recognition as pages finish.
    progress "openSource" (bytes: Option<Bytes>, request: source::SourceRequest) -> Option<Handle> {
        source::open_source(bytes.as_deref().unwrap_or_default(), request, progress)?.map(Handle)
    }
    /// A source's text as its format's reader gives it, without its structure.
    off "sourceText" (bytes: Bytes, request: source::TextRequest) -> String { source::source_text(&bytes, request)? }
    #[cfg(feature = "legalpdf")]
    now "pdfDocumentSummary" (document: Handle) -> &legalpdf::PdfSummary { engine::pdf(&document)?.summary() }
    #[cfg(feature = "legalpdf")]
    now "pdfRecognizedText" (document: Handle, pages: Option<Vec<u32>>) -> Option<Vec<&legal_structure::layout::Page>> {
        engine::pdf_recognized_text(&document, pages)?
    }
    /// Each page's printed number: the structure's, anchored on the first pages of the reports `citations` cite.
    #[cfg(feature = "legalpdf")]
    now "pdfPageMap" (document: Handle, citations: Vec<String>) -> Vec<legalpdf::PdfPageBinding> {
        engine::pdf_page_map(&document, &citations)?
    }
    /// The PDF pages (from 1) each printed page label names by the page map anchored on the reports `citations` cite;
    /// none for a label the map does not resolve.
    #[cfg(feature = "legalpdf")]
    now "pdfPrintedPages" (document: Handle, citations: Vec<String>, labels: Vec<String>) -> Vec<Vec<u32>> {
        engine::pdf_printed_pages(&document, &citations, &labels)?
    }
    /// The first pages of the reports `citations` cite.
    now "reporterStartPages" (citations: Vec<String>) -> Vec<u32> { engine::reporter_start_pages(&citations) }
    /// Every page's text in page order, empty where a page has no exact text.
    #[cfg(feature = "legalpdf")]
    now "pdfPageTexts" (document: Handle) -> Vec<String> { engine::pdf(&document)?.page_texts() }
    #[cfg(feature = "legalpdf")]
    now "pdfAuthorityTextUnits" (document: Handle) -> &[legal_structure_model::AuthorityTextUnit] {
        engine::pdf(&document)?.authority_text_units()
    }
    /// An authority's source as its book reads it (assembly/authority.rs): each of its PDFs, in the order joined, by its
    /// reading (else its count of pages, its text unread), with its marks where reviewed; null, the page the book holds
    /// in place of a PDF not there.
    #[cfg(feature = "legalpdf")]
    off "authorityReading" (parts: Vec<Option<crate::assembly::authority::Part>>, request: crate::assembly::authority::SourceRequest)
        -> crate::assembly::authority::AuthorityReading {
        crate::assembly::authority::authority_reading(&parts, &request)?
    }
    /// Each passage's pages, its lines' rectangles on each, and its quotations placed on them; a passage with no page it
    /// can be read on unavailable. With `citations`, a page locator naming no physical pages is a printed page, the PDF
    /// pages the page map anchored on the reports they cite gives it.
    #[cfg(feature = "legalpdf")]
    off "pdfPassageGeometry" (document: Handle, targets: Vec<legalpdf::PassageTarget>, citations: Option<Vec<String>>)
        -> legalpdf::PassageGeometry {
        engine::passage_geometry(&document, targets, citations)?
    }
    /// The page (from 1) of each citation of a Word brief in a PDF saved from it (`pages`, each page's text), by its id:
    /// each unit's citations found among the pages' words in order, body and notes each onward from their last match.
    #[cfg(feature = "legalpdf")]
    now "briefOccurrencePages" (pages: Vec<String>, units: Vec<legalpdf::BriefUnit>,
        occurrences: std::collections::HashMap<String, legalpdf::BriefOccurrence>) -> BTreeMap<String, u32> {
        legalpdf::brief_occurrence_pages(&pages, &units, &occurrences)
    }
    #[cfg(feature = "legalpdf")]
    now "queryPdfDocument" (document: Handle, request: legalpdf::PdfLookupRequest) -> legalpdf::PdfStructureLookup {
        engine::pdf(&document)?.lookup(&document.query, &request)
    }
    now "docxStructureLint" (document: Handle) -> legal_structure::DocxLintReport { engine::docx_structure_lint_json(&document)? }
    now "documentText" (document: Handle, limit: Option<u32>) -> &str { engine::document_text(&document, limit) }
    now "documentTextBytes" (document: Handle) -> usize { document.structure().query_text().len() }
    now "documentRevision" (document: Handle) -> &str { document.revision() }
    /// Reads the document's structure, here off the caller's thread: a store's document is derived where first read.
    off "readDocument" (document: Handle) -> () { document.structure(); }
    now "readDocumentTextWindow" (document: Handle, offset: usize, start_char: usize, limit: usize)
        -> legal_structure::DocumentTextWindow<'_> {
        document.query.text_window(document.structure(), offset, start_char, limit)
    }
    now "readDocumentTextRange" (document: Handle, start: usize, end: usize, offset: Option<usize>, limit: usize,
        start_char: Option<usize>) -> legal_structure::DocumentTextWindow<'_> {
        document.query.text_range_window(document.structure(), start, end, offset, limit, start_char)
    }
    /// The nodes the query serves, in its order, as readers take them; with `kind`, those it serves as that kind (a
    /// paragraph's prose among them); with `end`, those starting before it. Levels are one-based.
    now "documentAnchors" (document: Handle, kind: Option<legal_structure::NodeKind>, end: Option<u32>)
        -> Vec<legal_structure::NodeReading<'_>> {
        engine::document_anchors(&document, kind, end)
    }
    now "legalSourceViewer" (document: Handle, primary_kind: legal_structure::NodeKind, limit: Option<usize>)
        -> legal_structure::DocumentViewer<'_> {
        document.query.viewer(document.structure(), primary_kind, limit.unwrap_or(u32::MAX as usize))
    }
    /// The outline of a provider's text of a judgment ("cases") or a statute ("laws").
    now "textOutline" (text: String, kind: legal_structure::ProviderTextSourceKind) -> Vec<legal_structure_features::OutlineEntry> {
        legal_structure_features::text_outline(&text, kind).map_err(|error| error.to_string())?
    }
    /// A reader's labels of one kind as few as they can be written: runs of numbers ("12–14"), provisions' spans
    /// ("5(2)(a)–(c)"); null where a label is not of the kind's shape.
    now "collapseLabels" (labels: Vec<String>, kind: String) -> Option<Vec<String>> { legal_structure::collapse_labels(&labels, &kind) }
    /// Each typed locator of a kind as the label it names, the words it may open on taken off: "para. 12" and "par12"
    /// are "12", "s. 5(2)" and "sec5(2)" are "5(2)", "fn 3" is "3".
    now "bareLabels" (labels: Vec<String>, kind: String) -> Vec<String> {
        labels.iter().map(|label| legal_structure::bare_label(&kind, label)).collect()
    }
    /// Each citation of a text, outside its marked quotations, that pinpoints paragraphs: its lookup key and every
    /// paragraph it names, a range written out ("paras 12–14": 12, 13, 14).
    off "citedParagraphs" (text: String) -> Vec<legal_structure_features::CitedParagraphs> {
        legal_structure_features::cited_paragraphs(&text)?
    }
    /// A filing's cover from its opening page's text: the parties its BETWEEN block names in their roles, and whose
    /// document it is, from `title` (its record title) where given, else its DOCUMENT line.
    now "filingCover" (opening: String, title: Option<String>) -> legal_structure::FilingCover {
        legal_structure::filing_cover(&opening, title.as_deref())
    }
    /// The document's outline, read from its nodes.
    now "documentOutline" (document: Handle) -> Vec<legal_structure_features::OutlineEntry> {
        legal_structure_features::document_outline(document.structure())
    }
    now "documentTableCells" (document: Handle) -> Vec<legal_structure::AuthoritativeTableCell> { document.query.table_cells(document.structure()) }
    /// The citations a text holds, as the citation engine extracts them: with `options` (each left out its default),
    /// offsets in `offsetUnit` (bytes by default).
    now "citationExtract" (text: String, options: Defaulted<cite::Options>, offset_unit: Option<cite::OffsetUnit>)
        -> cite::api::ExtractResponse {
        cite::api::extract(&cite::api::ExtractRequest { text, markup_text: None, options: options.0,
            offset_unit: offset_unit.unwrap_or_default() }).map_err(|error| error.to_string())?
    }
    /// What the host knows of how far works run, for every later extraction: a works pack (shared/work-extents-data.mjs).
    now "registerExtents" (pack: String) -> () { cite::register_extents(&pack) }
    /// The identity key of the one full citation a text holds, and every citation's key.
    now "citationKeyForText" (text: String) -> cite::api::KeyForTextResponse {
        cite::api::key_for_text(&cite::api::TextRequest { text, ..Default::default() }).map_err(|error| error.to_string())?
    }
    /// Whether a page's running head ("[2019] 4 R.C.S. / CANADA c. VAVILOV / 653") prints the volume and first page of
    /// one of the citations' reports.
    now "matchesReporterHeader" (text: String, citations: Vec<cite::Citation>) -> bool {
        cite::cues::matches_reporter_header(&text, &citations)
    }
    /// Whether names written for a case can name the case another name names, and each one's distinctive words.
    now "caseNamesAgree" (written: Vec<String>, other: String) -> cite::format::CaseNamesAgreement {
        cite::format::case_names_agree(&cite::format::CaseNamesRequest { written, other })
    }
    /// The style of cause a decision prints before its own citation, which one of `keys` names; null where its caption
    /// is not a plain "Name, citation".
    now "captionStyleOfCause" (text: String, keys: Vec<String>) -> Option<String> {
        cite::authorities::caption_style_of_cause(&cite::authorities::CaptionRequest { text, keys })
    }
    /// The pinpoints written in `start..end` (UTF-16) of a text, each with its kind and place; with `strict`, none where
    /// the selection has no locator words, else a bare value is a page.
    now "pinpointsAt" (text: String, start: usize, end: usize, strict: Option<bool>) -> Vec<cite::authorities::PinpointValue> {
        cite::authorities::pinpoints_at(&cite::authorities::PinpointsRequest { text, start, end, strict: strict.unwrap_or(false) })
    }
    /// A pinpoint as McGill writes it ("at paras 12-14").
    now "citationFormat" (kind: cite::PinpointKind, locators: Vec<cite::api::Locator>) -> String {
        cite::api::format(&cite::api::FormatRequest { pinpoint: Some(cite::api::PinpointRequest { kind, locators }), ..Default::default() })
            .map_err(|error| error.to_string())?.pinpoint.unwrap_or_default()
    }
    /// A journal article as McGill cites it.
    now "formatArticle" (article: cite::format::Article) -> String { cite::format::article(&article) }
    /// The public source's page of a citation (a back reference's antecedent's), with `anchor` at its single pinpoint's
    /// anchor where the source has one; null where no source is certain.
    now "citationUrl" (citation: cite::Citation, anchor: Option<bool>) -> Option<String> {
        cite::api::url(&cite::api::UrlRequest { citation: Some(citation), anchor: anchor.unwrap_or(false), ..Default::default() })
            .map_err(|error| error.to_string())?.urls.into_iter().next().and_then(|url| url.url)
    }
    /// Each source court's code with its CanLII route ("fc": "fct").
    now "canliiRoutes" () -> std::collections::HashMap<String, String> { cite::url::source_canlii_routes().clone() }
    /// The CanLII page an alias's target ("onca/2019onca1") names, in French where `french`; with `pdf`, its PDF; null
    /// where the target names no decision.
    now "canliiAliasTarget" (target: String, french: Option<bool>, pdf: Option<bool>) -> Option<String> {
        let language = if french.unwrap_or(false) { cite::format::Language::Fr } else { cite::format::Language::En };
        let page = cite::url::canlii_alias_target(&target, language);
        if pdf.unwrap_or(false) { page.and_then(|page| cite::url::canlii_pdf_url(&page)) } else { page }
    }
    /// Each number the pinpoints write, linked on its own to the place the page at `url` has for it.
    now "pinpointLinks" (pinpoints: Vec<cite::Pinpoint>, url: String) -> Vec<cite::url::PinpointLink> {
        cite::url::pinpoint_links(&pinpoints, &url)
    }
    /// Each numbered label of a kind as the numbers it names, a run written out ("12–14": 12, 13, 14): null for one
    /// naming no number or run, or a run reversed or spanning more than `limit` past its first number.
    now "expandLabels" (labels: Vec<String>, kind: String, limit: usize) -> Vec<Option<Vec<String>>> {
        legal_structure::expand_labels(&labels, &kind, limit)
    }
    /// The anchor a source's page has for each label of a locator kind ("par12", "page 3", "2(1)"); null where none.
    now "sourceAnchor" (url: String, kind: String, labels: Vec<String>, depth: Option<usize>) -> Vec<Option<String>> {
        labels.iter().map(|label| cite::url::source_anchor_within(&url, &kind, label, depth)).collect()
    }
    /// A source's link at `anchor` where given, else the anchor it has; null for an address that cannot be linked. A
    /// path on the host stays a path.
    now "sourceUrl" (url: String, anchor: Option<String>) -> Option<String> {
        legal_structure_features::host_source_url(&url, anchor.as_deref())
    }
    /// A reference's link: its origin's link moved to the reference's own pinpoint.
    now "reanchorReference" (link: String, text: String) -> String { cite::short_forms::reanchor_reference(&link, &text) }
    /// Whether a reference is an ibid or a supra, the notes it numbers, and its words normalized.
    now "referenceInfo" (text: String) -> cite::short_forms::ReferenceInfo { cite::short_forms::reference_info(&text) }
    /// The name a supra is written with; with `fallback`, read more loosely where that finds none.
    now "supraHint" (text: String, aggressive: bool, fallback: Option<bool>) -> String {
        if fallback.unwrap_or(false) { cite::short_forms::fallback_hint(&text) } else { cite::short_forms::supra_hint(&text, aggressive) }
    }
    /// A note's clauses where it is only ibid and supra references; null otherwise.
    now "pureReferenceClauses" (text: String) -> Option<Vec<cite::source::PureReferenceClause>> {
        cite::source::pure_reference_clauses(&text)
    }
    /// A note split into its citation parts, offsets in `offsetUnit` (bytes by default).
    now "splitSources" (text: String, recall_first: bool, offset_unit: Option<cite::OffsetUnit>) -> cite::source::SourceSplit {
        cite::api::split_sources(&cite::api::SplitSourcesRequest { text, recall_first, offset_unit: offset_unit.unwrap_or_default(),
            ..Default::default() })
    }
    /// Each note split into its parts (UTF-16 offsets), each with the first authority it refers to and its fields.
    off "quoteCitationUnits" (texts: Vec<String>) -> Vec<cite::api::QuoteCitationUnit> { cite::api::quote_citation_units(texts) }
    /// Each note's proposition in a brief's body text (its body units in order, each followed by a line break): the
    /// passage since the call before its one call, or with `context` "sentence", the sentence its call ends or stands
    /// in; each with the parts of the units (by their place in `units`) it holds. Also where each body unit starts in
    /// that text and every call of a note in it by where it stands. Offsets in UTF-16 units.
    now "footnotePropositions" (units: Vec<legal_structure_model::AuthorityTextUnit>, context: Option<legal_structure_features::QuoteContext>)
        -> legal_structure_features::FootnotePropositions {
        legal_structure_features::footnote_propositions(&units, context.unwrap_or(legal_structure_features::QuoteContext::Passage))
    }
    /// The quotations to check in a brief's units, each with the citation parts it is checked against: a body
    /// quotation's in the note whose proposition holds it, else its own unit's that cite after it (`citations`, each
    /// unit's citations and parts). With `textOnly`, the body's quotations alone. Offsets in UTF-16 units.
    now "propositionQuotations" (units: Vec<legal_structure_model::AuthorityTextUnit>,
        citations: Vec<legal_structure_features::UnitCitations>, context: Option<legal_structure_features::QuoteContext>,
        text_only: Option<bool>) -> Vec<legal_structure_features::PropositionQuotation> {
        legal_structure_features::proposition_quotations(&units, &citations,
            context.unwrap_or(legal_structure_features::QuoteContext::Passage), text_only.unwrap_or(false))
    }
    /// A brief's citations read (legal_structure_features::brief_reading), each cited case's aliases from the A2AJ store
    /// at `store`, and kept here for its review (`briefReview`, by `reading`); what the host looks up for it first: the
    /// statutes whose CanLII pages A2AJ is to confirm. `fileNumber`: the brief's own court file number, which cites nothing.
    now "briefReading" (units: Vec<legal_structure_model::AuthorityTextUnit>, split_tier: legal_structure::citations::SplitTier,
        join_bodies: bool, file_number: Option<String>, store: std::path::PathBuf) -> BriefStatutes {
        let reading = legal_structure_features::brief_reading(&units, split_tier, join_bodies, file_number.as_deref(),
            |keys| Ok(alias_groups(&store, &keys)?.into_iter().map(|group| group.keys).collect()))?;
        let statutes = reading.statutes.clone();
        let mut readings = READINGS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        readings.0 += 1;
        let number = readings.0;
        readings.1.push((number, reading));
        let excess = readings.1.len().saturating_sub(RUNS_KEPT);
        readings.1.drain(..excess);
        BriefStatutes { reading: number, statutes }
    }
    /// The draft's review of a brief read (`reading`, from briefReading): its units and their note parts, its citations'
    /// occurrences and its authorities. `pages`: each statute candidate's CanLII pages A2AJ confirmed (statuteUrls).
    now "briefReview" (reading: u32, pages: Vec<Vec<String>>) -> legal_structure_features::BriefReview {
        let reading = {
            let mut readings = READINGS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let at = readings.1.iter().position(|(number, _)| *number == reading)
                .ok_or_else(|| "This brief's reading is no longer kept.".to_owned())?;
            readings.1.remove(at).1
        };
        legal_structure_features::brief_review(reading, &pages)?
    }
    /// The CanLII pages of the statutes A2AJ found (`hits`) that are a statute candidate's.
    now "statuteUrls" (candidate: legal_structure_features::StatuteCandidate, hits: Vec<legal_structure_features::StatuteHit>)
        -> Vec<String> { legal_structure_features::statute_urls(&candidate, &hits) }
    /// A statute's name as statute names are compared: two names alike give one key.
    now "statuteNameKey" (name: String) -> String { legal_structure_features::statute_name_key(&name) }
    now "citationLookupKeys" (texts: Vec<String>) -> Vec<String> {
        texts.iter().map(|text| legal_structure::citation_lookup_key(text)).collect()
    }
    /// What the lookup keys are made by: the key version and the alias table ("4:1a2b3c4d5e6f").
    now "citationKeyVersion" () -> String { engine::citation_key_version() }
    now "providerCitationsInText" (text: String) -> Vec<legal_structure::ProviderCitationMatch> {
        legal_structure::provider_citations_in_text(&text)
    }
    /// A passage's link on a source's page with the fragments planned against the document (legal-structure
    /// passage_links). A page on the host stays a path.
    now "passageLink" (document: Handle, request: legal_structure_features::PassageLinkRequest) -> Option<legal_structure_features::PassageLink> {
        legal_structure_features::host_passage_link(&document.query, document.structure(), &request)
    }
    /// The link citing a passage by its anchor, with its paragraph's or provision's fragments where they plan whole. A
    /// page on the host stays a path.
    now "citedPassageLink" (document: Handle, url: String, pinpoints: Vec<String>) -> Option<String> {
        legal_structure_features::on_host(&url, |url| legal_structure_features::cited_passage_link(&document.query, document.structure(), url, &pinpoints))
    }
    /// The link a passage of an A2AJ document is routed to: the publisher's where its page prints an anchor for the
    /// pinpoint, else CanLII's, else A2AJ Law Web's.
    now "sourceLink" (document: Handle, request: legal_structure_features::SourceLinkRequest) -> Option<String> {
        legal_structure_features::source_link(&document.query, document.structure(), document.canlii.as_deref(), &request)
    }
    /// The ALR Quote Verifier's "[CHECKED]" workbook of a draft and its quote check, read in one run (native/alr-verifier):
    /// its first step, which asks the host what only it can answer, or its workbook written.
    off "alrWorkbook" (request: alr_verifier::Request) -> AlrStep { alr_step(alr_verifier::Run::start(request), None, None)? }
    /// A run's next step, given its host's answer to the question it asked.
    off "alrAnswer" (run: u32, answer: alr_verifier::Answer<Handle>) -> AlrStep {
        let waiting = {
            let mut runs = RUNS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let at = runs.1.iter().position(|(number, _)| *number == run).ok_or_else(|| "This workbook's run is no longer waiting.".to_owned())?;
            runs.1.remove(at).1
        };
        alr_step(waiting, Some(answer), Some(run))?
    }
    /// Whether the engine's registry routes a court code to CanLII.
    /// Whether a model's answer links a Canadian decision, which it must cite by citation, not address.
    now "canadianDecisionLink" (answer: String) -> bool { legal_structure::canadian_decision_link(&answer) }
    /// The citations read in a text, placed in UTF-16 units of the unit it starts at `offset` in.
    now "citationOccurrencesInText" (text: String, offset: Option<usize>) -> Vec<legal_structure::CitationOccurrence> {
        legal_structure::citation_occurrences_in_text(&text, offset.unwrap_or(0))
    }
    now "authorityReferencesInText" (text: String, offset: Option<usize>) -> Vec<legal_structure::AuthorityReferenceOccurrence> {
        legal_structure::authority_references_in_text(&text, offset.unwrap_or(0))
    }
    now "hasCitationInText" (text: String) -> bool { legal_structure::has_citation_in_text(&text)? }
    now "groundedProseErrors" (text: String, cited_evidence_ids: Vec<String>, visible_evidence: Vec<legal_structure_features::VisibleEvidenceText>)
        -> Vec<String> {
        legal_structure_features::grounded_prose_errors(&text, &cited_evidence_ids, &visible_evidence)
    }
    now "quoteRepairSuggestion" (claim: String, spans: Vec<String>) -> Option<String> {
        legal_structure_features::quote_repair_suggestion(&claim, &spans)
    }
    now "searchQuery" (query: String, columns: Option<Vec<String>>) -> legal_structure_features::search_query::SearchQuery {
        legal_structure_features::search_query::compile(&query, columns.as_deref())
    }
    now "renderCitedBlocks" (blocks: Vec<legal_structure_features::CitedBlock>) -> String {
        legal_structure_features::render_cited_blocks(&blocks)
    }
    now "markedQuoteSpans" (text: String) -> Vec<legal_structure_features::MarkedQuoteSpan> {
        legal_structure_features::marked_quote_spans(&text)
    }
    /// A document's citable units as UTF-16 [start, end) spans of its text: every line, and with sentences every
    /// sentence of a line.
    now "documentTextUnits" (document: Handle, sentences: bool) -> Vec<[usize; 2]> {
        legal_structure::text_units(engine::document_text(&document, None), sentences)
    }
    /// The source's words as the author quoted them: the author's changes bracketed, omissions an ellipsis.
    now "editorialQuote" (authored: String, source: String) -> String { legal_structure_features::editorial_quote(&authored, &source) }
    /// How often, up to twice, a quotation stands in a text word for word, only substantive wording compared and its
    /// own edge punctuation left out.
    now "quoteOccurrences" (text: String, quote: String) -> usize { legal_structure_features::quote_occurrences(&text, &quote) }
    /// An authored quotation and the source's words side by side, in pieces, those the other lacks changed.
    now "quotationDiff" (authored: String, source: String) -> legal_structure_features::QuotationDiff {
        legal_structure_features::quotation_diff(&authored, &source)
    }
    /// The one sequence diff (difflib's matching blocks, no junk): each run of `left` and `right` as equal, replaced,
    /// deleted or inserted, by index into each.
    now "sequenceOpcodes" (left: Vec<String>, right: Vec<String>) -> Vec<(&str, usize, usize, usize, usize)> {
        legal_structure_features::sequence_opcodes(&left, &right)
    }
    /// The fewest changed characters that turn `text` into `target`, as [start, length, replacement] edits in UTF-16
    /// (the ALR macro's plan; past its 200-character cutoff, the sequence diff's characters).
    now "characterPlan" (text: String, target: String) -> Vec<(usize, usize, String)> {
        legal_structure_features::character_plan(&text, &target)
    }
    /// `text` (at `base`) as [start, end, edited] runs marking what a character plan changes.
    now "highlightRuns" (text: String, plan: Vec<(usize, usize, String)>, base: Option<usize>) -> Vec<(usize, usize, bool)> {
        legal_structure_features::highlight_runs(&text, &plan, base.unwrap_or(0))
    }
    /// The citations whose cited passage the Authorities review reads: each note's one citation, where its proposition
    /// marks a quotation.
    now "authoritiesDiscrepancyOccurrences" (units: Vec<legal_structure_features::BriefUnit>,
        occurrences: std::collections::HashMap<String, legal_structure_features::BriefOccurrence>) -> Vec<String> {
        legal_structure_features::discrepancy_occurrences(&units, &occurrences)
    }
    /// The Authorities review's findings against the passages the draft's citations cite: a quotation the cited passage
    /// holds otherwise, or one another passage of its source holds.
    now "authoritiesDiscrepancies" (units: Vec<legal_structure_features::BriefUnit>,
        occurrences: std::collections::HashMap<String, legal_structure_features::BriefOccurrence>,
        sources: Vec<legal_structure_features::DiscrepancySource>) -> Vec<legal_structure_features::DiscrepancyFinding> {
        legal_structure_features::discrepancies(&units, &occurrences, &sources)
    }
    /// What a decision on a finding writes into the brief; none for "ignore", or where the brief no longer holds what
    /// the finding read.
    now "authoritiesDiscrepancyCorrection" (units: Vec<legal_structure_features::BriefUnit>,
        occurrences: std::collections::HashMap<String, legal_structure_features::BriefOccurrence>,
        finding: legal_structure_features::DiscrepancyFinding, action: String) -> Option<legal_structure_features::BriefCorrection> {
        legal_structure_features::discrepancy_correction(&units, &occurrences, &finding, &action)
    }
    /// The source passage an authored quotation's words closely align with, where it occurs once.
    now "verbatimRepair" (authored: String, source: String) -> Option<String> { legal_structure_features::verbatim_repair(&authored, &source) }
    /// Each quotation located through the source structure the engine holds (each with the paragraphs, pages and
    /// provisions its citation names) and compared with the source's words there, with groundedProseErrors of it
    /// against the passage it was found in (the whole text where not), named by its id; with `compare` false, located
    /// only. Each is checked against `source` (its status, why, its passage's hash) and linked on its page at its words.
    /// `source`: a provider's text, or a PDF attached for it, read by the locators it prints (a statute's by its
    /// provisions). With `keep`, what was read of the document is kept for the quotations located in it after.
    off "quoteLocateDocument" (document: Handle, source: legal_structure_features::LinkedSource, quotes: Vec<legal_structure_features::QuoteToLocate>,
        compare: Option<bool>, keep: Option<bool>) -> Vec<engine::LocatedQuotation> {
        engine::quote_locate_document(&document, &source, &quotes, compare.unwrap_or(true), keep.unwrap_or(false))?
    }
    /// The document a citation names (`request`), with its provisions' document and its full text's: the store's at
    /// `store`, else A2AJ's where `request.remote`.
    #[cfg(feature = "a2aj")]
    off "a2ajLookup" (store: PathBuf, request: a2aj::remote::Request) -> Outcome<a2aj::remote::Looked<StoreDocument>> {
        http::outcome(a2aj::remote::document_asking(&store, &request, NativeDocument::reading)
            .map(|looked| looked.map(|found| StoreDocument::of(None, found))))?
    }
    /// One provision (`section`) of the statute `request` names, as an excerpt of the document `excerpt` describes: the
    /// store's, else A2AJ's; null where neither holds its text.
    #[cfg(feature = "a2aj")]
    off "a2ajProvisionLookup" (store: PathBuf, request: a2aj::remote::Request, section: String, excerpt: legal_structure_features::a2aj::Excerpt)
        -> Outcome<Option<Handle>> {
        http::outcome(a2aj::remote::provision_asking(&store, &request, &section, excerpt, NativeDocument::reading).map(|found| found.map(Handle)))?
    }
    /// The citation of the one decision the store holds (else A2AJ, where `remote`) under a style of cause, in a year, of one of
    /// `courts` (any where none): a decision cited by an identifier A2AJ does not carry, a CanLII number. Null where
    /// none answers, or several.
    #[cfg(feature = "a2aj")]
    off "a2ajNamedLookup" (store: PathBuf, named: a2aj::Named, language: Option<legal_structure_features::a2aj::Language>, remote: bool)
        -> Outcome<Option<String>> {
        http::outcome(a2aj::remote::named_asking(&store, &named, self::language(language), remote))?
    }
    /// The courts and tribunals (`cases`) or statute collections (`laws`) A2AJ holds, as its coverage lists them.
    #[cfg(feature = "a2aj")]
    off "a2ajCoverage" (doc_type: String) -> Outcome<Vec<a2aj::remote::Coverage>> {
        http::outcome(a2aj::remote::coverage(legal_structure_features::a2aj::doc_type(&doc_type)))?
    }
    /// The name of the jurisdiction a statute collection's suffix names ("LEGISLATION-ON" is Ontario); null where none.
    #[cfg(feature = "a2aj")]
    now "a2ajCollectionJurisdiction" (collection: String) -> Option<String> {
        a2aj::remote::collection_jurisdiction(&collection).map(|(_, name)| name)
    }
    /// Forgets every answer and hold the engine's requests kept, as a run that starts over does.
    now "lookupsForget" () -> () { http::forget() }
    /// A Decisia decision's page as its index (query and fragment dropped); null for any other address.
    now "decisiaIndex" (address: String) -> Option<String> { legal_structure_features::decisia_index(&address) }
    /// The PDF a Decisia decision's index page (`markup`, at `index`) offers in its own controls.
    now "decisiaMarkupPdf" (markup: String, index: String) -> Option<legal_structure_features::VerifiedPdf> {
        legal_structure_features::decisia_markup_pdf(&markup, &index)
    }
    /// The Constitution Act or annual statute of Canada `text` cites, from Justice Laws (an annual statute only with
    /// `remote`, as its title is read off its page there); null for any other citation.
    off "justiceLaws" (text: String, remote: bool) -> Outcome<Option<legal_structure_features::foreign_case::JusticeLaws>> {
        http::outcome(legal_structure_features::foreign_case::justice_laws(&text, remote))?
    }
    /// The publishers abroad the citations in `text` name (tna, govuk-et, govinfo), in the order they are asked.
    now "foreignCaseClaimed" (text: String) -> Vec<&'static str> { legal_structure_features::foreign_case::claimed(&text) }
    /// The decision the citations in `text` name, from the first publisher abroad that holds it (`only`: that one alone):
    /// a UK neutral citation's at Find Case Law, a tribunal case number's at GOV.UK, a US federal docket's at GovInfo; a
    /// source kept from an earlier lookup (`saved`, its page) read there without searching again.
    off "foreignCase" (text: String, only: Option<String>, saved: Option<String>) -> Outcome<Option<ForeignCase>> {
        http::outcome(foreign_case(&text, only.as_deref(), saved.as_deref()))?
    }
    /// The one CourtListener case a US reporter citation in `text` names: the bulk store's, else its citation lookup's.
    off "courtlistenerCluster" (access: court_listener::Access, text: String) -> Outcome<Option<u64>> {
        http::outcome(court_listener::cluster_of(&access, &text))?
    }
    /// A CourtListener case with its opinions (`opinion` alone where given), each read whole: the bulk store's, else
    /// the API's.
    off "courtlistenerCase" (access: court_listener::Access, cluster: u64, opinion: Option<u64>) -> Outcome<Option<CourtListenerCase>> {
        http::outcome(court_listener_case(&access, cluster, opinion))?
    }
    /// The CourtListener cases a search finds: the bulk store's, else CourtListener's search.
    off "courtlistenerSearch" (access: court_listener::Access, search: court_listener::Search) -> Outcome<Vec<court_listener::Hit>> {
        http::outcome(court_listener::search(&access, &search))?
    }
    /// The PDF a Decisia decision's page offers, its index asked for; null where none could be had.
    off "decisiaPdf" (page: String) -> Option<legal_structure_features::VerifiedPdf> { legal_structure_features::decisia_pdf(&page) }
    /// The journals database's path: as configured, else the shared one, else the one the search index was built from.
    now "journalPath" (stores: journal::JournalStores) -> String { journal::database_path(&stores)?.to_string_lossy().into_owned() }
    /// The journal articles answering a search, at most 25.
    now "journalSearch" (stores: journal::JournalStores, search: journal::Search) -> Vec<journal::Hit> { journal::search(&stores, &search)? }
    /// The article an identifier (its number, citation or name) names, with its document; null where no one article
    /// with a public text and address answers.
    off "journalDocument" (stores: journal::JournalStores, identifier: String) -> Option<JournalDocument> {
        journal::document(&stores, &identifier, |source| {
            let filename = source.package.map(|package| package.to_string_lossy().into_owned());
            engine::derive_document_structure(engine::StructureRequest::Journal { article_id: source.article_id, url: Some(source.url),
                text: filename.is_none().then_some(source.text), filename, page_rows: source.pages })
        })?.map(|(article, native)| JournalDocument { article, native: Handle(native) })
    }
    /// The number of the article a citation (or one of its other forms) names; null where none, or several.
    now "journalNamed" (stores: journal::JournalStores, texts: Vec<String>) -> Option<i64> { journal::named(&stores, &texts)? }
    /// An article's PDF opened at a printed page; null where its page map lacks the page.
    now "journalPageLink" (stores: journal::JournalStores, identity: String, page: String) -> Option<String> {
        journal::page_link(&stores, &identity, &page)?
    }
    /// Closes the journal files and forgets what was read of them.
    now "journalForget" () -> () { journal::forget() }
    /// The document a record A2AJ's API answered with holds, read and derived as a store's row is; null for a record
    /// without a text or a citation.
    #[cfg(feature = "a2aj")]
    off "a2ajRecord" (record: Untyped<Value>, language: Option<legal_structure_features::a2aj::Language>, doc_type: String) -> Option<StoreDocument> {
        a2aj::record(&record.0, self::language(language), &doc_type, NativeDocument::reading)?.map(|found| StoreDocument::of(None, found))
    }
    /// Each citation's exact aliases and authored forms in the store's inventory; its own key alone where there is
    /// no store.
    now "a2ajAliasGroups" (store: std::path::PathBuf, keys: Vec<String>) -> Vec<engine::AliasGroup> { alias_groups(&store, &keys)? }
    /// Each style of cause compared as its words: the key of the store's names and of CanLII's titles.
    #[cfg(feature = "a2aj")]
    now "a2ajNameKeys" (names: Vec<String>) -> Vec<String> { names.iter().map(|name| a2aj::name_key(name)).collect() }
    /// The documents answering a search, as a search lists them (never their text): the store's, else A2AJ's where the
    /// store has no full-text indexes, where `remote`.
    #[cfg(feature = "a2aj")]
    off "a2ajSearch" (store: PathBuf, search: a2aj::Search, remote: bool) -> Outcome<Vec<legal_structure_features::a2aj::Listing>> {
        http::outcome(a2aj::remote::search_asking(&store, search, remote))?
    }
    /// The id of the one document the store holds under a citation; null where none, or no store.
    #[cfg(feature = "a2aj")]
    now "a2ajFind" (store: PathBuf, lookup: a2aj::Lookup) -> Option<i64> { a2aj::find_id(&store, &lookup)? }
    /// Every court and jurisdiction in the store, with how many documents each has and the file it was installed
    /// from where the installer recorded it; null where there is no store.
    #[cfg(feature = "a2aj")]
    now "a2ajCourts" (store: PathBuf) -> Option<Vec<a2aj::Court>> { a2aj::courts(&store)? }
    /// The store's documents with these ids, of a kind, each in the language asked for where it has text in it, else
    /// the other, derived as a2ajDocument derives one: what experiments sample the store by.
    #[cfg(feature = "a2aj")]
    off "a2ajStoreDocuments" (store: PathBuf, ids: Vec<i64>, doc_type: Option<String>, language: Option<legal_structure_features::a2aj::Language>)
        -> Option<Vec<StoreDocument>> {
        a2aj::documents(&store, &ids, doc_type.as_deref().unwrap_or("cases"), self::language(language), NativeDocument::reading)?
            .map(|found| found.into_iter().map(|(id, found)| StoreDocument::of(Some(id), found)).collect())
    }
    /// The same documents' text and provisions as the store holds them, for experiments that read the text itself.
    #[cfg(feature = "a2aj")]
    now "a2ajReads" (store: PathBuf, ids: Vec<i64>, doc_type: Option<String>, language: Option<legal_structure_features::a2aj::Language>)
        -> Option<Vec<a2aj::StoreRead>> {
        a2aj::reads(&store, &ids, doc_type.as_deref().unwrap_or("cases"), self::language(language))?
    }
    /// The decisions citing a decision and what they and journal authors say it stands for, from the graph beside
    /// the A2AJ store at `store` (which gives the decision's keys); null where no graph is built.
    #[cfg(feature = "a2aj")]
    now "citatorNoteUp" (store: PathBuf, request: legal_structure_features::citator_graph::NoteUpRequest)
        -> Option<legal_structure_features::citator_graph::NoteUp> {
        let mut request = request;
        request.keys = a2aj::alias_keys(&store, &request.citation)?;
        legal_structure_features::citator_graph::note_up(&store, &request).map_err(|error| error.to_string())?
    }
    /// How much each citation is cited, by the graph beside the store at `store`; null where none is built.
    #[cfg(feature = "a2aj")]
    now "citatorMetrics" (store: PathBuf, citations: Vec<String>) -> Option<Vec<Option<legal_structure_features::citator_graph::AuthorityMetric>>> {
        legal_structure_features::citator_graph::authority_metrics(&store, &citations).map_err(|error| error.to_string())?
    }
    now "readDocumentRange" (document: Handle, kind: legal_structure::NodeKind, from: String, to: String, context_blocks: usize)
        -> Option<legal_structure::DocumentRangeLookup<'_>> {
        document.query.read_range(document.structure(), kind, &from, &to, context_blocks)
    }
    now "smallestContainingDocumentBlock" (document: Handle, start: usize, end: usize) -> Option<legal_structure::Passage<'_>> {
        document.query.smallest_containing_block(document.structure(), start, end)
    }
    /// What `start..end` is cited by: the node `nodeId` names (else the smallest block holding the span) where it is a
    /// labelled page, or a paragraph, provision or note printing its label; else the labelled page holding the span.
    now "documentLocator" (document: Handle, start: usize, end: usize, node_id: Option<String>) -> Option<legal_structure::Locator> {
        document.query.locator(document.structure(), start, end, node_id.as_deref())
    }
    now "lookupStructureBlock" (document: Handle, locator: engine::BlockLocator, context_blocks: u32) -> legal_structure::DocumentLookup<'_> {
        engine::lookup_structure_block(&document, locator, context_blocks)
    }
    now "resolveDocumentAddressSpans" (document: Handle, spec: String, follow: legal_structure::FollowDirection, depth: usize)
        -> legal_structure::DocumentAddressResolution {
        document.query.resolve_address_spans(document.structure(), &spec, follow, depth)
    }
    now "graphScope" (document: Handle, seed: legal_structure::GraphScopeSeed, follow: legal_structure::FollowDirection, depth: u32,
        include_descendants: bool, include_units: bool) -> Option<legal_structure::GraphScope<'_>> {
        engine::graph_scope(&document, &seed, follow, depth, include_descendants, include_units)
    }
    now "documentHasOrigin" (document: Handle, origin: legal_structure::Derivation) -> bool {
        document.query.has_origin(document.structure(), origin)
    }
}

/// Runs one framed request and frames its reply. A panic is reported as the call's error.
pub fn call(request: &[u8], progress: Progress) -> Vec<u8> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Value, Failure> {
        let header = request.get(..4).ok_or("truncated engine request")?;
        let json_length = u32::from_le_bytes(header.try_into().unwrap()) as usize;
        let json = request.get(4..4 + json_length).ok_or("truncated engine request")?;
        let parsed: Value = serde_json::from_slice(json).map_err(|error| error.to_string())?;
        let op = parsed.get("op").and_then(Value::as_str).ok_or("engine request lacks op")?;
        let args = parsed.get("args").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        // A document JavaScript no longer holds, which no operation names.
        if op == "releaseDocument" {
            documents().1.remove(&argument("document", args.first())?);
            return Ok(Value::Null);
        }
        // SAFETY: the request outlives the call, and its bytes are forgotten before the call returns.
        REQUEST_BYTES.set(unsafe { std::mem::transmute::<&[u8], &'static [u8]>(&request[4 + json_length..]) });
        dispatch(op, args, progress)
    }));
    REQUEST_BYTES.set(&[]);
    let bytes = REPLY_BYTES.take();
    let (ok, json, bytes) = match result {
        Ok(Ok(output)) => (true, serde_json::to_vec(&output).unwrap_or_default(), bytes),
        Ok(Err(failure)) => (false, serde_json::to_vec(&failure).unwrap_or_default(), Vec::new()),
        Err(panic) => (
            false,
            serde_json::to_vec(&Failure::from(
                panic
                    .downcast_ref::<&str>()
                    .map(|text| text.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "engine panicked".to_owned()),
            ))
            .unwrap_or_default(),
            Vec::new(),
        ),
    };
    let mut reply = Vec::with_capacity(5 + json.len() + bytes.len());
    reply.push(ok as u8);
    reply.extend_from_slice(&(json.len() as u32).to_le_bytes());
    reply.extend_from_slice(&json);
    reply.extend_from_slice(&bytes);
    reply
}
