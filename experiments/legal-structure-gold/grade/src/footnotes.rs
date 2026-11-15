//! The journal footnote gold (`olj-footnote-gold.v1`: scanned law-journal articles whose every note label and note
//! reference was placed by hand) scored on a parse's notes. A note is one footnote or endnote node: its label its
//! marker range, on its label's page; its references its calls.
//!
//!   notes       printed label on the label's page (body-start agreement reported beside it)
//!   references  a reference to the note's label on its page
//!   positions   references one of whose two words before matches the gold line's
//!   pairs       reference page + label page + note label
//!
//! Totals are micro-averaged.
use legal_structure_model::text::normalize_label;
use legal_structure_model::{DocumentStructure, NodeKind};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

pub const LAYERS: [&str; 4] = ["notes", "references", "positions", "pairs"];

#[derive(Deserialize)]
pub struct Gold {
    pub dataset: String,
    pub article_id: String,
    #[serde(default)]
    pub pages: usize,
    pub notes: Vec<Pair>,
}

#[derive(Deserialize)]
pub struct Pair {
    pub note_id: String,
    #[serde(default)]
    pub labels: Vec<Mark>,
    #[serde(default)]
    pub refs: Vec<Mark>,
}

#[derive(Deserialize)]
pub struct Mark {
    pub page: usize,
    pub start: usize,
    pub end: usize,
    pub line_text: String,
}

/// A label as both sides are compared on: the engine's normalized label, its punctuation off.
fn label_key(value: &str) -> String {
    normalize_label(value.trim().trim_matches(|c: char| ".)]([:,;".contains(c)).trim())
}

/// A text's words: its runs of two letters or more, lower-cased.
fn words(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut word = String::new();
    for c in text.chars().chain(std::iter::once(' ')) {
        if c.is_alphabetic() {
            word.extend(c.to_lowercase());
        } else {
            if word.chars().count() >= 2 {
                found.push(std::mem::take(&mut word));
            }
            word.clear();
        }
    }
    found
}

fn last_two(mut found: Vec<String>) -> Vec<String> {
    let keep = found.len().saturating_sub(2);
    found.drain(..keep);
    found
}

/// How alike two words are: twice their longest common subsequence over their lengths together.
fn ratio(a: &str, b: &str) -> f64 {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let mut row = vec![0usize; b.len() + 1];
    for x in &a {
        let mut previous = 0;
        for (j, y) in b.iter().enumerate() {
            let held = row[j + 1];
            row[j + 1] = if x == y { previous + 1 } else { row[j + 1].max(row[j]) };
            previous = held;
        }
    }
    2.0 * row[b.len()] as f64 / (a.len() + b.len()) as f64
}

struct Note {
    page: usize,
    label: String,
    body: String,
}

struct Reference {
    page: usize,
    label: String,
    note_page: Option<usize>,
    before: Vec<String>,
}

fn expected(gold: &Gold) -> (Vec<Note>, Vec<Reference>) {
    let (mut notes, mut references) = (Vec::new(), Vec::new());
    for pair in &gold.notes {
        let label = label_key(&pair.note_id);
        for mark in &pair.labels {
            notes.push(Note { page: mark.page, label: label.clone(), body: mark.line_text.chars().skip(mark.end).take(160).collect() });
        }
        for mark in &pair.refs {
            let before: String = mark.line_text.chars().take(mark.start).collect();
            references.push(Reference { page: mark.page, label: label.clone(), note_page: pair.labels.first().map(|l| l.page), before: last_two(words(&before)) });
        }
    }
    (notes, references)
}

fn predicted(structure: &DocumentStructure) -> (Vec<Note>, Vec<Reference>) {
    let units: Vec<u16> = structure.text.encode_utf16().collect();
    let text = |start: usize, end: usize| String::from_utf16_lossy(&units[start.min(units.len())..end.min(units.len())]);
    let mut pages: Vec<(usize, usize, usize)> = structure.nodes.iter().filter(|n| n.kind == NodeKind::Page)
        .map(|n| (n.range.start, n.range.end, n.page_indexes.first().copied().unwrap_or(0) + 1)).collect();
    pages.sort_unstable();
    let page_at = |offset: usize| pages.iter().find(|&&(s, e, _)| s <= offset && offset < e).or(pages.last()).map_or(1, |p| p.2);
    let (mut notes, mut references) = (Vec::new(), Vec::new());
    for node in structure.nodes.iter().filter(|n| matches!(n.kind, NodeKind::Footnote | NodeKind::Endnote)) {
        let label = node.marker_range.map(|m| label_key(&text(m.start, m.end))).unwrap_or_default();
        // The note's page is its label's; its body its ranges past the label.
        let page = node.marker_range.map_or_else(|| node.page_indexes.first().copied().unwrap_or(0) + 1, |m| page_at(m.start));
        let ranges = if node.ranges.is_empty() { vec![node.range] } else { node.ranges.clone() };
        let body: Vec<String> = ranges.iter().filter(|r| Some(**r) != node.marker_range).map(|r| text(r.start, r.end)).collect();
        let body = if body.is_empty() { text(node.range.start, node.range.end) } else { body.join(" ") };
        notes.push(Note { page, label: label.clone(), body: body.chars().take(160).collect() });
        for call in &node.calls {
            // A reference counts for the note it belongs to: recognition can misread its glyphs.
            references.push(Reference { page: page_at(call.start), label: label.clone(), note_page: Some(page),
                before: last_two(words(&text(call.start.saturating_sub(60), call.start))) });
        }
    }
    (notes, references)
}

