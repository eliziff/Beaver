//! The gold's paragraph answer key: the last place it is worked out, by `freeze` over the store and by the A2AJ aligner
//! (`a2aj_gold`) for each gold it makes or repairs; after it the gold says, and the grader compares. A gold's `paragraphs`
//! reads
//!
//!   {"count": N, "printings": {"1": [[line ids of a printing], ...], ...}, "speaks_for": [line ids]}
//!
//! `count` is null, with no printings, where the judgment numbers no paragraphs. `printings` holds the numbers 1 to
//! `count`; a number it does not hold is printed nowhere. `speaks_for` lists the lines the key answers for: every line
//! with a letter that the gold does not type a line_label, an a2aj-align gold's typed lines only. A gold that holds
//! `speaks_for` already keeps its key: the aligner writes its own.
//!
//!   pinpoint-corpus freeze [--sha PREFIX] [--rows OLD/rows.jsonl]    report what the freeze would change, writing nothing
//!   pinpoint-corpus freeze --write [--sha PREFIX]                    write it

use crate::gold_store::{gold_lines, gold_sources, items, list_item, rows_of, GoldLine, GoldSource};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::de::IgnoredAny;
use serde_json::{json, Deserializer, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

// -- the walk's states ----------------------------------------------------------------------------------------------

/// A column's last printing, and how many of its lines are its own words: what ends the reasons takes it back to them.
#[derive(Clone, Copy)]
struct Tail {
    printing: usize,
    own: usize,
}

/// Where a column's walk over the gold stands.
#[derive(Clone, Copy)]
enum Walk {
    /// No count runs: nothing has opened yet, or a new decision has begun. The last decision's tail stays until a printing
    /// replaces it.
    Uncounted { tail: Option<Tail> },
    /// A count runs and no paragraph is open: a heading or the reasons' end closed the last.
    Between { counted: usize, tail: Tail },
    /// A paragraph is open: what follows in its column is its own.
    Within { counted: usize, tail: Tail },
}

impl Default for Walk {
    fn default() -> Self {
        Walk::Uncounted { tail: None }
    }
}

impl Walk {
    fn counted(self) -> Option<usize> {
        match self {
            Walk::Uncounted { .. } => None,
            Walk::Between { counted, .. } | Walk::Within { counted, .. } => Some(counted),
        }
    }

    fn tail(self) -> Option<Tail> {
        match self {
            Walk::Uncounted { tail } => tail,
            Walk::Between { tail, .. } | Walk::Within { tail, .. } => Some(tail),
        }
    }

    fn open(self) -> Option<Tail> {
        match self {
            Walk::Within { tail, .. } => Some(tail),
            _ => None,
        }
    }

    /// A number opens a paragraph, in any state.
    fn opened(&mut self, counted: usize, printing: usize, own: usize) {
        *self = Walk::Within { counted, tail: Tail { printing, own } };
    }

    /// A heading or the reasons' end closes the open paragraph; the count goes on.
    fn closed(&mut self) {
        if let Walk::Within { counted, tail } = *self {
            *self = Walk::Between { counted, tail };
        }
    }

    /// A new decision begins: its count starts over.
    fn began(&mut self) {
        *self = Walk::Uncounted { tail: self.tail() };
    }

    /// The open paragraph's own words now reach its `own`th line.
    fn reached(&mut self, own: usize) {
        if let Walk::Within { tail, .. } = self {
            tail.own = own;
        }
    }
}

/// What a printing's next lines are.
#[derive(Clone, Copy, PartialEq)]
enum Goes {
    /// Its own words.
    Own,
    /// The list it introduced: the list's next item, however typed, is its.
    OnList,
}

struct Printing<'a> {
    lines: Vec<&'a str>,
    goes: Goes,
}

/// A margin number the gold typed as a page's label, waiting for its column's next text on its row.
#[derive(Clone, Copy)]
struct Margin {
    number: usize,
    page: u64,
    top: f64,
}

/// The printings so far, by number, and each column's walk.
#[derive(Default)]
struct Book<'a> {
    printings: Vec<Printing<'a>>,
    numbers: BTreeMap<usize, Vec<usize>>,
    walks: [Walk; 2],
}

impl<'a> Book<'a> {
    fn walk(&self, column: bool) -> Walk {
        self.walks[column as usize]
    }

    fn open(&self, column: bool) -> Option<&Printing<'a>> {
        self.walk(column).open().map(|tail| &self.printings[tail.printing])
    }

    fn next(&self, column: bool) -> usize {
        self.walk(column).counted().unwrap_or(0) + 1
    }

    /// `number` opens a printing of `lines`, the first `own` of them its own words.
    fn opened(&mut self, column: bool, number: usize, lines: Vec<&'a str>, own: usize) {
        self.numbers.entry(number).or_default().push(self.printings.len());
        self.walks[column as usize].opened(number, self.printings.len(), own);
        self.printings.push(Printing { lines, goes: Goes::Own });
    }

    /// Lines the open paragraph takes, past where its own words end.
    fn extended(&mut self, column: bool, lines: impl IntoIterator<Item = &'a str>) {
        if let Some(tail) = self.walk(column).open() {
            self.printings[tail.printing].lines.extend(lines);
        }
    }

    /// Lines the open paragraph takes as its own words.
    fn worded(&mut self, column: bool, lines: impl IntoIterator<Item = &'a str>) {
        self.extended(column, lines);
        if let Some(tail) = self.walk(column).open() {
            self.walks[column as usize].reached(self.printings[tail.printing].lines.len());
        }
    }

    /// The open paragraph goes on with the list it introduced.
    fn listing(&mut self, column: bool) {
        if let Some(tail) = self.walk(column).open() {
            self.printings[tail.printing].goes = Goes::OnList;
        }
    }

    fn closed(&mut self, column: bool) {
        self.walks[column as usize].closed();
    }

    /// The words of the open paragraph's last line.
    fn last_words(&self, column: bool, by_id: &HashMap<&str, &GoldLine>) -> String {
        self.open(column).and_then(|open| open.lines.last()).map_or_else(String::new, |id| by_id[*id].text.iter().collect())
    }

    /// Whether the open paragraph goes on with a list, or its last line opens one with a colon.
    fn under_list(&self, column: bool, by_id: &HashMap<&str, &GoldLine>) -> bool {
        self.open(column).is_some_and(|open| open.goes == Goes::OnList || open.lines.last().is_some_and(|id| by_id[*id].text.iter().rev().find(|c| !c.is_whitespace()) == Some(&':')))
    }

    /// The matter after the reasons: the open paragraph leaves what its own words did not reach, and closes.
    fn reasons_ended(&mut self, column: bool) {
        if let Some(tail) = self.walk(column).open() {
            self.printings[tail.printing].lines.truncate(tail.own);
        }
        self.closed(column);
    }

    fn document_began(&mut self) {
        self.walks.iter_mut().for_each(Walk::began);
    }

    /// The walk's end: each column's last printing runs to its own words.
    fn finished(&mut self) {
        for tail in self.walks.iter().filter_map(|walk| walk.tail()) {
            self.printings[tail.printing].lines.truncate(tail.own);
        }
    }
}

// -- the derivation -------------------------------------------------------------------------------------------------

/// What a typed line's marker prints: its text, trimmed.
fn printed_marker(mark: &Value, lines: &HashMap<&str, &GoldLine>) -> Option<String> {
    let span = if mark.is_array() { &mark[0] } else { mark };
    let line = lines.get(span["line_id"].as_str()?)?;
    let (start, end) = (span["start"].as_u64()? as usize, span["end"].as_u64()? as usize);
    let text: String = line.text.get(start.min(line.text.len())..end.min(line.text.len()))?.iter().collect();
    Some(text.trim().to_owned())
}

