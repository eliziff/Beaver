//! A PDF's lines labelled from A2AJ's reading of the same decision: the gold of label source a2aj-align.
//!
//! A2AJ's text is cut into segments: the front matter before the first numbered paragraph (one segment per A2AJ line: a
//! report's headnote, the titles of its lists of authorities, else text), numbered paragraphs and its unnumbered ones (text,
//! a printed number the marker), headings (no levels: A2AJ's tree is not the print's), the matter after the reasons (text)
//! and notes (their label the marker, their references located). Each PDF line takes the segment its aligned words come
//! from. What A2AJ cannot label is left unlabelled: the lines inside a paragraph that it reads as quotations or leaves
//! unread, its list items, and the PDF lines it does not carry. The PDF decides only which lines are running heads and
//! page numbers (in the page margins, repeated or a bare number).
use crate::page::{column_order, in_gutter, margin, masked, number_like, page_number, same_row, Bbox, Placed, Sizes, DEFAULT_PAGE};
use crate::words::{self, is_digits, is_space};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

static WORD_OUTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(PART|PARTIE|BOOK|LIVRE|TITLE|TITRE|VOLUME)\b").unwrap());
static WORD_INNER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(ARTICLE|CHAPTER|CHAPITRE|DIVISION|SECTION|SCHEDULE|ANNEX|ANNEXE|APPENDIX|TAB|RULE|R[ÈE]GLE|CLAUSE|FORM|FORMULE)\b").unwrap()
});
static SEC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d+(?:\.\d+)?)\s*\(\d+\)").unwrap());
static DOTTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+(?:\.\d+)+\.?").unwrap());
static NUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[(\[]?\d+[.)\]:]?").unwrap());
static ROMAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\(?([IVXLCivxlc]{1,6})[.)\]:]").unwrap());
static ALPHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\(?([A-Za-z]{1,2})[.)\]]").unwrap());
static BULLETED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[•·▪–—\-*●○■□►]\s").unwrap());
const ROMANS: &[&str] = &["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii",
                          "xviii", "xix", "xx", "xxi", "xxii", "xxiii", "xxiv", "xxv", "xxx", "xl", "l"];
const BULLETS: &str = "•·▪▫◦●○■□►▶➢➤✓✔‣⁃-–—*o";

// A report's front matter: the line naming the court appealed from, which the catchwords follow; the paragraph that ends
// the headnote ("APPEAL from a judgment of ...", "POURVOI contre un arrêt de ..."); the titles of its lists of authorities.
static OPENING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:on|upon) (?:appeal|motion|application|reference|further appeal)s? (?:from|by|to|of)\b|en appel d|sur (?:requête|renvoi|demande)\b)").unwrap()
});
static CLOSING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:CROSS-)?(?:APPEALS?|POURVOIS?|MOTIONS?|REQU[ÊE]TES?|APPLICATIONS?|DEMANDES?|REFERENCES?|RENVOIS?|APPEL(?:S|)|ACTIONS?)(?: (?:and|et|incident) (?:CROSS-APPEAL|POURVOI INCIDENT|incident))? (?:from|contre|by|par|to|for|pour|de|du|d'|d’|à|in|on|en|concerning|relating|against|under)").unwrap()
});
static CITED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:(?:cases|statutes|regulations|rules|authors|treaties|legislation|authorities|statutes and regulations|statutes, regulations and rules|rules and regulations)(?: and \w+)* cited|jurisprudence(?: citée)?|lois(?: et règlements)? cités?|lois, règlements et règles cités|règlements cités|règles citées|doctrine(?: citée)?|traités cités|doctrine et autres documents cités)\.?$").unwrap()
});
// A2AJ reads as headings lines a judgment speaks, not titles: who gives the reasons, and the sentence that introduces what
// follows ("The judgment of the Court was delivered by", "LAMER J. --", "... are as follows:").
static SPOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:delivered|given|rendered|read|written)(?: orally)? by:?$|\b(?:rendus?|prononcés?|lus?)(?: oralement)? par:?$|[:\-–—]$").unwrap()
});
static NOT_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\w]").unwrap());

fn ends_word(text: &str, at: usize) -> bool {
    text[at..].chars().next().is_none_or(is_space)
}

/// Whether a text opens on a numbering a unit can open with.
fn numbered_opening(text: &str) -> bool {
    let t = text.trim_start_matches(is_space);
    if WORD_OUTER.is_match(t) || WORD_INNER.is_match(t) || SEC.is_match(t) {
        return true;
    }
    if DOTTED.find(t).is_some_and(|m| ends_word(t, m.end())) {
        return true;
    }
    // A number stands alone, or closes with one mark: "12 ", "12.", "(12)", "[12]:", never "12" at the very end.
    if let Some(m) = NUM.find(t) {
        let closed = m.as_str().ends_with(['.', ')', ']', ':']);
        if closed && ends_word(t, m.end()) || !closed && t[m.end()..].chars().next().is_some_and(is_space) {
            return true;
        }
    }
    if let Some(found) = ROMAN.captures(t) {
        let token = found.get(1).unwrap().as_str();
        if ends_word(t, found.get(0).unwrap().end()) && (token.chars().count() == 1 || ROMANS.contains(&token.to_lowercase().as_str())) {
            return true;
        }
    }
    if let Some(found) = ALPHA.captures(t) {
        let token: Vec<char> = found.get(1).unwrap().as_str().chars().collect();
        if ends_word(t, found.get(0).unwrap().end()) && !(token.len() == 2 && token[0] != token[1]) {
            return true;
        }
    }
    BULLETED.is_match(t)
}

/// A bullet glyph: a listed symbol or a private-use (symbol font) character.
fn bullet(text: &[char]) -> bool {
    text.len() == 1 && !alnum(text[0]) && (BULLETS.contains(text[0]) || ('\u{E000}'..='\u{F8FF}').contains(&text[0]))
}

fn alnum(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric()
}

/// A line that is only a printed marker: a bullet glyph or an enumerator ("iii.", "(b)", "2.").
fn enumerator(text: &[char]) -> bool {
    let text = strip(text);
    if text.first() == Some(&'[') {
        return false; // a bracketed number is a paragraph's, never an item's
    }
    if bullet(text) {
        return true;
    }
    let spelled: String = text.iter().collect();
    !text.is_empty() && text.len() <= 6 && !text.contains(&' ') && numbered_opening(&format!("{spelled} x"))
}

/// A printed marker's extent: the word with the brackets, parentheses or full stop around it.
fn extend(text: &[char], mut a: usize, mut b: usize) -> (usize, usize) {
    while a > 0 && matches!(text[a - 1], '[' | '(') {
        a -= 1;
    }
    while b < text.len() && matches!(text[b], ']' | ')' | '.' | ':') {
        b += 1;
    }
    (a, b)
}

fn strip(text: &[char]) -> &[char] {
    let a = text.iter().position(|&c| !is_space(c)).unwrap_or(text.len());
    let b = text.iter().rposition(|&c| !is_space(c)).map_or(a, |at| at + 1);
    &text[a..b]
}

fn strip_of<'a>(text: &'a [char], marks: &str) -> &'a [char] {
    let a = text.iter().position(|&c| !marks.contains(c)).unwrap_or(text.len());
    let b = text.iter().rposition(|&c| !marks.contains(c)).map_or(a, |at| at + 1);
    &text[a..b]
}

fn spell(text: &[char]) -> String {
    text.iter().collect()
}

fn joined(text: &[char]) -> String {
    spell(text).split(is_space).filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ")
}

