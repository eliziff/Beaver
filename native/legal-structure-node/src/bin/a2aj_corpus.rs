#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! The structure engine's reading of every document in Beaver's local A2AJ store (a2aj.sqlite), read
//! as production reads it, and what changed between two readings. Built with the addon, by the same
//! build: it reads each document's engine input as the engine does (legal_structure_features::a2aj).
//!
//!   a2aj-corpus run  --label NAME [--against NAME] [--kind cases|laws|all] [--lang en|fr] [--threads N] [--every N]
//!   a2aj-corpus diff BASE NEW [--examples N]
//!   a2aj-corpus show ID [--lang en|fr] [--text]
//!
//! A reading is `<out>/<label>.jsonl` (one record per document and language) with `<label>.summary.json`.
//! The store is `%LOCALAPPDATA%/OpenLegalData/providers/a2aj/a2aj.sqlite` unless `--store` names another;
//! readings go to `%LOCALAPPDATA%/OpenLegalData/experiments/a2aj-structure` unless `--out` names another.

use legal_structure_features::a2aj::{self, Document, Language, Source, StoreRow};
use legal_structure::{
    provider_text_document_structure, DocumentStructure, NodeKind, ProviderTextInput, ProviderTextSourceKind,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::hash::{DefaultHasher, Hasher};
use std::error::Error;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// What the census reads of a document: what the engine derives it from.
const COLUMNS: [&str; 14] = ["doc_type", "dataset", "citation_en", "citation_fr", "citation2_en", "citation2_fr",
    "name_en", "name_fr", "url_en", "url_fr", "unofficial_text_en", "unofficial_text_fr",
    "unofficial_sections_en", "unofficial_sections_fr"];

/// One engine input: a document in one language, read from its provisions or from its text.
struct Job {
    key: String,
    dataset: String,
    input: ProviderTextInput,
}

/// The inputs production derives from a document (legal_structure_features::a2aj's reading), in each language it has text in.
fn jobs(id: i64, row: &StoreRow) -> rusqlite::Result<Vec<Job>> {
    let document = Document::new(row, Source::Store);
    let doc_type = a2aj::doc_type(document.field("doc_type")?.as_deref().unwrap_or_default());
    let mut jobs = Vec::new();
    for language in [Language::En, Language::Fr] {
        if document.text_language(language)? != language { continue }
        let Some(read) = document.read(language, doc_type)? else { continue };
        let dataset = read.metadata.dataset.clone();
        let key = format!("{id}:{}", language.code());
        match read.inputs() {
            (sections, Some(text)) => {
                jobs.push(Job { key: format!("{key}:sections"), dataset: dataset.clone(), input: sections });
                jobs.push(Job { key: format!("{key}:text"), dataset, input: text });
            }
            (input, None) => jobs.push(Job { key, dataset, input }),
        }
    }
    Ok(jobs)
}
#[derive(Serialize, Deserialize, Default)]
struct Record {
    key: String,
    dataset: String,
    citation: String,
    /// The engine input's SHA-256 (text, citations, name and provisions), its first 16 hex digits: a change
    /// here is the corpus's, not the engine's.
    text: String,
    ms: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    counts: BTreeMap<String, usize>,
    /// A hash of every node as `kind label start-end parent` and every note as `note label body > references`.
    nodes: String,
    /// What `nodes` hashes, written beside the census (`<label>.nodes.jsonl`) so two readings compare
    /// node by node without reading the documents again.
    #[serde(skip)]
    listing: String,
}

/// Byte offsets of each UTF-16 unit, so the structure's offsets slice the text.
struct Units<'a> {
    text: &'a str,
    bytes: Vec<usize>,
}

impl<'a> Units<'a> {
    fn new(text: &'a str) -> Self {
        let mut bytes = Vec::with_capacity(text.len() + 1);
        for (byte, character) in text.char_indices() {
            bytes.extend(std::iter::repeat_n(byte, character.len_utf16()));
        }
        bytes.push(text.len());
        Self { text, bytes }
    }
    fn slice(&self, start: usize, end: usize) -> &'a str {
        let at = |unit: usize| self.bytes[unit.min(self.bytes.len() - 1)];
        &self.text[at(start)..at(end.max(start))]
    }
}