/// A marker's number and its style ("[12]", "(12)", "12.", "12"), where it prints one.
fn marker_number(raw: &str) -> Option<(usize, char)> {
    let text = raw.trim_matches(['[', ']', '.', '(', ')', ' ']);
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    // A text layer may lose half a bracket ("8]").
    let style = if raw.starts_with('[') || raw.ends_with(']') { '[' } else if raw.starts_with('(') { '(' } else if raw.ends_with('.') { '.' } else { ' ' };
    Some((text.parse().ok()?, style))
}

/// The number `next` where a text layer garbled it at a line's opening: "[39}", "(1 O]", "[ 15]", or its bracket read
/// as a figure ("135]" for "[35]", "{431" for "[43]").
fn misread_number(text: &str, next: usize) -> bool {
    let opening = text.trim_start();
    let opened = opening.starts_with(['[', '(', '{']);
    let mut digits = String::new();
    let mut closed = false;
    for c in opening.chars().skip_while(|c| "[({ ".contains(*c)).take(7) {
        match c {
            '0'..='9' => digits.push(c),
            'O' | 'o' => digits.push('0'),
            'I' | 'l' | '|' | '!' => digits.push('1'),
            ' ' => {}
            ']' | ')' | '}' => {
                closed = true;
                break;
            }
            _ => break,
        }
    }
    let wanted = next.to_string();
    // (A lost bracket may read as a figure: "31 The first issue" for "[3]".)
    if next < 10 && digits == format!("{wanted}1") && opening.as_bytes().get(digits.len()) == Some(&b' ') {
        return true;
    }
    let clean = opening.starts_with('(') && opening.split_whitespace().next().is_some_and(|word| word.ends_with(')'));
    let one_off = digits.len() == wanted.len() && wanted.len() > 1 && digits.bytes().zip(wanted.bytes()).filter(|(a, b)| a != b).count() == 1;
    // (The very number a count wants, past its first few, whatever marks it kept: "11 Le preambule", "(33) Order accordingly".)
    digits == wanted && next >= 10 || !clean && (opened || closed) && (digits == wanted || one_off && opened && closed || digits.get(1..) == Some(wanted.as_str()) && closed
        || opened && digits.len() > 1 && digits[..digits.len() - 1] == wanted)
}

/// The numbers the gold's own markers print on its text: a judgment that numbers its paragraphs prints three or more,
/// four fifths of 1 to its last. The count runs to the highest number it reaches with four fifths printed, so a stray
/// large number (a statute's section) does not stand for it. None where the judgment numbers no paragraphs.
/// A gold that types its numbered paragraphs as items counts them too, where its text numbers none: but a list
/// numbers the reasons only where it runs through them, as a count does (on a document of four pages or more,
/// over three tenths of its pages, no two numbers pages apart); a list of a page or two in unnumbered reasons is a list.
fn gold_count(gold: &Value, lines: &HashMap<&str, &GoldLine>, parallel: bool) -> Option<usize> {
    let numbers = |region: &str| {
        let mut printed = BTreeMap::<usize, u64>::new();
        for typed in items(&gold["typed"]).iter().filter(|typed| typed["region"] == region) {
            for mark in items(&typed["markers"]) {
                let span = if mark.is_array() { &mark[0] } else { mark };
                let page = span["line_id"].as_str().and_then(|id| lines.get(id)).map_or(0, |line| line.page);
                if let Some((number, _)) = printed_marker(mark, lines).and_then(|raw| marker_number(&raw)) {
                    if number < 1000 {
                        printed.entry(number).or_insert(page);
                    }
                }
            }
        }
        printed
    };
    let reach = |printed: &BTreeMap<usize, u64>| {
        let reach = printed.keys().copied().filter(|&n| printed.range(..=n).count() * 5 >= n * 4).max()?;
        (printed.range(..=reach).count() >= 3).then_some(reach)
    };
    let (text, listed) = (numbers("text"), numbers("list_item"));
    if reach(&text).is_some() {
        let mut printed = text;
        for (number, page) in listed {
            printed.entry(number).or_insert(page);
        }
        // (A few numbers in a stretch of it are a list its reasons quote or set out: the relief sought, the issues.)
        let count = reach(&printed)?;
        let (first, last) = (printed.values().min().copied().unwrap_or(0), printed.values().max().copied().unwrap_or(0));
        let pages = lines.values().map(|line| line.page).max().unwrap_or(0);
        // (Nor does a count start over: lists of a few, each from 1, are lists. A parallel report prints its 1 in each column.)
        let columns = if parallel { 3 } else { 2 };
        let ones = items(&gold["typed"]).iter().filter(|typed| items(&typed["markers"]).iter().any(|mark| printed_marker(mark, lines).and_then(|raw| marker_number(&raw)).is_some_and(|(number, _)| number == 1))).count();
        return (count >= 10 || (last - first + 1) * 10 >= pages * 3 && ones < columns).then_some(count);
    }
    let count = reach(&listed)?;
    let pages = lines.values().map(|line| line.page).max().unwrap_or(0) + 1;
    let held: Vec<u64> = listed.range(..=count).map(|(_, page)| *page).collect();
    let spanned = held.iter().max().unwrap_or(&0) - held.iter().min().unwrap_or(&0) + 1;
    // And a count goes on: numbers pages apart are separate lists stitched by their figures.
    let stitched = held.windows(2).any(|pair| pair[1].saturating_sub(pair[0]) > 5);
    (!stitched && (pages < 4 || spanned * 10 >= pages * 3)).then_some(count)
}

/// Whether a decision's reasons go on past the numbers its gold types, as the reader holds (`reasons_go_on`).
fn list_in_reasons(gold: &Value, lines: &HashMap<&str, &GoldLine>, count: usize) -> bool {
    let order: Vec<&GoldLine> = items(&gold["lines"]).iter().filter_map(|line| lines.get(line["id"].as_str()?).copied()).collect();
    let place: HashMap<&str, usize> = order.iter().enumerate().map(|(at, line)| (line.id.as_str(), at)).collect();
    let numbered: Vec<usize> = items(&gold["typed"]).iter().flat_map(|typed| items(&typed["markers"]).iter()).filter_map(|mark| {
        let (number, _) = printed_marker(mark, lines).and_then(|raw| marker_number(&raw))?;
        let span = if mark.is_array() { &mark[0] } else { mark };
        place.get(span["line_id"].as_str()?).copied().filter(|_| number <= count)
    }).collect();
    let (Some(&first), Some(&last)) = (numbered.iter().min(), numbered.iter().max()) else { return false };
    let words = |part: &[&GoldLine]| part.iter().map(|line| line.text.iter().collect::<String>()).collect::<Vec<_>>().join("\n");
    count <= legal_structure::LIST_NUMBERS && legal_structure::reasons_go_on(&words(&order[..first]), &words(&order[first..last]), &words(&order[last..]))
}

/// A page's folio: a number between dashes ("- 28 -", or "-  -" its figures lost), or a bare number at the very top
/// or foot of its page. A number alone anywhere else is the text's (a quoted paragraph's "[15]", "¶50").
fn folio(line: &GoldLine, edges: (f64, f64)) -> bool {
    let figures = line.text.iter().filter(|c| c.is_alphanumeric()).count();
    let dashed = line.text.iter().filter(|c| matches!(c, '-' | '\u{2013}' | '\u{2014}')).count() >= 2;
    let bare = (1..=4).contains(&figures) && line.text.iter().all(|c| c.is_ascii_digit() || c.is_whitespace());
    (dashed && figures <= 4 && line.text.iter().all(|c| !c.is_alphabetic())) || (bare && (line.bbox[1] <= edges.0 + 1.0 || line.bbox[3] >= edges.1 - 1.0))
}

/// Whether a line's last words end a sentence, a note's call after them or not; an empty line has nothing to finish.
fn finishes(line: &str) -> bool {
    line.is_empty() || line.trim_end().trim_end_matches(|c: char| c.is_ascii_digit()).ends_with(['.', '?', '!', ')', '"', '\u{201d}'])
}

