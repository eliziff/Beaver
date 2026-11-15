//! One record per PDF: its lines aligned with A2AJ's text of the decision in each language it holds, and what the
//! alignment leaves unplaced, and why.
use super::page::{column_order, furniture, in_gutter, margin, two_columns, Bbox, Placed, Sizes, DEFAULT_PAGE};
use super::pairing::{Input, Pairing, WordPair, LEADING, MIN_RESEMBLANCE, TRAILING};
use super::words::{is_space, plain, similarity, strip, Token, Words};
use regex::Regex;
use rusqlite::{types::Value as Sql, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

fn hashed(sources: &[&str]) -> String {
    let mut hash = Sha256::new();
    for source in sources {
        hash.update(source);
    }
    hash.finalize().iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// What a record is stamped with: a change to the alignment's own code, and no other, makes a record stale.
pub static CODE: LazyLock<String> = LazyLock::new(|| hashed(&[include_str!("page.rs"), include_str!("pairing.rs"), include_str!("record.rs"), include_str!("words.rs")]));
/// What a gold's receipt is stamped with besides its reading: a gold this labelling made from the same reading is not made again.
pub static LABEL_CODE: LazyLock<String> = LazyLock::new(|| {
    hashed(&[include_str!("book.rs"), include_str!("conventions.rs"), include_str!("label.rs"), include_str!("make.rs"), include_str!("printed.rs"), include_str!("freeze.rs")])
});
const PRINTED: f64 = 0.1; // a language whose text the PDF places less of than this is not printed in it
const COVERAGE: f64 = 0.8; // a record aligns when its PDF places this share of each language it prints
const JS_SPACE: &[char] = &[
    '\t', '\n', '\x0b', '\x0c', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}',
    '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}', '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
];

static PREAMBLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A(?:\n[^\n]*){0,4}?\nDate ?: ?\d{4}-\d\d-\d\d[ \t]*\n").unwrap());
static COVER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A[\s\x1c-\x1f]*(?:SUPREME COURT OF CANADA|COUR SUPRÊME DU CANADA)\n(?:Citation|Référence) ?: ?([^\n]+)\n").unwrap()
});
static COVER_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A[\s\x1c-\x1f]*(?:Citation|Référence)[\s\x1c-\x1f]*:").unwrap());
static PAGE_MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[Page (\d+)\]").unwrap());
static NOTE_CALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\s\x1c-\x1f]\[\d+\]").unwrap());
static DIGIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A\d+\z").unwrap());
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\[?(\d+)\]?").unwrap());
// What A2AJ's text of a tribunal's web page carries that no PDF prints: its notes' labels ("Footnote 35", "Note de bas de page
// 2"), their heading, and the page's table of contents ("On this page Decision Overview Issue Analysis Conclusion").
static WEB_MATTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)\A(?:(?:Footnotes?|Notes? de bas de page)(?:\s+\d+)?|(?:On this page|Sur cette page)\b.*)\z").unwrap()
});
static LINE_LETTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A[a-j]\z").unwrap());

/// A decision's text as the census read it: its JavaScript white space trimmed, so the listing's offsets hold.
pub fn trimmed(text: &str) -> &str {
    text.trim_matches(JS_SPACE)
}

/// Where A2AJ's notes begin, in characters: the decision's notes come after its reasons, from the last "[1] " opening a
/// line, where the reasons call notes ("word[1]").
pub fn notes_start(text: &str) -> Option<usize> {
    let byte = if NOTE_CALL.is_match(text) { text.rfind("\n[1] ") } else { None }?;
    Some(text[..byte].chars().count() + 1)
}

/// Where the decision proper begins, in bytes: after A2AJ's metadata block, and the preamble it generates under it (the
/// court, the style of cause and its citation, the date: a few lines ending in `Date: YYYY-MM-DD`).
pub fn start_of(text: &str, language: &str) -> usize {
    let marker = if language == "en" { "Decision Content" } else { "Contenu de la décision" };
    let at = text.find(marker).map_or(0, |at| at + marker.len());
    PREAMBLE.find(&text[at..]).map_or(at, |m| at + m.end() - 1)
}

/// A language's text and its reading.
struct Source {
    language: &'static str,
    text: String,
    chars: Vec<char>,
    begin: usize,
    title_end: Option<usize>,
    tokens: Vec<Token>,   // the words from where the decision begins
    decision: Vec<Token>, // the same words without A2AJ's page marks
    marks: Vec<Mark>,
}

/// `[Page 1199]`: where the report's page turns, which the print shows as a page break, not as words.
struct Mark {
    start: u32,
    end: u32,
    number_at: u32,
    page: String,
}

impl Source {
    fn new(language: &'static str, text: String, words: &mut Words) -> Source {
        let chars: Vec<char> = text.chars().collect();
        let byte = start_of(&text, language);
        let begin = text[..byte].chars().count();
        let tokens = words.of(&text, byte, begin);
        let (mut at_byte, mut at_char) = (0, 0);
        let marks: Vec<Mark> = PAGE_MARK
            .captures_iter(&text)
            .map(|c| {
                let (whole, number) = (c.get(0).unwrap(), c.get(1).unwrap());
                let start = at_char + text[at_byte..whole.start()].chars().count() as u32;
                (at_byte, at_char) = (whole.end(), start + whole.as_str().chars().count() as u32);
                Mark { start, end: at_char, number_at: start + "[Page ".len() as u32, page: number.as_str().to_owned() }
            })
            .collect();
        let decision: Vec<Token> = tokens
            .iter()
            .filter(|token| {
                let k = marks.partition_point(|mark| mark.start <= token.start);
                !(k > 0 && token.start < marks[k - 1].end)
            })
            .copied()
            .collect();
        let title_end = (begin + 1..chars.len()).find(|&at| chars[at] == '\n');
        Source { language, text, chars, begin, title_end, tokens, decision, marks }
    }