/// What the census counts beside the nodes: how a case's numbered paragraphs cover it, and witnesses read
/// from the text alone (a trailing note list, glued note calls) that the structure should account for.
fn case_counts(structure: &DocumentStructure, counts: &mut BTreeMap<String, usize>) {
    let units = Units::new(&structure.text);
    let length = units.bytes.len() - 1;
    let index = structure.nodes.iter().enumerate().map(|(at, node)| (node.id.as_str(), at)).collect::<HashMap<_, _>>();
    let under_paragraph = |mut at: usize| loop {
        let node = &structure.nodes[at];
        if node.kind == NodeKind::Paragraph { break true; }
        match node.parent_id.as_deref().and_then(|parent| index.get(parent)) { Some(parent) => at = *parent, None => break false }
    };
    let mut paragraphs = structure.nodes.iter()
        .filter(|node| node.kind == NodeKind::Paragraph && node.label.as_deref().is_some_and(|label| label.starts_with("par")))
        .map(|node| (node.range.start, node.range.end)).collect::<Vec<_>>();
    paragraphs.sort_unstable();
    let mut covered = structure.nodes.iter().filter(|node| node.kind != NodeKind::Page)
        .map(|node| (node.range.start, node.range.end)).collect::<Vec<_>>();
    covered.sort_unstable();
    let mut owned = structure.nodes.iter().enumerate().filter(|(at, _)| under_paragraph(*at))
        .map(|(_, node)| (node.range.start, node.range.end)).collect::<Vec<_>>();
    owned.sort_unstable();
    let inside = |ranges: &[(usize, usize)], at: usize| {
        let position = ranges.partition_point(|range| range.0 <= at);
        ranges[..position].iter().rev().take(64).any(|range| at < range.1)
    };
    // Lines in [start, end): those no node covers, and those opening with a bracketed number outside every paragraph.
    let mut lines = |start: usize, end: usize, uncovered: &str, quoted: Option<&str>| {
        let mut at = start;
        for line in units.slice(start, end).split_inclusive('\n') {
            let width = line.encode_utf16().count();
            let lead = line.len() - line.trim_start().len();
            let first = at + line[..lead].encode_utf16().count();
            let body = line.trim();
            if !body.is_empty() {
                if !inside(&covered, first) { *counts.entry(uncovered.to_owned()).or_default() += 1; }
                if let Some(name) = quoted {
                    if bracketed(body).is_some() && !inside(&owned, first) { *counts.entry(name.to_owned()).or_default() += 1; }
                }
            }
            at += width;
        }
    };
    if let (Some(first), Some(last)) = (paragraphs.first().copied(), paragraphs.last().copied()) {
        lines(0, first.0, "uncovered_front_lines", None);
        for pair in paragraphs.windows(2) {
            if pair[1].0 > pair[0].1 { lines(pair[0].1, pair[1].0, "uncovered_between_lines", Some("detached_bracket_lines")); }
        }
        lines(last.1, length, "uncovered_tail_lines", None);
        // A note list after the reasons: its first line "[1] …" or "Footnote 1", with no paragraph after it.
        let tail = units.slice(last.1, length);
        let notes = tail.lines().map(str::trim).skip_while(|line| bracketed(line) != Some(1) && *line != "Footnote 1")
            .filter(|line| bracketed(line).is_some() || line.starts_with("Footnote ")).count();
        if notes > 0 { counts.insert("witness_tail_note_lines".to_owned(), notes); }
    }
    // The count read short or not at all: lines after the last numbered paragraph opening with its next
    // numbers, and, where no paragraph is numbered, a count from 1 of five or more among line openings.
    let numbers = structure.nodes.iter().filter_map(|node| node.label.as_deref()?.strip_prefix("par")?.parse::<u32>().ok());
    match (numbers.max(), paragraphs.last()) {
        (Some(last), Some(&(_, end))) => {
            // Up to the note list, whose numbers run past the paragraphs' as often as not.
            let continuing = units.slice(end, length).lines()
                .take_while(|line| { let line = line.trim(); bracketed(line) != Some(1) && line != "Footnote 1" && line != "Footnotes" })
                .filter(|line| opening_number(line).is_some_and(|number| number > last && number <= last + 400)).count();
            if continuing > 0 { counts.insert("witness_count_continues".to_owned(), continuing); }
        }
        _ => {
            // A note list (bracketed, most of it in the last quarter) is no missed count.
            let text = units.slice(0, length);
            let (mut run, mut bracketed_run, mut tail) = (0u32, 0usize, 0usize);
            let mut at = 0;
            for line in text.split_inclusive('\n') {
                if let Some(number) = opening_number(line) {
                    if number == run + 1 {
                        run = number;
                        if bracketed(line.trim_start()).is_some() { bracketed_run += 1; }
                        if at * 4 > text.len() * 3 { tail += 1; }
                    }
                }
                at += line.len();
            }
            let note_list = bracketed_run == run as usize && tail * 10 >= run as usize * 7;
            if run >= 5 && !note_list { counts.insert("witness_unnumbered_count".to_owned(), run as usize); }
        }
    }
    // A note call is a bracketed number run into the word or punctuation before it ("appeal.[1] The").
    let bytes = structure.text.as_bytes();
    let calls = structure.text.match_indices('[').filter(|(at, _)| {
        *at > 0 && !bytes[at - 1].is_ascii_whitespace() && bytes[at - 1] != b'['
            && bracketed(&structure.text[*at..]).is_some_and(|number| number < 1000)
    }).count();
    if calls > 0 { counts.insert("witness_glued_calls".to_owned(), calls); }
}