/// An enumerator's form: figures, lower letters or upper letters, read from its first character.
fn item_form(line: &str) -> Option<u8> {
    let first = line.trim_start().trim_start_matches('(').chars().next()?;
    Some(if first.is_ascii_digit() { 0 } else if first.is_lowercase() { 1 } else { 2 })
}

/// A recognizer's reading of a stamp over the page: marks no text prints ("^i^olNSCRIPTATORON \ r\"~^r,/ | / ,").
fn stamped(line: &str) -> bool {
    // (And a signing body's or judge's name under the reasons: "LABOUR RELATIONS BOARD", "MR. JUSTICE C. MACLEOD",
    // "Justice J. Hooper"; a date and time a signature stamps, "Date: 2022.02.01".)
    let words = line.trim();
    if words.starts_with('[') && words.ends_with(']') && !words.contains(char::is_lowercase) && words.split_whitespace().count() >= 2 || words.ends_with("LABOUR RELATIONS BOARD") || words.starts_with("MR. JUSTICE ") || words.starts_with("Date: ")
        || !words.ends_with(':') && words.strip_prefix("Justice ").is_some_and(|name| name.split_whitespace().count() <= 3) {
        return true;
    }
    // (A text layer may read a paragraph's brackets so: "|24| Il est important de rappeler".)
    line.chars().filter(|c| matches!(c, '^' | '~' | '|' | '\\')).count() >= 2 && line.split_whitespace().filter(|word| word.chars().count() >= 3 && word.chars().all(char::is_alphabetic)).count() < 4
}

/// A heading a gold typed as text, run to a colon ("Background:", "Grounds of Appeal:"): a few words, capitalized.
fn colon_heading(line: &str) -> bool {
    let line = line.trim();
    // (On its enumerator: "(i) Requirement for Counsel:".)
    let line = line.split_once(' ').filter(|(token, _)| list_item(token).is_some()).map_or(line, |(_, words)| words);
    line.ends_with(':') && line.starts_with(char::is_uppercase) && line.split_whitespace().count() <= 4
}

enum Flow {
    Unit(usize),
    Line(usize),
}