    /// The span of the court's cover page where A2AJ's text opens with it (the Supreme Court's own version: its citation,
    /// date, docket, parties, coram and who gave reasons, up to the style of cause, which repeats the citation) and the
    /// PDF does not print it (the report's version has no `Citation:` line on its first pages).
    fn cover(&self, lines: &[Line]) -> Option<[u32; 2]> {
        let byte = self.text.char_indices().nth(self.begin).map_or(self.text.len(), |(at, _)| at);
        let head = COVER.captures(&self.text[byte..])?;
        let after = byte + head.get(0).unwrap().end();
        let end = after + self.text[after..].find(&format!("\n{}", strip(&head[1])))?;
        let printed = lines.iter().any(|line| line.page <= 2 && COVER_LINE.is_match(&line.text));
        (!printed).then(|| [self.begin as u32, self.text[..end].chars().count() as u32 + 1])
    }
}

#[derive(Deserialize, Clone)]
pub struct Reading {
    pub pages: Vec<RawPage>,
}

#[derive(Deserialize, Clone)]
pub struct RawPage {
    pub number: i64,
    pub width: Option<f64>,
    pub height: Option<f64>,
    source: Option<String>,
    pub lines: Vec<RawLine>,
}

#[derive(Deserialize, Clone)]
pub struct RawLine {
    id: String,
    pub text: String,
    pub bbox: Bbox,
    #[serde(default)]
    reading_order: i64,
    spans: Option<Vec<RawSpan>>,
    words: Option<Vec<RawWord>>,
    source: Option<String>,
}

#[derive(Deserialize, Clone)]
struct RawSpan {
    #[serde(default)]
    start: i64,
    #[serde(default)]
    end: i64,
    font: Option<String>,
    #[serde(default)]
    flags: i64,
    size: Option<f64>,
}

#[derive(Deserialize, Clone)]
struct RawWord {
    start: i64,
    end: i64,
    bbox: Bbox,
}

#[derive(Serialize)]
pub struct Line {
    id: String,
    page: i64,
    text: String,
    bbox: Bbox,
    source: Option<String>,
    boxes: Vec<(i64, i64, f64, f64, f64, f64)>,
    bold: bool,
    italic: bool,
    size: Value,
    status: &'static str,
    exact: Option<String>,
    span: Option<[u32; 2]>,
    lang: Option<&'static str>,
    words: Vec<WordPair>,
    #[serde(skip_serializing_if = "Option::is_none")]
    why: Option<String>,
    /// The reading's line this one is a column's half of.
    #[serde(skip_serializing_if = "Option::is_none")]
    of: Option<Whole>,
    #[serde(skip)]
    tokens: Vec<Token>,
}

/// A line the recognizer ran across a page's columns, as the reading has it, and where in it a half begins.
#[derive(Serialize, Clone)]
struct Whole {
    id: String,
    at: usize,
    text: String,
    bbox: Bbox,
}

/// A line's type style, from its spans: most of its characters bold or italic, and the size most of them are set in.
fn style(spans: &[RawSpan]) -> (bool, bool, Value) {
    let (mut bold, mut italic, mut total) = (0i64, 0i64, 0i64);
    let mut sizes: Vec<(f64, i64)> = Vec::new();
    for span in spans {
        let n = (span.end - span.start).max(1);
        total += n;
        let font = span.font.as_deref().unwrap_or("").to_lowercase();
        if span.flags & 16 != 0 || font.contains("bold") || font.contains("black") || font.contains("heavy") {
            bold += n;
        }
        if span.flags & 2 != 0 || font.contains("italic") || font.contains("oblique") {
            italic += n;
        }
        let size = (span.size.unwrap_or(0.0) * 2.0).round_ties_even() / 2.0;
        match sizes.iter_mut().find(|entry| entry.0 == size) {
            Some(entry) => entry.1 += n,
            None => sizes.push((size, n)),
        }
    }
    let mut size = json!(0);
    let mut most = i64::MIN;
    for &(value, count) in &sizes {
        if count > most {
            (size, most) = (json!(value), count);
        }
    }
    (total > 0 && bold as f64 > 0.6 * total as f64, total > 0 && italic as f64 > 0.6 * total as f64, size)
}

/// A reading's lines in reading order, and its pages' sizes in the reading's order.
fn lines_of(reading: Reading, words: &mut Words) -> Result<(Vec<Line>, Vec<(i64, (f64, f64))>), String> {
    let (mut lines, mut pages, mut ids) = (Vec::new(), Vec::new(), HashSet::new());
    for page in reading.pages {
        let size = (page.width.filter(|&w| w != 0.0).unwrap_or(DEFAULT_PAGE.0), page.height.filter(|&h| h != 0.0).unwrap_or(DEFAULT_PAGE.1));
        pages.push((page.number, size));
        let mut raw = page.lines;
        raw.sort_by_key(|line| line.reading_order);
        for line in raw {
            if !ids.insert(line.id.clone()) {
                return Err(format!("two lines numbered {}", line.id));
            }
            if strip(&line.text).is_empty() {
                continue;
            }
            let (bold, italic, size) = style(line.spans.as_deref().unwrap_or(&[]));
            let source = line.source.filter(|source| !source.is_empty()).or_else(|| page.source.clone());
            let boxes = line.words.unwrap_or_default().iter().map(|w| (w.start, w.end, w.bbox[0], w.bbox[1], w.bbox[2], w.bbox[3])).collect();
            let tokens = words.of_line(&line.text);
            lines.push(Line {
                id: line.id,
                page: page.number,
                text: line.text,
                bbox: line.bbox,
                source,
                boxes,
                bold,
                italic,
                size,
                status: "unmatched",
                exact: None,
                span: None,
                lang: None,
                words: Vec::new(),
                why: None,
                of: None,
                tokens,
            });
        }
    }
    Ok((lines, pages))
}

