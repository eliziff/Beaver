//! What the page prints decides. The alignment pairs A2AJ's words with the PDF's, so a number A2AJ writes may land on a
//! quotation's printing of it or on a folio, or nowhere; A2AJ may omit or double a number, and its French may be another
//! edition. These rules read the judgment's own numbering off its lines (the spine: the style and the place in the margin
//! most of its markers have) and put the gold right against it: a number moves to the printing at the margin, a number
//! with no marker takes one, a unit holding two numbers is cut, folios and running heads typed as text go to the furniture,
//! headings typed as text become headings, and numbers printed as images take their place on their lines.
use super::book::Book;
use super::conventions::numbering;
use super::pdf::PageImages;
use super::words::is_space;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::LazyLock;

static FOLIO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[-\x{2013}\x{2014}]+\s*\d{1,4}\s*[-\x{2013}\x{2014}]+\s*$").unwrap());
pub(super) static OPENS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}[.)]?)").unwrap());
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+").unwrap());
// Lines a judgment speaks, never titles: who gives the reasons, the sentence that introduces what follows.
static SPOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:delivered|given|rendered|read|written)(?: orally)? by:?$|\b(?:rendus?|prononc[ée]s?|lus?)(?: oralement)? par:?$|\b(?:C\.?J\.?C?|J\.?J?\.?A?|D\.?J)\.\s*[:\-\x{2013}\x{2014}]*$|[:\-\x{2013}\x{2014}]$").unwrap()
});

// A judge's name opening reasons ("Miller J.A. (dissenting):", "ARBOUR J. \u{2014}L", "LES JUGES IACOBUCCI ET"), a translator's
// label, the line naming the court appealed from: bold or capitals, and speech all the same.
static NOT_HEADING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:J|JJ|C\.J|C\.J\.C|J\.A|JJ\.A|D\.J)\.?\s*(?:\([^)]*\))?\s*[:\-\x{2013}\x{2014}]*\s*\p{L}?$|^(?:LES? JUGES?|THE JUDGES?|ON APPEAL|EN APPEL|APPEAL FROM)\b|^\[[^\]]*\]$").unwrap()
});

const INDENT: f64 = 15.0; // a line this far in from its column is set apart from it
const PLACE: f64 = 4.0; // a number stands at the margin when within this of where the spine's numbers stand

/// The judgment's own numbering, from its text units' markers. None where it numbers no paragraphs (a list or two in its
/// reasons is not a numbering).
struct Spine {
    style: &'static str,
    alone: bool,
    places: BTreeSet<(i64, i64)>, // (page parity, x rounded to 3)
    marks: Vec<Mark>,
}

struct Mark {
    style: &'static str,
    number: u32,
    line: usize,
    typed: usize,
}

fn round3(x: f64) -> i64 {
    (x / 3.0).round_ties_even() as i64 * 3
}