/// Each numbered paragraph's printings in the gold, by number: for each, its line ids in reading order. A printing is
/// the gold's unit the number opens and everything after it in its column up to the next numbered paragraph or
/// heading: its quotations, its list items, its unnumbered text. The last printing of a column runs to its own
/// words, quotations and lists only (the text after them is the decision's end matter). In a parallel report
/// (`parallel`) a column is a page's half; a number printed in the margin beside both columns opens each column's
/// paragraph, and a unit holding it keeps only the column its text opens in.
fn printings(gold: &Value, lines: &[GoldLine], parallel: bool) -> BTreeMap<usize, Vec<Vec<String>>> {
    let by_id: HashMap<&str, &GoldLine> = lines.iter().map(|line| (line.id.as_str(), line)).collect();
    let typed = items(&gold["typed"]);
    // A running head: words printed alike at the top or foot of three pages or more, a fifth of the pages.
    let mut page_ends = HashMap::<u64, (f64, f64)>::new();
    for line in lines {
        let ends = page_ends.entry(line.page).or_insert((f64::MAX, f64::MIN));
        *ends = (ends.0.min(line.bbox[1]), ends.1.max(line.bbox[3]));
    }
    let at_edge = |line: &GoldLine| {
        let (rows, ends) = (2.5 * (line.bbox[3] - line.bbox[1]), page_ends[&line.page]);
        line.bbox[1] <= ends.0 + rows || line.bbox[3] >= ends.1 - rows
    };
    let mut printed_on = HashMap::<String, HashSet<u64>>::new();
    for line in lines.iter().filter(|line| at_edge(line)) {
        printed_on.entry(line.text.iter().collect::<String>().trim().to_owned()).or_default().insert(line.page);
    }
    let running = |line: &GoldLine| at_edge(line) && printed_on.get(line.text.iter().collect::<String>().trim()).is_some_and(|pages| pages.len() >= 3 && pages.len() * 5 >= page_ends.len());
    let (mut extent, mut height) = (HashMap::<u64, (f64, f64)>::new(), HashMap::<u64, (f64, f64)>::new());
    // (A page's width is its long lines': a stray fragment moves no page's middle.)
    for line in lines.iter().filter(|line| line.text.len() >= 20).chain(lines.iter().filter(|line| line.text.len() < 20)) {
        let span = extent.entry(line.page).or_insert((line.bbox[0], line.bbox[2]));
        if line.text.len() >= 20 {
            *span = (span.0.min(line.bbox[0]), span.1.max(line.bbox[2]));
        }
        let span = height.entry(line.page).or_insert((line.bbox[1], line.bbox[3]));
        *span = (span.0.min(line.bbox[1]), span.1.max(line.bbox[3]));
    }
    // A "parallel" report may print its languages one after the other: only a page of two columns has sides, its
    // lines standing side by side across its middle, a quarter of them or more on a row with one in the other half
    // (a page of short lines is no page of columns).
    let mut paged = HashMap::<u64, Vec<&GoldLine>>::new();
    for line in lines {
        paged.entry(line.page).or_default().push(line);
    }
    // (A reader may give a line no height: level within two points.)
    let side_by_side = |list: &[&GoldLine], (left_edge, right_edge): (f64, f64)| {
        let middle = (left_edge + right_edge) / 2.0;
        let level = |a: &GoldLine, b: &GoldLine| {
            let centre = (a.bbox[1] + a.bbox[3]) / 2.0;
            b.bbox[1] - 2.0 <= centre && centre <= b.bbox[3] + 2.0
        };
        list.iter().filter(|left| left.bbox[2] <= middle + 8.0 && list.iter().any(|right| right.bbox[0] >= middle - 8.0 && level(left, right))).count() * 4 >= list.len()
    };
    // (A running head's box may run past the columns and move a page's middle: then the page's width is its body's.)
    let mut body = HashMap::<u64, (f64, f64)>::new();
    for line in lines.iter().filter(|line| line.text.len() >= 20 && !at_edge(line)) {
        let span = body.entry(line.page).or_insert((line.bbox[0], line.bbox[2]));
        *span = (span.0.min(line.bbox[0]), span.1.max(line.bbox[2]));
    }
    let columned: HashSet<u64> = paged.iter().filter_map(|(page, list)| {
        if side_by_side(list, extent[page]) {
            return Some(*page);
        }
        let width = body.get(page).copied().filter(|width| side_by_side(list, *width))?;
        extent.insert(*page, width);
        Some(*page)
    }).collect();
    // (A report in two columns is in them throughout: a few such pages are an enactment's, in a report of one language after the other.)
    let columned = if columned.len() * 2 < paged.len() { HashSet::new() } else { columned };
    // A line stands in the column its centre falls in; one wider than a column, a fragment of the other run onto its
    // end, in the column it starts in.
    let side = |line: &GoldLine| parallel && columned.contains(&line.page) && {
        let page = extent[&line.page];
        let (middle, column) = ((page.0 + page.1) / 2.0, (page.1 - page.0) / 2.0);
        let centre = if line.bbox[2] - line.bbox[0] > column { line.bbox[0] + column / 2.0 } else { (line.bbox[0] + line.bbox[2]) / 2.0 };
        centre < middle
    };
    let held = |unit: &Value| -> Vec<usize> { items(&unit["lines"]).iter().filter_map(Value::as_u64).map(|t| t as usize).filter(|&t| t < typed.len()).collect() };
    let units: Vec<&Value> = items(&gold["units"]).iter().filter(|unit| !held(unit).is_empty()).collect();
    let region = |unit: &Value| typed[held(unit)[0]]["region"].as_str().unwrap_or_default().to_owned();
    let marker = |unit: &Value| -> Option<(usize, char)> {
        // (A line may print a heading's number and a paragraph's: "3. Step Two: ... [96] Even if ...".)
        let marks: Vec<(usize, char)> = items(&typed[held(unit)[0]]["markers"]).iter().filter_map(|mark| marker_number(&printed_marker(mark, &by_id)?)).collect();
        marks.iter().find(|(_, style)| *style == '[').or(marks.first()).copied()
    };
    // The judgment numbers its paragraphs in one style: its other numbers ("(1)" of a quoted enactment under
    // "[14]") are content.
    let style_of = |region_name: &str| {
        let mut styles = Vec::<(char, usize)>::new();
        for unit in units.iter().filter(|unit| region(unit) == region_name) {
            if let Some((_, style)) = marker(unit) {
                match styles.iter_mut().find(|(known, _)| *known == style) {
                    Some(count) => count.1 += 1,
                    None => styles.push((style, 1)),
                }
            }
        }
        styles.iter().rev().max_by_key(|(_, count)| *count).map(|(style, _)| *style)
    };
    // A gold that types the numbered paragraphs as items numbers them in its items' style.
    let own_style = style_of("text").or_else(|| style_of("list_item"));
    let order: HashMap<&str, usize> = lines.iter().enumerate().map(|(at, line)| (line.id.as_str(), at)).collect();
    let ids_of = |unit: &Value| -> Vec<&str> {
        held(unit).into_iter().flat_map(|t| items(&typed[t]["spans"])).filter(|span| span["start"] != span["end"]).filter_map(|span| span["line_id"].as_str()).filter(|id| by_id.contains_key(id)).collect()
    };
    let typed_ids: HashSet<&str> = typed.iter().flat_map(|t| items(&t["spans"])).filter(|span| span["start"] != span["end"]).filter_map(|span| span["line_id"].as_str()).collect();
    // Where the judgment's own numbers stand on their pages. Text aligned to A2AJ's may take a quotation's printing of a
    // number for the judgment's: a number standing well further in is the quotation's.
    let mut margins = HashMap::<u64, f64>::new();
    for line in lines.iter().filter(|line| line.text.len() >= 20) {
        let margin = margins.entry(line.page).or_insert(f64::MAX);
        *margin = margin.min(line.bbox[0]);
    }
    // (A page all of a quotation has no margin of its own.)
    let mut starts: Vec<f64> = margins.values().copied().collect();
    starts.sort_by(f64::total_cmp);
    let typical = starts.get(starts.len() / 2).copied().unwrap_or(0.0);
    for margin in margins.values_mut().filter(|margin| **margin > typical + 20.0) {
        *margin = typical;
    }
    let stands = |unit: &Value| ids_of(unit).first().map(|id| by_id[*id].bbox[0] - margins.get(&by_id[*id].page).copied().unwrap_or(by_id[*id].bbox[0]));
    // (In order: two places tied go the same way every run.)
    let mut places = BTreeMap::<i64, usize>::new();
    for unit in units.iter().filter(|unit| region(unit) == "text" && marker(unit).is_some_and(|(_, style)| Some(style) == own_style)) {
        if let Some(stand) = stands(unit) {
            *places.entry((stand / 3.0).round() as i64).or_default() += 1;
        }
    }
    let own_place = places.iter().max_by_key(|(_, count)| **count).map(|(place, _)| *place as f64 * 3.0);
    // (But for the count's next number where nothing at that place prints it: a judgment may set its concurring reasons'
    // numbers elsewhere, and a page's margin is no surer than its lines.)
    let mut own_numbers: HashSet<usize> = units.iter().filter(|unit| region(unit) == "text").filter_map(|unit| {
        let (number, style) = marker(unit)?;
        (Some(style) == own_style && own_place.zip(stands(unit)).is_some_and(|(own, stand)| stand - own <= 9.0)).then_some(number)
    }).collect();
    // (Or a line the gold left untyped: an aligner may take a quotation's printing of a number for the judgment's.)
    own_numbers.extend(lines.iter().filter(|line| !typed_ids.contains(line.id.as_str())).filter_map(|line| {
        let (number, style) = marker_number(line.text.iter().collect::<String>().split_whitespace().next()?)?;
        let stand = line.bbox[0] - margins.get(&line.page).copied().unwrap_or(line.bbox[0]);
        (Some(style) == own_style && own_place.is_some_and(|own| stand - own <= 9.0)).then_some(number)
    }));
    // A heading set over a quoted passage is the passage's: the first unit after the headings is a quotation, or it stands
    // set in and no paragraph of the judgment's follows. (A page's turn stands between them on nothing.)
    let quoted_heading: HashSet<usize> = (0..units.len()).filter(|&at| region(units[at]) == "heading" && {
        let turn = |unit: &&&Value| ["page_label", "furniture", "note", "note_quote", "line_label"].contains(&region(unit).as_str());
        let after = units[at + 1..].iter().find(|unit| region(unit) != "heading" && !turn(unit));
        let before = units[..at].iter().rev().find(|unit| !turn(unit));
        // (The judgment's own, where its numbers stand; a recognizer's "[1 O]" still prints one.)
        let own_next = after.is_some_and(|unit| region(unit) == "text" && (marker(unit).is_some_and(|(_, style)| Some(style) == own_style) || !items(&typed[held(unit)[0]]["markers"]).is_empty())
            && own_place.zip(stands(unit)).is_none_or(|(own, stand)| stand - own <= 9.0));
        // (From the body's margin: a number standing in the margin outside it says nothing of a heading's indent, and a
        // parallel report's right column stands in from its page's edge as all its lines do.)
        let body = own_place.filter(|own| (-1.0..=20.0).contains(own)).unwrap_or(0.0);
        let set_in = !parallel && stands(units[at]).is_some_and(|stand| stand - body > 9.0);
        let within = before.is_some_and(|unit| region(unit) == "quote") && after.is_some_and(|unit| region(unit) == "text" && marker(unit).is_none());
        within || set_in && !own_next || after.is_some_and(|unit| ["quote", "note_quote", "provision"].contains(&region(unit).as_str()))
    }).collect();
    let aligned_quote = |unit: &Value, next: usize| !parallel && gold["label_source"] == "a2aj-align" && own_place.zip(stands(unit)).is_some_and(|(own, stand)| stand - own > 9.0)
        && marker(unit).is_none_or(|(number, _)| number != next || own_numbers.contains(&number));
    // A parallel report's headings stand level across its columns: a line the gold left untyped beside a heading it
    // typed in the other column is that heading's translation, and ends its column's paragraph as the heading does.
    let mut heading_rows = HashMap::<u64, Vec<(f64, f64, bool)>>::new();
    if parallel {
        for span in typed.iter().filter(|t| t["region"] == "heading" || t["region"] == "title").flat_map(|t| items(&t["spans"])) {
            if let Some(line) = span["line_id"].as_str().and_then(|id| by_id.get(id)) {
                heading_rows.entry(line.page).or_default().push((line.bbox[1], line.bbox[3], side(line)));
            }
        }
    }
    let translated_heading = |line: &GoldLine| {
        let middle = (line.bbox[1] + line.bbox[3]) / 2.0;
        heading_rows.get(&line.page).is_some_and(|rows| rows.iter().any(|(top, bottom, column)| *column != side(line) && *top <= middle && middle <= *bottom))
    };
    // A parallel report's margin number stands for both columns, though the gold type it with one column's words
    // alone, or leave its line untyped.
    let margin_numbers: Vec<(u64, f64, usize)> = if !parallel { Vec::new() } else {
        lines.iter().filter_map(|line| {
            let number = line.text.iter().collect::<String>().trim().parse::<usize>().ok()?;
            (!folio(line, height[&line.page])).then_some((line.page, line.bbox[1], number))
        }).collect()
    };
    // A unit stands where its words open: a gold may list a page's margin numbers before its text ("[4]", "[5]",
    // "[6]" first), and a number alone on its line places no paragraph.
    // (A parallel report's margin number, listed after its page's columns, goes just before the first words on its row.)
    let row_of = |number: &GoldLine| {
        (parallel && number.text.iter().collect::<String>().trim().parse::<usize>().is_ok() && !folio(number, height[&number.page])).then_some(()).and_then(|_| {
            let centre = (number.bbox[1] + number.bbox[3]) / 2.0;
            let on_row: Vec<&GoldLine> = paged[&number.page].iter().copied().filter(|line| line.id != number.id && line.text.len() >= 6 && line.bbox[1] <= centre && centre <= line.bbox[3]).collect();
            // (In its own column: a number in the right margin goes after the right column's lines above its row.)
            let place = |line: &&GoldLine| order[line.id.as_str()];
            on_row.iter().filter(|line| side(line) == side(number)).map(place).min().or_else(|| on_row.iter().map(place).min())
        })
    };
    let place = |unit: &Value| {
        let ids = ids_of(unit);
        let row = (ids.len() == 1).then(|| by_id[ids[0]]).and_then(row_of);
        let worded = ids.iter().filter(|id| marker_number(&by_id[**id].text.iter().collect::<String>()).is_none() && !folio(by_id[**id], height[&by_id[**id].page])).map(|id| order[id]).min();
        row.map(|row| (row * 2).saturating_sub(1)).or(worded.map(|at| at * 2)).or_else(|| ids.iter().map(|id| order[id] * 2).min()).unwrap_or(0)
    };
    // (A speck's empty span still types its line: it is no untyped line of the paragraph's.)
    let spanned: HashSet<&str> = typed.iter().flat_map(|t| items(&t["spans"])).filter_map(|span| span["line_id"].as_str()).collect();
    let mut flow: Vec<(usize, bool, Flow)> = units.iter().enumerate().map(|(at, unit)| (place(unit), false, Flow::Unit(at))).collect();
    flow.extend(lines.iter().enumerate().filter(|(_, line)| !spanned.contains(line.id.as_str())).map(|(at, line)| (row_of(line).map_or(at * 2, |row| (row * 2).saturating_sub(1)), true, Flow::Line(at))));
    flow.sort_by_key(|item| (item.0, item.1));
    let mut book = Book::default();
    // Each column's margin number waiting for its next text.
    let mut waiting: [Option<Margin>; 2] = [None, None];
    for (_, _, item) in &flow {
        let at = match item {
            Flow::Line(at) => {
                // Words the gold left untyped that no paragraph holds: a heading across from one it typed, a formal
                // heading of its own, the next reasons' introduction, the matter after the reasons.
                let line = &lines[*at];
                let column = side(line);
                let words: String = line.text.iter().collect();
                // (But an item under a colon is the list that colon opens.)
                if list_item(&words).is_some() && book.under_list(column, &by_id) {
                    book.listing(column);
                } else {
                    // (A heading ends a finished paragraph: no number, no quotation's line an aligner left untyped, a quoted section's opening over nothing.)
                    let open_last = book.last_words(column, &by_id);
                    let deeper = gold["label_source"] == "a2aj-align" && own_place.is_some_and(|own| line.bbox[0] - margins.get(&line.page).copied().unwrap_or(line.bbox[0]) - own > 9.0);
                    let division = legal_structure::judgment_division(&words) && marker_number(&words).is_none() && finishes(&open_last) && !open_last.trim_end().ends_with(':') && !deeper;
                    if !running(line) && (translated_heading(line) || division) {
                        book.closed(column);
                        continue;
                    }
                }
                // A margin number the gold typed with the other column opens this column's words on its row.
                let due = book.next(column);
                let row_height = line.bbox[3] - line.bbox[1];
                if line.text.len() >= 6 && margin_numbers.iter().any(|(page, top, number)| *page == line.page && (line.bbox[1] - top).abs() <= row_height && *number == due) {
                    book.opened(column, due, vec![line.id.as_str()], 1);
                    continue;
                }
                // The next number, left untyped, opens its paragraph as a typed one does.
                let leading = words.split_whitespace().next().and_then(marker_number);
                if let Some((number, _)) = leading.filter(|(number, style)| Some(*style) == own_style && *number == due && !folio(line, height[&line.page])) {
                    book.opened(column, number, vec![line.id.as_str()], 1);
                    continue;
                }
                // A line no unit types is the paragraph's it falls within, in its column, a folio never.
                if !folio(line, height[&line.page]) {
                    book.extended(column, [line.id.as_str()]);
                }
                continue;
            }
            Flow::Unit(at) => *at,
        };
        let unit = units[at];
        let ids = ids_of(unit);
        let Some(first) = ids.first() else { continue };
        let opening = ids.iter().find(|id| by_id[**id].text.iter().collect::<String>().trim().chars().count() >= 20).unwrap_or(first);
        let column = side(by_id[opening]);
        if unit["starts_document"] == true {
            book.document_began();
        }
        let kind = region(unit);
        // A numbered paragraph the gold types an item is still the judgment's own when it prints the judgment's
        // bracketed numbering, or the next number of its count; a list's own "1." restarts no count.
        let next = book.next(column);
        let opening_words: String = by_id[*first].text.iter().collect();
        // A number alone over words carrying a sentence on, printed again where its paragraph opens: a court's numbering
        // fired on an empty line ("[15]" over "of Stockwell Day, ...", "[15] Then on January 31 ...").
        let misfired = |number: usize| book.numbers.get(&number).and_then(|printed| printed.last()).is_some_and(|&at| {
            let mut words = book.printings[at].lines.iter().map(|id| by_id[id].text.iter().collect::<String>());
            words.next().is_some_and(|words| marker_number(&words).is_some() && words.trim().chars().count() <= 6)
                && words.next().is_some_and(|words| words.trim_start().starts_with(char::is_lowercase))
        });
        let quoted = aligned_quote(unit, next);
        let open_last = book.last_words(column, &by_id);
        let under_colon = open_last.trim_end().ends_with(':');
        let number = (!quoted && (kind == "text" || kind == "list_item" || kind == "heading")).then(|| marker(unit)).flatten()
            .filter(|(number, style)| Some(*style) == own_style && (kind == "text" || *style == '[' || *number == next) && (kind != "heading" || *number == next))
            // A number going back is another's words, a list's or a page printed twice, but for a second language's count.
            .filter(|(number, _)| book.walk(column).counted().is_none() || (*number >= next || *number <= 1 && parallel && !under_colon || *number + 1 == next && misfired(*number)) && *number <= next + 8)
            .map(|(number, _)| number)
            .or_else(|| {
                // A number printed already and going on from there is printed again, a page's or a quotation's, not misread.
                // Nor is one where the next paragraph prints the number it would stand for: a slip of the court's.
                let following = units[at + 1..].iter().filter(|unit| region(unit) == "text").find_map(|unit| marker(unit)).map(|(number, _)| number);
                let again = marker(unit).is_some_and(|(number, _)| book.numbers.contains_key(&number) && (number + 1 == next || following == Some(number + 1)));
                (kind == "text" && !quoted && misread_number(&opening_words, next) && !again && following != Some(next)).then_some(next)
            })
            .or_else(|| {
                // A margin number opens the text on its row, not a line carried over above it.
                let line = by_id[*opening];
                let beside = waiting[column as usize].is_some_and(|margin| margin.page == line.page && (line.bbox[1] - margin.top).abs() <= line.bbox[3] - line.bbox[1]);
                (kind == "text" && beside).then(|| waiting[column as usize].take()).flatten().map(|margin| margin.number)
            })
            .or_else(|| {
                let line = by_id[*opening];
                let beside = |&&(page, top, number): &&(u64, f64, usize)| page == line.page && (line.bbox[1] - top).abs() <= line.bbox[3] - line.bbox[1] && number == next;
                (kind == "text").then(|| margin_numbers.iter().find(beside)).flatten().map(|(_, _, number)| *number)
            });
        // The next number in a line's middle opens there, the line both paragraphs': "... Justice of the Peace Welsh. [23] Later".
        let inline = format!(" [{next}] ");
        let line_of = |id: &str| by_id[id].text.iter().collect::<String>();
        if let Some(place) = (number.is_none() && own_style == Some('[') && !quoted && kind == "text").then(|| ids.iter().position(|id| line_of(id).contains(&inline))).flatten() {
            book.extended(column, ids[..=place].iter().copied());
            book.opened(column, next, ids[place..].to_vec(), ids.len() - place);
            continue;
        }
        // A unit's lines up to one ending the paragraphs, a page's folio none of them.
        // (A paragraph's own first line may open on its judge: "CORY J. -- The business ...".)
        // A paragraph may open on its judge ("Binnie J. - I agree ..."), and a sentence may wrap onto a line opening as a
        // disposition does ("... Court of" / "Appeal allowed the appeal"): neither ends anything.
        let line_words = |id: &str| by_id[id].text.iter().collect::<String>();
        // (A quotation or a table ends nothing: a quoted email's date, a chronology's rows.)
        // (Nor does a chronology a colon opened.)
        let list_open = under_colon || book.open(column).is_some_and(|open| open.goes == Goes::OnList);
        let ended_at = (!list_open && !["quote", "list_item", "provision", "table"].contains(&kind.as_str())).then_some(()).and_then(|_| ids.iter().enumerate().position(|(place, id)| {
            let words = line_words(id);
            // (A sentence's own words, "concurred in the result, but ...", open in lower case.)
            if words.trim_start().starts_with(char::is_lowercase) {
                return false;
            }
            let runs_on = words.split(['\u{2014}', '\u{2013}']).nth(1).or_else(|| words.split("--").nth(1)).is_some_and(|rest| rest.split_whitespace().count() > 0);
            let goes_on = place > 0 && line_words(ids[place - 1]).chars().any(char::is_alphanumeric) && !line_words(ids[place - 1]).trim_end().ends_with(['.', '?', '!', ':', ')', '"', '\u{201d}']);
            let signed = ids.get(place + 1).is_some_and(|next| ["J.A.", "J.", "JJ.A.", "Vice-Chairperson", "Chairperson", "Member", "Vice-Chair", "Chair", "Vice-président", "Vice-présidente", "Président", "Présidente", "Membre"].contains(&line_words(next).trim())
                // (On a row of its own: a line of a word at a time is no signature.)
                && (by_id[*next].bbox[1] - by_id[*id].bbox[1]).abs() > (by_id[*id].bbox[3] - by_id[*id].bbox[1]) / 2.0);
            (place > 0 || number.is_none()) && !running(by_id[id]) && !runs_on && !goes_on && words.split_whitespace().count() <= 24
                && (legal_structure::judgment_end(&words) || legal_structure::figure_caption(&words) || legal_structure::date_line(&words) || signed || stamped(&words))
        }));
        // (The number a unit opens on is its own, though it stand alone at the top of its page.)
        let ids: Vec<&str> = ids[..ended_at.unwrap_or(ids.len())].iter().copied().filter(|id| *id == *first && number.is_some() || !folio(by_id[id], height[&by_id[id].page]) && !running(by_id[id])).collect();
        let own: Vec<&str> = ids.iter().copied().filter(|id| side(by_id[id]) == column).collect();
        // The gold types this text: its words, not a line's shape, make it a division, under a finished paragraph, no list going
        // on, no figure closing it ("at 343", "$15,565.00"), and something to read in it.
        // (A sentence's lead-in, "The court further says:", sets out what follows; a heading, "Analysis:", heads it.)
        let lead_in = opening_words.split_whitespace().filter(|word| word.starts_with(char::is_lowercase)).count() >= 2;
        let sets_out = lead_in && units.get(at + 1).is_some_and(|unit| ["quote", "list_item", "provision"].contains(&region(unit).as_str()));
        let whole_words = ids.iter().map(|id| line_words(id)).collect::<Vec<_>>().join(" ");
        let finished = finishes(&open_last);
        // (Nor a transcript's question, a table's row, a citation, or a list's next item.)
        let opener = whole_words.split_whitespace().next().unwrap_or_default();
        let row = opener.len() == 5 && opener.ends_with(':') && opener[..4].chars().all(|c| c.is_ascii_digit());
        let form = item_form(&opening_words);
        let item_goes_on = list_item(&opening_words).is_some_and(|following| book.open(column).is_some_and(|open| open.lines.iter().rev().find_map(|id| {
            let words = line_words(id);
            (item_form(&words) == form).then(|| list_item(&words)).flatten()
        }).is_some_and(|item| item + 1 == following)));
        let divides = legal_structure::judgment_division(&whole_words) && whole_words.contains(char::is_alphabetic) && !whole_words.trim_end().ends_with(|c: char| c.is_ascii_digit())
            && !running(by_id[*first]) && !folio(by_id[*first], height[&by_id[*first].page]) && !list_open && finished
            && !matches!(opener, "Q" | "A" | "R" | "Q." | "A.") && !row && !whole_words.contains(" v. ") && !item_goes_on;
        let stray_first = number.is_some_and(|number| number + 1 == next && misfired(number));
        let next_unit_next = units.get(at + 1).is_some_and(|unit| marker(unit).is_some_and(|(number, style)| number == next && Some(style) == own_style));
        if let Some(number) = number {
            if stray_first {
                let stray = book.numbers.get_mut(&number).and_then(Vec::pop).map(|at| std::mem::take(&mut book.printings[at].lines));
                if let (Some(stray), Some(&before)) = (stray, book.numbers.get(&(number - 1)).and_then(|printed| printed.last())) {
                    book.printings[before].lines.extend(stray);
                }
            }
            waiting[column as usize] = None;
            let kept = ids.iter().copied().filter(|id| side(by_id[id]) == column || by_id[id].text.iter().collect::<String>().trim().chars().count() < 6).collect::<Vec<_>>();
            // (The next number may open further down the same unit, the line both paragraphs': "Welsh. [23] Later that morning".)
            let inner = format!(" [{}] ", number + 1);
            let next_opens = kept.iter().skip(1).position(|id| own_style == Some('[') && line_of(id).contains(&inner)).map(|place| place + 1);
            let kept_words = kept.len();
            match next_opens {
                None => book.opened(column, number, kept, kept_words),
                Some(place) => {
                    let rest = kept[place..].to_vec();
                    let rest_words = rest.len();
                    book.opened(column, number, kept[..=place].to_vec(), kept_words);
                    book.opened(column, number + 1, rest, rest_words);
                }
            }
        } else if ["quote", "list_item", "provision", "table"].contains(&kind.as_str()) || quoted_heading.contains(&at) {
            // A judgment's quoted enactment and its tables are set within the paragraph quoting them.
            if under_colon {
                book.listing(column);
            }
            book.worded(column, own);
        } else if kind == "text" && colon_heading(&opening_words) && !next_unit_next && book.under_list(column, &by_id) {
            // What a paragraph's own line introduces is its ("They are:", "Provided by the Crown:", then their lists).
            book.listing(column);
            book.worded(column, own);
        } else if kind == "text" && (ended_at == Some(0) || divides || colon_heading(&opening_words) && !sets_out
            // (A colon over the next number sets out nothing: "Comment on failure of appellant to testify:".)
            || ids.len() == 1 && opening_words.trim_end().ends_with(':') && next_unit_next) {
            // The next reasons' introduction, the matter after the reasons, a heading run to a colon ("Background:"):
            // no paragraph's, typed or not. A line's shape as a heading says nothing else here: a gold may type a
            // paragraph line by line.
            // (The matter after the reasons leaves what the last paragraph's own words did not reach.)
            if ended_at == Some(0) {
                book.reasons_ended(column);
            } else {
                book.closed(column);
            }
        } else if (kind == "page_label" || kind == "line_label" || kind == "text") && parallel && ids.len() <= 1 && opening_words.trim().parse::<usize>().is_ok_and(|number| !folio(by_id[*first], height[&by_id[*first].page]) && [false, true].iter().any(|column| book.next(*column) == number)) {
            let number: usize = opening_words.trim().parse().unwrap_or(0);
            for column in [false, true] {
                if book.next(column) == number {
                    waiting[column as usize] = Some(Margin { number, page: by_id[*first].page, top: by_id[*first].bbox[1] });
                }
            }
        } else if kind == "text" || kind == "line_label" {
            // A list's marker typed apart ("\u{2022}", "b)") or a line's floating accent ("l\u{2019}\u{b4}") is its
            // paragraph's as its words are; a parallel report's gutter letters and numbers, a letter or a figure alone
            // between its columns, are no one's.
            let gutter = kind == "line_label" && parallel && by_id.get(*first).is_some_and(|line| {
                let words: String = line.text.iter().filter(|c| !c.is_whitespace()).collect();
                let words = words.trim_end_matches('.');
                columned.contains(&line.page) && words.chars().all(char::is_alphanumeric) && (words.chars().count() == 1 || words.chars().all(|c| c.is_ascii_digit()))
            });
            if let Some(tail) = book.walk(column).open().filter(|_| !gutter) {
                // (A number standing as a unit of its own has its words here.)
                let bare = tail.own == 1 && book.printings[tail.printing].lines.first().is_some_and(|id| marker_number(&by_id[id].text.iter().collect::<String>()).is_some());
                if bare {
                    book.worded(column, own);
                } else {
                    book.extended(column, own);
                }
            }
        } else if ["heading", "title", "headnote", "contents"].contains(&kind.as_str()) {
            // What a paragraph's own line introduces is its list, however the gold typed it ("... the issues this
            // way:" over "1. Should leave to appeal be granted?").
            // A list ends with its items: the next heading's "V." goes on from no "C."
            let open = book.open(column);
            let last = open.and_then(|open| open.lines.last().copied()).map(|id| line_words(id)).unwrap_or_default();
            // (A heading of the next stretch stands under a colon too, its paragraph's number at once under it: "A. First indictment" over "[40]".)
            let next_prints = units.get(at + 1).is_some_and(|unit| region(unit) == "text" && marker(unit).is_some());
            let under = last.trim_end().ends_with(':') && !(list_item(&opening_words).is_some() && next_prints);
            // (Nor past the list: the next paragraph's number follows the heading at once.)
            let carried = open.is_some_and(|open| open.goes == Goes::OnList) && list_item(&last).is_none() && list_item(&opening_words).is_none() && !next_prints;
            // (The item before may wrap, or stand apart from its words: the last line opening on one of the same form, in a list a colon
            // opened or a paragraph that is a list.)
            let form = item_form(&opening_words);
            let item_before = open.and_then(|open| open.lines.iter().rev().find_map(|id| {
                let words = line_words(id);
                (item_form(&words) == form).then(|| list_item(&words)).flatten()
            }));
            let introduced = open.is_some_and(|open| open.goes == Goes::OnList || open.lines.iter().any(|id| line_words(id).trim_end().ends_with(':'))
                || open.lines.iter().map(|id| line_words(id)).find(|words| words.contains(char::is_alphabetic)).is_some_and(|words| list_item(&words).is_some()));
            let next_item = (list_item(&last).is_some() || introduced) && item_before.zip(list_item(&opening_words)).is_some_and(|(item, following)| item + 1 == following);
            if open.is_some() && (under || carried || next_item) {
                if under {
                    book.listing(column);
                }
                book.worded(column, own);
            } else {
                book.closed(column);
            }
        }
    }
    book.finished();
    // A number alone in the margin opens the words on its row, wherever the gold's line order sets them: a page may
    // list its row's words first, and they are the number's, not the paragraph's before.
    // (A page's furniture is on no row: a stamp turned up the margin stands level with whatever it passes.)
    let furniture: HashSet<&str> = typed.iter().filter(|t| t["region"] == "furniture").flat_map(|t| items(&t["spans"])).filter_map(|span| span["line_id"].as_str()).collect();
    if !parallel {
        for at in 1..book.printings.len() {
            let Some(number) = book.printings[at].lines.first().map(|id| by_id[id]) else { continue };
            if marker_number(&number.text.iter().collect::<String>()).is_none() {
                continue;
            }
            let centre = (number.bbox[1] + number.bbox[3]) / 2.0;
            // (Typed a heading or left after one, they are the number's all the same: "[24] 3.3 Must the information ...?--".)
            let row: Vec<&str> = paged[&number.page].iter().filter(|line| line.bbox[1] <= centre && centre <= line.bbox[3] && line.bbox[0] >= number.bbox[2] && !furniture.contains(line.id.as_str())).map(|line| line.id.as_str()).collect();
            for row in row {
                book.printings[at - 1].lines.retain(|id| *id != row);
                if !book.printings[at].lines.contains(&row) {
                    book.printings[at].lines.insert(1, row);
                }
            }
        }
    }
    book.numbers.iter().map(|(number, printed)| (*number, printed.iter().map(|at| book.printings[*at].lines.iter().map(|id| id.to_string()).collect()).collect())).collect()
}

