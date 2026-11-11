#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! The engine's note pairer over lines given as JSON, no PDF read. Each note it writes is printed on the input's own
//! lines: its label, its label's and its calls' places (a line's id and a character range of it) and its body lines.
//!
//! - `note_pairs < {"pages": [Page...]}`: pages and lines in the layout contract's shape, each line's region named by
//!   its `region_type` and `region_id`; prints the notes as one JSON array, for the structure gold to record the pairs
//!   it finds.
//! - `note_pairs --olj <gold_lines.jsonl> <gold_markers.jsonl> [notes.jsonl]`: scores the pairer on the Open Access
//!   Journals Database footnote goldset, on its own lines. Each note marks its label's line and each of its calls'
//!   lines; a mark matches the gold's by article, role (label or reference), note and line. A third argument writes each
//!   article's notes as JSONL.

use legal_structure::layout::{Line, LineZone, NoteLine, NotePage};
use legal_structure::ScalarRange;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::time::Instant;

/// A line as the input gives it: laid out, on its page, in a region its source named.
struct Given {
    line: Line,
    page: NotePage,
    region: String,
    region_id: String,
}

/// Where a line stands, by the name its source gave its region: a note's ("footnote", "endnote", "note"), a marginal
/// note's, a page's or line's number, a running head or foot, a figure's or table's, a heading's or title's, a line
/// label; the body's otherwise.
fn zone_named(region: &str) -> LineZone {
    let region = region.to_lowercase();
    let has = |tokens: &[&str]| tokens.iter().any(|token| region.contains(token));
    match region.as_str() {
        "marginal_note" => LineZone::MarginalNote,
        "footer" => LineZone::Footer,
        "line_label" => LineZone::LineLabel,
        _ if has(&["footnote", "endnote", "reference_content", "note"]) => LineZone::Note(None),
        _ if has(&["page_number", "number", "folio"]) => LineZone::Folio,
        _ if has(&["header", "running"]) => LineZone::Header,
        _ if has(&["table"]) => LineZone::Table,
        _ if has(&["image", "figure", "chart", "graphic", "formula", "separator", "photo"]) => LineZone::Figure,
        _ if has(&["title", "heading", "byline", "abstract", "toc"]) => LineZone::Heading,
        _ => LineZone::Body,
    }
}

/// The notes the pairer writes over `given` (in reading order), each as JSON on the input's lines.
fn pair(given: &[Given]) -> Vec<Value> {
    let mut blocks = HashMap::new();
    let lines: Vec<NoteLine<'_>> = given
        .iter()
        .map(|line| NoteLine {
            id: &line.line.id,
            text: &line.line.text,
            layout: Some(&line.line),
            page: line.page,
            zone: zone_named(&line.region),
            block: (!line.region_id.is_empty()).then(|| {
                let next = blocks.len();
                *blocks.entry(line.region_id.as_str()).or_insert(next)
            }),
            label_suppressed: false,
            paragraph_label: false,
            part: 0,
            citations: &[],
        })
        .collect();
    // The lines one after another, each its characters and a separator past them, so a range names its line.
    let mut starts = Vec::with_capacity(lines.len());
    let mut at = 0;
    for line in &lines {
        starts.push(at);
        at += line.text.chars().count() + 1;
    }
    let place = |line: usize, start: usize, end: usize| Some(ScalarRange { start: starts[line] + start, end: starts[line] + end });
    let on_line = |range: &ScalarRange| {
        let line = starts.partition_point(|&at| at <= range.start) - 1;
        json!({"line_id": lines[line].id, "start": range.start - starts[line], "end": range.end - starts[line]})
    };
    legal_structure::note_pairing::pair_footnotes(&lines, false, &place)
        .notes
        .iter()
        .map(|note| json!({
            "pair_id": note.id, "label": note.label.as_deref().unwrap_or(""), "label_anchor": note.marker_range.as_ref().map(on_line),
            "reference_anchors": note.calls.iter().map(on_line).collect::<Vec<_>>(), "body_line_ids": note.line_ids,
        }))
        .collect()
}