/// Which language each side of a page of two columns prints: (left, right) by page, from the lines the alignment placed there. A
/// page with too few lines to say goes with the document's commonest pair; one whose sides print one language has no such pair.
fn column_languages(lines: &[Line], sizes: &Sizes) -> HashMap<i64, (&'static str, &'static str)> {
    const SAY: u32 = 6;
    let mut placed: HashMap<i64, [HashMap<&'static str, u32>; 2]> = HashMap::new();
    let mut on_page: HashMap<i64, Vec<Bbox>> = HashMap::new();
    for line in lines {
        on_page.entry(line.page).or_default().push(line.bbox);
        if let Some(language) = line.lang {
            let side = ((line.bbox[0] + line.bbox[2]) / 2.0 > sizes[&line.page].0 / 2.0) as usize;
            *placed.entry(line.page).or_default()[side].entry(language).or_default() += 1;
        }
    }
    let major = |counts: &HashMap<&'static str, u32>| counts.iter().map(|(language, n)| (*n, *language)).max();
    let columned: HashSet<i64> = on_page.iter().filter(|(page, boxes)| two_columns(boxes, sizes[*page].0 / 2.0)).map(|(page, _)| *page).collect();
    let mut told: HashMap<i64, (&'static str, &'static str)> = HashMap::new();
    let mut same: HashSet<i64> = HashSet::new();
    for page in &columned {
        let Some([left, right]) = placed.get(page) else { continue };
        if let (Some((a, first)), Some((b, second))) = (major(left), major(right)) {
            if a >= SAY && b >= SAY {
                if first == second { same.insert(*page); } else { told.insert(*page, (first, second)); }
            }
        }
    }
    let mut pairs: HashMap<(&'static str, &'static str), u32> = HashMap::new();
    for pair in told.values() {
        *pairs.entry(*pair).or_default() += 1;
    }
    let Some((_, usual)) = pairs.iter().map(|(pair, n)| (*n, *pair)).max() else { return HashMap::new() };
    columned.into_iter().filter(|page| !same.contains(page)).map(|page| (page, told.get(&page).copied().unwrap_or(usual))).collect()
}

/// The language each line's side prints, on the pages `columns` holds.
fn fences(lines: &[Line], columns: &HashMap<i64, (&'static str, &'static str)>, sizes: &Sizes) -> Vec<Option<&'static str>> {
    lines.iter().map(|line| columns.get(&line.page).map(|&(left, right)| if (line.bbox[0] + line.bbox[2]) / 2.0 > sizes[&line.page].0 / 2.0 { right } else { left })).collect()
}

/// A line the recognizer ran across both columns of a page: it stands across the middle and the alignment placed none of one
/// side's words, for those are the other language's. Each side's words become a line of their own, the words in the gutter
/// (its letters) neither's; a line whose words the alignment placed on both sides is a line across the page and stays, and so
/// does page matter across its head or foot (a running head), of which nothing is placed.
fn split_joined(lines: Vec<Line>, columns: &HashMap<i64, (&'static str, &'static str)>, matter: &[Option<&'static str>], sizes: &Sizes, words: &mut Words) -> Vec<Line> {
    let mut out = Vec::with_capacity(lines.len());
    for (k, line) in lines.into_iter().enumerate() {
        let width = sizes[&line.page].0;
        let middle = width / 2.0;
        let centre = |b: &(i64, i64, f64, f64, f64, f64)| (b.2 + b.4) / 2.0;
        let (crossing, wide) = (line.bbox[0] < 0.45 * width && line.bbox[2] > 0.55 * width, line.boxes.len() >= 2);
        if !(columns.contains_key(&line.page) && crossing && wide) {
            out.push(line);
            continue;
        }
        let in_gutter = |b: &(i64, i64, f64, f64, f64, f64)| (centre(b) - middle).abs() < 0.04 * width && b.1 - b.0 <= 2;
        let left: Vec<_> = line.boxes.iter().filter(|b| !in_gutter(b) && centre(b) <= middle).copied().collect();
        let right: Vec<_> = line.boxes.iter().filter(|b| !in_gutter(b) && centre(b) > middle).copied().collect();
        let holds = |side: &[(i64, i64, f64, f64, f64, f64)], word: &WordPair| side.iter().any(|b| b.0 <= word.0 as i64 && (word.0 as i64) < b.1);
        let placed = (line.words.iter().any(|word| holds(&left, word)), line.words.iter().any(|word| holds(&right, word)));
        let page_matter = !placed.0 && !placed.1 && (matter[k].is_some() || margin(&line.bbox, sizes[&line.page]) == Some("head"));
        if left.is_empty() || right.is_empty() || placed.0 && placed.1 || page_matter {
            out.push(line);
            continue;
        }
        let chars: Vec<char> = line.text.chars().collect();
        let [_, top, _, bottom] = line.bbox;
        let whole = Whole { id: line.id.clone(), at: 0, text: line.text.clone(), bbox: line.bbox };
        for (side, part) in [(&left, "a"), (&right, "b")] {
            let (from, to) = (side[0].0 as usize, (side[side.len() - 1].1 as usize).min(chars.len()));
            let text: String = chars[from..to].iter().collect();
            let tokens = words.of_line(&text);
            let boxes = side.iter().map(|b| (b.0 - from as i64, b.1 - from as i64, b.2, b.3, b.4, b.5)).collect();
            let bbox = [side.iter().map(|b| b.2).fold(f64::MAX, f64::min), top, side.iter().map(|b| b.4).fold(f64::MIN, f64::max), bottom];
            out.push(Line { id: format!("{}{part}", line.id), page: line.page, text, bbox, source: line.source.clone(), boxes, bold: line.bold, italic: line.italic, size: line.size.clone(),
                            status: "unmatched", exact: None, span: None, lang: None, words: Vec::new(), why: None, of: Some(Whole { at: from, ..whole.clone() }), tokens });
        }
    }
    out
}

fn placed_of(lines: &[Line]) -> Vec<Placed<'_>> {
    lines.iter().map(|line| Placed { page: line.page, bbox: line.bbox, text: &line.text }).collect()
}

#[derive(Clone)]
struct Aligned {
    status: &'static str,
    exact: String,
    span: [u32; 2],
    lang: &'static str,
    words: Vec<WordPair>,
}

#[derive(Clone)]
enum Slot {
    Open,
    Gutter,
    Done(Aligned),
}