/// The paragraph number a line opens with, in any form a provider prints one: "[12] …", "(12) …", "12. …"
/// or "12 The …".
fn opening_number(line: &str) -> Option<u32> {
    let line = line.trim_start();
    if let Some(number) = bracketed(line) {
        return Some(number);
    }
    let (inner, wrapped) = match line.strip_prefix('(') { Some(rest) => (rest, true), None => (line, false) };
    let digits = inner.bytes().take(4).take_while(u8::is_ascii_digit).count();
    let rest = &inner[digits..];
    let opens = if wrapped { rest.starts_with(") ") } else { rest.starts_with(". ") || rest.starts_with(' ') && rest[1..].starts_with(char::is_uppercase) };
    (digits > 0 && opens).then(|| inner[..digits].parse().ok()).flatten()
}

/// The number a text opens with in brackets: "[12] …" is 12.
fn bracketed(text: &str) -> Option<u32> {
    let rest = text.strip_prefix('[')?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0 && digits <= 4 && rest.as_bytes().get(digits) == Some(&b']')).then(|| rest[..digits].parse().ok()).flatten()
}

fn census(job: Job) -> Record {
    let citation = job.input.citation.clone();
    let mut digest = DefaultHasher::new();
    for part in [&job.input.text, &job.input.citation, job.input.name.as_deref().unwrap_or_default(),
        job.input.alternate_citation.as_deref().unwrap_or_default()] {
        digest.write(part.as_bytes());
        digest.write_u8(0);
    }
    for (label, provision) in job.input.section_map.iter().flatten() {
        digest.write(label.as_bytes());
        digest.write_u8(0);
        digest.write(provision.as_bytes());
        digest.write_u8(0);
    }
    let text = format!("{:016x}", digest.finish());
    let cases = job.input.source_kind == ProviderTextSourceKind::Cases;
    let started = Instant::now();
    let derived = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| provider_text_document_structure(job.input)));
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut record = Record { key: job.key, dataset: job.dataset, citation, text, ms, ..Record::default() };
    let structure = match derived {
        Ok(Ok(structure)) => structure,
        Ok(Err(error)) => { record.error = Some(format!("{error:?}")); return record; }
        Err(panic) => {
            record.error = Some(format!("panic: {}", panic.downcast_ref::<String>().cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|value| value.to_string())).unwrap_or_default()));
            return record;
        }
    };
    let index = structure.nodes.iter().enumerate().map(|(at, node)| (node.id.as_str(), at)).collect::<HashMap<_, _>>();
    let mut nodes = String::new();
    for node in &structure.nodes {
        *record.counts.entry(node.kind.name().to_owned()).or_default() += 1;
        let parent = node.parent_id.as_deref().and_then(|parent| index.get(parent)).map_or("-".to_owned(), ToString::to_string);
        nodes.push_str(&format!("{} {} {}-{} {parent};", node.kind.name(), node.label.as_deref().unwrap_or("_"),
            node.range.start, node.range.end));
    }
    for note in &structure.notes {
        *record.counts.entry("notes".to_owned()).or_default() += 1;
        if !note.references.is_empty() { *record.counts.entry("notes_referenced".to_owned()).or_default() += 1; }
        let references = note.references.iter().map(|reference| reference.range.start.to_string()).collect::<Vec<_>>();
        nodes.push_str(&format!("note {}-{} {}-{} > {};", note.label_range.start, note.label_range.end,
            note.body_range.start, note.body_range.end, references.join(",")));
    }
    if cases {
        let numbered = structure.nodes.iter()
            .filter(|node| node.kind == NodeKind::Paragraph && node.label.as_deref().is_some_and(|label| label.starts_with("par")))
            .count();
        record.counts.insert("numbered_paragraphs".to_owned(), numbered);
        if numbered == 0 { record.counts.insert("zero_paragraph_docs".to_owned(), 1); }
        case_counts(&structure, &mut record.counts);
    }
    let mut digest = DefaultHasher::new();
    digest.write(nodes.as_bytes());
    record.nodes = format!("{:016x}", digest.finish());
    record.listing = nodes;
    record
}

