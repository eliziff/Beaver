#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! Scores the engine's note pairer on the Open Access Journals Database footnote goldset, on the
//! goldset's own lines, so no PDF is read: `olj_pairing <gold_lines.jsonl> <gold_markers.jsonl>`.
//! A marker matches the gold's by article, role (label or reference), note and line.

use legal_structure::layout::{Line, Page};
use legal_structure::{LayoutAnalysis, STRUCTURE_ANALYSIS};
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
                "region_type": row["region_type"].as_str().unwrap_or("unknown"), "source": "ocr",
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
        let output = STRUCTURE_ANALYSIS.pair_footnotes(&pages, &citations, true);
        for marker in output.pairing_audit.map(|audit| audit.markers).unwrap_or_default() {
            let mut marker = marker;
            marker["dataset"] = json!(dataset);
            marker["article_id"] = json!(article_id);
            predicted.insert(key(&marker));
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