fn spine_of(book: &Book) -> Option<Spine> {
    let mut marks = Vec::new();
    let mut alone = 0;
    for t in 0..book.typed.len() {
        if book.region(t) != "text" {
            continue;
        }
        for mark in book.markers(t) {
            let Some((said, line)) = book.printed(mark) else { continue };
            let Some((style, number)) = numbering(&said) else { continue };
            alone += (line.trimmed() == said.trim_matches(is_space)) as usize;
            marks.push(Mark { style, number, line: book.by_id[&line.id], typed: t });
        }
    }
    if marks.iter().map(|m| m.number).collect::<BTreeSet<_>>().len() < 3 {
        return None;
    }
    let mut styles: Vec<(&'static str, usize)> = Vec::new();
    for mark in &marks {
        match styles.iter_mut().find(|entry| entry.0 == mark.style) {
            Some(entry) => entry.1 += 1,
            None => styles.push((mark.style, 1)),
        }
    }
    let style = styles.iter().fold(styles[0], |best, &entry| if entry.1 > best.1 { entry } else { best }).0;
    let own: Vec<&Mark> = marks.iter().filter(|m| m.style == style).collect();
    let pages: BTreeSet<i64> = book.lines.iter().map(|line| line.page).collect();
    let held: BTreeSet<i64> = own.iter().map(|m| book.lines[m.line].page).collect();
    let spanned = held.iter().next_back().unwrap() - held.iter().next().unwrap() + 1;
    let printed = own.iter().map(|m| m.number).collect::<BTreeSet<_>>().len() as i64;
    if pages.len() >= 4 && (spanned * 10 < pages.len() as i64 * 3 || printed * 3 < spanned) {
        return None;
    }
    let mut counts: BTreeMap<(i64, i64), usize> = BTreeMap::new();
    for mark in &own {
        let line = &book.lines[mark.line];
        *counts.entry((line.page.rem_euclid(2), round3(line.bbox[0]))).or_default() += 1;
    }
    let floor = (0.08 * own.len() as f64).max(2.0);
    let places = counts.into_iter().filter(|&(_, n)| n as f64 >= floor).map(|(place, _)| place).collect();
    Some(Spine { style, alone: alone * 5 >= marks.len() * 4, places, marks })
}

impl Spine {
    fn at_margin(&self, page: i64, x: f64) -> bool {
        self.places.iter().any(|&(side, at)| side == page.rem_euclid(2) && (x - at as f64).abs() <= PLACE)
    }
}

/// The words (digits masked) of the lines at a page's head or foot, with the pages they stand on.
fn repeated(book: &Book) -> HashMap<String, BTreeSet<i64>> {
    let mut pages: BTreeMap<i64, Vec<usize>> = BTreeMap::new();
    for (k, line) in book.lines.iter().enumerate() {
        pages.entry(line.page).or_default().push(k);
    }
    let mut seen: HashMap<String, BTreeSet<i64>> = HashMap::new();
    for (page, mut on) in pages {
        on.sort_by(|&a, &b| book.lines[a].bbox[1].total_cmp(&book.lines[b].bbox[1]));
        let edge: BTreeSet<usize> = on.iter().take(2).chain(on.iter().rev().take(2)).copied().collect();
        for k in edge {
            seen.entry(masked(&book.lines[k].spelled())).or_default().insert(page);
        }
    }
    seen
}

fn masked(text: &str) -> String {
    DIGITS.replace_all(&text.split(is_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" "), "#").into_owned()
}

/// A folio ("- 13 -") typed as text or a heading is page furniture, whatever A2AJ's words it took.
fn page_folios(book: &mut Book) -> Vec<Value> {
    let mut done = Vec::new();
    for t in 0..book.typed.len() {
        if !matches!(book.region(t), "text" | "heading" | "quote" | "list_item") || book.spans(t).len() != 1 || !book.markers(t).is_empty() {
            continue;
        }
        let Some(line) = book.spans(t)[0]["line_id"].as_str().and_then(|id| book.line(id)) else { continue };
        if !FOLIO.is_match(&line.spelled()) {
            continue;
        }
        let (id, said) = (line.id.clone(), line.spelled());
        book.typed[t]["region"] = json!("page_label");
        book.typed[t]["start"] = json!(true);
        book.set_apart(t);
        done.push(json!({"rule": "typed_folio", "line": id, "text": said, "reason": "a folio typed as text"}));
    }
    book.in_order();
    done
}

/// A running head typed as text or a heading: words printed alike at the head or foot of three pages or more and a fifth
/// of the pages, which no paragraph's words are.
fn running_text(book: &mut Book) -> Vec<Value> {
    let seen = repeated(book);
    let pages = book.lines.iter().map(|line| line.page).collect::<BTreeSet<_>>().len();
    let mut done = Vec::new();
    for t in 0..book.typed.len() {
        if !matches!(book.region(t), "text" | "heading") || !book.markers(t).is_empty() || book.spans(t).len() != 1 {
            continue;
        }
        let Some(line) = book.spans(t)[0]["line_id"].as_str().and_then(|id| book.line(id)) else { continue };
        let key = masked(&line.spelled());
        let stands = seen.get(&key).is_some_and(|on| on.len() >= 3 && on.len() * 5 >= pages && on.contains(&line.page));
        if key.split(' ').count() < 2 || !stands {
            continue;
        }
        let (id, said) = (line.id.clone(), line.spelled().chars().take(70).collect::<String>());
        book.typed[t]["region"] = json!("furniture");
        book.typed[t]["start"] = json!(true);
        book.set_apart(t);
        done.push(json!({"rule": "typed_running_head", "line": id, "text": said, "reason": "a running head typed as text"}));
    }
    book.in_order();
    done
}

#[derive(Clone)]
pub(super) struct Candidate {
    pub(super) place: (i64, f64),
    pub(super) number: u32,
    pub(super) line: usize,
    pub(super) start: usize,
    pub(super) end: usize,
}

/// The longest strictly rising run of candidates.
pub(super) fn rising(found: &[Candidate]) -> Vec<Candidate> {
    let (mut tails, mut tail_at, mut before): (Vec<u32>, Vec<usize>, Vec<Option<usize>>) = (Vec::new(), Vec::new(), vec![None; found.len()]);
    for (i, candidate) in found.iter().enumerate() {
        let k = tails.partition_point(|&n| n < candidate.number);
        if k == tails.len() {
            tails.push(candidate.number);
            tail_at.push(i);
        } else {
            tails[k] = candidate.number;
            tail_at[k] = i;
        }
        before[i] = (k > 0).then(|| tail_at[k - 1]);
    }
    let mut out = Vec::new();
    let mut at = tail_at.last().copied();
    while let Some(i) = at {
        out.push(found[i].clone());
        at = before[i];
    }
    out.reverse();
    out
}

struct Numbers<'a> {
    book: &'a mut Book,
    extent: HashMap<i64, (f64, f64)>,
    numbered_lines: BTreeSet<usize>,
    seen: HashMap<String, BTreeSet<i64>>,
    left: HashMap<i64, f64>,
}

