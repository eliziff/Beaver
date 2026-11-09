//! page-evidence: what each page of a sample of journal PDFs tells of its number (`legalpdf::page_evidence`: its folio as
//! the structure stage reads it, the PDF's own label, an opening page's lines), read once as the product reads each PDF,
//! for `page-map-score` (legal-pdf-pages) to score the page map on without reading a PDF again.
//!
//!   page-evidence KEY OUT [--sample N] [--seed S] [--threads T] [--cache DIR] [--no-reread]
//!
//! KEY is JSON lines {id, pdf, map}; the sample is the first N by a hash of the seed and each id. Writes OUT/evidence.jsonl
//! ({id, pages: [...]} a line, or {id, error}), an article already there not read again; a line on stderr per article.
//! The readings are cached in OUT/cache, or DIR, and beside each PDF's reading its base evidence and the bands read again
//! (`evidence`): a run after the first recognizes only bands it has not read. A scan is recognized whole only where the
//! environment names a recognizer (LEGALPDF_INDRA_MODEL_PACK and LEGALPDF_ONNXRUNTIME), as a parse does. The pages
//! `read_again` names are read again in their heads and feet by the engine's recognizer (legal-pdf-parser/runtime).
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

fn sha256(bytes: &[u8]) -> String {
    <sha2::Sha256 as sha2::Digest>::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A PDF's page evidence: its base (`legalpdf::page_evidence`, cached beside its reading as `page-evidence.v1.json`: the
/// structure stage runs once a PDF) with the pages `read_again` names read again in their heads and feet, each page's
/// bands cached as `bands/<page>.json` (the recognizer reads a band once).
/// Where each PDF's readings are kept: its SHA-256, by its path, size and modification time (`<cache>/pdf-index.jsonl`),
/// so that a PDF read before is not read again to find them.
struct Index {
    known: Mutex<std::collections::HashMap<(String, u64, u64), String>>,
    file: Mutex<fs::File>,
}

impl Index {
    fn open(cache: &PathBuf) -> Index {
        let path = cache.join("pdf-index.jsonl");
        let known = fs::read_to_string(&path).unwrap_or_default().lines().filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|row| Some(((row["path"].as_str()?.to_owned(), row["size"].as_u64()?, row["modified"].as_u64()?), row["sha256"].as_str()?.to_owned())))
            .collect();
        Index { known: Mutex::new(known), file: Mutex::new(fs::OpenOptions::new().create(true).append(true).open(&path).expect("pdf-index.jsonl")) }
    }

    /// The PDF's identity, its bytes where they had to be read for it.
    fn identity(&self, pdf: &PathBuf) -> Result<(String, Option<Vec<u8>>), String> {
        let meta = fs::metadata(pdf).map_err(|e| format!("{}: {e}", pdf.display()))?;
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
        let key = (pdf.display().to_string(), meta.len(), modified);
        if let Some(sha) = self.known.lock().unwrap().get(&key) {
            return Ok((sha.clone(), None));
        }
        let bytes = fs::read(pdf).map_err(|e| format!("{}: {e}", pdf.display()))?;
        let sha = sha256(&bytes);
        let _ = writeln!(self.file.lock().unwrap(), "{}", json!({"path": key.0, "size": key.1, "modified": key.2, "sha256": sha}));
        self.known.lock().unwrap().insert(key, sha.clone());
        Ok((sha, Some(bytes)))
    }
}

/// A PDF's page evidence: its base (`legalpdf::page_evidence`, cached beside its reading as `page-evidence.v1.json`: the
/// structure stage runs once a PDF) with the pages `read_again` names read again in their heads and feet (`bands_kept`:
/// the recognizer reads a band once). The PDF itself is read only for what its cache does not hold.
fn evidence(pdf: &PathBuf, cache: &PathBuf, index: &Index, ocr: Option<&mut legalpdf::OcrProvider>) -> Result<(Value, [f64; 2]), String> {
    let begun = Instant::now();
    let (sha, read) = index.identity(pdf)?;
    let mut bytes = read;
    let load = |bytes: &mut Option<Vec<u8>>| -> Result<Vec<u8>, String> {
        if bytes.is_none() {
            *bytes = Some(fs::read(pdf).map_err(|e| format!("{}: {e}", pdf.display()))?);
        }
        Ok(bytes.clone().unwrap())
    };
    let home = cache.join(&sha);
    let base_path = home.join("page-evidence.v1.json");
    let base: Vec<legalpdf::PageEvidence> = match fs::read(&base_path).ok().and_then(|cached| serde_json::from_slice(&cached).ok()) {
        Some(base) => base,
        None => {
            let pdf_bytes = load(&mut bytes)?;
            let extracted = legalpdf::gold_structure_inputs(&pdf_bytes, &home).map_err(|e| e.to_string())?;
            let document = legalpdf::gold_structure_document(extracted, &sha, None).map_err(|e| e.to_string())?;
            let base = legalpdf::page_evidence(&document);
            let _ = fs::create_dir_all(&home);
            let _ = fs::write(&base_path, serde_json::to_vec(&base).unwrap_or_default());
            base
        }
    };
    let based = begun.elapsed().as_secs_f64();
    let pages = match ocr {
        Some(ocr) => legalpdf::reread(base, &mut |indices| bands_kept(&home.join("bands"), &mut || load(&mut bytes), indices, ocr))?,
        None => base,
    };
    let all = begun.elapsed().as_secs_f64();
    Ok((json!(pages), [based, all - based]))
}