// -- the key --------------------------------------------------------------------------------------------------------

/// The key a gold's own lines and types give, `count` null where the judgment numbers no paragraphs.
pub fn answer(gold: &Value, parallel: bool) -> Value {
    let unnumbered = json!({"count": null, "printings": {}, "speaks_for": []});
    let lines = gold_lines(gold);
    let by_id: HashMap<&str, &GoldLine> = lines.iter().map(|line| (line.id.as_str(), line)).collect();
    let Some(count) = gold_count(gold, &by_id, parallel).filter(|&count| !list_in_reasons(gold, &by_id, count)) else { return unnumbered };
    let sets = printings(gold, &lines, parallel);
    let regions: HashMap<&str, &str> = items(&gold["typed"]).iter()
        .flat_map(|typed| items(&typed["spans"]).iter().filter(|span| span["start"] != span["end"]).filter_map(move |span| Some((span["line_id"].as_str()?, typed["region"].as_str()?))))
        .collect();
    let typed_only = gold["label_source"] == "a2aj-align";
    // A judgment numbers its reasons, not a list or two in them: its numbered paragraphs hold a fifth of its prose,
    // of the lines the gold speaks for.
    let held: HashSet<&str> = sets.values().flatten().flatten().map(String::as_str).collect();
    let prose: Vec<&GoldLine> = lines.iter().filter(|line| line.text.iter().collect::<String>().split_whitespace().count() >= 9 && (!typed_only || regions.contains_key(line.id.as_str()))).collect();
    if prose.iter().filter(|line| held.contains(line.id.as_str())).count() * 5 < prose.len() {
        return unnumbered;
    }
    // A line the gold types a label (a gutter letter, a bullet, a floating accent), or one with no letter ("\u{2022}", "\u{2026}",
    // a margin number however typed), is no paragraph's words either way; an A2AJ gold speaks only for the lines it types.
    let speaks_for: Vec<&str> = lines.iter().filter(|line| regions.get(line.id.as_str()) != Some(&"line_label") && line.text.iter().any(|c| c.is_alphabetic())
        && (!typed_only || regions.contains_key(line.id.as_str()))).map(|line| line.id.as_str()).collect();
    // (Sorted as the store sorts a JSON object's keys.)
    let numbered: BTreeMap<String, Vec<Vec<String>>> = sets.into_iter().filter(|(number, _)| (1..=count).contains(number))
        .map(|(number, printed)| (number.to_string(), printed.into_iter().filter(|lines| !lines.is_empty()).collect::<Vec<_>>()))
        .filter(|(_, printed)| !printed.is_empty()).collect();
    json!({"count": count, "printings": numbered, "speaks_for": speaks_for})
}