/// The pages of a `{"pages": [...]}` request, their lines in reading order.
fn requested(request: &Value) -> Vec<Given> {
    let mut given = Vec::new();
    for page in request["pages"].as_array().expect("pages") {
        let place = NotePage {
            index: page["index"].as_u64().unwrap_or(0) as usize,
            number: page["number"].as_u64().unwrap_or(1) as u32,
            width: page["width"].as_f64().unwrap_or(0.0),
            height: page["height"].as_f64().unwrap_or(0.0),
        };
        let mut lines = page["lines"].as_array().expect("lines").iter().map(|line| Given {
            line: serde_json::from_value(line.clone()).expect("a line in the layout contract's shape"),
            page: place,
            region: line["region_type"].as_str().unwrap_or("").to_owned(),
            region_id: line["region_id"].as_str().unwrap_or("").to_owned(),
        }).collect::<Vec<_>>();
        lines.sort_by_key(|given| given.line.reading_order);
        given.extend(lines);
    }
    given.sort_by_key(|given| given.page.index);
    given
}

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

/// An article's goldset lines, page by page in reading order; a page as wide and tall as its lines reach (at least
/// 1000 by 1400).
fn article(rows: &[Value]) -> Vec<Given> {
    let mut pages = BTreeMap::<u64, Vec<(usize, Given)>>::new();
    for (index, row) in rows.iter().enumerate() {
        let number = field(row, "pdf_page").parse::<u64>().unwrap_or(1).max(1);
        let text = ["raw_transcription", "normalized_transcription", "line_text"]
            .iter()
            .find_map(|name| row[*name].as_str().filter(|text| !text.is_empty()))
            .unwrap_or_default();
        let order = field(row, "reading_order_index").parse().unwrap_or(index);
        let line = Line { id: field(row, "line_id"), text: text.to_owned(), bbox: bbox(&row["line_bbox_px"]), source: "ocr".to_owned(), ..Default::default() };
        let given = Given { line, page: NotePage::default(), region: row["region_type"].as_str().unwrap_or("").to_owned(), region_id: field(row, "region_id") };
        pages.entry(number).or_default().push((order, given));
    }
    let mut given = Vec::new();
    for (number, mut lines) in pages {
        lines.sort_by_key(|(order, _)| *order);
        let page = NotePage {
            index: number as usize - 1,
            number: number as u32,
            width: lines.iter().map(|(_, given)| given.line.bbox[2]).fold(1000.0, f64::max),
            height: lines.iter().map(|(_, given)| given.line.bbox[3]).fold(1400.0, f64::max),
        };
        given.extend(lines.into_iter().map(|(_, line)| Given { page, ..line }));
    }
    given
}

fn olj(args: &[String]) {
    let started = Instant::now();
    let mut articles = BTreeMap::<(String, String), Vec<Value>>::new();
    for row in rows(&args[0]) {
        let article = (field(&row, "dataset"), field(&row, "article_id"));
        if !article.0.is_empty() && !article.1.is_empty() {
            articles.entry(article).or_default().push(row);
        }
    }
    let key = |row: &Value| (field(row, "dataset"), field(row, "article_id"), field(row, "role"), field(row, "note_id"), field(row, "line_id"));
    let gold = rows(&args[1]).filter(|row| articles.contains_key(&(field(row, "dataset"), field(row, "article_id")))).map(|row| key(&row)).collect::<HashSet<_>>();
    // Only the goldset's verified articles are scored.
    let verified = gold.iter().map(|key| (key.0.clone(), key.1.clone())).collect::<HashSet<_>>();
    articles.retain(|article, _| verified.contains(article));
    let mut predicted = HashSet::new();
    let mut written = args.get(2).map(|path| std::io::BufWriter::new(std::fs::File::create(path).expect(path)));
    for ((dataset, article_id), rows) in &articles {
        for note in pair(&article(rows)) {
            let label = note["label"].as_str().unwrap_or("").to_owned();
            let mark = |role: &str, anchor: &Value| (dataset.clone(), article_id.clone(), role.to_owned(), label.clone(), field(anchor, "line_id"));
            predicted.extend(note["label_anchor"].as_object().map(|_| mark("fn_label", &note["label_anchor"])));
            predicted.extend(note["reference_anchors"].as_array().into_iter().flatten().map(|anchor| mark("fn_ref", anchor)));
            if let Some(out) = written.as_mut() {
                let note = json!({ "dataset": dataset, "article_id": article_id, "label": label, "label_anchor": note["label_anchor"],
                    "reference_anchors": note["reference_anchors"], "body_line_ids": note["body_line_ids"] });
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

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("--olj") {
        return olj(&args[1..]);
    }
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let request: Value = serde_json::from_str(&input).expect("JSON request");
    println!("{}", serde_json::to_string(&pair(&requested(&request))).expect("notes"));
}
