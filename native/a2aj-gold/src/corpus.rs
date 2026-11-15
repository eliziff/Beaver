//! Every read pair without a current record aligned: one thread hands the pairs out in order, one writes the records, and
//! each core reads, checks and aligns between them. A record is current while this crate's code and the PDF's reading are the
//! ones that made it: the reading by its place (`reading_key`), the extraction's identity and the PDF, which fix what it holds.
use super::record::{record_of, CODE};
use super::store;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use regex::bytes::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

static STAMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""code": ?"([0-9a-f]+)", ?"read": ?"([0-9a-f]+)""#).unwrap());

/// The code and reading digest a record is stamped with: the first words of its file.
fn stamp(path: &Path) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut head = [0u8; 256];
    let mut stream = GzDecoder::new(fs::File::open(path).ok()?);
    let mut filled = 0;
    while filled < head.len() {
        match stream.read(&mut head[filled..]).ok()? {
            0 => break,
            n => filled += n,
        }
    }
    let found = STAMP.captures(&head[..filled])?;
    Some((found[1].to_vec(), found[2].to_vec()))
}

/// The reading a record was aligned from, by its place: its folder (the extraction's identity) and its name (the PDF's),
/// which fix what it holds however it is written down.
pub fn reading_key(file: &Path) -> String {
    let name = |path: Option<&Path>| path.and_then(Path::file_name).map_or_else(String::new, |name| name.to_string_lossy().into_owned());
    let place = format!("{}/{}", name(file.parent()), name(Some(file)));
    Sha256::digest(place.as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

struct Job {
    pair: Value,
    file: PathBuf,
    record: PathBuf,
}

struct Done {
    pair: Value,
    /// None: the record is current.
    outcome: Option<Result<(Vec<u8>, Value, std::collections::BTreeMap<String, u64>), String>>,
}

/// A job's reading, unless the record is current: read, hashed and unzipped on the worker's own core.
fn align_one(job: Job, db: &Connection) -> Done {
    let Job { pair, file, record } = job;
    // A2AJ_GOLD_TIMES set: each part's time, on stderr.
    let timed = std::env::var_os("A2AJ_GOLD_TIMES").is_some();
    let mut clock = Instant::now();
    let mut lap = |part: &str| if timed {
        eprintln!("  {part:>12} {:7.1} ms", clock.elapsed().as_secs_f64() * 1000.0);
        clock = Instant::now();
    };
    let digest = reading_key(&file);
    let stamped = stamp(&record);
    if stamped.as_ref().is_some_and(|(code, read)| code == CODE.as_str().as_bytes() && read == digest.as_bytes()) {
        return Done { pair, outcome: None };
    }
    lap("stamp");
    let compressed = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) => return Done { pair, outcome: Some(Err(format!("{}: {error}", file.display()))) },
    };
    lap("file");
    let mut reading = Vec::with_capacity(compressed.len() * 8);
    if let Err(error) = GzDecoder::new(compressed.as_slice()).read_to_end(&mut reading) {
        return Done { pair, outcome: Some(Err(format!("{}: {error}", file.display()))) };
    }
    drop(compressed);
    lap("gunzip");
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let made = record_of(&pair, &reading, digest, db)?;
        lap("record_of");
        let mut stream = GzEncoder::new(Vec::with_capacity(made.json.len() / 8), Compression::new(6));
        stream.write_all(&made.json).map_err(|error| error.to_string())?;
        let gz = stream.finish().map_err(|error| error.to_string())?;
        lap("gzip");
        Ok((gz, made.verdict, made.kinds))
    }))
    .unwrap_or_else(|panic| Err(panic.downcast_ref::<String>().cloned().unwrap_or_else(|| "panicked".to_owned())));
    Done { pair, outcome: Some(outcome) }
}