fn round4(share: f64) -> f64 {
    format!("{share:.4}").parse().unwrap()
}

fn round3(x: f64) -> i64 {
    (x / 3.0).round_ties_even() as i64 * 3
}

// ---------------------------------------------------------------- A2AJ side

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Kind {
    Front,
    Paragraph,
    Heading,
    Inner,
    Item,
    Tail,
    Note,
}

impl Kind {
    fn body(self) -> bool {
        matches!(self, Kind::Paragraph | Kind::Heading | Kind::Inner | Kind::Item)
    }

    fn name(self) -> &'static str {
        match self {
            Kind::Front => "front",
            Kind::Paragraph => "paragraph",
            Kind::Heading => "heading",
            Kind::Inner => "inner",
            Kind::Item => "item",
            Kind::Tail => "tail",
            Kind::Note => "note",
        }
    }
}

#[derive(Clone, Default)]
struct Extra {
    number: Option<String>,
    label: Option<String>,
    label_range: Option<(usize, usize)>,
    refs: Vec<usize>,
}

#[derive(Clone)]
struct Seg {
    kind: Kind,
    index: usize,
    start: usize,
    end: usize,
    extra: Extra,
    outside: bool, // after the reasons: no body of the decision
    silent: bool,  // the matter after the reasons, of a length A2AJ's reading cannot label
}

pub struct Node {
    pub kind: String,
    pub label: String,
    pub start: usize,
    pub end: usize,
}

pub struct NoteNode {
    label: (usize, usize),
    body: (usize, usize),
    refs: Vec<usize>,
}

fn span_of(text: &str) -> Result<(usize, usize), String> {
    let (a, b) = text.split_once('-').ok_or_else(|| format!("no span in {text:?}"))?;
    Ok((a.parse().map_err(|_| format!("no span in {text:?}"))?, b.parse().map_err(|_| format!("no span in {text:?}"))?))
}

/// The census listing's nodes and notes.
pub fn nodes(listing: &str) -> Result<(Vec<Node>, Vec<NoteNode>), String> {
    let (mut found, mut notes) = (Vec::new(), Vec::new());
    for item in listing.split(';').filter(|item| !item.is_empty()) {
        let parts: Vec<&str> = item.split(' ').collect();
        if parts[0] == "note" {
            let (label, body) = (span_of(parts.get(1).ok_or("a note with no label")?)?, span_of(parts.get(2).ok_or("a note with no body")?)?);
            let refs = parts.get(4..).unwrap_or(&[]).join(" ");
            let refs = refs.split(',').filter(|r| !r.trim().is_empty()).map(|r| r.trim().parse::<usize>().map_err(|e| e.to_string())).collect::<Result<_, _>>()?;
            notes.push(NoteNode { label, body, refs });
        } else {
            let (start, end) = span_of(parts.get(parts.len().wrapping_sub(2)).ok_or("a node with no span")?)?;
            found.push(Node { kind: parts[0].to_owned(), label: parts[1..parts.len() - 2].join(" "), start, end });
        }
    }
    Ok((found, notes))
}

/// Code point offset of each UTF-16 offset of text.
fn code_points(text: &[char]) -> Vec<usize> {
    let mut out = Vec::with_capacity(text.len() + 1);
    for (at, &c) in text.iter().enumerate() {
        out.push(at);
        if c as u32 > 0xFFFF {
            out.push(at);
        }
    }
    out.push(text.len());
    out
}

/// (start, end) of each non-blank line of text[a..b], trimmed.
fn lines_in(text: &[char], a: usize, b: usize) -> Vec<(usize, usize)> {
    let (mut out, mut at) = (Vec::new(), a);
    while at < b {
        let stop = text[at..b].iter().position(|&c| c == '\n').map_or(b, |k| at + k);
        let (mut s, mut e) = (at, stop);
        while s < e && is_space(text[s]) {
            s += 1;
        }
        while e > s && is_space(text[e - 1]) {
            e -= 1;
        }
        if e > s {
            out.push((s, e));
        }
        at = stop + 1;
    }
    out
}

struct Painted {
    segs: Vec<Seg>,
    owner: Vec<Option<usize>>,
}

impl Painted {
    fn paint(&mut self, a: usize, b: usize, kind: Kind, extra: Extra) {
        let index = self.segs.len();
        self.segs.push(Seg { kind, index, start: a, end: b, extra, outside: false, silent: false });
        self.owner[a..b].fill(Some(index));
    }
}

/// The case outline (the engine's reading of A2AJ's text) only marks what A2AJ's nodes leave in doubt: the lines inside the
/// reasons it reads as set apart from their paragraph (an item, a nested block) are inner lines, as is every line inside
/// the reasons no node reads.
fn segments(text: &[char], listing: &str, outline: &[Value]) -> Result<Painted, String> {
    let units = code_points(text);
    let cp = |unit: usize| units[unit.min(units.len() - 1)];
    let (found, notes) = nodes(listing)?;
    let mut painted = Painted { segs: Vec::new(), owner: vec![None; text.len()] };
    let mut reasons: Vec<(usize, usize, Option<String>)> = Vec::new();
    for node in &found {
        if node.kind == "paragraph" && node.label.starts_with("par") {
            reasons.push((cp(node.start), cp(node.end), Some(node.label.chars().skip(3).collect())));
        } else if node.kind == "prose" {
            reasons.push((cp(node.start), cp(node.end), None));
        }
    }
    reasons.sort();
    if reasons.is_empty() {
        return Err(refusal("A2AJ reads no paragraphs"));
    }
    let note_start = notes.iter().map(|note| cp(note.label.0)).min().unwrap_or(text.len());
    let (start, end) = (reasons[0].0, reasons.iter().map(|r| r.1).max().unwrap());
    for (a, b) in lines_in(text, 0, start) {
        painted.paint(a, b, Kind::Front, Extra::default());
    }
    for (a, b) in lines_in(text, end, note_start) {
        painted.paint(a, b, Kind::Tail, Extra::default());
    }
    for (a, b, number) in reasons {
        painted.paint(a, b, Kind::Paragraph, Extra { number, ..Extra::default() });
    }
    for node in found.iter().filter(|node| node.kind == "quote") {
        for (x, y) in lines_in(text, cp(node.start), cp(node.end)) {
            painted.paint(x, y, Kind::Inner, Extra::default());
        }
    }
    for entry in outline {
        let at = |name: &str| entry[name].as_u64().unwrap_or(0) as usize;
        let (a, b) = (cp(at("start")), cp(at("end")));
        if !(start <= a && a < end) {
            continue;
        }
        let owners: HashSet<Option<Kind>> =
            (a..b).filter(|&i| !is_space(text[i])).map(|i| painted.owner[i].map(|s| painted.segs[s].kind)).collect();
        let only = |kind: Option<Kind>| owners.len() == 1 && owners.contains(&kind);
        let kind = entry["kind"].as_str().unwrap_or("");
        if only(None) || matches!(kind, "text" | "list_item" | "quote") && only(Some(Kind::Paragraph)) && entry["level"].as_i64().unwrap_or(0) >= 1 {
            for (x, y) in lines_in(text, a, b) {
                painted.paint(x, y, Kind::Inner, Extra::default());
            }
        }
    }
    for node in found.iter().filter(|node| node.kind == "list_item") {
        painted.paint(cp(node.start), cp(node.end), Kind::Item, Extra { label: Some(node.label.clone()), ..Extra::default() });
    }
    for node in found.iter().filter(|node| node.kind == "heading") {
        painted.paint(cp(node.start), cp(node.end), Kind::Heading, Extra::default());
    }
    for note in &notes {
        let range = (cp(note.label.0), cp(note.label.1));
        let refs = note.refs.iter().map(|&r| cp(r)).collect();
        painted.paint(cp(note.label.0), cp(note.body.1), Kind::Note, Extra { label_range: Some(range), refs, ..Extra::default() });
    }
    for (x, y) in lines_in(text, start, end) {
        let mut run = None;
        for i in x..=y {
            let free = i < y && painted.owner[i].is_none() && !is_space(text[i]);
            if free && run.is_none() {
                run = Some(i);
            } else if !free && run.is_some() && (i == y || painted.owner[i].is_some()) {
                painted.paint(run.take().unwrap(), i, Kind::Inner, Extra::default());
            }
        }
    }
    Ok(painted)
}

