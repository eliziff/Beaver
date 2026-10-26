//! Recognize frozen page crops; this executable never opens PDFs or runs a detector.
use legal_pdf_ocr::{IndraBackend, IndraOcr, IndraOptions};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Instant};

#[derive(Deserialize)]
struct Page {
    image: PathBuf,
    trace: PathBuf,
    output: PathBuf,
    image_sha256: String,
    trace_sha256: String,
}

fn read(path: &PathBuf) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    Ok(std::fs::read(path)?)
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if !(3..=4).contains(&args.len()) || args.get(3).is_some_and(|s| s != "margin") {
        return Err("usage: crop-ab JOBS.json MODEL_PACK RUNTIME_DLL [margin]".into());
    }
    let white_margin_ab = args.len() == 4;
    let jobs: Vec<Page> = serde_json::from_slice(&std::fs::read(&args[0])?)?;
    let mut reader = IndraOcr::new(&IndraOptions {
        model_pack: Some(args[1].clone().into()),
        runtime: Some(args[2].clone().into()),
        backend: Some(IndraBackend::Cpu),
        workers: 1,
        threads: 1,
        layout_workers: 1,
        batch_size: 16,
        ..Default::default()
    })?;
    for job in jobs {
        let began = Instant::now();
        let trace = read(&job.trace)?;
        if hash(&read(&job.image)?) != job.image_sha256 || hash(&trace) != job.trace_sha256 {
            return Err("Frozen input hash changed".into());
        }
        let trace: Value = serde_json::from_slice(&trace)?;
        let mut result = reader.attribution_crop_ab(
            &job.image,
            &trace,
            &job.output.join("review"),
            white_margin_ab,
        )?;
        result["seconds"] = json!(began.elapsed().as_secs_f64());
        std::fs::write(
            job.output.join("readings.json"),
            serde_json::to_vec_pretty(&result)?,
        )?;
        println!(
            "{}",
            json!({"page":job.trace.parent().unwrap().file_name().unwrap().to_string_lossy(),"seconds":began.elapsed().as_secs_f64(),"changed_inputs":result["lines"].as_array().unwrap().iter().filter(|l|l["pixels_changed"]==true).count()})
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
