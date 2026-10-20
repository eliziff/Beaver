//! Paragraph-boundary training inputs from the real Rust reader, with fixed gold targets.
use crate::paragraph_features::{
    paragraph_body_line as body, paragraph_boundary_features as features,
    PARAGRAPH_FEATURES as FEATURES,
};
use crate::state::{self, Gold, State};
use legal_pdf_core::{read_gzip_json, write_gzip_json, Page};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::Instant,
};

/// Project training targets through the same fixed-gold alignment used for evaluation.
fn owners(
    gold: &Gold,
    reference: &State,
    candidate: &State,
) -> Result<HashMap<String, Option<usize>>, String> {
    let mut spans: HashMap<&str, Vec<(usize, usize, usize)>> = HashMap::new();
    for (u, unit) in gold.units.iter().enumerate() {
        for &t in &unit.lines {
            for span in &gold.typed[t].spans {
                spans
                    .entry(&span.line_id)
                    .or_default()
                    .push((span.start, span.end, u));
            }
        }
    }
    let alignment = crate::alignment::align(reference, candidate)?;
    Ok(candidate
        .lines
        .iter()
        .enumerate()
        .map(|(c, line)| {
            let mut units = HashSet::new();
            let mut covered = 0;
            for &(_, _, r, start, end) in &alignment.mappings[c] {
                for &(lo, hi, u) in spans
                    .get(reference.lines[r].id.as_str())
                    .into_iter()
                    .flatten()
                {
                    let size = end.min(hi).saturating_sub(start.max(lo));
                    if size > 0 {
                        units.insert(u);
                        covered += size;
                    }
                }
            }
            // Mixed units and weak matches are ambiguous supervision, never negative examples.
            let owner = if units.len() == 1 && covered as f64 >= 0.9 * line.text.len().max(1) as f64
            {
                units.into_iter().next()
            } else {
                None
            };
            (line.id.clone(), owner)
        })
        .collect())
}

fn records(
    gold: &Gold,
    pages: &[Page],
    structure: &legal_structure_model::DocumentStructure,
) -> Result<Value, String> {
    let extraction = pages
        .iter()
        .map(|p| state::ExtractionPage {
            width: p.width,
            height: p.height,
            lines: p.lines.iter().map(|l| (l.id.clone(), l.bbox)).collect(),
        })
        .collect::<Vec<_>>();
    let owners = owners(
        gold,
        &state::projected(gold)?,
        &state::parsed(structure, &extraction)?,
    )?;
    let prose = |u: usize| {
        matches!(
            gold.typed[gold.units[u].lines[0]].region.as_str(),
            "text" | "quote" | "list_item"
        )
    };
    let (mut pairs, mut x, mut y, mut baseline) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for page in pages {
        for pair in page.lines.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            if !body(a) || !body(b) {
                continue;
            }
            let (Some(Some(ua)), Some(Some(ub))) =
                (owners.get(a.id.as_str()), owners.get(b.id.as_str()))
            else {
                continue;
            };
            if !prose(*ua) || !prose(*ub) {
                continue;
            }
            pairs.push([a.id.clone(), b.id.clone()]);
            x.push(features(page, a, b, a.block_index != b.block_index));
            y.push(ua != ub);
            baseline.push(a.block_index != b.block_index);
        }
    }
    Ok(json!({"pairs": pairs, "features": x, "starts": y, "baseline_starts": baseline}))
}