/// Each line's alignment: its language, status, slice of that language's text and word pairs. The main language goes
/// first; then, over the lines still unmatched and the words not yet placed, the other language's column, and notes and
/// other matter A2AJ sets elsewhere than the print (once more in each language, without the folios furniture finds). The
/// running matter furniture finds is in no pass: a running head "[2012] 2 S.C.R. SMITH v. JONES" would take the style of
/// cause's words or citation, which A2AJ prints once. A cover
/// page the PDF does not print (Source::cover) is left out, lest its parties and citation take the style of cause's
/// place, and so are the gutter's letters (in_gutter). A line fenced to a language (`fence`) is aligned with that language alone.
/// What the main language's first pass placed is returned, and taken as `first` where a caller knows that pass would place
/// the same again (the same lines, main language and covers, every line open to that language).
#[allow(clippy::too_many_arguments)]
fn align_lines(lines: &mut [Line], order: &[usize], sources: &[Source], main: &str, covers: &[Option<[u32; 2]>], gutter: &[bool],
               page_matter: &[Option<&'static str>], fence: &[Option<&'static str>], words: &Words, first: Option<Vec<Slot>>) -> Vec<Slot> {
    let mut result: Vec<Slot> = order.iter().map(|&i| if gutter[i] { Slot::Gutter } else { Slot::Open }).collect();
    let mut languages: Vec<usize> = (0..sources.len()).filter(|&k| sources[k].language == main).collect();
    languages.extend((0..sources.len()).filter(|&k| sources[k].language != main));
    let passes: Vec<usize> = languages.iter().chain(&languages).copied().collect();
    let resumed = first.is_some();
    if let Some(first) = first {
        result = first;
    }
    let mut after_first: Option<Vec<Slot>> = None;
    for (again, &language) in passes.iter().enumerate() {
        if again == 1 {
            after_first = Some(result.clone());
        }
        if again == 0 && resumed {
            continue;
        }
        let source = &sources[language];
        let left: Vec<usize> = (0..result.len())
            .filter(|&k| matches!(result[k], Slot::Open) && !(again >= languages.len() && page_matter[order[k]].is_some()) && page_matter[order[k]] != Some("furniture")
                && fence[order[k]].is_none_or(|own| own == source.language))
            .collect();
        if left.is_empty() {
            if result.iter().any(|slot| matches!(slot, Slot::Open)) {
                continue;
            }
            break;
        }
        let mut taken: Vec<[u32; 2]> = result
            .iter()
            .filter_map(|slot| match slot {
                Slot::Done(aligned) if aligned.lang == source.language => Some(aligned.span),
                _ => None,
            })
            .collect();
        taken.extend(covers[language]);
        let inputs: Vec<Input> = left.iter().map(|&k| Input { text: &lines[order[k]].text, tokens: &lines[order[k]].tokens }).collect();
        let mut pairing = Pairing::new(words, &source.chars, &source.tokens, &inputs, &taken);
        pairing.run();
        let mut paired: Vec<Vec<WordPair>> = vec![Vec::new(); inputs.len()];
        for (line, pair) in pairing.words() {
            paired[line as usize].push(pair);
        }
        for ((&k, sliced), pairs) in left.iter().zip(pairing.slices()).zip(paired) {
            if sliced.status != "unmatched" {
                result[k] = Slot::Done(Aligned { status: sliced.status, exact: sliced.exact, span: sliced.span.unwrap(), lang: source.language, words: pairs });
            }
        }
    }
    let after_first = after_first.unwrap_or_else(|| result.clone());
    for (slot, &i) in result.into_iter().zip(order) {
        if let Slot::Done(aligned) = slot {
            let line = &mut lines[i];
            (line.status, line.exact, line.span, line.lang, line.words) = (aligned.status, Some(aligned.exact), Some(aligned.span), Some(aligned.lang), aligned.words);
        }
    }
    after_first
}

/// The share of the decision's words that the PDF's lines place.
fn coverage(lines: &[Line], source: &Source) -> f64 {
    let placed: HashSet<u32> = placed_words(lines, source.language);
    source.decision.iter().filter(|token| placed.contains(&token.start)).count() as f64 / source.decision.len().max(1) as f64
}

fn placed_words(lines: &[Line], language: &str) -> HashSet<u32> {
    lines.iter().filter(|line| line.lang == Some(language)).flat_map(|line| line.words.iter().map(|w| w.2)).collect()
}

fn slice_chars(text: &str, from: usize, to: Option<usize>) -> String {
    let chars = text.chars().skip(from);
    match to {
        Some(to) => chars.take(to.saturating_sub(from)).collect(),
        None => chars.collect(),
    }
}

/// Whether a line reads these words: in a row, or (three or more) most of them.
fn reads(have: &[u32], want: &[u32]) -> bool {
    if have.len() >= want.len() && have.windows(want.len()).any(|window| window == want) {
        return true;
    }
    want.len() >= 3 && want.iter().filter(|w| have.contains(w)).count() as f64 >= 0.6 * want.len() as f64
}

