//! Bounded native replay. Gold remains fixed; the scorer and structure engine are their owners'.
use legal_pdf_core::{read_gzip_json, write_gzip_json};
use legal_pdf_ocr::{
    IndraBackend, IndraOptions, OcrOptions, OcrPageRequest, OcrProvider, ProbeBox,
};
use legal_structure_tagger::{alignment, state, text_diff};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Instant,
};

#[path = "../../legal-structure-gold/grade/src/score.rs"]
mod score;

#[derive(Deserialize)]
struct Job {
    sha256: String,
    pdf: PathBuf,
    gold: PathBuf,
    gold_sha256: String,
    pages: Vec<usize>,
    split: String,
}
#[derive(Deserialize)]
struct Jobs {
    documents: Vec<Job>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}
fn write(path: &Path, value: &Value) -> Result<(), String> {
    std::fs::write(path, serde_json::to_vec(value).unwrap()).map_err(|e| e.to_string())
}

pub(crate) struct Edit {
    start: usize,
    end: usize,
    replacement: Vec<char>,
    gold_start: usize,
    gold_end: usize,
}
pub(crate) fn edits(raw: &str, corrected: &str) -> Result<Vec<Edit>, String> {
    let a = raw.chars().collect::<Vec<_>>();
    let b = corrected.chars().collect::<Vec<_>>();
    let mut found = Vec::new();
    let (mut x, mut y) = (0, 0);
    let mut blocks = text_diff::matching_blocks(&a, &b)?;
    blocks.push((a.len(), b.len(), 0));
    for (i, j, n) in blocks {
        if x != i || y != j {
            found.push(Edit {
                start: x,
                end: i,
                replacement: b[y..j].to_vec(),
                gold_start: y,
                gold_end: j,
            });
        }
        x = i + n;
        y = j + n;
    }
    Ok(found)
}

/// Experimental text intervention: keep physical boxes, typography and flags, remap scalar
/// offsets through the edit. Inserted glyphs acquire no independently verified geometry.
pub(crate) fn patch(line: &mut legalpdf::Line, edit: &Edit) {
    let old = line.text.chars().collect::<Vec<_>>();
    let written = edit.replacement.len();
    let removed = edit.end - edit.start;
    let boundary = |p: usize| {
        if p <= edit.start {
            p
        } else if p >= edit.end {
            p + written - removed
        } else {
            edit.start + ((p - edit.start) * written / removed.max(1))
        }
    };
    line.text = old[..edit.start]
        .iter()
        .chain(&edit.replacement)
        .chain(&old[edit.end..])
        .collect();
    let new = line.text.chars().collect::<Vec<_>>();
    for word in &mut line.words {
        word.start = boundary(word.start);
        word.end = boundary(word.end);
        word.text = new[word.start..word.end].iter().collect();
    }
    line.words.retain(|w| w.start < w.end);
    for span in &mut line.spans {
        span.start = boundary(span.start);
        span.end = boundary(span.end);
        span.text = new[span.start..span.end].iter().collect();
    }
    for reference in &mut line.detached_references {
        reference.start_offset = boundary(reference.start_offset);
        reference.end_offset = boundary(reference.end_offset);
        reference.selected_text = new[reference.start_offset..reference.end_offset]
            .iter()
            .collect();
    }
}

