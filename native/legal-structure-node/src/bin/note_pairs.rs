#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! The engine's note pairer over pages of lines given as JSON on stdin, no PDF read:
//! `note_pairs < {"pages": [Page...]}`, each page and line in the layout contract's own shape.
//! Prints each note the pairer writes, on the gold's own lines: its label, its label's and its calls' places (a line's id
//! and a character range of it) and its body lines, as JSON, for the structure gold to record the pairs it finds.

use legal_structure::layout::Page;
use legal_structure::{ScalarRange, StructureAnalysis, STRUCTURE_ANALYSIS};
use std::collections::BTreeMap;
use std::io::Read;

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let request: serde_json::Value = serde_json::from_str(&input).expect("JSON request");
    let pages: Vec<Page> = serde_json::from_value(request["pages"].clone()).expect("pages in the layout contract's shape");
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
        serde_json::json!({"line_id": id, "start": range.start - at, "end": range.end - at})
    };
    let output = STRUCTURE_ANALYSIS.pair_footnotes(&pages, &BTreeMap::new(), &|_| 0, &place);
    let notes: Vec<serde_json::Value> = output.notes.iter().map(|note| serde_json::json!({
        "pair_id": note.id, "label": note.label.as_deref().unwrap_or(""), "label_anchor": note.marker_range.as_ref().map(on_line),
        "reference_anchors": note.calls.iter().map(on_line).collect::<Vec<_>>(), "body_line_ids": note.line_ids,
    })).collect();
    println!("{}", serde_json::to_string(&notes).expect("notes"));
}