// ---------------------------------------------------------------- labelling

pub struct Line {
    pub id: String,
    pub page: i64,
    pub text: Vec<char>,
    pub bbox: Bbox,
    pub bold: bool,
    pub words: Vec<(usize, usize, usize)>, // (start, end, the A2AJ word's start)
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Owner {
    Seg(usize),
    Furniture,
    PageLabel,
    Bullet,
    Free,
}

impl Owner {
    fn own(self) -> bool {
        matches!(self, Owner::Furniture | Owner::PageLabel)
    }
}

#[derive(Clone, Copy)]
struct Piece {
    line: usize,
    a: usize,
    b: usize,
    owner: Owner,
}

#[derive(Clone)]
struct Span {
    line_id: String,
    start: usize,
    end: usize,
}

impl Span {
    fn json(&self) -> Value {
        json!({"line_id": self.line_id, "start": self.start, "end": self.end})
    }
}

struct Reference {
    label: String,
    span: Span,
    note: usize,
}

struct Entry {
    page: i64,
    spans: Vec<Span>,
    markers: Vec<Span>,
    references: Vec<Reference>,
    region: String,
    start: bool,
    text: String,
}

fn refusal(reason: &str) -> String {
    format!("refused: {reason}")
}

/// The error a labelling that refuses returns, as run.py reports it.
pub fn refused_reason(error: &str) -> Option<&str> {
    error.strip_prefix("refused: ")
}

struct Pdf<'a> {
    lines: Vec<&'a Line>,
    pages: &'a Sizes,
    text: &'a [char],
    begin: usize,
    segs: Vec<Seg>,
    owner: Vec<Option<usize>>,
    a2aj_words: Vec<(String, usize, usize)>,
    seg_of: Vec<Option<usize>>,
    pdf_words: Vec<(String, Vec<(usize, usize, usize)>)>,
    matches: HashMap<usize, usize>,
    to_pdf: HashMap<usize, usize>,
    pieces: Vec<Piece>,
    bullets: HashSet<usize>,
    bullet_of: HashMap<usize, usize>,
    columns: HashMap<i64, (f64, f64)>,
    fallback: (f64, f64),
    stats: Map<String, Value>,
    decisions: BTreeMap<String, u64>,
    unlabelled: usize,
}

