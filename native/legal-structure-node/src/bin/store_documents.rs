#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! Derives provider-text documents once and stores each structure, so a caller that reads the same documents again
//! takes them back whole (`deriveDocumentStructure` with `{ kind: "stored", structure }`) instead of deriving them.
//!
//!   store_documents REQUESTS.jsonl OUT_DIR [--threads N]
//!
//! Each request line is `{ "key": NAME, "input": <provider-text input> }`; each structure goes to `OUT_DIR/NAME.json`.
//! A name already stored is skipped.

use legal_structure::{provider_text_document_structure, ProviderTextInput};
use serde::Deserialize;
use std::error::Error;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Deserialize)]
struct Request {
    key: String,
    input: ProviderTextInput,
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (requests, out) = match args.as_slice() {
        [requests, out, ..] => (requests, PathBuf::from(out)),
        _ => return Err("usage: store_documents REQUESTS.jsonl OUT_DIR [--threads N]".into()),
    };
    let threads = args.iter().position(|arg| arg == "--threads")
        .and_then(|at| args.get(at + 1)?.parse().ok()).unwrap_or(4usize);
    fs::create_dir_all(&out)?;
    let mut pending = Vec::new();
    for line in BufReader::new(File::open(requests)?).lines() {
        let request: Request = serde_json::from_str(&line?)?;
        if !out.join(format!("{}.json", request.key)).exists() { pending.push(request); }
    }
    let next = AtomicUsize::new(0);
    let pending = pending.into_iter().map(Some).map(std::sync::Mutex::new).collect::<Vec<_>>();
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(slot) = pending.get(index) else { break };
                let Request { key, input } = slot.lock().unwrap().take().unwrap();
                match provider_text_document_structure(input) {
                    Ok(structure) => {
                        let path = out.join(format!("{key}.json"));
                        let partial = path.with_extension("json.partial");
                        let written = File::create(&partial).map_err(|error| error.to_string())
                            .and_then(|file| serde_json::to_writer(BufWriter::new(file), &structure)
                                .map_err(|error| error.to_string()))
                            .and_then(|()| fs::rename(&partial, &path).map_err(|error| error.to_string()));
                        if let Err(error) = written { eprintln!("{key}: {error}"); }
                    }
                    Err(error) => eprintln!("{key}: {error}"),
                }
            });
        }
    });
    eprintln!("{} stored", pending.len());
    Ok(())
}