/// Unmatched lines that print, word for word, a run of the decision's words no line places, between the words the
/// matched lines above and below them place (on their side of a page in columns), and nowhere else there: matter the
/// print sets out of A2AJ's order (a paragraph's number in the margin, a table's cells). Such a line is `moved`.
fn recover(lines: &mut [Line], gutter: &[bool], fence: &[Option<&'static str>], sizes: &Sizes, source: &Source, words: &Words) {
    let decision = &source.decision;
    let mut placed = placed_words(lines, source.language);
    let (mut by_word, mut by_page): (HashMap<u32, Vec<usize>>, HashMap<i64, Vec<usize>>) = (HashMap::new(), HashMap::new());
    for (i, token) in decision.iter().enumerate() {
        by_word.entry(token.word).or_default().push(i);
    }
    for (k, line) in lines.iter().enumerate() {
        if !gutter[k] && line.lang.is_some() && !line.words.is_empty() {
            by_page.entry(line.page).or_default().push(k);
        }
    }
    let none = Vec::new();
    for k in 0..lines.len() {
        if gutter[k] || fence[k].is_some_and(|own| own != source.language) {
            continue;
        }
        let line = &lines[k];
        let letters: usize = line.tokens.iter().map(|t| words.get(t.word).chars.len()).sum();
        if line.status != "unmatched" || letters < 2 {
            continue;
        }
        let middle = sizes[&line.page].0 / 2.0;
        let [x0, y0, x1, y1] = line.bbox;
        let mut matched: Vec<usize> = by_page.get(&line.page).unwrap_or(&none).clone();
        let boxes: Vec<Bbox> = matched.iter().map(|&m| lines[m].bbox).collect();
        if two_columns(&boxes, middle) {
            matched.retain(|&m| ((lines[m].bbox[0] + lines[m].bbox[2]) / 2.0 <= middle) == ((x0 + x1) / 2.0 <= middle));
        }
        // neighbours: the nearest matched lines wholly above and below its middle (a line on its row lies between)
        let centre = (y0 + y1) / 2.0;
        let (mut above, mut below): (Option<usize>, Option<usize>) = (None, None);
        for &m in &matched {
            let b = lines[m].bbox;
            if b[3] <= centre && above.is_none_or(|at| b[3] > lines[at].bbox[3]) {
                above = Some(m);
            }
            if b[1] >= centre && below.is_none_or(|at| b[1] < lines[at].bbox[1]) {
                below = Some(m);
            }
        }
        let side = above.or(below).and_then(|m| lines[m].lang);
        if side.is_some_and(|side| side != source.language) {
            continue;
        }
        let runs_of = |tokens: &[Token], low: u32, high: u32| -> Vec<usize> {
            by_word.get(&tokens[0].word).unwrap_or(&none).iter().copied()
                .filter(|&i| {
                    low <= decision[i].start && decision[i].start <= high && i + tokens.len() <= decision.len()
                        && tokens.iter().enumerate().all(|(n, token)| decision[i + n].word == token.word && !placed.contains(&decision[i + n].start))
                })
                .collect()
        };
        let mut tokens: &[Token] = &line.tokens;
        let mut found = Vec::new();
        if let (Some(above), Some(below)) = (above, below) {
            if lines[above].lang == lines[below].lang {
                let low = lines[above].words.iter().map(|w| w.2).max().unwrap();
                let high = lines[below].words.iter().map(|w| w.2).min().unwrap();
                found = runs_of(tokens, low, high);
            }
        }
        // a footnote A2AJ moves to the decision's end: four words or more, anywhere, once (a mark the recognizer reads
        // before it, "*" as "4", aside)
        for skip in [0, 1] {
            if found.is_empty() && tokens.len() - skip >= 4 && (skip == 0 || words.get(tokens[0].word).chars.len() <= 2) {
                tokens = &tokens[skip..];
                found = runs_of(tokens, 0, source.chars.len() as u32);
            }
        }
        if found.len() != 1 {
            continue;
        }
        let run = &decision[found[0]..found[0] + tokens.len()];
        let pairs: Vec<WordPair> = tokens.iter().zip(run).map(|(own, there)| WordPair(own.start, own.end, there.start, there.end, "exact")).collect();
        placed.extend(run.iter().map(|token| token.start));
        let (mut from, mut to) = (run[0].start as usize, run[run.len() - 1].end as usize);
        while from > 0 && LEADING.contains(source.chars[from - 1]) {
            from -= 1;
        }
        while to < source.chars.len() && TRAILING.contains(source.chars[to]) {
            to += 1;
        }
        let line = &mut lines[k];
        line.status = "moved";
        line.lang = Some(source.language);
        line.span = Some([from as u32, to as u32]);
        line.exact = Some(source.chars[from..to].iter().collect());
        line.words = pairs;
    }
}

/// Each run of the decision's words that the PDF's lines do not place, with where it falls on the PDF (after the placed
/// word before it: its line and offset) and why:
///   cover_unprinted   in the court's cover page, which the PDF does not print (Source::cover)
///   web_matter        a web page's note labels and table of contents (WEB_MATTER), which no PDF prints
///   note_call         a footnote call A2AJ writes `[3]`, which the print sets as a superscript
///   notes             in the notes A2AJ gathers after the decision (the print sets them at the pages' feet)
///   paragraph_number  a paragraph number A2AJ writes at a paragraph's start (its 1, 2, 3 ... through the decision);
///                     `_unprinted` when the PDF places almost none of them (the older reports print none); `_shared` when
///                     the margin prints it once for both languages' columns and the other language has it
///   title             in the title line A2AJ writes where the decision begins (its name and citation)
///   outside           before the first or after the last placed word
///   on_<why>          an unmatched line of its neighbours' pages reads it (its words in a row, or most of them for three
///                     or more; four letters at least), the line's why after the prefix (on_joined_columns, ...)
///   not_read          the PDF's reading has no word between its placed neighbours
///   misread           the PDF's reading has words there that read like it, unpaired
///   out_of_order      its neighbours are more than a page apart, or the later one comes first
///   other             the PDF's reading has other words there
fn unplaced(lines: &[Line], source: &Source, cover: Option<[u32; 2]>, words: &Words) -> (Vec<Value>, Map<String, Value>) {
    let (text, chars) = (&source.text, &source.chars);
    let mut at: HashMap<u32, (usize, u32, u32)> = HashMap::new();
    for (k, line) in lines.iter().enumerate() {
        if line.lang == Some(source.language) {
            for w in &line.words {
                at.entry(w.2).or_insert((k, w.0, w.1));
            }
        }
    }
    let mut starts: Vec<u32> = at.keys().copied().collect();
    starts.sort_unstable();
    let title_end = source.title_end.map(|end| end as u32);
    let notes = notes_start(text).map_or(chars.len() as u32, |at| at as u32);
    // A2AJ's paragraph numbers run 1, 2, 3 ... through the decision; other numbers at a line's start are list items
    let (mut numbers, mut expected) = (HashSet::new(), 1u32);
    let mut byte = text.char_indices().nth(source.begin).map_or(text.len(), |(at, _)| at);
    let mut counted = (byte, source.begin);
    while let Some(found) = NUMBER.captures_at(text, byte) {
        let (whole, digits) = (found.get(0).unwrap(), found.get(1).unwrap());
        byte = whole.end();
        let rest = &text.as_bytes()[byte..];
        let follows = rest.first() == Some(&b' ') || rest.first() == Some(&b'\n') || rest.starts_with(b". ");
        if follows && digits.as_str() == expected.to_string() {
            counted = (digits.start(), counted.1 + text[counted.0..digits.start()].chars().count());
            numbers.insert(counted.1 as u32);
            expected += 1;
        }
    }
    let numbers_placed = numbers.iter().filter(|n| at.contains_key(n)).count() as f64 / numbers.len().max(1) as f64;
    let mut runs: Vec<Vec<Token>> = Vec::new();
    let mut current = Vec::new();
    for token in &source.decision {
        if at.contains_key(&token.start) {
            if !current.is_empty() {
                runs.push(std::mem::take(&mut current));
            }
        } else {
            current.push(*token);
        }
    }
    if !current.is_empty() {
        runs.push(current);
    }
    let (mut out, mut totals) = (Vec::with_capacity(runs.len()), Map::new());
    for run in &runs {
        let (s, e) = (run[0].start, run[run.len() - 1].end);
        let i = starts.partition_point(|&start| start < s);
        let before = (i > 0).then(|| at[&starts[i - 1]]);
        let after = (i < starts.len()).then(|| at[&starts[i]]);
        let spelled = |from: u32, to: u32| -> String { chars[from as usize..to as usize].iter().collect() };
        let note_call = s >= 2 && (e as usize) < chars.len() && chars[s as usize - 1] == '[' && chars[e as usize] == ']'
            && !is_space(chars[s as usize - 2]) && DIGIT.is_match(&spelled(s, e));
        let why = if cover.is_some_and(|cover| cover[0] <= s && s < cover[1]) {
            "cover_unprinted".to_owned()
        } else if WEB_MATTER.is_match(spelled(s, e).trim()) {
            "web_matter".to_owned()
        } else if s >= notes {
            "notes".to_owned()
        } else if run.len() == 1 && note_call {
            "note_call".to_owned()
        } else if run.len() == 1 && numbers.contains(&s) {
            let pages: Vec<i64> = [before, after].into_iter().flatten().map(|n| lines[n.0].page).collect();
            let word = spelled(s, e);
            let shared = lines.iter().any(|line| {
                line.lang.is_some_and(|lang| lang != source.language) && pages.contains(&line.page)
                    && line.text.trim_matches([' ', '[', ']', '(', ')', '.']) == word
            });
            format!("paragraph_number{}", if shared { "_shared" } else if numbers_placed < 0.1 { "_unprinted" } else { "" })
        } else if title_end.is_some_and(|end| e <= end) {
            "title".to_owned()
        } else if let (Some((k0, _, e0)), Some((k1, s1, _))) = (before, after) {
            let (p0, p1) = (lines[k0].page, lines[k1].page);
            // what the PDF reads between the neighbours: the rest of the one's line, the start of the other's, and any
            // unmatched line the reader sets between them
            let gap = if k0 == k1 {
                slice_chars(&lines[k0].text, e0 as usize, Some(s1 as usize))
            } else {
                let mut parts = vec![slice_chars(&lines[k0].text, e0 as usize, None)];
                if k1 as i64 - k0 as i64 <= 4 && k0 + 1 < k1 {
                    parts.extend(lines[k0 + 1..k1].iter().filter(|line| line.status == "unmatched").map(|line| line.text.clone()));
                }
                parts.push(slice_chars(&lines[k1].text, 0, Some(s1 as usize)));
                parts.join(" ")
            };
            let gap: Vec<char> = plain(&gap).concat().chars().collect();
            let want: Vec<u32> = run.iter().map(|token| token.word).collect();
            let wanted: Vec<char> = want.iter().flat_map(|&w| words.get(w).chars.iter().copied()).collect();
            let holder = if wanted.len() >= 4 {
                lines.iter().find(|line| {
                    (line.page == p0 || line.page == p1) && line.status == "unmatched"
                        && reads(&line.tokens.iter().map(|token| token.word).collect::<Vec<_>>(), &want)
                })
            } else {
                None
            };
            if let Some(holder) = holder {
                format!("on_{}", holder.why.as_deref().unwrap_or(""))
            } else if p1 < p0 || p1 - p0 > 1 {
                "out_of_order".to_owned()
            } else if gap.is_empty() {
                "not_read".to_owned()
            } else if similarity(&gap, &wanted) >= MIN_RESEMBLANCE {
                "misread".to_owned()
            } else {
                "other".to_owned()
            }
        } else {
            "outside".to_owned()
        };
        let place = before.map_or(Value::Null, |(k, _, end)| json!({"line": lines[k].id, "offset": end}));
        out.push(json!({"at": [s, e], "words": run.len(), "why": why, "pdf": place}));
        let total = totals.entry(why).or_insert(json!(0));
        *total = json!(total.as_u64().unwrap() + run.len() as u64);
    }
    (out, totals)
}

/// Where each of the report's pages begins on the PDF, from A2AJ's page marks: the page's number, the mark's offset in
/// A2AJ's text, the PDF line and offset of the first word after it that the PDF places (none where none is), and the
/// folio the aligner paired with the mark's number, where it did (the line printing the page's number).
fn page_breaks(lines: &[Line], source: &Source) -> Vec<Value> {
    let mut placed: Vec<(u32, &str, i64, u32)> = lines
        .iter()
        .filter(|line| line.lang == Some(source.language))
        .flat_map(|line| line.words.iter().map(move |w| (w.2, line.id.as_str(), line.page, w.0)))
        .collect();
    placed.sort_unstable();
    source
        .marks
        .iter()
        .map(|mark| {
            let i = placed.partition_point(|p| p.0 < mark.end);
            let first = placed.get(i).map_or(Value::Null, |p| json!({"line": p.1, "page": p.2, "offset": p.3, "text_at": p.0}));
            let folio = (i > 0 && placed[i - 1].0 >= mark.number_at).then(|| &placed[i - 1]);
            let folio = folio.map_or(Value::Null, |p| json!({"line": p.1, "page": p.2}));
            json!({"page": mark.page, "at": mark.start, "pdf": first, "folio": folio})
        })
        .collect()
}

fn round4(share: f64) -> f64 {
    format!("{share:.4}").parse().unwrap()
}

fn count<'a>(names: impl Iterator<Item = &'a str>) -> Map<String, Value> {
    let mut out = Map::new();
    for name in names {
        let total = out.entry(name.to_owned()).or_insert(json!(0));
        *total = json!(total.as_u64().unwrap() + 1);
    }
    out
}