impl<'a> Pdf<'a> {
    fn new(lines: Vec<&'a Line>, pages: &'a Sizes, text: &'a [char], listing: &str, outline: &[Value], begin: usize) -> Result<Pdf<'a>, String> {
        let painted = segments(text, listing, outline)?;
        let mut pdf = Pdf {
            lines, pages, text, begin, segs: painted.segs, owner: painted.owner, a2aj_words: Vec::new(), seg_of: Vec::new(), pdf_words: Vec::new(),
            matches: HashMap::new(), to_pdf: HashMap::new(), pieces: Vec::new(), bullets: HashSet::new(), bullet_of: HashMap::new(), columns: HashMap::new(),
            fallback: (72.0, 540.0), stats: Map::new(), decisions: BTreeMap::new(), unlabelled: 0,
        };
        pdf.align();
        pdf.cut();
        pdf.late_furniture();
        pdf.detached_bullets();
        pdf.page_margins();
        pdf.trailing();
        pdf.gate()?;
        Ok(pdf)
    }

    /// Each PDF word (a word the print broke across two lines is one word in two pieces) and the A2AJ word it stands for.
    fn align(&mut self) {
        let text: String = self.text.iter().collect();
        self.a2aj_words = words::words_of(&text, 0);
        let starts: Vec<usize> = self.a2aj_words.iter().map(|w| w.1).collect();
        self.seg_of = starts.iter().map(|&a| self.owner[a]).collect();
        let mut paired = HashMap::new();
        for (n, line) in self.lines.iter().enumerate() {
            for &(a, _, at) in &line.words {
                paired.insert((n, a), starts.partition_point(|&s| s <= at).wrapping_sub(1));
            }
        }
        for (n, line) in self.lines.iter().enumerate() {
            let spelled: String = line.text.iter().collect();
            for (word, a, b) in words::words_of(&spelled, 0) {
                let j = paired.get(&(n, a)).copied();
                let last = self.pdf_words.len().wrapping_sub(1);
                if j.is_some() && !self.pdf_words.is_empty() && self.matches.get(&last).copied() == j {
                    self.pdf_words[last].1.push((n, a, b));
                    continue;
                }
                if let Some(j) = j {
                    self.matches.insert(self.pdf_words.len(), j);
                }
                self.pdf_words.push((word, vec![(n, a, b)]));
            }
        }
        let mut ordered: Vec<(usize, usize)> = self.matches.iter().map(|(&i, &j)| (i, j)).collect();
        ordered.sort_unstable();
        self.to_pdf = ordered.into_iter().map(|(i, j)| (j, i)).collect();
    }

    /// Pieces in reading order.
    fn cut(&mut self) {
        let mut per_line: HashMap<usize, Vec<(usize, usize, Option<usize>)>> = HashMap::new();
        for (i, (_, pieces)) in self.pdf_words.iter().enumerate() {
            let s = self.matches.get(&i).and_then(|&j| self.seg_of[j]);
            for &(n, a, b) in pieces {
                per_line.entry(n).or_default().push((a, b, s));
            }
        }
        for n in 0..self.lines.len() {
            let line = self.lines[n];
            if strip(&line.text).is_empty() {
                continue;
            }
            let mut runs: Vec<(usize, usize, usize, usize)> = Vec::new();
            for &(a, b, s) in per_line.get(&n).map(Vec::as_slice).unwrap_or(&[]) {
                let Some(s) = s else { continue };
                match runs.last_mut() {
                    Some(run) if run.2 == s => {
                        run.1 = b;
                        run.3 += 1;
                    }
                    _ => runs.push((a, b, s, 1)),
                }
            }
            if runs.is_empty() {
                let owner = if enumerator(&line.text) { Owner::Bullet } else { Owner::Free };
                self.pieces.push(Piece { line: n, a: 0, b: line.text.len(), owner });
                continue;
            }
            // A run of one short word between two others is noise; a segment change splits the line.
            let many = runs.len() == 1;
            let mut kept: Vec<_> = runs.iter().copied()
                .filter(|r| r.3 >= 2 || r.1 - r.0 >= 4 || many || self.segs[r.2].extra.number.as_deref().is_some_and(|n| !n.is_empty()) || self.segs[r.2].kind == Kind::Note)
                .collect();
            if kept.is_empty() {
                kept = runs;
            }
            let mut merged: Vec<(usize, usize, usize, usize)> = Vec::new();
            for r in kept {
                match merged.last_mut() {
                    Some(last) if last.2 == r.2 => last.1 = r.1,
                    _ => merged.push(r),
                }
            }
            for k in 0..merged.len() {
                let a = if k == 0 { 0 } else { merged[k].0 };
                let b = merged.get(k + 1).map_or(line.text.len(), |next| next.0);
                self.pieces.push(Piece { line: n, a, b, owner: Owner::Seg(merged[k].2) });
            }
        }
    }

    /// Lines A2AJ does not carry that are page furniture all the same: a page number in the page head or foot, or words
    /// (digits masked) that recur, uncarried, on other pages.
    fn late_furniture(&mut self) {
        let mut loose: Vec<(usize, &'static str)> = Vec::new();
        for (k, piece) in self.pieces.iter().enumerate() {
            let line = self.lines[piece.line];
            let size = self.pages.get(&line.page).copied().unwrap_or(DEFAULT_PAGE);
            if piece.owner == Owner::Free {
                if let Some(place) = margin(&line.bbox, size) {
                    loose.push((k, place));
                }
            }
        }
        let mut pages: HashMap<String, BTreeSet<i64>> = HashMap::new();
        for &(k, _) in &loose {
            let line = self.lines[self.pieces[k].line];
            pages.entry(masked(&spell(&line.text))).or_default().insert(line.page);
        }
        let texts: Vec<String> = self.lines.iter().map(|line| spell(&line.text)).collect();
        for (k, place) in loose {
            let n = self.pieces[k].line;
            let line = self.lines[n];
            let others: Vec<(&str, Option<Bbox>)> = self.lines.iter().enumerate()
                .filter(|&(m, other)| m != n && other.page == line.page).map(|(m, other)| (texts[m].as_str(), Some(other.bbox))).collect();
            let mask = masked(&texts[n]);
            if place == "head" && page_number(&texts[n], Some(&line.bbox), &others) {
                self.pieces[k].owner = Owner::PageLabel;
            } else if !number_like(&texts[n]) && pages[&mask].len() >= 2 && mask.chars().count() >= 3 {
                self.pieces[k].owner = Owner::Furniture;
            }
        }
    }

    fn same_row(&self, n: usize, m: usize) -> bool {
        self.lines[n].page == self.lines[m].page && same_row(&self.lines[n].bbox, &self.lines[m].bbox)
    }

    /// A marker extracted as its own line on the row of its item's, heading's or line's first line opens it.
    fn detached_bullets(&mut self) {
        let mut opened = HashSet::new();
        for k in 0..self.pieces.len() {
            let piece = self.pieces[k];
            if let Owner::Seg(s) = piece.owner {
                opened.insert(s);
                continue;
            }
            if piece.owner != Owner::Bullet {
                continue;
            }
            let Some(next) = (k + 1..self.pieces.len()).find(|&q| !self.pieces[q].owner.own()) else { continue };
            if let Owner::Seg(s) = self.pieces[next].owner {
                if !opened.contains(&s) && matches!(self.segs[s].kind, Kind::Inner | Kind::Item | Kind::Heading) && self.same_row(piece.line, self.pieces[next].line) {
                    self.bullets.insert(k);
                    self.bullet_of.insert(s, k);
                }
            }
        }
    }

    fn kind(&self, piece: &Piece) -> Option<Kind> {
        match piece.owner {
            Owner::Seg(s) => Some(self.segs[s].kind),
            _ => None,
        }
    }

    fn gate(&mut self) -> Result<(), String> {
        let body: Vec<usize> = self.pieces.iter().enumerate()
            .filter(|(_, p)| self.kind(p).is_some_and(Kind::body) && matches!(p.owner, Owner::Seg(s) if !self.segs[s].outside))
            .map(|(k, _)| k).collect();
        let (Some(&first), Some(&last)) = (body.first(), body.last()) else { return Err(refusal("no A2AJ paragraph found in the PDF")) };
        let (mut furniture, mut body_lines, mut covered, mut touched) = (0u64, 0u64, 0u64, false);
        for (k, p) in self.pieces.iter().enumerate() {
            if p.owner.own() {
                furniture += 1;
                continue;
            }
            if first <= k && k <= last {
                body_lines += 1;
                touched = true;
                covered += (matches!(p.owner, Owner::Seg(_)) || self.bullets.contains(&k)) as u64;
            }
        }
        let stats = &mut self.stats;
        if furniture > 0 {
            stats.insert("furniture_lines".into(), json!(furniture));
        }
        if touched {
            stats.insert("body_lines".into(), json!(body_lines));
            stats.insert("covered_lines".into(), json!(covered));
        }
        // A paragraph number the PDF prints ("[95]" opening a line) that no A2AJ word takes: A2AJ's text lost the numbering
        // there. The page decides: printed.rs gives it its marker.
        let mut stray: Vec<String> = Vec::new();
        for (i, (word, pieces)) in self.pdf_words.iter().enumerate() {
            let (n, a, b) = pieces[0];
            let line = &self.lines[n].text;
            if is_digits(word) && !self.matches.contains_key(&i) && spell(strip(&line[..a])) == "[" && line.get(b) == Some(&']') {
                stray.push(word.clone());
            }
        }
        self.stats.insert("stray_paragraph_numbers".into(), json!(stray.len()));
        let (mut run, mut longest) = (0, 0);
        for k in first..=last {
            let p = self.pieces[k];
            if p.owner.own() {
                continue;
            }
            run = if p.owner == Owner::Free || (p.owner == Owner::Bullet && !self.bullets.contains(&k)) { run + 1 } else { 0 };
            longest = longest.max(run);
        }
        self.stats.insert("longest_uncarried_run".into(), json!(longest));
        let mut counts: HashMap<usize, (usize, usize)> = HashMap::new();
        for (j, s) in self.seg_of.iter().enumerate() {
            if let Some(s) = s {
                let count = counts.entry(*s).or_default();
                count.0 += 1;
                count.1 += self.to_pdf.contains_key(&j) as usize;
            }
        }
        let numbered: Vec<&Seg> = self.segs.iter().filter(|s| s.kind == Kind::Paragraph && s.extra.number.as_deref().is_some_and(|n| !n.is_empty())).collect();
        let of = |s: &Seg| counts.get(&s.index).copied().unwrap_or((0, 0));
        let unmatched: Vec<String> = numbered.iter().filter(|s| (of(s).1 as f64) < 0.6 * of(s).0.max(1) as f64).map(|s| s.extra.number.clone().unwrap()).collect();
        let mut unread: BTreeMap<&str, u64> = BTreeMap::new();
        for s in self.segs.iter().filter(|s| (s.kind.body() || s.kind == Kind::Note) && of(s).1 == 0 && of(s).0 > 0) {
            *unread.entry(s.kind.name()).or_default() += 1;
        }
        let unread_count: u64 = unread.values().sum();
        let matched = self.to_pdf.keys().filter(|&&j| self.seg_of[j].is_some()).count();
        let coverage = round4(covered as f64 / body_lines.max(1) as f64);
        let extra = json!({
            "pdf_lines": self.lines.iter().filter(|line| !strip(&line.text).is_empty()).count(),
            "paragraphs": numbered.len(), "unmatched_paragraphs": unmatched.len(), "unmatched_segments": unread_count,
            "a2aj_words": self.seg_of.iter().filter(|s| s.is_some()).count(), "a2aj_words_matched": matched,
            "pdf_words": self.pdf_words.len(), "pdf_words_matched": self.matches.len(), "coverage": coverage,
            "unmatched_paragraph_numbers": unmatched.iter().take(40).collect::<Vec<_>>(), "unmatched_segments_by_kind": unread,
        });
        if let Value::Object(extra) = extra {
            self.stats.extend(extra);
        }
        if !unmatched.is_empty() {
            return Err(refusal(&format!("{} of {} numbered paragraphs not found in the PDF", unmatched.len(), numbered.len())));
        }
        if coverage < 0.9 {
            return Err(refusal(&format!("A2AJ text covers {:.1}% of the body lines", coverage * 100.0)));
        }
        if longest >= 4 {
            return Err(refusal(&format!("{longest} consecutive body lines A2AJ does not carry")));
        }
        Ok(())
    }

    // ------------------------------------------------------------ PDF evidence

    /// Each page's body text column (left, right), from the lines of numbered paragraphs.
    fn page_margins(&mut self) {
        fn column(boxes: &[Bbox]) -> (f64, f64) {
            let mut seen: Vec<(i64, usize)> = Vec::new();
            for b in boxes {
                let at = round3(b[0]);
                match seen.iter_mut().find(|entry| entry.0 == at) {
                    Some(entry) => entry.1 += 1,
                    None => seen.push((at, 1)),
                }
            }
            let mut left = seen[0];
            for &entry in &seen[1..] {
                if entry.1 > left.1 {
                    left = entry;
                }
            }
            let mut rights: Vec<f64> = boxes.iter().map(|b| b[2]).collect();
            rights.sort_by(f64::total_cmp);
            let right = rights[(0.9 * (rights.len() - 1) as f64) as usize];
            (left.0 as f64, right.max(left.0 as f64 + 100.0))
        }
        let mut xs: BTreeMap<i64, Vec<Bbox>> = BTreeMap::new();
        let mut order: Vec<i64> = Vec::new();
        let mut everything: Vec<Bbox> = Vec::new();
        for piece in &self.pieces {
            if self.kind(piece) == Some(Kind::Paragraph) {
                let line = self.lines[piece.line];
                if !xs.contains_key(&line.page) {
                    order.push(line.page);
                }
                xs.entry(line.page).or_default().push(line.bbox);
            }
        }
        for page in order {
            everything.extend_from_slice(&xs[&page]);
        }
        self.fallback = if everything.is_empty() { (72.0, 540.0) } else { column(&everything) };
        self.columns = xs.iter().map(|(&page, boxes)| (page, if boxes.len() >= 4 { column(boxes) } else { self.fallback })).collect();
    }

    fn column(&self, page: i64) -> (f64, f64) {
        self.columns.get(&page).copied().unwrap_or(self.fallback)
    }

    /// A line's type: bold, capitals, centred.
    fn style(&self, n: usize) -> (bool, bool, bool) {
        let line = self.lines[n];
        let (left, right) = self.column(line.page);
        let letters: Vec<char> = line.text.iter().copied().filter(|c| c.is_alphabetic()).collect();
        let caps = letters.len() >= 3 && letters.iter().all(|c| c.is_uppercase());
        let centred = line.bbox[0] - left > 20.0 && ((line.bbox[0] + line.bbox[2]) / 2.0 - (left + right) / 2.0).abs() < 15.0;
        (line.bold, caps, centred)
    }

    fn indent(&self, n: usize) -> (f64, f64) {
        let line = self.lines[n];
        let (left, right) = self.column(line.page);
        (line.bbox[0] - left, right - left)
    }

    /// What the PDF shows an unnumbered line inside a paragraph to be: 'bullet', 'quote' (set apart from the paragraphs'
    /// text column: indented, or for a line A2AJ reads as a quotation, either way), 'heading', 'right' (set against the
    /// right margin) or 'text'.
    fn evidence(&self, members: &[Piece], quoted: bool) -> &'static str {
        let text = &self.lines[members[0].line].text;
        let lead = text[members[0].a..].iter().position(|&c| !is_space(c)).map_or(&[][..], |k| &text[members[0].a + k..]);
        if !lead.is_empty() && bullet(&lead[..1]) && (!"o-*".contains(lead[0]) || lead.get(1) == Some(&' ')) {
            return "bullet";
        }
        let rows: BTreeSet<usize> = members.iter().map(|m| m.line).collect();
        let shifts: Vec<(f64, f64)> = rows.iter().map(|&r| self.indent(r)).collect();
        if shifts.iter().all(|&(x, w)| x > 0.45 * w) {
            return "right";
        }
        let words: usize = rows.iter().map(|&r| spell(&self.lines[r].text).split(is_space).filter(|w| !w.is_empty()).count()).sum();
        let styles: Vec<(bool, bool, bool)> = rows.iter().map(|&r| self.style(r)).collect();
        if rows.len() <= 2 && words <= 15 && styles.iter().all(|s| s.2 && (s.0 || s.1)) {
            return "heading";
        }
        let apart = shifts.iter().filter(|&&(x, w)| (15.0 <= x || (quoted && x <= -15.0)) && x <= 0.45 * w).count();
        if apart as f64 >= 0.6 * shifts.len() as f64 {
            return "quote";
        }
        let last = strip(&self.lines[*rows.iter().next_back().unwrap()].text).last().copied();
        if rows.len() <= 2 && words <= 15 && last.is_some_and(|c| !".;,".contains(c)) && styles.iter().all(|s| s.0 || s.1) {
            return "heading";
        }
        "text"
    }

    /// A2AJ reads the matter after the reasons (a signature block, the disposition and counsel, a formal judgment, an
    /// appendix) as lines of the last numbered paragraph. The lines after the last of that paragraph's own words,
    /// quotations (set apart in the PDF) and list items are that matter: text when they are a few short lines; when they
    /// are many, long, or notes, A2AJ's reading cannot say what they are, and they stay unlabelled, outside the reasons.
    fn trailing(&mut self) {
        let Some(last) = self.segs.iter().filter(|s| s.kind == Kind::Paragraph && s.extra.number.as_deref().is_some_and(|n| !n.is_empty())).max_by_key(|s| s.start).cloned() else { return };
        let own: Vec<usize> = (last.start..last.end).filter(|&i| self.owner[i] == Some(last.index) && !is_space(self.text[i])).collect();
        let Some(&final_own) = own.last() else { return };
        let mut pieces: HashMap<usize, Vec<Piece>> = HashMap::new();
        for piece in &self.pieces {
            if let Owner::Seg(s) = piece.owner {
                pieces.entry(s).or_default().push(*piece);
            }
        }
        let after: BTreeSet<usize> = (final_own..last.end).filter_map(|i| self.owner[i]).filter(|&s| s != last.index).collect();
        let after: Vec<usize> = after.into_iter().filter(|&s| matches!(self.segs[s].kind, Kind::Inner | Kind::Item | Kind::Heading)).collect();
        let body = |s: usize| -> bool {
            let Some(members) = pieces.get(&s) else { return false };
            if self.segs[s].kind == Kind::Item || self.bullet_of.contains_key(&s) {
                return true;
            }
            self.segs[s].kind == Kind::Inner && matches!(self.evidence(members, true), "quote" | "bullet")
        };
        let cut = after.iter().rposition(|&s| body(s)).map_or(0, |k| k + 1);
        let tail: Vec<usize> = after[cut..].iter().copied().filter(|s| pieces.contains_key(s)).collect();
        if tail.is_empty() {
            return;
        }
        let sized = |s: usize| spell(&self.text[self.segs[s].start..self.segs[s].end]).split(is_space).filter(|w| !w.is_empty()).count();
        let noted = tail.iter().any(|&s| {
            let seg = &self.segs[s];
            self.text[seg.start] == '[' && self.text[seg.start..(seg.start + 6).min(self.text.len())].contains(&']')
        });
        let silent = tail.len() > 12 || tail.iter().map(|&s| sized(s)).max().unwrap_or(0) > 30 || noted;
        for s in tail {
            let seg = &mut self.segs[s];
            seg.kind = Kind::Tail;
            seg.outside = true;
            seg.silent = silent;
        }
    }

    /// {segment: region} for a report's headnote, from its fixed wording, whatever A2AJ's nodes read there.
    fn front(&self) -> HashMap<usize, &'static str> {
        let found = lines_in(self.text, self.begin, self.text.len());
        let said: Vec<String> = found.iter().map(|&(a, b)| joined(&self.text[a..b])).collect();
        let opening = said.iter().position(|t| OPENING.is_match(t));
        let closing = opening.and_then(|at| (at + 1..said.len()).find(|&k| CLOSING.is_match(&said[k])));
        let mut out: HashMap<usize, &'static str> = self.segs.iter().filter(|s| s.kind == Kind::Front).map(|s| (s.index, "text")).collect();
        let (Some(opening), Some(closing)) = (opening, closing) else { return out };
        let ((court, head), tail) = (found[opening], found[closing].1);
        for seg in self.segs.iter().filter(|s| s.kind != Kind::Note) {
            if court <= seg.start && seg.start < head {
                out.insert(seg.index, "text");
            }
            if head < seg.start && seg.start < tail {
                out.insert(seg.index, if CITED.is_match(&joined(&self.text[seg.start..seg.end])) { "heading" } else { "headnote" });
            }
        }
        out
    }

