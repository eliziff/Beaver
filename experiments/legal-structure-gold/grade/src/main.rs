//! Grade fixed gold against explicit cached predictions or a replay of the structure stage.
//!
//!   structure-gold inputs GOLD_DIR MANIFEST    each gold's extraction with its cached readings
//!   structure-gold synthesize GOLD_DIR MANIFEST --model-pack DIR --runtime DLL [--dpi N] [--limit N] [--genre GROUP]
//!       scans made of the main train split's digital golds: rendered, degraded, recognized; gold copied
//!                                              recognized into it: GOLD_DIR/inputs/<sha>.json.gz
//!   structure-gold grade GOLD_DIR MANIFEST [--exports | --candidates FILE] [--split S] [--runs PREFIX..]
//!                        [--group FIELD=VALUE]... [--out FILE] [--against FILE] [--show]
//!       replays the structure stage over GOLD_DIR/inputs and scores it (or, with --exports, the
//!       parser exports cached under GOLD_DIR/parsed); writes GOLD_DIR/score/grade.json unless
//!       --out names another file. Totals are pooled per split; test is left out unless asked.
//!       --candidates reads the existing OCR cache manifest (inputs: source_sha256, candidate),
//!       scores only its exports, and never selects them by gold line IDs.
//!       --labels FILE decodes a tagger's per-line labels ({sha256, ids, labels} rows) over the
//!       replayed parser, which supplies markers, references and note pairs, and scores them.
//!       --group FIELD=VALUE keeps matching manifest groups; repeat to require every match.
//!   structure-gold rows GOLD_DIR MANIFEST OUT_DIR
//!       the tier-1 tagger's training rows, train and development only: each line's evidence
//!       with the replayed parser's labels and the gold's, one JSON document per line of
//!       OUT_DIR/rows-<split>.jsonl.
//!   structure-gold explain GOLD_DIR MANIFEST SHA_PREFIX [--exports | --candidates FILE] [--layers a,b] [--limit N]
//!       one document's missed (-) and spurious (+) items per layer, as text.
//!   structure-gold paragraph-data GOLD_DIR MANIFEST OUT_DIR
//!       exports Rust boundary features and fixed-gold targets, excluding test.
mod paragraph_data;
mod paragraph_features;
mod score;

use legal_structure_tagger::{alignment, labels, rows, state, text_diff};

use legal_pdf_core::{read_gzip_json, write_gzip_json};
use legal_structure_model::DocumentStructure;
use sha2::Digest as _;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

const GROUP_FIELDS: [&str; 5] = ["language_layout", "genre_group", "country", "yardstick", "label_source"];