fn interventions(input: &Value, gold: &Value, marks_only: bool) -> Result<(Value, Value), String> {
    let mut extracted: legalpdf::ExtractedPdf =
        serde_json::from_value(input.clone()).map_err(|e| e.to_string())?;
    let mut changed = 0;
    let mut eligible = 0;
    let mut matched = 0;
    let mut used = HashSet::new();
    for g in gold["lines"].as_array().ok_or("Gold without lines")? {
        let Some(corrected) = g["corrected"].as_str() else {
            continue;
        };
        let raw = g["text"].as_str().ok_or("Gold line without text")?;
        let page = g["page"].as_u64().ok_or("Gold line without page")? as usize;
        let id = g["id"].as_str().unwrap();
        let spans = gold["typed"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|t| {
                let markers = t["markers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|group| group.as_array().into_iter().flatten());
                let refs = t["references"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|r| r["spans"].as_array().into_iter().flatten());
                markers.chain(refs)
            })
            .filter(|s| s["line_id"] == id)
            .map(|s| {
                (
                    s["start"].as_u64().unwrap() as usize,
                    s["end"].as_u64().unwrap() as usize,
                )
            })
            .collect::<Vec<_>>();
        let selected = edits(raw, corrected)?
            .into_iter()
            .filter(|e| {
                !marks_only
                    || spans.iter().any(|&(a, b)| {
                        a <= e.gold_start && e.gold_end <= b && (e.gold_start < b || e.gold_end > a)
                    })
            })
            .collect::<Vec<_>>();
        if selected.is_empty() {
            continue;
        }
        eligible += 1;
        let Some(p) = extracted
            .pages
            .iter_mut()
            .find(|p| p.number as usize == page)
        else {
            continue;
        };
        let matches = p
            .lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.text == raw && !used.contains(&l.id))
            .map(|(n, _)| n)
            .collect::<Vec<_>>();
        // Exact text and one unique source line on this page: no fuzzy correction of a different line.
        if matches.len() != 1 {
            continue;
        }
        let line = &mut p.lines[matches[0]];
        used.insert(line.id.clone());
        matched += 1;
        for edit in selected.iter().rev() {
            patch(line, edit);
            changed += 1;
        }
    }
    legal_pdf_core::associate_ocr_markers(&mut extracted.pages);
    Ok((
        serde_json::to_value(extracted).unwrap(),
        json!({"eligible_corrected_lines": eligible,
        "matched_corrected_lines": matched, "applied_edits": changed, "scope": "unique exact raw-line matches; fixed geometry"}),
    ))
}