/// What the aligner writes of a pair: the record, as JSON, and its verdict.
pub struct Made {
    pub json: Vec<u8>,
    pub verdict: Value,
    /// How many of its words the alignment paired each way (exact, fuzzy, ...): what the report counts of a record.
    pub kinds: std::collections::BTreeMap<String, u64>,
}

/// A pair's alignment record, from its reading (the file's bytes, and its key: `corpus::reading_key`) and A2AJ's store.
pub fn record_of(pair: &Value, reading: &[u8], digest: String, db: &Connection) -> Result<Made, String> {
    let mut reading: Reading = legalpdf::unpack(reading).map_err(|error| error.to_string())?;
    // A pair of one decision in a bound volume names the volume's pages that hold it ("window": [first, last]).
    if let Some([first, last]) = pair["window"].as_array().and_then(|w| Some([w.first()?.as_i64()?, w.get(1)?.as_i64()?])) {
        reading.pages.retain(|page| first <= page.number && page.number <= last);
    }
    record_of_reading(pair, reading, digest, db)
}

/// [`record_of`] from a reading already parsed (a bound volume's pages for one of its decisions).
pub fn record_of_reading(pair: &Value, reading: Reading, digest: String, db: &Connection) -> Result<Made, String> {
    // A2AJ_GOLD_TIMES set: each stage's time, on stderr.
    let timed = std::env::var_os("A2AJ_GOLD_TIMES").is_some();
    let mut clock = std::time::Instant::now();
    let mut lap = |stage: &str| if timed {
        eprintln!("  {stage:>12} {:7.1} ms", clock.elapsed().as_secs_f64() * 1000.0);
        clock = std::time::Instant::now();
    };
    let id = match &pair["a2aj"] {
        Value::Number(number) => Sql::Integer(number.as_i64().ok_or("the pair's document id")?),
        Value::String(text) => Sql::Text(text.clone()),
        _ => return Err("the pair has no document id".to_owned()),
    };
    let (en, fr): (Option<String>, Option<String>) = db
        .prepare_cached("select unofficial_text_en, unofficial_text_fr from document where id = ?1")
        .and_then(|mut query| query.query_row([id], |row| Ok((row.get(0)?, row.get(1)?))))
        .map_err(|error| error.to_string())?;
    let mut words = Words::default();
    let mut sources = Vec::new();
    for language in pair["languages"].as_array().ok_or("the pair has no languages")? {
        let (language, text) = match language.as_str() {
            Some("en") => ("en", &en),
            Some("fr") => ("fr", &fr),
            other => return Err(format!("no language {other:?}")),
        };
        let text = text.as_deref().map(trimmed).filter(|text| !text.is_empty()).ok_or(format!("no {language} text"))?;
        sources.push(Source::new(language, text.to_owned(), &mut words));
    }
    lap("texts");
    let (mut lines, pages) = lines_of(reading, &mut words)?;
    let sizes: Sizes = pages.iter().copied().collect();
    lap("lines");
    let mut main = if sources.iter().any(|source| source.language == "en") { "en" } else { "fr" };
    let covers: Vec<Option<[u32; 2]>> = sources.iter().map(|source| source.cover(&lines)).collect();
    let aligned = |lines: &mut [Line], fence: &[Option<&'static str>], words: &Words, main: &str, first: Option<Vec<Slot>>| {
        let (order, gutter, matter) = {
            let placed = placed_of(lines);
            (column_order(&placed, &sizes), in_gutter(&placed, &sizes), furniture(&placed, &sizes))
        };
        let first = align_lines(lines, &order, &sources, main, &covers, &gutter, &matter, fence, words, first);
        (gutter, matter, first)
    };
    let unaligned = |lines: &mut [Line]| for line in lines.iter_mut() {
        (line.status, line.exact, line.span, line.lang, line.words) = ("unmatched", None, None, None, Vec::new());
    };
    let mut fence = vec![None; lines.len()];
    let (mut gutter, mut matter, mut first) = aligned(&mut lines, &fence, &words, main, None);
    // A PDF that prints only the other language (a tribunal's French decision A2AJ also holds in English) is aligned in that
    // language first: aligned in English first, the names, dates, citations and numbers both texts share take the French
    // lines for English, and the French words those lines print are left unplaced.
    if let Some(other) = sources.iter().filter(|source| source.language != main).max_by(|a, b| coverage(&lines, a).total_cmp(&coverage(&lines, b))) {
        let own = sources.iter().find(|source| source.language == main).map_or(0.0, |source| coverage(&lines, source));
        // (A report printing both places most of each: its main language stays.)
        if own < 0.5 && coverage(&lines, other) > own {
            main = other.language;
            unaligned(&mut lines);
            (gutter, matter, first) = aligned(&mut lines, &fence, &words, main, None);
        }
    }
    // A PDF that prints one of the languages only is aligned in that one alone: the other's text places a few of its lines by
    // the citations and names both texts share (a note at a page's foot, which the printed language's text sets out of its
    // order at its end, goes to the other language's like note), and those lines' words are lost to the printed language.
    let printed: Vec<&'static str> = sources.iter().filter(|source| coverage(&lines, source) >= PRINTED).map(|source| source.language).collect();
    let alone = sources.len() > 1 && printed.len() == 1;
    if alone && lines.iter().any(|line| line.lang.is_some_and(|language| language != printed[0])) {
        fence = vec![Some(printed[0]); lines.len()];
        unaligned(&mut lines);
        // (Its main language's first pass, open to every line as it was, places what it placed: it is taken as it stands.)
        let again = (printed[0] == main).then(|| std::mem::take(&mut first));
        (gutter, matter, _) = aligned(&mut lines, &fence, &words, main, again);
    }
    lap("align");
    // A parallel report's columns print a language each. Words alike in both (a list of authorities, a citation) may land on the
    // other column's line, and a line run across both is half lost: the alignment read, each column goes again in its own language.
    if sources.len() > 1 && !alone {
        let columns = column_languages(&lines, &sizes);
        let lines_were = lines.len();
        lines = split_joined(lines, &columns, &matter, &sizes, &mut words);
        fence = fences(&lines, &columns, &sizes);
        let strays = lines.iter().zip(&fence).any(|(line, own)| line.lang.is_some() && own.is_some() && line.lang != *own);
        if strays || lines.len() != lines_were {
            unaligned(&mut lines);
            (gutter, matter, _) = aligned(&mut lines, &fence, &words, main, None);
        }
    }
    lap("columns");
    for source in &sources {
        if coverage(&lines, source) >= PRINTED {
            recover(&mut lines, &gutter, &fence, &sizes, source, &words);
        }
    }
    lap("recover");
    let by_language = count(lines.iter().filter_map(|line| line.lang));
    let mut most = 0;
    let mut main = main.to_owned();
    for (language, total) in &by_language {
        if total.as_u64().unwrap() > most {
            (main, most) = (language.clone(), total.as_u64().unwrap());
        }
    }
    explain(&mut lines, &gutter, &matter, &sizes);
    let mut covered = Map::new();
    let (mut printed, mut short, mut not_printed) = (Vec::new(), Vec::new(), Vec::new());
    for (k, source) in sources.iter().enumerate() {
        let share = round4(coverage(&lines, source));
        covered.insert(source.language.to_owned(), json!(share));
        if share >= PRINTED {
            printed.push(k);
            if share < COVERAGE {
                short.push(format!("the PDF places {:.1}% of A2AJ's {} text", share * 100.0, source.language));
            }
        } else {
            not_printed.push(source.language);
        }
    }
    not_printed.sort_unstable();
    // A language the PDF prints places most of its words; one it does not print (an English-only report of a decision A2AJ
    // also holds in French) places a few by chance and is no measure of the alignment.
    let refused = if printed.is_empty() {
        json!("the PDF does not print this decision")
    } else if short.is_empty() {
        Value::Null
    } else {
        json!(short.join("; "))
    };
    let (mut missing, mut missing_totals, mut breaks) = (Map::new(), Map::new(), Map::new());
    for &k in &printed {
        let (runs, totals) = unplaced(&lines, &sources[k], covers[k], &words);
        let language = sources[k].language.to_owned();
        missing.insert(language.clone(), Value::Array(runs));
        missing_totals.insert(language, Value::Object(totals));
    }
    for &k in &printed {
        breaks.insert(sources[k].language.to_owned(), Value::Array(page_breaks(&lines, &sources[k])));
    }
    lap("unplaced");
    let verdict = json!({
        "main": main, "coverage": covered, "not_printed": not_printed, "by_language": by_language,
        "status": count(lines.iter().map(|line| line.status)),
        "unmatched": count(lines.iter().filter_map(|line| line.why.as_deref())),
        "unplaced": missing_totals, "refused": refused,
    });
    let hex = |bytes: &[u8]| -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() };
    #[derive(Serialize)]
    struct Record<'a> {
        schema: &'static str,
        code: &'static str,
        read: String,
        pair: &'a Value,
        reading: Value,
        pages: Map<String, Value>,
        texts: Map<String, Value>,
        page_breaks: Map<String, Value>,
        covers_unprinted: Map<String, Value>,
        verdict: &'a Value,
        unplaced: Map<String, Value>,
        lines: &'a [Line],
    }
    let record = Record {
        schema: "a2aj-alignment.v1",
        code: CODE.as_str(),
        read: digest,
        pair,
        reading: json!({"reader": "legalpdf-read", "models": "legal-pdf-parser/runtime indra, onnx"}),
        pages: pages.iter().map(|&(page, (width, height))| (page.to_string(), json!([width, height]))).collect(),
        texts: sources.iter().map(|source| (source.language.to_owned(), json!(hex(&Sha256::digest(source.text.as_bytes()))))).collect(),
        page_breaks: breaks,
        covers_unprinted: sources.iter().zip(&covers).map(|(source, cover)| (source.language.to_owned(), json!(cover))).collect(),
        verdict: &verdict,
        unplaced: missing,
        lines: &lines,
    };
    let json = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    let mut kinds = std::collections::BTreeMap::new();
    for word in lines.iter().flat_map(|line| &line.words) {
        *kinds.entry(word.4.to_owned()).or_default() += 1;
    }
    lap("written");
    Ok(Made { json, verdict, kinds })
}

