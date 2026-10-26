//! Grade fixed gold against explicit cached predictions or a replay of the structure stage.
//!
//!   structure-gold inputs GOLD_DIR MANIFEST    each gold's PDF read as a parse of this build reads it,
//!       through the product's caches under GOLD_DIR/parsed, into GOLD_DIR/inputs/<build identity>/;
//!       the gold is aligned to whatever lines this build reads, never chosen by them
//!   structure-gold synthesize GOLD_DIR MANIFEST --model-pack DIR --runtime DLL [--dpi N] [--limit N] [--genre GROUP] [--only SHA_PREFIX] [--keep-pdf DIR] [--rendered DIR] [--inputs-only]
//!       scans made of the main train split's digital golds: rendered, degraded, recognized; gold copied
//!                                              recognized into it: GOLD_DIR/inputs/<sha>.json.gz
//!   structure-gold grade GOLD_DIR MANIFEST [--candidates FILE] [--split S] [--runs PREFIX..]
//!                        [--group FIELD=VALUE]... [--out FILE] [--against FILE] [--show]
//!       replays the structure stage over this build's inputs and scores it; writes
//!       GOLD_DIR/score/grade.json unless --out names another file. Totals are pooled per split; test is left out unless asked.
//!       --candidates reads the existing OCR cache manifest (inputs: source_sha256, candidate),
//!       scores only its exports, and never selects them by gold line IDs.
//!       --labels FILE decodes a tagger's per-line labels ({sha256, ids, labels} rows) over the
//!       replayed parser, which supplies markers, references and note pairs, and scores them.
//!       --group FIELD=VALUE keeps matching manifest groups; repeat to require every match.
//!       --parts grades each document of a packet on its own (run v4/<sha>#k): the gold cut at its
//!       document starts, the parser replayed on the extraction's lines that align to that document.
//!   structure-gold rows GOLD_DIR MANIFEST OUT_DIR
//!       the tier-1 tagger's training rows, train and development only: each line's evidence
//!       with the replayed parser's labels and the gold's, one JSON document per line of
//!       OUT_DIR/rows-<split>.jsonl.
//!   structure-gold explain GOLD_DIR MANIFEST SHA_PREFIX [--candidates FILE] [--layers a,b] [--limit N]
//!       --tagger DIR [--pure]: the engine's tagger over the parse; --pure takes its notes, references and document starts too
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

/// The structure-stage inputs this build makes, under the identity of the code and models that make
/// them (`legalpdf::gold_inputs_identity`), so a build never grades another build's pages: in
/// STRUCTURE_GOLD_INPUTS where set, else the gold's own inputs/.
fn inputs_dir(gold: &Path) -> PathBuf {
    std::env::var_os("STRUCTURE_GOLD_INPUTS")
        .map_or_else(|| gold.join("inputs"), PathBuf::from)
        .join(legalpdf::gold_inputs_identity())
}

