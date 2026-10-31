//! legalpdf-read: PDFs read as the product reads them (`legalpdf::gold_structure_inputs`: the extraction, Indra
//! recognition where LEGALPDF_INDRA_MODEL_PACK and LEGALPDF_ONNXRUNTIME name it, the PP-DocLayout layout model where
//! LEGALPDF_PPDOC_MODEL_PACK does), each written as OUT/<sha256>.json. One PDF at a time; a PDF already written is
//! skipped, so a stopped run resumes, and recognition is cached under OUT/cache/<sha256>, so no page is read twice.
//!
//!   legalpdf-read LIST OUT    LIST: one `<sha256>\t<path>` line per PDF

#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]

use std::path::Path;
use std::time::Instant;

// The reader runs the native OCR and layout runtimes; the browser build has none.
#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn read(sha256: &str, pdf: &Path, out: &Path) -> Result<bool, String> {
    let target = out.join(format!("{sha256}.json"));
    if target.is_file() {
        return Ok(false);
    }
    let bytes = std::fs::read(pdf).map_err(|e| format!("{}: {e}", pdf.display()))?;
    let extracted = legalpdf::gold_structure_inputs(&bytes, &out.join("cache").join(sha256)).map_err(|e| e.to_string())?;
    let temporary = target.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&extracted).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [list, out] = args.as_slice() else {
        eprintln!("usage: legalpdf-read LIST OUT    (LIST: one `<sha256>\\t<path>` line per PDF)");
        std::process::exit(2);
    };
    legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
    let out = Path::new(out);
    let list = std::fs::read_to_string(list).unwrap_or_else(|e| panic!("{list}: {e}"));
    let pdfs: Vec<(&str, &str)> = list.lines().filter_map(|line| line.split_once('\t')).collect();
    std::fs::create_dir_all(out).unwrap_or_else(|e| panic!("{}: {e}", out.display()));
    let (mut read_count, mut failed) = (0, 0);
    for (n, (sha256, pdf)) in pdfs.iter().enumerate() {
        let started = Instant::now();
        match read(sha256, Path::new(pdf), out) {
            Ok(true) => {
                read_count += 1;
                eprintln!("{}/{} {sha256} {:.1}s", n + 1, pdfs.len(), started.elapsed().as_secs_f64());
            }
            Ok(false) => {}
            Err(error) => {
                failed += 1;
                eprintln!("{}/{} {sha256} FAILED {error}", n + 1, pdfs.len());
            }
        }
    }
    eprintln!("{read_count} read, {failed} failed, of {} -> {}", pdfs.len(), out.display());
}
