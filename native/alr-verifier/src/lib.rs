//! The ALR Quote Verifier's "[CHECKED] <stem>.xlsx": sheet FootnoteReferences, one row per citation part of each note,
//! read in one run from an Authorities draft and its quote check. What only its host can answer (a model's reading of
//! the notes, a provider's source, a journal's page, a private CanLII index) the run asks for, each kind at once, and
//! takes the answers back; everything else is read here, once.

mod rows;
mod sheet;
mod workbook;

use indexmap::IndexMap;
use legal_structure::citations::source::SourcePart;
use legal_structure::{DocumentQuery, DocumentStructure};
use legal_structure_features::{BriefAuthority, BriefOccurrence, BriefUnit, QuoteContext};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

pub use rows::Row;

/// A source the host read for a part, as the run reads it.
pub trait Source: Send + Sync + 'static {
    fn query(&self) -> &DocumentQuery;
    fn structure(&self) -> &DocumentStructure;
    /// The source's CanLII page, as its reading read it off its citations.
    fn canlii(&self) -> Option<&str>;
    /// Which document it is: two sources the same document are read once.
    fn key(&self) -> usize;
}

/// What the run is asked to write.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub filename: String,
    pub draft: Draft,
    pub check: Check,
    #[serde(default)]
    pub options: Options,
    /// Whether a model reads the notes (an AI run mode): the run asks it to split them and to choose a supra's part.
    #[serde(default)]
    pub model: bool,
    /// Whether the host has a private CanLII index the run may ask for a decision's page.
    #[serde(default)]
    pub canlii_index: bool,
    /// Where the host's journal files are, for an article's page at its cited printed page.
    pub journals: Option<legal_structure_features::journal_store::JournalStores>,
    /// What makes a diagnostics file's signature its own (the time it is written).
    #[serde(default)]
    pub stamp: String,
}

#[derive(Deserialize, Default)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrOptions", optional_fields = nullable))]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// "display", "display-json", "diagnostic-hidden" (the default) or "diagnostic".
    pub export_detail: Option<String>,
    /// Footnote numbers ("1-5, 9, 12-14"); every note where none are given.
    pub footnotes: Option<String>,
    /// The quotation's context, the Python app's proposition_mode.
    pub quote_context: Option<QuoteContext>,
    /// The Python app's text fragments (frag_mode): "all" (the default), "pinpointless" or "off".
    pub text_fragments: Option<String>,
    /// Whether a part's passage may be read from A2AJ; off, only an attached PDF is read.
    pub a2aj: Option<bool>,
    /// A model's analysis of quotations, by quotation id: a column of its own.
    pub analysis: Option<BTreeMap<String, String>>,
}

/// The draft as the run reads it: its units with their note parts, its citations in the order the draft holds them, and
/// its authorities, each as the engine's review made them (legal_structure_features::BriefReview) and edited since.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrDraft", optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub units: Vec<BriefUnit>,
    #[cfg_attr(feature = "binding-types", ts(type = "Record<string, BriefOccurrence>"))]
    pub occurrences: IndexMap<String, BriefOccurrence>,
    #[cfg_attr(feature = "binding-types", ts(type = "Record<string, BriefAuthority>"))]
    pub authorities: HashMap<String, BriefAuthority>,
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(type = "Record<string, unknown>"))]
    pub discrepancy_decisions: HashMap<String, serde::de::IgnoredAny>,
}

