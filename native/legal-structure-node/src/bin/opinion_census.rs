#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! One pass over CourtListener's whole opinions file as the census stream stores it (stream/opinions:
//! frames.jsonl, shards/shard-NNNN.zst, header.csv; stream/clusters and stream/dockets the same way):
//! each opinion's census (experiments/courtlistener-census/census-row.mjs, ported), its court, decade and
//! cluster source, how html_with_citations relates to the other renditions, and what the structure engine
//! reads from the rendition production reads (html_with_citations, else CourtListener's source order),
//! plus any rendition that supplies a marker html_with_citations does not carry. Built with the addon.
//!
//!   opinion_census run   --stream DIR --out DIR [--threads N] [--frames A-B] [--no-engine] [--rows]
//!                        [--decoder experiments/courtlistener-census/zstd-frames.mjs]
//!   opinion_census merge --out DIR          (every frame's partial aggregate into aggregate.json)
//!   opinion_census diff  --out DIR --sidecars DIR [--frames A-B]   (--rows census against the JS sidecars)
//!
//! Frames decode through a node child (zstd-frames.mjs), one per thread. Each frame writes out/frames/NNNNNN.json
//! (its aggregate) and, with --rows, out/rows/NNNNNN.jsonl, atomically, so a run resumes where it stopped.

use legal_structure::{analyze_native_markup, document_outline, javascript_whitespace as is_js_space,
    trim_javascript_whitespace as js_trim, utf16_len as utf16, DocumentStructure, NativeMarkupInput, NodeKind, PrimaryRole, JS_WHITESPACE_CLASS};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

// ---- JavaScript string semantics -----------------------------------------------------------------

// JavaScript's \s (white space and line terminators), in which the census patterns were written.
fn js(pattern: &str) -> String {
    pattern.replace(r"\S", &format!("[^{JS_WHITESPACE_CLASS}]")).replace(r"\s", JS_WHITESPACE_CLASS)
        .replace(r"\w", "[A-Za-z0-9_]").replace(r"\d", "[0-9]").replace(r"\b", r"(?-u:\b)")
}
/// JavaScript's value.slice(0, n): the first n UTF-16 units (a split pair is left out).
fn js_prefix(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (byte, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n { return &s[..byte]; }
    }
    s
}

/// A value's shape: letter runs a/A, digit runs 9, white space runs a space; 32 units of the first 48.
fn shape(value: &str) -> String {
    let mut out = String::new();
    let mut last = '\0';
    for c in js_prefix(value, 48).chars() {
        let class = if c.is_ascii_lowercase() { 'a' } else if c.is_ascii_uppercase() { 'A' } else if c.is_ascii_digit() { '9' }
            else if is_js_space(c) { ' ' } else { out.push(c); last = '\0'; continue; };
        if class != last { out.push(class); }
        last = class;
    }
    js_prefix(&out, 32).to_owned()
}

/// Counts in JavaScript's own-key order: integer keys ascending, then insertion order.
#[derive(Default)]
struct Counts { keys: Vec<String>, index: HashMap<String, usize>, values: Vec<u64> }
impl Counts {
    fn inc(&mut self, key: &str, n: u64) {
        if let Some(&at) = self.index.get(key) { self.values[at] += n; return; }
        self.index.insert(key.to_owned(), self.keys.len());
        self.keys.push(key.to_owned());
        self.values.push(n);
    }
    fn set(&mut self, key: &str, n: u64) {
        match self.index.get(key) { Some(&at) => self.values[at] = n, None => self.inc(key, n) }
    }
    fn ordered(&self) -> Vec<(String, u64)> {
        let integer = |key: &str| -> Option<u64> {
            let canonical = key == "0" || (!key.is_empty() && !key.starts_with('0') && key.len() <= 10 && key.bytes().all(|b| b.is_ascii_digit()));
            if !canonical { return None; }
            key.parse::<u64>().ok().filter(|v| *v < 4294967295)
        };
        let mut ints: Vec<(u64, usize)> = Vec::new();
        let mut rest: Vec<usize> = Vec::new();
        for (i, k) in self.keys.iter().enumerate() {
            match integer(k) { Some(v) => ints.push((v, i)), None => rest.push(i) }
        }
        ints.sort();
        ints.into_iter().map(|(_, i)| i).chain(rest).map(|i| (self.keys[i].clone(), self.values[i])).collect()
    }
    fn value(&self) -> Value {
        let mut map = Map::new();
        for (k, v) in self.ordered() { map.insert(k, json!(v)); }
        Value::Object(map)
    }
    /// census-row.mjs top(): the map when it has at most n keys, else its n largest and "…more".
    fn top(&self, n: usize) -> Option<Value> {
        if self.keys.is_empty() { return None; }
        if self.keys.len() <= n { return Some(self.value()); }
        let mut entries = self.ordered();
        entries.sort_by(|a, b| b.1.cmp(&a.1));
        let mut map = Map::new();
        for (k, v) in entries.into_iter().take(n) { map.insert(k, json!(v)); }
        map.insert("…more".to_owned(), json!(self.keys.len() - n));
        Some(Value::Object(map))
    }
}

// ---- patterns --------------------------------------------------------------------------------------

/// A marker family. JavaScript's lookarounds become checks on each candidate's neighbours: the character
/// before it (`not_before`, where "w" stands for any word character) and what follows it.
struct Family { name: &'static str, re: Regex, not_before: &'static str, after: After }
#[derive(Clone, Copy, PartialEq)]
enum After { Any, NotDigit, NotDigitOrBracket, NotSpacedDigit }
impl Family {
    fn accepts(&self, text: &str, start: usize, end: usize) -> bool {
        if let Some(prev) = text[..start].chars().next_back() {
            if self.not_before.contains(prev) || (self.not_before.contains('w') && (prev.is_ascii_alphanumeric() || prev == '_')) {
                return false;
            }
        }
        let next = text[end..].chars().next();
        match self.after {
            After::Any => true,
            After::NotDigit => !next.is_some_and(|c| c.is_ascii_digit()),
            After::NotDigitOrBracket => !next.is_some_and(|c| c.is_ascii_digit() || c == ']'),
            After::NotSpacedDigit => !text[end..].trim_start_matches(is_js_space).starts_with(|c: char| c.is_ascii_digit()),
        }
    }
    /// Leftmost matches; a candidate its neighbours reject is retried one character on.
    fn starts(&self, text: &str) -> Vec<usize> {
        let plain = self.not_before.is_empty() && self.after == After::Any;
        let mut out = Vec::new();
        let mut at = 0;
        while at <= text.len() {
            let Some(m) = self.re.find_at(text, at) else { break };
            let step = text[m.start()..].chars().next().map_or(1, char::len_utf8);
            if plain || self.accepts(text, m.start(), m.end()) {
                out.push(m.start());
                at = if m.end() > m.start() { m.end() } else { m.end() + step };
            } else {
                at = m.start() + step;
            }
        }
        out
    }
}

