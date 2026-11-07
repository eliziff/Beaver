//! A PDF's lines aligned with a clean text of the same decision, word by word. Deterministic.
//!
//! Pairing::new takes the PDF's lines in reading order and the reference text (A2AJ's unofficial text), less the spans
//! earlier passes already gave to other lines. Pairing::words is the alignment itself: each paired PDF word's line and
//! offsets in it, the span of the text it stands for, and whether it reads exactly so (exact), is a close misreading
//! (fuzzy) or is placed by its neighbours alone (forced). slices reads each line's exact text off it: always text
//! copied from the reference, never edited or reordered. Words are compared normalised (case, accents, ligatures,
//! apostrophes, spacing); a word the print breaks across two lines, or the reader cuts in two, pairs with the reference
//! word as a split, each half standing for its part of it; two reference words the reader runs together pair with the
//! one PDF word (a merge).
//!
//! Method: runs of 6, 4, 3 and 2 words that are unique in the OCR and in the text are chained by longest increasing
//! subsequence (patience diff) and grown while the words keep agreeing; what lies between the anchors is aligned by word
//! edit distance. A line is then
//!   anchored   its first and last words are both pinned by exactly matching words;
//!   filled     it lies between pinned lines but is garbled at an end: its slice runs between its pinned words, extended
//!              over the free words next to a garbled end; or nothing in it matched and it takes the free words between
//!              its neighbours, if it still resembles them;
//!   unmatched  the text has nothing for it (running heads, folios, the other language's column): it keeps its OCR text.
use super::words::{edit_distance, norm, plain, similarity, strip, Token, Words};
use std::collections::HashMap;
use std::ops::Range;

pub const LEADING: &str = "([{«“‘$";
pub const TRAILING: &str = ".,;:!?)]}»”’…—–%*";
pub const MIN_RESEMBLANCE: f64 = 0.5;
const LEVELS: [usize; 4] = [6, 4, 3, 2];
const CELL_LIMIT: usize = 1_000_000; // a gap this big between anchors is text one side lacks (a wrong document, a language not printed)
const GAP: f64 = -0.4;

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    None,
    Exact,
    Fuzzy,
    Forced,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::None => "",
            Kind::Exact => "exact",
            Kind::Fuzzy => "fuzzy",
            Kind::Forced => "forced",
        }
    }
}

type Gap = (usize, usize, usize, usize);

/// A word pair as a record keeps it: its offsets in the line, its span of the text, its kind.
#[derive(Clone, serde::Serialize)]
pub struct WordPair(pub u32, pub u32, pub u32, pub u32, pub &'static str);

pub struct Sliced {
    pub status: &'static str,
    pub exact: String,
    pub span: Option<[u32; 2]>,
}

/// A line to align: its text and its words.
pub struct Input<'a> {
    pub text: &'a str,
    pub tokens: &'a [Token],
}

/// A line's stretch of the reference: its first and last reference words and offsets, and its first and last PDF words
/// (none for a line that took free words).
struct Span {
    a0: i64,
    a1: i64,
    begin: u32,
    finish: u32,
    first: Option<usize>,
    last: usize,
}

/// OCR words against reference words: o2a[i] is the reference word OCR word i stands for, or -1.
///
/// Two OCR words may stand together for one reference word (the print broke it at a line's end, the reader cut it at a
/// ligature, or a margin letter fell inside it): partner records the pair; both map to the same reference word. One OCR
/// word may stand for two reference words the print or the reader ran together ("redressilegal"): merged[o] is the
/// second.
pub struct Pairing<'a> {
    words: &'a Words,
    text: &'a [char],
    lines: &'a [Input<'a>],
    atokens: Vec<Token>,
    a: Vec<u32>,
    o: Vec<u32>,
    line_of: Vec<u32>,
    offsets: Vec<(u32, u32)>,
    line_tokens: Vec<Range<usize>>,
    o2a: Vec<i64>,
    kind: Vec<Kind>,
    a_owner: Vec<i64>,
    partner: Vec<i64>,
    merged: Vec<i64>,
    cuts: HashMap<usize, (u32, u32)>,
}