/// The quote check as the run reads it.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrCheck"))]
pub struct Check {
    pub quotes: Vec<Quote>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrQuote"))]
pub struct Quote {
    pub id: String,
    pub quote: String,
    pub start: usize,
    pub end: usize,
    pub context: String,
    pub candidates: Vec<Candidate>,
    pub checks: Vec<QuoteCheck>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrCandidate"))]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub unit_id: String,
    pub start: usize,
}

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrQuoteCheck", optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct QuoteCheck {
    pub candidate_id: Option<String>,
    pub status: String,
    pub receipt: Option<Receipt>,
}

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrReceipt", optional_fields = nullable))]
pub struct Receipt {
    pub source: ReceiptSource,
    pub link: Option<String>,
    /// Whether the quotation was compared with the source's wording.
    #[cfg_attr(feature = "binding-types", ts(type = "unknown"))]
    pub comparison: Option<serde::de::IgnoredAny>,
    #[serde(rename = "match")]
    pub location: Location,
}

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrReceiptSource"))]
pub struct ReceiptSource {
    pub provider: String,
}

/// Where a quotation was found (the engine's QuoteLocation).
#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrLocation", optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub location: String,
    pub perfect: bool,
    pub short_in_long: bool,
    pub labels: Vec<Label>,
    pub pinpoint: String,
    pub region: String,
    pub fragment: String,
    pub corrected: String,
    pub cited: Option<Cited>,
}

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrCited"))]
pub struct Cited {
    pub score: f64,
    pub labels: Vec<Label>,
    pub region: String,
    pub fragment: String,
    pub corrected: String,
}

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrLabel"))]
pub struct Label {
    pub shown: String,
}

/// What the run asks its host, each kind for every part at once.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrQuestion"))]
#[serde(tag = "ask", rename_all = "camelCase")]
pub enum Question {
    /// Decisions' pages in the host's private CanLII index.
    Links { cases: Vec<IndexedCase> },
    /// The model's parts of the notes it reads.
    Split { notes: Vec<ModelNote> },
    /// The earlier part each unresolved supra names, among those offered.
    Choose { references: Vec<Choice> },
    /// The source each part cites, read: a PDF attached for its authority, else its provider's text.
    Read { sources: Vec<Option<CitedSource>> },
}

/// A decision as a private CanLII index finds its page, read off its citation: its year and style of cause; its court as
/// written, without spaces or periods ("ONSC", "SCR"); the number a CanLII citation gives; its jurisdiction ("ca-on");
/// where its page is a Supreme Court Reports PDF, the report's first page and its pinpoint page; and the part's first
/// paragraph pinpoint ("par12").
#[derive(Serialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrIndexedCase", optional_fields = nullable))]
pub struct IndexedCase {
    pub year: String,
    pub style: String,
    pub court: Option<String>,
    pub number: Option<String>,
    pub jurisdiction: Option<String>,
    pub report: Option<(String, Option<String>)>,
    pub pinpoint: Option<String>,
}

/// A note as the run mode decides whether the model reads it: its text and the engine's parts.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrModelNote"))]
pub struct ModelNote {
    pub index: usize,
    pub number: u32,
    pub text: String,
    pub parts: Vec<ModelNotePart>,
}

#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrModelNotePart"))]
pub struct ModelNotePart {
    pub text: String,
    pub reference: String,
    pub link: String,
    pub kind: String,
}

#[derive(Serialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrChoice"))]
pub struct Choice {
    pub text: String,
    pub earlier: Vec<Earlier>,
    pub proposition: String,
}

#[derive(Serialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrEarlier"))]
#[serde(rename_all = "camelCase")]
pub struct Earlier {
    pub note: String,
    pub short_form: String,
    pub text: String,
    pub link: String,
}

/// What a part cites: its authority (by id), or the kind and citation its fields give.
#[derive(Serialize, Clone, PartialEq)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrCitedSource", optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct CitedSource {
    pub authority_id: Option<String>,
    pub kind: String,
    pub citation: String,
}

/// A source the host read, and where its provider holds it (none for an attached PDF).
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrRead", optional_fields = nullable))]
pub struct Read<D> {
    pub document: D,
    pub source: Option<legal_structure_features::LinkedSource>,
}