struct Patterns {
    markup: Regex, attr: Regex, block: Regex, comment: Regex, tag: Regex, entity: Regex, marked: Regex,
    host: Regex, ext: Regex, local: Regex, href: Regex, trailing_slash: Regex, key_entity: Regex,
    families: Vec<Family>, lines: Vec<(&'static str, Regex)>, leading: Vec<(&'static str, Regex)>,
    /// The line and leading families as one set, tested once per line.
    line_set: regex::RegexSet, line_names: Vec<&'static str>,
}
fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| {
        let mut p = patterns_unset();
        p.line_names = p.lines.iter().chain(p.leading.iter()).map(|(name, _)| *name).collect();
        p.line_set = regex::RegexSet::new(p.lines.iter().chain(p.leading.iter()).map(|(_, re)| re.as_str())).expect("line patterns");
        p
    })
}
fn patterns_unset() -> Patterns {
    {
        let r = |p: &str| Regex::new(&js(p)).expect("census pattern");
        let fam = |name: &'static str, p: &str, not_before: &'static str, after: After| Family { name, re: r(p), not_before, after };
        let plain = |name: &'static str, p: &str| fam(name, p, "", After::Any);
        Patterns {
            markup: r(r#"<!--([\s\S]*?)-->|<!\[CDATA\[[\s\S]*?\]\]>|<!([A-Za-z]+)[^>]*>|<\?([A-Za-z][\w:-]*)[^>]*\?>|<(/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);"#),
            attr: r(r#"([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?"#),
            block: Regex::new(r"(?i)</?(?:p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|blockquote|pre|center|footnote|footnotes|opinion|author|judges|parties|docketnumber|court|decisiondate|otherdate|attorneys|syllabus|summary|headnotes|history|disposition|correction|seealso|heading|casebody|headmatter|section|article|dd|dt|dl|hr|body|html|title)(?-u:\b)[^>]*>").expect("block pattern"),
            comment: r(r"<!--[\s\S]*?-->"),
            tag: r(r"<[^>]*>"),
            entity: r(r"&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z]+);"),
            key_entity: Regex::new(r"(?i)&(#[0-9]+|#x[0-9a-f]+|[a-z]+);").expect("entity pattern"),
            marked: r(r"</?[A-Za-z][\w:-]*[\s>/]|&(?:#\d+|[a-z]+);"),
            host: Regex::new(r"(?i)^[a-z]+://([^/]+)").expect("host pattern"),
            ext: Regex::new(r"\.([A-Za-z0-9]{1,5})(?:[?#]|$)").expect("extension pattern"),
            local: Regex::new(r"\.([A-Za-z0-9]{1,5})$").expect("local path pattern"),
            href: Regex::new(r"(?i)^([a-z]+://[^/]+)?(/?[^/?#]*)?").expect("href pattern"),
            trailing_slash: r(r"/\s*$"),
            families: vec![
                plain("bracket_star", r"\[\*+\s?\d{1,5}\]"),
                plain("star_page_word", r"\*\s?Page\s+\d{1,5}"),
                fam("double_star", r"\*\*\s?\d{1,5}", "w*", After::NotDigit),
                fam("star_n", r"\*\s?\d{1,5}", "w*[", After::NotDigitOrBracket),
                plain("bracket_pilcrow", r"\[¶\s*\d+(?:\.\d+)?\.?\]"),
                plain("brace_pilcrow", r"\{¶\s*\d+(?:\.\d+)?\.?\}"),
                plain("mojibake_pilcrow", r"Â¶\s*\d*"),
                fam("pilcrow_n", r"¶\s*\d+", "[{Â", After::Any),
                fam("pilcrow_other", r"¶", "[{Â", After::NotSpacedDigit),
                plain("section_sign", r"§+"),
                plain("bracket_n", r"\[\d{1,4}\]"),
                plain("brace_n", r"\{\d{1,4}\}"),
                plain("bracket_fn", r"\[(?:fn|FN|Fn)\s?\d+\]"),
                plain("fn_n", r"\bFN\s?\d+\b"),
                plain("page_n_of_m", r"(?i)\bPage\s+\d+\s+of\s+\d+\b"),
                plain("ct_page", r"\bCT\s+Page\s+\d+"),
                plain("ecf_stamp", r"Case\s+[\w:.\-]+\s+Document\s+[\w\-]+\s+Filed\s+[\d/.\-]+\s+Page\s+\d+\s+of\s+\d+"),
                plain("continued", r"\((?:continued|Continued|CONTINUED)[.…]*\)"),
                plain("cite_as", r"\[Cite as [^\]]{0,120}\]"),
                plain("slip_op", r"\bSlip Op(?:inion)?\.?\b"),
            ],
            lines: vec![
                ("line_dash_n_dash", r(r"^-\s?\d{1,4}\s?-$")),
                ("line_bare_number", r(r"^\d{1,4}$")),
                ("line_page_n", r(r"(?i)^Page\s+\d{1,4}$")),
                ("line_roman_label", r(r"^[IVXLC]{1,7}\.?$")),
                ("line_letter_label", r(r"^[A-Z]\.?$")),
                ("line_paren_label", r(r"^\(?(?:[a-z]{1,2}|\d{1,3}|[ivx]{1,5})\)$")),
                ("line_number_label", r(r"^\d{1,3}\.$")),
                ("line_star_n", r(r"^\*\s?\d{1,5}$")),
                ("line_bracket_star", r(r"^\[\*+\s?\d{1,5}\]$")),
                ("line_bracket_n", r(r"^\[\d{1,4}\]$")),
                ("line_all_caps", r(r"^[^a-z]*[A-Z]{3,}[^a-z]*$")),
            ],
            leading: vec![
                ("lead_roman", r(r"^[IVXLC]{1,7}\.\s")),
                ("lead_letter", r(r"^[A-Z]\.\s")),
                ("lead_paren", r(r"^\((?:[a-z]{1,2}|\d{1,3}|[ivx]{1,5})\)\s")),
                ("lead_number", r(r"^\d{1,3}\.\s")),
                ("lead_bracket_n", r(r"^\[\d{1,4}\]\s?")),
                ("lead_star", r(r"^\*\s?\d{1,5}\s")),
                ("lead_pilcrow", r(r"^[\[{]?¶\s*\d+")),
                ("lead_footnote_n", r(r"^\d{1,3}\s+[A-Z]")),
            ],
            line_set: regex::RegexSet::empty(),
            line_names: Vec::new(),
        }
    }
}

// ---- the census row (census-row.mjs) ------------------------------------------------------------

fn numeric_entity(e: &str) -> String {
    let hex = e.as_bytes().get(1).is_some_and(|b| *b == b'x' || *b == b'X');
    let cp = if hex { u128::from_str_radix(&e[2..], 16).ok() } else { e[1..].parse::<u128>().ok() };
    match cp {
        Some(cp) => format!("#U+{:0>4}", format!("{cp:X}")),
        None => "#U+?".to_owned(),
    }
}

fn href_shape(v: &str) -> String {
    let p = patterns();
    let m = p.href.captures(v);
    let host = m.as_ref().and_then(|m| m.get(1)).map_or(String::new(), |h| {
        let h = h.as_str();
        h.find("://").map_or(h.to_owned(), |at| h[at + 3..].to_owned())
    });
    let path = m.as_ref().and_then(|m| m.get(2)).map_or("", |g| g.as_str());
    format!("{host}{}{}", shape(path), if v.contains('#') { "#" } else { "" })
}

/// Every markup item of a markup string, counted: <tag, </tag, tag.class, tag@attr, tag@attr=shape, &entity;, comments.
fn markup_tokens(s: &str) -> Counts {
    let p = patterns();
    let mut tok = Counts::default();
    for m in p.markup.captures_iter(s) {
        if let Some(c) = m.get(1) { tok.inc(&format!("<!--{}-->", shape(js_trim(c.as_str()))), 1); continue; }
        if m.get(0).is_some_and(|w| w.as_str().starts_with("<![CDATA[")) { tok.inc("<![CDATA[", 1); continue; }
        if let Some(d) = m.get(2) { tok.inc(&format!("<!{}", d.as_str().to_lowercase()), 1); continue; }
        if let Some(pi) = m.get(3) { tok.inc(&format!("<?{}", pi.as_str()), 1); continue; }
        if let Some(name) = m.get(5) {
            let name = name.as_str();
            if m.get(4).is_some_and(|close| !close.as_str().is_empty()) { tok.inc(&format!("</{name}"), 1); continue; }
            tok.inc(&format!("<{name}"), 1);
            let attrs = m.get(6).map_or("", |a| a.as_str());
            if !js_trim(attrs).is_empty() && js_trim(attrs) != "/" {
                for a in p.attr.captures_iter(attrs) {
                    let Some(an) = a.get(1).map(|an| an.as_str()) else { continue };
                    if an == "/" { continue; }
                    let v = a.get(2).or_else(|| a.get(3)).or_else(|| a.get(4)).map(|v| v.as_str());
                    tok.inc(&format!("{name}@{an}"), 1);
                    if let Some(v) = v {
                        if an == "class" {
                            for c in v.split(is_js_space).filter(|c| !c.is_empty()) { tok.inc(&format!("{name}.{c}"), 1); }
                        }
                        if !matches!(an, "aria-description" | "title" | "alt" | "aria-label") {
                            let shaped = if an == "href" || an == "src" { href_shape(v) } else { shape(v) };
                            tok.inc(&format!("{name}@{an}={shaped}"), 1);
                        }
                    }
                }
            }
            if p.trailing_slash.is_match(attrs) { tok.inc(&format!("{name}/>"), 1); }
            continue;
        }
        if let Some(e) = m.get(7) {
            let e = e.as_str();
            let entity = if e.starts_with('#') { numeric_entity(e) } else { e.to_owned() };
            tok.inc(&format!("&{entity};"), 1);
        }
    }
    tok
}

fn decode_code_point(e: &str) -> Option<String> {
    let rest = e.strip_prefix('#')?;
    let cp = if rest.starts_with(['x', 'X']) { u32::from_str_radix(&rest[1..], 16).ok() } else { rest.parse::<u32>().ok() };
    cp.and_then(char::from_u32).map(|c| c.to_string())
}

/// Text projection of markup: block boundaries become newlines; other tags vanish; common entities decode.
fn text_of(markup: &str) -> String {
    let p = patterns();
    let s = p.comment.replace_all(markup, "");
    let s = p.block.replace_all(&s, "\n");
    let s = p.tag.replace_all(&s, "");
    p.entity.replace_all(&s, |c: &regex::Captures| -> String {
        let whole = c.get(0).map_or("", |w| w.as_str());
        let e = c.get(1).map_or("", |e| e.as_str());
        if e.starts_with('#') { return decode_code_point(e).unwrap_or_else(|| whole.to_owned()); }
        let named: &str = match e {
            "amp" => "&", "lt" => "<", "gt" => ">", "quot" => "\"", "apos" => "'", "nbsp" => "\u{A0}",
            "sect" => "§", "para" => "¶", "mdash" => "—", "ndash" => "–", _ => whole,
        };
        named.to_owned()
    }).into_owned()
}

/// Marker families, line families, line-start shapes, repeated lines and short lines of a text.
fn text_census(text: &str, o: &mut Map<String, Value>) {
    let p = patterns();
    let mut mk = Counts::default();
    let mut first_star: Option<usize> = None;
    let bytes = text.as_bytes();
    for family in &p.families {
        let starts = family.starts(text);
        for &start in &starts {
            if matches!(family.name, "star_n" | "bracket_star" | "star_page_word") && first_star.is_none_or(|f| start < f) {
                first_star = Some(start);
            }
            let mut k = start;
            while k > 0 && matches!(bytes[k - 1], b' ' | b'\t') { k -= 1; }
            if k == 0 || bytes[k - 1] == b'\n' { mk.inc(&format!("{}:ls", family.name), 1); }
        }
        if !starts.is_empty() { mk.inc(family.name, starts.len() as u64); }
    }
    let mut ls = Counts::default();
    let mut short = Counts::default();
    let mut seen = Counts::default();
    let mut non_empty = 0u64;
    for raw in text.split('\n') {
        let replaced = raw.replace('\u{A0}', " ");
        let line = js_trim(&replaced);
        if line.is_empty() { continue; }
        non_empty += 1;
        for index in p.line_set.matches(line).iter() { mk.inc(p.line_names[index], 1); }
        let first = line.split(is_js_space).next().unwrap_or("");
        if utf16(first) <= 8 && first.chars().any(|c| !c.is_ascii_alphabetic()) { ls.inc(&shape(first), 1); }
        let length = utf16(line);
        if length <= 30 { short.inc(&shape(line), 1); }
        if length <= 120 {
            let mut norm = String::with_capacity(line.len());
            let mut digit = false;
            let mut space = false;
            for c in line.chars() {
                if c.is_ascii_digit() { if !digit { norm.push('9'); } digit = true; space = false; continue; }
                digit = false;
                if is_js_space(c) { if !space { norm.push(' '); } space = true; continue; }
                space = false;
                norm.push(c);
            }
            seen.inc(&norm, 1);
        }
    }
    let mut rep = Counts::default();
    for (k, v) in seen.keys.iter().zip(seen.values.iter()) {
        if *v >= 3 { rep.set(js_prefix(k, 80), *v); }
    }
    o.insert("mk".into(), mk.value());
    if let Some(v) = ls.top(40) { o.insert("ls".into(), v); }
    if let Some(v) = short.top(40) { o.insert("short".into(), v); }
    if let Some(v) = rep.top(15) { o.insert("rep".into(), v); }
    o.insert("lines".into(), json!(non_empty));
    o.insert("textLen".into(), json!(utf16(text)));
    if let Some(at) = first_star { o.insert("preStar".into(), json!(utf16(&text[..at]))); }
}

fn field_census(value: &str, markup: bool) -> Value {
    let mut o = Map::new();
    o.insert("b".into(), json!(value.len()));
    if markup { o.insert("tok".into(), markup_tokens(value).value()); }
    if markup {
        let projected = text_of(value);
        text_census(&projected, &mut o);
    } else {
        text_census(value, &mut o);
    }
    Value::Object(o)
}

const RENDITIONS: [&str; 8] = ["plain_text", "html", "html_lawbox", "html_columbia", "html_anon_2020", "xml_harvard", "xml_scan", "html_with_citations"];
// CourtListener's source order for html_with_citations (cl/citations/utils.py).
const HWC_ORDER: [&str; 7] = ["xml_harvard", "xml_scan", "html_anon_2020", "html_columbia", "html_lawbox", "html", "plain_text"];
const CLUSTER_FIELDS: [&str; 17] = ["judges", "procedural_history", "attorneys", "nature_of_suit", "posture", "syllabus", "headnotes",
    "summary", "disposition", "history", "other_dates", "cross_reference", "correction", "arguments", "headmatter",
    "filepath_json_harvard", "filepath_pdf_harvard"];

fn js_number(v: Option<&str>) -> Value {
    let s = js_trim(v.unwrap_or(""));
    if s.is_empty() { return json!(0); }
    if let Ok(n) = s.parse::<u64>() { return json!(n); }
    s.parse::<f64>().ok().filter(|f| f.is_finite()).map_or(Value::Null, |f| json!(f))
}

struct Row<'a> { col: &'a HashMap<String, usize>, fields: Vec<Option<String>> }
impl Row<'_> {
    fn get(&self, key: &str) -> Option<&str> { self.col.get(key).and_then(|&i| self.fields.get(i)).and_then(|v| v.as_deref()) }
}