fn local(relative: &str) -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("OpenLegalData").join(relative)
}

struct Options {
    positional: Vec<String>,
    named: HashMap<String, String>,
    flags: Vec<String>,
}

fn options() -> Options {
    let mut positional = Vec::new();
    let mut named = HashMap::new();
    let mut flags = Vec::new();
    let mut arguments = std::env::args().skip(1).peekable();
    while let Some(argument) = arguments.next() {
        match argument.strip_prefix("--") {
            Some(name) if arguments.peek().is_some_and(|next| !next.starts_with("--")) && name != "text" => {
                named.insert(name.to_owned(), arguments.next().unwrap());
            }
            Some(name) => flags.push(name.to_owned()),
            None => positional.push(argument),
        }
    }
    Options { positional, named, flags }
}

fn open(store: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(store, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    connection.execute_batch("PRAGMA mmap_size=2147418112")?;
    Ok(connection)
}

fn read_row(row: &rusqlite::Row) -> rusqlite::Result<(i64, StoreRow)> {
    Ok((row.get(0)?, StoreRow::from_query(row, 1, &COLUMNS)?))
}

#[cfg(windows)]
fn below_normal_priority() {
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn SetPriorityClass(process: isize, class: u32) -> i32;
    }
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x4000;
    // SAFETY: the pseudo-handle of the current process is always valid.
    unsafe { SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS) };
}

#[cfg(not(windows))]
fn below_normal_priority() {}

