//! Words as the aligner compares them, and the string rules it reads text by. Offsets are code points.
use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;
use unicode_normalization::{char::canonical_combining_class, UnicodeNormalization};

static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+(?:['’‘ʼ`´][\p{L}\p{N}]+)*").unwrap());
static ALPHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A\p{L}+\z").unwrap());
// The decimal digits, and the digits of other kinds a word can still hold once normalised.
static DIGITS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A[\p{Nd}\x{1369}-\x{1371}\x{19DA}\x{24F5}-\x{24FD}\x{24FF}\x{2776}-\x{277E}\x{2780}-\x{2788}\x{278A}-\x{2792}\x{10A40}-\x{10A43}\x{10E60}-\x{10E68}\x{11052}-\x{1105A}]+\z").unwrap()
});

pub fn is_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

pub fn strip(text: &str) -> &str {
    text.trim_matches(is_space)
}

pub fn is_digits(word: &str) -> bool {
    DIGITS.is_match(word)
}

/// A character of a normalised word, case-folded.
fn fold(c: char, out: &mut String) {
    let u = c as u32;
    match u {
        0xDF | 0x1E9E => out.push_str("ss"),
        0x3C2 => out.push('σ'),
        0x13A0..=0x13F5 => out.push(c),
        0x13F8..=0x13FD | 0xAB70..=0xABBF => {
            out.push(char::from_u32(if u < 0x2000 { u - 8 } else { u - 0xAB70 + 0x13A0 }).unwrap())
        }
        0x1C80 => out.push('в'),
        0x1C81 => out.push('д'),
        0x1C82 => out.push('о'),
        0x1C83 => out.push('с'),
        0x1C84 | 0x1C85 => out.push('т'),
        0x1C86 => out.push('ъ'),
        0x1C87 => out.push('ѣ'),
        0x1C88 => out.push('ꙋ'),
        _ => out.extend(c.to_lowercase()),
    }
}

/// A word as compared: no accents, ligatures, apostrophes or case.
pub fn norm(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    if word.is_ascii() {
        out.extend(word.chars().filter(|c| !matches!(c, '\'' | '`')).map(|c| c.to_ascii_lowercase()));
        return out;
    }
    // (Apostrophes go first: a spacing accent decomposes to a space, and "pr´esent´e" is one word.)
    for c in word.chars().filter(|c| !matches!(c, '\'' | '’' | '‘' | 'ʼ' | '`' | '´')).nfkd() {
        if canonical_combining_class(c) == 0 {
            fold(c, &mut out);
        }
    }
    if out.contains(['æ', 'œ', 'ĳ']) {
        out = out.replace('æ', "ae").replace('œ', "oe").replace('ĳ', "ij");
    }
    out
}

/// Each normalised word of text with its offsets, from `start` (a code point, at byte `byte`).
pub fn scan(text: &str, byte: usize, start: usize, mut found: impl FnMut(&str, usize, usize)) {
    let (mut at_byte, mut at_char) = (byte, start);
    for m in WORD.find_iter(&text[byte..]) {
        let (a, b) = (byte + m.start(), byte + m.end());
        let s = at_char + text[at_byte..a].chars().count();
        let e = s + m.as_str().chars().count();
        (at_byte, at_char) = (b, e);
        found(m.as_str(), s, e);
    }
}

/// (normalised word, start, end) of every word of a text from code point `start`.
pub fn words_of(text: &str, start: usize) -> Vec<(String, usize, usize)> {
    let byte = text.char_indices().nth(start).map_or(text.len(), |(at, _)| at);
    let mut out = Vec::new();
    scan(text, byte, start, |word, s, e| {
        let word = norm(word);
        if !word.is_empty() {
            out.push((word, s, e));
        }
    });
    out
}

/// The normalised words of a text.
pub fn plain(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    scan(text, 0, 0, |word, _, _| {
        let word = norm(word);
        if !word.is_empty() {
            out.push(word)
        }
    });
    out
}

pub struct Word {
    pub chars: Vec<char>,
    pub digit: bool,
    pub alpha: bool,
}

#[derive(Clone, Copy)]
pub struct Token {
    pub word: u32,
    pub start: u32,
    pub end: u32,
}

/// One document's words, each held once: tokens compare by number.
#[derive(Default)]
pub struct Words {
    all: Vec<Word>,
    raw: HashMap<String, u32>,
    normal: HashMap<String, u32>,
}

impl Words {
    pub fn get(&self, id: u32) -> &Word {
        &self.all[id as usize]
    }

    fn intern(&mut self, raw: &str) -> u32 {
        if let Some(&id) = self.raw.get(raw) {
            return id;
        }
        let word = norm(raw);
        let id = match self.normal.get(&word) {
            Some(&id) => id,
            None => {
                let id = self.all.len() as u32;
                self.all.push(Word { chars: word.chars().collect(), digit: is_digits(&word), alpha: ALPHA.is_match(&word) });
                self.normal.insert(word, id);
                id
            }
        };
        self.raw.insert(raw.to_owned(), id);
        id
    }