/// Why each unmatched line has no text: a page number or running matter (furniture), a running head (in the page head
/// above the page's first matched line), a letter the bilingual reports print in the gutter between their columns to
/// locate lines (a few characters there, however the recognizer reads them), no word at all, a line the reader ran across
/// both columns of a page (half of it in each language), or nothing known.
fn explain(lines: &mut [Line], gutter: &[bool], matter: &[Option<&'static str>], sizes: &Sizes) {
    let (mut body_top, mut matched): (HashMap<i64, f64>, HashMap<i64, Vec<Bbox>>) = (HashMap::new(), HashMap::new());
    for line in lines.iter().filter(|line| line.status != "unmatched") {
        let top = body_top.entry(line.page).or_insert(line.bbox[1]);
        *top = top.min(line.bbox[1]);
        matched.entry(line.page).or_default().push(line.bbox);
    }
    let columns: HashMap<i64, bool> = matched.iter().map(|(&page, boxes)| (page, two_columns(boxes, sizes[&page].0 / 2.0))).collect();
    for (k, line) in lines.iter_mut().enumerate() {
        if line.status != "unmatched" {
            continue;
        }
        let size = sizes[&line.page];
        let at_edge = margin(&line.bbox, size) == Some("head");
        let head = at_edge && line.bbox[3] <= body_top.get(&line.page).copied().unwrap_or(0.0);
        let joined = !at_edge && columns.get(&line.page).copied().unwrap_or(false) && line.bbox[0] < 0.45 * size.0 && line.bbox[2] > 0.55 * size.0;
        let why = if let Some(why) = matter[k] {
            why
        } else if head {
            "running_head"
        } else if gutter[k] || LINE_LETTER.is_match(strip(&line.text)) {
            "margin_letter"
        } else if line.tokens.is_empty() {
            "no_words"
        } else if joined {
            "joined_columns"
        } else {
            "unexplained"
        };
        line.why = Some(why.to_owned());
    }
}