/// Align the pairs of WORK/pairs.jsonl (those `only` names, by the start of their sha256 or their citation) that have a
/// reading and no current record, at most `limit`. A pair that fails is reported and the run goes on.
pub fn align_all(work: &Path, a2aj: &Path, only: &[String], limit: Option<usize>, threads: Option<usize>) -> Result<Value, String> {
    let started = Instant::now();
    let takes = store::Only::of(only);
    let pairs = fs::read_to_string(work.join("pairs.jsonl")).map_err(|error| error.to_string())?;
    let chosen: Vec<Value> = pairs
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|pair| {
            let (sha, citation) = (pair["sha256"].as_str().unwrap_or(""), pair["citation"].as_str());
            takes.takes(sha, citation)
        })
        .collect();
    let records = work.join("records");
    fs::create_dir_all(&records).map_err(|error| error.to_string())?;
    let threads = threads.unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()));
    let (to_workers, from_reader) = sync_channel::<Job>(threads * 2);
    let (to_writer, from_workers) = sync_channel::<Done>(threads * 2);
    let from_reader = Mutex::new(from_reader);
    let (mut aligned, mut failed, mut current, mut aligning) = (0usize, 0usize, 0usize, Duration::ZERO);
    let mut writing = Duration::ZERO;
    let timed: Mutex<Duration> = Mutex::new(Duration::ZERO);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let mut taken = 0;
            for pair in chosen {
                let sha = pair["sha256"].as_str().unwrap_or("").to_owned();
                // a pair may name its reading (a bound volume's, shared by its decisions) instead of taking its own
                let file = pair["read"].as_str().map(PathBuf::from).unwrap_or_else(|| store::reading(&sha));
                if !file.is_file() {
                    continue;
                }
                let record = records.join(format!("{sha}.json.gz"));
                if to_workers.send(Job { pair, file, record }).is_err() {
                    break;
                }
                taken += 1;
                if limit.is_some_and(|limit| taken >= limit) {
                    break;
                }
            }
            drop(to_workers);
        });
        for _ in 0..threads {
            let (from_reader, to_writer, timed): (&Mutex<Receiver<Job>>, _, _) = (&from_reader, to_writer.clone(), &timed);
            scope.spawn(move || {
                let db = Connection::open_with_flags(a2aj, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX);
                let Ok(db) = db else { return };
                loop {
                    let next = from_reader.lock().unwrap().recv();
                    let Ok(job) = next else { break };
                    let begun = Instant::now();
                    let done = align_one(job, &db);
                    *timed.lock().unwrap() += begun.elapsed();
                    if to_writer.send(done).is_err() {
                        break;
                    }
                }
            });
        }
        drop(to_writer);
        let mut output = std::io::stdout();
        for done in from_workers {
            let citation = done.pair["citation"].as_str().unwrap_or("").to_owned();
            let sha = done.pair["sha256"].as_str().unwrap_or("").to_owned();
            match done.outcome {
                None => current += 1,
                Some(Ok((bytes, verdict, kinds))) => {
                    let begun = Instant::now();
                    let path = records.join(format!("{sha}.json.gz"));
                    let temporary = path.with_extension("tmp");
                    if let Err(error) = fs::write(&temporary, &bytes).and_then(|_| fs::rename(&temporary, &path)) {
                        failed += 1;
                        let _ = writeln!(output, "FAILED {citation}: {error}");
                        continue;
                    }
                    // (What the report counts of the record, kept by the record's digest as the report keeps it.)
                    let summary = json!({"key": store::hex(&Sha256::digest(&bytes)), "verdict": verdict.clone(), "code": CODE.as_str(), "kinds": kinds});
                    if let Ok(body) = serde_json::to_vec(&summary) {
                        let _ = store::write_atomic(&work.join("report-made").join(format!("{sha}.json")), &body);
                    }
                    writing += begun.elapsed();
                    aligned += 1;
                    let refused = verdict["refused"].as_str().map_or(String::new(), |why| format!(" REFUSED {why}"));
                    let _ = writeln!(output, "{aligned} {citation:<22} {:<11} {:>3}pp coverage {} {} unmatched {} unplaced {}{refused}",
                                     done.pair["mode"].as_str().unwrap_or(""), done.pair["pages"], verdict["coverage"], verdict["status"], verdict["unmatched"], verdict["unplaced"]);
                }
                Some(Err(error)) => {
                    failed += 1;
                    let _ = writeln!(output, "FAILED {citation}: {error}");
                }
            }
        }
    });
    aligning += *timed.lock().unwrap();
    Ok(json!({"aligned": aligned, "failed": failed, "current": current, "threads": threads, "seconds": started.elapsed().as_secs_f64(),
              "aligning_seconds": aligning.as_secs_f64(), "writing_seconds": writing.as_secs_f64()}))
}