/// census-row.mjs opinionCensus.
fn opinion_census(row: &Row) -> Value {
    let p = patterns();
    let mut renditions = Map::new();
    for name in RENDITIONS {
        let Some(v) = row.get(name) else { continue };
        if v.is_empty() { renditions.insert(name.into(), json!({"b": 0})); continue; }
        let markup = name != "plain_text";
        let mut census = field_census(v, markup);
        if !markup && p.marked.is_match(js_prefix(v, 200000)) {
            if let Some(o) = census.as_object_mut() { o.insert("tok".into(), markup_tokens(v).value()); }
        }
        renditions.insert(name.into(), census);
    }
    let dl = row.get("download_url");
    let mut o = Map::new();
    o.insert("id".into(), js_number(row.get("id")));
    o.insert("cl".into(), js_number(row.get("cluster_id")));
    o.insert("ty".into(), json!(row.get("type")));
    o.insert("ocr".into(), json!(row.get("extracted_by_ocr")));
    o.insert("pc".into(), json!(row.get("page_count")));
    o.insert("au".into(), json!(row.get("author_id").is_some()));
    o.insert("pcur".into(), json!(row.get("per_curiam")));
    o.insert("dl".into(), match dl {
        None => Value::Null,
        Some("") => json!(""),
        Some(d) => json!(p.host.captures(d).and_then(|m| m.get(1)).map_or_else(|| shape(d), |m| m.as_str().to_owned())),
    });
    if let Some(d) = dl.filter(|d| !d.is_empty()) {
        o.insert("dlx".into(), json!(p.ext.captures(d).and_then(|m| m.get(1)).map_or(String::new(), |m| m.as_str().to_lowercase())));
    }
    o.insert("lp".into(), match row.get("local_path") {
        None => Value::Null,
        Some("") => json!(""),
        Some(l) => json!(p.local.captures(l).and_then(|m| m.get(1)).map_or("other".to_owned(), |m| m.as_str().to_lowercase())),
    });
    o.insert("R".into(), Value::Object(renditions));
    Value::Object(o)
}

