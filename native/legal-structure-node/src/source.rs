//! A stored source read as the engine's document, whatever its format: the one way from a source's bytes to its
//! structure, and to its text. The engine keeps the documents it read (its working set, beside the PDF parser's disk
//! cache) by what each was read as, while a reader holds them, the latest eight; a document being read is waited for,
//! not read twice.

#[cfg(feature = "legalpdf")]
use crate::engine::NativeProduct;
use crate::dispatch::Progress;
use crate::engine::{Failure, NativeDocument};
use crate::formats;
use legal_structure::{analyze_instrument, utf16_prefix_ceil, DocumentStructure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};

const MAX_SOURCE_BYTES: usize = 100 * 1024 * 1024;
const MAX_PACKAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const KEPT: usize = 8;

/// A source as the engine reads it: whose version it is, its file type, the hash its bytes must have, and how it is
/// read: a Word document's text, drafting or redline view, a PDF's parse request (`legalpdf::PdfRequest`: its profile,
/// cache and pages, and the reading it names by cache key; the engine names the document and its hash). A Word or
/// PowerPoint binary (doc, ppt) comes as the PDF converted from it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRequest {
    document_id: String,
    version_id: String,
    file_type: String,
    source_sha256: String,
    #[serde(default)]
    mode: Mode,
    #[serde(default)]
    pdf: serde_json::Value,
}

/// What text is read of a source: with `drafting`, a Word document's drafting text; at most `limit` UTF-16 units.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRequest {
    file_type: String,
    source_sha256: String,
    #[serde(default)]
    drafting: bool,
    limit: Option<u32>,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    #[default]
    Text,
    Drafting,
    Redline,
}

#[derive(Clone, Copy, PartialEq)]
enum Format {
    Pdf,
    /// A Word or PowerPoint binary, read as the PDF converted from it.
    Converted,
    Docx,
    Sheet,
    Slides,
    Email,
    Text,
}

fn format_of(file_type: &str) -> Result<Format, Failure> {
    Ok(match file_type {
        "pdf" => Format::Pdf,
        "doc" | "ppt" => Format::Converted,
        "docx" => Format::Docx,
        "xlsx" | "xlsm" | "xls" => Format::Sheet,
        "pptx" => Format::Slides,
        "eml" => Format::Email,
        "txt" | "text" | "md" | "markdown" | "mdown" | "rst" | "log" => Format::Text,
        _ => return Err(format!("Document type {file_type} has no text projection").into()),
    })
}

/// The source's bytes, bounded and checked against the hash of its version. A Word view other than its text reads
/// the package itself, past the bound on a compressed package.
fn bounded<'a>(bytes: &'a [u8], file_type: &str, sha256: &str, package_view: bool) -> Result<&'a [u8], Failure> {
    if bytes.is_empty() || bytes.len() > MAX_SOURCE_BYTES {
        return Err("Document projection input exceeds the read limit".into());
    }
    if !package_view && ["docx", "xlsx", "xlsm", "pptx"].contains(&file_type) && bytes.len() > MAX_PACKAGE_BYTES {
        return Err("Compressed document exceeds the read limit".into());
    }
    if format!("{:x}", Sha256::digest(bytes)) != sha256 {
        return Err("Document source bytes no longer match their version".into());
    }
    Ok(bytes)
}

fn output_bounded(text: String) -> Result<String, Failure> {
    if text.len() > MAX_OUTPUT_BYTES {
        return Err("Document projection output exceeds the read limit".into());
    }
    Ok(text)
}

/// The text a reader of the format gives: a workbook's grid, a presentation's slides, an email, a plain text without
/// its byte-order mark.
fn format_text(format: Format, file_type: &str, bytes: &[u8]) -> Result<String, Failure> {
    Ok(match format {
        Format::Sheet => formats::sheet::read(bytes, file_type)?.text,
        Format::Slides => formats::slides::text(bytes)?,
        Format::Email => formats::email::text(bytes),
        Format::Text => {
            let text = String::from_utf8_lossy(bytes);
            text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned()
        }
        _ => return Err(format!("Document type {file_type} has no text projection").into()),
    })
}

/// The text of a source that is not read through a PDF: Word's (its drafting text where asked, its own text where the
/// drafting text cannot be read), or its format reader's; at most `limit` UTF-16 units.
pub fn source_text(bytes: &[u8], request: TextRequest) -> Result<String, Failure> {
    let format = format_of(&request.file_type)?;
    let bytes = bounded(bytes, &request.file_type, &request.source_sha256, false)?;
    if format == Format::Docx {
        #[cfg(feature = "docx")]
        {
            let read = |drafting| legalpdf::docx_text(bytes, drafting).map_err(|error| error.to_string());
            let text = if request.drafting { read(true).or_else(|_| read(false)) } else { read(false) }?;
            return output_bounded(limited(text, request.limit));
        }
        #[cfg(not(feature = "docx"))]
        return Err("Word documents require the engine's DOCX reader".into());
    }
    output_bounded(limited(format_text(format, &request.file_type, bytes)?, request.limit))
}