struct Source {
    sha256: String,
    mode: String,
    split: String,
    groups: BTreeMap<String, String>,
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
        // A gold still being authored into the store has no manifest row yet: it waits.
        let Some(row) = rows.get(sha256.as_str()) else {
            continue;
        };
        found.push(Source {
            mode: receipt["mode"].as_str().unwrap_or_default().to_owned(),
            split: row["split"].as_str().unwrap_or("unsplit").to_owned(),
            groups: GROUP_FIELDS.iter().map(|&field| (
                field.to_owned(), row[field].as_str().unwrap_or("unknown").to_owned(),
            )).collect(),
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
    same: Option<&dyn Fn(&T, &T) -> bool>,
) -> Result<T, String> {
    let mut matches: Vec<T> = found.into_iter().filter(|item| {
        let own = lines(item);
        own.len() == gold_lines.len() && own.iter().all(|id| gold_lines.contains(id.as_str()))
    }).collect();
    if matches.is_empty() {
        return Err(format!("{sha256}: no authoring parse holds the gold's lines"));
    }
    // Parses that read the very same lines are one reading for the gold, whichever is taken.
    let first = matches.remove(0);
    if matches.iter().any(|other| same.as_ref().is_none_or(|same| !same(&first, other))) {
        return Err(format!(
            "{sha256}: ambiguous authoring parse; use --candidates FILE"
        ));
    }
    Ok(first)
}

/// The structure-stage inputs: STRUCTURE_GOLD_INPUTS where set, else the gold's own inputs/.
fn inputs_dir(gold: &Path) -> PathBuf {
    std::env::var_os("STRUCTURE_GOLD_INPUTS").map_or_else(|| gold.join("inputs"), PathBuf::from)
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

/// A grey page degraded as a scan degrades it: a 3x3 box blur, a contrast stretch, deterministic
/// speckle from the seed, 16 grey levels.
fn degrade(width: usize, height: usize, pixels: &[u8], seed: u64) -> Vec<u8> {
    let at = |x: usize, y: usize| usize::from(pixels[y * width + x]);
    let mut state = seed | 1;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    let mut out = vec![0u8; width * height];
    for y in 0..height {
        for x in 0..width {
            let (x0, x1) = (x.saturating_sub(1), (x + 1).min(width - 1));
            let (y0, y1) = (y.saturating_sub(1), (y + 1).min(height - 1));
            let mut sum = 0;
            let mut n = 0;
            for yy in y0..=y1 {
                for xx in x0..=x1 {
                    sum += at(xx, yy);
                    n += 1;
                }
            }
            let mean = sum as f64 / n as f64;
            let r = next();
            let noise = (r % 25) as f64 - 12.0;
            let mut v = (mean - 128.0) * 1.15 + 128.0 + noise;
            if r % 1000 < 2 {
                v = 40.0;
            }
            let q = (v.clamp(0.0, 255.0) / 16.0).round() * 16.0;
            out[y * width + x] = q.min(255.0) as u8;
        }
    }
    out
}

/// An image-only PDF of grey pages at `dpi`: one DeviceGray FlateDecode image per page.
fn image_pdf(pages: &[(usize, usize, Vec<u8>)], dpi: f64) -> Vec<u8> {
    use std::io::Write;
    let mut out: Vec<u8> = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets: Vec<usize> = Vec::new();
    let object = |out: &mut Vec<u8>, offsets: &mut Vec<usize>, body: &[u8]| {
        offsets.push(out.len());
        let _ = write!(out, "{} 0 obj\n", offsets.len());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    };
    object(&mut out, &mut offsets, b"<< /Type /Catalog /Pages 2 0 R >>");
    let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", 3 + 3 * i)).collect();
    object(&mut out, &mut offsets, format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages.len()).as_bytes());
    for (i, (width, height, pixels)) in pages.iter().enumerate() {
        let (w, h) = (*width as f64 * 72.0 / dpi, *height as f64 * 72.0 / dpi);
        let (page, content, image) = (3 + 3 * i, 4 + 3 * i, 5 + 3 * i);
        object(&mut out, &mut offsets, format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w:.2} {h:.2}] /Resources << /XObject << /Im0 {image} 0 R >> >> /Contents {content} 0 R >>"
        ).as_bytes());
        let _ = page;
        let stream = format!("q {w:.2} 0 0 {h:.2} 0 0 cm /Im0 Do Q");
        object(&mut out, &mut offsets, format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()).as_bytes());
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::new(6));
        let _ = encoder.write_all(pixels);
        let data = encoder.finish().unwrap_or_default();
        let mut body = format!(
            "<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length {} >>\nstream\n",
            data.len()
        ).into_bytes();
        body.extend_from_slice(&data);
        body.extend_from_slice(b"\nendstream");
        object(&mut out, &mut offsets, &body);
    }
    let xref = out.len();
    let _ = write!(out, "xref\n0 {}\n0000000000 65535 f \n", offsets.len() + 1);
    for offset in &offsets {
        let _ = write!(out, "{offset:010} 00000 n \n");
    }
    let _ = write!(out, "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", offsets.len() + 1);
    out
}