// ---- CSV ---------------------------------------------------------------------------------------------

/// Fields of one PostgreSQL CSV record (ESCAPE '\'): unquoted empty is NULL, "" is empty (lib.mjs parseRecord).
fn parse_record(rec: &[u8]) -> std::result::Result<Vec<Option<String>>, String> {
    let mut fields = Vec::new();
    let mut end = rec.len();
    if end > 0 && rec[end - 1] == b'\n' { end -= 1; }
    if end > 0 && rec[end - 1] == b'\r' { end -= 1; }
    let mut i = 0;
    loop {
        if i >= end { fields.push(None); break; }
        if rec[i] == b'"' {
            i += 1;
            let mut value = Vec::new();
            loop {
                let Some(at) = rec[i..].iter().position(|b| *b == b'"' || *b == b'\\') else { return Err("unterminated quote".into()) };
                let at = i + at;
                value.extend_from_slice(&rec[i..at]);
                if rec[at] == b'\\' {
                    if at + 1 < rec.len() { value.push(rec[at + 1]); }
                    i = at + 2;
                    continue;
                }
                i = at + 1;
                break;
            }
            fields.push(Some(String::from_utf8_lossy(&value).into_owned()));
            if i >= end { break; }
            if rec[i] != b',' { return Err(format!("junk after quote at {i}")); }
            i += 1;
            if i >= end { fields.push(None); break; }
        } else {
            let e = rec[i..end].iter().position(|b| *b == b',').map_or(end, |c| i + c);
            fields.push(if e == i { None } else { Some(String::from_utf8_lossy(&rec[i..e]).into_owned()) });
            if e >= end { break; }
            i = e + 1;
            if i >= end { fields.push(None); break; }
        }
    }
    Ok(fields)
}

/// Whole records of a frame: a newline outside quotes ends one, a backslash escapes the next byte.
fn records(raw: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    let mut i = 0;
    while i < raw.len() {
        let c = raw[i];
        if quoted {
            if c == b'\\' { i += 1; } else if c == b'"' { quoted = false; }
        } else if c == b'"' {
            quoted = true;
        } else if c == b'\n' {
            out.push(&raw[start..=i]);
            start = i + 1;
        }
        i += 1;
    }
    if start < raw.len() { out.push(&raw[start..]); }
    out
}

/// Text with its tags stripped, entities decoded and every white space deleted (meta-pass.mjs textKey).
fn text_key(s: &str) -> String {
    let p = patterns();
    let stripped = p.tag.replace_all(s, "");
    let decoded = p.key_entity.replace_all(&stripped, |c: &regex::Captures| -> String {
        let whole = c.get(0).map_or("", |w| w.as_str());
        let e = c.get(1).map_or("", |e| e.as_str());
        if e.starts_with('#') { return decode_code_point(e).unwrap_or_else(|| whole.to_owned()); }
        let lower = e.to_lowercase();
        let named: &str = match lower.as_str() {
            "amp" => "&", "lt" => "<", "gt" => ">", "quot" => "\"", "apos" => "'", "nbsp" => " ", _ => whole,
        };
        named.to_owned()
    });
    decoded.chars().filter(|c| !is_js_space(*c)).collect()
}

// ---- frames and the decoder -------------------------------------------------------------------------

#[derive(serde::Deserialize, Clone)]
struct Frame {
    frame: usize,
    shard: usize,
    offset: u64,
    bytes: u64,
    rows: usize,
    #[serde(default)]
    side_offset: u64,
    #[serde(default)]
    side_bytes: u64,
}

fn frames(dir: &Path) -> Result<Vec<Frame>> {
    let text = fs::read_to_string(dir.join("frames.jsonl"))?;
    let mut out = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) { out.push(serde_json::from_str::<Frame>(line)?); }
    Ok(out)
}

fn header(dir: &Path) -> Result<HashMap<String, usize>> {
    let fields = parse_record(&fs::read(dir.join("header.csv"))?)?;
    Ok(fields.into_iter().enumerate().map(|(i, h)| (h.unwrap_or_default(), i)).collect())
}

/// A node child that decompresses frames (zstd-frames.mjs).
struct Decoder { child: Child, input: ChildStdin, output: ChildStdout }
impl Decoder {
    fn start(script: &Path) -> Result<Self> {
        let mut child = Command::new("node").arg(script).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
        let input = child.stdin.take().ok_or("decoder stdin")?;
        let output = child.stdout.take().ok_or("decoder stdout")?;
        Ok(Decoder { child, input, output })
    }
    fn frame(&mut self, dir: &Path, frame: &Frame) -> Result<Vec<u8>> {
        let shard = dir.join("shards").join(format!("shard-{:04}.zst", frame.shard));
        writeln!(self.input, "{}\t{}\t{}", shard.display(), frame.offset, frame.bytes)?;
        self.input.flush()?;
        let mut length = [0u8; 8];
        self.output.read_exact(&mut length)?;
        let mut raw = vec![0u8; u64::from_le_bytes(length) as usize];
        self.output.read_exact(&mut raw)?;
        Ok(raw)
    }
    fn side(&mut self, file: &Path, offset: u64, bytes: u64) -> Result<Vec<u8>> {
        writeln!(self.input, "{}\t{}\t{}", file.display(), offset, bytes)?;
        self.input.flush()?;
        let mut length = [0u8; 8];
        self.output.read_exact(&mut length)?;
        let mut raw = vec![0u8; u64::from_le_bytes(length) as usize];
        self.output.read_exact(&mut raw)?;
        Ok(raw)
    }
}
impl Drop for Decoder {
    fn drop(&mut self) { let _ = self.child.kill(); }
}

/// Every row of a stream (clusters or dockets), in frame order, through `visit`.
fn each_row(dir: &Path, decoder: &mut Decoder, mut visit: impl FnMut(&Row)) -> Result<usize> {
    let col = header(dir)?;
    let mut n = 0;
    for frame in frames(dir)? {
        let raw = decoder.frame(dir, &frame)?;
        for rec in records(&raw) {
            if let Ok(fields) = parse_record(rec) {
                visit(&Row { col: &col, fields });
                n += 1;
            }
        }
    }
    Ok(n)
}

// ---- the join: opinion -> cluster -> docket -> court --------------------------------------------------