fn limited(mut text: String, limit: Option<u32>) -> String {
    if let Some(limit) = limit {
        text.truncate(utf16_prefix_ceil(&text, limit as usize).len());
    }
    text
}

/// The document a source reads as: one the engine keeps, a PDF reading its parser cached under the cache key asked
/// for, or, given the source's bytes, the source read afresh (a PDF named by a cache key no longer kept is parsed again
/// with the profile it was asked with). Without bytes, none where the engine keeps none: the caller reads the bytes and
/// asks again.
#[cfg_attr(not(feature = "legalpdf"), allow(unused_variables))]
pub fn open_source(bytes: &[u8], request: SourceRequest, progress: Progress) -> Result<Option<Arc<NativeDocument>>, Failure> {
    let format = format_of(&request.file_type)?;
    let SourceRequest { document_id, version_id, file_type, source_sha256, mode, pdf } = request;
    let id = format!("{document_id}:{version_id}");
    let key = |reading: &str| format!("{file_type}\0{id}\0{source_sha256}\0{reading}");
    // Only a Word document has views; the redline is a Word document's alone.
    let mode = if format == Format::Docx { mode } else if mode == Mode::Redline {
        return Err("Redline requires a DOCX document".into());
    } else { Mode::Text };
    if matches!(format, Format::Pdf | Format::Converted) {
        #[cfg(feature = "legalpdf")]
        return open_pdf(bytes, format, &id, &source_sha256, pdf, key, progress);
        #[cfg(not(feature = "legalpdf"))]
        return Err("PDF documents require the engine's PDF reader".into());
    }
    let reading = match mode { Mode::Text => "text", Mode::Drafting => "drafting", Mode::Redline => "redline" };
    read_once(&key(reading), || {
        if bytes.is_empty() {
            return Ok(None);
        }
        let read = |mode: Mode| -> Result<DocumentStructure, Failure> {
            let bytes = bounded(bytes, &file_type, &source_sha256, mode != Mode::Text)?;
            let instrument = |text: String, id: String| analyze_instrument(text, id, &[], true).map_err(|error| error.to_string());
            Ok(match (format, mode) {
                #[cfg(feature = "docx")]
                (Format::Docx, Mode::Text) => legalpdf::analyze_docx_bytes(bytes, id.clone()).map_err(|error| error.to_string())?,
                #[cfg(feature = "docx")]
                (Format::Docx, Mode::Drafting) => legalpdf::analyze_docx_drafting_bytes(bytes, document_id.clone())
                    .map_err(|error| error.to_string())?,
                (Format::Docx, Mode::Redline) => instrument(formats::redline::text(bytes), document_id.clone())?,
                (Format::Sheet, _) => {
                    let grid = formats::sheet::read(bytes, &file_type)?;
                    analyze_instrument(grid.text, id.clone(), &grid.cells, false).map_err(|error| error.to_string())?
                }
                _ => instrument(output_bounded(format_text(format, &file_type, bytes)?)?, id.clone())?,
            })
        };
        // A drafting view that cannot be read is the document's text, read again next time as drafting.
        let (structure, keep, text_view) = match read(mode) {
            Ok(structure) => (structure, true, mode == Mode::Text),
            Err(_) if mode == Mode::Drafting => (read(Mode::Text)?, false, true),
            Err(error) => return Err(error),
        };
        if text_view && structure.query_text().len() > MAX_OUTPUT_BYTES {
            return Err("Document projection output exceeds the read limit".into());
        }
        Ok(Some(Read { document: Arc::new(NativeDocument::of(structure)), keys: Vec::new(), keep }))
    })
}

/// A PDF's reading: kept by the cache key its parse has, and, read by a profile, by that request too. A request for
/// some pages is served by the whole document's reading where one is kept. A converted source's PDF is read as itself
/// (its hash is its own, not the source's); its document is kept as the source's.
#[cfg(feature = "legalpdf")]
fn open_pdf(
    bytes: &[u8],
    format: Format,
    id: &str,
    source_sha256: &str,
    pdf: serde_json::Value,
    key: impl Fn(&str) -> String,
    progress: Progress,
) -> Result<Option<Arc<NativeDocument>>, Failure> {
    let mut request = serde_json::from_value::<legalpdf::PdfRequest>(pdf.clone()).map_err(|error| Failure::from(error.to_string()))?;
    request.id = Some(id.to_owned());
    request.expected_source_sha256 = (format == Format::Pdf).then(|| source_sha256.to_owned());
    let document = |document: legalpdf::PdfDocument| Arc::new(NativeDocument::new(NativeProduct::Pdf(document)));
    // Without bytes, a reading is still found where the parse cache holds it under the key the request names (a
    // converted source's PDF has no hash to name it by until its bytes are converted).
    let parse = |request: &legalpdf::PdfRequest| -> Result<Option<Read>, Failure> {
        if bytes.is_empty() && request.expected_source_sha256.is_none() {
            return Ok(None);
        }
        let Some(parsed) = legalpdf::read_pdf((!bytes.is_empty()).then_some(bytes), request, progress)? else {
            return Ok(None);
        };
        Ok(Some(Read { keys: vec![key(&parsed.summary().cache_key)], document: document(parsed), keep: true }))
    };
    if let Some(cache_key) = request.cache_key.clone().filter(|_| format == Format::Pdf) {
        return read_once(&key(&cache_key), || {
            if let Some(cached) = legalpdf::read_pdf(None, &request, None)? {
                return Ok(Some(Read { document: document(cached), keys: Vec::new(), keep: true }));
            }
            // Parsed again, it may have a cache key of its own: it is kept by that one.
            request.cache_key = None;
            Ok(parse(&request)?.map(|read| Read { keep: false, ..read }))
        });
    }
    request.cache_key = None;
    // What the PDF is read as: the request, its pages apart.
    let mut whole = pdf;
    if let Some(fields) = whole.as_object_mut() {
        fields.remove("pages");
        fields.remove("cacheKey");
    }
    let reading = |pages: Option<&[usize]>| key(&format!("request:{whole}:{pages:?}"));
    if request.ocr_pages.is_some() {
        if let Some(document) = kept(&reading(None)) {
            return Ok(Some(document));
        }
    }
    read_once(&reading(request.ocr_pages.as_deref()), || parse(&request))
}