/// The host's answer to the run's question: the field its question asks for.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrAnswer", optional_fields))]
#[serde(default, bound(deserialize = "D: Deserialize<'de>"))]
pub struct Answer<D> {
    #[cfg_attr(feature = "binding-types", ts(as = "Option<Vec<Option<String>>>", optional))]
    pub links: Vec<Option<String>>,
    /// A model's parts of each note it read, at their places in the note's text, with the fields it gives them.
    #[cfg_attr(feature = "binding-types", ts(as = "Option<Vec<(usize, Vec<SourcePart>)>>", optional))]
    pub parts: Vec<(usize, Vec<SourcePart>)>,
    #[cfg_attr(feature = "binding-types", ts(as = "Option<Vec<Option<usize>>>", optional))]
    pub chosen: Vec<Option<usize>>,
    #[cfg_attr(feature = "binding-types", ts(as = "Option<Vec<Option<Read<D>>>>", optional))]
    pub reads: Vec<Option<Read<D>>>,
}

impl<D> Default for Answer<D> {
    fn default() -> Self { Self { links: Vec::new(), parts: Vec::new(), chosen: Vec::new(), reads: Vec::new() } }
}

/// The workbook written: its name, its package, its rows, how many of its rows are an ibid or a supra and how many of
/// those are linked, and for display-json the signature its diagnostics file is paired with it by.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrReferences"))]
pub struct References {
    pub ibid: usize,
    pub supra: usize,
    pub linked: usize,
}

pub struct Written {
    pub name: String,
    pub workbook: Vec<u8>,
    pub rows: Vec<Row>,
    pub references: References,
    pub signature: Option<String>,
}

enum Exchange<D> {
    Idle,
    Asked(Question),
    Answered(Answer<D>),
}

/// The run's side of a question: put to the host, and its answer taken when the run is resumed with it.
struct Ask<D> {
    exchange: Arc<Mutex<Exchange<D>>>,
    question: Option<Question>,
}

impl<D> Future for Ask<D> {
    type Output = Answer<D>;
    fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Answer<D>> {
        let exchange = Arc::clone(&self.exchange);
        let mut exchange = exchange.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(question) = self.question.take() {
            *exchange = Exchange::Asked(question);
            return Poll::Pending;
        }
        match std::mem::replace(&mut *exchange, Exchange::Idle) {
            Exchange::Answered(answer) => Poll::Ready(answer),
            other => { *exchange = other; Poll::Pending }
        }
    }
}

/// How the run puts its questions.
pub(crate) struct Host<D> {
    exchange: Arc<Mutex<Exchange<D>>>,
}

impl<D> Host<D> {
    pub(crate) fn ask(&self, question: Question) -> impl Future<Output = Answer<D>> {
        Ask { exchange: Arc::clone(&self.exchange), question: Some(question) }
    }
}

/// A run: the workbook being read, waiting on its host's answer between steps.
pub struct Run<D> {
    future: Pin<Box<dyn Future<Output = Result<Written, String>> + Send>>,
    exchange: Arc<Mutex<Exchange<D>>>,
}

/// Where a run stands after a step: asking its host, or done.
pub enum Step {
    Ask(Question),
    Done(Written),
}

impl<D: Source + Send> Run<D> {
    pub fn start(request: Request) -> Self {
        let exchange = Arc::new(Mutex::new(Exchange::Idle));
        let host = Host { exchange: Arc::clone(&exchange) };
        Self { future: Box::pin(rows::written(request, host)), exchange }
    }

    /// The run's next step, given the answer to its last question.
    pub fn resume(&mut self, answer: Option<Answer<D>>) -> Result<Step, String> {
        if let Some(answer) = answer {
            *self.exchange.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Exchange::Answered(answer);
        }
        match self.future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(written) => written.map(Step::Done),
            Poll::Pending => match std::mem::replace(&mut *self.exchange.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
                Exchange::Idle) {
                Exchange::Asked(question) => Ok(Step::Ask(question)),
                _ => Err("The workbook's reading waited on no question.".to_owned()),
            },
        }
    }
}
