//! Grade fixed gold against explicit cached predictions or a replay of the structure stage.
//!
//!   structure-gold inputs GOLD_DIR MANIFEST    each gold's extraction with its cached readings
//!                                              recognized into it: GOLD_DIR/inputs/<sha>.json.gz
//!   structure-gold grade GOLD_DIR MANIFEST [--exports | --candidates FILE] [--split S] [--runs PREFIX..]
//!                        [--out FILE] [--against FILE] [--show]
//!       replays the structure stage over GOLD_DIR/inputs and scores it (or, with --exports, the
//!       parser exports cached under GOLD_DIR/parsed); writes GOLD_DIR/score/grade.json unless
//!       --out names another file. Totals are pooled per split; test is left out unless asked.
//!       --candidates reads the existing OCR cache manifest (inputs: source_sha256, candidate),
//!       scores only its exports, and never selects them by gold line IDs.
//!   structure-gold explain GOLD_DIR MANIFEST SHA_PREFIX [--exports | --candidates FILE] [--layers a,b] [--limit N]
//!       one document's missed (-) and spurious (+) items per layer, as text.
mod alignment;
mod score;
mod state;
mod text_diff;

use legal_pdf_core::{read_gzip_json, write_gzip_json};
use legal_structure_model::DocumentStructure;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

struct Source {
    sha256: String,
    mode: String,
    split: String,
    pdf: PathBuf,
}

/// A Windows path in the manifest, read from WSL where the grader runs there.
fn local(path: &str) -> PathBuf {
    if cfg!(windows) {
        return PathBuf::from(path);
    }
    let path = path.replace('\\', "/");
    match path.split_once(":/") {
        Some((drive, rest)) if drive.len() == 1 => {
            PathBuf::from(format!("/mnt/{}/{rest}", drive.to_lowercase()))
        }
        _ => PathBuf::from(path),
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
}

/// Every completed gold, with its manifest split and PDF.
fn sources(gold: &Path, manifest: &Path) -> Result<Vec<Source>, String> {
    let manifest = read_json(manifest)?;
    let rows: BTreeMap<&str, &Value> = manifest["documents"]
        .as_array()
        .ok_or("Manifest without documents")?
        .iter()
        .filter_map(|row| Some((row["sha256"].as_str()?, row)))
        .collect();
    let mut found = Vec::new();
    for entry in std::fs::read_dir(gold.join("v4")).map_err(|e| e.to_string())? {
        let job = entry.map_err(|e| e.to_string())?.path();
        let Ok(receipt) = read_json(&job.join("receipt.json")) else {
            continue;
        };
        if receipt["status"] != "complete" || !job.join("gold.json.gz").is_file() {
            continue;
        }
        let sha256 = receipt["source_sha256"]
            .as_str()
            .ok_or("Receipt without source")?
            .to_owned();
        let row = rows
            .get(sha256.as_str())
            .ok_or_else(|| format!("{sha256} is not in the manifest"))?;
        found.push(Source {
            mode: receipt["mode"].as_str().unwrap_or_default().to_owned(),
            split: row["split"].as_str().unwrap_or("unsplit").to_owned(),
            pdf: local(row["path"].as_str().ok_or("Manifest row without path")?),
            sha256,
        });
    }
    found.sort_by(|a, b| a.sha256.cmp(&b.sha256));
    Ok(found)
}

/// The cached parses of a source: its plain (not layout) request directories.
fn parses(gold: &Path, sha256: &str, expected: &state::Gold) -> Result<Vec<PathBuf>, String> {
    let binary_sha = expected.parser["binary_sha256"]
        .as_str()
        .ok_or("Gold has no authoring parser identity")?;
    let mut found = Vec::new();
    for binary in std::fs::read_dir(gold.join("parsed").join(sha256))
        .map_err(|e| format!("{sha256}: {e}"))?
        .flatten()
    {
        if binary.file_name().to_string_lossy() != binary_sha {
            continue;
        }
        for request in std::fs::read_dir(binary.path())
            .map_err(|e| e.to_string())?
            .flatten()
        {
            if request.path().is_dir()
                && !request.file_name().to_string_lossy().ends_with("-layout")
            {
                found.push(request.path());
            }
        }
    }
    found.sort();
    if found.is_empty() {
        return Err(format!("{sha256}: no cached parse"));
    }
    Ok(found)
}

/// Of a source's cached parses, the one whose lines are the gold's lines.
fn authoring<T>(
    sha256: &str,
    gold_lines: &HashSet<&str>,
    found: Vec<T>,
    lines: impl Fn(&T) -> HashSet<String>,
) -> Result<T, String> {
    let mut matches = found.into_iter().filter(|item| {
        let own = lines(item);
        own.len() == gold_lines.len() && own.iter().all(|id| gold_lines.contains(id.as_str()))
    });
    let selected = matches
        .next()
        .ok_or_else(|| format!("{sha256}: no authoring parse holds the gold's lines"))?;
    if matches.next().is_some() {
        return Err(format!(
            "{sha256}: ambiguous authoring parse; use --candidates FILE"
        ));
    }
    Ok(selected)
}

fn files(directory: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".json.gz"))
        .collect();
    found.sort();
    found
}