pub(crate) fn grade(
    extraction: Value,
    expected: &state::State,
    sha: &str,
) -> Result<Value, String> {
    let input = serde_json::from_value(extraction).map_err(|e| e.to_string())?;
    let document =
        legalpdf::gold_structure_document(input, sha, None).map_err(|e| e.to_string())?;
    let parsed = state::parsed(document.structure())?;
    let result = score::compare(expected, &parsed)?;
    Ok(
        json!({"metrics": result.metrics, "alignment": result.alignment, "text": result.text,
        "groups": parsed.groups, "annotations": parsed.annotations}),
    )
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        return Err(
            "usage: ocr-structure-attribution JOBS.json OUTPUT MODEL_PACK RUNTIME_DLL".into(),
        );
    }
    let jobs: Jobs =
        serde_json::from_slice(&read(Path::new(&args[0]))?).map_err(|e| e.to_string())?;
    let run_identity = json!({"binary_sha256": digest(&read(&std::env::current_exe().map_err(|e| e.to_string())?)?),
        "jobs_sha256": digest(&read(Path::new(&args[0]))?),
        "model_manifest_sha256": digest(&read(&Path::new(&args[2]).join("manifest.json"))?),
        "runtime_sha256": digest(&read(Path::new(&args[3]))?)});
    legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
    let options = IndraOptions {
        model_pack: Some(args[2].clone().into()),
        runtime: Some(args[3].clone().into()),
        backend: Some(IndraBackend::Cpu),
        workers: 1,
        threads: 1,
        layout_workers: 1,
        batch_size: 16,
        ..Default::default()
    };
    let ocr_options = OcrOptions::Indra(options.clone());
    let mut runtime = Some(OcrProvider::new(&ocr_options).map_err(|e| e.to_string())?);
    let mut high_reader = legal_pdf_ocr::IndraOcr::new(&IndraOptions {
        dpi: 288,
        ..options.clone()
    })
    .map_err(|e| e.to_string())?;
    for job in jobs.documents {
        if !matches!(job.split.as_str(), "train" | "development") {
            return Err("Only exploratory train/development inputs are permitted".into());
        }
        let pdf = read(&job.pdf)?;
        let gold_bytes = read(&job.gold)?;
        if digest(&pdf) != job.sha256 || digest(&gold_bytes) != job.gold_sha256 {
            return Err("Source/gold hash mismatch".into());
        }
        let gold: Value = read_gzip_json(&job.gold).map_err(|e| e.to_string())?;
        if gold["source_sha256"] != job.sha256 {
            return Err("Gold belongs to another source".into());
        }
        let expected = state::projected(
            &serde_json::from_value::<state::Gold>(gold.clone()).map_err(|e| e.to_string())?,
        )?;
        let out = Path::new(&args[1]).join(&job.sha256);
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        let began = Instant::now();
        let extracted = legalpdf::gold_synthetic_inputs(&pdf, &ocr_options, &mut runtime)
            .map_err(|e| e.to_string())?;
        println!(
            "{}",
            json!({"sha256":job.sha256,"phase":"extraction","seconds":began.elapsed().as_secs_f64()})
        );
        let original = serde_json::to_value(&extracted).unwrap();
        write_gzip_json(&out.join("extraction.json.gz"), &original).map_err(|e| e.to_string())?;
        let mut scores = json!({"baseline": grade(original.clone(), &expected, &job.sha256)?});
        for (name, marks_only) in [("mark_text_oracle", true), ("all_text_oracle", false)] {
            let (modified, coverage) = interventions(&original, &gold, marks_only)?;
            scores[name] = grade(modified, &expected, &job.sha256)?;
            scores[name]["intervention"] = coverage;
        }
        println!(
            "{}",
            json!({"sha256":job.sha256,"phase":"structure","seconds":began.elapsed().as_secs_f64()})
        );
        write(&out.join("structure.json"), &scores)?;
        let OcrProvider::Indra(engine) = runtime.as_mut().unwrap();
        let identity = engine.identity().to_owned();
        for number in &job.pages {
            let page = extracted
                .pages
                .iter()
                .find(|p| p.number as usize == *number)
                .ok_or("Selected page absent")?;
            let targets = gold["lines"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|l| l["page"].as_u64() == Some(*number as u64))
                .filter(|l| {
                    gold["typed"].as_array().unwrap().iter().any(|t| {
                        t["markers"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .flat_map(|v| v.as_array().into_iter().flatten())
                            .chain(
                                t["references"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .flat_map(|r| r["spans"].as_array().into_iter().flatten()),
                            )
                            .any(|s| s["line_id"] == l["id"])
                    })
                })
                .map(|l| ProbeBox {
                    id: l["id"].as_str().unwrap().into(),
                    bbox: serde_json::from_value(l["bbox"].clone()).unwrap(),
                })
                .collect::<Vec<_>>();
            for dpi in [144, 288] {
                let reader = if dpi == 144 {
                    &mut *engine
                } else {
                    &mut high_reader
                };
                let request = OcrPageRequest {
                    page_index: page.index,
                    width: page.width,
                    height: page.height,
                    regions: Vec::new(),
                    lines: Vec::new(),
                    words: Vec::new(),
                };
                let directory = out.join(format!("page-{number}-{dpi}"));
                let value = reader
                    .attribution_page(&pdf, &request, &targets, &directory)
                    .map_err(|e| e.to_string())?;
                write(&directory.join("trace.json"), &value)?;
                println!(
                    "{}",
                    json!({"sha256":job.sha256,"phase":"probe","page":number,"dpi":dpi})
                );
            }
        }
        write(
            &out.join("receipt.json"),
            &json!({"source_sha256": job.sha256, "gold_sha256": job.gold_sha256,
            "run_identity": run_identity,
            "ocr_identity": identity, "seconds": began.elapsed().as_secs_f64(), "pages_probed": job.pages,
            "split": job.split, "status": "complete"}),
        )?;
        println!(
            "{}",
            json!({"sha256": job.sha256, "seconds": began.elapsed().as_secs_f64(), "pages": job.pages.len()})
        );
    }
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_edits_are_scalar_ranges_and_keep_unrelated_text() {
        let found = edits("A 🦉 rests. [I2]", "A 🦉 rests. [12]").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].start, 12);
        assert_eq!(found[0].replacement, vec!['1']);
    }

    #[test]
    fn oracle_changes_keep_word_and_span_offsets_in_the_new_scalar_frame() {
        let mut line: legalpdf::Line = serde_json::from_value(json!({
            "id":"invented", "page_index":0,"page_number":1,"source_index":0,"reading_order":0,"block_index":0,
            "text":"4. Quiet boats.","bbox":[0.,0.,100.,12.],
            "words":[{"id":"word","text":"Quiet","bbox":[20.,0.,50.,12.],"start":3,"end":8}],
            "spans":[{"id":"span","text":"4. Quiet boats.","bbox":[0.,0.,100.,12.],"start":0,"end":15}]
        })).unwrap();
        patch(
            &mut line,
            &Edit {
                start: 0,
                end: 1,
                replacement: vec!['1', '2'],
                gold_start: 0,
                gold_end: 2,
            },
        );
        assert_eq!(line.text, "12. Quiet boats.");
        assert_eq!(
            (
                line.words[0].start,
                line.words[0].end,
                line.words[0].text.as_str()
            ),
            (4, 9, "Quiet")
        );
        assert_eq!(line.spans[0].text, line.text);
        assert_eq!(line.spans[0].end, 16);
    }
}
