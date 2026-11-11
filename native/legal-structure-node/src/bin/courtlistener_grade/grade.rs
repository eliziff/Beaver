//! The grader: judges' own citations as the answer key. A later opinion that quotes an earlier one and pins the quotation says
//! where those words stand: page, parallel page, vendor star page, paragraph, footnote, or a separate writing. Each reader is
//! asked where the words stand, and is right, wrong, or has no answer.
//!
//!   courtlistener-structure grade --pack FILE[,FILE] --pins FILE --out DIR [--clusters FILE] [--citations FILE] [--threads N]
//!
//! PINS comes from experiments/courtlistener-census/pin_stream.py, one JSON line each: {cluster, citing, cite, pin, form, quote, after}.
//! The readers: `parser` is the product, in process. `field` is html_with_citations alone, every tag read as well as it can be and
//! paragraph signs found in its words. `docket` holds that field's `page-number` and `footnote` elements only, what the best
//! converter in the wild reads. COLD Cases strips every tag and answers nothing, so it is a line in the report and no reader.
//!
//! A grade carries its own controls. `shifted` moves the parser's right answers a page either way: the grader must mark them wrong.
//! `chance` asks the parser about another quotation of the same opinion: what a reader earns knowing nothing of where this one stands.
//! `--mutate` plants a known fault in the parser's output: its own item must fall and the others hold.
//! Nothing the parser produces decides what is graded: exclusions and groups come from the citation table, the renditions' own tags
//! and the field's text alone. A reader that keeps its answer back is marked for it: the pass marks count no answers.
//! The tag check asks words from the middle of a tagged page. The field's score there only shows the finder and lookups agree with
//! the tags they were read from; the parser's is a real test of what it does with those tags.
//! Each miss of the parser goes to OUT/failures.jsonl under its cause.

use crate::tool::{citations_of, clusters_of, flag, record_of, WORKER_STACK};
use legal_structure::opinion::{in_flow, nodes, numbers_at, opinion_structure, paragraphs, pin_at, reading};
use legal_structure::{DocumentStructure, NodeKind, StructureNode};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

/// A quotation shorter than this names no place.
const LEAST_WORDS: usize = 6;
/// How many words stand for a place in the index.
const GRAM: usize = 4;
/// A gram found oftener than this in one opinion says nothing of where a quotation stands.
const COMMON: usize = 8;
/// A label this far past the citation's first page is no page of this opinion.
const REACH: u32 = 400;
/// A wrong answer this close to a page mark is the mark's placing, not the numbering.
const NEAR_MARK: usize = 150;
/// The citers' numbering of paragraphs, kept beside those of each reporter's pages.
const PARAGRAPHS: &str = "¶";
/// A passage, for the citers' vote, in UTF-16 units of the field's text.
const PASSAGE: usize = 200;
/// The fewest citing opinions on a passage for their majority to be a key.
const LEAST_VOTES: u32 = 3;

#[derive(Clone, Debug)]
struct Question {
    citing: String,
    cite: String,
    /// Volume and reporter, as a pin names them: "275 Kan.".
    reporter: String,
    pin: String,
    /// The end of a pinned range, "250-51" at 251.
    through: Option<String>,
    /// Other pages of a list, "at 231, 238, 241".
    others: Vec<String>,
    kind: Kind,
    quote: String,
}

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    Page,
    Vendor,
    Paragraph,
    Note(String),
    Part(&'static str),
    /// A syllabus point, "Syl. pt. 3".
    Point,
}

impl Kind {
    fn name(&self) -> &'static str {
        match self {
            Kind::Page => "page",
            Kind::Vendor => "vendor",
            Kind::Paragraph => "paragraph",
            Kind::Note(_) => "footnote",
            Kind::Part(_) => "writing",
            Kind::Point => "headnote",
        }
    }
}

fn base_cite(cite: &str) -> &str {
    static CUT: OnceLock<Regex> = OnceLock::new();
    let cut = CUT.get_or_init(|| Regex::new(r",\s*(?:at\s+)?[¶*\d]").unwrap());
    cut.find(cite).map_or(cite, |found| &cite[..found.start()]).trim()
}

fn squeezed(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// A harvested line's questions: its pin, and what the words after the citation pin as well.
fn questions_of(row: &Value) -> Vec<(String, Question)> {
    static NOTE: OnceLock<Regex> = OnceLock::new();
    static WRITER: OnceLock<Regex> = OnceLock::new();
    let note = NOTE.get_or_init(|| Regex::new(r"(?i)^[\s,&]*(?:nn?\.|notes?|fn\.?)\s*(\d{1,3})\b").unwrap());
    let writer = WRITER.get_or_init(|| Regex::new(r"(?i)^[^()]{0,40}(?:\([^()]{0,30}\)\s*)?\([^()]{0,70}\b(dissent|concurr)").unwrap());
    let text = |name: &str| row[name].as_str().unwrap_or_default().to_owned();
    let (cluster, cite, after, reporter) = (text("cluster"), text("cite"), text("after"), text("reporter"));
    let pin = text("pin").trim_matches(|c: char| !c.is_ascii_digit()).split(|c: char| !c.is_ascii_digit()).next().unwrap_or_default().to_owned();
    static RANGE: OnceLock<Regex> = OnceLock::new();
    let range = RANGE.get_or_init(|| Regex::new(r"(\d+)\s*[-–—]\s*(\d+)\s*(?:nn?\.\s*\d+)?\s*$").unwrap());
    // "250-51" drops what it shares with the page it starts on.
    let through = range.captures(&cite).filter(|capture| capture[1] == pin).map(|capture| {
        let (from, to) = (&capture[1], &capture[2]);
        if to.len() < from.len() { format!("{}{to}", &from[..from.len() - to.len()]) } else { to.to_owned() }
    });
    static LIST: OnceLock<Regex> = OnceLock::new();
    let list = LIST.get_or_init(|| Regex::new(r"\d(?:\s*,\s*\d+)+\s*$").unwrap());
    let tail = cite.find(&pin).map_or("", |at| &cite[at..]);
    let others = list.find(tail).map_or_else(Vec::new, |found| found.as_str().split(',').skip(1).map(|page| page.trim().to_owned()).collect());
    let question = |kind: Kind| (cluster.clone(), Question { citing: text("citing"), cite: base_cite(&cite).to_owned(), reporter: reporter.clone(), pin: pin.clone(), through: through.clone(), others: others.clone(), kind, quote: text("quote") });
    // "211 Ariz. 529, 542, ¶ 40" pins a page and a paragraph; the link's fragment holds the page. Each is its own question.
    static SIGNED: OnceLock<Regex> = OnceLock::new();
    let signed = SIGNED.get_or_init(|| Regex::new(r"¶+\s*(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?").unwrap()).captures(&cite);
    let mut found = Vec::new();
    match (text("form").as_str(), &signed) {
        ("vendor", _) => found.push(question(Kind::Vendor)),
        ("syllabus", _) => return vec![question(Kind::Point)],
        ("paragraph", Some(sign)) => {
            let mut asked = question(Kind::Paragraph);
            asked.1.pin = sign[1].to_owned();
            asked.1.through = sign.get(2).map(|to| to.as_str().to_owned());
            asked.1.others = Vec::new();
            found.push(asked);
            if pin != sign[1] {
                found.push(question(Kind::Page));
            }
        }
        ("paragraph", None) => found.push(question(Kind::Paragraph)),
        _ => found.push(question(Kind::Page)),
    }
    // A footnote pin may stand in the citation's own link: "160 P.3d 438, 441 n.3".
    static OWN_NOTE: OnceLock<Regex> = OnceLock::new();
    let own_note = OWN_NOTE.get_or_init(|| Regex::new(r"(?i)\d[\s,]*(?:&\s*)?nn?\.\s*(\d{1,3})\b").unwrap());
    if let Some(capture) = own_note.captures(&cite).or_else(|| note.captures(&after)) {
        found.push(question(Kind::Note(capture[1].to_owned())));
    }
    if let Some(capture) = writer.captures(&after) {
        found.push(question(Kind::Part(if capture[1].eq_ignore_ascii_case("dissent") { "dissent" } else { "concur" })));
    }
    found
}

fn hash_word(word: &str) -> u64 {
    word.bytes().fold(0xcbf29ce484222325, |hash, byte| (hash ^ byte as u64).wrapping_mul(0x100000001b3))
}

fn gram(words: &[u64]) -> u64 {
    words.iter().fold(0, |hash, word| hash.rotate_left(13) ^ word)
}

/// Words of a text with where each stands, in UTF-16 units as the parser counts.
fn words_of(text: &str) -> (Vec<u64>, Vec<(usize, usize)>) {
    let (mut hashes, mut places, mut word, mut unit, mut start) = (Vec::new(), Vec::new(), String::new(), 0, 0);
    for c in text.chars() {
        if c.is_alphanumeric() {
            if word.is_empty() {
                start = unit;
            }
            word.extend(c.to_lowercase());
        } else if !word.is_empty() {
            hashes.push(hash_word(&word));
            places.push((start, unit));
            word.clear();
        }
        unit += c.len_utf16();
    }
    if !word.is_empty() {
        hashes.push(hash_word(&word));
        places.push((start, unit));
    }
    (hashes, places)
}

#[derive(Clone, Copy, Debug)]
struct Found {
    start: usize,
    end: usize,
    exact: bool,
    twice: bool,
}

struct Finder {
    words: Vec<u64>,
    places: Vec<(usize, usize)>,
    index: HashMap<u64, Vec<u32>>,
}

impl Finder {
    fn new(text: &str) -> Self {
        let (words, places) = words_of(text);
        let mut index = HashMap::<u64, Vec<u32>>::with_capacity(words.len());
        for (at, window) in words.windows(GRAM).enumerate() {
            index.entry(gram(window)).or_default().push(at as u32);
        }
        Self { words, places, index }
    }

    /// Where a quotation stands: word for word, or where most of its grams fall on one line through a scanner's slips.
    fn find(&self, quote: &[u64]) -> Option<Found> {
        if quote.len() < LEAST_WORDS {
            return None;
        }
        let exact = self.index.get(&gram(&quote[..GRAM])).into_iter().flatten().map(|at| *at as usize)
            .filter(|at| self.words.get(*at..*at + quote.len()).is_some_and(|window| window == quote)).collect::<Vec<_>>();
        if let Some(at) = exact.first() {
            return Some(Found { start: self.places[*at].0, end: self.places[*at + quote.len() - 1].1, exact: true, twice: exact.len() > 1 });
        }
        let mut votes = HashMap::<isize, usize>::new();
        for (from, window) in quote.windows(GRAM).enumerate() {
            let hits = self.index.get(&gram(window)).map_or(&[][..], Vec::as_slice);
            if hits.len() <= COMMON {
                for at in hits {
                    *votes.entry(*at as isize - from as isize).or_default() += 1;
                }
            }
        }
        let (line, _) = votes.iter().max_by_key(|(line, count)| (**count, -**line)).map(|(line, count)| (*line, *count))?;
        let near = (-3..=3).filter_map(|shift| votes.get(&(line + shift))).sum::<usize>();
        if near * 3 < (quote.len() - GRAM + 1) * 2 {
            return None;
        }
        let first = line.max(0) as usize;
        let last = (first + quote.len() - 1).min(self.places.len() - 1);
        // A second line that also carries most of the grams: scanned words can stand twice as well as exact ones.
        let elsewhere = votes.keys().filter(|other| other.abs_diff(line) > 3).any(|other| (-3..=3).filter_map(|shift| votes.get(&(other + shift))).sum::<usize>() * 3 >= (quote.len() - GRAM + 1) * 2);
        Some(Found { start: self.places[first.min(last)].0, end: self.places[last].1, exact: false, twice: elsewhere })
    }
}

/// A quotation's stretches between a writer's ellipses and bracketed changes, as words, in order.
fn quote_parts(quote: &str) -> Vec<Vec<u64>> {
    static BREAK: OnceLock<Regex> = OnceLock::new();
    let cut = BREAK.get_or_init(|| Regex::new(r"\.\s?\.\s?\.|…|\*\s\*\s\*|\[[^\]]*\]").unwrap());
    cut.split(quote).map(|part| words_of(part).0).filter(|part| part.len() >= LEAST_WORDS).collect()
}

/// Where a whole quotation stands: its longest stretch fixes the place, the others its reach, so far as they fall near.
fn find_quote(finder: &Finder, parts: &[Vec<u64>]) -> Option<Found> {
    const REACH_UNITS: usize = 1500;
    let longest = parts.iter().max_by_key(|part| part.len())?;
    let mut found = finder.find(longest)?;
    for part in parts {
        if let Some(other) = finder.find(part).filter(|other| !other.twice) {
            if other.start.abs_diff(found.end) <= REACH_UNITS || other.end.abs_diff(found.start) <= REACH_UNITS {
                found.start = found.start.min(other.start);
                found.end = found.end.max(other.end);
            }
        }
    }
    Some(found)
}

/// A judge pins a sentence, and a quotation may open partway through one: the place widens to the sentence it stands in.
fn widened(units: &[u16], found: Found) -> Found {
    const SENTENCE: usize = 400;
    let stop = |at: usize| matches!(units.get(at), Some(46 | 63 | 33)) && units.get(at + 1).is_none_or(|next| matches!(*next, 32 | 10 | 34 | 8221));
    let from = (found.start.saturating_sub(SENTENCE)..found.start.min(units.len())).rev().find(|at| stop(*at) || units[*at] == 10).map_or(found.start, |at| at + 1);
    let to = (found.end..(found.end + SENTENCE).min(units.len())).find(|at| stop(*at) || units[*at] == 10).unwrap_or(found.end);
    Found { start: from, end: to, ..found }
}

/// The words stand inside quotation marks in the cited text: it repeats them from elsewhere, as a dissent does the majority.
fn echoed(units: &[u16], found: Found) -> bool {
    let before = units[..found.start.min(units.len())].iter().rev().find(|unit| !matches!(**unit, 32 | 10 | 40 | 91));
    before.is_some_and(|unit| matches!(*unit, 34 | 8220 | 8216))
}

/// What html_with_citations gives one who reads it well.
#[derive(Default)]
struct Field {
    text: String,
    /// Where a page mark stands, its label, and whether it is a `page-number` element.
    marks: Vec<(usize, String, bool)>,
    signs: Vec<(usize, String)>,
    /// A note's span and label, and whether it is a `footnote` element.
    notes: Vec<(usize, usize, String, bool)>,
    /// A writing's span and type.
    writings: Vec<(usize, usize, String)>,
    /// Where a note is called, and its label.
    calls: Vec<(usize, String)>,
    /// Each paragraph or block quotation, as the markup sets it.
    blocks: Vec<(usize, usize)>,
}

fn decoded(text: &str) -> String {
    static ENTITY: OnceLock<Regex> = OnceLock::new();
    if !text.contains('&') {
        return text.to_owned();
    }
    ENTITY.get_or_init(|| Regex::new(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);").unwrap()).replace_all(text, |capture: &regex::Captures| {
        let name = &capture[1];
        let code = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")).map(|hex| u32::from_str_radix(hex, 16).ok()).unwrap_or_else(|| name.strip_prefix('#').and_then(|digits| digits.parse().ok()));
        match (code.and_then(char::from_u32), name) {
            (Some(c), _) => c.to_string(),
            (_, "amp") => "&".to_owned(), (_, "lt") => "<".to_owned(), (_, "gt") => ">".to_owned(), (_, "quot") => "\"".to_owned(), (_, "apos") => "'".to_owned(),
            (_, "nbsp") => " ".to_owned(), (_, "para") => "¶".to_owned(), (_, "sect") => "§".to_owned(), (_, "mdash") => "—".to_owned(), (_, "ndash") => "–".to_owned(),
            (_, "ldquo") => "“".to_owned(), (_, "rdquo") => "”".to_owned(), (_, "lsquo") => "‘".to_owned(), (_, "rsquo") => "’".to_owned(),
            _ => capture[0].to_owned(),
        }
    }).into_owned()
}

