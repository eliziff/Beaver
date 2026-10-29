//! Strictly matched crop readings through cached extraction and the owning Rust structure scorer.
#[allow(dead_code, unused_imports)]
#[path = "../main.rs"]
mod replay;

use legal_pdf_core::read_gzip_json;
use legal_pdf_tagger::{alignment, state, text_diff};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::PathBuf};

#[derive(Deserialize)]
struct Page {
    number: usize,
    readings: PathBuf,
    readings_sha256: String,
}
#[derive(Deserialize)]
struct Job {
    sha256: String,
    gold: PathBuf,
    gold_sha256: String,
    extraction: PathBuf,
    extraction_sha256: String,
    pages: Vec<Page>,
}

fn checked(path: &PathBuf, expected: &str) -> Result<(), Box<dyn std::error::Error>> {
    if format!("{:x}", Sha256::digest(std::fs::read(path)?)) != expected {
        return Err("Frozen input changed".into());
    }
    Ok(())
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        return Err("usage: crop-structure JOBS.json OUTPUT.json".into());
    }
    let jobs: Vec<Job> = serde_json::from_slice(&std::fs::read(&args[0])?)?;
    legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
    let mut results = Vec::new();
    for job in jobs {
        checked(&job.gold, &job.gold_sha256)?;
        checked(&job.extraction, &job.extraction_sha256)?;
        let gold: Value = read_gzip_json(&job.gold)?;
        let expected = state::projected(&serde_json::from_value::<state::Gold>(gold)?)?;
        let original: Value = read_gzip_json(&job.extraction)?;
        let mut modified: legalpdf::ExtractedPdf = serde_json::from_value(original.clone())?;
        let mut eligible = 0;
        let mut matched = 0;
        let mut ambiguous = 0;
        let mut used = HashSet::new();
        for page in job.pages {
            checked(&page.readings, &page.readings_sha256)?;
            let observed: Value = serde_json::from_slice(&std::fs::read(&page.readings)?)?;
            let lines = &mut modified
                .pages
                .iter_mut()
                .find(|p| p.number as usize == page.number)
                .ok_or("Missing cached page")?
                .lines;
            for row in observed["lines"].as_array().ok_or("Missing readings")? {
                let before = row["baseline"]["text"]
                    .as_str()
                    .ok_or("Missing baseline text")?;
                let after = row["candidate"]["text"]
                    .as_str()
                    .ok_or("Missing candidate text")?;
                if before == after {
                    continue;
                }
                eligible += 1;
                let indices = lines
                    .iter()
                    .enumerate()
                    .filter(|(_, l)| l.text == before && !used.contains(&l.id))
                    .map(|(i, _)| i)
                    .collect::<Vec<_>>();
                if indices.len() != 1 {
                    ambiguous += usize::from(indices.len() > 1);
                    continue;
                }
                let line = &mut lines[indices[0]];
                used.insert(line.id.clone());
                for edit in replay::edits(before, after)?.iter().rev() {
                    replay::patch(line, edit);
                }
                matched += 1;
            }
        }
        let baseline = replay::grade(original.clone(), &expected, &job.sha256)?;
        let candidate = if matched == 0 {
            baseline.clone()
        } else {
            legal_pdf_core::associate_ocr_markers(&mut modified.pages);
            replay::grade(serde_json::to_value(modified)?, &expected, &job.sha256)?
        };
        results.push(json!({"source_sha256":job.sha256,"changed_readings":eligible,"matched_lines":matched,
            "ambiguous_lines":ambiguous,"baseline":baseline["metrics"],"candidate_partial":candidate["metrics"]}));
        println!(
            "{}",
            json!({"source":job.sha256,"changed_readings":eligible,"matched_lines":matched})
        );
    }
    std::fs::write(
        &args[1],
        serde_json::to_vec_pretty(&json!({"schema":"ocr-crop-ab.structure.v1",
        "scope":"Only unique exact baseline-line matches are patched; fixed geometry. This is a partial candidate replay.","documents":results}))?,
    )?;
    Ok(())
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
