#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! The engine's note pairer over pages of lines given as JSON on stdin, no PDF read:
//! `note_pairs < {"pages": [Page...]}`, each page and line in the layout contract's own shape.
//! Prints the pair claims (each note's label anchor, its reference anchors and its body lines) as
//! JSON, for the structure gold to record the pairs the pairer finds over the gold's own lines.

use legal_structure::layout::Page;
use legal_structure::{LayoutAnalysis, STRUCTURE_ANALYSIS};
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
    let output = STRUCTURE_ANALYSIS.pair_footnotes(&pages, &BTreeMap::new(), false);
    println!("{}", serde_json::to_string(&output.pair_claims).expect("pair claims"));
}