#[derive(Default)]
struct Join {
    courts: Vec<String>,
    /// Docket id -> 1 + its court's index; 0 where no docket row has the id.
    docket_court: Vec<u16>,
    sources: Vec<String>,
    /// Cluster id -> (docket id, year filed, 1 + its source's index); a 0 source where no cluster row has the id.
    cluster: Vec<(u32, u16, u16)>,
}
impl Join {
    fn load(stream: &Path, decoder: &mut Decoder) -> Result<(Join, Value)> {
        let mut join = Join::default();
        let mut court_index = HashMap::<String, u16>::new();
        let mut source_index = HashMap::<String, u16>::new();
        let mut receipt = Map::new();
        let dockets = stream.join("dockets");
        if dockets.join("frames.jsonl").exists() {
            let mut courts: Vec<String> = Vec::new();
            let mut docket_court: Vec<u16> = Vec::new();
            let n = each_row(&dockets, decoder, |row| {
                let Some(id) = row.get("id").and_then(|v| v.parse::<usize>().ok()) else { return };
                let court = row.get("court_id").unwrap_or("?").to_owned();
                let index = match court_index.get(&court) {
                    Some(index) => *index,
                    None => {
                        courts.push(court.clone());
                        let index = courts.len() as u16;
                        court_index.insert(court, index);
                        index
                    }
                };
                if docket_court.len() <= id { docket_court.resize(id + 1, 0); }
                docket_court[id] = index;
            })?;
            join.courts = courts;
            join.docket_court = docket_court;
            receipt.insert("docket_rows".into(), json!(n));
        }
        let clusters = stream.join("clusters");
        let mut cluster_cells: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
        if clusters.join("frames.jsonl").exists() {
            let mut sources: Vec<String> = Vec::new();
            let mut cluster: Vec<(u32, u16, u16)> = Vec::new();
            let docket_court = &join.docket_court;
            let courts = &join.courts;
            let n = each_row(&clusters, decoder, |row| {
                let Some(id) = row.get("id").and_then(|v| v.parse::<usize>().ok()) else { return };
                let docket = row.get("docket_id").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
                let year = row.get("date_filed").and_then(|d| d.get(..4)).and_then(|y| y.parse::<u16>().ok()).unwrap_or(0);
                let source = row.get("source").unwrap_or("?").to_owned();
                let index = match source_index.get(&source) {
                    Some(index) => *index,
                    None => {
                        sources.push(source.clone());
                        let index = sources.len() as u16;
                        source_index.insert(source.clone(), index);
                        index
                    }
                };
                if cluster.len() <= id { cluster.resize(id + 1, (0, 0, 0)); }
                cluster[id] = (docket, year, index);
                let court = match docket_court.get(docket as usize).copied().unwrap_or(0) {
                    0 => "!no-docket",
                    c => courts[c as usize - 1].as_str(),
                };
                let cell = cluster_cells.entry(format!("{court}|{}|{source}", year / 10 * 10)).or_default();
                *cell.entry("clusters".to_owned()).or_default() += 1;
                for field in CLUSTER_FIELDS {
                    if row.get(field).is_some_and(|v| !v.is_empty()) { *cell.entry(field.to_owned()).or_default() += 1; }
                }
            })?;
            join.sources = sources;
            join.cluster = cluster;
            receipt.insert("cluster_rows".into(), json!(n));
        }
        receipt.insert("clusters_by_court_decade_source".into(), serde_json::to_value(&cluster_cells)?);
        Ok((join, Value::Object(receipt)))
    }
    /// The opinion's court, decade and cluster source; misses as !no-cluster or !no-docket.
    fn cell(&self, cluster: Option<u64>) -> (String, String, String) {
        let found = cluster.and_then(|c| self.cluster.get(c as usize)).copied().filter(|entry| entry.2 > 0);
        let Some((docket, year, source)) = found else {
            return ("!no-cluster".into(), "?".into(), "?".into());
        };
        let court = match self.docket_court.get(docket as usize).copied().unwrap_or(0) {
            0 => "!no-docket".to_owned(),
            c => self.courts[c as usize - 1].clone(),
        };
        (court, (year / 10 * 10).to_string(), self.sources[source as usize - 1].clone())
    }
}

// ---- what the engine reads ------------------------------------------------------------------------------

fn derive(row: &Row, field: &str) -> std::result::Result<DocumentStructure, String> {
    let value = row.get(field).unwrap_or("").to_owned();
    let plain = field == "plain_text";
    let input: NativeMarkupInput = serde_json::from_value(json!({
        "provider": "courtlistener",
        "id": row.get("id").unwrap_or(""),
        "url": null,
        "text": if plain { value.clone() } else { String::new() },
        "markup": if plain { None } else { Some(value) },
        "pageCitations": [],
        "scope": {"kind": "complete", "markupSerialization": if field.starts_with("xml") { "xml_source" } else { "html_source" }},
    })).map_err(|e| e.to_string())?;
    analyze_native_markup(input).map_err(|e| e.to_string())
}

/// What a consumer reads, from the projected nodes documentAnchors lists and the outline.
fn reading(doc: &DocumentStructure, outline: bool) -> Value {
    let text = doc.query_text();
    let mut pages = 0u64;
    let mut first_page = usize::MAX;
    let mut notes = 0u64;
    let mut numbered = 0u64;
    let mut roles = 0u64;
    for node in &doc.nodes {
        if !matches!(node.kind, NodeKind::Paragraph | NodeKind::Prose | NodeKind::Page | NodeKind::Section
            | NodeKind::Footnote | NodeKind::Table | NodeKind::Row | NodeKind::Cell) { continue; }
        if node.kind == NodeKind::Page { pages += 1; first_page = first_page.min(doc.query_range(node).start); }
        if node.kind == NodeKind::Footnote { notes += 1; }
        if matches!(node.kind, NodeKind::Paragraph | NodeKind::Prose) && node.label.is_some()
            && node.marker_range.is_some_and(|r| r.start < r.end) { numbered += 1; }
        if node.role.is_some_and(|r| !matches!(r, PrimaryRole::Text | PrimaryRole::Heading)) { roles += 1; }
    }
    // The opening page: non-space text before the first page, in UTF-16 units.
    let mut opening = 0usize;
    if pages > 0 && first_page > 0 && first_page != usize::MAX {
        let mut unit = 0usize;
        for c in text.chars() {
            if unit >= first_page { break; }
            if !is_js_space(c) { opening += c.len_utf16(); }
            unit += c.len_utf16();
        }
    }
    let mut g = json!({"pages": pages, "notes": notes, "numbered": numbered, "roles": roles, "opening": opening});
    let (elements, markers, prose_lines) = residue(doc);
    g["elements"] = elements;
    g["markers"] = markers;
    g["prose_lines"] = prose_lines;
    if outline {
        let headings = serde_json::to_value(document_outline(doc, false, None)).ok()
            .and_then(|v| v.as_array().map(|a| a.iter().filter(|e| e["kind"] == "heading").count())).unwrap_or(0);
        g["headings"] = json!(headings);
    }
    g
}

/// UTF-16 offset of every byte boundary of a text (the engine's ranges are UTF-16).
fn utf16_offsets(text: &str) -> Vec<u32> {
    let mut out = vec![0u32; text.len() + 1];
    let mut unit = 0u32;
    for (byte, c) in text.char_indices() {
        for k in 0..c.len_utf8() { out[byte + k] = unit; }
        unit += c.len_utf16() as u32;
    }
    out[text.len()] = unit;
    out
}

/// Whether [start, end) lies inside one of the sorted, merged ranges.
fn inside(ranges: &[(usize, usize)], start: usize, end: usize) -> bool {
    let at = ranges.partition_point(|r| r.0 <= start);
    at > 0 && ranges[at - 1].1 >= end
}

fn merged(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.sort();
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (s, e) in ranges {
        if e <= s { continue; }
        match out.last_mut() { Some(last) if s <= last.1 => last.1 = last.1.max(e), _ => out.push((s, e)) }
    }
    out
}