    fn count(&mut self, what: String) {
        *self.decisions.entry(what).or_default() += 1;
    }

    /// The gold's typed lines, and each one's segment. What A2AJ's reading cannot label is left out of them, unlabelled.
    fn typed(&mut self) -> (Vec<Entry>, HashMap<usize, Owner>) {
        let mut groups: Vec<(usize, Vec<usize>)> = Vec::new();
        let mut group_at: HashMap<usize, usize> = HashMap::new();
        for (k, piece) in self.pieces.iter().enumerate() {
            if let Owner::Seg(s) = piece.owner {
                let at = *group_at.entry(s).or_insert_with(|| {
                    groups.push((s, Vec::new()));
                    groups.len() - 1
                });
                groups[at].1.push(k);
            }
        }
        let mut region: HashMap<usize, Option<&'static str>> = HashMap::new();
        let front = self.front();
        for (s, ks) in &groups {
            let (s, seg) = (*s, self.segs[*s].clone());
            let spoken = || SPOKEN.is_match(&joined(&self.text[seg.start..seg.end]));
            let chosen = if let Some(&given) = front.get(&s) {
                Some(given)
            } else if matches!(seg.kind, Kind::Inner | Kind::Item) || seg.silent {
                None
            } else if seg.kind == Kind::Paragraph && seg.extra.number.as_deref().is_none_or(str::is_empty)
                && ks.iter().map(|&k| self.pieces[k].line).collect::<HashSet<_>>().len() >= 2
                && self.evidence(&ks.iter().map(|&k| self.pieces[k]).collect::<Vec<_>>(), false) == "quote" {
                None // a block quotation A2AJ reads as an unnumbered paragraph: the print sets it apart
            } else if seg.kind == Kind::Heading && spoken() {
                Some("text") // "The judgment of the Court was delivered by", "LAMER J. --", "... as follows:"
            } else {
                Some(match seg.kind {
                    Kind::Tail | Kind::Paragraph => "text",
                    Kind::Heading => "heading",
                    Kind::Note => "note",
                    Kind::Front | Kind::Inner | Kind::Item => unreachable!(),
                })
            };
            region.insert(s, chosen);
            self.count(format!("{}_{}", seg.kind.name(), chosen.unwrap_or("None")));
        }
        let mut marker: HashMap<usize, (usize, usize, usize)> = HashMap::new();
        // Bullets: a glyph extracted as its own line before the item.
        for (s, _) in &groups {
            if let Some(&k) = self.bullet_of.get(s) {
                let n = self.pieces[k].line;
                let text = &self.lines[n].text;
                let at = text.iter().position(|&c| !is_space(c)).unwrap_or(text.len());
                let end = text.iter().rposition(|&c| !is_space(c)).map_or(at, |e| e + 1);
                marker.insert(*s, (n, at, end));
                self.count("marker_detached".to_owned());
            }
        }
        // Printed markers: the A2AJ word that opens the segment, where the PDF prints it first.
        let starts: Vec<usize> = self.a2aj_words.iter().map(|w| w.1).collect();
        for (s, ks) in &groups {
            let (s, seg) = (*s, self.segs[*s].clone());
            let span = seg.extra.label_range.unwrap_or((seg.start, seg.end));
            let want = match seg.kind {
                Kind::Paragraph => seg.extra.number.clone(),
                Kind::Item | Kind::Heading => seg.extra.label.clone(),
                Kind::Note => Some(spell(&self.text[span.0..span.1])),
                _ => None,
            };
            let Some(want) = want.filter(|w| !w.is_empty()) else { continue };
            if marker.contains_key(&s) {
                continue;
            }
            let target: Vec<String> = words::words_of(&want, 0).into_iter().map(|w| w.0).collect();
            let j = starts.partition_point(|&a| a < span.0);
            let j = (j < starts.len() && starts[j] < span.1).then_some(j);
            let missing = format!("marker_missing_{}", seg.kind.name());
            let Some(j) = j.filter(|&j| target.first() == Some(&self.a2aj_words[j].0) && self.to_pdf.contains_key(&j)) else {
                self.count(missing);
                continue;
            };
            let pieces = self.pdf_words[self.to_pdf[&j]].1.clone();
            let (n, a, mut b) = pieces[0];
            let first = self.pieces[ks[0]];
            let text = &self.lines[n].text;
            let before = (n == first.line).then(|| &text[first.a..a]);
            // A number the margin prints beside the paragraph's first line, which the reader puts on a line of its own after
            // it: the paragraph's marker all the same, the line its own as a detached bullet's is.
            let alone = if n != first.line { ks[1..].iter().copied().find(|&k| self.pieces[k].line == n) } else { None };
            if let Some(alone) = alone {
                if spell(strip_of(text, "[](). \t")) == want && self.same_row(n, first.line) {
                    self.bullets.insert(alone);
                    self.bullet_of.insert(s, alone);
                    let (x, y) = extend(text, a, b);
                    marker.insert(s, (n, x, y));
                    self.count(format!("marker_{}", "margin"));
                    continue;
                }
            }
            if before.is_none_or(|before| !strip_of(before, "[( \t").is_empty()) {
                self.count(missing);
                continue;
            }
            if target.len() > 1 && pieces.len() == 1 {
                // "B.1": the label's further words
                for jj in j + 1..j + target.len() {
                    if let Some(&i) = self.to_pdf.get(&jj) {
                        if self.pdf_words[i].1[0].0 == n {
                            b = self.pdf_words[i].1[0].2;
                        }
                    }
                }
            }
            let (x, y) = extend(text, a, b);
            marker.insert(s, (n, x, y));
            self.count(format!("marker_{}", seg.kind.name()));
        }
        // References to notes, located through the word A2AJ prints at each.
        let mut refs: HashMap<usize, Vec<(usize, usize, usize)>> = HashMap::new();
        for (s, _) in &groups {
            let (s, seg) = (*s, self.segs[*s].clone());
            for &r in &seg.extra.refs {
                let j = starts.partition_point(|&a| a < r);
                let Some(&i) = (j < starts.len() && starts[j] < r + 4).then(|| self.to_pdf.get(&j)).flatten() else {
                    self.count("reference_missing".to_owned());
                    continue;
                };
                let (n, mut a, mut b) = self.pdf_words[i].1[0];
                let text = &self.lines[n].text;
                if a > 0 && b < text.len() && matches!((text[a - 1], text[b]), ('[', ']') | ('(', ')')) {
                    a -= 1;
                    b += 1;
                }
                refs.entry(n).or_default().push((a, b, s));
                self.count("reference".to_owned());
            }
        }
        // Typed lines in reading order.
        let (mut typed, mut unit_seg): (Vec<Entry>, HashMap<usize, Owner>) = (Vec::new(), HashMap::new());
        let opened: HashMap<usize, usize> = self.bullet_of.iter().map(|(&s, &k)| (k, s)).collect();
        let (mut previous_region, mut previous_seg): (Option<String>, Option<Owner>) = (None, None);
        let mut seen: HashSet<usize> = HashSet::new();
        for k in 0..self.pieces.len() {
            let Piece { line: n, mut a, mut b, mut owner } = self.pieces[k];
            let line = self.lines[n];
            let text = &line.text;
            if !(a == 0 && b == text.len()) {
                while a < b && is_space(text[a]) {
                    a += 1;
                }
                while b > a && is_space(text[b - 1]) {
                    b -= 1;
                }
            }
            if self.bullets.contains(&k) && region[&opened[&k]].is_some() {
                continue; // its item's or heading's marker
            }
            if owner == Owner::Bullet || self.bullets.contains(&k) {
                owner = Owner::Free;
            }
            let mut entry = Entry { page: line.page, spans: vec![Span { line_id: line.id.clone(), start: a, end: b }], markers: Vec::new(), references: Vec::new(),
                                    region: String::new(), start: true, text: String::new() };
            match owner {
                Owner::Furniture => entry.region = "furniture".to_owned(),
                Owner::PageLabel => entry.region = "page_label".to_owned(),
                Owner::Seg(s) if region[&s].is_some() => {
                    let opening = !seen.contains(&s);
                    entry.region = region[&s].unwrap().to_owned();
                    entry.start = opening || self.segs[s].kind == Kind::Paragraph && previous_region.as_deref().is_some_and(|r| r != "quote") && previous_seg != Some(owner);
                    if opening {
                        if let Some(&(m, x, y)) = marker.get(&s).filter(|m| m.0 == n || self.bullet_of.contains_key(&s)) {
                            entry.markers = vec![Span { line_id: self.lines[m].id.clone(), start: x, end: y }];
                            if m != n {
                                entry.spans.insert(0, Span { line_id: self.lines[m].id.clone(), start: 0, end: self.lines[m].text.len() });
                            }
                        }
                    }
                    seen.insert(s);
                }
                _ => {
                    self.unlabelled += 1;
                    continue;
                }
            }
            let plain = !matches!(entry.region.as_str(), "furniture" | "page_label" | "note");
            for &(x, y, note) in refs.get(&n).map(Vec::as_slice).unwrap_or(&[]) {
                if a <= x && y <= b && plain {
                    entry.references.push(Reference { label: spell(&text[x..y]), span: Span { line_id: line.id.clone(), start: x, end: y }, note });
                }
            }
            entry.text = typed_text(text, a, b, &entry);
            if entry.markers.first().is_some_and(|m| m.line_id != line.id) {
                let m = &entry.markers[0];
                let Owner::Seg(s) = owner else { unreachable!() };
                let glyph = spell(&self.lines[self.pieces[self.bullet_of[&s]].line].text[m.start..m.end]);
                entry.text = format!("{glyph}\t{}", entry.text.trim_start_matches(is_space));
            }
            if plain {
                previous_region = Some(entry.region.clone());
                previous_seg = Some(owner);
            }
            typed.push(entry);
            unit_seg.insert(typed.len() - 1, owner);
        }
        let position: HashMap<&str, usize> = self.lines.iter().enumerate().map(|(k, line)| (line.id.as_str(), k)).collect();
        for entry in &mut typed {
            entry.spans.sort_by_key(|span| (position[span.line_id.as_str()], span.start));
        }
        (typed, unit_seg)
    }
}