fn longest_increasing(sequence: &[i64]) -> Vec<usize> {
    let (mut tails, mut tail_at): (Vec<i64>, Vec<usize>) = (Vec::new(), Vec::new());
    let mut previous = vec![usize::MAX; sequence.len()];
    for (i, &value) in sequence.iter().enumerate() {
        let at = tails.partition_point(|&tail| tail < value);
        if at == tails.len() {
            tails.push(value);
            tail_at.push(i);
        } else {
            tails[at] = value;
            tail_at[at] = i;
        }
        previous[i] = if at > 0 { tail_at[at - 1] } else { usize::MAX };
    }
    let mut chain = Vec::new();
    let mut i = tail_at.last().copied().unwrap_or(usize::MAX);
    while i != usize::MAX {
        chain.push(i);
        i = previous[i];
    }
    chain.reverse();
    chain
}

impl<'a> Pairing<'a> {
    /// `tokens`: the reference's words from where the decision begins. `exclude`: [begin, end) spans given to other lines.
    pub fn new(words: &'a Words, text: &'a [char], tokens: &[Token], lines: &'a [Input<'a>], exclude: &[[u32; 2]]) -> Self {
        let mut begins = exclude.to_vec();
        begins.sort();
        let atokens: Vec<Token> = if begins.is_empty() {
            tokens.to_vec()
        } else {
            tokens
                .iter()
                .filter(|token| {
                    let at = begins.partition_point(|span| span[0] <= token.start);
                    !(at > 0 && token.start < begins[at - 1][1])
                })
                .copied()
                .collect()
        };
        let a: Vec<u32> = atokens.iter().map(|token| token.word).collect();
        let (mut o, mut line_of, mut offsets, mut line_tokens) = (Vec::new(), Vec::new(), Vec::new(), Vec::with_capacity(lines.len()));
        for (k, line) in lines.iter().enumerate() {
            let from = o.len();
            for token in line.tokens {
                o.push(token.word);
                line_of.push(k as u32);
                offsets.push((token.start, token.end));
            }
            line_tokens.push(from..o.len());
        }
        let (count, others) = (o.len(), a.len());
        Pairing {
            words,
            text,
            lines,
            atokens,
            a,
            o,
            line_of,
            offsets,
            line_tokens,
            o2a: vec![-1; count],
            kind: vec![Kind::None; count],
            a_owner: vec![-1; others],
            partner: vec![-1; count],
            merged: vec![-1; count],
            cuts: HashMap::new(),
        }
    }

    fn link(&mut self, o: usize, a: usize, kind: Kind) {
        self.o2a[o] = a as i64;
        self.a_owner[a] = o as i64;
        self.kind[o] = kind;
    }

    /// The last reference word OCR word o stands for.
    fn last(&self, o: usize) -> i64 {
        if self.merged[o] >= 0 {
            self.merged[o]
        } else {
            self.o2a[o]
        }
    }

    fn unlink(&mut self, o: usize) {
        let other = if self.partner[o] >= 0 { self.partner[o] as usize } else { o };
        for t in [o, other] {
            self.partner[t] = -1;
            if self.merged[t] >= 0 {
                self.a_owner[self.merged[t] as usize] = -1;
                self.merged[t] = -1;
            }
            if self.o2a[t] >= 0 {
                let owner = self.a_owner[self.o2a[t] as usize];
                if owner == o as i64 || owner == t as i64 {
                    self.a_owner[self.o2a[t] as usize] = -1;
                }
            }
            self.o2a[t] = -1;
            self.kind[t] = Kind::None;
        }
    }

    // -- anchors -----------------------------------------------------------------------------------
    fn anchor_gap(&mut self, gap: Gap, n: usize) {
        let (olo, ohi, alo, ahi) = gap;
        if ohi - olo < n || ahi - alo < n {
            return;
        }
        let mut in_a: HashMap<&[u32], (usize, usize)> = HashMap::with_capacity(ahi - alo);
        for a in alo..=ahi - n {
            in_a.entry(&self.a[a..a + n]).or_insert((a, 0)).1 += 1;
        }
        let mut in_o: HashMap<&[u32], (usize, usize)> = HashMap::with_capacity(ohi - olo);
        for o in olo..=ohi - n {
            let gram = &self.o[o..o + n];
            if in_a.contains_key(gram) {
                in_o.entry(gram).or_insert((o, 0)).1 += 1;
            }
        }
        let mut pairs: Vec<(usize, usize)> = in_o
            .iter()
            .filter(|(gram, seen)| seen.1 == 1 && in_a[*gram].1 == 1)
            .map(|(gram, seen)| (seen.0, in_a[gram].0))
            .collect();
        pairs.sort_unstable();
        let order: Vec<i64> = pairs.iter().map(|pair| pair.1 as i64).collect();
        for at in longest_increasing(&order) {
            let (o, a) = pairs[at];
            for j in 0..n {
                if self.o2a[o + j] < 0 && self.a_owner[a + j] < 0 {
                    self.link(o + j, a + j, Kind::Exact);
                }
            }
        }
        // grow every pinned run while the words keep agreeing, to the right and then to the left
        for o in olo..ohi {
            let a = self.o2a[o];
            let mut step = 1;
            while a >= 0 && o + step < ohi && (a as usize) + step < ahi && self.o2a[o + step] < 0 && self.a_owner[a as usize + step] < 0
                && self.o[o + step] == self.a[a as usize + step]
            {
                self.link(o + step, a as usize + step, Kind::Exact);
                step += 1;
            }
        }
        for o in (olo..ohi).rev() {
            let a = self.o2a[o];
            let mut step = 1;
            while a >= 0 && o as i64 - step as i64 >= olo as i64 && a - step as i64 >= alo as i64 && self.o2a[o - step] < 0
                && self.a_owner[a as usize - step] < 0 && self.o[o - step] == self.a[a as usize - step]
            {
                self.link(o - step, a as usize - step, Kind::Exact);
                step += 1;
            }
        }
    }

    /// The stretches of a gap between its pinned words that have words on both sides.
    fn gaps_in(&self, gap: Gap, found: &mut Vec<Gap>) {
        let (olo, ohi, alo, ahi) = gap;
        let (mut previous_o, mut previous_a) = (olo as i64 - 1, alo as i64 - 1);
        for o in olo..=ohi {
            if o < ohi && self.o2a[o] < 0 {
                continue;
            }
            let a = if o < ohi { self.o2a[o] } else { ahi as i64 };
            if o as i64 - previous_o > 1 && a - previous_a > 1 {
                found.push(((previous_o + 1) as usize, o, (previous_a + 1) as usize, a as usize));
            }
            (previous_o, previous_a) = (o as i64, a);
        }
    }

    fn pair_score(&self, o: u32, a: u32) -> Option<f64> {
        if o == a {
            return Some(2.0);
        }
        let (o, a) = (&self.words.get(o).chars, &self.words.get(a).chars);
        if o.len() < 3 || a.len() < 3 || o.len().abs_diff(a.len()) as f64 > o.len().max(a.len()) as f64 / 2.0 {
            return None;
        }
        let sim = similarity(o, a);
        (sim >= 0.6).then(|| 2.0 * sim - 0.6)
    }

    /// Two OCR words read together as one reference word (also two reference words read as one OCR word), when
    /// together they read more like it than either alone ("[TRADUCTiION]" is "traduction", not "traduction le").
    fn split_score(&self, first: u32, second: u32, a: u32, joined: &mut Vec<char>) -> Option<f64> {
        let (first, second, a) = (&self.words.get(first).chars, &self.words.get(second).chars, &self.words.get(a).chars);
        let width = first.len() + second.len();
        if width == a.len() && a[..first.len()] == first[..] && a[first.len()..] == second[..] {
            return Some(2.0);
        }
        if a.len() < 5 || width.abs_diff(a.len()) > 2 {
            return None;
        }
        joined.clear();
        joined.extend_from_slice(first);
        joined.extend_from_slice(second);
        let sim = similarity(joined, a);
        if sim < 0.75 || sim <= similarity(first, a).max(similarity(second, a)) {
            return None;
        }
        Some(2.0 * sim - 0.6)
    }

    /// A number against a word of letters, of two characters or more: no misreading of the one.
    fn unlike(&self, ocr: u32, word: u32) -> bool {
        let (ocr, word) = (self.words.get(ocr), self.words.get(word));
        ocr.chars.len().max(word.chars.len()) >= 2 && (ocr.digit && word.alpha || ocr.alpha && word.digit)
    }

    fn joins(&self, first: u32, second: u32, whole: u32) -> bool {
        let (first, second, whole) = (&self.words.get(first).chars, &self.words.get(second).chars, &self.words.get(whole).chars);
        first.len() + second.len() == whole.len() && whole[..first.len()] == first[..] && whole[first.len()..] == second[..]
    }

    /// Align a small gap by word edit distance: exact words and close misreadings pair up, and so do a word the print
    /// broke across a line or the reader cut in two (with a margin letter of one or two characters fallen between the
    /// halves), and two words the reader ran together.
    fn dp_gap(&mut self, gap: Gap) {
        let (olo, ohi, alo, ahi) = gap;
        let (m, n) = (ohi - olo, ahi - alo);
        if m * n > CELL_LIMIT {
            return;
        }
        let stride = n + 1;
        let mut back = vec![0u8; (m + 1) * stride];
        back[1..stride].fill(2);
        let mut rows: [Vec<f64>; 4] = std::array::from_fn(|_| vec![0.0; stride]);
        for j in 0..=n {
            rows[0][j] = GAP * j as f64;
        }
        let mut joined = Vec::new();
        for i in 1..=m {
            let mut current = std::mem::take(&mut rows[i % 4]);
            current[0] = GAP * i as f64;
            back[i * stride] = 1;
            let word = self.o[olo + i - 1];
            let before = (i >= 2).then(|| self.o[olo + i - 2]);
            let around = before.filter(|&b| i >= 3 && self.words.get(b).chars.len() <= 2).map(|_| self.o[olo + i - 3]);
            let previous = &rows[(i + 3) % 4];
            for j in 1..=n {
                let (mut best, mut movement) = (previous[j] + GAP, 1u8);
                if current[j - 1] + GAP > best {
                    (best, movement) = (current[j - 1] + GAP, 2);
                }
                let a = self.a[alo + j - 1];
                if let Some(score) = self.pair_score(word, a) {
                    if previous[j - 1] + score >= best {
                        (best, movement) = (previous[j - 1] + score, 0);
                    }
                }
                if let Some(before) = before {
                    if let Some(score) = self.split_score(before, word, a, &mut joined) {
                        let row = &rows[(i + 2) % 4];
                        if row[j - 1] + score >= best {
                            (best, movement) = (row[j - 1] + score, 3);
                        }
                    }
                }
                if let Some(around) = around {
                    if let Some(score) = self.split_score(around, word, a, &mut joined) {
                        let row = &rows[(i + 1) % 4];
                        if row[j - 1] + score >= best {
                            (best, movement) = (row[j - 1] + score, 5);
                        }
                    }
                }
                // two reference words read as one ("[f]or" as "flor"), but no paragraph's "6" swallowed into the
                // "L'HUREUX" after it
                if j >= 2 {
                    let first = self.a[alo + j - 2];
                    if self.joins(first, a, word) || !self.unlike(first, a) {
                        if let Some(score) = self.split_score(first, a, word, &mut joined) {
                            if previous[j - 2] + score >= best {
                                (best, movement) = (previous[j - 2] + score, 4);
                            }
                        }
                    }
                }
                current[j] = best;
                back[i * stride + j] = movement;
            }
            rows[i % 4] = current;
        }
        let (mut i, mut j) = (m, n);
        while i > 0 || j > 0 {
            let movement = back[i * stride + j];
            if i > 0 && j > 0 && movement == 0 {
                let (o, a) = (olo + i - 1, alo + j - 1);
                let kind = if self.o[o] == self.a[a] { Kind::Exact } else { Kind::Fuzzy };
                self.link(o, a, kind);
                (i, j) = (i - 1, j - 1);
            } else if j > 0 && (movement == 3 || movement == 5) {
                let width = if movement == 3 { 2 } else { 3 };
                let (first, second, a) = (olo + i - width, olo + i - 1, alo + j - 1);
                let kind = if self.joins(self.o[first], self.o[second], self.a[a]) { Kind::Exact } else { Kind::Fuzzy };
                self.link(first, a, kind);
                self.o2a[second] = a as i64;
                self.kind[second] = kind;
                self.partner[first] = second as i64;
                self.partner[second] = first as i64;
                (i, j) = (i - width, j - 1);
            } else if i > 0 && j > 1 && movement == 4 {
                let (o, a) = (olo + i - 1, alo + j - 2);
                let kind = if self.joins(self.a[a], self.a[a + 1], self.o[o]) { Kind::Exact } else { Kind::Fuzzy };
                self.link(o, a, kind);
                self.a_owner[a + 1] = o as i64;
                self.merged[o] = a as i64 + 1;
                (i, j) = (i - 1, j - 2);
            } else if i > 0 && (j == 0 || movement == 1) {
                i -= 1;
            } else {
                j -= 1;
            }
        }
    }

    pub fn run(&mut self) {
        let mut gaps: Vec<Gap> = vec![(0, self.o.len(), 0, self.a.len())];
        for n in LEVELS {
            let mut following = Vec::new();
            for &gap in &gaps {
                self.anchor_gap(gap, n);
                self.gaps_in(gap, &mut following);
            }
            gaps = following;
        }
        for gap in gaps {
            self.dp_gap(gap);
        }
        self.drop_chance_matches();
        self.force_sandwiched();
    }

    /// A reference word left alone between two paired neighbours stands for the one PDF word left between theirs,
    /// however it reads ("1”" for "1er", "(6)" for "(b)" at a line's start): its place decides it; but a number does not
    /// stand for a word of letters, nor the reverse ("53", a paragraph's number in the margin, for "by", a word A2AJ's
    /// text lacks). Where other lines come between (a page's running head and folio, the other language's column), what
    /// counts is the end of the one neighbour's line and the start of the other's, and what is there must read like the
    /// word: one word, or two together (a word broken across a page).
    fn force_sandwiched(&mut self) {
        for a in 1..self.a.len().saturating_sub(1) {
            if self.a_owner[a] >= 0 || self.a_owner[a - 1] < 0 || self.a_owner[a + 1] < 0 {
                continue;
            }
            let neighbour = self.a_owner[a - 1];
            let before = neighbour.max(self.partner[neighbour as usize]) as usize;
            let after = self.a_owner[a + 1] as usize;
            if after == before + 2 && !self.unlike(self.o[before + 1], self.a[a]) {
                self.link(before + 1, a, Kind::Forced);
                continue;
            }
            let (ends, starts) = (self.line_of[before], self.line_of[after]);
            let mut between = Vec::new();
            for t in before + 1..after {
                if self.line_of[t] == ends || self.line_of[t] == starts {
                    between.push(t);
                    if between.len() > 2 {
                        break;
                    }
                }
            }
            let word = &self.words.get(self.a[a]).chars;
            if between.len() == 1 && similarity(&self.words.get(self.o[between[0]]).chars, word) >= MIN_RESEMBLANCE {
                self.link(between[0], a, Kind::Forced);
            } else if between.len() == 2 && self.line_of[between[0]] != self.line_of[between[1]] {
                let (first, second) = (between[0], between[1]);
                let joined: Vec<char> = [&self.words.get(self.o[first]).chars, &self.words.get(self.o[second]).chars]
                    .iter()
                    .flat_map(|chars| chars.iter().copied())
                    .collect();
                if similarity(&joined, word) >= MIN_RESEMBLANCE {
                    self.link(first, a, Kind::Forced);
                    self.o2a[second] = a as i64;
                    self.kind[second] = Kind::Forced;
                    self.partner[first] = second as i64;
                    self.partner[second] = first as i64;
                }
            }
        }
    }

    /// A line of four or more words with under 30% of them matched agrees by chance (the other language's column,
    /// running heads); a short line's match must sit next to its neighbours' on one side at least.
    fn drop_chance_matches(&mut self) {
        for k in 0..self.line_tokens.len() {
            let tokens = self.line_tokens[k].clone();
            let hits: Vec<usize> = tokens.clone().filter(|&t| self.o2a[t] >= 0).collect();
            if !hits.is_empty() && tokens.len() >= 4 && (hits.len() as f64) < 0.3 * tokens.len() as f64 {
                for t in hits {
                    if self.o2a[t] >= 0 {
                        self.unlink(t);
                    }
                }
            }
        }
        let matched: Vec<usize> = (0..self.o.len()).filter(|&t| self.o2a[t] >= 0).collect();
        let place: Vec<i64> = matched.iter().map(|&t| self.o2a[t]).collect();
        for (position, &t) in matched.iter().enumerate() {
            if self.line_tokens[self.line_of[t] as usize].len() > 3 || self.o2a[t] < 0 {
                continue;
            }
            let before = position == 0 || place[position] - place[position - 1] > 3;
            let after = position + 1 == matched.len() || place[position + 1] - place[position] > 3;
            if before && after {
                self.unlink(t);
            }
        }
    }

    /// Offset inside a reference word where its first `length` normalised characters end.
    fn offset_of(&self, token: Token, length: usize) -> u32 {
        let mut taken = 0;
        for at in token.start..token.end {
            taken += norm(&self.text[at as usize].to_string()).chars().count();
            if taken >= length {
                return at + 1;
            }
        }
        token.end
    }

    /// The offsets of PDF word t's half of a split reference word.
    fn cut(&self, t: usize, token: Token) -> (u32, u32) {
        let other = self.partner[t] as usize;
        let (first, second) = (t.min(other), t.max(other));
        let a = &self.words.get(token.word).chars;
        let (head, tail) = (&self.words.get(self.o[first]).chars, &self.words.get(self.o[second]).chars);
        // the cut that makes the two pieces read most like the two halves of the reference word
        let (mut best, mut chosen) = ((usize::MAX, usize::MAX), 1);
        for c in 1..a.len().max(2) {
            let at = c.min(a.len());
            let key = (edit_distance(head, &a[..at]) + edit_distance(tail, &a[at..]), c.abs_diff(head.len()));
            if key < best {
                (best, chosen) = (key, c);
            }
        }
        let at = self.offset_of(token, chosen);
        if t == first {
            (token.start, at)
        } else {
            (at, token.end)
        }
    }

    /// Offsets of the part of the reference word that PDF word t stands for (of both, for a merge).
    fn edges(&mut self, t: usize) -> (u32, u32) {
        let token = self.atokens[self.o2a[t] as usize];
        if self.partner[t] < 0 {
            return (token.start, self.atokens[self.last(t) as usize].end);
        }
        if let Some(&cut) = self.cuts.get(&t) {
            return cut;
        }
        let cut = self.cut(t, token);
        self.cuts.insert(t, cut);
        cut
    }

    /// Each paired PDF word: (line, its pair), in reading order; a PDF word that stands for two reference words is
    /// paired with each.
    pub fn words(&mut self) -> Vec<(u32, WordPair)> {
        let mut out = Vec::new();
        for t in 0..self.o.len() {
            if self.o2a[t] < 0 {
                continue;
            }
            let (line, (start, end), kind) = (self.line_of[t], self.offsets[t], self.kind[t].name());
            if self.merged[t] >= 0 {
                for a in [self.o2a[t], self.merged[t]] {
                    let token = self.atokens[a as usize];
                    out.push((line, WordPair(start, end, token.start, token.end, kind)));
                }
            } else {
                let (from, to) = self.edges(t);
                out.push((line, WordPair(start, end, from, to, kind)));
            }
        }
        out
    }

    /// One result per line: its status, its exact text (the slice of the reference, or none when unmatched) and its
    /// [start, end) offsets into the reference.
    pub fn slices(&mut self) -> Vec<Sliced> {
        let count = self.lines.len();
        let mut claimed = vec![false; self.atokens.len()]; // reference words taken by an extension
        let mut spans: Vec<Option<Span>> = (0..count).map(|_| None).collect();
        for k in 0..count {
            let tokens = self.line_tokens[k].clone();
            let hits: Vec<usize> = tokens.clone().filter(|&t| self.o2a[t] >= 0).collect();
            let (Some(&first), Some(&last)) = (hits.first(), hits.last()) else { continue };
            let (mut a0, mut a1) = (self.o2a[first], self.last(last));
            let (mut begin, mut finish) = (self.edges(first).0, self.edges(last).1);
            let (mut lead, mut trail) = (first - tokens.start, tokens.end - 1 - last);
            let starts_inside = self.partner[first] >= 0 && (self.partner[first] as usize) < first;
            let ends_inside = self.partner[last] >= 0 && self.partner[last] as usize > last;
            while lead > 0 && !starts_inside && a0 >= 1 && self.a_owner[a0 as usize - 1] < 0 && !claimed[a0 as usize - 1] {
                a0 -= 1;
                lead -= 1;
                claimed[a0 as usize] = true;
                begin = self.atokens[a0 as usize].start;
            }
            while trail > 0 && !ends_inside && ((a1 + 1) as usize) < self.atokens.len() && self.a_owner[a1 as usize + 1] < 0 && !claimed[a1 as usize + 1] {
                a1 += 1;
                trail -= 1;
                claimed[a1 as usize] = true;
                finish = self.atokens[a1 as usize].end;
            }
            spans[k] = Some(Span { a0, a1, begin, finish, first: Some(first), last });
        }

        // a line in which nothing matched takes the free words between its neighbours, if they fit it
        let mut k = 0;
        while k < count {
            if spans[k].is_some() || self.line_tokens[k].is_empty() {
                k += 1;
                continue;
            }
            let mut run = k;
            while run < count && spans[run].is_none() {
                run += 1;
            }
            let before = (0..k).rev().find_map(|i| spans[i].as_ref().map(|span| span.a1));
            let after = (run < count).then(|| spans[run].as_ref().unwrap().a0);
            if let (Some(before), Some(after)) = (before, after) {
                let free: Vec<usize> = (before + 1..after).map(|a| a as usize).filter(|&a| self.a_owner[a] < 0 && !claimed[a]).collect();
                let members: Vec<usize> = (k..run).filter(|&i| !self.line_tokens[i].is_empty()).collect();
                let need: usize = members.iter().map(|&i| self.line_tokens[i].len()).sum();
                let fits = 0.5 * need as f64 <= free.len() as f64 && free.len() as f64 <= 2.0 * need as f64 + 1.0;
                if !free.is_empty() && !members.is_empty() && fits {
                    let weight: Vec<usize> = members.iter().map(|&i| strip(self.lines[i].text).chars().count().max(1)).collect();
                    let total: usize = weight.iter().sum();
                    let (mut taken, mut running) = (0, 0);
                    for (&i, &w) in members.iter().zip(&weight) {
                        running += w;
                        let stop = ((free.len() * running) as f64 / total as f64).round_ties_even() as usize;
                        if stop > taken {
                            let chunk = &free[taken..stop];
                            let (head, tail) = (chunk[0], chunk[chunk.len() - 1]);
                            spans[i] = Some(Span {
                                a0: head as i64,
                                a1: tail as i64,
                                begin: self.atokens[head].start,
                                finish: self.atokens[tail].end,
                                first: None,
                                last: 0,
                            });
                            taken = stop;
                        }
                    }
                }
            }
            k = run;
        }

        let text = self.text;
        let mut results = Vec::with_capacity(count);
        let mut cursor = 0usize;
        for (k, span) in spans.iter().enumerate() {
            let unmatched = || Sliced { status: "unmatched", exact: String::new(), span: None };
            let Some(span) = span else {
                results.push(unmatched());
                continue;
            };
            let (mut begin, mut finish) = ((span.begin as usize).max(cursor), span.finish as usize);
            // punctuation stuck to the first and last word belongs to the line
            while begin > cursor && LEADING.contains(text[begin - 1]) {
                begin -= 1;
            }
            while finish < text.len() && TRAILING.contains(text[finish]) {
                finish += 1;
            }
            let exact: String = if begin < finish { text[begin..finish].iter().collect() } else { String::new() };
            let exact = strip(&exact);
            if begin >= finish || resemblance(self.lines[k].text, exact) < MIN_RESEMBLANCE {
                results.push(unmatched());
                continue;
            }
            let pinned = span.first.is_some_and(|first| self.kind[first] == Kind::Exact && self.kind[span.last] == Kind::Exact);
            results.push(Sliced {
                status: if pinned { "anchored" } else { "filled" },
                exact: exact.to_owned(),
                span: Some([begin as u32, finish as u32]),
            });
            cursor = finish;
        }
        results
    }
}

/// How alike two lines read, by their normalised words.
fn resemblance(ocr: &str, exact: &str) -> f64 {
    let (a, b): (Vec<char>, Vec<char>) = (plain(ocr).join(" ").chars().collect(), plain(exact).join(" ").chars().collect());
    if a.is_empty() && b.is_empty() {
        0.0
    } else {
        similarity(&a, &b)
    }
}