/// What the engine left of the source: each markup element as claimed (a node is it), covered (inside
/// prose), empty or none, by tag and tag.class; each text marker as taken (a node's printed marker is it),
/// boundary (a node starts or ends at it), covered or none; and the shapes of lines that stay inside prose.
fn residue(doc: &DocumentStructure) -> (Value, Value, Value) {
    let text = doc.query_text();
    let claimed: std::collections::HashSet<usize> = doc.nodes.iter().filter_map(|n| n.markup_start).collect();
    let mut prose = Vec::new();
    let mut edges = Vec::new();
    let mut printed = Vec::new();
    for node in &doc.nodes {
        let r = doc.query_range(node);
        edges.push(r.start);
        edges.push(r.end);
        if matches!(node.kind, NodeKind::Prose | NodeKind::Paragraph) { prose.push((r.start, r.end)); }
        if let Some(m) = node.marker_range { printed.push((m.start, m.end)); }
    }
    let prose = merged(prose);
    let printed = merged(printed);
    let units = utf16_offsets(text);
    // Text the engine's blocks own, bridged over white space between them: a container whose children
    // are blocks is contained, not left over.
    let mut byte_of = vec![0usize; *units.last().unwrap_or(&0) as usize + 1];
    for (byte, unit) in units.iter().enumerate().rev() { byte_of[*unit as usize] = byte; }
    let mut owned = merged(doc.nodes.iter().filter(|n| !matches!(n.kind, NodeKind::Page | NodeKind::Section))
        .map(|n| { let r = doc.query_range(n); (r.start, r.end) }).collect());
    let mut bridged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in owned.drain(..) {
        if let Some(last) = bridged.last_mut() {
            let gap = text.get(byte_of[last.1.min(byte_of.len() - 1)]..byte_of[s.min(byte_of.len() - 1)]).unwrap_or("x");
            if gap.chars().all(is_js_space) { last.1 = last.1.max(e); continue; }
        }
        bridged.push((s, e));
    }
    edges.sort_unstable();
    let near_edge = |start: usize, end: usize| {
        let at = edges.partition_point(|e| *e + 2 < start);
        edges.get(at).is_some_and(|e| *e <= end + 2)
    };
    let mut elements: BTreeMap<String, [u64; 4]> = BTreeMap::new();
    for element in &doc.markup_elements {
        let (s, e) = (element.range.start, element.range.end);
        // Trimmed of the white space at its edges.
        let raw = text.get(byte_of[s.min(byte_of.len() - 1)]..byte_of[e.min(byte_of.len() - 1)]).unwrap_or("");
        let lead = utf16(&raw[..raw.len() - raw.trim_start_matches(is_js_space).len()]);
        let trail = utf16(&raw[raw.trim_end_matches(is_js_space).len()..]);
        let (ts, te) = (s + lead, e.saturating_sub(trail).max(s + lead));
        let status = if claimed.contains(&element.markup_start) { 0 } else if ts >= te { 2 }
            else if inside(&prose, ts, te) { 1 } else if inside(&bridged, ts, te) { 0 } else { 3 };
        elements.entry(element.tag.clone()).or_default()[status] += 1;
        for class in element.attributes.get("class").map_or("", String::as_str).split_ascii_whitespace() {
            elements.entry(format!("{}.{class}", element.tag)).or_default()[status] += 1;
        }
    }
    let p = patterns();
    let mut markers: BTreeMap<String, [u64; 4]> = BTreeMap::new();
    let status_of = |s: usize, e: usize| -> usize {
        let at = printed.partition_point(|r| r.1 <= s);
        if printed.get(at).is_some_and(|r| r.0 < e) { 0 } else if near_edge(s, e) { 1 } else if inside(&prose, s, e) { 2 } else { 3 }
    };
    for family in &p.families {
        if matches!(family.name, "section_sign" | "continued") { continue; }
        for start in family.starts(text) {
            let end = family.re.find_at(text, start).map_or(start, |m| m.end());
            markers.entry(family.name.to_owned()).or_default()[status_of(units[start] as usize, units[end] as usize)] += 1;
        }
    }
    // Whole lines: line families and line shapes, where the line stays inside prose.
    let mut shapes = Counts::default();
    let mut seen = Counts::default();
    let mut byte = 0usize;
    for raw in text.split('\n') {
        let line_start = byte;
        byte += raw.len() + 1;
        let trimmed = js_trim(raw);
        if trimmed.is_empty() { continue; }
        let lead = raw.len() - raw.trim_start_matches(is_js_space).len();
        let (s, e) = (units[line_start + lead] as usize, units[line_start + lead + trimmed.len()] as usize);
        let status = status_of(s, e);
        for index in p.line_set.matches(trimmed).iter() {
            markers.entry(p.line_names[index].to_owned()).or_default()[status] += 1;
        }
        if status != 2 { continue; }
        let first = trimmed.split(is_js_space).next().unwrap_or("");
        if utf16(first) <= 8 && first.chars().any(|c| !c.is_ascii_alphabetic()) { shapes.inc(&format!("start:{}", shape(first)), 1); }
        if utf16(trimmed) <= 30 { shapes.inc(&format!("short:{}", shape(trimmed)), 1); }
        if utf16(trimmed) <= 120 {
            let norm: String = trimmed.chars().map(|c| if c.is_ascii_digit() { '9' } else { c }).collect();
            seen.inc(&norm, 1);
        }
    }
    for (k, v) in seen.keys.iter().zip(seen.values.iter()) {
        if *v >= 3 { shapes.inc(&format!("repeated:{}", js_prefix(k, 80)), 1); }
    }
    let as_value = |m: BTreeMap<String, [u64; 4]>| Value::Object(m.into_iter().map(|(k, v)| (k, json!(v))).collect());
    (as_value(elements), as_value(markers), shapes.value())
}

/// Markers a rendition supplies, from its census: the ones html_with_citations may not carry.
fn markers(census: &Value) -> Vec<&'static str> {
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    let (mk, tok) = (&census["mk"], &census["tok"]);
    let mut out = Vec::new();
    for (key, name) in [("bracket_star", "bracket_star"), ("ct_page", "ct_page"), ("mojibake_pilcrow", "mojibake_pilcrow"),
        ("star_n", "star_n"), ("bracket_pilcrow", "bracket_pilcrow"), ("brace_pilcrow", "brace_pilcrow")] {
        if n(mk, key) > 0 { out.push(name); }
    }
    if n(tok, "div.num") > 0 { out.push("div.num"); }
    if n(tok, "<bracketnum") > 0 { out.push("<bracketnum"); }
    if n(tok, "<footnote") + n(tok, "<footnote_body") > 0 { out.push("notes"); }
    out
}