/// Synthetic scans of the main train split's digital golds: each PDF rendered at --dpi (200), degraded,
/// wrapped as an image-only PDF, recognized by Indra through the engine; the gold copied under the
/// synthetic PDF's sha (mode ocr, `synthetic_of` the original), its inputs written, a manifest row
/// and a provenance record added (collection synthetic-scan). Resumable: an original already
/// synthesized is skipped. Transcripts are left out.
fn synthesize(gold: &Path, manifest: &Path, options: &[String]) -> Result<(), String> {
    let value = |name: &str| options.iter().position(|o| o == name).and_then(|n| options.get(n + 1)).cloned();
    let dpi: f64 = value("--dpi").and_then(|v| v.parse().ok()).unwrap_or(200.0);
    let limit: usize = value("--limit").and_then(|v| v.parse().ok()).unwrap_or(usize::MAX);
    let genre = value("--genre");
    let model_pack = value("--model-pack").ok_or("--model-pack DIR")?;
    let runtime_library = value("--runtime").ok_or("--runtime DLL")?;
    let ocr = legalpdf::OcrOptions::Indra(legalpdf::IndraOptions {
        model_pack: Some(PathBuf::from(model_pack)),
        runtime: Some(PathBuf::from(runtime_library)),
        ..Default::default()
    });
    let mut runtime: Option<legalpdf::OcrProvider> = None;
    let mut done: HashSet<String> = HashSet::new();
    for entry in std::fs::read_dir(gold.join("v4")).map_err(|e| e.to_string())? {
        let job = entry.map_err(|e| e.to_string())?.path();
        if let Ok(receipt) = read_json(&job.join("receipt.json")) {
            if let Some(original) = receipt["synthetic_of"].as_str() {
                done.insert(original.to_owned());
            }
        }
    }
    let provenance_path = gold.join("provenance.json");
    let mut provenance = read_json(&provenance_path)?;
    let mut manifest_value = read_json(manifest)?;
    let chosen: Vec<Source> = sources(gold, manifest)?
        .into_iter()
        .filter(|s| s.split == "train" && s.mode != "ocr" && s.groups.get("yardstick").is_some_and(|y| y == "main")
            && s.groups.get("genre_group").is_none_or(|g| g != "transcript") && !done.contains(&s.sha256)
            && genre.as_deref().is_none_or(|wanted| s.groups.get("genre_group").is_some_and(|g| g == wanted)))
        .collect();
    eprintln!("{} digital main train documents to synthesize ({} already done)", chosen.len(), done.len());
    let started = Instant::now();
    for (n, source) in chosen.iter().take(limit).enumerate() {
        let pdf = match std::fs::read(&source.pdf) {
            Ok(bytes) => bytes,
            Err(e) => {
                eprintln!("SKIP {} {}: {e}", source.sha256, source.pdf.display());
                continue;
            }
        };
        let pages = legalpdf::render_gray_pages(&pdf, dpi);
        if pages.is_empty() {
            eprintln!("SKIP {}: nothing rendered", source.sha256);
            continue;
        }
        let seed = u64::from_str_radix(&source.sha256[..16], 16).unwrap_or(1);
        let degraded: Vec<(usize, usize, Vec<u8>)> = pages.iter().enumerate()
            .map(|(k, (w, h, px))| (*w, *h, degrade(*w, *h, px, seed.wrapping_add(k as u64 * 7919))))
            .collect();
        let synthetic = image_pdf(&degraded, dpi);
        let sha = format!("{:x}", sha2::Sha256::digest(&synthetic));
        let extracted = match legalpdf::gold_synthetic_inputs(&synthetic, &ocr, &mut runtime) {
            Ok(extracted) => extracted,
            Err(e) => {
                eprintln!("FAIL {}: {e}", source.sha256);
                continue;
            }
        };
        let recognized = extracted.pages.iter().filter(|p| p.source == "ocr").count();
        let lines: usize = extracted.pages.iter().map(|p| p.lines.len()).sum();
        let folder = gold.join("v4").join(&sha);
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        legal_pdf_core::write_gzip_json(&inputs_dir(gold).join(format!("{sha}.json.gz")), &extracted).map_err(|e| e.to_string())?;
        let mut copy: Value = read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz")).map_err(|e| e.to_string())?;
        copy["source_sha256"] = json!(sha);
        copy["mode"] = json!("ocr");
        copy["synthetic_of"] = json!(source.sha256);
        legal_pdf_core::write_gzip_json(&folder.join("gold.json.gz"), &copy).map_err(|e| e.to_string())?;
        let receipt = json!({
            "status": "complete", "source_sha256": sha, "mode": "ocr", "pages": pages.len(), "model": "synthetic-scan",
            "synthetic_of": source.sha256, "dpi": dpi, "recognized_pages": recognized, "lines": lines,
            "finished_at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0),
        });
        std::fs::write(folder.join("receipt.json"), serde_json::to_string_pretty(&receipt).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let path = format!("synthetic/{sha}.pdf");
        if let Some(documents) = manifest_value["documents"].as_array_mut() {
            documents.push(json!({"path": path, "mode": "ocr", "split": "train", "sha256": sha, "pages": pages.len(), "synthetic_of": source.sha256}));
        }
        if let Some(records) = provenance["records"].as_array_mut() {
            let mut record = records.iter().find(|r| r["sha256"] == source.sha256).cloned().unwrap_or_else(|| json!({"genre": "unknown", "country": "ca"}));
            record["sha256"] = json!(sha);
            record["mode"] = json!("ocr");
            record["split"] = json!("train");
            record["path"] = json!(path);
            record["pages"] = json!(pages.len());
            record["collection"] = json!("synthetic-scan-2026-10-23");
            record["synthetic_of"] = json!(source.sha256);
            record["label_source"] = json!("model");
            record["source_family"] = json!(format!("{} synthetic", record["source_family"].as_str().unwrap_or("unknown")));
            record["authoring"] = json!({"model": "synthetic-scan", "status": "complete", "dpi": dpi});
            records.push(record);
        }
        std::fs::write(manifest, serde_json::to_string_pretty(&manifest_value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::write(&provenance_path, serde_json::to_string_pretty(&provenance).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        eprintln!("{}/{} {} -> {} pages {} recognized {} lines {} in {:.0}s", n + 1, chosen.len().min(limit), &source.sha256[..12], &sha[..12],
            pages.len(), recognized, lines, started.elapsed().as_secs_f64());
    }
    Ok(())
}

fn inputs(gold: &Path, manifest: &Path) -> Result<(), String> {
    let all = sources(gold, manifest)?;
    let destination = inputs_dir(gold);
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
                    legalpdf::gold_structure_inputs(&pdf, extraction, &readings, std::env::var_os("STRUCTURE_GOLD_FRESH").is_some())
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
                Some(&|a: &legalpdf::ExtractedPdf, b: &legalpdf::ExtractedPdf| {
                    let read = |e: &legalpdf::ExtractedPdf| e.pages.iter()
                        .flat_map(|p| p.lines.iter().map(|l| (l.id.clone(), l.text.clone()))).collect::<Vec<_>>();
                    read(a) == read(b)
                }),
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
            },
                None,
            )?
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
        &inputs_dir(gold)
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

/// Per document, each piece's labels from a tagger's predictions file: {sha256, ids, labels}, ids
/// naming pieces (line@offset) and each label [region, start, document, reference, heading level,
/// marker, resumed row], the row being that of the piece it resumes, or -1.
fn label_file(path: Option<&str>) -> Result<Option<BTreeMap<String, HashMap<String, labels::Label>>>, String> {
    let Some(path) = path else { return Ok(None) };
    let text = std::fs::read_to_string(local(path)).map_err(|e| format!("{path}: {e}"))?;
    let mut found = BTreeMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let row: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        let sha = row["sha256"].as_str().ok_or("Labels row without sha256")?.to_owned();
        let ids = row["ids"].as_array().ok_or("Labels row without ids")?;
        let rows = row["labels"].as_array().ok_or("Labels row without labels")?;
        let mut per_piece = HashMap::new();
        for (id, label) in ids.iter().zip(rows) {
            let field = |k: usize| label[k].as_u64().unwrap_or(0) as usize;
            let pointer = |k: usize| label.get(k).and_then(Value::as_i64).filter(|&row| row >= 0)
                .and_then(|row| ids.get(row as usize)).and_then(Value::as_str).map(str::to_owned);
            per_piece.insert(id.as_str().unwrap_or_default().to_owned(), labels::Label {
                region: field(0), start: field(1), document: field(2) == 1, reference: field(3) == 1, level: field(4),
                marker: field(5) == 1, continues: pointer(6),
            });
        }
        found.insert(sha, per_piece);
    }
    Ok(Some(found))
}

/// A tagger's labels decoded over a frame's own pieces.
fn decode_labels(frame: &state::State, per_piece: &HashMap<String, labels::Label>, sha256: &str) -> Result<state::State, String> {
    let pieces = labels::pieces(frame);
    let found: Vec<labels::Label> = pieces.iter().map(|p| per_piece.get(&labels::anchor(frame, p)).cloned().unwrap_or_default()).collect();
    state::projected(&labels::decode(frame, &pieces, &found, sha256))
}

/// A tagger's labels for one document, decoded over the replayed parser and scored like a parse.
fn grade_labels(gold: &Path, source: &Source, per_piece: &HashMap<String, labels::Label>) -> Result<Graded, String> {
    let expected: state::Gold = read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz")).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let (structure, pages) = candidate(gold, source, &expected, false, None)?;
    let parsed_at = Instant::now();
    let decoded = decode_labels(&state::parsed(&structure, &pages)?, per_piece, &source.sha256)?;
    let score = score::compare(&state::projected(&expected)?, &decoded)?;
    Ok(Graded { score, parse_ms: (parsed_at - started).as_secs_f64() * 1e3, score_ms: parsed_at.elapsed().as_secs_f64() * 1e3 })
}

/// The engine's tagger over one document: the parse replayed from the cached extraction, re-labelled
/// by the model and decoded by the hierarchy rule, scored like a parse. One session serves every
/// document in turn.
fn grade_tagged(gold: &Path, source: &Source, tagger: &Mutex<legal_structure_tagger::onnx::Tagger>) -> Result<Graded, String> {
    let expected: state::Gold = read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz")).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let extracted: legalpdf::ExtractedPdf = read_gzip_json(&inputs_dir(gold).join(format!("{}.json.gz", source.sha256)))
        .map_err(|e| format!("{}: {e}", source.sha256))?;
    let mut pages = Vec::new();
    let document = legalpdf::gold_structure_document(extracted, &source.sha256, Some(&mut pages)).map_err(|e| format!("{}: {e}", source.sha256))?;
    let parsed_at = Instant::now();
    // The product's path: the graph re-labelled in place, then read as any parse is.
    let mut structure = document.structure().clone();
    tagger.lock().map_err(|_| "tagger poisoned".to_owned())?.retag(&mut structure, &pages, &source.sha256, true)?;
    let tagged_at = Instant::now();
    let boxes: Vec<state::ExtractionPage> = pages.iter().map(|p| state::ExtractionPage {
        width: p.width, height: p.height, lines: p.lines.iter().map(|l| (l.id.clone(), l.bbox)).collect(),
    }).collect();
    let score = score::compare(&state::projected(&expected)?, &state::parsed(&structure, &boxes)?)?;
    Ok(Graded { score, parse_ms: (tagged_at - started).as_secs_f64() * 1e3, score_ms: tagged_at.elapsed().as_secs_f64() * 1e3 })
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

fn totals_json(rows: &[&Value]) -> Value {
    Value::Object(pooled(rows).into_iter().map(|(name, m)| {
        let p = if m.predicted > 0 { m.correct as f64 / m.predicted as f64 } else { 1.0 };
        let r = if m.expected > 0 { m.correct as f64 / m.expected as f64 } else { 1.0 };
        (name, json!({"expected": m.expected, "predicted": m.predicted, "correct": m.correct, "precision": p, "recall": r, "f1": m.f1()}))
    }).collect())
}

/// The layers the apps read, first and by name; every other layer follows.
const KEY_LAYERS: [(&str, &str); 11] = [
    ("units_heading", "headings"),
    ("markers_text", "numbered paragraphs, sections"),
    ("units_text", "paragraphs"),
    ("units_list_item", "list items"),
    ("markers_list_item", "list markers"),
    ("note_references", "footnote references"),
    ("note", "footnote pairs"),
    ("hierarchy_parent", "parents"),
    ("order", "reading order"),
    ("coverage", "text coverage"),
    ("transcription", "transcription (characters matched)"),
];

fn table(title: &str, totals: &BTreeMap<String, score::Metric>) {
    println!("
{title}");
    println!(
        "{:34} {:>8} {:>8} {:>6} {:>6} {:>6}",
        "layer", "exp", "pred", "P", "R", "F1"
    );
    let row = |name: &str, m: &score::Metric| {
        let p = if m.predicted > 0 { m.correct as f64 / m.predicted as f64 } else { 1.0 };
        let r = if m.expected > 0 { m.correct as f64 / m.expected as f64 } else { 1.0 };
        println!("{name:34} {:8} {:8} {p:6.3} {r:6.3} {:6.3}", m.expected, m.predicted, m.f1());
    };
    for (layer, label) in KEY_LAYERS {
        if let Some(m) = totals.get(layer) {
            row(&format!("{label} [{layer}]"), m);
        }
    }
    println!("{:34} {:>8}", "  other layers", "");
    for (name, m) in totals {
        if !KEY_LAYERS.iter().any(|(layer, _)| layer == name) {
            row(name, m);
        }
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
    delta_table("against the earlier summary", &common);
    let main: Vec<(&Value, &Value)> = common.into_iter()
        .filter(|(b, a)| b["yardstick"] == "main" && a["yardstick"] == "main").collect();
    if !main.is_empty() {
        delta_table("against the earlier summary / yardstick=main", &main);
    }
}

fn delta_table(title: &str, common: &[(&Value, &Value)]) {
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
        "\n{title}: {} runs in common",
        common.len()
    );
    println!(
        "{:22} {:>9} {:>7} {:>7}   {:>6} {:>6}",
        "layer", "F1 before", "after", "delta", "better", "worse"
    );
    for (name, m) in &pooled_after {
        let (mut better, mut worse) = (0, 0);
        for (b, a) in common {
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
    let labelled = label_file(value("--labels").as_deref())?;
    // --tagger DIR runs the engine's own tagger (tagger.onnx + tagger.json) over every document;
    // --onnx-runtime names the ONNX Runtime library (else LEGALPDF_ONNX_RUNTIME).
    let tagger = match value("--tagger") {
        Some(dir) => {
            let runtime = value("--onnx-runtime").or_else(|| std::env::var("LEGALPDF_ONNX_RUNTIME").ok())
                .ok_or("--tagger needs --onnx-runtime PATH or LEGALPDF_ONNX_RUNTIME")?;
            legal_pdf_core::init_ort_runtime(Path::new(&runtime), None).map_err(|e| format!("ONNX Runtime: {e}"))?;
            Some(Mutex::new(legal_structure_tagger::onnx::Tagger::load(Path::new(&dir), 4)?))
        }
        None => None,
    };
    let split = value("--split");
    let mut groups = Vec::new();
    for (n, option) in options.iter().enumerate().filter(|(_, o)| *o == "--group") {
        let (field, value) = options.get(n + 1).and_then(|v| v.split_once('='))
            .filter(|(field, value)| GROUP_FIELDS.contains(field) && !value.is_empty())
            .ok_or_else(|| format!("{option} requires FIELD=VALUE; fields: {}", GROUP_FIELDS.join(", ")))?;
        groups.push((field, value));
    }
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
        .filter(|s| labelled.is_none() || labelled.as_ref().is_some_and(|l| l.contains_key(&s.sha256)))
        .filter(|s| groups.iter().all(|(field, value)| s.groups[*field] == *value))
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
        let began = Instant::now();
        let result = match (&labelled, &tagger) {
            (_, Some(tagger)) => grade_tagged(gold, source, tagger),
            (Some(labelled), None) => grade_labels(gold, source, &labelled[&source.sha256]),
            (None, None) => grade_one(gold, source, exports, selected.get(&source.sha256)),
        };
        if began.elapsed().as_secs() >= 10 {
            eprintln!("slow: {} took {:.0}s", source.sha256, began.elapsed().as_secs_f64());
        }
        result
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
                // Transcription stands beside the structure layers: gold characters the parser's
                // text reproduces, so recognition quality is read on its own row.
                let mut metrics = s.metrics.clone();
                metrics.insert("transcription", score::Metric {
                    expected: s.text.characters, predicted: s.text.characters, correct: s.text.matched_characters,
                });
                rows.push(json!({
                    "run": format!("v4/{}", source.sha256), "source_sha256": source.sha256, "mode": source.mode, "split": source.split,
                    "language_layout": source.groups["language_layout"], "genre_group": source.groups["genre_group"],
                    "country": source.groups["country"], "yardstick": source.groups["yardstick"], "label_source": source.groups["label_source"],
                    "parse_ms": graded.parse_ms.round(),
                    "alignment": s.alignment,
                    "text": s.text, "metrics": metrics_json(&metrics),
                }));
            }
            Err(error) => {
                errors.push(json!({"run": format!("v4/{}", source.sha256), "error": error}))
            }
        }
    }
    let refs: Vec<&Value> = rows.iter().collect();
    let totals = totals_json(&refs);
    let mut totals_by = Map::new();
    let mut splits: Vec<&str> = rows.iter().filter_map(|r| r["split"].as_str()).collect();
    splits.sort_unstable();
    splits.dedup();
    splits.sort_by_key(|s| match *s { "train" => 0, "development" => 1, "test" => 2, _ => 3 });
    for split in splits {
        let chosen: Vec<&Value> = rows.iter().filter(|r| r["split"] == split).collect();
        table(&format!("{split}: {} documents", chosen.len()), &pooled(&chosen));
        let mut fields = Map::new();
        for field in ["yardstick", "language_layout", "genre_group"] {
            let mut grouped: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
            for row in &chosen {
                if field == "genre_group" && row["yardstick"] != "main" {
                    continue;
                }
                grouped.entry(row[field].as_str().unwrap_or("unknown")).or_default().push(row);
            }
            let mut values = Map::new();
            for (value, members) in grouped {
                let scope = if field == "genre_group" { " / yardstick=main" } else { "" };
                table(&format!("{split}{scope} / {field}={value}: {} documents", members.len()), &pooled(&members));
                values.insert(value.to_owned(), totals_json(&members));
            }
            fields.insert(field.to_owned(), Value::Object(values));
        }
        totals_by.insert(split.to_owned(), Value::Object(fields));
    }
    let summary = json!({
        "source": if inventory.is_some() { "candidates" } else if exports { "exports" } else { "replay" },
        "candidates": inventory, "elapsed_seconds": elapsed, "runs": rows.len() + errors.len(), "errors": errors,
        "totals": totals, "totals_by": totals_by, "per_run": rows,
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

/// The tier-1 tagger's training rows: train and development documents, never test.
fn rows(gold: &Path, manifest: &Path, out: &Path) -> Result<(), String> {
    let all: Vec<Source> = sources(gold, manifest)?.into_iter().filter(|s| s.split != "test").collect();
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    std::fs::write(out.join("features.json"), serde_json::to_string(&rows::FEATURES[..]).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let weight = |s: &Source| std::fs::metadata(inputs_dir(gold).join(format!("{}.json.gz", s.sha256))).map_or(0, |m| m.len());
    let results = parallel(&all, weight, |source| -> Result<String, String> {
        let expected: state::Gold = read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz")).map_err(|e| e.to_string())?;
        let extracted: legalpdf::ExtractedPdf = read_gzip_json(&inputs_dir(gold).join(format!("{}.json.gz", source.sha256)))
            .map_err(|e| format!("{}: {e}", source.sha256))?;
        let mut pages = Vec::new();
        let document = legalpdf::gold_structure_document(extracted, &source.sha256, Some(&mut pages)).map_err(|e| format!("{}: {e}", source.sha256))?;
        let boxes: Vec<state::ExtractionPage> = pages.iter().map(|p| state::ExtractionPage {
            width: p.width, height: p.height, lines: p.lines.iter().map(|l| (l.id.clone(), l.bbox)).collect(),
        }).collect();
        let candidate = state::parsed(document.structure(), &boxes)?;
        let reference = state::projected(&expected)?;
        let parsed_regions = labels::parsed_regions(&candidate);
        let (pieces, tier0) = labels::labels(&candidate, &|p| parsed_regions.of(p))?;
        let gold_regions = labels::gold_regions(&expected, &reference);
        let (gold_pieces, wanted) = labels::labels(&reference, &|p| gold_regions.of(p))?;
        let alignment = alignment::align(&reference, &candidate)?;
        let carried = labels::carry(&reference, &gold_pieces, &wanted, &candidate, &pieces, &alignment);
        let mut row = rows::document(&pages, &candidate, &pieces, &tier0, &carried);
        row["sha256"] = json!(source.sha256);
        row["split"] = json!(source.split);
        row["mode"] = json!(source.mode);
        Ok(serde_json::to_string(&row).map_err(|e| e.to_string())?)
    });
    let mut files: BTreeMap<String, std::io::BufWriter<std::fs::File>> = BTreeMap::new();
    let mut failed = 0;
    for (source, result) in all.iter().zip(results) {
        match result {
            Ok(line) => {
                use std::io::Write;
                let file = match files.entry(source.split.clone()) {
                    std::collections::btree_map::Entry::Occupied(e) => e.into_mut(),
                    std::collections::btree_map::Entry::Vacant(e) => e.insert(std::io::BufWriter::new(
                        std::fs::File::create(out.join(format!("rows-{}.jsonl", source.split))).map_err(|e| e.to_string())?)),
                };
                writeln!(file, "{line}").map_err(|e| e.to_string())?;
            }
            Err(error) => {
                failed += 1;
                eprintln!("ERROR {error}");
            }
        }
    }
    eprintln!("{} documents, {failed} failed, in {:.1}s; features: {}", all.len(), started.elapsed().as_secs_f64(), rows::FEATURES.join(","));
    Ok(())
}

/// Diagnostic: the note pairer over one document's replayed pages, its markers beside each line.
fn pairing(gold: &Path, manifest: &Path, prefix: &str, options: &[String]) -> Result<(), String> {
    use legal_structure::LayoutAnalysis;
    let source = sources(gold, manifest)?.into_iter().find(|s| s.sha256.starts_with(prefix)).ok_or("No such gold")?;
    let extracted: legalpdf::ExtractedPdf = read_gzip_json(&inputs_dir(gold).join(format!("{}.json.gz", source.sha256)))
        .map_err(|e| format!("{}: {e}", source.sha256))?;
    let mut pages = Vec::new();
    legalpdf::gold_structure_document(extracted, &source.sha256, Some(&mut pages)).map_err(|e| e.to_string())?;
    let output = legal_structure::STRUCTURE_ANALYSIS.pair_footnotes(&pages, &BTreeMap::new(), true);
    let audit = output.pairing_audit.ok_or("No pairing audit")?;
    println!("{}", serde_json::to_string(&audit.pairing_summary).map_err(|e| e.to_string())?);
    let range = options.first().and_then(|r| r.split_once('-')).and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)));
    let mut by_line: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for marker in &audit.markers {
        let line = marker["line_id"].as_str().unwrap_or_default().to_owned();
        by_line.entry(line).or_default().push(format!("{}:{}", marker["role"].as_str().unwrap_or("?"), marker["note_id"]));
    }
    for page in &pages {
        if range.is_some_and(|(a, b)| page.number < a || page.number > b) {
            continue;
        }
        for line in &page.lines {
            let marks = by_line.get(&line.id).map(|m| m.join(",")).unwrap_or_default();
            let text: String = line.text.chars().take(70).collect();
            println!("p{} {:>10} {:>9} {}{:<14} | {text}", page.number, line.region_type, line.note_region_mode,
                if line.exclude_from_body { "X " } else { "  " }, marks);
        }
    }
    Ok(())
}

/// The gold against itself through the scorer (must be 1.0 everywhere), and the gold's own labels
/// decoded over the gold's own lines, order, markers and notes (any shortfall is the label
/// encoding or the decoder, never the gold): `selfcheck GOLD MANIFEST self|labels`.
fn selfcheck(gold: &Path, manifest: &Path, mode: &str, options: &[String]) -> Result<(), String> {
    let value = |name: &str| options.iter().position(|o| o == name).and_then(|n| options.get(n + 1)).cloned();
    let split = value("--split");
    let all: Vec<Source> = sources(gold, manifest)?.into_iter()
        .filter(|s| split.as_deref().map_or(s.split != "test", |want| s.split == want)).collect();
    let results = parallel(&all, |_| 0, |source| -> Result<score::Score, String> {
        let expected: state::Gold = read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz")).map_err(|e| e.to_string())?;
        let reference = state::projected(&expected)?;
        let candidate = match mode {
            "self" => state::projected(&expected)?,
            _ => roundtrip(&expected, &reference)?,
        };
        score::compare(&reference, &candidate)
    });
    let mut totals: BTreeMap<&str, score::Metric> = BTreeMap::new();
    let mut errors = 0;
    for (source, result) in all.iter().zip(&results) {
        match result {
            Ok(score) => for (name, m) in &score.metrics { totals.entry(name).or_default().add(m); },
            Err(error) => { errors += 1; eprintln!("ERROR {} {error}", &source.sha256[..12]); }
        }
    }
    println!("{mode}: {} documents, {errors} errors", all.len());
    for (name, m) in totals {
        println!("{name:22} {:8} {:8} {:8} {:.4}", m.expected, m.predicted, m.correct, m.f1());
    }
    // The documents losing most on each named layer: missed plus spurious items.
    for layer in value("--worst").map(|l| l.split(',').map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default() {
        let mut lost: Vec<(usize, &str)> = all.iter().zip(&results).filter_map(|(source, result)| {
            let m = result.as_ref().ok()?.metrics.get(layer.as_str())?;
            let lost = m.expected + m.predicted - 2 * m.correct;
            (lost > 0).then_some((lost, source.sha256.as_str()))
        }).collect();
        lost.sort_by(|a, b| b.cmp(a));
        let total: usize = lost.iter().map(|l| l.0).sum();
        println!("{layer}: {total} lost in {} documents; worst {}", lost.len(),
            lost.iter().take(8).map(|(n, sha)| format!("{}:{n}", &sha[..12])).collect::<Vec<_>>().join(" "));
    }
    Ok(())
}

/// The gold's own labels decoded over the gold's own lines, order, markers and notes.
fn roundtrip(expected: &state::Gold, reference: &state::State) -> Result<state::State, String> {
    let regions = labels::gold_regions(expected, reference);
    let (pieces, found) = labels::labels(reference, &|p| regions.of(p))?;
    state::projected(&labels::decode(reference, &pieces, &found, &expected.source_sha256))
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
    if options.iter().any(|o| o == "--tree") {
        // The parser's own node tree: kind, role, grammar, label and the start of its text.
        let text: Vec<u16> = structure.text.encode_utf16().collect();
        let parents: HashMap<&str, &str> = structure.nodes.iter()
            .filter_map(|n| n.parent_id.as_deref().map(|p| (n.id.as_str(), p))).collect();
        for node in structure.nodes.iter().filter(|n| n.kind != legal_structure_model::NodeKind::Page) {
            let (mut depth, mut at) = (0, node.id.as_str());
            while let Some(p) = parents.get(at) { depth += 1; at = p; }
            let range = node.heading_range.as_ref().unwrap_or(&node.range);
            let end = range.end.min(range.start + 70).min(text.len());
            let snippet = String::from_utf16_lossy(&text[range.start.min(end)..end]).replace('\n', " / ");
            println!("{}{:?} {:?} {} {} [{}] {}..{} {} {snippet:?}", "  ".repeat(depth), node.kind, node.role,
                node.grammar.as_deref().unwrap_or("-"), node.label.as_deref().unwrap_or("-"),
                node.line_ids.first().map(String::as_str).unwrap_or("-"), node.range.start, node.range.end, node.origin_id);
        }
    }
    let mut candidate_state = state::parsed(&structure, &pages)?;
    if options.iter().any(|o| o == "--roundtrip") {
        candidate_state = roundtrip(&expected, &state::projected(&expected)?)?;
    }
    // --tagger DIR: the engine's tagger over the replayed parse, read back as the product reads it.
    if let Some(dir) = value("--tagger") {
        let runtime = value("--onnx-runtime").or_else(|| std::env::var("LEGALPDF_ONNX_RUNTIME").ok()).ok_or("--tagger needs --onnx-runtime PATH")?;
        legal_pdf_core::init_ort_runtime(Path::new(&runtime), None).map_err(|e| format!("ONNX Runtime: {e}"))?;
        let mut tagger = legal_structure_tagger::onnx::Tagger::load(Path::new(&dir), 4)?;
        let extracted: legalpdf::ExtractedPdf = read_gzip_json(&inputs_dir(gold).join(format!("{}.json.gz", source.sha256))).map_err(|e| format!("{}: {e}", source.sha256))?;
        let mut pages = Vec::new();
        let document = legalpdf::gold_structure_document(extracted, &source.sha256, Some(&mut pages)).map_err(|e| format!("{}: {e}", source.sha256))?;
        let mut structure = document.structure().clone();
        tagger.retag(&mut structure, &pages, &source.sha256, true)?;
        let boxes: Vec<state::ExtractionPage> = pages.iter().map(|p| state::ExtractionPage {
            width: p.width, height: p.height, lines: p.lines.iter().map(|l| (l.id.clone(), l.bbox)).collect(),
        }).collect();
        candidate_state = state::parsed(&structure, &boxes)?;
    }
    if let Some(labelled) = label_file(value("--labels").as_deref())? {
        let per_piece = labelled.get(&source.sha256).ok_or("No labels for this source")?;
        candidate_state = decode_labels(&candidate_state, per_piece, &source.sha256)?;
    }
    let text = score::explain(
        &state::projected(&expected)?,
        &candidate_state,
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
        [command, gold, manifest, options @ ..] if command == "synthesize" => {
            synthesize(Path::new(gold), Path::new(manifest), options)
        }
        [command, gold, manifest] if command == "inputs" => {
            inputs(Path::new(gold), Path::new(manifest))
        }
        [command, gold, manifest, out] if command == "paragraph-data" => {
            paragraph_data::export(Path::new(gold), Path::new(manifest), Path::new(out))
        }
        [command, gold, manifest, mode, options @ ..] if command == "selfcheck" => {
            selfcheck(Path::new(gold), Path::new(manifest), mode, options)
        }
        [command, gold, manifest, out] if command == "rows" => {
            rows(Path::new(gold), Path::new(manifest), Path::new(out))
        }
        [command, gold, manifest, prefix, options @ ..] if command == "pairing" => {
            pairing(Path::new(gold), Path::new(manifest), prefix, options)
        }
        [command, gold, manifest, prefix, options @ ..] if command == "explain" => {
            explain(Path::new(gold), Path::new(manifest), prefix, options)
        }
        _ => Err(
            "usage: structure-gold inputs|grade|rows|explain GOLD_DIR MANIFEST [SHA|OUT_DIR] [options]".into(),
        ),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
