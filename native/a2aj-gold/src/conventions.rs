//! The gold store's conventions (experiments/legal-structure-gold/postcorrect.py), as they bear on a judgment, which is all
//! this gold ever is. Its rules for instruments (section captions, numbered captions, provisions) cannot fire on a document
//! typed judgment, so they are not here. Each correction is kept in the gold under `postcorrections`.
use super::book::{span_of, Book};
use super::words::is_space;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::LazyLock;

const EDGE: usize = 2; // a line among the first or last three of its page by height is at the edge

static CONCURRENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*(Concurred in|Concurring|I concur|Je souscris|Souscrivent)\s*:\s*$").unwrap());
static BRACKET_ALONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\[\d{1,4}\])\s*$").unwrap());
static NOTE_LABEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\s*)(\d{1,3}|[*\x{2020}\x{2021}\x{a7}\x{b6}]{1,3})").unwrap());
static NOT_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\w ]").unwrap());
static MARGIN_FORM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[?\d{1,4}\]?$").unwrap());

/// A page as the corrections read it: its lines, and its height where known.
pub struct Page<'a> {
    pub lines: Vec<&'a super::book::PageLine>,
    pub height: Option<f64>,
}

type Edge = HashMap<String, (usize, f64, f64)>;

/// Each line's distance from its page's nearer edge (in lines ordered by height), its middle's height on the page (as a
/// share of the page) and its own height.
pub fn edges(pages: &[Page]) -> Edge {
    let mut out = HashMap::new();
    for page in pages {
        let mut ordered = page.lines.clone();
        ordered.sort_by(|a, b| a.bbox[1].total_cmp(&b.bbox[1]));
        let tall = page.height.filter(|&h| h != 0.0).or(ordered.iter().map(|line| line.bbox[3]).reduce(f64::max)).filter(|&h| h != 0.0).unwrap_or(1.0);
        let count = ordered.len();
        for (rank, line) in ordered.iter().enumerate() {
            let [_, y0, _, y1] = line.bbox;
            out.insert(line.id.clone(), (rank.min(count - 1 - rank), (y0 + y1) / 2.0 / tall, (y1 - y0) / tall));
        }
    }
    out
}

fn is_number(word: &str) -> bool {
    super::words::is_digits(word)
}

fn key_words(text: &str) -> String {
    let lowered = NOT_WORD.replace_all(&text.to_lowercase(), " ").into_owned();
    let mut found: Vec<&str> = lowered.split(is_space).filter(|word| !word.is_empty()).collect();
    while found.first().is_some_and(|word| is_number(word)) {
        found.remove(0);
    }
    while found.last().is_some_and(|word| is_number(word)) {
        found.pop();
    }
    found.join(" ")
}