/// Run `work` over the sources on every core, longest first, keeping each result in place.
fn parallel<T: Send>(
    sources: &[Source],
    weight: impl Fn(&Source) -> u64,
    work: impl Fn(&Source) -> T + Sync,
) -> Vec<T> {
    let mut order: Vec<usize> = (0..sources.len()).collect();
    order.sort_by_key(|&n| std::cmp::Reverse(weight(&sources[n])));
    // STRUCTURE_GOLD_THREADS caps the documents graded at once (a shared machine's memory).
    let threads = std::env::var("STRUCTURE_GOLD_THREADS").ok().and_then(|v| v.parse::<usize>().ok()).filter(|n| *n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(8, |n| n.get()));
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
    let only = value("--only");
    let keep = value("--keep-pdf").map(PathBuf::from);
    // --rendered DIR: synthetic PDFs rendered and degraded elsewhere (render_synthetic.py with pdfium, which draws
    // the text hayro leaves blank on some documents), one DIR/<sha>.pdf per original; originals without one wait.
    let rendered = value("--rendered").map(PathBuf::from);
    // --inputs-only: the recognized inputs alone, for every chosen original (done or not), into the
    // inputs directory; no gold copy, manifest row or provenance record. A second reading of the same
    // synthetic scans under other settings (LEGALPDF_PARAGRAPH_RECOVERY=off) for a paired comparison.
    let inputs_only = options.iter().any(|o| o == "--inputs-only");
    if let Some(dir) = &keep {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
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
            && s.groups.get("genre_group").is_none_or(|g| g != "transcript") && (inputs_only || !done.contains(&s.sha256))
            && genre.as_deref().is_none_or(|wanted| s.groups.get("genre_group").is_some_and(|g| g == wanted))
            && only.as_deref().is_none_or(|prefix| s.sha256.starts_with(prefix)))
        .collect();
    eprintln!("{} digital main train documents to synthesize ({} already done)", chosen.len(), done.len());
    let started = Instant::now();
    for (n, source) in chosen.iter().take(limit).enumerate() {
        let (synthetic, page_count) = if let Some(dir) = &rendered {
            let path = dir.join(format!("{}.pdf", source.sha256));
            match std::fs::read(&path) {
                Ok(bytes) => {
                    let count = legalpdf::render_gray_pages(&bytes, 10.0).len();
                    (bytes, count)
                }
                Err(_) => {
                    eprintln!("WAIT {}: no rendered PDF at {}", &source.sha256[..12], path.display());
                    continue;
                }
            }
        } else {
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
            let count = degraded.len();
            (image_pdf(&degraded, dpi), count)
        };
        let sha = format!("{:x}", sha2::Sha256::digest(&synthetic));
        if let Some(dir) = &keep {
            std::fs::write(dir.join(format!("{}-{}.pdf", &source.sha256[..12], &sha[..12])), &synthetic).map_err(|e| e.to_string())?;
        }
        let extracted = match legalpdf::gold_synthetic_inputs(&synthetic, &ocr, &mut runtime) {
            Ok(extracted) => extracted,
            Err(e) => {
                eprintln!("FAIL {}: {e}", source.sha256);
                continue;
            }
        };
        let recognized = extracted.pages.iter().filter(|p| p.source == "ocr").count();
        let lines: usize = extracted.pages.iter().map(|p| p.lines.len()).sum();
        let routing = format!("scanned {} routed {} unresolved {}", extracted.metadata.scanned_pages.len(),
            extracted.metadata.ocr_routed_pages.len(), extracted.metadata.pages_needing_ocr.len());
        let pages_len = page_count.max(extracted.pages.len());
        legal_pdf_core::write_gzip_json(&inputs_dir(gold).join(format!("{sha}.json.gz")), &extracted).map_err(|e| e.to_string())?;
        if inputs_only {
            eprintln!("{}/{} {} -> {} inputs only: pages {} recognized {} lines {} ({routing}) in {:.0}s", n + 1, chosen.len().min(limit), &source.sha256[..12], &sha[..12],
                pages_len, recognized, lines, started.elapsed().as_secs_f64());
            continue;
        }
        let folder = gold.join("v4").join(&sha);
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let mut copy: Value = read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz")).map_err(|e| e.to_string())?;
        copy["source_sha256"] = json!(sha);
        copy["mode"] = json!("ocr");
        copy["synthetic_of"] = json!(source.sha256);
        legal_pdf_core::write_gzip_json(&folder.join("gold.json.gz"), &copy).map_err(|e| e.to_string())?;
        let receipt = json!({
            "status": "complete", "source_sha256": sha, "mode": "ocr", "pages": pages_len, "model": "synthetic-scan",
            "synthetic_of": source.sha256, "dpi": dpi, "recognized_pages": recognized, "lines": lines,
            "finished_at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0),
        });
        std::fs::write(folder.join("receipt.json"), serde_json::to_string_pretty(&receipt).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let path = format!("synthetic/{sha}.pdf");
        if let Some(documents) = manifest_value["documents"].as_array_mut() {
            documents.push(json!({"path": path, "mode": "ocr", "split": "train", "sha256": sha, "pages": pages_len, "synthetic_of": source.sha256}));
        }
        if let Some(records) = provenance["records"].as_array_mut() {
            let mut record = records.iter().find(|r| r["sha256"] == source.sha256).cloned().unwrap_or_else(|| json!({"genre": "unknown", "country": "ca"}));
            record["sha256"] = json!(sha);
            record["mode"] = json!("ocr");
            record["split"] = json!("train");
            record["path"] = json!(path);
            record["pages"] = json!(pages_len);
            record["collection"] = json!("synthetic-scan-2026-10-23");
            record["synthetic_of"] = json!(source.sha256);
            record["label_source"] = json!("model");
            record["source_family"] = json!(format!("{} synthetic", record["source_family"].as_str().unwrap_or("unknown")));
            record["authoring"] = json!({"model": "synthetic-scan", "status": "complete", "dpi": dpi});
            records.push(record);
        }
        std::fs::write(manifest, serde_json::to_string_pretty(&manifest_value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::write(&provenance_path, serde_json::to_string_pretty(&provenance).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        eprintln!("{}/{} {} -> {} pages {} recognized {} lines {} ({routing}) in {:.0}s", n + 1, chosen.len().min(limit), &source.sha256[..12], &sha[..12],
            pages_len, recognized, lines, started.elapsed().as_secs_f64());
    }
    Ok(())
}

fn inputs(gold: &Path, manifest: &Path) -> Result<(), String> {
    let mut all = sources(gold, manifest)?;
    // STRUCTURE_GOLD_INPUTS_ONLY: comma-separated sha prefixes, for a slice.
    if let Ok(only) = std::env::var("STRUCTURE_GOLD_INPUTS_ONLY") {
        let prefixes: Vec<&str> = only.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
        all.retain(|s| prefixes.iter().any(|p| s.sha256.starts_with(p)));
    }
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
            let pdf =
                std::fs::read(&source.pdf).map_err(|e| format!("{}: {e}", source.pdf.display()))?;
            // The PDF read as a parse of this build reads it, through the product's caches beside the
            // gold; nothing is chosen by the gold, which the scorer aligns to whatever lines these are.
            let extracted = legalpdf::gold_structure_inputs(&pdf, &gold.join("parsed").join(&source.sha256))
                .map_err(|e| format!("{}: {e}", source.sha256))?;
            write_gzip_json(&target, &extracted).map_err(|e| e.to_string())
        },
    );
    let failed: Vec<&String> = results.iter().filter_map(|r| r.as_ref().err()).collect();
    for error in &failed {
        eprintln!("ERROR {error}");
    }
    eprintln!(
        "{} inputs, {} failed, in {:.1}s, in {}",
        all.len(),
        failed.len(),
        started.elapsed().as_secs_f64(),
        destination.display()
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

/// The parser's structure for a source: replayed from this build's inputs, or read from the export
/// a candidates inventory names.
fn candidate(
    gold: &Path,
    source: &Source,
    selected: Option<&PathBuf>,
) -> Result<DocumentStructure, String> {
    if let Some(path) = selected {
        let export = read_gzip_json::<Export>(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if export.extraction.source_sha256 != source.sha256 {
            return Err("Candidate extraction belongs to another PDF".into());
        }
        return Ok(export.structure);
    }
    let read_at = Instant::now();
    let extracted: legalpdf::ExtractedPdf = read_gzip_json(
        &inputs_dir(gold)
            .join(format!("{}.json.gz", source.sha256)),
    )
    .map_err(|e| format!("{}: {e}", source.sha256))?;
    let structure_at = Instant::now();
    let document = legalpdf::gold_structure_document(extracted, &source.sha256, None)
        .map_err(|e| format!("{}: {e}", source.sha256))?;
    if std::env::var_os("STRUCTURE_GOLD_TIMING").is_some() {
        eprintln!("timing	{}	inputs_ms	{:.1}	structure_ms	{:.1}", &source.sha256[..12],
            (structure_at - read_at).as_secs_f64() * 1e3, structure_at.elapsed().as_secs_f64() * 1e3);
    }
    Ok(document.structure().clone())
}

struct Graded {
    score: score::Score,
    parse_ms: f64,
    score_ms: f64,
}

static PARTS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// A packet's gold cut at its document starts: each part is the units from one start to the
/// next, the typed lines they hold (one no unit holds goes with the typed line before it), the
/// gold's lines those name (one none names goes with the line before it), and the note pairs
/// within it. Units and note pairs point into the typed lines, which corrections can split or
/// merge, so the typed lines are cut first. A gold of one document is its own only part. Beside
/// the parts, each gold line's parts: its own, and any other whose typed lines also name it.
fn gold_parts(gold: &Value) -> Result<(Vec<Value>, Vec<Vec<usize>>), String> {
    let units = gold["units"].as_array().ok_or("A gold without units")?;
    let lines = gold["lines"].as_array().ok_or("A gold without lines")?;
    let typed = gold["typed"].as_array().ok_or("A gold without typed lines")?;
    let starts: Vec<usize> = (0..units.len()).filter(|&u| u == 0 || units[u]["starts_document"] == true).collect();
    if starts.len() < 2 {
        return Ok((vec![gold.clone()], vec![vec![0]; lines.len()]));
    }
    let unit_typed = |u: usize| units[u]["lines"].as_array().into_iter().flatten().filter_map(Value::as_u64).map(|n| n as usize);
    let part_of_unit: Vec<usize> = (0..units.len()).map(|u| starts.partition_point(|&s| s <= u) - 1).collect();
    let carry = |held: Vec<Option<usize>>| {
        let mut parts: Vec<usize> = Vec::with_capacity(held.len());
        for found in held {
            parts.push(found.or(parts.last().copied()).unwrap_or(0));
        }
        parts
    };
    let mut held: Vec<Option<usize>> = vec![None; typed.len()];
    for u in 0..units.len() {
        for t in unit_typed(u).filter(|&t| t < typed.len()) {
            held[t].get_or_insert(part_of_unit[u]);
        }
    }
    let typed_part = carry(held);
    // The extraction's lines each typed line's spans name.
    let index: HashMap<&str, usize> = lines.iter().enumerate().filter_map(|(n, line)| Some((line["id"].as_str()?, n))).collect();
    let named = |t: usize| -> Vec<usize> {
        typed[t]["spans"].as_array().into_iter().flatten()
            .filter_map(|span| index.get(span["line_id"].as_str()?).copied()).collect()
    };
    let mut held: Vec<Option<usize>> = vec![None; lines.len()];
    for t in 0..typed.len() {
        for n in named(t) {
            held[n].get_or_insert(typed_part[t]);
        }
    }
    let line_part = carry(held);
    let mut line_parts: Vec<Vec<usize>> = line_part.iter().map(|&p| vec![p]).collect();
    let parts = (0..starts.len()).map(|p| {
        let kept_typed: Vec<usize> = (0..typed.len()).filter(|&t| typed_part[t] == p).collect();
        let new_typed: HashMap<usize, usize> = kept_typed.iter().enumerate().map(|(i, &t)| (t, i)).collect();
        // Its own lines, and any line of another part its typed lines also name.
        let named_here: HashSet<usize> = kept_typed.iter().flat_map(|&t| named(t)).collect();
        let kept_lines: Vec<usize> = (0..lines.len()).filter(|&n| line_part[n] == p || named_here.contains(&n)).collect();
        for &n in &kept_lines {
            if !line_parts[n].contains(&p) {
                line_parts[n].push(p);
            }
        }
        let mut new_unit = HashMap::new();
        let mut part_units = Vec::new();
        for u in (0..units.len()).filter(|&u| part_of_unit[u] == p) {
            let own: Vec<usize> = unit_typed(u).filter_map(|t| new_typed.get(&t).copied()).collect();
            if own.is_empty() {
                continue;
            }
            let mut unit = units[u].clone();
            unit["lines"] = json!(own);
            // The part is a document of its own: nothing in it starts another.
            unit["starts_document"] = json!(false);
            new_unit.insert(u, part_units.len());
            part_units.push(unit);
        }
        let notes: Vec<Value> = gold["notes"].as_array().into_iter().flatten().filter_map(|pair| {
            let line = new_typed.get(&(pair["line"].as_u64()? as usize))?;
            let note = pair["note"].as_u64().and_then(|n| new_unit.get(&(n as usize)));
            Some(json!({"line": line, "reference": pair["reference"], "note": note}))
        }).collect();
        let mut part = gold.clone();
        part["lines"] = json!(kept_lines.iter().map(|&n| &lines[n]).collect::<Vec<_>>());
        part["typed"] = json!(kept_typed.iter().map(|&t| &typed[t]).collect::<Vec<_>>());
        part["units"] = json!(part_units);
        part["notes"] = json!(notes);
        part
    }).collect();
    Ok((parts, line_parts))
}

/// Each extraction line's parts, read through the alignment of the extraction's lines, every one in
/// extraction order, to the whole gold: the parts of the gold line that holds most of the line's
/// characters. A line the gold erased (its correction empty: scan noise) is matched by the text it
/// was read as, which is still the page's. A line the alignment leaves unmatched takes the part of
/// the matched line before it on its page, else of the one after it on its page, else of the line
/// before it.
fn extraction_parts(
    extracted: &legalpdf::ExtractedPdf,
    whole_gold: &state::Gold,
    line_parts: &[Vec<usize>],
) -> Result<HashMap<String, Vec<usize>>, String> {
    let mut reference = state::projected(whole_gold)?;
    for (line, gold_line) in reference.lines.iter_mut().zip(&whole_gold.lines) {
        if gold_line.corrected.as_deref() == Some("") {
            line.text = gold_line.text.chars().collect();
        }
    }
    let lines: Vec<state::Line> = extracted.pages.iter().flat_map(|p| &p.lines).enumerate().map(|(k, line)| state::Line {
        id: line.id.clone(),
        page: line.page_index + 1,
        text: line.text.chars().collect(),
        spatial: (line.page_index + 1, k as f64, 0.0),
    }).collect();
    let whole = state::State {
        index: lines.iter().enumerate().map(|(n, l)| (l.id.clone(), n)).collect(),
        reading_order: (0..lines.len()).collect(),
        lines,
        span_rank: HashMap::new(),
        groups: Vec::new(),
        annotations: Vec::new(),
        continuations: Default::default(),
    };
    let alignment = alignment::align(&reference, &whole)?;
    let held: Vec<Option<&[usize]>> = alignment.mappings.iter().map(|mappings| {
        let mut characters: BTreeMap<usize, usize> = BTreeMap::new();
        for &(start, end, r, _, _) in mappings {
            *characters.entry(r).or_default() += end - start;
        }
        characters.iter().max_by_key(|(&r, &n)| (n, std::cmp::Reverse(r))).map(|(&r, _)| line_parts[r].as_slice())
    }).collect();
    let page = |c: usize| whole.lines[c].page;
    let mut parts = HashMap::new();
    let mut last = 0;
    for c in 0..whole.lines.len() {
        let found = match held[c] {
            Some(found) => found.to_vec(),
            None => {
                let before = (0..c).rev().take_while(|&k| page(k) == page(c)).find_map(|k| held[k]);
                let after = (c + 1..whole.lines.len()).take_while(|&k| page(k) == page(c)).find_map(|k| held[k]);
                vec![before.or(after).map_or(last, |found| found[0])]
            }
        };
        last = found[0];
        parts.insert(whole.lines[c].id.clone(), found);
    }
    Ok(parts)
}

/// The parser's input for one part: every page kept (per-page tables index pages by position),
/// holding only that part's lines and the regions over them.
fn input_part(mut extracted: legalpdf::ExtractedPdf, ids: &HashSet<&str>) -> legalpdf::ExtractedPdf {
    for page in &mut extracted.pages {
        page.lines.retain(|line| ids.contains(line.id.as_str()));
        page.regions.retain_mut(|region| {
            let had = !region.line_ids.is_empty();
            region.line_ids.retain(|id| ids.contains(id.as_str()));
            !had || !region.line_ids.is_empty()
        });
    }
    extracted
}

/// A source's grades: one, or with --parts one per document of a packet.
fn grade_one(
    gold: &Path,
    source: &Source,
    selected: Option<&PathBuf>,
) -> Result<Vec<(Option<usize>, Graded)>, String> {
    let gold_at = Instant::now();
    let raw: Value = read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz")).map_err(|e| e.to_string())?;
    let (parts, line_parts) = if PARTS.load(Ordering::Relaxed) && selected.is_none() { gold_parts(&raw)? } else { (vec![raw.clone()], Vec::new()) };
    if parts.len() == 1 {
        let expected: state::Gold = serde_json::from_value(parts.into_iter().next().unwrap_or_default()).map_err(|e| e.to_string())?;
        let started = Instant::now();
        let structure = candidate(gold, source, selected)?;
        return Ok(vec![(None, score_structure(source, &expected, &structure, gold_at, started)?)]);
    }
    // Each document of the packet is parsed on the extraction's lines that read as its gold's, which
    // the extraction aligned to the whole gold says.
    let started = Instant::now();
    let path = inputs_dir(gold).join(format!("{}.json.gz", source.sha256));
    let read = || -> Result<legalpdf::ExtractedPdf, String> { read_gzip_json(&path).map_err(|e| format!("{}: {e}", source.sha256)) };
    let whole_gold: state::Gold = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    let parts_of = extraction_parts(&read()?, &whole_gold, &line_parts)?;
    let mut graded = Vec::new();
    for (k, part) in parts.into_iter().enumerate() {
        let expected: state::Gold = serde_json::from_value(part).map_err(|e| format!("part {}: {e}", k + 1))?;
        let started = if k == 0 { started } else { Instant::now() };
        let ids: HashSet<&str> = parts_of.iter().filter(|(_, parts)| parts.contains(&k)).map(|(id, _)| id.as_str()).collect();
        let document = legalpdf::gold_structure_document(input_part(read()?, &ids), &source.sha256, None)
            .map_err(|e| format!("{} part {}: {e}", source.sha256, k + 1))?;
        graded.push((Some(k + 1), score_structure(source, &expected, document.structure(), gold_at, started)?));
    }
    Ok(graded)
}

fn score_structure(
    source: &Source,
    expected: &state::Gold,
    structure: &DocumentStructure,
    gold_at: Instant,
    started: Instant,
) -> Result<Graded, String> {
    let parsed_at = Instant::now();
    if structure
        .source_sha256
        .as_deref()
        .is_some_and(|sha| sha != expected.source_sha256)
    {
        return Err("Candidate belongs to another PDF".into());
    }
    let reference = state::projected(expected)?;
    let predicted = state::parsed(structure)?;
    // STRUCTURE_GOLD_BLOCKS_DIR: both frames' blocks (kind, lines, locator, marker) per document, for
    // censuses of how the parser's units differ from the gold's.
    if let Some(dir) = std::env::var_os("STRUCTURE_GOLD_BLOCKS_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        let dump = |state: &state::State| -> Vec<serde_json::Value> {
            state.groups.iter().map(|g| serde_json::json!({
                "kind": g.kind,
                "lines": g.line_ids,
                "spans": g.spans.iter().map(|s| serde_json::json!([s.line_id, s.start, s.end])).collect::<Vec<_>>(),
                "region": g.attributes.get("region"),
                "locator": g.attributes.get("locator_kind"),
                "marker": g.attributes.get("marker").map(|m| !m.is_null() && m.as_array().is_some_and(|a| !a.is_empty())).unwrap_or(false),
                "heading_level": g.attributes.get("heading_level"),
                "depth": g.attributes.get("depth"),
            })).collect()
        };
        let lines: Vec<serde_json::Value> = predicted.lines.iter().map(|l| serde_json::json!([l.id, l.page, l.text.iter().collect::<String>()])).collect();
        let fragments: Vec<&str> = structure.source_fragments.iter().map(|f| f.id.as_str()).collect();
        let _ = std::fs::write(dir.join(format!("{}.json", source.sha256)),
            serde_json::to_vec(&serde_json::json!({"gold": dump(&reference), "parser": dump(&predicted), "lines": lines, "fragments": fragments})).unwrap_or_default());
    }
    let compared_at = Instant::now();
    let score = score::compare(&reference, &predicted)?;
    if std::env::var_os("STRUCTURE_GOLD_TIMING").is_some() {
        eprintln!("timing	{}	parsed_ms	{:.1}	compare_ms	{:.1}	gold_ms	{:.1}", &source.sha256[..12],
            (compared_at - parsed_at).as_secs_f64() * 1e3, compared_at.elapsed().as_secs_f64() * 1e3,
            (started - gold_at).as_secs_f64() * 1e3);
    }
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
                marker: field(5) == 1, continues: pointer(6), depth: field(7),
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
    let structure = candidate(gold, source, None)?;
    let parsed_at = Instant::now();
    let decoded = decode_labels(&state::parsed(&structure)?, per_piece, &source.sha256)?;
    let score = score::compare(&state::projected(&expected)?, &decoded)?;
    Ok(Graded { score, parse_ms: (parsed_at - started).as_secs_f64() * 1e3, score_ms: parsed_at.elapsed().as_secs_f64() * 1e3 })
}

/// The engine's tagger over one document: the parse replayed from the cached extraction, re-labelled
/// by the model and decoded by the hierarchy rule, scored like a parse. One session serves every
/// document in turn.
/// --pure: the tagger's own notes, references and document starts (else tier 0's stay, "hybrid").
static PURE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn hybrid() -> bool {
    !PURE.load(std::sync::atomic::Ordering::Relaxed)
}

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
    tagger.lock().map_err(|_| "tagger poisoned".to_owned())?.retag(&mut structure, &pages, &source.sha256, hybrid())?;
    let tagged_at = Instant::now();
    let score = score::compare(&state::projected(&expected)?, &state::parsed(&structure)?)?;
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

/// The layers the apps read, first and by name; every other layer follows. A parse alone is read
/// for its body units as one kind (BODY_LAYERS); a tagger's for paragraphs, provisions and list
/// items apart.
const BODY_LAYERS: [(&str, &str); 2] = [("units_body", "body units"), ("markers_body", "body markers")];
const FINE_LAYERS: [&str; 6] = ["markers_text", "units_text", "markers_provision", "units_provision", "units_list_item", "markers_list_item"];
const KEY_LAYERS: [(&str, &str); 17] = [
    ("units_heading", "headings"),
    ("markers_text", "numbered paragraphs"),
    ("units_text", "paragraphs"),
    ("markers_provision", "numbered sections, clauses"),
    ("units_provision", "provisions"),
    ("units_list_item", "list items"),
    ("markers_list_item", "list markers"),
    ("note_references", "footnote references"),
    ("note", "footnote pairs"),
    ("heading_steps", "heading levels"),
    ("depth_steps", "body depths"),
    ("sequence_steps", "numbered sequences"),
    ("line_numbers", "transcript line numbers"),
    ("speakers", "speaker turns"),
    ("order", "reading order"),
    ("coverage", "text coverage"),
    ("transcription", "transcription (characters matched)"),
];

fn table(title: &str, totals: &BTreeMap<String, score::Metric>, fine: bool) {
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
    let shown: Vec<(&str, &str)> = if fine {
        KEY_LAYERS.into_iter().collect()
    } else {
        BODY_LAYERS.into_iter().chain(KEY_LAYERS.into_iter().filter(|(layer, _)| !FINE_LAYERS.contains(layer))).collect()
    };
    for (layer, label) in &shown {
        if let Some(m) = totals.get(*layer) {
            row(&format!("{label} [{layer}]"), m);
        }
    }
    println!("{:34} {:>8}", "  other layers", "");
    for (name, m) in totals {
        // The other reading's body layers stay out of the table (they remain in the summary).
        let other_reading = if fine { BODY_LAYERS.iter().any(|(layer, _)| layer == name) } else { FINE_LAYERS.contains(&name.as_str()) };
        if !shown.iter().any(|(layer, _)| layer == name) && !other_reading {
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
    // The citation grammar's tables and regexes compile on first use; pay that once, outside
    // any document's timing.
    legal_pdf_core::profile::measure("warmup.citations", || {
        let _ = legal_pdf_core::layout_analysis().citations("R. v. White, 2020 NSCA 33, [2008] 2 S.C.R. 3, para. 12.");
    });
    let flag = |name: &str| options.iter().any(|o| o == name);
    let value = |name: &str| {
        options
            .iter()
            .position(|o| o == name)
            .and_then(|n| options.get(n + 1))
            .cloned()
    };
    let inventory = value("--candidates");
    if flag("--candidates") && inventory.as_deref().is_none_or(|v| v.starts_with("--")) {
        return Err("--candidates requires an inventory file".into());
    }
    let selected = candidates(inventory.as_deref())?;
    let labelled = label_file(value("--labels").as_deref())?;
    // --tagger DIR runs the engine's own tagger (tagger.onnx + tagger.json) over every document;
    // --onnx-runtime names the ONNX Runtime library (else LEGALPDF_ONNX_RUNTIME).
    PURE.store(options.iter().any(|o| o == "--pure"), std::sync::atomic::Ordering::Relaxed);
    PARTS.store(flag("--parts"), Ordering::Relaxed);
    let tagger = match value("--tagger") {
        Some(dir) => {
            let runtime = value("--onnx-runtime").or_else(|| std::env::var("LEGALPDF_ONNX_RUNTIME").ok())
                .ok_or("--tagger needs --onnx-runtime PATH or LEGALPDF_ONNX_RUNTIME")?;
            legal_pdf_core::init_ort_runtime(Path::new(&runtime), None).map_err(|e| format!("ONNX Runtime: {e}"))?;
            Some(Mutex::new(legal_structure_tagger::onnx::Tagger::load(Path::new(&dir), 4)?))
        }
        None => None,
    };
    // A tagger's labels are read for paragraphs, provisions and list items apart; a parse alone, not.
    let fine = tagger.is_some() || labelled.is_some();
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
            (_, Some(tagger)) => grade_tagged(gold, source, tagger).map(|graded| vec![(None, graded)]),
            (Some(labelled), None) => grade_labels(gold, source, &labelled[&source.sha256]).map(|graded| vec![(None, graded)]),
            (None, None) => grade_one(gold, source, selected.get(&source.sha256)),
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
            Ok(parts) => for (part, graded) in parts {
                parse_ms += graded.parse_ms;
                score_ms += graded.score_ms;
                let s = &graded.score;
                // Transcription stands beside the structure layers: gold characters the parser's
                // text reproduces, so recognition quality is read on its own row.
                let mut metrics = s.metrics.clone();
                metrics.insert("transcription", score::Metric {
                    expected: s.text.characters, predicted: s.text.characters, correct: s.text.matched_characters,
                });
                let run = part.map_or_else(|| format!("v4/{}", source.sha256), |k| format!("v4/{}#{k}", source.sha256));
                rows.push(json!({
                    "run": run, "part": part, "source_sha256": source.sha256, "mode": source.mode, "split": source.split,
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
        table(&format!("{split}: {} documents", chosen.len()), &pooled(&chosen), fine);
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
                table(&format!("{split}{scope} / {field}={value}: {} documents", members.len()), &pooled(&members), fine);
                values.insert(value.to_owned(), totals_json(&members));
            }
            fields.insert(field.to_owned(), Value::Object(values));
        }
        totals_by.insert(split.to_owned(), Value::Object(fields));
    }
    let summary = json!({
        "source": if inventory.is_some() { "candidates" } else { "replay" },
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
        let candidate = state::parsed(document.structure())?;
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
/// `self`: the gold against itself; `labels`: the gold's own labels decoded; `agree --other STORE`:
/// the gold against the same document's gold authored independently into another store, which is
/// how far two authorings agree.
fn selfcheck(gold: &Path, manifest: &Path, mode: &str, options: &[String]) -> Result<(), String> {
    let value = |name: &str| options.iter().position(|o| o == name).and_then(|n| options.get(n + 1)).cloned();
    let split = value("--split");
    let other = value("--other").map(PathBuf::from);
    if mode == "agree" && other.is_none() {
        return Err("agree needs --other STORE".into());
    }
    let all: Vec<Source> = sources(gold, manifest)?.into_iter()
        .filter(|s| split.as_deref().map_or(s.split != "test", |want| s.split == want)).collect();
    let results = parallel(&all, |_| 0, |source| -> Result<score::Score, String> {
        let read = |store: &Path| -> Result<state::Gold, String> {
            read_gzip_json(&store.join("v4").join(&source.sha256).join("gold.json.gz")).map_err(|e| e.to_string())
        };
        let expected = read(gold)?;
        let reference = state::projected(&expected)?;
        let candidate = match mode {
            "self" => state::projected(&expected)?,
            "agree" => state::projected(&read(other.as_deref().expect("checked above"))?)?,
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
    let selected = candidates(inventory.as_deref())?;
    if inventory.is_some() && !selected.contains_key(&source.sha256) {
        return Err("No candidate selected for this source".into());
    }
    let structure = candidate(
        gold,
        &source,
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
    let mut candidate_state = state::parsed(&structure)?;
    if options.iter().any(|o| o == "--roundtrip") {
        candidate_state = roundtrip(&expected, &state::projected(&expected)?)?;
    }
    // --tagger DIR: the engine's tagger over the replayed parse, read back as the product reads it.
    if let Some(dir) = value("--tagger") {
        PURE.store(options.iter().any(|o| o == "--pure"), std::sync::atomic::Ordering::Relaxed);
        let runtime = value("--onnx-runtime").or_else(|| std::env::var("LEGALPDF_ONNX_RUNTIME").ok()).ok_or("--tagger needs --onnx-runtime PATH")?;
        legal_pdf_core::init_ort_runtime(Path::new(&runtime), None).map_err(|e| format!("ONNX Runtime: {e}"))?;
        let mut tagger = legal_structure_tagger::onnx::Tagger::load(Path::new(&dir), 4)?;
        let extracted: legalpdf::ExtractedPdf = read_gzip_json(&inputs_dir(gold).join(format!("{}.json.gz", source.sha256))).map_err(|e| format!("{}: {e}", source.sha256))?;
        let mut pages = Vec::new();
        let document = legalpdf::gold_structure_document(extracted, &source.sha256, Some(&mut pages)).map_err(|e| format!("{}: {e}", source.sha256))?;
        let mut structure = document.structure().clone();
        // --labels-out FILE: the engine's own per-piece labels, in the trainer's predictions format, so
        // they can be set beside a predictions file piece by piece.
        if let Some(path) = value("--labels-out") {
            let frame = state::parsed(&structure)?;
            let regions = labels::parsed_regions(&frame);
            let (pieces, tier0) = labels::labels(&frame, &|p| regions.of(p))?;
            let predicted = tagger.predict(&pages, &frame, &pieces, &tier0, hybrid())?;
            let row_of: HashMap<String, usize> = pieces.iter().enumerate().map(|(k, p)| (labels::anchor(&frame, p), k)).collect();
            let ids: Vec<String> = pieces.iter().map(|p| labels::anchor(&frame, p)).collect();
            let rows: Vec<Vec<i64>> = predicted.iter().map(|l| vec![l.region as i64, l.start as i64, i64::from(l.document), i64::from(l.reference),
                l.level as i64, i64::from(l.marker), l.continues.as_deref().and_then(|a| row_of.get(a)).map_or(-1, |&r| r as i64), l.depth as i64]).collect();
            std::fs::write(&path, serde_json::to_string(&json!({"sha256": source.sha256, "ids": ids, "labels": rows})).map_err(|e| e.to_string())? + "
").map_err(|e| e.to_string())?;
            eprintln!("engine labels for {} pieces -> {path}", pieces.len());
        }
        // --units-out FILE: the decoded units (region, typed spans) beside the blocks the composition makes
        // of the re-labelled graph (native_id, spans), unit by unit, to see where the two frames part.
        let units_out = value("--units-out");
        let decoded = units_out.as_ref().map(|_| {
            state::parsed(&structure).and_then(|frame| {
                let regions = labels::parsed_regions(&frame);
                let (pieces, tier0) = labels::labels(&frame, &|p| regions.of(p))?;
                let predicted = tagger.predict(&pages, &frame, &pieces, &tier0, hybrid())?;
                Ok(labels::decode(&frame, &pieces, &predicted, &source.sha256))
            })
        }).transpose()?;
        tagger.retag(&mut structure, &pages, &source.sha256, hybrid())?;
        candidate_state = state::parsed(&structure)?;
        if let (Some(path), Some(gold)) = (units_out, decoded) {
            let units: Vec<Value> = gold.units.iter().enumerate().map(|(u, unit)| json!({
                "unit": u, "node": format!("tag-{:06}", u + 1), "region": gold.typed[unit.lines[0]].region,
                "spans": unit.lines.iter().flat_map(|&t| gold.typed[t].spans.iter().map(|s| format!("{}[{}:{}]", s.line_id, s.start, s.end))).collect::<Vec<_>>(),
            })).collect();
            let blocks: Vec<Value> = candidate_state.groups.iter().map(|g| json!({
                "native_id": g.attributes.get("native_id").cloned().unwrap_or(Value::Null), "kind": g.kind,
                "spans": g.spans.iter().map(|s| format!("{}[{}:{}]", s.line_id, s.start, s.end)).collect::<Vec<_>>(),
            })).collect();
            std::fs::write(&path, serde_json::to_string_pretty(&json!({"units": units, "blocks": blocks})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            eprintln!("{} decoded units, {} composition blocks -> {path}", gold.units.len(), candidate_state.groups.len());
        }
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
    legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
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
