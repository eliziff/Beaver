#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! Scores the engine's note pairer on the Open Access Journals Database footnote goldset, on the
//! goldset's own lines, so no PDF is read: `olj_pairing <gold_lines.jsonl> <gold_markers.jsonl> [notes.jsonl]`.
//! Each note the pairer writes marks its label's line and each of its calls' lines; a mark matches the gold's by
//! article, role (label or reference), note and line. A third argument writes each article's notes as JSONL: its label,
//! its label's and its calls' places (a line's id and a character range of it) and its body lines.

use legal_structure::layout::{Line, Page};
use legal_structure::{ScalarRange, StructureAnalysis, STRUCTURE_ANALYSIS};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::{BufRead, BufReader};
use std::time::Instant;

fn field(row: &Value, name: &str) -> String {
    match &row[name] {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// A line box, as an object or as the text of one ("{'x0': 192.0, ...}").
fn bbox(value: &Value) -> [f64; 4] {
    let parsed;
    let value = match value.as_str() {
        Some(text) => {
            parsed = serde_json::from_str::<Value>(&text.replace('\'', "\"")).unwrap_or(Value::Null);
            &parsed
        }
        None => value,
    };
    let get = |keys: &[&str]| keys.iter().find_map(|key| value.get(*key).and_then(Value::as_f64));
    match (get(&["x0", "left", "x"]), get(&["y0", "top", "y"]), get(&["x1", "right"]), get(&["y1", "bottom"])) {
        (Some(x0), Some(y0), Some(x1), Some(y1)) => [x0, y0, x1, y1],
        _ => [0.0; 4],
    }
}

fn rows(path: &str) -> impl Iterator<Item = Value> {
    BufReader::new(std::fs::File::open(path).expect(path))
        .lines()
        .map_while(Result::ok)
        .filter_map(|row| serde_json::from_str::<Value>(row.trim_start_matches('\u{feff}')).ok())
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let started = Instant::now();
    let mut articles = BTreeMap::<(String, String), Vec<Value>>::new();
    for row in rows(&args[1]) {
        let article = (field(&row, "dataset"), field(&row, "article_id"));
        if !article.0.is_empty() && !article.1.is_empty() {
            articles.entry(article).or_default().push(row);
        }
    }
    let key = |row: &Value| (field(row, "dataset"), field(row, "article_id"), field(row, "role"), field(row, "note_id"), field(row, "line_id"));
    let gold = rows(&args[2]).filter(|row| articles.contains_key(&(field(row, "dataset"), field(row, "article_id")))).map(|row| key(&row)).collect::<HashSet<_>>();
    // Only the goldset's verified articles are scored.
    let verified = gold.iter().map(|key| (key.0.clone(), key.1.clone())).collect::<HashSet<_>>();
    articles.retain(|article, _| verified.contains(article));
    let mut predicted = HashSet::new();
    let mut written = args.get(3).map(|path| std::io::BufWriter::new(std::fs::File::create(path).expect(path)));
    let citations = BTreeMap::new();
    for ((dataset, article_id), rows) in &articles {
        let mut pages = BTreeMap::<u64, Vec<Line>>::new();
        for (index, row) in rows.iter().enumerate() {
            let number = field(row, "pdf_page").parse::<u64>().unwrap_or(1).max(1);
            let text = ["raw_transcription", "normalized_transcription", "line_text"]
                .iter()
                .find_map(|name| row[*name].as_str().filter(|text| !text.is_empty()))
                .unwrap_or_default();
            let line = json!({
                "id": row["line_id"], "page_index": number - 1, "page_number": number, "source_index": index,
                "reading_order": field(row, "reading_order_index").parse::<u64>().unwrap_or(index as u64),
                "block_index": 0, "text": text, "bbox": bbox(&row["line_bbox_px"]),
                "region_type": row["region_type"].as_str().unwrap_or("unknown"), "region_id": field(row, "region_id"), "source": "ocr",
            });
            pages.entry(number).or_default().push(serde_json::from_value(line).expect("goldset line"));
        }
        let pages = pages
            .into_iter()
            .map(|(number, mut lines)| {
                lines.sort_by_key(|line| line.reading_order);
                let width = lines.iter().map(|line| line.bbox[2]).fold(1000.0, f64::max);
                let height = lines.iter().map(|line| line.bbox[3]).fold(1400.0, f64::max);
                serde_json::from_value::<Page>(json!({
                    "id": format!("p{number:04}"), "index": number - 1, "number": number, "width": width,
                    "height": height, "lines": lines, "regions": [], "source": "ocr",
                }))
                .expect("goldset page")
            })
            .collect::<Vec<_>>();
        // The lines one after another, each its characters and a separator past them, so a range names its line.
        let mut starts = Vec::new();
        let mut at = 0;
        for line in pages.iter().flat_map(|page| &page.lines) {
            starts.push((at, line.id.as_str()));
            at += line.text.chars().count() + 1;
        }
        let start_of: std::collections::HashMap<&str, usize> = starts.iter().map(|&(at, id)| (id, at)).collect();
        let place = |id: &str, start: usize, end: usize| start_of.get(id).map(|&at| ScalarRange { start: at + start, end: at + end });
        let on_line = |range: &ScalarRange| {
            let (at, id) = starts[starts.partition_point(|&(at, _)| at <= range.start) - 1];
            (id, json!({"line_id": id, "start": range.start - at, "end": range.end - at}))
        };
        let output = STRUCTURE_ANALYSIS.pair_footnotes(&pages, &citations, &|_| 0, &place);
        for note in &output.notes {
            let label = note.printed_label();
            let mark = |role: &str, range: &ScalarRange| (dataset.clone(), article_id.clone(), role.to_owned(), label.to_owned(),
                on_line(range).0.to_owned());
            predicted.extend(note.marker_range.iter().map(|range| mark("fn_label", range)));
            predicted.extend(note.calls.iter().map(|call| mark("fn_ref", call)));
            if let Some(out) = written.as_mut() {
                use std::io::Write;
                let note = json!({ "dataset": dataset, "article_id": article_id, "label": label,
                    "label_anchor": note.marker_range.as_ref().map(|range| on_line(range).1),
                    "reference_anchors": note.calls.iter().map(|call| on_line(call).1).collect::<Vec<_>>(),
                    "body_line_ids": &note.line_ids });
                writeln!(out, "{note}").expect("notes out");
            }
        }
    }
    for role in ["fn_label", "fn_ref"] {
        let expected = gold.iter().filter(|key| key.2 == role).count();
        let found = predicted.iter().filter(|key| key.2 == role).count();
        let correct = predicted.iter().filter(|key| key.2 == role && gold.contains(*key)).count();
        println!(
            "{role}: expected {expected}, predicted {found}, correct {correct}, precision {:.4}, recall {:.4}",
            correct as f64 / found.max(1) as f64,
            correct as f64 / expected.max(1) as f64
        );
    }
    println!("{} articles in {:.1} s", articles.len(), started.elapsed().as_secs_f64());
}