fn run(options: &Options) -> Result<()> {
    let store = options.named.get("store").map(PathBuf::from).unwrap_or_else(|| local("providers/a2aj/a2aj.sqlite"));
    let out = options.named.get("out").map(PathBuf::from).unwrap_or_else(|| local("experiments/a2aj-structure"));
    let label = options.named.get("label").ok_or("--label is required")?;
    let kind = options.named.get("kind").map_or("all", String::as_str);
    let every = options.named.get("every").map_or(Ok(1), |value| value.parse::<i64>())?.max(1);
    // A census shares the machine: three threads by default, below normal priority.
    let threads = options.named.get("threads").map_or(Ok(3), |value| value.parse::<usize>())?.max(1);
    below_normal_priority();
    let language = options.named.get("lang").cloned();
    std::fs::create_dir_all(&out)?;
    // The store is read in id order: an index on doc_type would sort every row's text instead.
    let filter = match kind { "cases" | "laws" => format!("WHERE +doc_type = '{kind}'"), _ => String::new() };
    let sampled = if every > 1 { format!("{} id % {every} = 0", if filter.is_empty() { "WHERE" } else { " AND" }) } else { String::new() };
    let sql = format!("SELECT id, {} FROM document {filter}{sampled} ORDER BY id", COLUMNS.join(", "));
    let started = Instant::now();
    let (send_jobs, receive_jobs) = mpsc::sync_channel::<Job>(threads * 4);
    let (send_records, receive_records) = mpsc::sync_channel::<Record>(threads * 4);
    let receive_jobs = Arc::new(Mutex::new(receive_jobs));
    let path = out.join(format!("{label}.jsonl"));
    let mut summary = Summary::default();
    std::thread::scope(|scope| -> Result<()> {
        let reader = scope.spawn(move || -> std::result::Result<(), String> {
            let connection = open(&store).map_err(|error| error.to_string())?;
            let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
            let rows = statement.query_map([], read_row).map_err(|error| error.to_string())?;
            for row in rows {
                let (id, row) = row.map_err(|error| error.to_string())?;
                for job in jobs(id, &row).map_err(|error| error.to_string())?
                    .into_iter()
                    .filter(|job| language.as_deref().is_none_or(|language| job.key.split(':').nth(1) == Some(language)))
                {
                    if send_jobs.send(job).is_err() { return Ok(()); }
                }
            }
            Ok(())
        });
        for _ in 0..threads {
            let receive_jobs = Arc::clone(&receive_jobs);
            let send_records = send_records.clone();
            scope.spawn(move || loop {
                let job = match receive_jobs.lock().unwrap().recv() { Ok(job) => job, Err(_) => break };
                if send_records.send(census(job)).is_err() { break; }
            });
        }
        drop(send_records);
        let mut writer = BufWriter::new(File::create(&path)?);
        let mut listings = BufWriter::new(File::create(out.join(format!("{label}.nodes.jsonl")))?);
        for record in receive_records {
            summary.add(&record);
            serde_json::to_writer(&mut writer, &record)?;
            writer.write_all(b"\n")?;
            serde_json::to_writer(&mut listings, &serde_json::json!({ "key": record.key, "nodes": record.listing }))?;
            listings.write_all(b"\n")?;
            if summary.records % 20_000 == 0 {
                eprintln!("{} documents, {:.0} s", summary.records, started.elapsed().as_secs_f64());
            }
        }
        reader.join().map_err(|_| "the store reader panicked")??;
        Ok(())
    })?;
    let wall = started.elapsed().as_secs_f64();
    let report = summary.report(label, wall, threads);
    std::fs::write(out.join(format!("{label}.summary.json")), serde_json::to_string_pretty(&report)? + "\n")?;
    println!("{}", serde_json::to_string_pretty(&report["total"])?);
    println!("{label}: {} documents in {wall:.1} s on {threads} threads -> {}", summary.records, path.display());
    if let Some(base) = options.named.get("against") {
        diff(&out.join(format!("{base}.jsonl")), &path, examples(options)?, &out.join(format!("{base}--{label}.diff.json")))?;
    }
    Ok(())
}

#[derive(Default)]
struct Totals {
    documents: usize,
    errors: usize,
    ms: f64,
    counts: BTreeMap<String, usize>,
    /// Documents with each count above zero.
    holding: BTreeMap<String, usize>,
}