/// Expected, predicted and correct of two multisets of keys.
fn count<K: std::hash::Hash + Eq>(gold: impl Iterator<Item = K>, found: impl Iterator<Item = K>) -> Value {
    let mut want: HashMap<K, usize> = HashMap::new();
    for key in gold {
        *want.entry(key).or_default() += 1;
    }
    let (expected, mut predicted, mut correct) = (want.values().sum::<usize>(), 0, 0);
    for key in found {
        predicted += 1;
        if let Some(left) = want.get_mut(&key).filter(|left| **left > 0) {
            *left -= 1;
            correct += 1;
        }
    }
    json!({"expected": expected, "predicted": predicted, "correct": correct})
}

/// One article's layers, its bodies' agreement, and its false and missed notes.
pub fn compare(gold: &Gold, structure: &DocumentStructure) -> Value {
    let (gold_notes, gold_references) = expected(gold);
    let (notes, references) = predicted(structure);
    let mut positions = 0;
    let mut pool: HashMap<(usize, &str), Vec<&Vec<String>>> = HashMap::new();
    for reference in &gold_references {
        pool.entry((reference.page, &reference.label)).or_default().push(&reference.before);
    }
    for reference in &references {
        let Some(options) = pool.get_mut(&(reference.page, reference.label.as_str())) else { continue };
        let matched = options.iter().position(|before| {
            (before.is_empty() && reference.before.is_empty()) || before.iter().any(|a| reference.before.iter().any(|b| ratio(a, b) >= 0.75))
        });
        if let Some(k) = matched {
            positions += 1;
            options.remove(k);
        }
    }
    let mut bodies: HashMap<(usize, &str), Vec<&str>> = HashMap::new();
    for note in &gold_notes {
        bodies.entry((note.page, &note.label)).or_default().push(&note.body);
    }
    let (mut matched, mut agreed, mut false_notes) = (0, 0, Vec::new());
    for note in &notes {
        match bodies.get_mut(&(note.page, note.label.as_str())).filter(|found| !found.is_empty()) {
            Some(found) => {
                let gold_body = found.remove(0);
                matched += 1;
                let a: Vec<String> = words(gold_body).into_iter().take(8).collect();
                let b: Vec<String> = words(&note.body).into_iter().take(10).collect();
                agreed += usize::from(a.is_empty() || a.iter().filter(|w| b.contains(w)).count() as f64 >= 0.6 * a.len() as f64);
            }
            None => false_notes.push(json!({"page": note.page, "label": note.label, "body": note.body.chars().take(100).collect::<String>()})),
        }
    }
    let missed: Vec<Value> = bodies.iter().flat_map(|((page, label), found)| found.iter()
        .map(move |body| json!({"page": page, "label": label, "body": body.chars().take(100).collect::<String>()}))).collect();
    json!({
        "metrics": {
            "notes": count(gold_notes.iter().map(|n| (n.page, n.label.clone())), notes.iter().map(|n| (n.page, n.label.clone()))),
            "references": count(gold_references.iter().map(|r| (r.page, r.label.clone())), references.iter().map(|r| (r.page, r.label.clone()))),
            "positions": {"expected": gold_references.len(), "predicted": references.len(), "correct": positions},
            "pairs": count(gold_references.iter().map(|r| (r.page, r.label.clone(), r.note_page)), references.iter().map(|r| (r.page, r.label.clone(), r.note_page))),
        },
        "bodies": {"matched": matched, "agreed": agreed},
        "false_notes": false_notes,
        "missed_notes": missed,
    })
}

/// Each layer's pooled counts, precision, recall and F1.
pub fn totals(rows: &[&Value]) -> Value {
    let mut found = serde_json::Map::new();
    for layer in LAYERS {
        let sum = |key: &str| rows.iter().map(|r| r["metrics"][layer][key].as_u64().unwrap_or(0)).sum::<u64>();
        let (e, p, c) = (sum("expected"), sum("predicted"), sum("correct"));
        let precision = if p > 0 { c as f64 / p as f64 } else { 1.0 };
        let recall = if e > 0 { c as f64 / e as f64 } else { 1.0 };
        let f1 = if precision + recall > 0.0 { 2.0 * precision * recall / (precision + recall) } else { 0.0 };
        found.insert(layer.into(), json!({"expected": e, "predicted": p, "correct": c, "precision": precision, "recall": recall, "f1": f1}));
    }
    Value::Object(found)
}
