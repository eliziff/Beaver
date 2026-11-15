//! Where the aligner's data lives, and the gold store's file conventions: sorted compact JSON, gzip without a timestamp,
//! written atomically.
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
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

/// Where the PDFs' readings are: the structure grader's inputs (`<sha>.pack.gz`, the product's extraction of the PDF), so a PDF
/// is read once for the alignment and the grader both, and the gold's lines are the lines the grader and the training read.
/// The grader's folder: STRUCTURE_GOLD_INPUTS (else gold-inputs/ in the data home), the one extraction cache the engine
/// keeps each PDF's finished extraction in, under the identity of the extraction (`readings`), and its recognition.
pub fn readings_root() -> PathBuf {
    std::env::var_os("STRUCTURE_GOLD_INPUTS").map_or_else(|| data_home().join("gold-inputs"), PathBuf::from)
}

pub fn readings() -> PathBuf {
    readings_root().join(legalpdf::gold_inputs_identity())
}

pub fn reading(sha: &str) -> PathBuf {
    legalpdf::gold_inputs_file(&readings_root(), sha)
}

/// Where a digital PDF's images stand on its pages (pdf::images), found once when the PDF is read and kept by its digest.
pub fn images_path(sha: &str) -> PathBuf {
    data_home().join("gold-images").join(format!("{sha}.json"))
}

/// A digital PDF's images: as kept, else found in the PDF and kept.
pub(crate) fn images(sha: &str, pdf: &Path) -> Vec<crate::pdf::PageImages> {
    let kept = images_path(sha);
    if let Some(found) = fs::read(&kept).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()) {
        return found;
    }
    let Ok(bytes) = fs::read(pdf) else { return Vec::new() };
    keep_images(sha, &bytes)
}

/// A PDF's images found in its bytes, and kept.
pub(crate) fn keep_images(sha: &str, pdf: &[u8]) -> Vec<crate::pdf::PageImages> {
    let found = crate::pdf::images_in(pdf, |_, _| true);
    keep_found_images(sha, &found);
    found
}

/// A PDF's images, as found, kept.
pub(crate) fn keep_found_images(sha: &str, found: &[crate::pdf::PageImages]) {
    if let Ok(body) = serde_json::to_vec(found) {
        let _ = write_atomic(&images_path(sha), &body);
    }
}

/// A pair's PDF: where the corpus holds it under the data home, else the path the pairing found it at.
pub fn pdf_of(pair: &Value) -> PathBuf {
    let sha = pair["sha256"].as_str().unwrap_or("");
    let known = Connection::open_with_flags(corpus_db(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()
        .and_then(|db| db.query_row("select path from files where sha256 = ?", [sha], |row| row.get::<_, String>(0)).ok())
        .map(|path| spelled(&data_home().join(path)))
        .filter(|path| path.is_file());
    known.unwrap_or_else(|| PathBuf::from(pair["path"].as_str().unwrap_or("")))
}

pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).unwrap().to_path_buf()
}

/// A path as the system spells it, whatever separators its parts came with.
pub fn spelled(path: &Path) -> PathBuf {
    path.components().collect()
}

pub fn store_root() -> PathBuf {
    std::env::var_os("OPENLEGAL_GOLD").map_or_else(|| spelled(&repo().join("benchmarks/local-data/gold")), PathBuf::from)
}

/// The pairs `--only` names: by a whole sha256 (looked up), by its start or by citation; every pair where it names none.
pub struct Only<'a> {
    whole: std::collections::HashSet<&'a str>,
    other: Vec<&'a str>,
}

impl<'a> Only<'a> {
    pub fn of(only: &'a [String]) -> Only<'a> {
        let (whole, other): (Vec<&str>, Vec<&str>) = only.iter().map(String::as_str).partition(|o| o.len() == 64);
        Only { whole: whole.into_iter().collect(), other }
    }

    pub fn takes(&self, sha: &str, citation: Option<&str>) -> bool {
        (self.whole.is_empty() && self.other.is_empty()) || self.whole.contains(sha) || self.other.iter().any(|o| sha.starts_with(o) || citation == Some(*o))
    }
}

/// Each part's time since the last, on stderr, where A2AJ_GOLD_TIMES is set.
pub struct Laps {
    timed: bool,
    clock: std::time::Instant,
}

impl Laps {
    pub fn new() -> Laps {
        Laps { timed: std::env::var_os("A2AJ_GOLD_TIMES").is_some(), clock: std::time::Instant::now() }
    }