fn engine(row: &Row, census: &Value) -> Value {
    let renditions = &census["R"];
    let present = |name: &str| renditions.get(name).and_then(|r| r["b"].as_u64()).unwrap_or(0) > 0;
    let primary = ["html_with_citations", "xml_harvard", "html_columbia", "html_lawbox", "html_anon_2020", "html", "plain_text"]
        .into_iter().find(|name| present(name));
    let mut out = Map::new();
    let mut read = |field: &str| {
        let r = &renditions[field];
        let outline = r["mk"].get("line_roman_label").is_some() || r["mk"].get("line_letter_label").is_some();
        let started = Instant::now();
        let mut value = match derive(row, field) {
            Ok(doc) => reading(&doc, outline),
            Err(e) => json!({"error": e.chars().take(200).collect::<String>()}),
        };
        value["ms"] = json!((started.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0);
        out.insert(field.to_owned(), value);
    };
    let Some(primary) = primary else { return Value::Object(Map::new()) };
    read(primary);
    let carried = markers(&renditions[primary]);
    for name in RENDITIONS {
        if name == primary || !present(name) { continue; }
        if markers(&renditions[name]).iter().any(|m| !carried.contains(m)) { read(name); }
    }
    Value::Object(out)
}

// ---- aggregation ------------------------------------------------------------------------------------------

/// Counters, nested by name, with up to five example ids where a key asks for them.
#[derive(Default)]
struct Aggregate { counts: BTreeMap<String, BTreeMap<String, u64>>, examples: BTreeMap<String, Vec<u64>> }
impl Aggregate {
    fn inc(&mut self, table: &str, key: &str, n: u64) {
        *self.counts.entry(table.to_owned()).or_default().entry(key.to_owned()).or_default() += n;
    }
    fn example(&mut self, key: &str, id: u64) {
        let list = self.examples.entry(key.to_owned()).or_default();
        if list.len() < 5 && !list.contains(&id) { list.push(id); }
    }
    fn value(&self) -> Value { json!({"counts": self.counts, "examples": self.examples}) }
    fn merge(&mut self, other: &Value) {
        if let Some(tables) = other["counts"].as_object() {
            for (table, keys) in tables {
                let target = self.counts.entry(table.clone()).or_default();
                for (key, n) in keys.as_object().into_iter().flatten() { *target.entry(key.clone()).or_default() += n.as_u64().unwrap_or(0); }
            }
        }
        if let Some(examples) = other["examples"].as_object() {
            for (key, ids) in examples {
                for id in ids.as_array().into_iter().flatten().filter_map(Value::as_u64) { self.example(key, id); }
            }
        }
    }
}

/// One opinion into its frame's aggregate: the metadata cell, the html_with_citations source check, the
/// census vocabulary by rendition, court and decade, and what the engine read against what the source supplies.
fn aggregate(agg: &mut Aggregate, row: &Row, census: &Value, engine: Option<&Value>, (court, decade, source): &(String, String, String)) {
    let id = census["id"].as_u64().unwrap_or(0);
    let cell = format!("{court}|{decade}|{source}");
    agg.inc("cells", &format!("{cell}|rows"), 1);
    if court.starts_with('!') { agg.inc("totals", court, 1); agg.example(court, id); }
    let mut have = Vec::new();
    for name in RENDITIONS {
        let state = match row.get(name) { None => "null", Some("") => "empty", Some(_) => { have.push(name); "text" } };
        agg.inc("cells", &format!("{cell}|{name}:{state}"), 1);
    }
    agg.inc("cells", &format!("{cell}|combo:{}", if have.is_empty() { "none".to_owned() } else { have.join("+") }), 1);
    let p = patterns();
    if let Some(dl) = row.get("download_url").filter(|d| !d.is_empty()) {
        agg.inc("cells", &format!("{cell}|download_url"), 1);
        let ext = p.ext.captures(dl).and_then(|m| m.get(1)).map_or("-".to_owned(), |m| m.as_str().to_lowercase());
        agg.inc("cells", &format!("{cell}|dl_ext:{ext}"), 1);
    }
    if let Some(lp) = row.get("local_path").filter(|l| !l.is_empty()) {
        let kind = if lp.starts_with("/home/") { "importer-path" } else { lp.split('/').next().unwrap_or("") };
        let ext: String = lp.rsplit('.').next().unwrap_or("").to_lowercase().chars().take(5).collect();
        agg.inc("cells", &format!("{cell}|local_path"), 1);
        agg.inc("cells", &format!("{cell}|lp:{kind}:{ext}"), 1);
    }
    agg.inc("cells", &format!("{cell}|ocr:{}", row.get("extracted_by_ocr").unwrap_or("null")), 1);
    // html_with_citations against CourtListener's source order.
    let keyed: Vec<(&str, String)> = have.iter().map(|name| (*name, text_key(row.get(name).unwrap_or("")))).collect();
    let key_of = |name: &str| keyed.iter().find(|(n, _)| *n == name).map(|(_, k)| k);
    if let Some(hk) = key_of("html_with_citations") {
        let rule = HWC_ORDER.into_iter().find(|name| have.contains(name));
        let verdict = match rule {
            None => "no-source".to_owned(),
            Some(r) if key_of(r) == Some(hk) => "equals-rule-source".to_owned(),
            Some(r) => HWC_ORDER.into_iter().find(|o| *o != r && have.contains(o) && key_of(o) == Some(hk))
                .map_or("equals-none".to_owned(), |o| format!("equals-other:{o}")),
        };
        agg.inc("hwc", &format!("{}|{verdict}", rule.unwrap_or("-")), 1);
        if verdict != "equals-rule-source" { agg.example(&format!("hwc:{}|{verdict}", rule.unwrap_or("-")), id); }
    }
    // Pairwise text relations among the independent renditions.
    let independent: Vec<&(&str, String)> = keyed.iter().filter(|(n, _)| *n != "html_with_citations").collect();
    for i in 0..independent.len() {
        for j in i + 1..independent.len() {
            let (a, ka) = independent[i];
            let (b, kb) = independent[j];
            let relation = if ka == kb { "equal" } else if ka.contains(kb.as_str()) { "first-contains-second" }
                else if kb.contains(ka.as_str()) { "second-contains-first" } else { "differ" };
            agg.inc("pairs", &format!("{a}~{b}|{relation}"), 1);
            agg.example(&format!("pair:{a}~{b}|{relation}"), id);
        }
    }
    // Census vocabulary: markup tokens and marker families, as opinions carrying each, by rendition x court x decade.
    if let Some(renditions) = census["R"].as_object() {
        for (name, r) in renditions {
            let scope = format!("{name}|{court}|{decade}");
            agg.inc("rendition_rows", &scope, 1);
            for (part, table) in [("tok", "tokens"), ("mk", "markers"), ("ls", "line_starts"), ("short", "short_lines")] {
                if let Some(items) = r[part].as_object() {
                    for (item, n) in items {
                        if item == "…more" { continue; }
                        agg.inc(table, &format!("{scope}|{item}"), 1);
                        agg.inc(&format!("{table}_occurrences"), &format!("{scope}|{item}"), n.as_u64().unwrap_or(0));
                        if part == "tok" { agg.example(&format!("{name}|{item}"), id); }
                    }
                }
            }
        }
    }
    // What the engine read, against the source's own markers, by rendition x court x decade.
    if let Some(engine) = engine.and_then(Value::as_object) {
        for (name, g) in engine {
            let scope = format!("{name}|{court}|{decade}");
            agg.inc("engine", &format!("{scope}|read"), 1);
            if g.get("error").is_some() { agg.inc("engine", &format!("{scope}|error"), 1); agg.example(&format!("error:{name}"), id); continue; }
            let r = &census["R"][name.as_str()];
            let supplied = |k: &str| r["mk"].get(k).and_then(Value::as_u64).unwrap_or(0) + r["tok"].get(k).and_then(Value::as_u64).unwrap_or(0);
            let n = |k: &str| g.get(k).and_then(Value::as_u64).unwrap_or(0);
            for k in ["pages", "notes", "numbered", "roles", "headings"] { if n(k) > 0 { agg.inc("engine", &format!("{scope}|{k}"), 1); } }
            if n("pages") > 0 && n("opening") > 0 { agg.inc("engine", &format!("{scope}|opening_unpaged"), 1); agg.example(&format!("opening_unpaged:{name}"), id); }
            let page_markers = supplied("star_n") + supplied("bracket_star") + supplied("ct_page") + supplied("<page-number") + supplied("span.star-pagination");
            let numbering = supplied("bracket_pilcrow") + supplied("brace_pilcrow") + supplied("mojibake_pilcrow") + supplied("div.num") + supplied("lead_pilcrow");
            let notes = supplied("<footnote") + supplied("<footnote_body") + supplied("bracket_fn");
            for (witness, have_it, read_it) in [("pages", page_markers > 0, n("pages") > 0), ("numbering", numbering >= 5, n("numbered") > 0), ("notes", notes > 0, n("notes") > 0)] {
                if !have_it { continue; }
                agg.inc("supplied", &format!("{scope}|{witness}"), 1);
                if read_it { agg.inc("supplied", &format!("{scope}|{witness}:taken"), 1); }
                else { agg.example(&format!("untaken:{witness}:{name}"), id); }
            }
            if let Some(ms) = g.get("ms").and_then(Value::as_f64) { agg.inc("engine_ms", name, ms.round() as u64); }
            // The residue: elements and markers by what the engine made of them, and line shapes left in prose.
            for (table, statuses) in [("elements", ["claimed", "covered", "empty", "none"]), ("markers", ["taken", "boundary", "covered", "none"])] {
                for (key, counts) in g.get(table).and_then(Value::as_object).into_iter().flatten() {
                    for (i, status) in statuses.iter().enumerate() {
                        let n = counts.get(i).and_then(Value::as_u64).unwrap_or(0);
                        if n == 0 { continue; }
                        let cell = format!("{name}|{key}|{status}");
                        agg.inc(table, &cell, n);
                        agg.inc(&format!("{table}_opinions"), &cell, 1);
                        if i > 0 { agg.example(&format!("{table}:{cell}"), id); }
                    }
                }
            }
            for (shape, _) in g.get("prose_lines").and_then(Value::as_object).into_iter().flatten() {
                let cell = format!("{name}|{shape}");
                agg.inc("prose_lines", &cell, 1);
                agg.example(&format!("prose:{cell}"), id);
            }
        }
    }
}

// ---- commands -----------------------------------------------------------------------------------------------

fn frame_file(out: &Path, part: &str, frame: usize, extension: &str) -> PathBuf {
    out.join(part).join(format!("{frame:06}.{extension}"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let partial = path.with_extension("partial");
    fs::write(&partial, bytes)?;
    fs::rename(&partial, path)?;
    Ok(())
}

struct Options { stream: PathBuf, out: PathBuf, decoder: PathBuf, threads: usize, range: Option<(usize, usize)>, engine: bool, rows: bool }

fn run(o: &Options) -> Result<()> {
    fs::create_dir_all(o.out.join("frames"))?;
    if o.rows { fs::create_dir_all(o.out.join("rows"))?; }
    let started = Instant::now();
    let (join, receipt) = Join::load(&o.stream, &mut Decoder::start(&o.decoder)?)?;
    write_atomic(&o.out.join("join.json"), serde_json::to_string(&receipt)?.as_bytes())?;
    eprintln!("join: {} courts, {} cluster ids, {:.0} s", join.courts.len(), join.cluster.len(), started.elapsed().as_secs_f64());
    let dir = o.stream.join("opinions");
    let col = header(&dir)?;
    let todo: Vec<Frame> = frames(&dir)?.into_iter()
        .filter(|f| o.range.is_none_or(|(a, b)| f.frame >= a && f.frame <= b))
        .filter(|f| !frame_file(&o.out, "frames", f.frame, "json").exists())
        .collect();
    eprintln!("{} opinion frames to read", todo.len());
    let next = AtomicUsize::new(0);
    let rows_done = AtomicUsize::new(0);
    let frames_done = AtomicUsize::new(0);
    let failure: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    std::thread::scope(|scope| {
        for _ in 0..o.threads.max(1) {
            scope.spawn(|| {
                let work = || -> Result<()> {
                    let mut decoder = Decoder::start(&o.decoder)?;
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(frame) = todo.get(index) else { return Ok(()) };
                        let raw = decoder.frame(&dir, frame)?;
                        let recs = records(&raw);
                        let mut agg = Aggregate::default();
                        agg.inc("totals", "rows", recs.len() as u64);
                        if recs.len() != frame.rows { agg.inc("totals", "frame_row_mismatch", 1); }
                        let mut lines = String::new();
                        for rec in recs {
                            let census = match parse_record(rec) {
                                Ok(fields) if fields.len() == col.len() => {
                                    let row = Row { col: &col, fields };
                                    let mut census = opinion_census(&row);
                                    let engine = if o.engine { Some(engine(&row, &census)) } else { None };
                                    let cluster = row.get("cluster_id").and_then(|c| c.parse::<u64>().ok());
                                    aggregate(&mut agg, &row, &census, engine.as_ref(), &join.cell(cluster));
                                    if let Some(engine) = engine { census["e"] = engine; }
                                    census
                                }
                                Ok(fields) => {
                                    agg.inc("totals", "field_count_mismatch", 1);
                                    json!({"id": js_number(fields.first().and_then(|v| v.as_deref())), "err": format!("field count {} != {}", fields.len(), col.len())})
                                }
                                Err(error) => { agg.inc("totals", "parse_error", 1); json!({"err": error}) }
                            };
                            if o.rows { lines.push_str(&census.to_string()); lines.push('\n'); }
                        }
                        if o.rows { write_atomic(&frame_file(&o.out, "rows", frame.frame, "jsonl"), lines.as_bytes())?; }
                        write_atomic(&frame_file(&o.out, "frames", frame.frame, "json"), agg.value().to_string().as_bytes())?;
                        let rows = rows_done.fetch_add(frame.rows, Ordering::Relaxed) + frame.rows;
                        let done = frames_done.fetch_add(1, Ordering::Relaxed) + 1;
                        if done % 25 == 0 || done == todo.len() {
                            let seconds = started.elapsed().as_secs_f64();
                            eprintln!("{done}/{} frames, {rows} rows, {seconds:.0} s, {:.0} rows/s", todo.len(), rows as f64 / seconds);
                        }
                    }
                };
                if let Err(error) = work() {
                    if let Ok(mut slot) = failure.lock() { slot.get_or_insert(error.to_string()); }
                    next.store(usize::MAX / 2, Ordering::Relaxed);
                }
            });
        }
    });
    if let Some(error) = failure.into_inner().ok().flatten() { return Err(error.into()); }
    Ok(())
}

fn merge(out: &Path) -> Result<()> {
    let mut total = Aggregate::default();
    let mut frames_read = 0;
    for entry in fs::read_dir(out.join("frames"))? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "json") {
            total.merge(&serde_json::from_slice::<Value>(&fs::read(&path)?)?);
            frames_read += 1;
        }
    }
    let mut value = total.value();
    value["frames"] = json!(frames_read);
    if let Ok(join) = fs::read(out.join("join.json")) { value["join"] = serde_json::from_slice(&join)?; }
    write_atomic(&out.join("aggregate.json"), serde_json::to_string(&value)?.as_bytes())?;
    println!("{frames_read} frames merged into {}", out.join("aggregate.json").display());
    Ok(())
}

