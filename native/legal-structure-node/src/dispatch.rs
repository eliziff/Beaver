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
    native: Handle,
    search_native: Handle,
}

#[cfg(feature = "a2aj")]
impl StoreDocument {
    fn of(id: Option<i64>, found: a2aj::Found<NativeDocument>) -> Self {
        let search = found.search.unwrap_or_else(|| Arc::clone(&found.native));
        Self {
            id,
            metadata: found.metadata,
            native: Handle(found.native),
            search_native: Handle(search),
        }
    }
}

/// A statute's provision as the store holds it: found, or the provision or the statute missing.
#[cfg(feature = "a2aj")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum Provision {
    Found { native: Handle },
    MissingProvision,
    MissingStatute,
}

/// A value TypeScript is not told the shape of (`unknown`): the citation engine's own API, a PDF's parse request, a
/// record A2AJ's API answered with.
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

/// A PDF the engine wrote, or a Word document it rewrote: its bytes after the reply's JSON, and what it says of them.
#[cfg(feature = "legalpdf")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub(crate) struct WrittenPdf {
    bytes: Buffer,
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
pub(crate) struct SourcePdf {
    bytes: Buffer,
    page_count: usize,
    outline: Vec<legalpdf::compose::Outline>,
}


#[cfg(feature = "docx")]
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub(crate) struct SupraCleanup {
    bytes: Buffer,
    #[serde(flatten)]
    cleanup: legalpdf::DocxSupraCleanup,
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

#[cfg(feature = "a2aj")]
fn language(language: Option<legal_structure_features::a2aj::Language>) -> legal_structure_features::a2aj::Language {
    language.unwrap_or(legal_structure_features::a2aj::Language::En)
}

operations! { progress;
    now "nativeBuildFeatures" () -> String { engine::native_build_features().to_owned() }
    off "deriveDocumentStructure" (request: engine::StructureRequest) -> Handle {
        Handle::new(engine::derive_document_structure(request)?)
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
        -> WrittenPdf {
        let written = legalpdf::write_annotations(&bytes, &marks, &namespace, disarm.unwrap_or(true)).map_err(|error| error.to_string())?;
        WrittenPdf { bytes: Buffer(written) }
    }
    /// A source's own PDF set from its provider's text (assembly/statute.rs): a statute by its provisions, a judgment by
    /// its paragraphs.
    #[cfg(feature = "legalpdf")]
    off "renderSourcePdf" (source: crate::assembly::statute::SourceText) -> SourcePdf {
        let (bytes, page_count, outline) = crate::assembly::statute::render_source_pdf(&source)?;
        SourcePdf { bytes: Buffer(bytes), page_count, outline }
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
    /// Each page's crop box ([x, y, width, height]), rotation, and links to web addresses ([index, uri, rect]).
    #[cfg(feature = "legalpdf")]
    off "pdfPages" (bytes: Bytes) -> Vec<legalpdf::compose::PageFrame> {
        legalpdf::compose::page_frames(&bytes).map_err(|error| error.to_string())?
    }
    /// The brief and its book as one PDF.
    #[cfg(feature = "legalpdf")]
    off "renderFinalPdf" (bytes: Bytes, plan: crate::assembly::book::FinalPlan) -> RenderedPdf {
        let (bytes, page_count) = crate::assembly::book::render_final(&plan, &bytes)?;
        RenderedPdf { bytes: Buffer(bytes), page_count }
    }
    /// A PDF read and cached where another engine reopens it by its cache key (a page's parse workers): its summary.
    #[cfg(feature = "legalpdf")]
    progress "preparePdfDocument" (bytes: Bytes, request: Untyped<legalpdf::PdfRequest>) -> legalpdf::PdfSummary {
        legalpdf::read_pdf(Some(&bytes), &request.0, progress)?.ok_or("PDF cache miss after parsing source bytes")?.summary().clone()
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
    now "documentRevision" (document: Handle) -> &String { &document.structure().revision }
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
    /// Where a statute's text holds each cited provision, part ("16(3)(a)") or range ("49-51"), by its outline: each span
    /// (UTF-16) with everything under it, in the text's order; a label it does not hold has none.
    now "statuteProvisionSpans" (text: String, labels: Vec<String>) -> Vec<[usize; 2]> {
        legal_structure::statute_provision_spans(&text, &labels).map_err(|error| error.to_string())?
    }
    /// A reader's labels of one kind as few as they can be written: runs of numbers ("12–14"), provisions' spans
    /// ("5(2)(a)–(c)"); null where a label is not of the kind's shape.
    now "collapseLabels" (labels: Vec<String>, kind: String) -> Option<Vec<String>> { legal_structure::collapse_labels(&labels, &kind) }
    /// Each typed locator of a kind as the label it names, the words it may open on taken off: "para. 12" and "par12"
    /// are "12", "s. 5(2)" and "sec5(2)" are "5(2)", "fn 3" is "3".
    now "bareLabels" (labels: Vec<String>, kind: String) -> Vec<String> {
        labels.iter().map(|label| legal_structure::bare_label(&kind, label)).collect()
    }
    /// Each numbered label of a kind as the numbers it names, a run written out ("12–14": 12, 13, 14): null for one
    /// naming no number or run, or a run reversed or spanning more than `limit` past its first number.
    now "expandLabels" (labels: Vec<String>, kind: String, limit: usize) -> Vec<Option<Vec<String>>> {
        legal_structure::expand_labels(&labels, &kind, limit)
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
    /// A call of the citation engine's API (legal-citations `api::call_value`): its method and its request as it reads it.
    now "citationEngineCall" (method: String, request: Untyped<Value>) -> Untyped<Value> {
        Untyped(legal_structure::citations::api::call_value(&method, request.0).map_err(|error| error.to_string())?)
    }
    /// Each note's proposition in a brief's body text (its body units in order, each followed by a line break): the
    /// passage since the call before its one call, or with `context` "sentence", the sentence its call ends or stands
    /// in; each with the parts of the units (by their place in `units`) it holds. Also where each body unit starts in
    /// that text and every call of a note in it by where it stands. Offsets in UTF-16 units.
    now "footnotePropositions" (units: Vec<legal_structure_features::PropositionUnit>, context: Option<legal_structure_features::QuoteContext>)
        -> legal_structure_features::FootnotePropositions {
        legal_structure_features::footnote_propositions(&units, context.unwrap_or(legal_structure_features::QuoteContext::Passage))
    }
    /// A brief's text, its units joined by a blank line, and its notes in reading order as the citation engine reads
    /// them (number u32::MAX where unprinted, the span, the sequence, the call).
    now "briefText" (units: Vec<legal_structure_model::AuthorityTextUnit>) -> legal_structure_features::BriefText {
        legal_structure_features::brief_text(&units)
    }
    /// The units as joined (with `joinBodies`, the body units a citation runs across are one), where each starts in the
    /// brief's text, and the citations' indexes in reading order (a note's after the body up to its call).
    now "briefCitationOrder" (units: Vec<legal_structure_model::AuthorityTextUnit>, citations: Vec<legal_structure_features::BriefCitation>,
        join_bodies: bool) -> legal_structure_features::BriefCitationOrder {
        legal_structure_features::brief_citation_order(&units, &citations, join_bodies)
    }
    now "citationLookupKeys" (texts: Vec<String>) -> Vec<String> {
        texts.iter().map(|text| legal_structure::citation_lookup_key(text)).collect()
    }
    /// What the lookup keys are made by: the key version and the alias table ("4:1a2b3c4d5e6f").
    now "citationKeyVersion" () -> String { engine::citation_key_version() }
    now "providerCitationsInText" (text: String) -> Vec<legal_structure::ProviderCitationMatch> {
        legal_structure::provider_citations_in_text(&text)
    }
    /// The CanLII page of the first decision the citations name by a neutral or CanLII citation with its court written,
    /// of `court` where given and routed; null where none.
    now "canliiCaseUrl" (citations: Vec<String>, language: Option<String>, court: Option<String>) -> Option<String> {
        legal_structure::canlii_case_url(&citations, &language.unwrap_or_default(), court.as_deref())
    }
    /// The CanLII page, in `language` (English by default), of the first statute or regulation the text cites; null
    /// where none. `consolidated` where it is a statute in force as consolidated (an A2AJ legislation record).
    now "canliiLawUrl" (text: String, language: Option<String>, consolidated: Option<bool>) -> Option<String> {
        legal_structure::canlii_law_url(&text, &language.unwrap_or_default(), consolidated.unwrap_or(false))
    }
    /// A passage's link on a source's page with the fragments planned against the document (legal-structure
    /// passage_links).
    now "passageLink" (document: Handle, request: legal_structure_features::PassageLinkRequest) -> Option<legal_structure_features::PassageLink> {
        legal_structure_features::passage_link(&document.query, document.structure(), &request)
    }
    /// The link citing a passage by its anchor, with its paragraph's or provision's fragments where they plan whole.
    now "citedPassageLink" (document: Handle, url: String, pinpoints: Vec<String>) -> Option<String> {
        legal_structure_features::cited_passage_link(&document.query, document.structure(), &url, &pinpoints)
    }
    /// The link a passage of an A2AJ document is routed to: the publisher's where its page prints an anchor for the
    /// pinpoint, else CanLII's, else A2AJ Law Web's.
    now "sourceLink" (document: Handle, request: legal_structure_features::SourceLinkRequest) -> Option<String> {
        legal_structure_features::source_link(&document.query, document.structure(), &request)
    }
    /// Whether the engine's registry routes a court code to CanLII.
    now "canliiCourtRoute" (court: String) -> bool { legal_structure::canlii_court_route(&court) }
    now "citationOccurrencesInText" (text: String) -> Vec<legal_structure::CitationOccurrence> {
        legal_structure::citation_occurrences_in_text(&text)
    }
    now "authorityReferencesInText" (text: String) -> Vec<legal_structure::AuthorityReferenceOccurrence> {
        legal_structure::authority_references_in_text(&text)
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
    /// The searches of a journal index's names for the articles a citation quotes the titles of (FTS5 queries).
    now "journalTitleSearches" (citation: String) -> Vec<legal_structure_features::JournalTitleSearch> {
        legal_structure_features::journal_title_searches(&citation)
    }
    /// The article whose found name is closest to the title searched for it, when close enough.
    now "journalTitleChoice" (hits: Vec<legal_structure_features::JournalTitleHit>) -> Option<i64> {
        legal_structure_features::journal_title_choice(&hits)
    }
    /// Where a quotation's words are in a source passage, the passage it is compared with, and what differs.
    now "quoteComparison" (authored: String, source: String) -> legal_structure_features::QuoteComparison {
        legal_structure_features::quote_text_comparison(&authored, &source)
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
    /// The source passage an authored quotation's words closely align with, where it occurs once.
    now "verbatimRepair" (authored: String, source: String) -> Option<String> { legal_structure_features::verbatim_repair(&authored, &source) }
    /// Each quotation located through the source structure the engine holds (each with the paragraphs, pages and
    /// provisions its citation names) and compared with the source's words there, with groundedProseErrors of it
    /// against the passage it was found in (the whole text where not), named by its id; with `compare` false, located
    /// only. `source`: a provider's text, a PDF read by the locators it prints, or a statute's PDF read by its
    /// provisions. With `keep`, what was read of the document is kept for the quotations located in it after.
    off "quoteLocateDocument" (document: Handle, source: legal_structure_features::QuoteSource, quotes: Vec<legal_structure_features::QuoteToLocate>,
        compare: Option<bool>, keep: Option<bool>) -> Vec<engine::LocatedQuotation> {
        engine::quote_locate_document(&document, source, &quotes, compare.unwrap_or(true), keep.unwrap_or(false))?
    }
    /// The one document the local A2AJ store at `store` holds under a citation's key, with its provisions' document and
    /// its full text's; null where the store, or the document, is missing.
    #[cfg(feature = "a2aj")]
    off "a2ajDocument" (store: PathBuf, lookup: a2aj::Lookup) -> Option<StoreDocument> {
        a2aj::document(&store, &lookup, NativeDocument::of)?.map(|found| StoreDocument::of(None, found))
    }
    /// The document a record A2AJ's API answered with holds, read and derived as a store's row is; null for a record
    /// without a text or a citation.
    #[cfg(feature = "a2aj")]
    off "a2ajRecord" (record: Untyped<Value>, language: Option<legal_structure_features::a2aj::Language>, doc_type: String) -> Option<StoreDocument> {
        a2aj::record(&record.0, self::language(language), &doc_type, NativeDocument::of)?.map(|found| StoreDocument::of(None, found))
    }
    /// One provision of a statute, from the records A2AJ's API answered a lookup of it with, as an excerpt of the
    /// document `excerpt` describes; null where no record of the collection and address asked for holds its text.
    #[cfg(feature = "a2aj")]
    off "a2ajRecordProvision" (records: Vec<Untyped<Value>>, lookup: a2aj::ProvisionLookup, excerpt: legal_structure_features::a2aj::Excerpt)
        -> Option<Handle> {
        let records = records.into_iter().map(|record| record.0).collect::<Vec<_>>();
        a2aj::record_provision(&records, &lookup, excerpt, NativeDocument::of)?.map(Handle)
    }
    /// A record A2AJ's API answered with, as a search lists it; null for one without a citation.
    #[cfg(feature = "a2aj")]
    now "a2ajRecordListing" (record: Untyped<Value>, language: Option<legal_structure_features::a2aj::Language>)
        -> Option<legal_structure_features::a2aj::Listing> {
        a2aj::record_listing(&record.0, self::language(language))
    }
    /// The places, among records A2AJ's API answered with, of those answering a citation (by its key or one of
    /// `aliases`), of the collection and at the address asked for.
    #[cfg(feature = "a2aj")]
    now "a2ajRecordMatches" (records: Vec<Untyped<Value>>, query: legal_structure_features::a2aj::Query) -> Vec<usize> {
        a2aj::record_matches(&records.into_iter().map(|record| record.0).collect::<Vec<_>>(), &query)
    }
    /// One provision of a statute the store holds, as an excerpt of the document `excerpt` describes, or that the store
    /// lacks the provision or the statute.
    #[cfg(feature = "a2aj")]
    off "a2ajSection" (store: PathBuf, lookup: a2aj::Lookup, section: String, excerpt: legal_structure_features::a2aj::Excerpt) -> Provision {
        match a2aj::section(&store, &lookup, &section, excerpt, NativeDocument::of)? {
            Some(Some(native)) => Provision::Found { native: Handle(native) },
            Some(None) => Provision::MissingProvision,
            None => Provision::MissingStatute,
        }
    }
    /// Each citation's exact aliases and authored forms in the store's inventory; its own key alone where there is
    /// no store.
    now "a2ajAliasGroups" (store: std::path::PathBuf, keys: Vec<String>) -> Vec<engine::AliasGroup> {
        #[cfg(feature = "a2aj")]
        let groups = a2aj::alias_groups(&store, &keys)?;
        #[cfg(not(feature = "a2aj"))]
        let groups = { let _ = store; keys.iter().map(|key| engine::AliasGroup::own(key)).collect() };
        groups
    }
    /// The citation of the one decision the store holds under a style of cause, in a year, of one of `courts` (any
    /// where none): a decision cited by an identifier A2AJ does not carry. Null where none answers, or several.
    #[cfg(feature = "a2aj")]
    now "a2ajNamedCase" (store: PathBuf, named: a2aj::Named) -> Option<String> { a2aj::named_case(&store, &named)? }
    /// The same of the records A2AJ's API answered a search of the name with.
    #[cfg(feature = "a2aj")]
    now "a2ajNamedRecord" (records: Vec<Untyped<Value>>, named: a2aj::Named, language: Option<legal_structure_features::a2aj::Language>)
        -> Option<String> {
        a2aj::named_record(&records.into_iter().map(|record| record.0).collect::<Vec<_>>(), &named, self::language(language))
    }
    /// Each style of cause compared as its words: the key of the store's names and of CanLII's titles.
    #[cfg(feature = "a2aj")]
    now "a2ajNameKeys" (names: Vec<String>) -> Vec<String> { names.iter().map(|name| a2aj::name_key(name)).collect() }
    /// The store's documents answering a search, as a search lists them (never their text); null where there is no
    /// store or it has no full-text indexes.
    #[cfg(feature = "a2aj")]
    now "a2ajSearch" (store: PathBuf, search: a2aj::Search) -> Option<Vec<legal_structure_features::a2aj::Listing>> { a2aj::search(&store, &search)? }
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
        a2aj::documents(&store, &ids, doc_type.as_deref().unwrap_or("cases"), self::language(language), NativeDocument::of)?
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