/// A document read, the keys it is also kept by, and whether it is kept by the one it was asked by.
struct Read {
    document: Arc<NativeDocument>,
    keys: Vec<String>,
    keep: bool,
}

type Opened = Result<Option<Arc<NativeDocument>>, Failure>;

#[derive(Default)]
struct Pending {
    opened: Mutex<Option<Opened>>,
    done: Condvar,
}

enum Slot {
    Kept(Weak<NativeDocument>),
    Reading(Arc<Pending>),
}

/// The working set, oldest first.
static WORKING: Mutex<Vec<(String, Slot)>> = Mutex::new(Vec::new());

fn working() -> MutexGuard<'static, Vec<(String, Slot)>> {
    WORKING.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The document kept by `key`, if a reader still holds it, made the latest.
fn kept(key: &str) -> Option<Arc<NativeDocument>> {
    let mut set = working();
    let at = set.iter().position(|(kept, slot)| kept == key && matches!(slot, Slot::Kept(_)))?;
    let (kept, slot) = set.remove(at);
    let Slot::Kept(document) = slot else { unreachable!() };
    let live = document.upgrade()?;
    set.push((kept, Slot::Kept(document)));
    Some(live)
}

/// Stops a reading that ended without its document (a panic among them) from keeping its readers waiting.
struct Reading<'a> {
    key: &'a str,
    pending: Arc<Pending>,
    opened: Option<Opened>,
}

impl Drop for Reading<'_> {
    fn drop(&mut self) {
        let opened = self.opened.take().unwrap_or_else(|| Err("engine panicked".into()));
        working().retain(|(key, slot)| !(key == self.key && matches!(slot, Slot::Reading(pending) if Arc::ptr_eq(pending, &self.pending))));
        *self.pending.opened.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(opened);
        self.pending.done.notify_all();
    }
}

/// The document kept by `key`, the one being read by it once that reading ends, or `read`'s, kept by `key` and the
/// keys it names. A reading that ended with none (its reader had no bytes) is not this caller's answer: it asks again.
fn read_once(key: &str, read: impl FnOnce() -> Result<Option<Read>, Failure>) -> Opened {
    let pending = loop {
        if let Some(document) = kept(key) {
            return Ok(Some(document));
        }
        let mut set = working();
        if let Some(Slot::Reading(pending)) = set.iter().find(|(kept, _)| kept == key).map(|(_, slot)| slot) {
            let pending = Arc::clone(pending);
            drop(set);
            let mut opened = pending.opened.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            while opened.is_none() {
                opened = pending.done.wait(opened).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            match opened.clone().expect("a reading ends with its document") {
                Ok(None) => continue,
                opened => return opened,
            }
        }
        let pending = Arc::new(Pending::default());
        set.push((key.to_owned(), Slot::Reading(Arc::clone(&pending))));
        break pending;
    };
    let mut reading = Reading { key, pending, opened: None };
    let opened = read().map(|read| read.map(|read| {
        let mut set = working();
        let keys = read.keep.then(|| key.to_owned()).into_iter().chain(read.keys);
        for kept in keys {
            set.retain(|(key, slot)| !(key == &kept && matches!(slot, Slot::Kept(_))));
            set.push((kept, Slot::Kept(Arc::downgrade(&read.document))));
        }
        set.retain(|(_, slot)| !matches!(slot, Slot::Kept(document) if document.strong_count() == 0));
        while set.iter().filter(|(_, slot)| matches!(slot, Slot::Kept(_))).count() > KEPT {
            let oldest = set.iter().position(|(_, slot)| matches!(slot, Slot::Kept(_))).expect("a kept document");
            set.remove(oldest);
        }
        read.document
    }));
    reading.opened = Some(opened.clone());
    opened
}