    pub fn lap(&mut self, part: &str) {
        if self.timed {
            eprintln!("  {part:>12} {:7.1} ms", self.clock.elapsed().as_secs_f64() * 1000.0);
            self.clock = std::time::Instant::now();
        }
    }
}

/// The cores a step works on: A2AJ_GOLD_THREADS, else all of them.
pub fn cores() -> usize {
    std::env::var("A2AJ_GOLD_THREADS").ok().and_then(|n| n.parse().ok()).filter(|&n| n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
}

/// `work` over the items on every core, each thread with what `open` gives it (its own connections), the results in the
/// items' order; the first error stops the step.
pub fn on_cores_with<T: Sync, S, R: Send>(items: &[T], open: impl Fn() -> Result<S, String> + Sync, work: impl Fn(&T, &S) -> Result<R, String> + Sync) -> Result<Vec<R>, String> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results: std::sync::Mutex<Vec<Option<Result<R, String>>>> = std::sync::Mutex::new((0..items.len()).map(|_| None).collect());
    std::thread::scope(|scope| {
        for _ in 0..cores().min(items.len().max(1)) {
            scope.spawn(|| {
                let state = match open() {
                    Ok(state) => state,
                    Err(error) => {
                        results.lock().unwrap()[0] = Some(Err(error));
                        return;
                    }
                };
                loop {
                    let k = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(item) = items.get(k) else { break };
                    let done = work(item, &state);
                    results.lock().unwrap()[k] = Some(done);
                }
            });
        }
    });
    results.into_inner().unwrap().into_iter().map(|done| done.unwrap_or_else(|| Err("an item was not done".to_owned()))).collect()
}

/// [`on_cores_with`], each thread with its own read-only connection to A2AJ.
pub fn on_cores<T: Sync, R: Send>(items: &[T], work: impl Fn(&T, &Connection) -> Result<R, String> + Sync) -> Result<Vec<R>, String> {
    on_cores_with(items, crate::make::a2aj, work)
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

pub fn gunzip(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(raw.len() * 6);
    GzDecoder::new(raw).read_to_end(&mut out).map_err(|error| error.to_string())?;
    Ok(out)
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

/// A gold's bytes after a repair: its file as it stands, with only the members the repair changed written again, so that what
/// it left alone keeps its coordinates to the last digit (this crate's serde_json reads a float a digit off).
pub fn patched(path: &Path, before: &Value, after: &Value) -> Result<Vec<u8>, String> {
    let mut fields = crate::freeze::members(&read_bytes(path)?)?;
    for (name, value) in after.as_object().ok_or("a gold is an object")? {
        if before.get(name) != Some(value) {
            fields.insert(name.clone(), serde_json::to_vec(&sorted(value)).map_err(|error| error.to_string())?);
        }
    }
    let data = crate::freeze::object(&fields);
    let mut stream = GzEncoder::new(Vec::with_capacity(data.len() / 6), Compression::best());
    stream.write_all(&data).map_err(|error| error.to_string())?;
    stream.finish().map_err(|error| error.to_string())
}

impl Batch {
    pub fn add(&mut self, path: &Path, value: &Value) -> Result<String, String> {
        self.add_bytes(path, &encoded(path, value)?)
    }

    pub fn add_bytes(&mut self, path: &Path, body: &[u8]) -> Result<String, String> {
        let mut next = path.as_os_str().to_owned();
        next.push(".next");
        let next = PathBuf::from(next);
        fs::write(&next, body).map_err(|error| format!("{}: {error}", next.display()))?;
        self.files.push((next, path.to_path_buf()));
        Ok(hex(&Sha256::digest(body)))
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

pub fn corpus_writer() -> Result<Connection, String> {
    let db = Connection::open(corpus_db()).map_err(|error| error.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(600)).map_err(|error| error.to_string())?;
    Ok(db)
}

const STRUCTURE: &str = "gold/structure";
const SPLIT: &str = "gold/split";
// The dataset the store replaced: the split registry's origins and its archive.
const RETIRED: &str = "page-stream-segmentation/%";
const PARTITIONS: [&str; 3] = ["train", "development", "test"];

/// The store recorded in the corpus's registry: a gold_records row per source and kind, its runs in gold_runs, their files, with
/// hashes, in gold_artifacts. Every source must be in the corpus's files and have a partition.
pub fn register() -> Result<Value, String> {
    let root = store_root();
    let folders = sources(&root);
    let mut db = corpus_writer()?;
    // Immediate: the write lock taken first, waiting out another writer, where a read upgraded to a write would be refused
    // at once ("database is locked") while one writes.
    let done = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let run = |sql: &str, values: &[&dyn rusqlite::ToSql]| done.execute(sql, values).map(|_| ()).map_err(|e| format!("{sql}: {e}"));
    let mut pages: Vec<Option<i64>> = Vec::with_capacity(folders.len());
    {
        let mut query = done.prepare("select pages from files where sha256=?").map_err(|e| e.to_string())?;
        for sha in &folders {
            match query.query_row([sha], |row| row.get(0)) {
                Ok(count) => pages.push(count),
                Err(_) => return Err(format!("a gold source is not in the corpus file index: {sha}")),
            }
        }
    }
    if let Some(sha) = folders.iter().find(|sha| !PARTITIONS.iter().any(|name| source(&root, sha)["partition"] == *name)) {
        return Err(format!("a gold source has no partition in source.json: {sha}"));
    }
    for pattern in [RETIRED, STRUCTURE, SPLIT] {
        run("delete from gold_artifacts where run_id in (select run_id from gold_runs where dataset like ?)", &[&pattern])?;
        for table in ["gold_runs", "gold_records", "gold_memberships"] {
            run(&format!("delete from {table} where dataset like ?"), &[&pattern])?;
        }
    }
    let (mut structures, mut splits) = (0, 0);
    let spell = |path: &Path| path.to_string_lossy().into_owned();
    for (sha, pages) in folders.iter().zip(pages) {
        let folder = root.join(sha);
        for (k, gold_run) in structure_runs(&folder).iter().enumerate() {
            let name = gold_run.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let receipt = gold_run.join("receipt.json");
            let held = receipt.is_file();
            let authored = if held { read_json(&receipt)? } else { json!({}) };
            let run_id = format!("{STRUCTURE}:{sha}:{name}");
            let (receipt_path, receipt_digest) = if held { (Some(spell(&receipt)), Some(digest(&receipt)?)) } else { (None, None) };
            run("insert into gold_runs values (?,?,?,?,?,?,?,?)", params![run_id, STRUCTURE, sha, "complete", receipt_path, receipt_digest, authored["started_at"].as_str(), authored["finished_at"].as_str()])?;
            for (role, file) in [("gold", "gold.json.gz"), ("receipt", "receipt.json"), ("calls", "calls.jsonl.gz")] {
                let path = gold_run.join(file);
                if path.is_file() {
                    run("insert into gold_artifacts values (?,?,?,?)", params![run_id, role, spell(&path), digest(&path)?])?;
                }
            }
            if k == 0 {
                let status = if source(&root, sha).get("hold").is_some_and(|hold| !hold.is_null()) { "held" } else { "complete" };
                run("insert into gold_records values (?,?,?,?,?,?)", params![STRUCTURE, sha, authored["mode"].as_str(), pages, status, run_id])?;
                structures += 1;
            }
        }
        let split = folder.join("split.json");
        if split.is_file() {
            let run_id = format!("{SPLIT}:{sha}");
            run("insert into gold_runs values (?,?,?,?,?,?,?,?)", params![run_id, SPLIT, sha, "complete", None::<String>, None::<String>, None::<String>, None::<String>])?;
            run("insert into gold_artifacts values (?,?,?,?)", params![run_id, "gold", spell(&split), digest(&split)?])?;
            run("insert into gold_records values (?,?,?,?,?,?)", params![SPLIT, sha, None::<String>, pages, "complete", run_id])?;
            splits += 1;
        }
    }
    done.commit().map_err(|e| e.to_string())?;
    Ok(json!({STRUCTURE: structures, SPLIT: splits}))
}