impl Totals {
    fn add(&mut self, record: &Record) {
        self.documents += 1;
        self.errors += usize::from(record.error.is_some());
        self.ms += record.ms;
        for (name, value) in &record.counts {
            *self.counts.entry(name.clone()).or_default() += value;
            *self.holding.entry(name.clone()).or_default() += usize::from(*value > 0);
        }
    }
    fn json(&self) -> Value {
        json!({ "documents": self.documents, "errors": self.errors, "engine_seconds": (self.ms / 10.0).round() / 100.0,
            "counts": self.counts, "documents_holding": self.holding })
    }
}

#[derive(Default)]
struct Summary {
    records: usize,
    total: Totals,
    by_dataset: BTreeMap<String, Totals>,
    errors: Vec<String>,
}

impl Summary {
    fn add(&mut self, record: &Record) {
        self.records += 1;
        self.total.add(record);
        self.by_dataset.entry(record.dataset.clone()).or_default().add(record);
        if let Some(error) = &record.error {
            if self.errors.len() < 200 { self.errors.push(format!("{} {}: {error}", record.key, record.citation)); }
        }
    }
    fn report(&self, label: &str, wall: f64, threads: usize) -> Value {
        json!({ "label": label, "wall_seconds": (wall * 10.0).round() / 10.0, "threads": threads,
            "total": self.total.json(),
            "by_dataset": self.by_dataset.iter().map(|(name, totals)| (name.clone(), totals.json())).collect::<BTreeMap<_, _>>(),
            "errors": self.errors })
    }
}

fn load(path: &Path) -> Result<HashMap<String, Record>> {
    let reader = BufReader::new(File::open(path)?);
    let mut records = HashMap::new();
    for line in reader.lines() {
        let record: Record = serde_json::from_str(&line?)?;
        records.insert(record.key.clone(), record);
    }
    Ok(records)
}

/// What changed between two readings: documents whose text changed (the corpus), and among those whose text did
/// not, how each count moved (the engine).
fn diff(base: &Path, new: &Path, examples: usize, report: &Path) -> Result<()> {
    let (before, after) = (load(base)?, load(new)?);
    let mut categories = BTreeMap::<String, (usize, Vec<String>)>::new();
    let mut note = |category: String, key: &str, citation: &str| {
        let entry = categories.entry(category).or_default();
        entry.0 += 1;
        if entry.1.len() < examples { entry.1.push(format!("{key} {citation}")); }
    };
    let mut keys = before.keys().chain(after.keys().filter(|key| !before.contains_key(*key))).collect::<Vec<_>>();
    keys.sort();
    for key in keys {
        match (before.get(key), after.get(key)) {
            (Some(old), None) => note("removed from the store".to_owned(), key, &old.citation),
            (None, Some(new)) => note(format!("added to the store ({})", new.dataset), key, &new.citation),
            (Some(old), Some(new)) if old.text != new.text => note(format!("text changed ({})", new.dataset), key, &new.citation),
            (Some(old), Some(new)) => {
                if old.error.is_none() && new.error.is_some() { note("engine: now fails".to_owned(), key, &new.citation); continue; }
                if old.error.is_some() && new.error.is_none() { note("engine: no longer fails".to_owned(), key, &new.citation); continue; }
                if old.nodes == new.nodes && old.counts == new.counts { continue; }
                let mut moved = false;
                for name in old.counts.keys().chain(new.counts.keys()).collect::<std::collections::BTreeSet<_>>() {
                    let (was, is) = (old.counts.get(name).copied().unwrap_or(0), new.counts.get(name).copied().unwrap_or(0));
                    if was != is {
                        moved = true;
                        note(format!("engine: {name} {}", if is > was { "up" } else { "down" }), key, &new.citation);
                    }
                }
                if !moved { note("engine: same counts, other ranges".to_owned(), key, &new.citation); }
            }
            (None, None) => unreachable!(),
        }
    }
    let value = json!({ "base": base, "new": new, "documents": { "base": before.len(), "new": after.len() },
        "categories": categories.iter().map(|(name, (count, keys))| (name.clone(), json!({ "documents": count, "examples": keys })))
            .collect::<serde_json::Map<_, _>>() });
    std::fs::write(report, serde_json::to_string_pretty(&value)? + "\n")?;
    for (name, (count, _)) in &categories { println!("{count:>8}  {name}"); }
    println!("-> {}", report.display());
    Ok(())
}

