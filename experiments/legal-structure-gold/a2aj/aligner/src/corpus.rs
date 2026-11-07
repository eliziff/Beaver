//! Every read pair without a current record aligned: one thread reads the disk in order, one writes it, and each core
//! aligns between them. A record is current while this crate's code and the PDF's reading are the ones that made it.
use crate::record::{record_of, CODE};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use regex::bytes::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
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

fn digest_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

struct Job {
    pair: Value,
    reading: Vec<u8>,
    digest: String,
}

struct Done {
    pair: Value,
    outcome: Result<(Vec<u8>, Value), String>,
}

fn align_one(job: Job, db: &Connection) -> Done {
    let Job { pair, reading, digest } = job;
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let made = record_of(&pair, &reading, digest, db)?;
        let mut stream = GzEncoder::new(Vec::with_capacity(made.json.len() / 8), Compression::new(6));
        stream.write_all(&made.json).map_err(|error| error.to_string())?;
        Ok((stream.finish().map_err(|error| error.to_string())?, made.verdict))
    }))
    .unwrap_or_else(|panic| Err(panic.downcast_ref::<String>().cloned().unwrap_or_else(|| "panicked".to_owned())));
    Done { pair, outcome }
}

/// Align the pairs of WORK/pairs.jsonl (those `only` names, by the start of their sha256 or their citation) that have a
/// reading and no current record, at most `limit`. A pair that fails is reported and the run goes on.
pub fn align_all(work: &Path, a2aj: &Path, only: &[String], limit: Option<usize>, threads: Option<usize>) -> Result<Value, String> {
    let started = Instant::now();
    let pairs = fs::read_to_string(work.join("pairs.jsonl")).map_err(|error| error.to_string())?;
    let chosen: Vec<Value> = pairs
        .lines()
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|pair| {
            let (sha, citation) = (pair["sha256"].as_str().unwrap_or(""), pair["citation"].as_str());
            only.is_empty() || only.iter().any(|o| sha.starts_with(o.as_str()) || citation == Some(o.as_str()))
        })
        .collect();
    let (read_folder, records) = (work.join("read"), work.join("records"));
    fs::create_dir_all(&records).map_err(|error| error.to_string())?;
    let threads = threads.unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()));
    let (to_workers, from_reader) = sync_channel::<Job>(threads * 2);
    let (to_writer, from_workers) = sync_channel::<Done>(threads * 2);
    let from_reader = Mutex::new(from_reader);
    let (mut aligned, mut failed, mut aligning) = (0usize, 0usize, Duration::ZERO);
    let mut writing = Duration::ZERO;
    let timed: Mutex<Duration> = Mutex::new(Duration::ZERO);
    let read_time = std::thread::scope(|scope| {
        let reader = scope.spawn(|| {
            let reader_started = Instant::now();
            let mut taken = 0;
            for pair in chosen {
                let sha = pair["sha256"].as_str().unwrap_or("").to_owned();
                let file = read_folder.join(format!("{sha}.json"));
                if !file.is_file() {
                    continue;
                }
                let stamped = stamp(&records.join(format!("{sha}.json.gz")));
                let same_code = stamped.as_ref().is_some_and(|(code, _)| code == CODE.as_bytes());
                let Ok(reading) = fs::read(&file) else { continue };
                let digest = digest_of(&reading);
                if same_code && stamped.as_ref().is_some_and(|(_, read)| read == digest.as_bytes()) {
                    continue;
                }
                if to_workers.send(Job { pair, reading, digest }).is_err() {
                    break;
                }
                taken += 1;
                if limit.is_some_and(|limit| taken >= limit) {
                    break;
                }
            }
            drop(to_workers);
            reader_started.elapsed()
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
                Ok((bytes, verdict)) => {
                    let begun = Instant::now();
                    let path = records.join(format!("{sha}.json.gz"));
                    let temporary = path.with_extension("tmp");
                    if let Err(error) = fs::write(&temporary, &bytes).and_then(|_| fs::rename(&temporary, &path)) {
                        failed += 1;
                        let _ = writeln!(output, "FAILED {citation}: {error}");
                        continue;
                    }
                    writing += begun.elapsed();
                    aligned += 1;
                    let refused = verdict["refused"].as_str().map_or(String::new(), |why| format!(" REFUSED {why}"));
                    let _ = writeln!(output, "{aligned} {citation:<22} {:<11} {:>3}pp coverage {} {} unmatched {} unplaced {}{refused}",
                                     done.pair["mode"].as_str().unwrap_or(""), done.pair["pages"], verdict["coverage"], verdict["status"], verdict["unmatched"], verdict["unplaced"]);
                }
                Err(error) => {
                    failed += 1;
                    let _ = writeln!(output, "FAILED {citation}: {error}");
                }
            }
        }
        reader.join().unwrap_or(Duration::ZERO)
    });
    aligning += *timed.lock().unwrap();
    Ok(json!({"aligned": aligned, "failed": failed, "threads": threads, "seconds": started.elapsed().as_secs_f64(),
              "reading_seconds": read_time.as_secs_f64(), "aligning_seconds": aligning.as_secs_f64(), "writing_seconds": writing.as_secs_f64()}))
}