    /// A line's words, a word set letter by letter ("R E A S O N S") read whole.
    pub fn of_line(&mut self, text: &str) -> Vec<Token> {
        let tokens = self.of(text, 0, 0);
        let chars: Vec<char> = text.chars().collect();
        let letter = |token: &Token| token.end - token.start == 1 && chars[token.start as usize].is_alphabetic();
        // (By spaces alone: "S.C.R." is three words, as the text has it.)
        let spaced = |a: &Token, b: &Token| b.start == a.end + 1 && is_space(chars[a.end as usize]);
        let (mut out, mut at) = (Vec::with_capacity(tokens.len()), 0);
        while at < tokens.len() {
            let mut end = at;
            while end + 1 < tokens.len() && letter(&tokens[end]) && letter(&tokens[end + 1]) && spaced(&tokens[end], &tokens[end + 1]) {
                end += 1;
            }
            if end - at >= 3 {
                let word: String = tokens[at..=end].iter().flat_map(|token| self.all[token.word as usize].chars.iter()).collect();
                let id = self.intern(&word);
                out.push(Token { word: id, start: tokens[at].start, end: tokens[end].end });
            } else {
                out.extend_from_slice(&tokens[at..=end]);
            }
            at = end + 1;
        }
        out
    }

    /// (word, start, end) of every word of text from `start` (a code point, at byte `byte`).
    pub fn of(&mut self, text: &str, byte: usize, start: usize) -> Vec<Token> {
        let mut out = Vec::new();
        scan(text, byte, start, |word, s, e| {
            let id = self.intern(word);
            if !self.all[id as usize].chars.is_empty() {
                out.push(Token { word: id, start: s as u32, end: e as u32 });
            }
        });
        out
    }
}

fn one_block(a: &[char], b: &[char]) -> usize {
    let mut ascii = [0u64; 128];
    let mut other: Vec<(char, u64)> = Vec::new();
    for (i, &c) in a.iter().enumerate() {
        if c.is_ascii() {
            ascii[c as usize] |= 1 << i;
        } else if let Some(entry) = other.iter_mut().find(|entry| entry.0 == c) {
            entry.1 |= 1 << i;
        } else {
            other.push((c, 1 << i));
        }
    }
    let top = 1u64 << (a.len() - 1);
    let (mut pv, mut mv, mut score) = (u64::MAX, 0u64, a.len());
    for &c in b {
        let eq = if c.is_ascii() { ascii[c as usize] } else { other.iter().find(|entry| entry.0 == c).map_or(0, |entry| entry.1) };
        let xv = eq | mv;
        let xh = ((eq & pv).wrapping_add(pv) ^ pv) | eq;
        let ph = mv | !(xh | pv);
        let mh = pv & xh;
        if ph & top != 0 {
            score += 1;
        } else if mh & top != 0 {
            score -= 1;
        }
        let ph = ph << 1 | 1;
        let mh = mh << 1;
        pv = mh | !(xv | ph);
        mv = ph & xv;
    }
    score
}

fn blocks(a: &[char], b: &[char]) -> usize {
    let width = a.len().div_ceil(64);
    let mut peq: HashMap<char, Vec<u64>> = HashMap::new();
    for (i, &c) in a.iter().enumerate() {
        peq.entry(c).or_insert_with(|| vec![0; width])[i / 64] |= 1 << (i % 64);
    }
    let none = vec![0u64; width];
    let top = 1u64 << ((a.len() - 1) % 64);
    let (mut pv, mut mv, mut score) = (vec![u64::MAX; width], vec![0u64; width], a.len());
    for c in b {
        let eq = peq.get(c).unwrap_or(&none);
        let (mut carry, mut ph_in, mut mh_in) = (false, 1u64, 0u64);
        for k in 0..width {
            let (e, p, m) = (eq[k], pv[k], mv[k]);
            let xv = e | m;
            let (sum, c1) = (e & p).overflowing_add(p);
            let (sum, c2) = sum.overflowing_add(carry as u64);
            carry = c1 || c2;
            let xh = (sum ^ p) | e;
            let ph = m | !(xh | p);
            let mh = p & xh;
            if k + 1 == width {
                if ph & top != 0 {
                    score += 1;
                } else if mh & top != 0 {
                    score -= 1;
                }
            }
            let shifted_ph = ph << 1 | ph_in;
            let shifted_mh = mh << 1 | mh_in;
            ph_in = ph >> 63;
            mh_in = mh >> 63;
            pv[k] = shifted_mh | !(xv | shifted_ph);
            mv[k] = shifted_ph & xv;
        }
    }
    score
}

/// Levenshtein distance, a column of the table at a time in the bits of a word (Myers, Hyyrö).
pub fn edit_distance(a: &[char], b: &[char]) -> usize {
    let head = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[head..], &b[head..]);
    let tail = a.iter().rev().zip(b.iter().rev()).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[..a.len() - tail], &b[..b.len() - tail]);
    let (a, b) = if a.len() > b.len() { (b, a) } else { (a, b) };
    match a.len() {
        0 => b.len(),
        1..=64 => one_block(a, b),
        _ => blocks(a, b),
    }
}

pub fn similarity(a: &[char], b: &[char]) -> f64 {
    1.0 - edit_distance(a, b) as f64 / a.len().max(b.len()).max(1) as f64
}