/// The printed line as the authoring model types it: a tab after a leading marker, note references as [^mark].
fn typed_text(text: &[char], a: usize, b: usize, entry: &Entry) -> String {
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let last = &entry.spans[entry.spans.len() - 1].line_id;
    for mark in entry.markers.iter().filter(|m| &m.line_id == last) {
        let mut gap = mark.end;
        while gap < b && matches!(text[gap], ' ' | '\t') {
            gap += 1;
        }
        edits.push((mark.end, gap, "\t".to_owned()));
    }
    for reference in &entry.references {
        let (x, y) = (reference.span.start, reference.span.end);
        edits.push((x, y, format!("[^{}]", spell(&text[x..y]))));
    }
    edits.sort();
    let (mut out, mut cursor) = (String::new(), a);
    for (x, y, new) in edits {
        if x < cursor {
            continue;
        }
        out.extend(&text[cursor..x]);
        out.push_str(&new);
        cursor = y;
    }
    out.extend(&text[cursor..b]);
    out
}

/// Units of typed lines ([[typed line index]], in order): a line that does not start a unit continues the last unit of its
/// kind on its page, or else on the page before; furniture and labels are units of their own.
fn units_of(found: &[Entry]) -> Vec<Vec<usize>> {
    let family = |region: &str| if matches!(region, "text" | "provision" | "list_item") { "body".to_owned() } else { region.to_owned() };
    let own = |region: &str| matches!(region, "furniture" | "page_label" | "line_label");
    let (mut result, mut last, mut earlier, mut page): (Vec<Vec<usize>>, HashMap<String, usize>, HashMap<String, usize>, Option<i64>) =
        (Vec::new(), HashMap::new(), HashMap::new(), None);
    for (n, line) in found.iter().enumerate() {
        if page != Some(line.page) {
            page = Some(line.page);
            earlier = std::mem::take(&mut last);
        }
        let kind = family(&line.region);
        let joined = if own(&line.region) || line.start { None } else { last.get(&kind).or_else(|| earlier.get(&kind)).copied() };
        let joined = match joined {
            Some(at) => {
                result[at].push(n);
                at
            }
            None => {
                result.push(vec![n]);
                result.len() - 1
            }
        };
        if !own(&line.region) {
            last.insert(kind, joined);
        }
    }
    result
}