fn median(values: &[f64]) -> f64 {
    let mut values = values.to_vec();
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

/// A running head: a one-line heading unit at the edge of its page, whose words already stand at the edge of other pages as
/// furniture, where they stand and as tall.
fn running_heads(book: &mut Book, edge: &Edge) -> Vec<Value> {
    let near = |book: &Book, k: usize| edge.get(&book.lines[k].id).copied().unwrap_or((EDGE + 1, 0.0, 0.0));
    let mut region_of: HashMap<usize, String> = HashMap::new();
    let of_typed: Vec<Vec<usize>> = (0..book.typed.len()).map(|t| book.spans(t).iter().filter_map(|s| s["line_id"].as_str().and_then(|id| book.by_id.get(id).copied())).collect()).collect();
    for (t, ks) in of_typed.iter().enumerate() {
        for &k in ks {
            region_of.insert(k, book.region(t).to_owned());
        }
    }
    let mut furniture: HashMap<String, Vec<(i64, f64, f64)>> = HashMap::new();
    for k in 0..book.lines.len() {
        let key = key_words(&book.lines[k].spelled());
        let (rank, middle, tall) = near(book, k);
        if key.chars().count() >= 3 && rank <= EDGE && region_of.get(&k).map(String::as_str) == Some("furniture") {
            furniture.entry(key).or_default().push((book.lines[k].page, middle, tall));
        }
    }
    let mut corrections = Vec::new();
    for u in 0..book.units.len() {
        if book.regions(u) != BTreeSet::from(["heading".to_owned()]) {
            continue;
        }
        let ks: BTreeSet<usize> = book.members(u).iter().flat_map(|&t| of_typed[t].iter().copied()).collect();
        let Some(&k) = ks.iter().next().filter(|_| ks.len() == 1) else { continue };
        if near(book, k).0 > EDGE {
            continue;
        }
        let key = key_words(&book.lines[k].spelled());
        let page = book.lines[k].page;
        let copies: Vec<(f64, f64)> = furniture.get(&key).map(Vec::as_slice).unwrap_or(&[]).iter().filter(|c| c.0 != page).map(|c| (c.1, c.2)).collect();
        if key.chars().count() < 3 || copies.len() < 2 {
            continue;
        }
        let (_, middle, tall) = near(book, k);
        let (at, size) = (median(&copies.iter().map(|c| c.0).collect::<Vec<_>>()), median(&copies.iter().map(|c| c.1).collect::<Vec<_>>()));
        if (middle - at).abs() > 0.015 || (tall - size).abs() > 0.15 * size.max(1e-6) {
            continue;
        }
        corrections.push(json!({"rule": "running_head", "unit": u, "page": page, "text": book.lines[k].spelled().chars().take(120).collect::<String>(), "parent": null, "children": []}));
    }
    for correction in &corrections {
        let u = correction["unit"].as_u64().unwrap() as usize;
        for t in book.members(u) {
            book.typed[t]["region"] = json!("furniture");
        }
        book.units[u]["parent"] = Value::Null;
    }
    corrections
}

/// A judgment's bracketed paragraph number printed alone on its line ("[1]") opens the paragraph under it.
fn bracket_number_lines(book: &mut Book) -> Vec<Value> {
    let kinds = book.kinds();
    let mut done = Vec::new();
    let mut u = book.units.len().saturating_sub(1);
    while u > 0 {
        u -= 1;
        let (unit, after) = (book.members(u), book.members(u + 1));
        if unit.len() != 1 || after.is_empty() || kinds.get(u).and_then(Option::as_deref) != Some("judgment") {
            continue;
        }
        let (entry, opening) = (unit[0], after[0]);
        let said = book.typed[entry]["text"].as_str().unwrap_or("").to_owned();
        let Some(found) = BRACKET_ALONE.captures(&said) else { continue };
        if book.region(entry) != "line_label" || book.spans(entry).is_empty() || book.region(opening) != "text" || !book.markers(opening).is_empty() {
            continue;
        }
        let span = book.spans(entry)[0].clone();
        let Some(line) = book.line(span["line_id"].as_str().unwrap_or("")) else { continue };
        let number: Vec<char> = found[1].chars().collect();
        let Some(start) = line.text.windows(number.len()).position(|window| window == number.as_slice()) else { continue };
        let line_id = line.id.clone();
        book.typed[entry]["region"] = json!("text");
        book.typed[entry]["markers"] = json!([[{"line_id": line_id, "start": start, "end": start + number.len()}]]);
        book.typed[opening]["start"] = json!(false);
        let mut merged = book.units[u + 1].clone();
        for (key, value) in book.units[u].as_object().unwrap().clone() {
            if key != "lines" && value.as_bool() != Some(false) && !value.is_null() && value != json!("") {
                merged[key] = value;
            }
        }
        merged["lines"] = json!([unit, after].concat());
        book.replace_units(u, u + 1, vec![merged]);
        done.push(json!({"rule": "bracket_number_line", "unit": u, "number": &found[1], "text": book.typed[opening]["text"].as_str().unwrap_or("").chars().take(80).collect::<String>()}));
    }
    done
}

/// A judgment's concurrence line after its reasons ("Concurred in:") opens the signature matter: a text unit holding one
/// after its first line is split there.
fn concurrence_lines(book: &mut Book) -> Vec<Value> {
    let kinds = book.kinds();
    let mut done = Vec::new();
    for u in (0..book.units.len()).rev() {
        if kinds.get(u).and_then(Option::as_deref) != Some("judgment") {
            continue;
        }
        let unit = book.members(u);
        let cut = unit.iter().enumerate().find(|&(k, &t)| k > 0 && book.region(t) == "text" && CONCURRENCE.is_match(book.typed[t]["text"].as_str().unwrap_or(""))).map(|(_, &t)| t);
        let Some(t) = cut else { continue };
        book.typed[t]["start"] = json!(true);
        book.split_at(t);
        done.push(json!({"rule": "concurrence_line", "unit": u, "text": book.typed[t]["text"].as_str().unwrap_or("").chars().take(80).collect::<String>()}));
    }
    done
}

/// A law report's paragraph number printed alone in the margin numbers the row beside it, in every column: each text unit
/// opening on the number's row without a marker of its own takes the number.
pub fn margin_numbers(book: &mut Book) -> Vec<Value> {
    let kinds = book.kinds();
    let unit_of: HashMap<usize, usize> = (0..book.units.len()).flat_map(|u| book.members(u).into_iter().map(move |t| (t, u))).collect();
    let mut prose: HashMap<i64, Vec<[f64; 4]>> = HashMap::new();
    for line in &book.lines {
        if line.trimmed().chars().count() >= 20 {
            prose.entry(line.page).or_default().push(line.bbox);
        }
    }
    // The text lines that could take a number, by page: each opens a unit (whether or not the labelling called it a
    // start), and its first line holds words; with its first line's middle.
    let mut openings: HashMap<i64, Vec<(usize, f64)>> = HashMap::new();
    for other in 0..book.typed.len() {
        let opens_unit = unit_of.get(&other).is_some_and(|&u| book.members(u).first() == Some(&other));
        if book.region(other) != "text" || !(book.typed[other]["start"] == true || opens_unit) {
            continue;
        }
        let Some(first) = book.spans(other).first().and_then(|s| s["line_id"].as_str()).and_then(|id| book.line(id)) else { continue };
        if first.trimmed().chars().count() >= 6 {
            openings.entry(first.page).or_default().push((other, (first.bbox[1] + first.bbox[3]) / 2.0));
        }
    }
    let mut done = Vec::new();
    for t in 0..book.typed.len() {
        if book.region(t) != "text" || book.markers(t).is_empty() || kinds.get(unit_of.get(&t).copied().unwrap_or(0)).and_then(Option::as_deref) != Some("judgment") {
            continue;
        }
        let span = span_of(&book.markers(t)[0]).clone();
        let Some(number_line) = span["line_id"].as_str().and_then(|id| book.by_id.get(id).copied()) else { continue };
        let (said, page, bbox) = (book.lines[number_line].trimmed(), book.lines[number_line].page, book.lines[number_line].bbox);
        if !MARGIN_FORM.is_match(&said) {
            continue;
        }
        let Some(boxes) = prose.get(&page).filter(|boxes| !boxes.is_empty()) else { continue };
        let [x0, y0, x1, y1] = bbox;
        if !(x1 < boxes.iter().map(|b| b[0]).fold(f64::MAX, f64::min) - 2.0 || x0 > boxes.iter().map(|b| b[2]).fold(f64::MIN, f64::max) + 2.0) {
            continue;
        }
        let (middle, height) = ((y0 + y1) / 2.0, (y1 - y0).max(1.0));
        for &(other, row) in openings.get(&page).map(Vec::as_slice).unwrap_or(&[]) {
            if other == t || !book.markers(other).is_empty() || (row - middle).abs() > (height * 0.6).max(6.5) {
                continue;
            }
            let text: String = book.typed[other]["text"].as_str().unwrap_or("").chars().take(80).collect();
            book.typed[other]["markers"] = json!([[span.clone()]]);
            book.typed[other]["start"] = json!(true);
            done.push(json!({"rule": "margin_number", "unit": unit_of.get(&other), "number": said, "text": text}));
        }
    }
    done
}

/// A printed paragraph number's style and number ("[12]": bracket, 12).
pub fn numbering(marker: &str) -> Option<(&'static str, u32)> {
    let text = marker.trim_matches(is_space);
    let digits = |inner: &str| (!inner.is_empty() && inner.len() <= 4 && inner.bytes().all(|byte| byte.is_ascii_digit())).then(|| inner.parse::<u32>().ok()).flatten();
    if let Some(inner) = text.strip_prefix('[').and_then(|t| t.strip_suffix(']')) {
        return digits(inner).map(|n| ("bracket", n));
    }
    if let Some(inner) = text.strip_prefix('(').and_then(|t| t.strip_suffix(')')) {
        return digits(inner).map(|n| ("paren", n));
    }
    if let Some(inner) = text.strip_suffix('.') {
        return digits(inner).map(|n| ("dot", n));
    }
    if let Some(inner) = text.strip_suffix(')') {
        return digits(inner).map(|n| ("half", n));
    }
    digits(text).map(|n| ("bare", n))
}

/// Numbering that spans under three tenths of a judgment of four pages or more, or prints fewer numbers than a third of the
/// pages it spans, is no paragraph numbering; its units are lists. (An aligned gold's numbered paragraphs otherwise stay.)
fn no_paragraph_numbering(book: &mut Book) -> Vec<Value> {
    let kinds = book.kinds();
    let count = book.units.len();
    let numbered: Vec<Vec<Option<(&'static str, u32)>>> = book.units.iter().map(|unit| book.printed_markers(unit).iter().map(|m| numbering(m)).collect()).collect();
    let mut starts: Vec<usize> = (0..count).filter(|&u| u == 0 || book.units[u]["starts_document"] == true).collect();
    starts.push(count);
    let page_of: HashMap<&str, i64> = book.lines.iter().map(|line| (line.id.as_str(), line.page)).collect();
    let pages_of = |book: &Book, us: &[usize]| -> Vec<i64> {
        us.iter().flat_map(|&u| book.members(u)).filter_map(|t| book.spans(t).first().and_then(|s| s["line_id"].as_str()).and_then(|id| page_of.get(id).copied())).collect()
    };
    let mut done = Vec::new();
    let mut changes = Vec::new();
    for window in starts.windows(2) {
        let (a, b) = (window[0], window[1]);
        if kinds.get(a).and_then(Option::as_deref) != Some("judgment") {
            continue;
        }
        let only_text = BTreeSet::from(["text".to_owned()]);
        let text: Vec<usize> = (a..b).filter(|&u| book.regions(u) == only_text && numbered[u].first().is_some_and(Option::is_some)).collect();
        let mut printed: Vec<(&str, BTreeSet<u32>)> = Vec::new();
        for &u in &text {
            let (style, number) = numbered[u][0].unwrap();
            match printed.iter_mut().find(|entry| entry.0 == style) {
                Some(entry) => { entry.1.insert(number); }
                None => printed.push((style, BTreeSet::from([number]))),
            }
        }
        let Some(spine) = printed.iter().fold(None::<&(&str, BTreeSet<u32>)>, |best, entry| match best {
            Some(best) if best.1.len() >= entry.1.len() => Some(best),
            _ => Some(entry),
        }) else { continue };
        if spine.1.len() < 3 {
            continue;
        }
        let own: Vec<usize> = text.iter().copied().filter(|&u| numbered[u][0].unwrap().0 == spine.0).collect();
        let spine_pages = pages_of(book, &own);
        let document_pages: BTreeSet<i64> = pages_of(book, &(a..b).collect::<Vec<_>>()).into_iter().collect();
        let spanned = if spine_pages.is_empty() { 0 } else { spine_pages.iter().max().unwrap() - spine_pages.iter().min().unwrap() + 1 };
        if document_pages.len() >= 4 && (spanned * 10 < document_pages.len() as i64 * 3 || (spine.1.len() as i64) * 3 < spanned) {
            changes.push((text.clone(), spine.0.to_owned()));
        }
    }
    for (text, spine) in changes {
        for u in text {
            for t in book.members(u) {
                if book.region(t) == "text" {
                    book.typed[t]["region"] = json!("list_item");
                }
            }
            done.push(json!({"rule": "no_paragraph_numbering", "unit": u, "spine": spine, "to": "list_item", "text": book.unit_text(&book.units[u]).chars().take(80).collect::<String>()}));
        }
    }
    done
}

/// A note's label is the number or symbol its first line opens on.
fn note_labels(book: &mut Book) -> Vec<Value> {
    let mut done = Vec::new();
    for u in 0..book.units.len() {
        let Some(&head) = book.members(u).first() else { continue };
        if book.region(head) != "note" || !book.markers(head).is_empty() || book.spans(head).is_empty() {
            continue;
        }
        let span = book.spans(head)[0].clone();
        let Some(line) = span["line_id"].as_str().and_then(|id| book.line(id)) else { continue };
        let (start, end) = (span["start"].as_u64().unwrap_or(0) as usize, span["end"].as_u64().unwrap_or(0) as usize);
        let text = line.slice(start, end);
        let Some(found) = NOTE_LABEL.captures(&text) else { continue };
        if !text[found.get(0).unwrap().end()..].chars().next().is_some_and(is_space) {
            continue;
        }
        let at = start + found[1].chars().count();
        let line_id = line.id.clone();
        book.typed[head]["markers"] = json!([[{"line_id": line_id, "start": at, "end": at + found[2].chars().count()}]]);
        done.push(json!({"rule": "note_label", "unit": u, "label": &found[2], "text": text.chars().take(80).collect::<String>()}));
    }
    done
}

/// A reference mark is the whole printed mark: where one line holds two references one inside the other, the shorter goes,
/// with any pair that names it.
fn duplicate_references(book: &mut Book) -> Vec<Value> {
    let mut done = Vec::new();
    for t in 0..book.typed.len() {
        let references = book.typed[t]["references"].as_array().cloned().unwrap_or_default();
        let spans: Vec<Option<(String, u64, u64)>> = references.iter().map(|r| r["spans"].get(0).map(|s| (s["line_id"].as_str().unwrap_or("").to_owned(), s["start"].as_u64().unwrap_or(0), s["end"].as_u64().unwrap_or(0)))).collect();
        let mut drop: BTreeSet<usize> = BTreeSet::new();
        for (i, a) in spans.iter().enumerate() {
            for (j, b) in spans.iter().enumerate() {
                if let (true, Some(a), Some(b)) = (i != j, a, b) {
                    if a.0 == b.0 && b.1 <= a.1 && a.2 <= b.2 && a.2 - a.1 < b.2 - b.1 {
                        drop.insert(i);
                    }
                }
            }
        }
        if drop.is_empty() {
            continue;
        }
        let kept: Vec<usize> = (0..references.len()).filter(|i| !drop.contains(i)).collect();
        let moved: BTreeMap<usize, usize> = kept.iter().enumerate().map(|(new, &old)| (old, new)).collect();
        for &i in &drop {
            let span = spans[i].as_ref().unwrap();
            done.push(json!({"rule": "duplicate_reference", "typed": t, "label": references[i]["label"], "span": [span.1, span.2]}));
        }
        book.typed[t]["references"] = Value::Array(kept.iter().map(|&i| references[i].clone()).collect());
        book.notes.retain_mut(|pair| {
            if pair["line"].as_u64() != Some(t as u64) {
                return true;
            }
            match pair["reference"].as_u64().and_then(|r| moved.get(&(r as usize))) {
                Some(&new) => { pair["reference"] = json!(new); true }
                None => false,
            }
        });
    }
    done
}

/// Every convention over one gold, in the order the store applies them.
pub fn apply(book: &mut Book, heights: &HashMap<i64, f64>) -> Vec<Value> {
    let pages: Vec<i64> = book.lines.iter().map(|line| line.page).collect::<BTreeSet<_>>().into_iter().collect();
    let edge = {
        let view: Vec<Page> = pages.iter().map(|&page| Page { lines: book.lines.iter().filter(|line| line.page == page).collect(), height: heights.get(&page).copied() }).collect();
        edges(&view)
    };
    let mut done = running_heads(book, &edge);
    done.extend(bracket_number_lines(book));
    done.extend(concurrence_lines(book));
    done.extend(margin_numbers(book));
    done.extend(no_paragraph_numbering(book));
    done.extend(note_labels(book));
    done.extend(duplicate_references(book));
    done
}