/// Run `work` over the sources on every core, longest first, keeping each result in place.
fn parallel<T: Send>(
    sources: &[Source],
    weight: impl Fn(&Source) -> u64,
    work: impl Fn(&Source) -> T + Sync,
) -> Vec<T> {
    let mut order: Vec<usize> = (0..sources.len()).collect();
    order.sort_by_key(|&n| std::cmp::Reverse(weight(&sources[n])));
    let threads = std::thread::available_parallelism().map_or(8, |n| n.get());
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<T>>> = Mutex::new((0..sources.len()).map(|_| None).collect());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let k = next.fetch_add(1, Ordering::Relaxed);
                let Some(&n) = order.get(k) else { break };
                let value = work(&sources[n]);
                results.lock().unwrap()[n] = Some(value);
            });
        }
    });
    results
        .into_inner()
        .unwrap()
        .into_iter()
        .map(Option::unwrap)
        .collect()
}

fn inputs(gold: &Path, manifest: &Path) -> Result<(), String> {
    let all = sources(gold, manifest)?;
    let destination = gold.join("inputs");
    std::fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let results = parallel(
        &all,
        |s| std::fs::metadata(&s.pdf).map_or(0, |m| m.len()),
        |source| -> Result<(), String> {
            let target = destination.join(format!("{}.json.gz", source.sha256));
            if target.is_file() {
                return Ok(());
            }
            let expected: state::Gold =
                read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz"))
                    .map_err(|e| e.to_string())?;
            let gold_lines: HashSet<&str> = expected.lines.iter().map(|l| l.id.as_str()).collect();
            let pdf =
                std::fs::read(&source.pdf).map_err(|e| format!("{}: {e}", source.pdf.display()))?;
            let mut candidates = Vec::new();
            for parse in parses(gold, &source.sha256, &expected)? {
                let extractions = files(&parse.join("parse-v1/extractions"));
                let [extraction] = extractions.as_slice() else {
                    return Err(format!(
                        "{}: {} extractions",
                        source.sha256,
                        extractions.len()
                    ));
                };
                let readings = files(&parse.join("parse-v1/recognition"));
                candidates.push(
                    legalpdf::gold_structure_inputs(&pdf, extraction, &readings)
                        .map_err(|e| format!("{}: {e}", source.sha256))?,
                );
            }
            let extracted = authoring(
                &source.sha256,
                &gold_lines,
                candidates,
                |extracted: &legalpdf::ExtractedPdf| {
                    extracted
                        .pages
                        .iter()
                        .flat_map(|p| p.lines.iter().map(|l| l.id.clone()))
                        .collect()
                },
            )?;
            write_gzip_json(&target, &extracted).map_err(|e| e.to_string())
        },
    );
    let failed: Vec<&String> = results.iter().filter_map(|r| r.as_ref().err()).collect();
    for error in &failed {
        eprintln!("ERROR {error}");
    }
    eprintln!(
        "{} inputs, {} failed, in {:.1}s",
        all.len(),
        failed.len(),
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

#[derive(Deserialize)]
struct Export {
    structure: DocumentStructure,
    extraction: ExportExtraction,
}

#[derive(Deserialize)]
struct ExportExtraction {
    source_sha256: String,
    pages: Vec<ExportPage>,
}

#[derive(Deserialize)]
struct ExportPage {
    width: f64,
    height: f64,
    lines: Vec<ExportLine>,
}

#[derive(Deserialize)]
struct ExportLine {
    id: String,
    bbox: [f64; 4],
}

/// Select cached predictions explicitly, using the existing OCR cache inventory.
fn candidates(path: Option<&str>) -> Result<BTreeMap<String, PathBuf>, String> {
    #[derive(Deserialize)]
    struct Inventory {
        inputs: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        source_sha256: String,
        candidate: String,
    }
    let Some(path) = path else {
        return Ok(BTreeMap::new());
    };
    let path = Path::new(path);
    let inventory: Inventory =
        serde_json::from_value(read_json(path)?).map_err(|e| e.to_string())?;
    let mut selected = BTreeMap::new();
    for row in inventory.inputs {
        let candidate = local(&row.candidate);
        let candidate = if candidate.is_absolute() {
            candidate
        } else {
            path.parent().unwrap_or(Path::new(".")).join(candidate)
        };
        if selected
            .insert(row.source_sha256.clone(), candidate)
            .is_some()
        {
            return Err(format!("Duplicate candidate for {}", row.source_sha256));
        }
    }
    Ok(selected)
}

/// The parser's structure for a source and its pages' line boxes: replayed from the gold's
/// inputs, or read from the authoring parse's export.
fn candidate(
    gold: &Path,
    source: &Source,
    expected: &state::Gold,
    exports: bool,
    selected: Option<&PathBuf>,
) -> Result<(DocumentStructure, Vec<state::ExtractionPage>), String> {
    if exports || selected.is_some() {
        let export = if let Some(path) = selected {
            read_gzip_json::<Export>(path).map_err(|e| format!("{}: {e}", path.display()))?
        } else {
            let mut found = Vec::new();
            for parse in parses(gold, &source.sha256, &expected)? {
                found.push(
                    read_gzip_json::<Export>(&parse.join(format!("{}.json.gz", source.mode)))
                        .map_err(|e| format!("{}: {e}", source.sha256))?,
                );
            }
            let gold_lines = expected.lines.iter().map(|l| l.id.as_str()).collect();
            authoring(&source.sha256, &gold_lines, found, |export: &Export| {
                export
                    .structure
                    .source_fragments
                    .iter()
                    .map(|f| f.id.clone())
                    .collect()
            })?
        };
        if export.extraction.source_sha256 != source.sha256 {
            return Err("Candidate extraction belongs to another PDF".into());
        }
        let pages = export
            .extraction
            .pages
            .into_iter()
            .map(|p| state::ExtractionPage {
                width: p.width,
                height: p.height,
                lines: p.lines.into_iter().map(|l| (l.id, l.bbox)).collect(),
            })
            .collect();
        return Ok((export.structure, pages));
    }
    let extracted: legalpdf::ExtractedPdf = read_gzip_json(
        &gold
            .join("inputs")
            .join(format!("{}.json.gz", source.sha256)),
    )
    .map_err(|e| format!("{}: {e}", source.sha256))?;
    let pages = extracted
        .pages
        .iter()
        .map(|p| state::ExtractionPage {
            width: p.width,
            height: p.height,
            lines: p.lines.iter().map(|l| (l.id.clone(), l.bbox)).collect(),
        })
        .collect();
    let document = legalpdf::gold_structure_document(extracted, &source.sha256, None)
        .map_err(|e| format!("{}: {e}", source.sha256))?;
    Ok((document.structure().clone(), pages))
}

struct Graded {
    score: score::Score,
    parse_ms: f64,
    score_ms: f64,
}

fn grade_one(
    gold: &Path,
    source: &Source,
    exports: bool,
    selected: Option<&PathBuf>,
) -> Result<Graded, String> {
    let expected: state::Gold =
        read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz"))
            .map_err(|e| e.to_string())?;
    let started = Instant::now();
    let (structure, pages) = candidate(gold, source, &expected, exports, selected)?;
    let parsed_at = Instant::now();
    if structure
        .source_sha256
        .as_deref()
        .is_some_and(|sha| sha != expected.source_sha256)
    {
        return Err("Candidate belongs to another PDF".into());
    }
    let reference = state::projected(&expected)?;
    let predicted = state::parsed(&structure, &pages)?;
    let score = score::compare(&reference, &predicted)?;
    Ok(Graded {
        score,
        parse_ms: (parsed_at - started).as_secs_f64() * 1e3,
        score_ms: parsed_at.elapsed().as_secs_f64() * 1e3,
    })
}

fn metrics_json(metrics: &BTreeMap<&'static str, score::Metric>) -> Value {
    Value::Object(metrics.iter().map(|(name, m)| (name.to_string(), json!({
        "expected": m.expected, "predicted": m.predicted, "correct": m.correct, "f1": m.f1(),
    }))).collect())
}

fn pooled(rows: &[&Value]) -> BTreeMap<String, score::Metric> {
    let mut totals: BTreeMap<String, score::Metric> = BTreeMap::new();
    for row in rows {
        for (name, m) in row["metrics"].as_object().into_iter().flatten() {
            let field = |key: &str| m[key].as_u64().unwrap_or(0) as usize;
            totals.entry(name.clone()).or_default().add(&score::Metric {
                expected: field("expected"),
                predicted: field("predicted"),
                correct: field("correct"),
            });
        }
    }
    totals
}

fn table(title: &str, totals: &BTreeMap<String, score::Metric>) {
    println!("\n{title}");
    println!(
        "{:22} {:>8} {:>8} {:>6} {:>6} {:>6}",
        "layer", "exp", "pred", "P", "R", "F1"
    );
    for (name, m) in totals {
        let p = if m.predicted > 0 {
            m.correct as f64 / m.predicted as f64
        } else {
            1.0
        };
        let r = if m.expected > 0 {
            m.correct as f64 / m.expected as f64
        } else {
            1.0
        };
        println!(
            "{name:22} {:8} {:8} {p:6.3} {r:6.3} {:6.3}",
            m.expected,
            m.predicted,
            m.f1()
        );
    }
}

/// The change from an earlier summary over the runs both scored: pooled F1 per layer, and per
/// document how many got better or worse.
fn against(before: &Value, after: &[&Value]) {
    let earlier: BTreeMap<&str, &Value> = before["per_run"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| Some((row["source_sha256"].as_str()?, row)))
        .collect();
    let common: Vec<(&Value, &Value)> = after
        .iter()
        .filter_map(|row| Some((*earlier.get(row["source_sha256"].as_str()?)?, *row)))
        .collect();
    let f1 = |m: &Value| {
        let field = |key: &str| m[key].as_u64().unwrap_or(0) as f64;
        let (e, p, c) = (field("expected"), field("predicted"), field("correct"));
        if e + p == 0.0 {
            1.0
        } else {
            2.0 * c / (e + p)
        }
    };
    let (left, right): (Vec<&Value>, Vec<&Value>) = common.iter().copied().unzip();
    let (pooled_before, pooled_after) = (pooled(&left), pooled(&right));
    println!(
        "\nagainst the earlier summary: {} runs in common",
        common.len()
    );
    println!(
        "{:22} {:>9} {:>7} {:>7}   {:>6} {:>6}",
        "layer", "F1 before", "after", "delta", "better", "worse"
    );
    for (name, m) in &pooled_after {
        let (mut better, mut worse) = (0, 0);
        for (b, a) in &common {
            let (Some(x), Some(y)) = (b["metrics"].get(name), a["metrics"].get(name)) else {
                continue;
            };
            let delta = f1(y) - f1(x);
            better += usize::from(delta > 1e-9);
            worse += usize::from(delta < -1e-9);
        }
        let b = pooled_before.get(name).map_or(0.0, |m| m.f1());
        println!(
            "{name:22} {b:9.3} {:7.3} {:+7.3}   {better:6} {worse:6}",
            m.f1(),
            m.f1() - b
        );
    }
}

fn grade(gold: &Path, manifest: &Path, options: &[String]) -> Result<(), String> {
    let flag = |name: &str| options.iter().any(|o| o == name);
    let value = |name: &str| {
        options
            .iter()
            .position(|o| o == name)
            .and_then(|n| options.get(n + 1))
            .cloned()
    };
    let exports = flag("--exports");
    let inventory = value("--candidates");
    if flag("--candidates") && inventory.as_deref().is_none_or(|v| v.starts_with("--")) {
        return Err("--candidates requires an inventory file".into());
    }
    if exports && inventory.is_some() {
        return Err("Choose --exports or --candidates FILE".into());
    }
    let selected = candidates(inventory.as_deref())?;
    let split = value("--split");
    let prefixes: Vec<&String> = options
        .iter()
        .skip_while(|o| *o != "--runs")
        .skip(1)
        .take_while(|o| !o.starts_with("--"))
        .collect();
    let all = sources(gold, manifest)?;
    for sha in selected.keys() {
        if !all.iter().any(|s| &s.sha256 == sha) {
            return Err(format!("Candidate {sha} has no completed gold"));
        }
    }
    let all: Vec<Source> = all
        .into_iter()
        .filter(|s| inventory.is_none() || selected.contains_key(&s.sha256))
        .filter(|s| {
            split
                .as_deref()
                .map_or(s.split != "test", |want| s.split == want)
        })
        .filter(|s| {
            prefixes.is_empty() || prefixes.iter().any(|p| s.sha256.starts_with(p.as_str()))
        })
        .collect();
    if all.is_empty() {
        return Err("No documents selected".into());
    }
    let started = Instant::now();
    let weight = |s: &Source| {
        std::fs::metadata(gold.join("v4").join(&s.sha256).join("gold.json.gz"))
            .map_or(0, |m| m.len())
    };
    let results = parallel(&all, weight, |source| {
        grade_one(gold, source, exports, selected.get(&source.sha256))
    });
    let elapsed = started.elapsed().as_secs_f64();
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    let (mut parse_ms, mut score_ms) = (0.0, 0.0);
    for (source, result) in all.iter().zip(results) {
        match result {
            Ok(graded) => {
                parse_ms += graded.parse_ms;
                score_ms += graded.score_ms;
                let s = &graded.score;
                rows.push(json!({
                    "run": format!("v4/{}", source.sha256), "source_sha256": source.sha256, "mode": source.mode, "split": source.split,
                    "parse_ms": graded.parse_ms.round(),
                    "alignment": s.alignment,
                    "text": s.text, "metrics": metrics_json(&s.metrics),
                }));
            }
            Err(error) => {
                errors.push(json!({"run": format!("v4/{}", source.sha256), "error": error}))
            }
        }
    }
    let refs: Vec<&Value> = rows.iter().collect();
    let mut totals = Map::new();
    for (name, m) in pooled(&refs) {
        let p = if m.predicted > 0 {
            m.correct as f64 / m.predicted as f64
        } else {
            1.0
        };
        let r = if m.expected > 0 {
            m.correct as f64 / m.expected as f64
        } else {
            1.0
        };
        totals.insert(name, json!({"expected": m.expected, "predicted": m.predicted, "correct": m.correct, "precision": p, "recall": r, "f1": m.f1()}));
    }
    let summary = json!({
        "source": if inventory.is_some() { "candidates" } else if exports { "exports" } else { "replay" },
        "candidates": inventory, "elapsed_seconds": elapsed, "runs": rows.len() + errors.len(), "errors": errors,
        "totals": totals, "per_run": rows,
    });
    let out = value("--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| gold.join("score/grade.json"));
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &out,
        serde_json::to_vec(&summary).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    for split in ["train", "development", "test"] {
        let chosen: Vec<&Value> = rows.iter().filter(|r| r["split"] == split).collect();
        if !chosen.is_empty() {
            table(
                &format!("{split}: {} documents", chosen.len()),
                &pooled(&chosen),
            );
        }
    }
    if flag("--show") {
        for row in &rows {
            let layers = row["metrics"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, m)| format!("{k}={:.2}", m["f1"].as_f64().unwrap_or(0.0)))
                .collect::<Vec<_>>()
                .join(" ");
            println!(
                "{} {layers}",
                row["source_sha256"].as_str().unwrap_or_default()
            );
        }
    }
    if let Some(path) = value("--against") {
        against(&read_json(Path::new(&path))?, &refs);
    }
    for error in summary["errors"].as_array().into_iter().flatten() {
        eprintln!("ERROR {} {}", error["run"], error["error"]);
    }
    eprintln!(
        "\n{} documents, {} errors -> {} in {elapsed:.1}s (loading/replay {:.1}s, scoring {:.1}s, summed document times)",
        rows.len(),
        summary["errors"].as_array().map_or(0, Vec::len),
        out.display(),
        parse_ms / 1e3,
        score_ms / 1e3
    );
    if !errors.is_empty() {
        return Err(format!(
            "{} documents failed; see {}",
            errors.len(),
            out.display()
        ));
    }
    Ok(())
}

/// One document's missed and spurious items, layer by layer.
fn explain(gold: &Path, manifest: &Path, prefix: &str, options: &[String]) -> Result<(), String> {
    let value = |name: &str| {
        options
            .iter()
            .position(|o| o == name)
            .and_then(|n| options.get(n + 1))
            .cloned()
    };
    let source = sources(gold, manifest)?
        .into_iter()
        .find(|s| s.sha256.starts_with(prefix))
        .ok_or("No such gold")?;
    let expected: state::Gold =
        read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz"))
            .map_err(|e| e.to_string())?;
    let inventory = value("--candidates");
    if options.iter().any(|o| o == "--candidates")
        && inventory.as_deref().is_none_or(|v| v.starts_with("--"))
    {
        return Err("--candidates requires an inventory file".into());
    }
    if options.iter().any(|o| o == "--exports") && inventory.is_some() {
        return Err("Choose --exports or --candidates FILE".into());
    }
    let selected = candidates(inventory.as_deref())?;
    if inventory.is_some() && !selected.contains_key(&source.sha256) {
        return Err("No candidate selected for this source".into());
    }
    let (structure, pages) = candidate(
        gold,
        &source,
        &expected,
        options.iter().any(|o| o == "--exports"),
        selected.get(&source.sha256),
    )?;
    let layers: Vec<String> = value("--layers")
        .map(|l| l.split(',').map(str::to_owned).collect())
        .unwrap_or_default();
    let limit = value("--limit").and_then(|n| n.parse().ok()).unwrap_or(40);
    let text = score::explain(
        &state::projected(&expected)?,
        &state::parsed(&structure, &pages)?,
        &layers,
        limit,
    )?;
    println!(
        "{} ({}, {}){text}",
        source.sha256, source.mode, source.split
    );
    Ok(())
}

fn main() {
    legalpdf::install_structure_analysis(legal_pdf_core::CHECKOUT_ENGINE);
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let result = match arguments.as_slice() {
        [command, gold, manifest, options @ ..] if command == "grade" => {
            grade(Path::new(gold), Path::new(manifest), options)
        }
        [command, gold, manifest] if command == "inputs" => {
            inputs(Path::new(gold), Path::new(manifest))
        }
        [command, gold, manifest, prefix, options @ ..] if command == "explain" => {
            explain(Path::new(gold), Path::new(manifest), prefix, options)
        }
        _ => Err(
            "usage: structure-gold inputs|grade|explain GOLD_DIR MANIFEST [SHA] [options]".into(),
        ),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