impl Numbers<'_> {
    fn stream(&self, k: usize) -> &'static str {
        let line = &self.book.lines[k];
        if self.book.languages <= 1 {
            return "one";
        }
        let Some(&(a, b)) = self.extent.get(&line.page) else { return "one" };
        if line.bbox[2] < a - 2.0 || line.bbox[0] > b + 2.0 {
            return "margin";
        }
        if (line.bbox[0] + line.bbox[2]) / 2.0 <= (a + b) / 2.0 { "left" } else { "right" }
    }

    fn key(&self, k: usize) -> (i64, bool, f64, f64) {
        let line = &self.book.lines[k];
        (line.page, self.stream(k) == "right", line.bbox[1], line.bbox[0])
    }

    /// The number opens line k: the line typed text with its marker, its unit its paragraph's. The typed line.
    fn opens(&mut self, k: usize, start: usize, end: usize) -> usize {
        let (id, length, page, alone) = {
            let line = &self.book.lines[k];
            (line.id.clone(), line.text.len(), line.page, line.trimmed().chars().count() == end - start)
        };
        let mark = json!([[{"line_id": id, "start": start, "end": end}]]);
        let t = match self.book.typed_on(&id) {
            None => {
                let key = self.key(k);
                let at = (0..self.book.typed.len()).find(|&t| {
                    let first = self.book.spans(t).first().and_then(|s| s["line_id"].as_str()).and_then(|id| self.book.by_id.get(id).copied());
                    first.is_some_and(|f| self.key(f).partial_cmp(&key).is_some_and(|o| o.is_gt()))
                }).unwrap_or(self.book.typed.len());
                let said: String = self.book.lines[k].text[..end].iter().collect();
                let rest: String = self.book.lines[k].text[end..].iter().collect();
                self.book.insert_typed(at, json!({"markers": mark, "page": page, "references": [], "region": "text", "spans": [{"end": length, "line_id": id, "start": 0}],
                                                  "start": true, "text": format!("{said}\t{}", rest.trim_start_matches(is_space))}));
                self.book.units.push(json!({"lines": [at], "starts_document": false}));
                self.book.in_order();
                at
            }
            Some(t) => {
                if !matches!(self.book.region(t), "text") {
                    self.book.set_apart(t);
                }
                let entry = &mut self.book.typed[t];
                entry["region"] = json!("text");
                entry["start"] = json!(true);
                entry["markers"] = mark;
                self.book.split_at(t);
                self.book.in_order();
                t
            }
        };
        if !alone || self.stream(k) == "margin" {
            return t;
        }
        // A number alone on its line: its paragraph's words stand beside or under it.
        let Some(u) = self.book.unit_of(t) else { return t };
        if self.book.members(u).last() != Some(&t) || t + 1 >= self.book.typed.len() {
            return t;
        }
        let next = t + 1;
        if self.book.region(next) != "text" || !self.book.markers(next).is_empty() {
            return t;
        }
        let Some(first) = self.book.spans(next).first().and_then(|s| s["line_id"].as_str()).and_then(|id| self.book.line(id)) else { return t };
        let line = &self.book.lines[k];
        if first.page != line.page || first.bbox[1] - line.bbox[3] >= 2.5 * (line.bbox[3] - line.bbox[1]).max(1.0) {
            return t;
        }
        self.book.split_at(next);
        self.book.in_order();
        if let (Some(a), Some(b)) = (self.book.unit_of(t), self.book.unit_of(next)) {
            if a != b {
                let mut joined = self.book.members(a);
                joined.extend(self.book.members(b));
                self.book.units[a]["lines"] = json!(joined);
                self.book.units[b]["lines"] = json!([]);
                self.book.typed[next]["start"] = json!(false);
                self.book.in_order();
            }
        }
        t
    }

    /// The untyped lines that go on from a number whose words nothing typed, to the next typed or numbered line.
    fn fill(&mut self, t: usize, k: usize) -> usize {
        let Some(u) = self.book.unit_of(t) else { return 0 };
        if self.book.members(u).last() != Some(&t) {
            return 0;
        }
        let typed: BTreeSet<&str> = self.book.typed.iter().flat_map(|e| e["spans"].as_array().into_iter().flatten()).filter_map(|s| s["line_id"].as_str()).collect();
        let mine = self.stream(k);
        let mut order: Vec<usize> = (0..self.book.lines.len()).filter(|&o| mine == "margin" || self.stream(o) == mine).collect();
        order.sort_by(|&a, &b| self.key(a).partial_cmp(&self.key(b)).unwrap_or(std::cmp::Ordering::Equal));
        let Some(at) = order.iter().position(|&o| o == k) else { return 0 };
        let number = self.book.lines[k].bbox;
        let mut adding = Vec::new();
        for &other in &order[at + 1..] {
            let line = &self.book.lines[other];
            if self.numbered_lines.contains(&other) || typed.contains(line.id.as_str()) || line.trimmed().is_empty() {
                break;
            }
            if self.seen.get(&masked(&line.spelled())).is_some_and(|on| on.len() >= 3) {
                continue;
            }
            let same_row = line.page == self.book.lines[k].page && super::page::same_row(&number, &line.bbox);
            let column = self.left.get(&line.page).copied().unwrap_or(number[0]);
            if !same_row && line.bbox[0] > column + INDENT {
                break; // set apart from the column: a quotation, which this reading cannot tell from a list
            }
            adding.push(other);
        }
        let count = adding.len();
        for (n, other) in adding.into_iter().enumerate() {
            let line = &self.book.lines[other];
            let (id, page, length, text) = (line.id.clone(), line.page, line.text.len(), line.spelled());
            let position = t + n + 1;
            self.book.insert_typed(position, json!({"markers": [], "page": page, "references": [], "region": "text", "spans": [{"end": length, "line_id": id, "start": 0}], "start": false, "text": text}));
            let mut lines = self.book.members(u);
            lines.push(position);
            self.book.units[u]["lines"] = json!(lines);
        }
        count
    }
}