pub fn export(gold: &Path, manifest: &Path, out: &Path) -> Result<(), String> {
    let sources: Vec<_> = super::sources(gold, manifest)?
        .into_iter()
        .filter(|s| s.split != "test")
        .collect();
    std::fs::create_dir_all(out.join("data")).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let hash = |path: &Path| -> Result<String, String> {
        std::fs::read(path)
            .map(|bytes| format!("{:x}", Sha256::digest(&bytes)))
            .map_err(|e| e.to_string())
    };
    let results = super::parallel(
        &sources,
        |s| {
            std::fs::metadata(gold.join("inputs").join(format!("{}.json.gz", s.sha256)))
                .map_or(0, |m| m.len())
        },
        |source| -> Result<Value, String> {
            let gold_path = gold.join("v4").join(&source.sha256).join("gold.json.gz");
            let input = gold
                .join("inputs")
                .join(format!("{}.json.gz", source.sha256));
            let expected: Gold = read_gzip_json(&gold_path).map_err(|e| e.to_string())?;
            let extracted = read_gzip_json(&input).map_err(|e| e.to_string())?;
            let mut pages = Vec::new();
            let document =
                legalpdf::gold_structure_document(extracted, &source.sha256, Some(&mut pages))
                    .map_err(|e| e.to_string())?;
            let record = records(&expected, &pages, document.structure())?;
            let file = format!("data/{}.json.gz", source.sha256);
            write_gzip_json(&out.join(&file), &record).map_err(|e| e.to_string())?;
            Ok(
                json!({"source_sha256": source.sha256, "split": source.split, "mode": source.mode,
            "file": file, "file_sha256": hash(&out.join(&file))?, "pairs": record["starts"].as_array().map_or(0, Vec::len),
            "gold_sha256": hash(&gold_path)?, "input_sha256": hash(&input)?}),
            )
        },
    );
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    for (source, result) in sources.iter().zip(results) {
        match result {
            Ok(row) => rows.push(row),
            Err(error) => errors.push(json!({"source_sha256": source.sha256, "error": error})),
        }
    }
    let dataset = json!({"schema_version": "legal-paragraph-boundaries.v1", "feature_names": FEATURES,
        "exporter_sha256": hash(&std::env::current_exe().map_err(|e| e.to_string())?)?,
        "sources": rows, "errors": errors, "elapsed_seconds": started.elapsed().as_secs_f64()});
    std::fs::write(
        out.join("dataset.json"),
        serde_json::to_vec(&dataset).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    eprintln!(
        "{} sources, {} pairs, {} errors in {:.1}s",
        rows.len(),
        rows.iter()
            .map(|r| r["pairs"].as_u64().unwrap_or(0))
            .sum::<u64>(),
        errors.len(),
        started.elapsed().as_secs_f64()
    );
    if !errors.is_empty() {
        return Err("Paragraph data export failed; see dataset.json".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_ocr_splits_can_have_targets_while_mixed_units_are_excluded() {
        let gold: Gold = serde_json::from_value(json!({"schema_version": state::V4,
            "source_sha256": "invented", "lines": [{"id": "original", "page": 1, "text": "AmberBlue"}], "notes": [],
            "typed": [
                {"region": "text", "spans": [{"line_id": "original", "start": 0, "end": 5}]},
                {"region": "text", "spans": [{"line_id": "original", "start": 5, "end": 9}]}
            ], "units": [{"lines": [0], "parent": null}, {"lines": [1], "parent": null}]})).unwrap();
        let reference = state::projected(&gold).unwrap();
        for (lines, expected) in [
            (
                json!([{"id": "first", "page": 1, "text": "Amber"}, {"id": "last", "page": 1, "text": "Blue"}]),
                vec![Some(0), Some(1)],
            ),
            (
                json!([{"id": "mixed", "page": 1, "text": "AmberBlue"}]),
                vec![None],
            ),
            (
                json!([{"id": "missing", "page": 1, "text": "Quartz"}]),
                vec![None],
            ),
        ] {
            let candidate_gold: Gold = serde_json::from_value(json!({"schema_version": state::V4,
                "source_sha256": "invented", "lines": lines, "typed": [], "units": [], "notes": []})).unwrap();
            let candidate = state::projected(&candidate_gold).unwrap();
            let actual = owners(&gold, &reference, &candidate).unwrap();
            assert_eq!(
                candidate
                    .lines
                    .iter()
                    .map(|l| actual[&l.id])
                    .collect::<Vec<_>>(),
                expected
            );
        }
    }
}