fn line_total(key: &Value) -> usize {
    key["printings"].as_object().map_or(0, |printings| printings.values().flat_map(items).map(|printing| items(printing).len()).sum())
}

// -- the store ------------------------------------------------------------------------------------------------------

/// A JSON object's members as written. This crate's serde_json reads a float a digit off (no `float_roundtrip`), so what the
/// freeze leaves alone is copied, never read and printed again.
pub fn members(json: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let json = json.strip_prefix(b"\xef\xbb\xbf").unwrap_or(json);
    let past = |mut at: usize| {
        while json.get(at).is_some_and(|c| b" \t\r\n,:".contains(c)) {
            at += 1;
        }
        at
    };
    let mut at = past(json.iter().position(|c| *c == b'{').ok_or("no object")? + 1);
    let mut found = BTreeMap::new();
    while json.get(at).is_some_and(|c| *c != b'}') {
        let mut keys = Deserializer::from_slice(&json[at..]).into_iter::<String>();
        let key = keys.next().ok_or("no key")?.map_err(|e| e.to_string())?;
        at = past(at + keys.byte_offset());
        let mut values = Deserializer::from_slice(&json[at..]).into_iter::<IgnoredAny>();
        values.next().ok_or("no value")?.map_err(|e| e.to_string())?;
        let end = at + values.byte_offset();
        found.insert(key, json[at..end].to_vec());
        at = past(end);
    }
    Ok(found)
}