/// `legalpdf::read_bands`, each page's bands kept under `dir` (`<page>.json`) and read there when asked again: the
/// recognizer reads a band once.
fn bands_kept(dir: &std::path::Path, pdf: &mut dyn FnMut() -> Result<Vec<u8>, String>, indices: &[usize], ocr: &mut legalpdf::OcrProvider) -> Result<Vec<(usize, legalpdf::Bands)>, String> {
    let mut out = Vec::new();
    let mut missing = Vec::new();
    for &index in indices {
        match fs::read(dir.join(format!("{index}.json"))).ok().and_then(|kept| serde_json::from_slice(&kept).ok()) {
            Some(bands) => out.push((index, bands)),
            None => missing.push(index),
        }
    }
    if !missing.is_empty() {
        let _ = fs::create_dir_all(dir);
        for (index, bands) in legalpdf::read_bands(&pdf()?, &missing, ocr).map_err(|e| e.to_string())? {
            let _ = fs::write(dir.join(format!("{index}.json")), serde_json::to_vec(&bands).unwrap_or_default());
            out.push((index, bands));
        }
    }
    Ok(out)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |name: &str| args.iter().position(|arg| arg == name).and_then(|at| args.get(at + 1)).cloned();
    let (Some(key), Some(out)) = (args.first(), args.get(1)) else {
        eprintln!("page-evidence KEY OUT [--sample N] [--seed S] [--threads T]");
        std::process::exit(2);
    };
    let out = PathBuf::from(out);
    let cache = value("--cache").map(PathBuf::from).unwrap_or_else(|| out.join("cache"));
    fs::create_dir_all(&cache).expect("OUT");
    legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
    let index = Index::open(&cache);
    let mut articles: Vec<(Value, PathBuf)> = BufReader::new(fs::File::open(key).expect("KEY")).lines().map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(|row| Some((row["id"].clone(), PathBuf::from(row["pdf"].as_str()?))))
        .collect();
    let seed: u64 = value("--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
    articles.sort_by_key(|(id, _)| sha256(format!("{seed}:{id}").as_bytes()));
    if let Some(n) = value("--sample").and_then(|n| n.parse::<usize>().ok()) {
        articles.truncate(n);
    }
    let path = out.join("evidence.jsonl");
    let done: HashSet<String> = fs::read_to_string(&path).unwrap_or_default().lines()
        .filter_map(|line| Some(serde_json::from_str::<Value>(line).ok()?.get("id")?.to_string())).collect();
    articles.retain(|(id, _)| !done.contains(&id.to_string()));
    let writer = Mutex::new(fs::OpenOptions::new().create(true).append(true).open(&path).expect("evidence.jsonl"));
    let threads: usize = value("--threads").and_then(|n| n.parse().ok()).unwrap_or(4);
    let (next, finished, started) = (AtomicUsize::new(0), AtomicUsize::new(0), Instant::now());
    let total = articles.len();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
              // each worker reads heads and feet again with its own recognizer, the engine's (its runtime folder)
              let runtime = a2aj_gold::store::repo().join("legal-pdf-parser/runtime");
              let options = legalpdf::OcrOptions { model_pack: Some(runtime.join("indra")), runtime: Some(runtime.join("onnx/onnxruntime.dll")), ..Default::default() };
              let mut ocr = (runtime.join("indra/manifest.json").is_file() && !args.iter().any(|arg| arg == "--no-reread"))
                  .then(|| legalpdf::OcrProvider::new(&options).expect("OCR"));
              loop {
                let Some((id, pdf)) = articles.get(next.fetch_add(1, Ordering::SeqCst)) else { break };
                let begun = Instant::now();
                let mut phases = [0.0; 2];
                let row = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| evidence(pdf, &cache, &index, ocr.as_mut()))) {
                    Ok(Ok((pages, times))) => { phases = times; json!({"id": id, "pages": pages}) }
                    Ok(Err(error)) => json!({"id": id, "error": error}),
                    Err(_) => json!({"id": id, "error": "panicked"}),
                };
                let _ = writeln!(writer.lock().unwrap(), "{row}");
                let n = finished.fetch_add(1, Ordering::SeqCst) + 1;
                eprintln!("{n}/{total} {id} {:.2}s ({:.0}s in) base {:.2} reread {:.2}", begun.elapsed().as_secs_f64(), started.elapsed().as_secs_f64(), phases[0], phases[1]);
              }
            });
        }
    });
    eprintln!("{total} read in {:.0} s -> {}", started.elapsed().as_secs_f64(), path.display());
}