/// Each number the judgment prints in its spine's style at its spine's place, walked in order: where a marker stands on
/// another printing (a quotation's, indented; a folio's) it moves to the number at the margin, and a number with no marker
/// takes one, whether its line is untyped, typed as a label, or typed inside the unit of the number before.
fn printed_numbers(book: &mut Book) -> Vec<Value> {
    let Some(spine) = spine_of(book) else { return Vec::new() };
    // (A few plain numbers may be a list its reasons set out; brackets are a judgment's own.)
    if spine.style != "bracket" && spine.marks.iter().map(|m| m.number).collect::<BTreeSet<_>>().len() < 8 {
        return Vec::new();
    }
    let mut extent: HashMap<i64, (f64, f64)> = HashMap::new();
    let mut lefts: HashMap<i64, HashMap<i64, usize>> = HashMap::new();
    for line in &book.lines {
        if line.trimmed().chars().count() >= 20 {
            let entry = extent.entry(line.page).or_insert((f64::MAX, f64::MIN));
            *entry = (entry.0.min(line.bbox[0]), entry.1.max(line.bbox[2]));
        }
        if line.trimmed().chars().count() >= 40 {
            *lefts.entry(line.page).or_default().entry(round3(line.bbox[0])).or_default() += 1;
        }
    }
    let left: HashMap<i64, f64> = lefts.into_iter().map(|(page, counts)| (page, counts.into_iter().max_by_key(|&(x, n)| (n, -x)).unwrap().0 as f64)).collect();
    let seen = repeated(book);
    let mut numbers = Numbers { book, extent, numbered_lines: BTreeSet::new(), seen, left };
    // The numbers the page prints at the margin, by stream.
    let mut streams: BTreeMap<&'static str, Vec<Candidate>> = BTreeMap::new();
    for k in 0..numbers.book.lines.len() {
        let line = &numbers.book.lines[k];
        let said = line.spelled();
        let Some(found) = OPENS.captures(&said) else { continue };
        let whole = found.get(0).unwrap();
        if !said[whole.end()..].chars().next().is_none_or(is_space) {
            continue;
        }
        let marker = found.get(1).unwrap();
        let Some((style, number)) = numbering(marker.as_str()) else { continue };
        let outside = numbers.extent.get(&line.page).is_some_and(|&(left, right)| line.bbox[0] < left - 1.0 || line.bbox[2] > right + 1.0);
        if style != spine.style || !(spine.at_margin(line.page, line.bbox[0]) || spine.alone && outside) || (spine.alone && line.trimmed() != marker.as_str()) {
            continue;
        }
        let start = said[..marker.start()].chars().count();
        let end = said[..marker.end()].chars().count();
        let stream = numbers.stream(k);
        streams.entry(stream).or_default().push(Candidate { place: (line.page, line.bbox[1]), number, line: k, start, end });
    }
    numbers.numbered_lines = streams.values().flatten().map(|c| c.line).collect();
    let mut marked: HashMap<(&'static str, u32), Vec<&Mark>> = HashMap::new();
    for mark in &spine.marks {
        marked.entry((numbers.stream(mark.line), mark.number)).or_default().push(mark);
    }
    let (mut moves, mut adds): (Vec<(u32, usize, Candidate)>, Vec<Candidate>) = (Vec::new(), Vec::new());
    for (&name, found) in streams.iter_mut() {
        found.sort_by(|a, b| a.place.partial_cmp(&b.place).unwrap_or(std::cmp::Ordering::Equal));
        let chain = rising(found);
        let chained: BTreeSet<u32> = chain.iter().map(|c| c.number).collect();
        let top = marked.keys().filter(|key| key.0 == name).map(|key| key.1).max().unwrap_or(0);
        for candidate in chain {
            let number = candidate.number;
            let have = marked.get(&(name, number)).map(Vec::as_slice).unwrap_or(&[]);
            if have.iter().any(|mark| mark.line == candidate.line) {
                continue;
            }
            if let Some(other) = have.first() {
                let line = &numbers.book.lines[other.line];
                let near = (line.page - numbers.book.lines[candidate.line].page).abs() <= 2;
                if near && (other.style != spine.style || !spine.at_margin(line.page, line.bbox[0])) {
                    moves.push((number, other.line, candidate));
                }
                continue;
            }
            let before = number == 1 || chained.contains(&(number - 1)) || marked.contains_key(&(name, number - 1));
            let after = chained.contains(&(number + 1)) || marked.contains_key(&(name, number + 1)) || number > top;
            if before && after && found.iter().filter(|c| c.number == number).count() == 1 {
                adds.push(candidate);
            }
        }
    }
    let mut done = Vec::new();
    for (number, other, candidate) in moves {
        let (other_id, folio) = {
            let line = &numbers.book.lines[other];
            let mut on: Vec<&super::book::PageLine> = numbers.book.lines.iter().filter(|l| l.page == line.page).collect();
            on.sort_by(|a, b| a.bbox[1].total_cmp(&b.bbox[1]));
            let edge = on.iter().take(2).chain(on.iter().rev().take(2)).any(|l| l.id == line.id);
            (line.id.clone(), edge && numbering(&line.trimmed()).is_some_and(|read| read.0 == "bare"))
        };
        let printing = if folio { "folio" } else { "quotation" };
        let Some(t) = numbers.book.typed_on(&other_id) else { continue };
        numbers.book.typed[t]["markers"] = json!([]);
        if printing == "folio" {
            numbers.book.typed[t]["region"] = json!("page_label");
            numbers.book.typed[t]["start"] = json!(true);
            numbers.book.set_apart(t);
        } else if let Some(u) = numbers.book.unit_of(t) {
            for member in numbers.book.members(u) {
                numbers.book.typed[member]["region"] = json!("quote");
            }
        }
        numbers.book.in_order();
        let at = numbers.opens(candidate.line, candidate.start, candidate.end);
        let filled = numbers.fill(at, candidate.line);
        let to = numbers.book.lines[candidate.line].id.clone();
        done.push(json!({"rule": "number_at_margin", "number": number, "from": other_id, "to": to, "printing": printing, "filled": filled,
                         "reason": format!("number {number} stood on a {printing}'s printing; the margin prints it at {to}")}));
    }
    for candidate in adds {
        let id = numbers.book.lines[candidate.line].id.clone();
        let was = numbers.book.typed_on(&id).map(|t| numbers.book.region(t).to_owned());
        let at = numbers.opens(candidate.line, candidate.start, candidate.end);
        let filled = numbers.fill(at, candidate.line);
        done.push(json!({"rule": "number_printed", "number": candidate.number, "line": id, "was": was, "filled": filled,
                         "reason": format!("the page prints {} at the margin and the gold had no marker for it", candidate.number)}));
    }
    done
}

/// Numbers printed as tiny images beside the lines they open, in no text layer: each image's line takes its number back, the
/// nth in reading order printing n. Only where every image's line opens a text unit that has no marker: a line already
/// numbered, or an image beside anything else, says these are not such numbers.
fn image_numbers(book: &mut Book, images: &[PageImages]) -> Vec<Value> {
    let sizes: Vec<(usize, f64, f64, usize)> = images.iter().enumerate().flat_map(|(page, on)| {
        let book = &*book;
        on.boxes.iter().filter(|b| b[2] - b[0] < 40.0 && b[3] - b[1] < 30.0).filter_map(move |b| {
            let middle = (b[1] + b[3]) / 2.0;
            let beside = book.lines.iter().enumerate()
                .filter(|(_, line)| line.page == page as i64 + 1 && line.bbox[1] <= middle && middle <= line.bbox[3] && line.bbox[0] >= b[2] - 2.0)
                .min_by(|(_, a), (_, c)| a.bbox[0].total_cmp(&c.bbox[0]))?;
            Some((page, b[1], b[0], beside.0))
        }).collect::<Vec<_>>()
    }).collect();
    let mut hits = sizes;
    hits.sort_by(|a, b| (a.0, a.1).partial_cmp(&(b.0, b.1)).unwrap_or(std::cmp::Ordering::Equal));
    if hits.len() < 5 {
        return Vec::new();
    }
    let opens: BTreeSet<usize> = (0..book.units.len()).filter_map(|u| book.members(u).first().copied()).collect();
    for hit in &hits {
        let Some(t) = book.typed_on(&book.lines[hit.3].id) else { return Vec::new() };
        if !opens.contains(&t) || book.region(t) != "text" || !book.markers(t).is_empty() || OPENS.is_match(&book.lines[hit.3].spelled()) {
            return Vec::new();
        }
    }
    let mut done = Vec::new();
    for (index, hit) in hits.iter().enumerate() {
        let number = index + 1;
        let label = format!("[{number}]");
        let by = label.chars().count() + 1;
        let id = book.lines[hit.3].id.clone();
        for entry in &mut book.typed {
            shift(entry, &id, by);
        }
        let t = book.typed_on(&id).unwrap();
        book.typed[t]["spans"][0]["start"] = json!(0);
        book.typed[t]["text"] = json!(format!("{label} {}", book.typed[t]["text"].as_str().unwrap_or("")));
        book.typed[t]["markers"] = json!([[{"end": label.chars().count(), "line_id": id, "start": 0}]]);
        let line = &mut book.lines[hit.3];
        let mut text: Vec<char> = format!("{label} ").chars().collect();
        text.append(&mut line.text);
        line.text = text;
        line.bbox[0] = (hit.2 * 1000.0).round() / 1000.0;
        done.push(json!({"rule": "number_printed_as_image", "line": id, "number": number, "reason": "a number printed as an image, in no text layer"}));
    }
    done
}

fn shift(value: &mut Value, line: &str, by: usize) {
    match value {
        Value::Object(map) => {
            if map.get("line_id").and_then(Value::as_str) == Some(line) && map.get("start").is_some_and(Value::is_u64) {
                for key in ["start", "end"] {
                    let moved = map[key].as_u64().unwrap() as usize + by;
                    map[key] = json!(moved);
                }
            }
            map.values_mut().for_each(|item| shift(item, line, by));
        }
        Value::Array(items) => items.iter_mut().for_each(|item| shift(item, line, by)),
        _ => {}
    }
}

/// Whether a stretch of a page's lines stands apart: more than a line's pitch from the lines above and below it in its column.
struct Spacing {
    above: HashMap<usize, f64>,
    below: HashMap<usize, f64>,
    pitch: f64,
}

impl Spacing {
    fn of(book: &Book) -> Spacing {
        let mut columns: BTreeMap<(i64, bool), Vec<usize>> = BTreeMap::new();
        let mut extent: HashMap<i64, (f64, f64)> = HashMap::new();
        for line in book.lines.iter().filter(|line| line.trimmed().chars().count() >= 20) {
            let entry = extent.entry(line.page).or_insert((f64::MAX, f64::MIN));
            *entry = (entry.0.min(line.bbox[0]), entry.1.max(line.bbox[2]));
        }
        for (k, line) in book.lines.iter().enumerate() {
            let right = book.languages > 1 && extent.get(&line.page).is_some_and(|&(a, b)| (line.bbox[0] + line.bbox[2]) / 2.0 > (a + b) / 2.0);
            columns.entry((line.page, right)).or_default().push(k);
        }
        let (mut above, mut below, mut steps): (HashMap<usize, f64>, HashMap<usize, f64>, Vec<f64>) = (HashMap::new(), HashMap::new(), Vec::new());
        for mut lines in columns.into_values() {
            lines.sort_by(|&a, &b| book.lines[a].bbox[1].total_cmp(&book.lines[b].bbox[1]));
            for pair in lines.windows(2) {
                let step = book.lines[pair[1]].bbox[1] - book.lines[pair[0]].bbox[1];
                below.insert(pair[0], step);
                above.insert(pair[1], step);
                if step > 1.0 {
                    steps.push(step);
                }
            }
        }
        steps.sort_by(f64::total_cmp);
        Spacing { above, below, pitch: steps.get(steps.len() / 2).copied().unwrap_or(f64::MAX) }
    }

    fn apart(&self, first: usize, last: usize) -> bool {
        self.above.get(&first).is_some_and(|&step| step >= 1.5 * self.pitch) && self.below.get(&last).is_some_and(|&step| step >= 1.3 * self.pitch)
    }
}

/// A heading typed as text: a unit of a line or two between two numbered paragraphs, unmarked but for a heading's own letter or
/// numeral, a few words with no closing punctuation, set in bold or capitals or apart from the lines around it (the print's own
/// evidence; A2AJ's reading says prose). The same words at the foot of a paragraph's unit, after a line that closes its sentence,
/// are cut from it first: A2AJ ran the heading into the paragraph.
fn typed_headings(book: &mut Book, styled: &HashMap<String, (bool, bool)>) -> Vec<Value> {
    let Some(spine) = spine_of(book) else { return Vec::new() };
    let places: Vec<usize> = spine.marks.iter().map(|m| m.typed).collect();
    let (Some(&first), Some(&last)) = (places.iter().min(), places.iter().max()) else { return Vec::new() };
    let bold_line = |book: &Book, t: usize| book.spans(t).iter().all(|span| span["line_id"].as_str().and_then(|id| styled.get(id)).is_some_and(|&(bold, _)| bold));
    for u in (0..book.units.len()).rev() {
        let members = book.members(u);
        let count = members.iter().rev().take(2).take_while(|&&t| bold_line(book, t) && book.region(t) == "text" && book.markers(t).is_empty()).count();
        if count == 0 || count >= members.len() {
            continue;
        }
        let at = members[members.len() - count];
        let closed = book.typed[members[members.len() - count - 1]]["text"].as_str().unwrap_or("").trim_end_matches(is_space).ends_with(['.', ':', ';', '?', '!', '\u{201d}', '"', ')']);
        if closed {
            book.split_at(at);
        }
    }
    book.in_order();
    let spacing = Spacing::of(book);
    let mut done = Vec::new();
    for u in 0..book.units.len() {
        let members = book.members(u);
        let Some(&head) = members.first() else { continue };
        let numbered = members.iter().any(|&t| book.markers(t).iter().any(|mark| book.printed(mark).is_none_or(|(said, _)| numbering(&said).is_some())));
        if head <= first || head >= last || members.len() > 2 || book.regions(u) != BTreeSet::from(["text".to_owned()]) || numbered {
            continue;
        }
        let said = book.unit_text(&book.units[u]);
        let words = said.split(is_space).filter(|w| !w.is_empty()).count();
        let bold = members.iter().all(|&t| bold_line(book, t));
        // (A bold line may close on a colon: "(ii) Ability of the accused to retain counsel:".)
        if words == 0 || words > 12 || said.ends_with(['.', ';', ',', '?', '!']) || !bold && said.ends_with(':') || (!bold && SPOKEN.is_match(&said)) || NOT_HEADING.is_match(&said) {
            continue;
        }
        let set = members.iter().all(|&t| book.spans(t).iter().all(|span| {
            let (Some(id), letters) = (span["line_id"].as_str(), said.chars().filter(|c| c.is_alphabetic()).collect::<Vec<_>>()) else { return false };
            styled.get(id).is_some_and(|&(bold, _)| bold) || letters.len() >= 3 && letters.iter().all(|c| c.is_uppercase())
        }));
        let at_line = |t: usize| book.spans(t).first().and_then(|span| span["line_id"].as_str()).and_then(|id| book.by_id.get(id).copied());
        let apart = at_line(head).zip(members.last().and_then(|&t| at_line(t))).is_some_and(|(top, bottom)| spacing.apart(top, bottom));
        if !set && !apart {
            continue;
        }
        for &t in &members {
            book.typed[t]["region"] = json!("heading");
        }
        done.push(json!({"rule": "typed_heading", "unit": u, "text": said.chars().take(70).collect::<String>(), "reason": "a heading typed as text"}));
    }
    done
}

/// A line on the row of its page's furniture at the page's head, above the page's body, is furniture itself: a report's
/// running head changes with the judge ("Le juge McLachlin") and repeats too little to be found by its words.
fn head_rows(book: &mut Book) -> Vec<Value> {
    let mut furniture: HashMap<i64, Vec<[f64; 4]>> = HashMap::new();
    for t in 0..book.typed.len() {
        if matches!(book.region(t), "furniture" | "page_label") {
            for span in book.spans(t) {
                if let Some(line) = span["line_id"].as_str().and_then(|id| book.line(id)) {
                    furniture.entry(line.page).or_default().push(line.bbox);
                }
            }
        }
    }
    let mut done = Vec::new();
    for t in 0..book.typed.len() {
        if !matches!(book.region(t), "text" | "heading") || !book.markers(t).is_empty() || book.spans(t).len() != 1 {
            continue;
        }
        let Some(line) = book.spans(t)[0]["line_id"].as_str().and_then(|id| book.line(id)) else { continue };
        let Some(row) = furniture.get(&line.page).filter(|row| row.iter().any(|b| super::page::same_row(b, &line.bbox))) else { continue };
        let top = book.lines.iter().filter(|other| other.page == line.page).map(|other| other.bbox[1]).fold(f64::MAX, f64::min);
        let below = book.lines.iter().filter(|other| other.page == line.page && other.bbox[1] > line.bbox[3]).map(|other| other.bbox[1]).fold(f64::MAX, f64::min);
        let height = (line.bbox[3] - line.bbox[1]).max(1.0);
        if row.is_empty() || line.bbox[1] - top > height || below - line.bbox[3] < height {
            continue;
        }
        let (id, said) = (line.id.clone(), line.spelled().chars().take(70).collect::<String>());
        let region = if super::page::number_like(&said) { "page_label" } else { "furniture" };
        book.typed[t]["region"] = json!(region);
        book.typed[t]["start"] = json!(true);
        book.set_apart(t);
        done.push(json!({"rule": "typed_running_head", "line": id, "text": said, "reason": "a line on the row of the page's furniture"}));
    }
    book.in_order();
    done
}

/// Two units of a parallel report whose last lines the alignment crossed: on one page the unit running down the left column
/// ends in the right, and the other the other way. Each takes its own column's lines back.
fn crossed_columns(book: &mut Book) -> Vec<Value> {
    if book.languages <= 1 {
        return Vec::new();
    }
    let mut extent: HashMap<i64, (f64, f64)> = HashMap::new();
    for line in book.lines.iter().filter(|line| line.trimmed().chars().count() >= 20) {
        let entry = extent.entry(line.page).or_insert((f64::MAX, f64::MIN));
        *entry = (entry.0.min(line.bbox[0]), entry.1.max(line.bbox[2]));
    }
    let side = |book: &Book, t: usize| -> Option<(i64, bool, f64)> {
        let line = book.spans(t).first().and_then(|s| s["line_id"].as_str()).and_then(|id| book.line(id))?;
        let &(a, b) = extent.get(&line.page)?;
        Some((line.page, (line.bbox[0] + line.bbox[2]) / 2.0 > (a + b) / 2.0, line.bbox[1]))
    };
    let mut done = Vec::new();
    for u in 0..book.units.len().saturating_sub(1) {
        for v in u + 1..(u + 3).min(book.units.len()) {
            if book.regions(u) != BTreeSet::from(["text".to_owned()]) || book.regions(v) != BTreeSet::from(["text".to_owned()]) {
                continue;
            }
            let (first, second) = (book.members(u), book.members(v));
            // Each unit's lines on the page where it holds both columns.
            let split = |lines: &[usize], page: i64, right: bool| -> Vec<usize> {
                lines.iter().copied().filter(|&t| side(book, t).is_some_and(|s| s.0 == page && s.1 == right)).collect()
            };
            let Some((page, _, _)) = first.last().and_then(|&t| side(book, t)) else { continue };
            let (own_left, tail_right) = (split(&first, page, false), split(&first, page, true));
            let (tail_left, own_right) = (split(&second, page, false), split(&second, page, true));
            if own_left.is_empty() || tail_right.is_empty() || tail_left.is_empty() || own_right.is_empty() {
                continue;
            }
            let high = |lines: &[usize], pick: fn(f64, f64) -> f64, from: f64| lines.iter().filter_map(|&t| side(book, t)).map(|s| s.2).fold(from, pick);
            // The left column goes on from the first unit, the right from the second.
            if high(&own_left, f64::max, f64::MIN) >= high(&tail_left, f64::min, f64::MAX) || high(&own_right, f64::max, f64::MIN) >= high(&tail_right, f64::min, f64::MAX) {
                continue;
            }
            let without = |lines: &[usize], gone: &[usize]| lines.iter().copied().filter(|t| !gone.contains(t)).collect::<Vec<_>>();
            let (mut a, mut b) = (without(&first, &tail_right), without(&second, &tail_left));
            a.extend(&tail_left);
            b.extend(&tail_right);
            a.sort_unstable();
            b.sort_unstable();
            let moved = tail_left.len() + tail_right.len();
            book.units[u]["lines"] = json!(a);
            book.units[v]["lines"] = json!(b);
            done.push(json!({"rule": "crossed_columns", "unit": u, "other": v, "lines": moved, "reason": "two units' last lines crossed between the columns"}));
        }
    }
    book.in_order();
    done
}

/// A note's call printed on a row of its own ("[4]" after a heading): in the spine's form, but behind the count where it
/// stands, with the next number following at once. A label, no paragraph.
fn note_calls(book: &mut Book) -> Vec<Value> {
    let Some(spine) = spine_of(book) else { return Vec::new() };
    let mut placed: Vec<(usize, u32)> = (0..book.typed.len()).flat_map(|t| book.markers(t).iter().filter_map(move |mark| Some((t, mark))).collect::<Vec<_>>())
        .filter(|(t, _)| book.region(*t) == "text").filter_map(|(t, mark)| Some((t, numbering(&book.printed(mark)?.0)?.1))).collect();
    placed.sort_unstable();
    let mut done = Vec::new();
    for t in 0..book.typed.len() {
        if book.region(t) != "text" || !book.markers(t).is_empty() || book.spans(t).len() != 1 {
            continue;
        }
        let Some(line) = book.spans(t)[0]["line_id"].as_str().and_then(|id| book.line(id)) else { continue };
        let Some((style, number)) = numbering(&line.trimmed()) else { continue };
        let before = placed.iter().rev().find(|p| p.0 < t).map(|p| p.1);
        if style != spine.style || !before.is_some_and(|n| number + 1 < n) || placed.iter().find(|p| p.0 > t).is_none_or(|p| p.0 > t + 1) {
            continue;
        }
        let (id, said) = (line.id.clone(), line.trimmed());
        book.typed[t]["region"] = json!("line_label");
        book.typed[t]["start"] = json!(true);
        book.set_apart(t);
        done.push(json!({"rule": "note_call_row", "line": id, "text": said, "reason": "a note's call on a row of its own, behind the count"}));
    }
    book.in_order();
    done
}

/// The numbers a report prints alone in its margin, out of its page's text, rising down the pages and dense enough to be a
/// count: the judgment's own, whatever A2AJ's text carries. Each marks its line, which takes a typed line if it has none; the
/// units opening on its row take it from `margin_numbers`. A transcript's line numbers are too sparse for a count.
fn margin_spine(book: &mut Book) -> Vec<Value> {
    let mut extent: HashMap<i64, (f64, f64)> = HashMap::new();
    let mut top: HashMap<i64, f64> = HashMap::new();
    for line in &book.lines {
        let least = top.entry(line.page).or_insert(f64::MAX);
        *least = least.min(line.bbox[1]);
        if line.trimmed().chars().count() >= 20 {
            let entry = extent.entry(line.page).or_insert((f64::MAX, f64::MIN));
            *entry = (entry.0.min(line.bbox[0]), entry.1.max(line.bbox[2]));
        }
    }
    let mut found: Vec<Candidate> = (0..book.lines.len()).filter_map(|k| {
        let line = &book.lines[k];
        let (style, number) = numbering(&line.trimmed())?;
        let &(left, right) = extent.get(&line.page)?;
        let outside = line.bbox[0] < left - 1.0 || line.bbox[2] > right + 1.0;
        (style == "bare" && outside && line.bbox[1] > top[&line.page] + 20.0).then(|| {
            let start = line.text.iter().position(|c| !is_space(*c)).unwrap_or(0);
            Candidate { place: (line.page, line.bbox[1]), number, line: k, start, end: start + line.trimmed().chars().count() }
        })
    }).collect();
    found.sort_by(|a, b| a.place.partial_cmp(&b.place).unwrap_or(std::cmp::Ordering::Equal));
    let chain = rising(&found);
    let Some(last) = chain.last().map(|candidate| candidate.number as usize) else { return Vec::new() };
    if chain.len() < 3 || chain.len() * 10 < last * 6 {
        return Vec::new();
    }
    let mut done = Vec::new();
    for candidate in chain {
        let (id, page, length) = (book.lines[candidate.line].id.clone(), book.lines[candidate.line].page, book.lines[candidate.line].text.len());
        let mark = json!([[{"line_id": id, "start": candidate.start, "end": candidate.end}]]);
        let said = format!("{}\t", candidate.number);
        match book.typed_on(&id) {
            None => {
                let at = (0..book.typed.len()).find(|&t| book.spans(t).first().and_then(|s| s["line_id"].as_str()).and_then(|id| book.by_id.get(id)).is_some_and(|&k| k > candidate.line)).unwrap_or(book.typed.len());
                book.insert_typed(at, json!({"markers": mark, "page": page, "references": [], "region": "text", "spans": [{"end": length, "line_id": id, "start": 0}], "start": true, "text": said}));
                book.units.push(json!({"lines": [at], "starts_document": false}));
            }
            Some(t) if book.markers(t).is_empty() && matches!(book.region(t), "text" | "page_label" | "furniture") => {
                let entry = &mut book.typed[t];
                entry["region"] = json!("text");
                entry["start"] = json!(true);
                entry["markers"] = mark;
                entry["text"] = json!(said);
                book.set_apart(t);
            }
            Some(_) => continue,
        }
        book.in_order();
        done.push(json!({"rule": "margin_spine", "number": candidate.number, "line": id, "reason": "a number printed in the margin that no marker took"}));
    }
    done
}

/// Numbers in reasons the judgment does not number are a list it sets out (an order's terms, the grounds of appeal), as its
/// answer key says: their units are list items, not paragraphs.
pub fn set_out_lists(book: &mut Book) -> Vec<Value> {
    let numbered: BTreeSet<usize> = (0..book.typed.len()).filter(|&t| book.region(t) == "text" && book.markers(t).iter().any(|mark| book.printed(mark).is_some_and(|(said, _)| numbering(&said).is_some())))
        .filter_map(|t| book.unit_of(t)).collect();
    let mut done = Vec::new();
    for u in numbered {
        let said = book.unit_text(&book.units[u]).chars().take(70).collect::<String>();
        for t in book.members(u) {
            if book.region(t) == "text" {
                book.typed[t]["region"] = json!("list_item");
            }
        }
        done.push(json!({"rule": "set_out_list", "unit": u, "text": said, "reason": "a list in reasons the judgment does not number, typed as numbered paragraphs"}));
    }
    done
}

/// A folio's number where the recognizer misread it ("4H2", "4082" for 402): a folio's line keeps its reading, the gold its
/// page's number. That number is A2AJ's page mark for the page ("[Page 402]" before its first words; a page two marks give
/// two numbers has none), else the count its folios run: the folios read nearest before and after it, which agree on it
/// (or, at the document's ends, the two nearest on its one side). `breaks`: the record's `page_breaks`, {language: [mark, ...]}.
fn marked_page_labels(book: &mut Book, breaks: &Value) -> Vec<Value> {
    let mut marked: HashMap<i64, Option<String>> = HashMap::new();
    for mark in breaks.as_object().into_iter().flat_map(|all| all.values()).filter_map(Value::as_array).flatten() {
        if let (Some(number), Some(page)) = (mark["page"].as_str().map(str::trim), mark["pdf"]["page"].as_i64()) {
            let slot = marked.entry(page).or_insert_with(|| Some(number.to_owned()));
            if slot.as_deref() != Some(number) {
                *slot = None;
            }
        }
    }
    // each folio: its entry, its page, and the number it reads (its first run of digits)
    let folios: Vec<(usize, i64, Option<i64>)> = (0..book.typed.len()).filter(|&t| book.region(t) == "page_label")
        .filter_map(|t| Some((t, book.typed[t]["page"].as_i64()?, DIGITS.find(book.typed[t]["text"].as_str().unwrap_or("")).and_then(|found| found.as_str().parse().ok()))))
        .collect();
    // the count the folios read nearest a page run to (the folio's number less its page), on one side of it
    let offsets = |page: i64, later: bool| -> Vec<i64> {
        let mut side: Vec<(i64, i64)> = folios.iter().filter(|f| if later { f.1 > page } else { f.1 < page }).filter_map(|f| Some((f.1, f.2? - f.1))).collect();
        side.sort_by_key(|&(at, _)| (at - page).abs());
        side.into_iter().map(|(_, offset)| offset).take(2).collect()
    };
    let mut done = Vec::new();
    for &(t, page, read) in &folios {
        let said = book.typed[t]["text"].as_str().unwrap_or("").to_owned();
        let number = match marked.get(&page) {
            Some(Some(number)) => Some(number.clone()),
            _ if read.is_none() && !said.chars().any(|c| c.is_ascii_digit()) => None, // a roman folio, a letter's: not a count's
            _ => {
                let (before, after) = (offsets(page, false), offsets(page, true));
                let run = match (before.first(), after.first()) {
                    (Some(b), Some(a)) if a == b => Some(*a),
                    (Some(b), None) if before.len() == 2 && before[1] == *b => Some(*b),
                    (None, Some(a)) if after.len() == 2 && after[1] == *a => Some(*a),
                    _ => None,
                };
                run.map(|offset| (page + offset).to_string())
            }
        };
        let Some(number) = number else { continue };
        if read.is_some() && read == number.parse().ok() {
            continue;
        }
        book.typed[t]["text"] = json!(number);
        done.push(json!({"rule": "marked_page_label", "page": book.typed[t]["page"], "text": said, "label": number, "reason": "a misread folio: its page's number as A2AJ's page mark or its folios' count gives it"}));
    }
    done
}

/// Every rule over one gold. `images`: the PDF's pages' images; `styled`: {line id: (bold, italic)} and `breaks` (its
/// page marks) from its record.
pub fn apply(book: &mut Book, images: &[PageImages], styled: &HashMap<String, (bool, bool)>, breaks: &Value) -> Vec<Value> {
    let mut done = image_numbers(book, images);
    done.extend(page_folios(book));
    done.extend(running_text(book));
    done.extend(head_rows(book));
    done.extend(crossed_columns(book));
    done.extend(margin_spine(book));
    done.extend(printed_numbers(book));
    done.extend(note_calls(book));
    done.extend(typed_headings(book, styled));
    done.extend(marked_page_labels(book, breaks));
    done
}

/// A gold's own check against its page, after the rules: each marker's number and where it stands.
pub fn marks_of(book: &Book) -> Vec<(u32, String)> {
    (0..book.typed.len()).filter(|&t| book.region(t) == "text").flat_map(|t| book.markers(t).iter().filter_map(|mark| {
        let (said, line) = book.printed(mark)?;
        Some((numbering(&said)?.1, line.id.clone()))
    }).collect::<Vec<_>>()).collect()
}