fn field_of(raw: &str) -> Field {
    static TAG: OnceLock<Regex> = OnceLock::new();
    static LABEL: OnceLock<Regex> = OnceLock::new();
    static TYPE: OnceLock<Regex> = OnceLock::new();
    static SIGN: OnceLock<Regex> = OnceLock::new();
    static NOTE_ID: OnceLock<Regex> = OnceLock::new();
    let tag = TAG.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let label = LABEL.get_or_init(|| Regex::new(r#"\blabel="([^"]+)""#).unwrap());
    let kind = TYPE.get_or_init(|| Regex::new(r#"\b(?:type|opiniontype)="([^"]+)""#).unwrap());
    let sign = SIGN.get_or_init(|| Regex::new(r"¶+\s*(\d{1,4})").unwrap());
    let note_id = NOTE_ID.get_or_init(|| Regex::new(r#"\bid="fn([^"_-]+)"#).unwrap());
    let mut field = Field::default();
    let (mut units, mut at) = (0, 0);
    let mut open_note: Option<(usize, String)> = None;
    let mut open_div: Option<(usize, String, usize)> = None;
    let mut open_writing: Option<(usize, String)> = None;
    let mut open_blocks = Vec::<usize>::new();
    let mut pieces = String::with_capacity(raw.len());
    for found in tag.find_iter(raw) {
        let chunk = decoded(&raw[at..found.start()]);
        units += chunk.encode_utf16().count();
        pieces.push_str(&chunk);
        at = found.end();
        let element = found.as_str();
        let name = element.trim_start_matches(['<', '/']).split(|c: char| c.is_whitespace() || c == '>' || c == '/').next().unwrap_or("");
        let closing = element.starts_with("</");
        if !closing {
            static CALL: OnceLock<Regex> = OnceLock::new();
            let call = CALL.get_or_init(|| Regex::new(r##"href="#fn([^"_-]+)""##).unwrap());
            if let Some(capture) = call.captures(element) {
                field.calls.push((units, capture[1].to_owned()));
            } else if name == "footnotemark" {
                let label = raw[found.end()..].split('<').next().unwrap_or("").trim();
                field.calls.push((units, label.to_owned()));
            }
        }
        if !closing && (element.contains("star-pagination") || name == "page-number") {
            if let Some(capture) = label.captures(element) {
                field.marks.push((units, capture[1].trim_matches(['*', ' ']).to_owned(), name == "page-number"));
            }
        }
        match (name, closing) {
            ("p" | "blockquote", false) => open_blocks.push(units),
            ("p" | "blockquote", true) => {
                if let Some(start) = open_blocks.pop() {
                    field.blocks.push((start, units));
                }
            }
            ("footnote", false) => open_note = Some((units, label.captures(element).map_or(String::new(), |capture| capture[1].to_owned()))),
            ("footnote", true) => {
                if let Some((start, name)) = open_note.take() {
                    field.notes.push((start, units, name, true));
                }
            }
            ("div", false) => {
                if let Some(open) = &mut open_div {
                    open.2 += 1;
                } else if element.contains("class=\"footnote\"") {
                    open_div = Some((units, note_id.captures(element).map_or(String::new(), |capture| capture[1].to_owned()), 0));
                }
            }
            ("div", true) => {
                if let Some(open) = &mut open_div {
                    if open.2 == 0 {
                        let (start, name, _) = open_div.take().unwrap();
                        field.notes.push((start, units, name, false));
                    } else {
                        open.2 -= 1;
                    }
                }
            }
            ("opinion", false) => open_writing = Some((units, kind.captures(element).map_or(String::new(), |capture| capture[1].to_lowercase()))),
            ("opinion", true) => {
                if let Some((start, name)) = open_writing.take() {
                    field.writings.push((start, units, name));
                }
            }
            _ => {}
        }
        if !closing && element.contains("class=\"opinion\"") {
            if let Some((start, name)) = open_writing.take() {
                field.writings.push((start, units, name));
            }
            open_writing = Some((units, kind.captures(element).map_or(String::new(), |capture| capture[1].to_lowercase())));
        }
        if matches!(name, "p" | "div" | "br" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "pre") {
            pieces.push('\n');
            units += 1;
        }
    }
    let chunk = decoded(&raw[at..]);
    units += chunk.encode_utf16().count();
    pieces.push_str(&chunk);
    if let Some((start, name)) = open_writing.take() {
        field.writings.push((start, units, name));
    }
    // Paragraph signs stand in the words: those that count up from 1 in order are the opinion's own, wherever a line falls.
    let (mut due, mut last_byte, mut last_unit) = (1u32, 0, 0);
    for capture in sign.captures_iter(&pieces) {
        if capture[1].parse::<u32>().ok() == Some(due) {
            let place = capture.get(0).unwrap().start();
            last_unit += pieces[last_byte..place].encode_utf16().count();
            last_byte = place;
            field.signs.push((last_unit, capture[1].to_owned()));
            due += 1;
        }
    }
    // A page mark inside a note marks the note's own turn, not the opinion's.
    let notes = field.notes.clone();
    field.marks.retain(|mark| !notes.iter().any(|note| note.0 <= mark.0 && mark.0 < note.1));
    field.text = pieces;
    field
}

fn last_before<'a>(marks: &'a [(usize, String)], place: usize) -> Option<&'a str> {
    marks[..marks.partition_point(|mark| mark.0 <= place)].last().map(|mark| mark.1.as_str())
}

fn first_digits(cite: &str) -> Option<u32> {
    static END: OnceLock<Regex> = OnceLock::new();
    END.get_or_init(|| Regex::new(r"(\d{1,5})\s*$").unwrap()).captures(cite)?[1].parse().ok()
}

/// The pin, or the range it names, against what a reader names at the sentence's two ends: words may cross a page.
fn holds(pin: &str, through: Option<&str>, first: &str, last: &str) -> bool {
    // A lettered label, "557B", prints an inserted leaf of page 557.
    let number = |label: &str| label.trim_end_matches(|c: char| c.is_ascii_alphabetic()).parse::<u32>();
    match (pin.parse::<u32>(), through.unwrap_or(pin).parse::<u32>(), number(first), number(last)) {
        (Ok(pin), Ok(through), Ok(first), Ok(last)) => pin <= first.max(last) && first.min(last) <= through,
        _ => pin == first || pin == last,
    }
}

type Answer = Option<(String, String)>;

/// The parser's answer: which page, paragraph, note or writing it says the words stand in.
fn parser_answer(structure: &DocumentStructure, question: &Question, found: Found) -> Answer {
    match &question.kind {
        Kind::Page | Kind::Vendor => {
            let series = series_for(structure, question)?;
            let pin = pin_at(structure, &series, found.start, found.end)?;
            let through = pin.through.clone().unwrap_or_else(|| pin.page.clone());
            Some((pin.page, through))
        }
        Kind::Paragraph => numbers_at(structure, found.start, found.end),
        Kind::Note(_) => {
            let middle = (found.start + found.end) / 2;
            let note = nodes(structure, NodeKind::Footnote).find(|note| note.ranges.iter().any(|range| range.start <= middle && middle < range.end))?;
            Some((note.label.as_deref().unwrap_or("").trim_matches(['[', ']', '(', ')', '.', ':', ' ']).to_owned(), String::new()))
        }
        Kind::Part(_) => {
            let middle = (found.start + found.end) / 2;
            let part = nodes(structure, NodeKind::Section).find(|part| part.range.start <= middle && middle < part.range.end)?;
            Some((part.display_value.as_deref().unwrap_or("").to_lowercase(), String::new()))
        }
        Kind::Point => None,
    }
}

/// The point of the opinion's syllabus that holds a quotation: asked of the headnotes, which may stand apart from the text.
fn point_answer(structure: &DocumentStructure, quote: &[Vec<u64>]) -> Answer {
    let longest = quote.iter().max_by_key(|part| part.len())?;
    legal_structure::opinion::headnotes(structure).find_map(|(_, number, text)| {
        let finder = Finder::new(text);
        finder.find(longest)?;
        Some((number.map(str::to_owned).or_else(|| legal_structure::opinion::headnote_number(text)).unwrap_or_default().trim_matches(['.', ')', '(', ' ']).to_owned(), String::new()))
    }).filter(|answer| !answer.0.is_empty())
}

/// The numbering a pin names, by the name of the citation it was matched to.
fn series_for(structure: &DocumentStructure, question: &Question) -> Option<String> {
    let name = squeezed(&question.reporter);
    if name.is_empty() {
        return None;
    }
    reading(structure).page_series.iter().find(|series| squeezed(&series.reporter) == name || series.also.iter().any(|also| squeezed(also).starts_with(&name))).map(|series| series.series.clone())
}

/// The record's table of citations: name, volume, first page.
type Table = Vec<(String, String, u32)>;

/// The citation a pin names, from the table alone: by reporter; failing that, a variant name with the volume and first page; failing
/// that, the volume, if only one citation has it. Returns the table's own name, so that a variant reaches the numbering.
fn citation_of(question: &Question, table: &Table) -> Option<(String, u32)> {
    // "Id. at 603" after "223 W. Va. 594, 603, 678 S.E.2d 847, 856": the carried reporter is only the last named. The pin falls in the
    // pages of one citation; if in several, or none, it cannot be told which and the pin is not asked.
    if !question.cite.starts_with(|c: char| c.is_ascii_digit()) {
        let pin = question.pin.parse::<u32>().ok()?;
        let fits = table.iter().filter(|row| row.2 <= pin && pin <= row.2 + REACH).collect::<Vec<_>>();
        let first = fits.iter().map(|row| row.2).max()?;
        let nearest = fits.iter().filter(|row| row.2 == first).collect::<Vec<_>>();
        let apart = fits.iter().all(|row| row.2 == first);
        return apart.then(|| (nearest[0].0.clone(), first));
    }
    let name = squeezed(&question.reporter);
    if let Some(found) = table.iter().find(|row| row.0 == name) {
        return Some((found.0.clone(), found.2));
    }
    let volume = question.reporter.split_whitespace().next()?;
    let cited = first_digits(&question.cite);
    let same = table.iter().filter(|row| row.1 == volume).collect::<Vec<_>>();
    same.iter().find(|row| Some(row.2) == cited).or_else(|| (same.len() == 1).then(|| &same[0])).map(|row| (row.0.clone(), row.2))
}

/// The kind of mark a page answer rests on: printed, placed from another version, or reckoned.
fn source_of<'a>(structure: &'a DocumentStructure, question: &Question, found: Found) -> Option<&'a str> {
    if !matches!(question.kind, Kind::Page | Kind::Vendor) {
        return None;
    }
    let series = series_for(structure, question)?;
    nodes(structure, NodeKind::Page).filter(|page| page.series == series && !page.properties.contains_key("in_note") && page.range.start <= found.start).max_by_key(|page| page.range.start).map(|page| page.grammar.as_deref().unwrap_or(""))
}

/// `docket` keeps to the `page-number` and `footnote` elements. `low` is the citation's first page in the record's own table. Words
/// in a note stand where the note is called.
fn field_answer(field: &Field, question: &Question, found: Found, elements_only: bool, low: Option<u32>, opinion_type: &str) -> Answer {
    let middle = (found.start + found.end) / 2;
    let note = field.notes.iter().filter(|note| !elements_only || note.3).find(|note| note.0 <= middle && middle < note.1);
    match &question.kind {
        Kind::Page | Kind::Vendor => {
            let low = if question.kind == Kind::Page { low? } else { 1 };
            let marks = field.marks.iter().filter(|mark| !elements_only || mark.2)
                .filter(|mark| mark.1.parse::<u32>().is_ok_and(|label| low <= label && label <= low + REACH))
                .map(|mark| (mark.0, mark.1.clone())).collect::<Vec<_>>();
            if marks.is_empty() {
                return None;
            }
            let place = |at: usize| note.and_then(|note| field.calls.iter().find(|call| call.1 == note.2.trim_matches(['[', ']', '(', ')', '.', ':', ' ']))).map_or(at, |call| call.0);
            let first = last_before(&marks, place(found.start)).map_or_else(|| low.to_string(), str::to_owned);
            let last = last_before(&marks, place(found.end)).map_or_else(|| first.clone(), str::to_owned);
            Some((first, last))
        }
        Kind::Paragraph if elements_only => None,
        Kind::Paragraph => Some((last_before(&field.signs, found.start)?.to_owned(), last_before(&field.signs, found.end)?.to_owned())),
        Kind::Note(_) => Some((note?.2.trim_matches(['[', ']', '(', ')', '.', ':', ' ']).to_owned(), String::new())),
        Kind::Point => None,
        Kind::Part(_) if elements_only => None,
        // The record's own type is the field's to read, as the parser reads it.
        Kind::Part(_) => field.writings.iter().find(|writing| writing.0 <= middle && middle < writing.1).map(|writing| writing.2.clone())
            .or_else(|| (!opinion_type.is_empty()).then(|| opinion_type.to_lowercase())).map(|kind| (kind, String::new())),
    }
}

fn right(question: &Question, answer: &(String, String)) -> bool {
    match &question.kind {
        Kind::Page | Kind::Vendor | Kind::Paragraph => holds(&question.pin, question.through.as_deref(), &answer.0, &answer.1) || question.others.iter().any(|page| holds(page, None, &answer.0, &answer.1)),
        Kind::Note(label) => answer.0 == *label,
        Kind::Point => answer.0 == question.pin,
        Kind::Part(kind) => answer.0.contains(kind),
    }
}

fn outcome(question: &Question, answer: &Answer) -> &'static str {
    match answer {
        None => "no answer",
        Some(answer) if right(question, answer) => "right",
        Some(_) => "wrong",
    }
}

fn near_mark(structure: &DocumentStructure, place: usize) -> bool {
    nodes(structure, NodeKind::Page).any(|page| !page.properties.contains_key("in_note") && page.range.start.abs_diff(place) <= NEAR_MARK)
}

/// Why the parser missed, the cause to read first.
fn cause(question: &Question, ours: &Answer, field: &Answer, structure: &DocumentStructure, found: Found) -> &'static str {
    let field_right = field.as_ref().is_some_and(|answer| right(question, answer));
    match ours {
        None if field_right => "no answer, the field had it",
        None if reading(structure).page_series.is_empty() && matches!(question.kind, Kind::Page | Kind::Vendor) => "no answer, no numbering tied to any citation",
        None => "no answer",
        Some(_) if field_right => "wrong, the field had it",
        Some(mine) => {
            if field.as_ref() == Some(mine) {
                return "wrong, and the field agrees with us";
            }
            let off = matches!((question.pin.parse::<i64>(), mine.0.parse::<i64>()), (Ok(pin), Ok(said)) if pin.abs_diff(said) == 1);
            if off && near_mark(structure, found.start) {
                "wrong by a page, beside a mark"
            } else if off {
                "wrong by a page"
            } else {
                "wrong"
            }
        }
    }
}

#[derive(Default)]
struct Tally {
    counts: BTreeMap<String, u64>,
}

impl Tally {
    fn add(&mut self, key: String) {
        *self.counts.entry(key).or_default() += 1;
    }
    fn add_by(&mut self, key: String, by: u64) {
        *self.counts.entry(key).or_default() += by;
    }
    fn get(&self, key: &str) -> u64 {
        self.counts.get(key).copied().unwrap_or(0)
    }
}

/// A physical page of a scan, its words in reading order.
struct ScanPage {
    grams: std::collections::HashSet<u64>,
    /// The number the page prints, as read at its head; a scan missing a sheet is not counted on from its first page.
    label: u32,
}

/// A case's scan and the number its first physical page prints.
struct Scan {
    first: u32,
    pages: Vec<ScanPage>,
}

/// How long a run of words must match, and how many of a quotation's runs a page must hold to hold the quotation.
const SCAN_RUN: usize = 3;
const SCAN_HOLDS: f64 = 0.5;
/// A page holding this much of a quotation's runs holds it whole; with none such, a page holding SCAN_PART holds a copy of it.
const SCAN_WHOLE: f64 = 0.9;
const SCAN_PART: f64 = 0.25;
const SCAN_TURN: f64 = 0.8;

impl Scan {
    fn runs_of(text: &str) -> Vec<u64> {
        words_of(text).0.windows(SCAN_RUN).map(gram).collect()
    }

    /// The physical pages a quotation stands on: every page that holds its words in order, for words a case prints twice, or failing
    /// that the two pages of a turn that hold them between them.
    fn places_of(&self, quote: &str) -> Vec<usize> {
        let runs = Self::runs_of(quote);
        if runs.len() < 4 {
            return Vec::new();
        }
        let share = |page: &ScanPage| runs.iter().filter(|run| page.grams.contains(run)).count() as f64 / runs.len() as f64;
        // Every page that holds most of the words, and both pages of every turn that hold them between them: a quotation a case
        // prints twice, a dissent quoting the majority, or one that runs over a page, stands on each of those pages.
        // Where no page holds it whole, each page holding a good part of it: the copies a case prints twice differ in a word or two.
        let whole = self.pages.iter().any(|page| share(page) >= SCAN_WHOLE);
        let mut places = self.pages.iter().enumerate().filter(|(_, page)| share(page) >= SCAN_HOLDS || (!whole && share(page) >= SCAN_PART) || (whole && share(page) >= SCAN_WHOLE)).map(|(at, _)| at).collect::<Vec<_>>();
        places.extend(self.pages.windows(2).enumerate().filter(|(_, pair)| {
            let held = runs.iter().filter(|run| pair[0].grams.contains(run) || pair[1].grams.contains(run)).count() as f64 / runs.len() as f64;
            held >= SCAN_TURN && share(&pair[0]) > 0.1 && share(&pair[1]) > 0.1
        }).flat_map(|(at, _)| [at, at + 1]));
        places.sort_unstable();
        places.dedup();
        places
    }

    fn pages_of(&self, quote: &str) -> Vec<u32> {
        self.places_of(quote).into_iter().map(|at| self.pages[at].label).collect()
    }
}

fn scans_of(args: &[String]) -> HashMap<String, Scan> {
    // A planted fault: every printed number one too high. The score by scan must fall to almost nothing, or the key is not reading pages.
    let shifted = flag(args, "--mutate").as_deref() == Some("scan-first+1");
    let mut scans = HashMap::new();
    for file in flag(args, "--scans").iter().flat_map(|files| files.split(',')) {
        for row in BufReader::new(File::open(file).unwrap()).lines().filter_map(Result::ok).filter_map(|line| serde_json::from_str::<Value>(&line).ok()) {
            // Each page counts on from the first: Harvard blacks out the running heads, so a page's own number cannot be read, and
            // numbers at a line's edge are the text's. A scan missing a sheet mislabels the pages after it, a limit of this key.
            let first = row["first"].as_u64().unwrap_or(0) as u32 + u32::from(shifted);
            let pages = row["pages"].as_array().into_iter().flatten().enumerate().map(|(at, page)| {
                // A word broken across a line is one word.
                let text = page.as_str().unwrap_or_default().replace("-\n", "");
                ScanPage { grams: Scan::runs_of(&text).into_iter().collect(), label: first + at as u32 }
            }).collect();
            scans.insert(row["cluster"].as_str().unwrap_or_default().to_owned(), Scan { first, pages });
        }
    }
    scans
}

/// A reader's answer against the pages the scan puts a quotation on.
fn by_scan(truth: &[u32], answer: &Answer) -> &'static str {
    let Some((first, last)) = answer else { return "no answer" };
    let number = |label: &str| label.trim_end_matches(|c: char| c.is_ascii_alphabetic()).parse::<u32>();
    let (Ok(first), last) = (number(first), number(last).ok()) else { return "wrong" };
    if truth.iter().any(|page| first <= *page && *page <= last.unwrap_or(first).max(first)) { "right" } else { "wrong" }
}

/// Pairs judges wrote, by case: (reporter, page, other reporter, its page, citing opinion), reporters squeezed.
type Pairs = HashMap<String, Vec<(String, u32, String, u32, String)>>;

fn pairs_of(args: &[String], wanted: &std::collections::HashSet<String>) -> Pairs {
    let mut pairs = Pairs::new();
    for file in flag(args, "--pairs").iter().flat_map(|files| files.split(',')) {
        for line in BufReader::new(File::open(file).unwrap()).lines().filter_map(Result::ok) {
            let Some(cluster) = line.get(13..).and_then(|rest| rest.split('"').next()) else { continue };
            if !wanted.contains(cluster) {
                continue;
            }
            let Ok(row) = serde_json::from_str::<Value>(&line) else { continue };
            let text = |name: &str| row[name].as_str().unwrap_or_default().to_owned();
            if let (Ok(a), Ok(b)) = (text("a_pin").trim_matches(|c: char| !c.is_ascii_digit()).parse::<u32>(), text("b_pin").trim_matches(|c: char| !c.is_ascii_digit()).parse::<u32>()) {
                let entry = pairs.entry(cluster.to_owned()).or_default();
                entry.push((squeezed(&text("a")), a, squeezed(&text("b")), b, text("citing")));
            }
        }
    }
    pairs
}

/// The page in `wanted` that other opinions pair with `page` in `known`, by most of their votes.
fn paired_page(pairs: &[(String, u32, String, u32, String)], known: &str, page: u32, wanted: &str, asker: &str, least: u32) -> Option<u32> {
    let mut votes = HashMap::<u32, u32>::new();
    for (a, a_pin, b, b_pin, _) in pairs.iter().filter(|pair| pair.4 != asker) {
        if a == known && *a_pin == page && b == wanted {
            *votes.entry(*b_pin).or_default() += 1;
        } else if b == known && *b_pin == page && a == wanted {
            *votes.entry(*a_pin).or_default() += 1;
        }
    }
    let total = votes.values().sum::<u32>();
    // least 0: every pairing opinion must agree, so that a page the other book turns inside gives no answer.
    if least == 0 {
        return (votes.len() == 1).then(|| votes.into_keys().next()).flatten();
    }
    votes.into_iter().max_by_key(|vote| vote.1).filter(|vote| vote.1 * 2 > total && vote.1 >= least).map(|vote| vote.0)
}

/// One reader's result on one pin: group, reader, result, and the claim, its words and pin: a thousand citers copying one line make one.
type Scored = (String, String, &'static str, String);

/// Each claim once, and each opinion's share of its claims right, so that no famous case outweighs the rest.
fn summarize(scored: &[Scored], tally: &mut Tally, rate: f64, tier: &str) {
    // The sample takes each court and year at its own rate: an opinion stands for 1/rate of the corpus.
    let weight = if rate > 0.0 { 1.0 / rate } else { 1.0 };
    let mut seen = std::collections::HashSet::new();
    let mut opinions = BTreeMap::<(&str, &str), (u64, u64)>::new();
    for (group, reader, result, claim) in scored {
        if !seen.insert((group, reader, claim)) {
            continue;
        }
        tally.add(format!("{group}|{reader} distinct|{result}"));
        tally.add(format!("{group}|{reader} [{tier}]|{result}"));
        let entry = opinions.entry((group, reader)).or_default();
        entry.0 += u64::from(*result == "right");
        entry.1 += 1;
    }
    for ((group, reader), (right, all)) in opinions {
        let share = right as f64 / all as f64;
        tally.add(format!("{group}|{reader} per opinion|opinions"));
        tally.add_by(format!("{group}|{reader} per opinion|sum"), (share * 1e6) as u64);
        tally.add_by(format!("{group}|{reader} per opinion|square"), (share * share * 1e6) as u64);
        tally.add_by(format!("{group}|{reader} per opinion|weight"), (weight * 1e3) as u64);
        tally.add_by(format!("{group}|{reader} per opinion|weighted"), (share * weight * 1e3) as u64);
    }
}

/// A rendition as one who reads it as well as can be: its tags, or failing those the marks its words print, "*735", "Page 702".
fn any_rendition(raw: &str) -> Field {
    static PRINTED: OnceLock<Regex> = OnceLock::new();
    let printed = PRINTED.get_or_init(|| Regex::new(r"\*\s?(?:Page\s*)?(\d{1,5})\b|(?m)^\s*Page\s+(\d{1,5})\s*$").unwrap());
    let mut field = field_of(raw);
    if field.marks.is_empty() {
        let (mut last_byte, mut last_unit) = (0, 0);
        for capture in printed.captures_iter(&field.text) {
            let place = capture.get(0).unwrap().start();
            last_unit += field.text[last_byte..place].encode_utf16().count();
            last_byte = place;
            let label = capture.get(1).or_else(|| capture.get(2)).unwrap().as_str().to_owned();
            field.marks.push((last_unit, label, false));
        }
    }
    field
}

/// The best single field for this opinion, item by item, chosen knowing which pins it gets right: no real reader can do better
/// from one field, so what it cannot reach only the union reaches.
#[allow(clippy::too_many_arguments)]
fn best_one_field(renditions: &[(String, String)], graded: &[(String, Question, Option<u32>, String)], opinion_type: &str, scan: Option<&Scan>, reparse: Option<&dyn Fn(&str) -> Option<DocumentStructure>>, scored: &mut Vec<Scored>, tally: &mut Tally, failures: &mut Vec<Value>, id: &str) {
    let mut best = BTreeMap::<&str, (usize, &str, Vec<(&'static str, &str)>)>::new();
    let mut best_by_scan = BTreeMap::<&str, (usize, Vec<&'static str>)>::new();
    let truths = graded.iter().map(|(_, question, low, _)| scan.filter(|scan| question.kind == Kind::Page && low.is_some_and(|low| low.abs_diff(scan.first) <= 2)).map_or_else(Vec::new, |scan| scan.pages_of(&question.quote))).collect::<Vec<_>>();
    let mut read = std::collections::HashSet::new();
    for (name, raw) in renditions {
        // The rival reads one rendition: by our own parser where asked, else by its tags.
        let parsed = reparse.and_then(|reparse| reparse(name));
        if reparse.is_some() && parsed.is_none() {
            continue;
        }
        let field = any_rendition(raw);
        let text = parsed.as_ref().map_or(field.text.as_str(), |structure| structure.text.as_str());
        // html_with_citations and xml_harvard are one tree: the same words and marks are not read twice.
        if !read.insert((hash_word(text), field.marks.len())) {
            continue;
        }
        let finder = Finder::new(text);
        let units = text.encode_utf16().collect::<Vec<_>>();
        let mut here = BTreeMap::<&str, Vec<(&'static str, &str)>>::new();
        let mut here_by_scan = BTreeMap::<&str, Vec<&'static str>>::new();
        for ((group, question, low, claim), truth) in graded.iter().zip(&truths) {
            let found = find_quote(&finder, &quote_parts(&question.quote)).filter(|found| !found.twice).map(|found| widened(&units, found));
            let said = match &parsed {
                Some(structure) => found.and_then(|found| parser_answer(structure, question, found)),
                None => found.and_then(|found| field_answer(&field, question, found, false, *low, opinion_type)),
            };
            let result = if found.is_some() { outcome(question, &said) } else { "quotation not in its text" };
            here.entry(group).or_default().push((result, claim));
            if !truth.is_empty() {
                here_by_scan.entry(group).or_default().push(by_scan(truth, &said));
            }
        }
        for (group, results) in here_by_scan {
            let right = results.iter().filter(|result| **result == "right").count();
            if best_by_scan.get(group).is_none_or(|known| right > known.0) {
                best_by_scan.insert(group, (right, results));
            }
        }
        for (group, results) in here {
            let right = results.iter().filter(|result| result.0 == "right").count();
            if best.get(group).is_none_or(|known| right > known.0) {
                best.insert(group, (right, name, results));
            }
        }
    }
    for (group, (_, results)) in best_by_scan {
        for result in results {
            tally.add(format!("{group}|best one field by scan|{result}"));
        }
    }
    let ours = scored.iter().filter(|score| score.1 == "parser").map(|score| ((score.0.clone(), score.3.clone()), score.2)).collect::<HashMap<_, _>>();
    for (group, (_, name, results)) in best {
        for (result, claim) in results {
            tally.add(format!("{group}|best one field|{result}"));
            scored.push((group.to_owned(), "best one field".to_owned(), result, claim.to_owned()));
            if result == "right" && ours.get(&(group.to_owned(), claim.to_owned())).is_some_and(|ours| *ours != "right") {
                tally.add(format!("{group}|only the best field right|{name}"));
                failures.push(json!({ "cause": "the best field had it", "kind": "rival", "group": group, "id": id, "rendition": name, "claim": claim }));
            }
        }
    }
}

const TIERS: [&str; 3] = ["no Harvard", "Harvard, no marks", "Harvard, marks"];

/// What the record holds of Harvard, from its files alone.
fn harvard_tier(renditions: &[(String, String)]) -> &'static str {
    match renditions.iter().find(|(name, _)| name == "xml_harvard.xml") {
        None => TIERS[0],
        Some((_, text)) if text.contains("page-number") || text.contains("star-pagination") => TIERS[2],
        Some(_) => TIERS[1],
    }
}

/// The rate the sample took this opinion at.
fn rate_of(fields: &Value) -> f64 {
    fields["_rate"].as_f64().or_else(|| fields["_rate"].as_str().and_then(|rate| rate.parse().ok())).unwrap_or(0.0)
}

fn tagged_labels(rendition: &str) -> Vec<u32> {
    static LABEL: OnceLock<Regex> = OnceLock::new();
    LABEL.get_or_init(|| Regex::new(r#"\blabel="\*?\s*(\d{1,5})\s*""#).unwrap()).captures_iter(rendition).filter_map(|capture| capture[1].parse().ok()).collect()
}

#[allow(clippy::too_many_arguments)]
fn grade_record(structure: &DocumentStructure, raw: &str, renditions: &[(String, String)], labels: &[u32], opinion_type: &str, siblings: &[String], scan: Option<&Scan>, paired: Option<&Vec<(String, u32, String, u32, String)>>, reparse: Option<&dyn Fn(&str) -> Option<DocumentStructure>>, rate: f64, questions: &[Question], table: &Table, tally: &mut Tally, failures: &mut Vec<Value>, answers: &mut Vec<Value>, id: &str) {
    let mut scored = Vec::<Scored>::new();
    let mut graded = Vec::<(String, Question, Option<u32>, String)>::new();
    let ours = Finder::new(&structure.text);
    let field = field_of(raw);
    let theirs = Finder::new(&field.text);
    let (our_units, their_units) = (structure.text.encode_utf16().collect::<Vec<_>>(), field.text.encode_utf16().collect::<Vec<_>>());
    let located = questions.iter().map(|question| {
        let parts = quote_parts(&question.quote);
        (find_quote(&ours, &parts), find_quote(&theirs, &parts))
    }).collect::<Vec<_>>();
    // What the other citing opinions pin, by citation and by half of the citing opinions: no opinion's own pin helps answer it.
    let half = |citing: &str| hash_word(citing) % 2 == 0;
    let mut pinned = HashMap::<(String, bool), Vec<(usize, u32)>>::new();
    for (question, &(mine, other)) in questions.iter().zip(&located) {
        let Some(found) = mine.filter(|found| matches!(question.kind, Kind::Page | Kind::Paragraph | Kind::Vendor) && !found.twice) else { continue };
        if other.is_some_and(|found| found.twice || echoed(&their_units, found)) {
            continue;
        }
        let name = match question.kind {
            Kind::Paragraph => Some(PARAGRAPHS.to_owned()),
            Kind::Vendor => Some(question.cite.split_whitespace().take(3).collect::<Vec<_>>().join(" ")),
            _ => citation_of(question, table).map(|cited| cited.0),
        };
        if let (Some(name), Ok(pin)) = (name, question.pin.parse::<u32>()) {
            let found = widened(&our_units, found);
            pinned.entry((name, half(&question.citing))).or_default().push(((found.start + found.end) / 2, pin));
        }
    }
    let numberings = pinned.iter().map(|(key, pins)| (key.clone(), legal_structure::opinion::citers_numbering(pins))).collect::<HashMap<_, _>>();
    let every_citer = pinned.keys().map(|key| key.0.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().map(|name| {
        let pins = [true, false].iter().filter_map(|side| pinned.get(&(name.clone(), *side))).flatten().copied().collect::<Vec<_>>();
        let numbering = legal_structure::opinion::citers_numbering(&pins);
        (name, numbering)
    }).collect::<HashMap<_, _>>();
    tag_check(structure, &field, &our_units, &their_units, &ours, &theirs, table, tally, failures, id, &every_citer);
    // What opens a separate writing, by its first word: no pin tests a part wrongly opened where nobody attributes a quotation.
    for part in nodes(structure, NodeKind::Section).filter(|part| part.range.start > 0 && matches!(part.display_value.as_deref().unwrap_or(""), "dissent" | "concurrence" | "concurrence and dissent")) {
        let first = part.properties.get("author").map(String::as_str).and_then(|author| author.split_whitespace().next()).unwrap_or("").to_lowercase();
        tally.add(format!("openers|{}|", first.trim_matches(|c: char| !c.is_alphanumeric())));
    }
    let places = located.iter().filter_map(|pair| pair.0).map(|found| widened(&our_units, found)).collect::<Vec<_>>();
    // Who pins what at each passage of the field's text, by citation. A citer's pin can belong to the next sentence of its own
    // opinion, so a passage three or more quote has a second key, their majority. No reader's answer enters it.
    let passage_of = |question: &Question, found: Found| {
        let name = if question.kind == Kind::Paragraph { PARAGRAPHS.to_owned() } else { citation_of(question, table).map_or_else(String::new, |cited| cited.0) };
        (name, (found.start + found.end) / 2 / PASSAGE)
    };
    let mut votes = HashMap::<(String, usize), HashMap<String, (u32, std::collections::BTreeSet<String>)>>::new();
    for (question, &(_, other)) in questions.iter().zip(&located) {
        if let (Some(found), true) = (other.map(|found| widened(&their_units, found)), matches!(question.kind, Kind::Page | Kind::Paragraph)) {
            let entry = votes.entry(passage_of(question, found)).or_default().entry(question.pin.clone()).or_default();
            if entry.1.insert(question.citing.clone()) {
                entry.0 += 1;
            }
        }
    }
    let majority = |question: &Question, found: Found| -> Option<String> {
        let pins = votes.get(&passage_of(question, found))?;
        let total = pins.values().map(|pin| pin.0).sum::<u32>();
        let (pin, count) = pins.iter().map(|(pin, entry)| (pin, entry.0)).max_by_key(|entry| entry.1)?;
        (total >= LEAST_VOTES && count * 2 > total).then(|| pin.clone())
    };
    for (at, (question, &(mine, other))) in questions.iter().zip(&located).enumerate() {
        let kind = question.kind.name();
        // A syllabus may stand on the case and not in the opinion's text: the point is asked of the headnotes alone.
        if question.kind == Kind::Point {
            let said = point_answer(structure, &quote_parts(&question.quote));
            let result = outcome(question, &said);
            tally.add(format!("{kind}|parser|{result}"));
            tally.add(format!("{kind}|field|no answer"));
            tally.add(format!("{kind}|docket|no answer"));
            if result != "right" {
                failures.push(json!({ "cause": result, "kind": kind, "group": kind, "id": id, "cite": question.cite, "pin": question.pin, "ours": said, "citing": question.citing, "quote": question.quote }));
            }
            continue;
        }
        if mine.is_none() && other.is_none() {
            tally.add(format!("{kind}|excluded|quotation in neither text, {}", if siblings.is_empty() { "the case's only opinion, or no sheet" } else { "the case has other opinions" }));
            continue;
        }
        // "(Thomas, J., concurring)" where the case holds the concurrence as an opinion of its own: the words here are that writing's echo.
        if let Kind::Part(asked) = &question.kind {
            if !opinion_type.to_lowercase().contains(asked) && siblings.iter().any(|sibling| sibling.to_lowercase().contains(asked)) {
                tally.add(format!("{kind}|excluded|attributed to another opinion of the case"));
                continue;
            }
        }
        // What stands twice, or is itself a quotation, is read off the field's text, never off ours.
        if other.is_some_and(|found| found.twice) {
            tally.add(format!("{kind}|excluded|quotation stands twice in the field"));
            continue;
        }
        let pages = matches!(question.kind, Kind::Page | Kind::Vendor);
        let cited = citation_of(question, table);
        if question.kind == Kind::Page && cited.is_none() {
            tally.add(format!("{kind}|excluded|pin names no one citation in the case's table"));
            continue;
        }
        let question = &Question { reporter: cited.as_ref().map_or_else(|| question.reporter.clone(), |found| found.0.clone()), ..question.clone() };
        let low = cited.as_ref().map(|found| found.1);
        // Which pages a record holds, from every rendition's own tags: it may be one writing of several.
        if let (Some(low), Ok(pin)) = (low.filter(|_| question.kind == Kind::Page), question.pin.parse::<u32>()) {
            let own = labels.iter().copied().filter(|label| low <= *label && *label <= low + REACH).collect::<Vec<_>>();
            if let (Some(least), Some(most)) = (own.iter().min(), own.iter().max()) {
                if own.len() >= 2 && (pin + 1 < *least || pin > *most + 1) {
                    tally.add(format!("{kind}|excluded|pin outside this writing's tagged pages"));
                    continue;
                }
            }
        }
        // Groups by the reporter and the tags alone, before any reader answers.
        let marked = low.is_some_and(|low| field.marks.iter().any(|mark| mark.1.parse::<u32>().is_ok_and(|label| low <= label && label <= low + REACH)));
        let plain = match question.kind {
            Kind::Page | Kind::Vendor if marked => format!("{kind} (reporter the field marks)"),
            // A true parallel pin: the field numbers another reporter, not this one.
            Kind::Page | Kind::Vendor if !field.marks.is_empty() => format!("{kind} (parallel: the field marks another reporter)"),
            Kind::Page | Kind::Vendor => format!("{kind} (the field marks no pages)"),
            _ => kind.to_owned(),
        };
        // Words the cited text itself quotes are graded apart and count toward no mark: a separate writing's echo can stand there.
        let group = if other.is_some_and(|found| echoed(&their_units, found)) { format!("{plain}, words the cited text quotes") } else { plain };
        let _ = pages;
        let claim = format!("{}|{}", squeezed(&question.quote), question.pin);
        graded.push((group.clone(), question.clone(), low, claim.clone()));
        let other = other.map(|found| widened(&their_units, found));
        let mine = mine.map(|found| widened(&our_units, found));
        let field_said = other.and_then(|found| field_answer(&field, question, found, false, low, opinion_type));
        let docket_said = other.and_then(|found| field_answer(&field, question, found, true, low, opinion_type));
        let field_result = if other.is_some() { outcome(question, &field_said) } else { "quotation not in its text" };
        tally.add(format!("{group}|field|{field_result}"));
        scored.push((group.clone(), "field".to_owned(), field_result, claim.clone()));
        tally.add(format!("{group}|docket|{}", if other.is_some() { outcome(question, &docket_said) } else { "quotation not in its text" }));
        let Some(found) = mine else {
            tally.add(format!("{group}|parser|quotation not in its text"));
            tally.add(format!("{group}|combined|quotation not in its text"));
            scored.push((group.clone(), "parser".to_owned(), "quotation not in its text", claim.clone()));
            scored.push((group.clone(), "combined".to_owned(), "quotation not in its text", claim.clone()));
            if field_said.as_ref().is_some_and(|answer| right(question, answer)) {
                failures.push(json!({ "cause": "our text lacks the words, the field had it", "kind": kind, "id": id, "cite": question.cite, "pin": question.pin, "citing": question.citing, "quote": question.quote }));
            }
            continue;
        };
        let said = parser_answer(structure, question, found);
        let result = outcome(question, &said);
        tally.add(format!("{group}|parser|{result}"));
        scored.push((group.clone(), "parser".to_owned(), result, claim.clone()));
        let vote = other.filter(|_| matches!(question.kind, Kind::Page | Kind::Paragraph)).and_then(|found| majority(question, found));
        if let Some(vote) = &vote {
            let voted = Question { pin: vote.clone(), through: None, others: Vec::new(), ..question.clone() };
            tally.add(format!("{group}|parser, by passage vote|{}", outcome(&voted, &said)));
            tally.add(format!("{group}|field, by passage vote|{}", outcome(&voted, &field_said)));
            tally.add(format!("{group}|this pin against its passage's vote|{}", if *vote == question.pin { "agrees" } else { "differs" }));
        }
        if matches!(question.kind, Kind::Page | Kind::Paragraph | Kind::Vendor) {
            let name = match question.kind {
                Kind::Paragraph => PARAGRAPHS.to_owned(),
                Kind::Vendor => question.cite.split_whitespace().take(3).collect::<Vec<_>>().join(" "),
                _ => question.reporter.clone(),
            };
            let numbering = numberings.get(&(name, !half(&question.citing)));
            let citers = numbering.and_then(|numbering| legal_structure::opinion::citers_page(numbering, (found.start + found.end) / 2)).map(|pages| (pages.0.to_string(), pages.1.to_string()));
            tally.add(format!("{group}|citers|{}", outcome(question, &citers)));
            if citers.as_ref().is_some_and(|pages| pages.0 == pages.1) {
                tally.add(format!("{group}|citers, one page|{}", outcome(question, &citers)));
            }
            if question.kind == Kind::Page {
                answers.push(json!({ "id": id, "group": group, "cite": question.cite, "pin": question.pin, "through": question.through, "citing": question.citing, "quote": question.quote, "ours": said, "field": field_said, "citers": citers, "exact": found.exact, "result": result }));
            }
            // The scan's own book only: a pin to a parallel reporter names pages this scan does not print.
            if let (Some(scan), Some(low), Kind::Page) = (scan, low, &question.kind) {
                if low.abs_diff(scan.first) <= 2 {
                    let truth = scan.pages_of(&question.quote);
                    if truth.is_empty() {
                        tally.add(format!("{group}|excluded by scan|words not located on a page"));
                    } else {
                        let pin = question.pin.parse::<u32>().ok().map(|pin| (pin.to_string(), question.through.clone().unwrap_or_else(|| pin.to_string())));
                        for (reader, answer) in [("parser", &said), ("field", &field_said), ("citers", &citers), ("citing judge", &pin)] {
                            tally.add(format!("{group}|{reader} by scan|{}", by_scan(&truth, answer)));
                        }
                        let joined = said.clone().or(citers.clone());
                        tally.add(format!("{group}|combined by scan|{}", by_scan(&truth, &joined)));
                        if by_scan(&truth, &said) != "right" {
                            failures.push(json!({ "cause": format!("scan: {}", by_scan(&truth, &said)), "kind": "scan", "group": group, "id": id, "cite": question.cite, "pin": question.pin, "ours": said, "field": field_said, "truth": truth, "quote": question.quote, "at": found.start }));
                        }
                    }
                }
            }
            // Pairs: a page the parser knows in another reporter, and the page other opinions pair with it in this one.
            if let Some(paired) = paired.filter(|_| question.kind == Kind::Page) {
                let wanted = question.reporter.clone();
                let ask = |least: u32| reading(structure).page_series.iter().filter(|series| squeezed(&series.reporter) != wanted).find_map(|series| {
                    let other = Question { reporter: series.reporter.clone(), ..question.clone() };
                    let page = parser_answer(structure, &other, found)?.0.parse::<u32>().ok()?;
                    paired_page(paired, &squeezed(&series.reporter), page, &wanted, &question.citing, least)
                }).map(|page| (page.to_string(), page.to_string()));
                let (answer, agreed, unanimous) = (ask(1), ask(2), ask(0));
                tally.add(format!("{group}|pairs, all agree|{}", outcome(question, &unanimous)));
                tally.add(format!("{group}|parser, citers, pairs all agree|{}", outcome(question, &said.clone().or(citers.clone()).or(unanimous.clone()))));
                // Where pairs disagree, the citers' page decides between them: keep it only if some pair names it.
                let settled = citers.clone().filter(|_| unanimous.is_none() && answer.is_some());
                tally.add(format!("{group}|parser, pairs all agree, then citers|{}", outcome(question, &said.clone().or(unanimous).or(settled).or(citers.clone()))));
                tally.add(format!("{group}|pairs|{}", outcome(question, &answer)));
                if let (Some(said_page), Ok(pin)) = (answer.as_ref().and_then(|pages| pages.0.parse::<i64>().ok()), question.pin.parse::<i64>()) {
                    if outcome(question, &answer) == "wrong" {
                        let off = said_page - pin;
                        tally.add(format!("pairs off by|{}|", if off.abs() <= 3 { off.to_string() } else if off > 0 { "more than +3".to_owned() } else { "more than -3".to_owned() }));
                    }
                }
                tally.add(format!("{group}|pairs, two or more|{}", outcome(question, &agreed)));
                tally.add(format!("{group}|parser, then pairs, then citers|{}", outcome(question, &said.clone().or(answer.clone()).or(citers.clone()))));
                tally.add(format!("{group}|parser, then citers, then pairs|{}", outcome(question, &said.clone().or(citers.clone()).or(answer))));
                tally.add(format!("{group}|parser, citers, pairs two or more|{}", outcome(question, &said.clone().or(citers.clone()).or(agreed))));
            }
            let joined = outcome(question, &said.clone().or(citers));
            tally.add(format!("{group}|combined|{joined}"));
            scored.push((group.clone(), "combined".to_owned(), joined, claim.clone()));
        } else {
            tally.add(format!("{group}|combined|{result}"));
            scored.push((group.clone(), "combined".to_owned(), result, claim.clone()));
        }
        if let Some(source) = said.as_ref().and_then(|_| source_of(structure, question, found)) {
            tally.add(format!("{group}|rests on {source}|{result}"));
        }
        tally.add(format!("{group}|found|{}", if found.exact { "word for word" } else { "through a scanner's slips" }));
        if found.twice {
            tally.add(format!("{group}|words stand twice in our text|"));
        }
        if result == "right" && field_said.as_ref().is_none_or(|answer| !right(question, answer)) {
            tally.add(format!("{group}|only the parser right|"));
        }
        if result != "right" && field_said.as_ref().is_some_and(|answer| right(question, answer)) {
            tally.add(format!("{group}|only the field right|"));
        }
        // The controls: the same questions, answered wrongly on purpose. Only a right answer can show the grader sees a wrong one.
        if matches!(question.kind, Kind::Page | Kind::Paragraph | Kind::Vendor) {
            if let (Some(answer), "right") = (&said, result) {
                if let (Ok(first), Ok(last)) = (answer.0.parse::<u32>(), answer.1.parse::<u32>()) {
                    for by in [1, -1] {
                        let moved = |page: u32| (page as i64 + by).to_string();
                        let answer = Some((moved(first), moved(last)));
                        tally.add(format!("{group}|shifted|{}", outcome(question, &answer)));
                    }
                }
            }
            if places.len() > 1 {
                let elsewhere = places[(at + 1) % places.len()];
                if elsewhere.start != found.start {
                    let answer = parser_answer(structure, question, elsewhere);
                    tally.add(format!("{group}|chance|{}", outcome(question, &answer)));
                }
            }
        }
        if result != "right" {
            let why = cause(question, &said, &field_said, structure, found);
            tally.add(format!("{group}|cause|{why}"));
            let (from, to) = (found.start.saturating_sub(120), found.end + 120);
            let context = String::from_utf16_lossy(&structure.text.encode_utf16().skip(from).take(to - from).collect::<Vec<_>>());
            failures.push(json!({ "cause": why, "kind": kind, "group": group, "id": id, "cite": question.cite, "pin": question.pin, "ours": said, "field": field_said, "citing": question.citing, "quote": question.quote, "at": found.start, "exact": found.exact, "vote": vote, "marks_around": other.map(|found| (field.marks.iter().filter(|mark| mark.0 <= found.end).next_back().map(|mark| found.start as i64 - mark.0 as i64), field.marks.iter().find(|mark| mark.0 > found.end).map(|mark| mark.0 as i64 - found.end as i64))), "context": context, "series": reading(structure).page_series.iter().map(|series| &series.citation).collect::<Vec<_>>() }));
        }
    }
    let started = Instant::now();
    best_one_field(renditions, &graded, opinion_type, scan, reparse, &mut scored, tally, failures, id);
    tally.add_by("timing|best one field|ms".to_owned(), started.elapsed().as_millis() as u64);
    summarize(&scored, tally, rate, harvard_tier(renditions));
}

/// The key with no judge in it. Words from the middle of a page the tags bound are asked of every reader: the field, which holds
/// the tags, must be right every time or the grader is broken, and any miss of the parser is its own. Most of the opinion's pages,
/// spread evenly, a handful to a record.
#[allow(clippy::too_many_arguments)]
fn tag_check(structure: &DocumentStructure, field: &Field, our_units: &[u16], their_units: &[u16], ours: &Finder, theirs: &Finder, table: &Table, tally: &mut Tally, failures: &mut Vec<Value>, id: &str, citers: &HashMap<String, Vec<(usize, u32, u32)>>) {
    const ASKED: usize = 5;
    const SPAN: usize = 260;
    const GROUP: &str = "tag check, no judges";
    let marks = field.marks.iter().filter_map(|mark| Some((mark.0, mark.1.parse::<u32>().ok()?))).collect::<Vec<_>>();
    if marks.len() < 3 {
        return;
    }
    let lowest = marks.iter().map(|mark| mark.1).min().unwrap_or(0);
    // The citations these tags can number, any whose pages reach them: the table cannot say which, "90 L. Ed. 2d 428" lying nearer the
    // marks of 476 U.S. 426 from 441. This check asks where the marks fall; the real pins grade the name.
    let printed = |row: &&(String, String, u32)| !row.0.contains("lexis") && !row.0.ends_with("wl");
    let mut reach = table.iter().filter(printed).filter(|row| row.2 <= lowest && lowest <= row.2 + REACH).collect::<Vec<_>>();
    reach.sort_by_key(|row| std::cmp::Reverse(row.2));
    let names = reach.into_iter().map(|row| row.0.clone()).collect::<Vec<_>>();
    if names.is_empty() {
        return;
    }
    let tagged = marks.iter().map(|mark| (mark.0, mark.1.to_string())).collect::<Vec<_>>();
    for pair in marks.windows(2).step_by((marks.len() / ASKED).max(1)) {
        let ((from, label), (to, _)) = (pair[0], pair[1]);
        let middle = (from + to) / 2 - SPAN / 2;
        if to < from + SPAN * 2 || field.notes.iter().any(|note| note.0 < middle + SPAN && middle < note.1) {
            continue;
        }
        let words = words_of(&String::from_utf16_lossy(&their_units[middle..middle + SPAN])).0;
        if words.len() < 14 {
            continue;
        }
        let words = &words[1..words.len() - 1];
        let question = |name: &String| Question { citing: String::new(), cite: String::new(), reporter: name.clone(), pin: label.to_string(), through: None, others: Vec::new(), kind: Kind::Page, quote: String::new() };
        let asked = question(&names[0]);
        let (Some(mine), Some(other)) = (ours.find(words), theirs.find(words)) else {
            tally.add(format!("{GROUP}|excluded|words differ between the texts"));
            continue;
        };
        if other.twice {
            tally.add(format!("{GROUP}|excluded|words stand twice in the field"));
            continue;
        }
        let said = last_before(&tagged, other.start).map(|page| (page.to_owned(), last_before(&tagged, other.end).unwrap_or(page).to_owned()));
        tally.add(format!("{GROUP}|field|{}", outcome(&asked, &said)));
        let ours_said = names.iter().find_map(|name| parser_answer(structure, &question(name), mine));
        let result = outcome(&asked, &ours_said);
        tally.add(format!("{GROUP}|parser|{result}"));
        // The citers' numbering against the tags, which no citer wrote: the one check of it the citers cannot have leaked into.
        let reckoned = names.iter().find_map(|name| legal_structure::opinion::citers_page(citers.get(name)?, (mine.start + mine.end) / 2)).map(|pages| (pages.0.to_string(), pages.1.to_string()));
        tally.add(format!("{GROUP}|citers|{}", outcome(&asked, &reckoned)));
        if result != "right" {
            let at = mine.start.min(our_units.len());
            let context = String::from_utf16_lossy(&our_units[at.saturating_sub(100)..(at + 160).min(our_units.len())]);
            failures.push(json!({ "cause": format!("tag check: {result}"), "kind": "tag", "id": id, "reporter": names, "pin": label, "ours": ours_said, "at": mine.start, "context": context, "series": reading(structure).page_series.iter().map(|series| &series.citation).collect::<Vec<_>>() }));
        }
    }
}

/// A planted fault, to prove the grader sees it: each must lower its own item and leave the others.
fn mutate(structure: &mut DocumentStructure, name: &str) {
    // Each number one more: a label that is no number stays.
    let relabel = |node: &mut StructureNode| {
        if let Some(label) = node.label.as_mut().filter(|label| label.parse::<i64>().is_ok()) {
            *label = (label.parse::<i64>().unwrap() + 1).to_string();
        }
    };
    let paragraph = |node: &StructureNode| matches!(node.kind, NodeKind::Paragraph | NodeKind::Quote);
    match name {
        "page-labels+1" => structure.nodes.iter_mut().filter(|node| node.kind == NodeKind::Page).for_each(|page| relabel(page)),
        // Each mark a little way down the page: only passages near a break can tell.
        "page-marks-late" => structure.nodes.iter_mut().filter(|node| node.kind == NodeKind::Page).for_each(|page| page.range.start += 600),
        // Reporters crossed: each citation answered with the other's numbering. The parallel pins' own test.
        "series-crossed" => if let Some(opinion) = structure.opinion.as_deref_mut() {
            let names = opinion.page_series.iter().map(|series| series.series.clone()).collect::<Vec<_>>();
            if names.len() >= 2 {
                for (at, series) in opinion.page_series.iter_mut().enumerate() {
                    series.series = names[(at + 1) % names.len()].clone();
                }
            }
        },
        "notes-gone" => structure.nodes.retain(|node| node.kind != NodeKind::Footnote),
        "note-labels+1" => structure.nodes.iter_mut().filter(|node| node.kind == NodeKind::Footnote).for_each(|note| relabel(note)),
        "numbers+1" => structure.nodes.iter_mut().filter(|node| paragraph(node) && node.label.is_some()).for_each(|node| relabel(node)),
        "numbers-gone" => structure.nodes.iter_mut().filter(|node| paragraph(node)).for_each(|node| node.label = None),
        "writings-crossed" => structure.nodes.iter_mut().filter(|node| node.kind == NodeKind::Section).for_each(|part| {
            let crossed = if part.display_value.as_deref().unwrap_or("").contains("dissent") { "majority" } else { "dissent" };
            part.display_value = Some(crossed.to_owned());
        }),
        // Text cut from the middle: the words go, and every pin past them must say so.
        "text-halved" => {
            let half = structure.text.len() / 2;
            let cut = (half..structure.text.len()).find(|at| structure.text.is_char_boundary(*at)).unwrap_or(half);
            structure.text.truncate(cut);
        }
        other => panic!("no such mutation: {other}"),
    }
}

/// The marks set before any pin was scored: right when answering, and right of all pins whose quotation stands in the reader's
/// text, for each form. None where the free data limits how many can be answered.
const PASS: [(&str, f64, Option<f64>); 5] = [
    ("page (reporter the field marks)", 99.0, Some(95.0)), ("page (parallel: the field marks another reporter)", 99.0, None), ("page (the field marks no pages)", 99.0, None),
    ("paragraph", 99.5, Some(97.0)), ("footnote", 99.0, Some(95.0)),
];

fn report(tally: &Tally, records: u64, seconds: f64) -> String {
    let mut groups = tally.counts.keys().filter_map(|key| key.split('|').next()).map(str::to_owned).collect::<Vec<_>>();
    groups.dedup();
    groups.sort();
    groups.dedup();
    let mut out = format!("{records} cited opinions graded, {seconds:.0}s\n");
    for group in &groups {
        let count = |reader: &str, result: &str| tally.get(&format!("{group}|{reader}|{result}"));
        out.push_str(&format!("\n== {group}\n"));
        for reader in ["parser", "field", "best one field", "docket", "citers", "citers, one page", "combined", "parser, by passage vote", "field, by passage vote", "parser distinct", "field distinct", "best one field distinct", "combined distinct", "parser by scan", "field by scan", "best one field by scan", "citers by scan", "combined by scan", "citing judge by scan", "pairs", "pairs, two or more", "pairs, all agree", "parser, citers, pairs all agree", "parser, pairs all agree, then citers", "parser, then pairs, then citers", "parser, then citers, then pairs", "parser, citers, pairs two or more"] {
            let (yes, no, none, away) = (count(reader, "right"), count(reader, "wrong"), count(reader, "no answer"), count(reader, "quotation not in its text"));
            let answered = yes + no;
            if answered + none + away == 0 {
                continue;
            }
            out.push_str(&format!("  {reader:24} right {yes:>8}  wrong {no:>7}  no answer {none:>8}  words not in its text {away:>7}  right when answering {:>6.2}%  right of all {:>6.2}%\n",
                yes as f64 * 100.0 / answered.max(1) as f64, yes as f64 * 100.0 / (answered + none + away).max(1) as f64));
        }
        for reader in ["parser", "field", "best one field", "combined"] {
            let opinions = count(&format!("{reader} per opinion"), "opinions");
            if opinions > 0 {
                let mean = count(&format!("{reader} per opinion"), "sum") as f64 / 1e6 / opinions as f64;
                let spread = (count(&format!("{reader} per opinion"), "square") as f64 / 1e6 / opinions as f64 - mean * mean).max(0.0);
                let (weighted, weight) = (count(&format!("{reader} per opinion"), "weighted") as f64, count(&format!("{reader} per opinion"), "weight") as f64);
                out.push_str(&format!("  {reader:24} per opinion {:>6.2}% +/- {:.2} of {opinions} opinions; weighted to the corpus {:>6.2}%\n", mean * 100.0, 196.0 * (spread / opinions as f64).sqrt(), weighted * 100.0 / weight.max(1.0)));
            }
        }
        out.push_str(&format!("  cold    right        0  (COLD Cases keeps no marks; it answers nothing)\n"));
        for tier in TIERS {
            for reader in ["parser", "field", "best one field", "combined"] {
                let name = format!("{reader} [{tier}]");
                let (yes, no, none, away) = (count(&name, "right"), count(&name, "wrong"), count(&name, "no answer"), count(&name, "quotation not in its text"));
                if yes + no + none + away > 0 {
                    out.push_str(&format!("  {name:38} right {yes:>7}  wrong {no:>6}  no answer {none:>7}  not in text {away:>6}  right when answering {:>6.2}%  right of all {:>6.2}%\n", yes as f64 * 100.0 / (yes + no).max(1) as f64, yes as f64 * 100.0 / (yes + no + none + away).max(1) as f64));
                }
            }
        }
        let (agrees, differs) = (count("this pin against its passage's vote", "agrees"), count("this pin against its passage's vote", "differs"));
        if agrees + differs > 0 {
            out.push_str(&format!("  pins on a passage three or more quote: {} agree with the majority, {} do not ({:.2}%)\n", agrees, differs, differs as f64 * 100.0 / (agrees + differs) as f64));
        }
        out.push_str(&format!("  only the parser right {}   only the field right {}\n", count("only the parser right", ""), count("only the field right", "")));
        let (moved, chance) = (count("shifted", "right") as f64 * 100.0 / (count("shifted", "right") + count("shifted", "wrong")).max(1) as f64,
            count("chance", "right") as f64 * 100.0 / (count("chance", "right") + count("chance", "wrong")).max(1) as f64);
        if count("shifted", "wrong") + count("chance", "wrong") > 0 {
            out.push_str(&format!("  controls: right answers moved a page either way still marked right {moved:.2}%, another quotation's place marked right {chance:.2}%\n"));
        }
        let excluded = tally.counts.iter().filter(|(key, _)| key.starts_with(&format!("{group}|excluded|"))).map(|(key, count)| format!("{} {count}", key.rsplit('|').next().unwrap_or(""))).collect::<Vec<_>>();
        if !excluded.is_empty() {
            out.push_str(&format!("  excluded: {}\n", excluded.join(", ")));
        }
        let sources = tally.counts.keys().filter_map(|key| key.strip_prefix(&format!("{group}|rests on "))).filter_map(|rest| rest.split('|').next()).map(str::to_owned).collect::<std::collections::BTreeSet<_>>();
        for source in sources {
            let (yes, no) = (tally.get(&format!("{group}|rests on {source}|right")), tally.get(&format!("{group}|rests on {source}|wrong")));
            out.push_str(&format!("    resting on {source:18} right {yes:>7}  wrong {no:>6}  {:>6.2}%\n", yes as f64 * 100.0 / (yes + no).max(1) as f64));
        }
        let mut causes = tally.counts.iter().filter(|(key, _)| key.starts_with(&format!("{group}|cause|"))).map(|(key, count)| (*count, key.rsplit('|').next().unwrap_or("").to_owned())).collect::<Vec<_>>();
        causes.sort_by(|a, b| b.0.cmp(&a.0));
        for (count, cause) in causes {
            out.push_str(&format!("    {count:>7}  {cause}\n"));
        }
    }
    if tally.get("panic|panic|panic") > 0 {
        out.push_str(&format!("\nPANICS: {} records lost with all their pins\n", tally.get("panic|panic|panic")));
    }
    out.push_str("\npass marks, which count only where the head of this report says UNSEEN: right when answering, and right of all\n");
    let mut marks = PASS.iter().map(|(name, answering, all)| ("parser", (*name).to_owned(), *answering, *all)).collect::<Vec<_>>();
    marks.push(("parser", "writing".to_owned(), 99.0, Some(95.0)));
    marks.push(("parser", "headnote".to_owned(), 99.0, None));
    marks.extend(PASS.iter().take(4).map(|(name, answering, all)| ("combined", (*name).to_owned(), *answering, *all)));
    for (reader, name, answering, all) in marks {
        let count = |result: &str| tally.get(&format!("{name}|{reader}|{result}"));
        let (yes, no, none, away) = (count("right"), count("wrong"), count("no answer"), count("quotation not in its text"));
        let (when, overall) = (yes as f64 * 100.0 / (yes + no).max(1) as f64, yes as f64 * 100.0 / (yes + no + none + away).max(1) as f64);
        let passed = when >= answering && all.is_none_or(|mark| overall >= mark);
        out.push_str(&format!("  {reader:8} {name:36} {when:>6.2}% of {:>7}  mark {answering}%   {overall:>6.2}% of {:>7}  mark {}   {}\n", yes + no, yes + no + none + away, all.map_or("report".to_owned(), |mark| format!("{mark}%")), if yes + no < 1000 { "too few pins to judge" } else if passed { "PASS" } else { "FAIL" }));
    }
    out
}

/// A pack line's cluster, read off the raw line: most records have no pins and are never parsed.
fn cluster_in(line: &str) -> Option<&str> {
    const MARK: &str = r#"cluster_id\": \""#;
    let from = line.find(MARK)? + MARK.len();
    line[from..].split('\\').next()
}

pub fn grade(args: &[String]) {
    let packs = flag(args, "--pack").expect("--pack FILE[,FILE]");
    let out = flag(args, "--out").expect("--out DIR");
    let pins_file = flag(args, "--pins").expect("--pins FILE");
    let threads = flag(args, "--threads").and_then(|value| value.parse().ok()).unwrap_or(3);
    let mutation = Arc::new(flag(args, "--mutate"));
    fs::create_dir_all(&out).unwrap();
    // A judging run needs a sample no run has touched; the ledger refuses any other, so that "unseen" is a fact and not a claim.
    let (ledger, sample, judging) = (flag(args, "--ledger"), flag(args, "--sample"), args.iter().any(|arg| arg == "--judge"));
    let status = match (&ledger, &sample) {
        (Some(ledger), Some(sample)) => {
            let spent = fs::read_to_string(ledger).unwrap_or_default().lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).any(|row| row["sample"].as_str() == Some(sample));
            if judging && spent {
                eprintln!("REFUSED: sample {sample} is in the ledger, so it cannot judge. Draw a fresh one.");
                std::process::exit(2);
            }
            format!("sample {sample}: {}", if judging { "UNSEEN, judging" } else if spent { "already used, tuning only" } else { "tuning" })
        }
        _ if judging => {
            eprintln!("REFUSED: --judge needs --ledger and --sample.");
            std::process::exit(2);
        }
        _ => "sample not in the ledger: tuning only, nothing here judges".to_owned(),
    };
    let mut pins = HashMap::<String, Vec<Question>>::new();
    let mut read = 0u64;
    for row in BufReader::new(File::open(&pins_file).unwrap()).lines().filter_map(Result::ok).filter_map(|line| serde_json::from_str::<Value>(&line).ok()) {
        read += 1;
        for (cluster, question) in questions_of(&row) {
            pins.entry(cluster).or_default().push(question);
        }
    }
    eprintln!("{read} pins on {} opinions", pins.len());
    let pins = Arc::new(pins);
    let mut siblings = HashMap::<String, Vec<(String, String)>>::new();
    for file in flag(args, "--siblings").iter().flat_map(|files| files.split(',')) {
        for row in BufReader::new(File::open(file).unwrap()).lines().filter_map(Result::ok).filter_map(|line| serde_json::from_str::<Value>(&line).ok()) {
            let opinions = row["opinions"].as_array().into_iter().flatten().filter_map(|opinion| Some((opinion[0].as_str()?.to_owned(), opinion[1].as_str()?.to_owned()))).collect();
            siblings.insert(row["cluster"].as_str().unwrap_or_default().to_owned(), opinions);
        }
    }
    let siblings = Arc::new(siblings);
    let scans = Arc::new(scans_of(args));
    let pairs = Arc::new(pairs_of(args, &pins.keys().cloned().collect()));
    let only = flag(args, "--only");
    let parser_rival = flag(args, "--rival").as_deref() == Some("parser");
    let clusters = Arc::new(clusters_of(args));
    let citations = Arc::new(citations_of(args));
    let (send, receive) = sync_channel::<String>(threads * 2);
    let receive = Arc::new(Mutex::new(receive));
    let tally = Arc::new(Mutex::new(Tally::default()));
    let failures = Arc::new(Mutex::new(File::create(Path::new(&out).join("failures.jsonl")).unwrap()));
    let answers = Arc::new(Mutex::new(File::create(Path::new(&out).join("answers.jsonl")).unwrap()));
    let done = Arc::new(Mutex::new(0u64));
    let started = Instant::now();
    let workers = (0..threads).map(|_| {
        let (receive, pins, clusters, citations, tally, failures, answers, done, siblings, scans, pairs) = (receive.clone(), pins.clone(), clusters.clone(), citations.clone(), tally.clone(), failures.clone(), answers.clone(), done.clone(), siblings.clone(), scans.clone(), pairs.clone());
        let mutation = mutation.clone();
        let only = only.clone();
        std::thread::Builder::new().stack_size(WORKER_STACK).spawn(move || loop {
            let Ok(line) = receive.lock().unwrap().recv() else { break };
            let Ok(row) = serde_json::from_str::<Value>(&line) else { continue };
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            let files = row["files"].as_object().into_iter().flatten().filter_map(|(name, text)| Some((name.clone(), text.as_str()?.to_owned()))).collect::<Vec<_>>();
            let id_for_rival = id.clone();
            let (mut counted, mut missed, mut answered) = (Tally::default(), Vec::new(), Vec::new());
            let mutation = mutation.as_deref();
            let graded = catch_unwind(AssertUnwindSafe(|| {
                let raw = files.iter().find(|(name, _)| name == "html_with_citations.html").map_or(String::new(), |(_, text)| text.clone());
                let labels = files.iter().filter(|(name, _)| name != "fields.json").flat_map(|(_, text)| tagged_labels(text)).collect::<Vec<_>>();
                let renditions = files.iter().filter(|(name, _)| name != "fields.json").cloned().collect::<Vec<_>>();
                // The rival, our parser on one rendition at a time, with the record's own fields.
                let one_by_one = files.clone();
                let (clusters_here, citations_here) = (clusters.clone(), citations.clone());
                let reparse = parser_rival.then(|| move |name: &str| -> Option<DocumentStructure> {
                    let only = one_by_one.iter().filter(|file| file.0 == "fields.json" || file.0 == name).cloned().collect::<Vec<_>>();
                    let (record, _) = record_of(id_for_rival.clone(), only, &clusters_here, &citations_here);
                    catch_unwind(AssertUnwindSafe(|| opinion_structure(&record, None))).ok()
                });
                // The same parser on the one rendition: what the union itself adds, and no comparison of a parser with a tag reader.
                let files = files.into_iter().filter(|(name, _)| name == "fields.json" || only.as_deref().is_none_or(|only| only == name)).collect::<Vec<_>>();
                let (record, fields) = record_of(id.clone(), files, &clusters, &citations);
                let others = fields["cluster_id"].as_str().and_then(|cluster| siblings.get(cluster)).map_or_else(Vec::new, |opinions| opinions.iter().filter(|opinion| opinion.0 != id).map(|opinion| opinion.1.clone()).collect::<Vec<_>>());
                let Some(questions) = fields["cluster_id"].as_str().and_then(|cluster| pins.get(cluster)) else { return false };
                let table = record.citations.iter().filter_map(|citation| Some((squeezed(&format!("{} {}", citation.volume, citation.reporter)), citation.volume.clone(), citation.page.parse().ok()?))).collect::<Table>();
                let started = Instant::now();
                let mut structure = opinion_structure(&record, None);
                counted.add_by("timing|parse|ms".to_owned(), started.elapsed().as_millis() as u64);
                let started = Instant::now();
                if let Some(name) = mutation.filter(|name| *name != "scan-first+1") {
                    mutate(&mut structure, name);
                }
                // A scan with fewer pages than the case's own marks run over has lost sheets: counted on from its first page, its
                // later pages carry the wrong numbers, so it judges nothing.
                let scan = fields["cluster_id"].as_str().and_then(|cluster| scans.get(cluster));
                let marked_to = scan.and_then(|scan| nodes(&structure, NodeKind::Page).filter(|page| page.series.starts_with("reporter") && in_flow(page))
                    .filter_map(|page| page.label.as_deref().unwrap_or("").parse::<u32>().ok()).filter(|label| *label >= scan.first && *label <= scan.first + 200).max());
                let scan = scan.filter(|scan| marked_to.is_none_or(|last| ((last - scan.first) as usize) < scan.pages.len()));
                if fields["cluster_id"].as_str().and_then(|cluster| scans.get(cluster)).is_some() && scan.is_none() {
                    counted.add("scan|excluded|the scan has fewer pages than the case's marks run over".to_owned());
                }
                grade_record(&structure, &raw, &renditions, &labels, record.opinion_type.as_deref().unwrap_or(""), &others, scan, fields["cluster_id"].as_str().and_then(|cluster| pairs.get(cluster)), reparse.as_ref().map(|reparse| reparse as &dyn Fn(&str) -> Option<DocumentStructure>), rate_of(&fields), questions, &table, &mut counted, &mut missed, &mut answered, &id);
                counted.add_by("timing|score, all told|ms".to_owned(), started.elapsed().as_millis() as u64);
                true
            }));
            match graded {
                Ok(false) => continue,
                Ok(true) => {
                    let mut total = tally.lock().unwrap();
                    for (key, count) in counted.counts {
                        *total.counts.entry(key).or_default() += count;
                    }
                }
                Err(_) => tally.lock().unwrap().add("panic|panic|panic".to_owned()),
            }
            let mut written = failures.lock().unwrap();
            for failure in missed {
                writeln!(written, "{failure}").unwrap();
            }
            drop(written);
            let mut written = answers.lock().unwrap();
            for answer in answered {
                writeln!(written, "{answer}").unwrap();
            }
            drop(written);
            *done.lock().unwrap() += 1;
        }).unwrap()
    }).collect::<Vec<_>>();
    let (mut all, mut all_weight, mut cited, mut cited_weight) = (0u64, 0.0, 0u64, 0.0);
    static RATE: OnceLock<Regex> = OnceLock::new();
    let rate_in = RATE.get_or_init(|| Regex::new(r#"_rate\\":\s*([0-9.eE-]+)"#).unwrap());
    let reading = Instant::now();
    for pack in packs.split(',') {
        for line in BufReader::new(File::open(pack).unwrap()).lines().filter_map(Result::ok) {
            let tail = (line.len().saturating_sub(600)..line.len()).find(|at| line.is_char_boundary(*at)).unwrap_or(line.len());
            let weight = rate_in.captures(&line[tail..]).and_then(|capture| capture[1].parse::<f64>().ok()).filter(|rate| *rate > 0.0).map_or(1.0, |rate| 1.0 / rate);
            all += 1;
            all_weight += weight;
            if cluster_in(&line).is_some_and(|cluster| pins.contains_key(cluster)) {
                cited += 1;
                cited_weight += weight;
                send.send(line).unwrap();
            }
        }
    }
    drop(send);
    for worker in workers {
        worker.join().unwrap();
    }
    let mut tally = tally.lock().unwrap();
    tally.add_by("timing|whole run|ms".to_owned(), reading.elapsed().as_millis() as u64);
    let mut text = format!("{status}\ncoverage: {cited} of {all} packed opinions have a quoted pin ({:.2}% of the corpus weight); the scores speak for those\n", cited_weight * 100.0 / f64::max(all_weight, 1.0));
    text.push_str(&report(&tally, *done.lock().unwrap(), started.elapsed().as_secs_f64()));
    text.push_str(&format!("\ntime, summed over threads: parse {} s, scoring all told {} s, of which the best single field {} s; wall {} s\n", tally.get("timing|parse|ms") / 1000, tally.get("timing|score, all told|ms") / 1000, tally.get("timing|best one field|ms") / 1000, tally.get("timing|whole run|ms") / 1000));
    if let (Some(ledger), Some(sample)) = (&ledger, &sample) {
        let mut record = fs::OpenOptions::new().create(true).append(true).open(ledger).unwrap();
        writeln!(record, "{}", json!({ "sample": sample, "use": if judging { "judge" } else { "tuning" }, "out": out })).unwrap();
    }
    fs::write(Path::new(&out).join("grade.txt"), &text).unwrap();
    fs::write(Path::new(&out).join("grade.json"), serde_json::to_string_pretty(&tally.counts).unwrap()).unwrap();
    println!("{text}");
}

/// Lawbox's body headings from its tags alone: an h2 to h6 past the caption, its mark and its note lists aside.
fn tagged_headings(lawbox: &str) -> Vec<String> {
    static HEADING: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    let heading = HEADING.get_or_init(|| Regex::new(r"(?is)<h([2-6])\b[^>]*>(.{2,400}?)</h[2-6]>").unwrap());
    let tag = TAG.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    heading.captures_iter(lawbox).filter_map(|capture| {
        let words = decoded(&tag.replace_all(&capture[2], " "));
        let words = words.split_whitespace().filter(|word| !word.starts_with('*')).collect::<Vec<_>>().join(" ");
        let plain = squeezed(&words);
        (plain.chars().count() >= 2 && !matches!(plain.as_str(), "notes" | "footnotes" | "note" | "opinion")).then_some(plain)
    }).collect()
}

/// The field's headings as a generous reader takes them: every block of up to twelve words that does not end a sentence.
fn field_headings(raw: &str) -> Vec<String> {
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    let block = BLOCK.get_or_init(|| Regex::new(r"(?is)<(?:p|h[1-6]|center|div)\b[^>]*>(.{2,300}?)</(?:p|h[1-6]|center|div)>").unwrap());
    let tag = TAG.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    block.captures_iter(raw).filter_map(|capture| {
        let words = decoded(&tag.replace_all(&capture[1], " "));
        let trimmed = words.trim();
        (trimmed.split_whitespace().count() <= 12 && !trimmed.ends_with([',', ';']) && (!trimmed.ends_with('.') || trimmed.split_whitespace().count() <= 6)).then(|| squeezed(trimmed))
    }).filter(|plain| plain.len() >= 2).collect()
}

/// Harvard's notes and paragraphs, read by the grader's one tag reader: label and text of each note, text of each block outside them.
fn tagged_notes(harvard: &str) -> Vec<(String, String)> {
    let field = field_of(harvard);
    let units = field.text.encode_utf16().collect::<Vec<_>>();
    field.notes.iter().map(|note| (note.2.clone(), squeezed(&String::from_utf16_lossy(&units[note.0.min(units.len())..note.1.min(units.len())])))).collect()
}

fn tagged_paragraphs(harvard: &str) -> Vec<String> {
    let field = field_of(harvard);
    let units = field.text.encode_utf16().collect::<Vec<_>>();
    field.blocks.iter().filter(|block| !field.notes.iter().any(|note| note.0 <= block.0 && block.0 < note.1))
        .map(|block| squeezed(&String::from_utf16_lossy(&units[block.0.min(units.len())..block.1.min(units.len())])))
        .filter(|text| text.chars().count() >= HOLD_OPENING).collect()
}

/// The first letters of a block, enough to know it by; a page mark's or a number's few letters ahead of it may differ.
const HOLD_OPENING: usize = 40;
const HOLD_SKIP: usize = 8;

fn opening(text: &str) -> String {
    text.chars().skip(HOLD_SKIP).take(HOLD_OPENING - HOLD_SKIP).collect()
}

/// The words stand in Harvard's own body too: the opinion repeats them, and no leak is shown.
fn harvard_body_has(harvard: &str, key: &str) -> bool {
    tagged_paragraphs(harvard).iter().any(|text| text.contains(key))
}

/// Footnotes and paragraphs with Harvard hidden: does the rest give back each one, and keep the note out of the body?
fn structure_holdout(structure: &DocumentStructure, harvard: &str, lawbox: &str, counted: &mut Tally, missed: &mut Vec<Value>, id: &str) {
    let units = structure.text.encode_utf16().collect::<Vec<_>>();
    let slice = |from: usize, to: usize| squeezed(&String::from_utf16_lossy(&units[from.min(units.len())..to.min(units.len())]));
    let plain = squeezed(&structure.text);
    let notes = nodes(structure, NodeKind::Footnote).map(|note| (note.label.as_deref().unwrap_or("").trim_matches(['[', ']', '(', ')', '.', ':', ' ']).to_owned(), note.ranges.iter().map(|range| slice(range.start, range.end)).collect::<String>())).collect::<Vec<_>>();
    let paragraphs = paragraphs(structure).map(|paragraph| slice(paragraph.range.start, paragraph.range.end)).collect::<Vec<_>>();
    let body = paragraphs.concat();
    let lawbox_field = any_rendition(lawbox);
    let lawbox_notes = lawbox_field.notes.iter().map(|note| squeezed(&String::from_utf16_lossy(&lawbox_field.text.encode_utf16().skip(note.0).take(note.1 - note.0).collect::<Vec<_>>()))).collect::<Vec<_>>();
    // The key against a plain count of Harvard's note tags: a key that misses a whole form shows here, not in a score.
    let keyed = tagged_notes(harvard);
    let raw = harvard.matches("<footnote").count() + harvard.matches("class=\"footnote\" id=\"fn").count();
    counted.add(format!("key check|notes|{}", if keyed.len() == raw { "key matches the raw count" } else if keyed.len() < raw { "key holds fewer" } else { "key holds more" }));
    counted.add_by("key check|notes keyed|".to_owned(), keyed.len() as u64);
    counted.add_by("key check|note tags raw|".to_owned(), raw as u64);
    for (label, text) in keyed {
        let key = opening(&text);
        if key.chars().count() < HOLD_OPENING - HOLD_SKIP || !plain.contains(&key) {
            counted.add("note|excluded|its words are not in the other versions".to_owned());
            continue;
        }
        let found = notes.iter().find(|note| note.1.contains(&key));
        counted.add(format!("note|parser|{}", if found.is_some() { "found" } else { "lost" }));
        counted.add(format!("note|field|{}", if lawbox_notes.iter().any(|note| note.contains(&key)) { "found" } else { "lost" }));
        if let Some(note) = found {
            counted.add(format!("note label|parser|{}", if note.0 == label.trim_matches(['*', ' ']) { "right" } else { "wrong" }));
        }
        if body.contains(&key) {
            counted.add("note in the body|parser|left in the text".to_owned());
            let inside = paragraphs.iter().position(|text| text.contains(&key)).unwrap_or(0);
            let quoted = harvard_body_has(harvard, &key);
            missed.push(json!({ "id": id, "kind": "leak", "label": label, "words": key, "paragraph": inside, "of": paragraphs.len(), "also_in_harvard_body": quoted, "rendition": reading(structure).rendition, "text": paragraphs.get(inside).map(|text| text.chars().take(160).collect::<String>()) }));
        } else {
            counted.add("note in the body|parser|kept out".to_owned());
        }
        if found.is_none() {
            missed.push(json!({ "id": id, "kind": "note", "label": label, "words": key }));
        }
    }
    let wanted = tagged_paragraphs(harvard);
    let starts = paragraphs.iter().map(|text| text.chars().take(HOLD_OPENING + HOLD_SKIP).collect::<String>()).collect::<Vec<_>>();
    for text in &wanted {
        let key = opening(text);
        if !plain.contains(&key) {
            counted.add("paragraph|excluded|its words are not in the other versions".to_owned());
            continue;
        }
        let found = starts.iter().any(|start| start.contains(&key));
        counted.add(format!("paragraph|parser|{}", if found { "found" } else { "lost" }));
        if !found {
            missed.push(json!({ "id": id, "kind": "paragraph", "words": key }));
        }
    }
    let keys = wanted.iter().map(|text| opening(text)).collect::<std::collections::HashSet<_>>();
    for start in starts.iter().filter(|start| start.chars().count() >= HOLD_OPENING) {
        let at_harvard = keys.iter().any(|key| start.contains(key.as_str()));
        counted.add(format!("paragraph opens|parser|{}", if at_harvard { "where Harvard's does" } else { "where it does not" }));
    }
}

/// Hide a version, read the rest, score against what was hidden: `holdout --pack FILE[,FILE] --out DIR [--clusters F] [--citations F] [--threads N]`.
/// Only records Harvard also holds count, html_with_citations then being Harvard's and no copy of Lawbox.
pub fn holdout(args: &[String]) {
    let out = flag(args, "--out").expect("--out");
    let packs = flag(args, "--pack").expect("--pack");
    let threads = flag(args, "--threads").and_then(|count| count.parse().ok()).unwrap_or(8);
    let planted = flag(args, "--mutate");
    fs::create_dir_all(&out).unwrap();
    let (clusters, citations) = (Arc::new(clusters_of(args)), Arc::new(citations_of(args)));
    let (send, receive) = sync_channel::<String>(threads * 2);
    let receive = Arc::new(Mutex::new(receive));
    let tally = Arc::new(Mutex::new(Tally::default()));
    let failures = Arc::new(Mutex::new(File::create(Path::new(&out).join("holdout-misses.jsonl")).unwrap()));
    let workers = (0..threads).map(|_| {
        let (receive, clusters, citations, tally, failures, planted) = (receive.clone(), clusters.clone(), citations.clone(), tally.clone(), failures.clone(), planted.clone());
        std::thread::Builder::new().stack_size(WORKER_STACK).spawn(move || loop {
            let Ok(line) = receive.lock().unwrap().recv() else { break };
            let Ok(row) = serde_json::from_str::<Value>(&line) else { continue };
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            let files = row["files"].as_object().into_iter().flatten().filter_map(|(name, text)| Some((name.clone(), text.as_str()?.to_owned()))).collect::<Vec<_>>();
            let of = |name: &str| files.iter().find(|file| file.0 == name).map(|file| file.1.clone());
            let (Some(lawbox), Some(raw), true) = (of("html_lawbox.html"), of("html_with_citations.html"), of("xml_harvard.xml").is_some()) else { continue };
            let key = tagged_headings(&lawbox);
            if key.is_empty() {
                continue;
            }
            let rest = files.iter().filter(|file| file.0 != "html_lawbox.html").cloned().collect::<Vec<_>>();
            let graded = catch_unwind(AssertUnwindSafe(|| {
                let (record, _) = record_of(id.clone(), rest, &clusters, &citations);
                let structure = opinion_structure(&record, None);
                let plain_text = squeezed(&structure.text);
                let ours = nodes(&structure, NodeKind::Heading).map(|heading| squeezed(&heading.display_value.as_deref().unwrap_or(""))).collect::<Vec<_>>();
                let theirs = field_headings(&raw);
                let held = |reader: &[String], heading: &str| reader.iter().any(|known| known == heading || (known.len() >= 6 && heading.contains(known.as_str())) || (heading.len() >= 6 && known.contains(heading)));
                let mut counted = Tally::default();
                let mut missed = Vec::new();
                for heading in &key {
                    if !plain_text.contains(heading.as_str()) {
                        counted.add("recall|excluded|the words are not in the other versions".to_owned());
                        continue;
                    }
                    let (mine, field) = (held(&ours, heading), held(&theirs, heading));
                    counted.add(format!("recall|parser|{}", if mine { "found" } else { "lost" }));
                    counted.add(format!("recall|field|{}", if field { "found" } else { "lost" }));
                    if !mine {
                        missed.push(json!({ "id": id, "lost": heading, "field": field }));
                    }
                }
                for (known, heading) in ours.iter().zip(nodes(&structure, NodeKind::Heading)).filter(|(known, _)| known.len() >= 2) {
                    let in_tags = held(&key, known);
                    counted.add(format!("precision|parser|{}", if in_tags { "in Lawbox's tags" } else { "not in them" }));
                    if !in_tags {
                        let units = structure.text.encode_utf16().collect::<Vec<_>>();
                        let around = |from: usize, to: usize| String::from_utf16_lossy(&units[from.min(units.len())..to.min(units.len())]);
                        missed.push(json!({ "id": id, "extra": heading.display_value.as_deref().unwrap_or(""), "source": heading.grammar.as_deref().unwrap_or(""), "before": around(heading.range.start.saturating_sub(220), heading.range.start), "after": around(heading.range.end, heading.range.end + 220) }));
                    }
                }
                for known in &theirs {
                    counted.add(format!("precision|field|{}", if held(&key, known) { "in Lawbox's tags" } else { "not in them" }));
                }
                counted.add("records|records|".to_owned());
                // Now Harvard hidden, whose html_with_citations goes with it.
                let harvard = of("xml_harvard.xml").unwrap_or_default();
                let without = files.iter().filter(|file| !matches!(file.0.as_str(), "xml_harvard.xml" | "html_with_citations.html")).cloned().collect::<Vec<_>>();
                let (record, _) = record_of(id.clone(), without, &clusters, &citations);
                let mut structure = opinion_structure(&record, None);
                // Planted faults: each must lower its own score, or the key does not see what it claims to.
                if let Some(name) = &planted {
                    mutate(&mut structure, name);
                }
                structure_holdout(&structure, &harvard, &lawbox, &mut counted, &mut missed, &id);
                (counted, missed)
            }));
            match graded {
                Ok((counted, missed)) => {
                    let mut total = tally.lock().unwrap();
                    for (key, count) in counted.counts {
                        total.add_by(key, count);
                    }
                    drop(total);
                    let mut written = failures.lock().unwrap();
                    for miss in missed {
                        writeln!(written, "{miss}").unwrap();
                    }
                }
                Err(_) => tally.lock().unwrap().add("panic|panic|panic".to_owned()),
            }
        }).unwrap()
    }).collect::<Vec<_>>();
    for pack in packs.split(',') {
        for line in BufReader::new(File::open(pack).unwrap()).lines().filter_map(Result::ok) {
            send.send(line).unwrap();
        }
    }
    drop(send);
    for worker in workers {
        worker.join().unwrap();
    }
    let tally = tally.lock().unwrap();
    let share = |item: &str, reader: &str, yes: &str, no: &str| {
        let (hit, miss) = (tally.get(&format!("{item}|{reader}|{yes}")), tally.get(&format!("{item}|{reader}|{no}")));
        format!("{item} {reader}: {:.2}% of {}\n", hit as f64 * 100.0 / (hit + miss).max(1) as f64, hit + miss)
    };
    let mut text = format!("{} records\n", tally.get("records|records|"));
    for reader in ["parser", "field"] {
        text.push_str(&share("recall", reader, "found", "lost"));
        text.push_str(&share("precision", reader, "in Lawbox's tags", "not in them"));
    }
    text.push_str("\nHarvard hidden, every footnote and paragraph its tags hold:\n");
    text.push_str(&share("note", "parser", "found", "lost"));
    text.push_str(&share("note", "field", "found", "lost"));
    text.push_str(&share("note label", "parser", "right", "wrong"));
    text.push_str(&share("note in the body", "parser", "kept out", "left in the text"));
    text.push_str(&share("paragraph", "parser", "found", "lost"));
    text.push_str(&share("paragraph opens", "parser", "where Harvard's does", "where it does not"));
    text.push_str(&format!("key check: {} notes keyed against {} note tags counted raw; records where they differ: {} fewer, {} more\n", tally.get("key check|notes keyed|"), tally.get("key check|note tags raw|"), tally.get("key check|notes|key holds fewer"), tally.get("key check|notes|key holds more")));
    text.push_str(&format!("notes excluded {}, paragraphs excluded {}\n", tally.get("note|excluded|its words are not in the other versions"), tally.get("paragraph|excluded|its words are not in the other versions")));
    text.push_str(&format!("excluded, the words not in the other versions: {}\npanics {}\n", tally.get("recall|excluded|the words are not in the other versions"), tally.get("panic|panic|panic")));
    fs::write(Path::new(&out).join("holdout.txt"), &text).unwrap();
    println!("{text}");
}

/// Footnote type, a page's number, a bold line: what a PDF prints and bulk text loses, scored against the parser.
fn pdf_score(structure: &DocumentStructure, pages: &[Value], counted: &mut Tally, missed: &mut Vec<Value>, id: &str) {
    const SMALLER: f64 = 0.9;
    const LEAST: usize = 24;
    let finder = Finder::new(&structure.text);
    let in_range = |place: usize, ranges: &[(usize, usize)]| ranges.iter().any(|range| range.0 <= place && place < range.1);
    let notes = nodes(structure, NodeKind::Footnote).flat_map(|note| note.ranges.iter().map(|range| (range.start, range.end))).collect::<Vec<_>>();
    let squeezed_headings = nodes(structure, NodeKind::Heading).map(|heading| squeezed(&heading.display_value.as_deref().unwrap_or(""))).collect::<Vec<_>>();
    let paragraphs = paragraphs(structure).map(|paragraph| (paragraph.range.start, paragraph.range.end)).collect::<Vec<_>>();
    let mut series = HashMap::<&str, usize>::new();
    // The PDF prints the document's own numbers: a reporter's or a vendor's numbering held beside them is another count.
    let own = |name: &str| matches!(name, "slip" | "ecf" | "sheet" | "original" | "leaf") || name.starts_with("slip-");
    for page in nodes(structure, NodeKind::Page).filter(|page| !page.properties.contains_key("in_note") && own(&page.series)) {
        *series.entry(page.series.as_str()).or_default() += 1;
    }
    let main = series.iter().max_by_key(|entry| *entry.1).map(|entry| entry.0.to_owned());
    let mut marks = nodes(structure, NodeKind::Page).filter(|page| !page.properties.contains_key("in_note") && main.as_deref() == Some(page.series.as_str()) && page.grammar.as_deref() != Some("stray")).map(|page| (page.range.start, page.label.as_deref().unwrap_or("").to_owned())).collect::<Vec<_>>();
    marks.sort();
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    let number = NUMBER.get_or_init(|| Regex::new(r"^\s*(?:-\s*)?(?:Page\s+)?(\d{1,3})(?:\s*-)?(?:\s+of\s+\d+)?\s*$").unwrap());
    for page in pages {
        let body = page["body"].as_f64().unwrap_or(0.0);
        let lines = page["lines"].as_array().map_or(&[][..], Vec::as_slice);
        let text = |line: &Value| line[0].as_str().unwrap_or_default().to_owned();
        let edge = [lines.first(), lines.last()].into_iter().flatten().find_map(|line| number.captures(&text(line)).map(|capture| capture[1].to_owned()));
        // The page: where its first full line of words falls in the parser's pages.
        if let Some(printed) = edge {
            let sample = lines.iter().skip(1).map(text).find(|line| words_of(line).0.len() >= 8);
            if let Some(found) = sample.and_then(|line| finder.find(&words_of(&line).0)) {
                let said = last_before(&marks, found.start);
                let result = match said { None => "no answer", Some(label) if label == printed => "right", Some(_) => "wrong" };
                counted.add(format!("page|parser|{result}"));
                if result != "right" {
                    let held = marks.iter().take(6).map(|mark| mark.1.clone()).collect::<Vec<_>>();
                    missed.push(json!({ "id": id, "kind": "page", "result": result, "printed": printed, "said": said, "series": main, "marks": marks.len(), "first_marks": held, "at": found.start, "length": structure.text.encode_utf16().count(), "rendition": reading(structure).rendition }));
                }
            } else {
                counted.add("page|excluded|line not found in the text".to_owned());
            }
        }
        for line in lines {
            let words = text(line);
            let size = line[1].as_f64().unwrap_or(0.0);
            let bold = line[2].as_bool().unwrap_or(false);
            // A footnote's line, small type well clear of the body's size.
            if body > 0.0 && size > 0.0 && size < body - SMALLER && squeezed(&words).chars().count() >= LEAST {
                match finder.find(&words_of(&words).0) {
                    Some(found) if !found.twice => {
                        let (note, body_text) = (in_range(found.start, &notes), in_range(found.start, &paragraphs));
                        counted.add(format!("note line|parser|{}", if note && !body_text { "in a note" } else if body_text { "in the body" } else { "in neither" }));
                        if !note || body_text {
                            missed.push(json!({ "id": id, "kind": "note line", "words": words, "body": body_text }));
                        }
                    }
                    _ => counted.add("note line|excluded|not found once in the text".to_owned()),
                }
            }
            // A heading's line: short, bold, ending no sentence.
            let plain = squeezed(&words);
            if bold && (6..=120).contains(&plain.chars().count()) && !words.trim_end().ends_with([',', ';', '.']) && words.chars().any(char::is_alphabetic) && !number.is_match(&words) {
                if finder.find(&words_of(&words).0).is_some() || structure.text.contains(words.trim()) {
                    let held = squeezed_headings.iter().any(|heading| heading.contains(&plain) || (heading.len() >= 6 && plain.contains(heading.as_str())));
                    counted.add(format!("bold line|parser|{}", if held { "a heading" } else { "not a heading" }));
                    if !held {
                        missed.push(json!({ "id": id, "kind": "bold line", "words": words }));
                    }
                }
            }
        }
    }
}

/// The court's PDF against what the parser reads from bulk text: `pdfkey --pack FILE --sheet FILE --out DIR [--clusters F] [--citations F]`.
pub fn pdfkey(args: &[String]) {
    let out = flag(args, "--out").expect("--out");
    let packs = flag(args, "--pack").expect("--pack");
    fs::create_dir_all(&out).unwrap();
    let (clusters, citations) = (clusters_of(args), citations_of(args));
    let mut sheet = HashMap::<String, Vec<Value>>::new();
    for row in BufReader::new(File::open(flag(args, "--sheet").expect("--sheet")).unwrap()).lines().filter_map(Result::ok).filter_map(|line| serde_json::from_str::<Value>(&line).ok()) {
        sheet.insert(row["id"].as_str().unwrap_or_default().to_owned(), row["pages"].as_array().cloned().unwrap_or_default());
    }
    let (mut tally, mut missed) = (Tally::default(), Vec::new());
    for pack in packs.split(',') {
        for line in BufReader::new(File::open(pack).unwrap()).lines().filter_map(Result::ok) {
            let head = line.get(..40).unwrap_or(&line);
            let opened = head.split('"').nth(3).unwrap_or_default();
            if !sheet.contains_key(opened) {
                continue;
            }
            let Ok(row) = serde_json::from_str::<Value>(&line) else { continue };
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            let Some(pages) = sheet.get(&id) else { continue };
            let files = row["files"].as_object().into_iter().flatten().filter_map(|(name, text)| Some((name.clone(), text.as_str()?.to_owned()))).collect::<Vec<_>>();
            let graded = catch_unwind(AssertUnwindSafe(|| {
                let (record, _) = record_of(id.clone(), files, &clusters, &citations);
                let structure = opinion_structure(&record, None);
                pdf_score(&structure, pages, &mut tally, &mut missed, &id);
                tally.add(format!("records|{}|", reading(&structure).rendition));
            }));
            if graded.is_err() {
                tally.add("panic|panic|panic".to_owned());
            }
        }
    }
    let mut text = String::new();
    for (key, count) in &tally.counts {
        text.push_str(&format!("{count:>8}  {key}\n"));
    }
    fs::write(Path::new(&out).join("pdfkey.txt"), &text).unwrap();
    let mut written = File::create(Path::new(&out).join("pdfkey-misses.jsonl")).unwrap();
    for miss in missed {
        writeln!(written, "{miss}").unwrap();
    }
    println!("{text}");
}