/// Members as the store writes an object: sorted, compact, a newline after.
pub fn object(members: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let mut json = vec![b'{'];
    for (at, (key, value)) in members.iter().enumerate() {
        if at > 0 {
            json.push(b',');
        }
        json.extend(serde_json::to_vec(key).expect("a key"));
        json.push(b':');
        json.extend(value);
    }
    json.extend(b"}\n");
    json
}

fn gunzip(path: &Path) -> Result<Vec<u8>, String> {
    let mut json = Vec::new();
    let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    GzDecoder::new(file).read_to_end(&mut json).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(json)
}

/// Gzip without a timestamp, as the store packs a gold.
fn gzip(json: &[u8]) -> Result<Vec<u8>, String> {
    let mut stream = GzEncoder::new(Vec::with_capacity(json.len() / 6), Compression::best());
    stream.write_all(json).map_err(|e| e.to_string())?;
    stream.finish().map_err(|e| e.to_string())
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Files made first beside their places, then swapped in, so a stopped run leaves no half-written gold.
fn replaced(files: &[(PathBuf, Vec<u8>)]) -> Result<(), String> {
    let temporary = |path: &Path| PathBuf::from(format!("{}.tmp", path.display()));
    for (path, bytes) in files {
        fs::write(temporary(path), bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    for (path, _) in files {
        fs::rename(temporary(path), path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}

/// The correction a key is listed by in its gold.
pub fn key_entry(key: &Value) -> Value {
    let printed = key["printings"].as_object().map_or(0, Map::len);
    json!({"count": key["count"], "lines": line_total(key), "numbers": printed, "rule": "paragraph_key", "speaks_for": items(&key["speaks_for"]).len()})
}

/// A gold's file and receipt with `key` written in, nothing else in the gold changed but its `postcorrections`.
fn with_key(path: &Path, raw: &[u8], gold: &Value, key: &Value) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    let entry = serde_json::to_vec(&key_entry(key)).map_err(|e| e.to_string())?;
    let mut fields = members(raw)?;
    let corrections = match fields.get("postcorrections") {
        Some(list) if list.as_slice() != b"[]" => [&list[..list.len() - 1], b",".as_slice(), entry.as_slice(), b"]".as_slice()].concat(),
        _ => [b"[".as_slice(), entry.as_slice(), b"]".as_slice()].concat(),
    };
    fields.insert("postcorrections".to_owned(), corrections);
    fields.insert("paragraphs".to_owned(), serde_json::to_vec(key).map_err(|e| e.to_string())?);
    let json = object(&fields);
    // Read back: the key as made, the corrections one longer, the rest as it was.
    let mut written: Value = serde_json::from_slice(&json).map_err(|e| e.to_string())?;
    let mut was = gold.clone();
    let count = written["postcorrections"].as_array().map_or(0, Vec::len);
    let (mine, others) = (written.as_object_mut().ok_or("no object")?, was.as_object_mut().ok_or("no object")?);
    let (paragraphs, listed) = (mine.remove("paragraphs"), others.remove("postcorrections"));
    mine.remove("postcorrections");
    others.remove("paragraphs");
    if paragraphs.as_ref() != Some(key) || count != listed.as_ref().map_or(0, |list| items(list).len()) + 1 || mine != others {
        return Err("the written gold does not read back".to_owned());
    }
    let packed = gzip(&json)?;
    let receipt_path = path.with_file_name("receipt.json");
    let mut receipt = members(&fs::read(&receipt_path).map_err(|e| format!("{}: {e}", receipt_path.display()))?)?;
    receipt.insert("gold_sha256".to_owned(), serde_json::to_vec(&sha256(&packed)).map_err(|e| e.to_string())?);
    receipt.insert("postcorrections".to_owned(), count.to_string().into_bytes());
    Ok(vec![(path.to_owned(), packed), (receipt_path, object(&receipt))])
}

/// One gold: what the freeze makes of it, by the report's classes.
fn frozen(source: &GoldSource, write: bool, graded: &HashMap<String, bool>) -> Result<Vec<&'static str>, String> {
    let raw = gunzip(&source.gold)?;
    let gold: Value = serde_json::from_slice(&raw).map_err(|e| format!("{}: {e}", source.gold.display()))?;
    let key = answer(&gold, source.layout == "parallel");
    let stored = &gold["paragraphs"];
    let mut classes = vec![if key["count"].is_null() { "unnumbered" } else { "numbered" }];
    let said = |class: &str| println!("{class} {} {} {} count {} -> {} numbers {} -> {} lines {} -> {}", source.sha, source.layout, gold["label_source"].as_str().unwrap_or("-"),
        stored["count"], key["count"], stored["printings"].as_object().map_or(0, Map::len), key["printings"].as_object().map_or(0, Map::len), line_total(stored), line_total(&key));
    if stored["count"] != key["count"] {
        said("verdict");
        classes.push("verdict");
    } else if stored["printings"] != key["printings"] {
        said("lines");
        classes.push("lines");
    }
    if graded.get(&source.sha).is_some_and(|numbered| *numbered != !key["count"].is_null()) {
        said("grade");
        classes.push("grade");
    }
    // The aligner's key, or a key written before, stands.
    if !stored["speaks_for"].is_null() {
        if *stored != key {
            said("keeps");
        }
        classes.push("keeps");
    } else if write {
        replaced(&with_key(&source.gold, &raw, &gold, &key)?)?;
        classes.push("written");
    }
    Ok(classes)
}

/// Every judgment gold of the store: a line for each whose key the freeze would change (`verdict`: its count or its being
/// numbered; `lines`: its printings), against the key it holds; with `rows`, each whose verdict differs from that grade's
/// (`grade`); each key the freeze keeps though it would read otherwise (`keeps`); then the totals.
pub fn freeze(write: bool, prefix: &str, rows: Option<&Path>) {
    let graded: HashMap<String, bool> = rows.map_or_else(Vec::new, rows_of).iter()
        .filter_map(|row| Some((row["sha"].as_str()?.to_owned(), row["gold"]["numbered"].as_bool()?))).collect();
    let mut totals = BTreeMap::<&str, usize>::new();
    for source in gold_sources().iter().filter(|source| source.sha.starts_with(prefix)) {
        *totals.entry("golds").or_default() += 1;
        match catch_unwind(AssertUnwindSafe(|| frozen(source, write, &graded))).unwrap_or_else(|_| Err("panic".to_owned())) {
            Ok(classes) => classes.into_iter().for_each(|class| *totals.entry(class).or_default() += 1),
            Err(error) => {
                println!("error {} {error}", source.sha);
                *totals.entry("errors").or_default() += 1;
            }
        }
    }
    println!("{}", json!(totals));
}