/// The --rows census against the JS sidecars, value for value (key order aside).
fn diff(o: &Options, sidecars: &Path) -> Result<()> {
    let mut decoder = Decoder::start(&o.decoder)?;
    let side_frames = frames(sidecars)?;
    let (mut rows, mut equal, mut shown) = (0usize, 0usize, 0usize);
    let mut fields = HashMap::<String, usize>::new();
    for frame in side_frames.iter().filter(|f| f.side_bytes > 0 && o.range.is_none_or(|(a, b)| f.frame >= a && f.frame <= b)) {
        let path = frame_file(&o.out, "rows", frame.frame, "jsonl");
        if !path.exists() { continue; }
        let mine = fs::read_to_string(&path)?;
        let theirs = String::from_utf8(decoder.side(&sidecars.join("sidecar.zst"), frame.side_offset, frame.side_bytes)?)?;
        for (a, b) in mine.lines().zip(theirs.lines()) {
            rows += 1;
            let mut a: Value = serde_json::from_str(a)?;
            let b: Value = serde_json::from_str(b)?;
            if let Some(object) = a.as_object_mut() { object.remove("e"); }
            if a == b { equal += 1; continue; }
            let mut paths = Vec::new();
            differences(&a, &b, String::new(), &mut paths);
            for p in &paths { *fields.entry(p.split(':').next().unwrap_or("").split('.').take(4).collect::<Vec<_>>().join(".")).or_default() += 1; }
            if shown < 15 { shown += 1; eprintln!("id {}: {}", b["id"], paths.iter().take(5).cloned().collect::<Vec<_>>().join(" | ")); }
        }
    }
    let mut fields: Vec<(String, usize)> = fields.into_iter().collect();
    fields.sort_by(|a, b| b.1.cmp(&a.1));
    println!("rows {rows}, identical {equal}, differing {}", rows - equal);
    for (field, n) in fields.iter().take(40) { println!("  {n} {field}"); }
    Ok(())
}

fn differences(a: &Value, b: &Value, at: String, out: &mut Vec<String>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let keys: Vec<&String> = x.keys().chain(y.keys().filter(|k| !x.contains_key(k.as_str()))).collect();
            for k in keys {
                let va = x.get(k.as_str()).unwrap_or(&Value::Null);
                let vb = y.get(k.as_str()).unwrap_or(&Value::Null);
                if va != vb { differences(va, vb, if at.is_empty() { k.clone() } else { format!("{at}.{k}") }, out); }
            }
        }
        _ => {
            let (sa, sb) = (a.to_string(), b.to_string());
            out.push(format!("{at}: {} vs {}", sa.chars().take(60).collect::<String>(), sb.chars().take(60).collect::<String>()));
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let range = arg("--frames").map(|r| {
        let (a, b) = r.split_once('-').unwrap_or((r.as_str(), r.as_str()));
        (a.parse::<usize>().unwrap_or(0), b.parse::<usize>().unwrap_or(usize::MAX))
    });
    let options = Options {
        stream: PathBuf::from(arg("--stream").unwrap_or_else(|| "E:/MikeOSS-archive/courtlistener-census/stream".to_owned())),
        out: PathBuf::from(arg("--out").ok_or("--out DIR")?),
        decoder: PathBuf::from(arg("--decoder").unwrap_or_else(|| "experiments/courtlistener-census/zstd-frames.mjs".to_owned())),
        threads: arg("--threads").and_then(|t| t.parse().ok()).unwrap_or(3),
        range,
        engine: !args.iter().any(|a| a == "--no-engine"),
        rows: args.iter().any(|a| a == "--rows"),
    };
    match args.first().map(String::as_str) {
        Some("run") => run(&options)?,
        Some("merge") => merge(&options.out)?,
        Some("diff") => diff(&options, &PathBuf::from(arg("--sidecars").ok_or("--sidecars DIR")?))?,
        _ => return Err("usage: opinion_census run|merge|diff --out DIR [--stream DIR] [--threads N] [--frames A-B] [--no-engine] [--rows] [--sidecars DIR]".into()),
    }
    std::io::stdout().flush()?;
    Ok(())
}