fn examples(options: &Options) -> Result<usize> {
    Ok(options.named.get("examples").map_or(Ok(40), |value| value.parse())?)
}

/// One document's nodes with the text each opens with, for reading a change by eye.
fn show(options: &Options) -> Result<()> {
    let id = options.positional.get(1).ok_or("show needs a document id")?.parse::<i64>()?;
    let language = options.named.get("lang").map_or("en", String::as_str);
    let store = options.named.get("store").map(PathBuf::from).unwrap_or_else(|| local("providers/a2aj/a2aj.sqlite"));
    let connection = open(&store)?;
    let (id, row) = connection.query_row(&format!("SELECT id, {} FROM document WHERE id = ?", COLUMNS.join(", ")), [id], read_row)?;
    let wanted = options.flags.iter().any(|flag| flag == "text");
    for job in jobs(id, &row)?.into_iter().filter(|job| job.key.split(':').nth(1) == Some(language)
        && (!job.key.ends_with(":sections") || !wanted)) {
        println!("== {} {} ({})", job.key, job.input.citation, job.dataset);
        let structure = provider_text_document_structure(job.input)?;
        let units = Units::new(&structure.text);
        let index = structure.nodes.iter().enumerate().map(|(at, node)| (node.id.as_str(), at)).collect::<HashMap<_, _>>();
        let mut cursor = 0;
        let mut order = (0..structure.nodes.len()).collect::<Vec<_>>();
        order.sort_by_key(|at| (structure.nodes[*at].range.start, std::cmp::Reverse(structure.nodes[*at].range.end)));
        for at in order {
            let node = &structure.nodes[at];
            if node.kind == NodeKind::Page { continue; }
            if node.range.start > cursor && !units.slice(cursor, node.range.start).trim().is_empty() {
                for line in units.slice(cursor, node.range.start).lines().filter(|line| !line.trim().is_empty()) {
                    println!("{:>24}  | {}", "(none)", line.chars().take(110).collect::<String>());
                }
            }
            let depth = std::iter::successors(node.parent_id.as_deref(), |parent| index.get(parent)
                .and_then(|at| structure.nodes[*at].parent_id.as_deref())).count();
            let body = units.slice(node.range.start, node.range.end);
            let lines = body.lines().filter(|line| !line.trim().is_empty()).count();
            println!("{:>24}  {}{} [{} lines] {}", format!("{} {}", node.kind.name(), node.label.as_deref().unwrap_or("")),
                "  ".repeat(depth), node.range.start, lines, body.lines().next().unwrap_or("").chars().take(100).collect::<String>());
            cursor = cursor.max(node.range.end);
        }
        let length = units.bytes.len() - 1;
        for line in units.slice(cursor, length).lines().filter(|line| !line.trim().is_empty()) {
            println!("{:>24}  | {}", "(none)", line.chars().take(110).collect::<String>());
        }
        for note in &structure.notes {
            println!("note {} body {}-{} refs {:?}", units.slice(note.label_range.start, note.label_range.end),
                note.body_range.start, note.body_range.end, note.references.iter().map(|value| value.range.start).collect::<Vec<_>>());
        }
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<()> {
    let options = options();
    match options.positional.first().map(String::as_str) {
        Some("run") => run(&options),
        Some("diff") => {
            let [base, new] = [1, 2].map(|at| options.positional.get(at).map(PathBuf::from));
            let (base, new) = (base.ok_or("diff needs two readings")?, new.ok_or("diff needs two readings")?);
            let report = new.with_extension("").with_extension("diff.json");
            diff(&base, &new, examples(&options)?, &report)
        }
        Some("show") => show(&options),
        _ => Err("usage: a2aj-corpus run --label NAME [--against NAME] | diff BASE NEW | show ID".into()),
    }
}