// The page matter the alignment finds among the lines A2AJ's text does not carry, as the gold's regions.
fn furniture_region(why: &str) -> Option<&'static str> {
    match why {
        "furniture" | "running_head" => Some("furniture"),
        "page_label" => Some("page_label"),
        "margin_letter" => Some("line_label"),
        _ => None,
    }
}

fn lines_of_record(record: &Value) -> Vec<(Line, Option<String>, Option<String>, String)> {
    record["lines"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter().map(|line| {
        let at = |n: usize| line["bbox"][n].as_f64().unwrap_or(0.0);
        let words = line["words"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter()
            .map(|w| (w[0].as_u64().unwrap_or(0) as usize, w[1].as_u64().unwrap_or(0) as usize, w[2].as_u64().unwrap_or(0) as usize)).collect();
        (Line { id: line["id"].as_str().unwrap_or("").to_owned(), page: line["page"].as_i64().unwrap_or(0), text: line["text"].as_str().unwrap_or("").chars().collect(),
                bbox: [at(0), at(1), at(2), at(3)], bold: line["bold"] == true, words },
         line["lang"].as_str().map(str::to_owned), line["why"].as_str().map(str::to_owned), line["status"].as_str().unwrap_or("").to_owned())
    }).collect()
}

/// An aligned record's structure gold: {typed, units, notes, report}. Each language the PDF prints is labelled from A2AJ's
/// reading of it over the lines the alignment gave that language; the page matter the alignment found (folios, running
/// heads, the gutter's line letters) is units of its own; every other line is unlabelled, typed by no line. Units carry no
/// levels or depths, and the first says the document is a judgment. A language whose labelling refuses refuses the gold.
pub fn gold(record: &Value, texts: &Map<String, Value>, listings: &Map<String, Value>, outlines: &Map<String, Value>) -> Result<Value, String> {
    let rows = lines_of_record(record);
    let sizes: Sizes = record["pages"].as_object().ok_or("the record has no pages")?.iter()
        .map(|(page, size)| Ok((page.parse::<i64>().map_err(|e| e.to_string())?, (size[0].as_f64().unwrap_or(0.0), size[1].as_f64().unwrap_or(0.0)))))
        .collect::<Result<_, String>>()?;
    let spelled: Vec<String> = rows.iter().map(|row| spell(&row.0.text)).collect();
    let placed: Vec<Placed> = rows.iter().zip(&spelled).map(|(row, text)| Placed { page: row.0.page, bbox: row.0.bbox, text }).collect();
    let rank: HashMap<&str, usize> = column_order(&placed, &sizes).into_iter().enumerate().map(|(rank, i)| (rows[i].0.id.as_str(), rank)).collect();
    let gutter = in_gutter(&placed, &sizes);
    let (mut typed, mut groups, mut notes): (Vec<Entry>, Vec<Vec<usize>>, Vec<(usize, String, usize, usize)>) = (Vec::new(), Vec::new(), Vec::new());
    let mut labelled = Map::new();
    for (k, (line, _, why, status)) in rows.iter().enumerate() {
        let Some(mut region) = why.as_deref().filter(|_| status == "unmatched").and_then(furniture_region) else { continue };
        if gutter[k] {
            region = "line_label";
        }
        if region == "line_label" && NOT_WORD.replace_all(&spelled[k], "").chars().count() > 2 {
            continue; // a word's end, not a line's letter
        }
        groups.push(vec![typed.len()]);
        typed.push(Entry { page: line.page, spans: vec![Span { line_id: line.id.clone(), start: 0, end: line.text.len() }], markers: Vec::new(), references: Vec::new(),
                           region: region.to_owned(), start: true, text: spelled[k].clone() });
    }
    let mut languages: Vec<&String> = texts.keys().collect();
    languages.sort();
    for language in languages {
        let text: Vec<char> = texts[language].as_str().ok_or("no text")?.chars().collect();
        let own: Vec<&Line> = rows.iter().filter(|row| row.1.as_deref() == Some(language)).map(|row| &row.0).collect();
        let begin = crate::record::start_of(texts[language].as_str().unwrap(), language);
        let begin = texts[language].as_str().unwrap()[..begin].chars().count();
        let empty = Vec::new();
        let listing = listings[language].as_str().ok_or("no listing")?;
        let outline = outlines[language].as_array().unwrap_or(&empty);
        let mut pdf = Pdf::new(own, &sizes, &text, listing, outline, begin)?;
        let (found, unit_seg) = pdf.typed();
        let (base, members) = (typed.len(), units_of(&found));
        let unit_of: HashMap<usize, usize> = members.iter().enumerate().flat_map(|(u, unit)| unit.iter().map(move |&t| (t, u))).collect();
        let mut first_typed: HashMap<usize, usize> = HashMap::new();
        let mut held: Vec<(usize, Owner)> = unit_seg.into_iter().collect();
        held.sort_unstable_by_key(|entry| entry.0);
        for (t, owner) in held {
            if let Owner::Seg(s) = owner {
                first_typed.entry(s).or_insert(t);
            }
        }
        for (t, entry) in found.iter().enumerate() {
            for (k, reference) in entry.references.iter().enumerate() {
                if let Some(&note) = first_typed.get(&reference.note) {
                    if found[note].region == "note" {
                        notes.push((base + t, reference.label.trim_matches(['[', ']', '(', ')']).to_owned(), k, groups.len() + unit_of[&note]));
                    }
                }
            }
        }
        let mut stats = std::mem::take(&mut pdf.stats);
        stats.insert("decisions".into(), json!(pdf.decisions));
        stats.insert("unlabelled_pieces".into(), json!(pdf.unlabelled));
        labelled.insert(language.clone(), Value::Object(stats));
        groups.extend(members.iter().map(|unit| unit.iter().map(|t| base + t).collect::<Vec<_>>()));
        typed.extend(found);
    }
    // Reading order: each typed line where its first line stands.
    let mut order: Vec<usize> = (0..typed.len()).collect();
    order.sort_by_key(|&t| (rank[typed[t].spans[0].line_id.as_str()], typed[t].spans[0].start));
    let moved: HashMap<usize, usize> = order.iter().enumerate().map(|(new, &old)| (old, new)).collect();
    let mut members: Vec<Vec<usize>> = groups.iter().map(|unit| {
        let mut unit: Vec<usize> = unit.iter().map(|t| moved[t]).collect();
        unit.sort_unstable();
        unit
    }).collect();
    let mut by_first: Vec<usize> = (0..members.len()).collect();
    by_first.sort_by_key(|&u| members[u][0]);
    let unit_moved: HashMap<usize, usize> = by_first.iter().enumerate().map(|(new, &old)| (old, new)).collect();
    let mut units: Vec<Value> = by_first.iter().map(|&old| json!({"lines": std::mem::take(&mut members[old]), "starts_document": false})).collect();
    if let Some(Value::Object(first)) = units.first_mut() {
        first.insert("document_type".into(), json!("judgment"));
    }
    let span_json = |span: &Span| span.json();
    let typed_json: Vec<Value> = order.iter().map(|&t| {
        let entry = &typed[t];
        json!({"page": entry.page, "spans": entry.spans.iter().map(span_json).collect::<Vec<_>>(),
               "markers": entry.markers.iter().map(|m| vec![m.json()]).collect::<Vec<_>>(),
               "references": entry.references.iter().map(|r| json!({"label": r.label, "spans": [r.span.json()]})).collect::<Vec<_>>(),
               "region": entry.region, "start": entry.start, "text": entry.text})
    }).collect();
    let notes: Vec<Value> = notes.into_iter().map(|(line, marker, reference, note)| json!({"line": moved[&line], "marker": marker, "reference": reference, "note": unit_moved[&note]})).collect();
    let covered: HashSet<&str> = typed.iter().flat_map(|t| t.spans.iter().map(|s| s.line_id.as_str())).collect();
    let unlabelled: Vec<&str> = rows.iter().map(|row| row.0.id.as_str()).filter(|id| !covered.contains(id)).collect();
    Ok(json!({"typed": typed_json, "units": units, "notes": notes, "report": {"labelled": labelled, "unlabelled_lines": unlabelled}}))
}
