//! page-evidence: what each page of a sample of journal PDFs tells of its number (`legalpdf::page_evidence`: its folio as
//! the structure stage reads it, the PDF's own label, an opening page's lines), read once as the product reads each PDF,
//! for `page-map-score` (legal-pdf-pages) to score the page map on without reading a PDF again.
//!
//!   page-evidence KEY OUT [--sample N] [--seed S] [--threads T] [--cache DIR]
//!
//! KEY is JSON lines {id, pdf, map}; the sample is the first N by a hash of the seed and each id. Writes OUT/evidence.jsonl
//! ({id, pages: [...]} a line, or {id, error}), an article already there not read again; a line on stderr per article.
//! The readings are cached in OUT/cache, or DIR. Where the environment names a recognizer (LEGALPDF_INDRA_MODEL_PACK and
//! LEGALPDF_ONNXRUNTIME), a page whose head and foot print no folio is read again there (`page_evidence_read`).
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

fn evidence(pdf: &PathBuf, cache: &PathBuf, ocr: Option<&mut legalpdf::OcrProvider>) -> Result<Value, String> {
    let bytes = fs::read(pdf).map_err(|e| format!("{}: {e}", pdf.display()))?;
    let identity = sha256(&bytes);
    let extracted = legalpdf::gold_structure_inputs(&bytes, &cache.join(&identity)).map_err(|e| e.to_string())?;
    let document = legalpdf::gold_structure_document(extracted, &identity, None).map_err(|e| e.to_string())?;
    Ok(match ocr {
        Some(ocr) => json!(legalpdf::page_evidence_read(&document, &bytes, ocr).map_err(|e| e.to_string())?),
        None => json!(legalpdf::page_evidence(&document)),
    })
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
    let mut articles: Vec<(i64, PathBuf)> = BufReader::new(fs::File::open(key).expect("KEY")).lines().map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter_map(|row| Some((row["id"].as_i64()?, PathBuf::from(row["pdf"].as_str()?))))
        .collect();
    let seed: u64 = value("--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
    articles.sort_by_key(|(id, _)| sha256(format!("{seed}:{id}").as_bytes()));
    if let Some(n) = value("--sample").and_then(|n| n.parse::<usize>().ok()) {
        articles.truncate(n);
    }
    let path = out.join("evidence.jsonl");
    let done: HashSet<i64> = fs::read_to_string(&path).unwrap_or_default().lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok()?.get("id")?.as_i64()).collect();
    articles.retain(|(id, _)| !done.contains(id));
    let writer = Mutex::new(fs::OpenOptions::new().create(true).append(true).open(&path).expect("evidence.jsonl"));
    let threads: usize = value("--threads").and_then(|n| n.parse().ok()).unwrap_or(4);
    let (next, finished, started) = (AtomicUsize::new(0), AtomicUsize::new(0), Instant::now());
    let total = articles.len();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
              // each worker reads heads and feet again with its own recognizer, where the environment names one
              let mut ocr = (std::env::var_os("LEGALPDF_INDRA_MODEL_PACK").is_some() && std::env::var_os("LEGALPDF_ONNXRUNTIME").is_some())
                  .then(|| legalpdf::OcrProvider::new(&legalpdf::OcrOptions::Indra(legalpdf::IndraOptions::default())).expect("OCR"));
              loop {
                let Some((id, pdf)) = articles.get(next.fetch_add(1, Ordering::SeqCst)) else { break };
                let begun = Instant::now();
                let row = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| evidence(pdf, &cache, ocr.as_mut()))) {
                    Ok(Ok(pages)) => json!({"id": id, "pages": pages}),
                    Ok(Err(error)) => json!({"id": id, "error": error}),
                    Err(_) => json!({"id": id, "error": "panicked"}),
                };
                let _ = writeln!(writer.lock().unwrap(), "{row}");
                let n = finished.fetch_add(1, Ordering::SeqCst) + 1;
                eprintln!("{n}/{total} {id} {:.2}s ({:.0}s in)", begun.elapsed().as_secs_f64(), started.elapsed().as_secs_f64());
              }
            });
        }
    });
    eprintln!("{total} read in {:.0} s -> {}", started.elapsed().as_secs_f64(), path.display());
}
