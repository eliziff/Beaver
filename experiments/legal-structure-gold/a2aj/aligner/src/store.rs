//! Where the aligner's data lives, and the gold store's file conventions: sorted compact JSON, gzip without a timestamp,
//! written atomically.
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const GOLD_RUN: &str = "a2aj-a"; // the store's run folder of this gold
pub const BATCH: &str = "a2aj"; // the sources' yardstick
pub const LABEL_SOURCE: &str = "a2aj-align";

pub fn data_home() -> PathBuf {
    match std::env::var_os("OPEN_LEGAL_DATA_HOME") {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("OpenLegalData"),
    }
}

pub fn a2aj_db() -> PathBuf {
    data_home().join("providers/a2aj/a2aj.sqlite")
}

pub fn corpus_db() -> PathBuf {
    data_home().join("corpus/corpus.sqlite")
}

pub fn listing() -> PathBuf {
    data_home().join("experiments/a2aj-structure/fix.nodes.jsonl")
}

pub fn work() -> PathBuf {
    std::env::var_os("A2AJ_GOLD_WORK").map_or_else(|| PathBuf::from("E:/OpenLegalData/a2aj-gold"), PathBuf::from)
}

pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap().to_path_buf()
}

pub fn store_root() -> PathBuf {
    std::env::var_os("OPENLEGAL_GOLD").map_or_else(|| repo().join("benchmarks/local-data/gold"), PathBuf::from)
}

/// A file's bytes, gunzipped where its name ends in .gz.
pub fn read_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let raw = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if path.extension().is_some_and(|extension| extension == "gz") {
        let mut out = Vec::with_capacity(raw.len() * 6);
        GzDecoder::new(raw.as_slice()).read_to_end(&mut out).map_err(|error| format!("{}: {error}", path.display()))?;
        return Ok(out);
    }
    Ok(raw)
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = read_bytes(path)?;
    let text = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    serde_json::from_slice(text).map_err(|error| format!("{}: {error}", path.display()))
}

fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::with_capacity(keys.len());
            for key in keys {
                out.insert(key.clone(), sorted(&map[key]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// As every gold artifact is written: sorted compact JSON and a newline, gzip without a timestamp where the name ends in
/// .gz, atomically.
pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    write_atomic(path, &encoded(path, value)?)
}

/// A value's bytes as they are written to `path`.
pub fn encoded(path: &Path, value: &Value) -> Result<Vec<u8>, String> {
    let mut data = serde_json::to_vec(&sorted(value)).map_err(|error| error.to_string())?;
    data.push(b'\n');
    if path.extension().is_some_and(|extension| extension == "gz") {
        let mut stream = GzEncoder::new(Vec::with_capacity(data.len() / 6), Compression::best());
        stream.write_all(&data).map_err(|error| error.to_string())?;
        return stream.finish().map_err(|error| error.to_string());
    }
    Ok(data)
}

/// A batch of files: each made first beside its place, under NAME.next, then all swapped in together, so no reader sees a
/// half-done batch for longer than the renames take.
#[derive(Default)]
pub struct Batch {
    files: Vec<(PathBuf, PathBuf)>,
}

impl Batch {
    pub fn add(&mut self, path: &Path, value: &Value) -> Result<String, String> {
        let body = encoded(path, value)?;
        let mut next = path.as_os_str().to_owned();
        next.push(".next");
        let next = PathBuf::from(next);
        fs::write(&next, &body).map_err(|error| format!("{}: {error}", next.display()))?;
        self.files.push((next, path.to_path_buf()));
        Ok(hex(&Sha256::digest(&body)))
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn swap(self) -> Result<(), String> {
        for (next, path) in self.files {
            fs::rename(&next, &path).map_err(|error| format!("{}: {error}", path.display()))?;
        }
        Ok(())
    }
}

pub fn write_atomic(path: &Path, body: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    fs::write(&temporary, body).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub fn digest(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(hex(&Sha256::digest(&bytes)))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The first 16 hexadecimal digits of a reading's digest, as a record keeps it.
pub fn read_digest(path: &Path) -> Result<String, String> {
    let mut whole = digest(path)?;
    whole.truncate(16);
    Ok(whole)
}

/// The source's structure gold runs, its current run (run "a") first.
pub fn structure_runs(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(folder.join("structure")) else { return Vec::new() };
    let mut runs: Vec<PathBuf> = entries.flatten().map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.contains('-')) && path.join("gold.json.gz").is_file())
        .collect();
    runs.sort_by_key(|path| {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        (name.split_once('-').map(|(_, run)| run != "a").unwrap_or(true), name)
    });
    runs
}

/// The sources of the gold store.
pub fn sources(root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<String> = entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit())).collect();
    out.sort();
    out
}

/// A source's source.json, or an empty object.
pub fn source(root: &Path, sha: &str) -> Value {
    let path = root.join(sha).join("source.json");
    if path.is_file() { read_json(&path).unwrap_or_else(|_| Value::Object(Map::new())) } else { Value::Object(Map::new()) }
}
