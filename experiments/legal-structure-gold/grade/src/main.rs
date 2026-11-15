//! Grade fixed gold against explicit cached predictions or a parse of the structure stage.
//!
//! STORE is the gold store (benchmarks/local-data/gold, or a worker's checkout of the same repository;
//! experiments/legal_pdf_corpus/gold_store.py): one folder per source, its current gold in
//! structure/<batch>-a/gold.json.gz, its partition (--split) and groups in source.json. What a machine
//! makes from the store stays on that machine, under the data home (OPEN_LEGAL_DATA_HOME, else
//! %LOCALAPPDATA%/OpenLegalData): extraction caches in gold-parsed/, the structure-stage inputs in
//! STRUCTURE_GOLD_INPUTS (else gold-inputs/), and grades; with STRUCTURE_GOLD_DUMP naming a folder,
//! each source's parsed structure and pages, to compare two builds' parses. Every core grades unless
//! STRUCTURE_GOLD_THREADS says otherwise.
//!
//!   structure-gold inputs STORE    each gold's PDF read as a parse of this build reads it, through
//!       the product's caches, into the inputs folder under <build identity>/; the gold is aligned to
//!       whatever lines this build reads, never chosen by them
//!   structure-gold grade STORE [--candidates FILE] [--split S] [--runs PREFIX..]
//!                        [--group FIELD=VALUE]... [--out FILE] [--against FILE] [--show]
//!       runs the structure stage over this build's inputs and scores it; writes
//!       gold-grade.json in the data home unless --out names another file. Totals are pooled per split; test is left out unless asked
//!       (--split test, or --split all for every split). --against FILE[,FILE...] reads this grade against earlier ones: each
//!       layer's counts and F1 before and after (BELOW where it falls), by mode, and the documents losing most on the key layers.
//!       --candidates reads the existing OCR cache manifest (inputs: source_sha256, candidate),
//!       scores only its exports, and never selects them by gold line IDs.
//!       --group FIELD=VALUE keeps matching source groups; repeat to require every match.
//!       --parts grades each document of a packet on its own (run <sha>#k): the gold cut at its
//!       document starts, the parser run on the extraction's lines that align to that document.
//!   structure-gold digest STORE OUT
//!       each source's parse hashed, nothing graded: `sha<TAB>digest` per document, every split; two builds parse the
//!       same where their files are (`fc /b`, `cmp`).
//!   structure-gold labels STORE OUT
//!       the gold's labels on this build's parse of every train and development source (never test), which
//!       Detect-Order-Construct is fitted on: one {sha256, ids, labels} row per source, the parser's
//!       LEGALPDF_DOC_GOLD (`labels.rs`).
//!   structure-gold footnotes GOLD_DIR OUT [--against FILE] [--show]
//!       the journal footnote gold (benchmarks/local-data/olj-footnote-gold/gold, one <sha>/gold.json per article) scored
//!       on this build's parse of each article: notes, references, positions, pairs (`footnotes.rs`).
//!   structure-gold explain STORE SHA_PREFIX|@FILE [--candidates FILE] [--layers a,b] [--limit N]
//!       one document's missed (-) and spurious (+) items per layer, as text; @FILE, each document it names (a SHA
//!       prefix a line) in turn.
//!   structure-gold selfcheck STORE self|agree [--run R] [--split S] [--worst a,b]
//!       exports Rust boundary features and fixed-gold targets, excluding test.
mod alignment;
mod footnotes;
mod gold;
mod labels;
mod packs;
mod score;
mod side;
mod text_diff;

/// mimalloc, whose threads allocate from heaps of their own: on Windows' process heap the
/// documents graded at once waited on its lock for 70% of their time (a stack sample of the
/// whole store on twelve threads).
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

use gold::Gold;
use side::Side;

use legal_pdf_core::{read_gzip_json, write_gzip_json};
use legal_structure_model::DocumentStructure;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

const GROUP_FIELDS: [&str; 5] = ["language_layout", "genre_group", "country", "yardstick", "label_source"];

struct Source {
    sha256: String,
    mode: String,
    split: String,
    groups: BTreeMap<String, String>,
    pdf: PathBuf,
    /// The source's current gold: structure/<batch>-a/gold.json.gz.
    gold: PathBuf,
}

/// Where this machine keeps what it makes from the store: OPEN_LEGAL_DATA_HOME, else
/// %LOCALAPPDATA%/OpenLegalData (the corpus home's parent, as corpus_store.py has it).
fn data_home() -> PathBuf {
    std::env::var_os("OPEN_LEGAL_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join("AppData/Local")))
            .unwrap_or_default().join("OpenLegalData")
    })
}

/// A Windows path in a candidates inventory or labels file, read from WSL where the grader runs there.
fn local(path: &str) -> PathBuf {
    if cfg!(windows) {
        return PathBuf::from(path);
    }
    let path = path.replace('\\', "/");
    match path.split_once(":/") {
        Some((drive, rest)) if drive.len() == 1 => {
            PathBuf::from(format!("/mnt/{}/{rest}", drive.to_lowercase()))
        }
        _ => PathBuf::from(path),
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
}

/// A source folder's gold of one run (structure/<batch>-<run>/gold.json.gz), if it has one.
fn run_gold(folder: &Path, run: &str) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(folder.join("structure")).ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().and_then(|n| n.to_str()).and_then(|n| n.rsplit_once('-')).is_some_and(|(_, r)| r == run))
        .map(|p| p.join("gold.json.gz"))
        .filter(|p| p.is_file())
        .collect();
    found.sort();
    found.pop()
}

/// Every source in the store with a current gold (run "a"), its partition and groups from its
/// source.json, its mode from the gold's receipt. A source whose source.json holds its gold for a repair
/// (`hold`, gold_store.py) is no gold until the hold is taken off.
fn sources(store: &Path) -> Result<Vec<Source>, String> {
    sources_where(store, |_| true)
}

/// The store's sources whose sha256 is `wanted`: a source not wanted is not read. The sources are read on every core.
fn sources_where(store: &Path, wanted: impl Fn(&str) -> bool + Sync) -> Result<Vec<Source>, String> {
    let mut folders = Vec::new();
    for entry in std::fs::read_dir(store).map_err(|e| format!("{}: {e}", store.display()))? {
        let folder = entry.map_err(|e| e.to_string())?.path();
        if let Some(sha256) = folder.file_name().and_then(|n| n.to_str()).filter(|n| n.len() == 64 && wanted(n)).map(str::to_owned) {
            folders.push((folder, sha256));
        }
    }
    // Each folder's source, none (no gold of the run), or held (Err(None)).
    let read = parallel(&folders, |_| 1, |(folder, sha256)| -> Result<Option<Source>, Option<String>> {
        let Some(gold) = run_gold(folder, "a") else {
            return Ok(None);
        };
        let source = read_json(&folder.join("source.json")).map_err(Some)?;
        if !source["hold"].is_null() {
            return Err(None);
        }
        let receipt = read_json(&gold.with_file_name("receipt.json")).map_err(Some)?;
        let pdf = local(source["pdf"].as_str().ok_or_else(|| Some(format!("{sha256}: source.json without pdf")))?);
        Ok(Some(Source {
            mode: receipt["mode"].as_str().unwrap_or_default().to_owned(),
            split: source["partition"].as_str().ok_or_else(|| Some(format!("{sha256}: source.json without partition")))?.to_owned(),
            groups: GROUP_FIELDS.iter().map(|&field| (
                field.to_owned(), source[field].as_str().unwrap_or("unknown").to_owned(),
            )).collect(),
            pdf: if pdf.is_absolute() { pdf } else { data_home().join(pdf) },
            gold,
            sha256: sha256.clone(),
        }))
    });
    let (mut found, mut held) = (Vec::new(), 0);
    for source in read {
        match source {
            Ok(Some(source)) => found.push(source),
            Ok(None) => {}
            Err(None) => held += 1,
            Err(Some(error)) => return Err(error),
        }
    }
    found.sort_by(|a, b| a.sha256.cmp(&b.sha256));
    if held > 0 {
        eprintln!("{held} sources held for repair (gold_store.py holds)");
    }
    Ok(found)
}

/// The one extraction cache the grader reads: STRUCTURE_GOLD_INPUTS where set, else gold-inputs/ in the data home. The
/// engine keeps each source's finished extraction there under the identity of the code and models that make it
/// (`legalpdf::gold_inputs_identity`), so a build never grades another build's pages, and the recognition it read
/// beside them, so no recognized page is read twice.
fn inputs_root() -> PathBuf {
    std::env::var_os("STRUCTURE_GOLD_INPUTS").map_or_else(|| data_home().join("gold-inputs"), PathBuf::from)
}

/// A source's pages as a parse of this build feeds its structure stage (`legalpdf::gold_structure_inputs`): read back
/// from the extraction cache, made where it holds none.
fn extracted(source: &Source) -> Result<legalpdf::ExtractedPdf, String> {
    legalpdf::gold_structure_inputs(&source.pdf, &source.sha256, &inputs_root()).map_err(|e| format!("{}: {e}", source.sha256))
}

/// Whether a source's inputs are kept (`extracted`), and their file's size and time: what a parse of it reads.
fn inputs_stamp(source: &Source) -> Option<(u64, Option<std::time::SystemTime>)> {
    std::fs::metadata(legalpdf::gold_inputs_file(&inputs_root(), &source.sha256)).ok().map(|m| (m.len(), m.modified().ok()))
}

/// The sources a grade resumes together, DOC reading all their pages at once.
const GROUP: usize = 16;

/// Run `work` over the sources on every core, longest first, keeping each result in place.
fn parallel<S: Sync, T: Send>(
    sources: &[S],
    weight: impl Fn(&S) -> u64,
    work: impl Fn(&S) -> T + Sync,
) -> Vec<T> {
    let mut order: Vec<usize> = (0..sources.len()).collect();
    order.sort_by_key(|&n| std::cmp::Reverse(weight(&sources[n])));
    // STRUCTURE_GOLD_THREADS caps the documents graded at once (a shared machine's memory).
    let threads = std::env::var("STRUCTURE_GOLD_THREADS").ok().and_then(|v| v.parse::<usize>().ok()).filter(|n| *n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(8, |n| n.get()));
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<T>>> = Mutex::new((0..sources.len()).map(|_| None).collect());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let k = next.fetch_add(1, Ordering::Relaxed);
                let Some(&n) = order.get(k) else { break };
                let value = work(&sources[n]);
                results.lock().unwrap()[n] = Some(value);
            });
        }
    });
    results
        .into_inner()
        .unwrap()
        .into_iter()
        .map(Option::unwrap)
        .collect()
}

fn inputs(store: &Path) -> Result<(), String> {
    let mut all = sources(store)?;
    // STRUCTURE_GOLD_INPUTS_ONLY: comma-separated sha prefixes, for a slice.
    if let Ok(only) = std::env::var("STRUCTURE_GOLD_INPUTS_ONLY") {
        let prefixes: Vec<&str> = only.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
        all.retain(|s| prefixes.iter().any(|p| s.sha256.starts_with(p)));
    }
    let started = Instant::now();
    let results = parallel(&all, |s| std::fs::metadata(&s.pdf).map_or(0, |m| m.len()), |source| if inputs_stamp(source).is_some() { Ok(()) } else { extracted(source).map(|_| ()) });
    let failed: Vec<&String> = results.iter().filter_map(|r| r.as_ref().err()).collect();
    for error in &failed {
        eprintln!("ERROR {error}");
    }
    eprintln!("{} inputs, {} failed, in {:.1}s", all.len(), failed.len(), started.elapsed().as_secs_f64());
    if failed.is_empty() { Ok(()) } else { Err(format!("{} sources without their inputs", failed.len())) }
}

#[derive(Deserialize)]
struct Export {
    structure: DocumentStructure,
    extraction: ExportExtraction,
}

#[derive(Deserialize)]
struct ExportExtraction {
    source_sha256: String,
}

/// Select cached predictions explicitly, using the existing OCR cache inventory.
fn candidates(path: Option<&str>) -> Result<BTreeMap<String, PathBuf>, String> {
    #[derive(Deserialize)]
    struct Inventory {
        inputs: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        source_sha256: String,
        candidate: String,
    }
    let Some(path) = path else {
        return Ok(BTreeMap::new());
    };
    let path = Path::new(path);
    let inventory: Inventory =
        serde_json::from_value(read_json(path)?).map_err(|e| e.to_string())?;
    let mut selected = BTreeMap::new();
    for row in inventory.inputs {
        let candidate = local(&row.candidate);
        let candidate = if candidate.is_absolute() {
            candidate
        } else {
            path.parent().unwrap_or(Path::new(".")).join(candidate)
        };
        if selected
            .insert(row.source_sha256.clone(), candidate)
            .is_some()
        {
            return Err(format!("Duplicate candidate for {}", row.source_sha256));
        }
    }
    Ok(selected)
}

/// The parser's structure for a source: parsed from this build's inputs, or read from the export
/// a candidates inventory names.
fn candidate(
    source: &Source,
    selected: Option<&PathBuf>,
) -> Result<DocumentStructure, String> {
    if let Some(path) = selected {
        let export = read_gzip_json::<Export>(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if export.extraction.source_sha256 != source.sha256 {
            return Err("Candidate extraction belongs to another PDF".into());
        }
        return Ok(export.structure);
    }
    Ok(parse(source)?.0)
}

/// What a parse reads, known without parsing: the parse's version (`legalpdf::PARSE_VERSION`) and the text model it
/// embeds lines with, by its files. A document's kept parse and dump stand while this and its extraction do.
fn parse_key() -> &'static str {
    static KEY: std::sync::LazyLock<String> = std::sync::LazyLock::new(made_key);
    &KEY
}

/// A source's read key: what its parse is made of (`parse_key`) and its extraction, by its identity (the code and models
/// that make it, its folder's name), where it is kept: a file under one identity is written once.
fn read_key(source: &Source) -> Option<String> {
    inputs_stamp(source).map(|_| format!("{}:{}", parse_key(), legalpdf::gold_inputs_identity()))
}

/// The dump (LEGALPDF_DOC_DUMP), where a parse is kept and resumed; none under the oracle layout, which reads the gold.
fn dump_folder() -> Option<PathBuf> {
    // Every grade keeps its parses and reads them back: LEGALPDF_DOC_DUMP names the folder, else doc-dump/ in the data home.
    let folder = std::env::var_os("LEGALPDF_DOC_DUMP").map_or_else(|| data_home().join("doc-dump"), PathBuf::from);
    Some(folder).filter(|_| std::env::var_os("STRUCTURE_GOLD_ORACLE_LAYOUT").is_none())
}

/// What a source's labels and gold side are made from: its gold file (its size and time) and the labelling rule's own
/// version (`labels::VERSION`). A change to either reads the gold again (the rule changed alone, the stamp did not, and
/// stale labels were read back).
fn gold_stamp(source: &Source) -> Result<String, String> {
    std::fs::metadata(&source.gold).map(|m| format!("{}:{:?}:labels{}", m.len(), m.modified().ok(), labels::VERSION)).map_err(|e| e.to_string())
}

/// A source's dump entry where it holds this build's parse of the source (`is_current`).
fn current(dump: &Path, source: &Source) -> Option<legalpdf::Entry> {
    legalpdf::Entry::read(dump, &source.sha256).filter(|entry| is_current(entry, source))
}

/// Whether an entry holds this build's parse of the source: its read key, and the parse itself.
fn is_current(entry: &legalpdf::Entry, source: &Source) -> bool {
    read_key(source).is_some_and(|key| entry.record["read_key"] == key.as_str()) && entry.bytes("parse").is_some()
        && (!keeps_inputs() || entry.has_part("inputs"))
}

/// Whether a grade keeps DOC's inputs with its parses: where DOC reads the kept parse (a model named) or its fit does (a
/// dump named).
fn keeps_inputs() -> bool {
    std::env::var_os("LEGALPDF_DOC").is_some() || std::env::var_os("LEGALPDF_DOC_DUMP").is_some()
}

/// The gold's side an entry keeps for this gold (`gold_stamp`), where it keeps one.
fn kept_side(entry: &legalpdf::Entry, source: &Source) -> Option<Side> {
    let stamp = gold_stamp(source).ok()?;
    entry.bytes("gold").and_then(|bytes| rmp_serde::from_slice::<(String, Side)>(bytes).ok()).filter(|(was, _)| *was == stamp).map(|(_, side)| side)
}

/// The parse's version and the text model it tokenizes lines with, by its files' contents (the recognizer is the
/// extraction's, in its identity).
fn made_key() -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(legalpdf::PARSE_VERSION);
    if let Some(dir) = std::env::var_os("LEGALPDF_DOC_TEXT") {
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
        files.sort();
        for file in files {
            hasher.update(file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default());
            hasher.update(std::fs::read(&file).unwrap_or_default());
        }
    }
    hasher.finalize().iter().take(8).map(|byte| format!("{byte:02x}")).collect::<String>()
}

/// The structure stage over a source's inputs, with the pages it wrote. With STRUCTURE_GOLD_DUMP
/// naming a folder, each source's structure and pages are kept there (<sha>.structure.json.gz,
/// <sha>.pages.json.gz), for comparing two builds' parses byte for byte.
fn parse(source: &Source) -> Result<(DocumentStructure, std::sync::Arc<Vec<legal_pdf_core::model::Page>>), String> {
    let read_at = Instant::now();
    let extracted = extracted(source)?;
    let extracted = if std::env::var_os("STRUCTURE_GOLD_ORACLE_LAYOUT").is_some() {
        let whole: Gold = read_gzip_json(&source.gold).map_err(|e| e.to_string())?;
        oracle_layout(extracted, &whole)?
    } else {
        extracted
    };
    let structure_at = Instant::now();
    // The parse kept under this build's key, which the next grade reads it back by (`is_current`).
    let (folder, key) = (dump_folder(), read_key(source));
    let keep = folder.as_deref().zip(key.as_deref()).map(|(folder, key)| legalpdf::Keep { folder, key, inputs: keeps_inputs() });
    let document = legalpdf::gold_structure_document(extracted, &source.sha256, keep)
        .map_err(|e| format!("{}: {e}", source.sha256))?;
    if std::env::var_os("STRUCTURE_GOLD_TIMING").is_some() {
        eprintln!("timing	{}	inputs_ms	{:.1}	structure_ms	{:.1}", &source.sha256[..12],
            (structure_at - read_at).as_secs_f64() * 1e3, structure_at.elapsed().as_secs_f64() * 1e3);
    }
    let structure = document.structure().clone();
    let pages = document.passage_pages();
    if let Some(folder) = std::env::var_os("STRUCTURE_GOLD_DUMP").map(PathBuf::from) {
        std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
        write_gzip_json(&folder.join(format!("{}.pages.json.gz", source.sha256)), &*pages)
            .and_then(|()| write_gzip_json(&folder.join(format!("{}.structure.json.gz", source.sha256)), &structure))
            .map_err(|e| format!("{}: {e}", folder.display()))?;
    }
    Ok((structure, pages))
}

/// Each source's parse hashed, nothing graded: one `sha<TAB>digest` line per document (the SHA-256 of its pages' and
/// structure's JSON), every split's, sorted, to OUT. Two builds parse the same where their files are the same.
fn digest(store: &Path, out: &Path) -> Result<(), String> {
    use sha2::Digest;
    let all = sources(store)?;
    let inputs = |s: &Source| inputs_stamp(s).map_or(0, |(size, _)| size);
    let digests = parallel(&all, inputs, |source| {
        let (structure, pages) = parse(source)?;
        let mut hasher = sha2::Sha256::new();
        hasher.update(serde_json::to_vec(&*pages).map_err(|e| e.to_string())?);
        hasher.update(serde_json::to_vec(&structure).map_err(|e| e.to_string())?);
        Ok::<_, String>(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>())
    });
    let mut lines: Vec<String> = all.iter().zip(digests).map(|(source, digest)| format!("{}\t{}", source.sha256, digest.unwrap_or_else(|e| format!("error {e}")))).collect();
    lines.sort();
    std::fs::write(out, lines.join("\n") + "\n").map_err(|e| format!("{}: {e}", out.display()))
}

/// The gold's labels on this build's parse of every train and development source, never test, which Detect-Order-Construct
/// is fitted on: one `{sha256, ids, labels}` row per source to OUT where given (the parser's LEGALPDF_DOC_GOLD, for its
/// oracle; `labels::rows`), and with LEGALPDF_DOC_DUMP the dump and the fit's set.
fn labels(store: &Path, out: Option<&Path>) -> Result<(), String> {
    let all: Vec<Source> = sources(store)?.into_iter().filter(|s| s.split == "train" || s.split == "development").collect();
    let started = Instant::now();
    let inputs = |s: &Source| inputs_stamp(s).map_or(0, |(size, _)| size);
    let found = parallel(&all, inputs, |source| -> Result<Value, String> {
        let dump = dump_folder();
        let stamp = gold_stamp(source)?;
        let key = read_key(source).ok_or_else(|| format!("{}: no inputs (run inputs first)", source.sha256))?;
        // A document's entry in the fit's set (`set.json`): its partition, label source, its dump's key (what the parse
        // read and the gold it was labelled from) and its summary.
        let entry = |meta: &Value| json!({"sha256": source.sha256, "split": source.split, "label_source": source.groups.get("label_source"),
            "key": format!("{}:{}", meta["parse_hash"].as_str().unwrap_or(""), stamp), "summary": meta["summary"]});
        // An entry whole with this build's parse, its targets and the labels of this gold stands.
        if let Some(meta) = dump.as_deref().and_then(|dump| current(dump, source)).filter(|entry| entry.has_part("targets")).map(|entry| entry.record)
            .filter(|meta| meta["gold_stamp"] == stamp.as_str() && !meta["summary"].is_null()) {
            return Ok(json!({"sha256": source.sha256, "ids": meta["label_ids"], "labels": meta["label_rows"], "set": entry(&meta)}));
        }
        // Under another key, what the entry holds is checked, not thrown away: the parse is run again (it writes the
        // entry's inputs and parse anew only where they differ), and where it reads the document as the entry's did (its
        // parse hash) the labels and targets of this gold stand, the key carried over.
        let was = dump.as_deref().and_then(|dump| legalpdf::Entry::read(dump, &source.sha256)).map(|entry| entry.record)
            .filter(|meta| meta["gold_stamp"] == stamp.as_str() && !meta["summary"].is_null() && meta["parse_hash"].is_string());
        let (structure, _) = parse(source)?;
        if let (Some(dump), Some(was)) = (dump.as_deref(), was) {
            if let Some(mut kept) = legalpdf::Entry::read(dump, &source.sha256).filter(|kept| kept.record["parse_hash"] == was["parse_hash"] && kept.has_part("targets")) {
                kept.record["read_key"] = Value::from(key.as_str());
                kept.write(dump, &source.sha256).map_err(|e| format!("{}: {e}", source.sha256))?;
                return Ok(json!({"sha256": source.sha256, "ids": kept.record["label_ids"], "labels": kept.record["label_rows"], "set": entry(&kept.record)}));
            }
        }
        let gold: Gold = read_gzip_json(&source.gold).map_err(|e| format!("{}: {e}", source.sha256))?;
        let reference = Side::of_gold(&gold)?;
        let candidate = Side::of_parse(&structure)?;
        let alignment = alignment::align(&reference, &candidate)?;
        let machine_aligned = source.groups.get("label_source").is_some_and(|label| label == "a2aj-align");
        let (ids, rows) = labels::rows(&gold, &reference, &candidate, &alignment, machine_aligned);
        let set = match &dump {
            Some(dump) => entry(&fill_dump(dump, &source.sha256, &ids, &rows, &stamp, &key)?),
            None => Value::Null,
        };
        Ok(json!({"sha256": source.sha256, "ids": ids, "labels": rows, "set": set}))
    });
    let mut text = String::new();
    let (mut failed, mut set) = (0, Vec::new());
    for (source, row) in all.iter().zip(found) {
        match row {
            Ok(mut row) => {
                let entry = row.as_object_mut().and_then(|r| r.remove("set")).unwrap_or(Value::Null);
                if !entry.is_null() {
                    set.push(entry);
                }
                if out.is_some() {
                    text.push_str(&(row.to_string() + "\n"));
                }
            }
            Err(error) => {
                failed += 1;
                eprintln!("ERROR {}: {error}", source.sha256);
            }
        }
    }
    if let Some(out) = out {
        std::fs::write(out, text).map_err(|e| format!("{}: {e}", out.display()))?;
    }
    // The fit's set beside the dump: every document it may train on, what it knows of each before reading its arrays.
    if let Some(folder) = std::env::var_os("LEGALPDF_DOC_DUMP").filter(|_| failed == 0) {
        let path = PathBuf::from(folder).join("set.json");
        std::fs::write(&path, serde_json::to_vec(&set).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    eprintln!("{} sources, {failed} failed, in {:.1}s", all.len(), started.elapsed().as_secs_f64());
    if failed == 0 { Ok(()) } else { Err(format!("{failed} sources not labelled: no set for the fit")) }
}

/// The fit's training data from the store, whole, in one command: each source's inputs where missing, the dump (a
/// source parsed again only where its build, text model, extraction or gold changed: `labels`), then the packs and
/// their manifest (`packs::packs`). A source that fails stops it: a fit trains on the whole store or not at all.
fn training(store: &Path, dump: &Path, out: &Path, options: &[String]) -> Result<(), String> {
    let value = |name: &str| options.iter().position(|o| o == name).and_then(|n| options.get(n + 1)).cloned();
    let packing = packs::Options::read(options)?;
    std::env::set_var("LEGALPDF_DOC_DUMP", dump);
    // The text model every line's text is embedded with, the fit's export carries it on to the reader.
    std::env::set_var("LEGALPDF_DOC_TEXT", value("--text").ok_or("training needs --text DIR: the text model the lines are embedded with")?);
    std::fs::create_dir_all(dump).map_err(|e| format!("{}: {e}", dump.display()))?;
    inputs(store)?;
    labels(store, None)?;
    packs::packs(dump, out, &packing)
}

/// A parse's dump (the parser's LEGALPDF_DOC_DUMP, written as `labels` parsed the source) given the fit's targets
/// from the gold's rows (`ids` the rows' lines, `line@0`): each row and its pointers (a resumed row, a note's paired
/// reference) placed on the dump's lines, then `legalpdf::doc_targets`. One parse makes both the labels and the
/// fit's inputs.
fn fill_dump(dump: &Path, sha256: &str, ids: &[String], rows: &[[i64; 10]], stamp: &str, key: &str) -> Result<Value, String> {
    let mut entry = legalpdf::Entry::read(dump, sha256).ok_or_else(|| format!("{sha256}: no dump entry"))?;
    let mut meta = std::mem::take(&mut entry.record);
    let lines: Vec<&str> = meta["ids"].as_array().ok_or("dump without ids")?.iter().filter_map(Value::as_str).collect();
    let place: HashMap<&str, usize> = lines.iter().enumerate().map(|(k, &id)| (id, k)).collect();
    let line_of = |row: usize| ids.get(row).and_then(|id| place.get(id.split('@').next().unwrap_or(id))).map_or(-1, |&k| k as i64);
    let n = lines.len();
    let (mut gold, mut ranks, mut note_refs) = (vec![[-1i64; 8]; n], vec![-1i64; n], vec![-1i64; n]);
    for (id, row) in ids.iter().zip(rows) {
        let Some(&k) = place.get(id.split('@').next().unwrap_or(id)) else { continue };
        gold[k] = std::array::from_fn(|c| row[c]);
        if row[6] >= 0 {
            gold[k][6] = line_of(row[6] as usize);
        }
        ranks[k] = row[8];
        note_refs[k] = if row[9] >= 0 { line_of(row[9] as usize) } else { -1 };
    }
    let pages: Vec<usize> = meta["pages"].as_array().ok_or("dump without pages")?.iter().map(|v| v.as_u64().unwrap_or(0) as usize).collect();
    let note_numbers: Vec<i64> = meta["note_numbers"].as_array().ok_or("dump without note numbers")?.iter().map(|v| v.as_i64().unwrap_or(-1)).collect();
    let references: Vec<Vec<(u32, u32, u32)>> = meta["references"].as_array().ok_or("dump without references")?.iter().map(|line| {
        line.as_array().into_iter().flatten().filter_map(|mark| {
            let at = |c: usize| mark.get(c).and_then(Value::as_u64).map(|v| v as u32);
            Some((at(0)?, at(1)?, at(2)?))
        }).collect()
    }).collect();
    let inputs: Vec<legalpdf::tensors::Tensor> = entry.part("inputs").into_values().collect();
    let (targets, summary) = legalpdf::doc_targets(&gold, &pages, &note_refs, &ranks, &references, &note_numbers, &inputs);
    entry.set_part("targets", targets);
    meta["summary"] = summary;
    // What the targets were made from (the gold file's size and time) and the labels themselves, for the next pass.
    meta["gold_stamp"] = Value::from(stamp);
    meta["read_key"] = Value::from(key);
    meta["label_ids"] = json!(ids);
    meta["label_rows"] = json!(rows);
    entry.record = meta;
    entry.write(dump, sha256).map_err(|e| format!("{sha256}: {e}"))?;
    Ok(entry.record)
}

/// The journal footnote gold (`footnotes.rs`) scored on this build's parse of each article: GOLD_DIR holds one
/// `<sha>/gold.json` per article, its PDF in the corpus home's journals. Each article's inputs are made once into this
/// build's inputs folder, as `inputs` makes the store's, then parsed. Writes the summary to OUT; `--against FILE` prints
/// each layer's change from an earlier summary over the articles both scored, `--show` each article's false and
/// missed notes.
fn footnotes(gold_dir: &Path, out: &Path, options: &[String]) -> Result<(), String> {
    let value = |name: &str| options.iter().position(|o| o == name).and_then(|n| options.get(n + 1)).cloned();
    let mut articles: Vec<(String, footnotes::Gold)> = Vec::new();
    for entry in std::fs::read_dir(gold_dir).map_err(|e| format!("{}: {e}", gold_dir.display()))? {
        let folder = entry.map_err(|e| e.to_string())?.path();
        // An article with only its receipt (no gold.json) was not made into gold.
        let Some(sha) = folder.file_name().and_then(|n| n.to_str()).filter(|n| n.len() == 64 && folder.join("gold.json").is_file()).map(str::to_owned) else { continue };
        let gold: footnotes::Gold = serde_json::from_value(read_json(&folder.join("gold.json"))?).map_err(|e| format!("{sha}: {e}"))?;
        articles.push((sha, gold));
    }
    articles.sort_by(|a, b| a.0.cmp(&b.0));
    // Each article's PDF, found once among the corpus home's journals.
    let mut pdfs: HashMap<String, PathBuf> = HashMap::new();
    let mut folders = vec![data_home().join("corpus").join("journals")];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                folders.push(path);
            } else if let Some(sha) = path.file_stem().and_then(|n| n.to_str()).filter(|_| path.extension().is_some_and(|e| e == "pdf")) {
                pdfs.insert(sha.to_owned(), path.clone());
            }
        }
    }
    let started = Instant::now();
    let sources: Vec<Source> = articles.iter().map(|(sha, _)| Source {
        sha256: sha.clone(), mode: "ocr".into(), split: "test".into(), groups: BTreeMap::new(),
        pdf: pdfs.get(sha).cloned().unwrap_or_default(), gold: gold_dir.join(sha).join("gold.json"),
    }).collect();
    let gold_of: HashMap<&str, &footnotes::Gold> = articles.iter().map(|(sha, gold)| (sha.as_str(), gold)).collect();
    let results = parallel(&sources, |s| std::fs::metadata(&s.pdf).map_or(0, |m| m.len()), |source| -> Result<Value, String> {
        let (structure, _) = parse(source)?;
        let gold = gold_of[source.sha256.as_str()];
        let mut row = footnotes::compare(gold, &structure);
        row["document"] = json!(format!("{}:{}", gold.dataset, gold.article_id));
        row["sha256"] = json!(source.sha256);
        row["pages"] = json!(gold.pages);
        Ok(row)
    });
    let (mut rows, mut errors) = (Vec::new(), Vec::new());
    for (source, result) in sources.iter().zip(results) {
        match result {
            Ok(row) => rows.push(row),
            Err(error) => errors.push(json!({"sha256": source.sha256, "error": error})),
        }
    }
    let refs: Vec<&Value> = rows.iter().collect();
    let bodies = |key: &str| rows.iter().map(|r| r["bodies"][key].as_u64().unwrap_or(0)).sum::<u64>();
    let summary = json!({
        "dataset": "olj-footnote-gold.v1", "documents": rows.len() + errors.len(),
        "pages": rows.iter().map(|r| r["pages"].as_u64().unwrap_or(0)).sum::<u64>(), "errors": errors,
        "totals": footnotes::totals(&refs), "bodies": {"matched": bodies("matched"), "agreed": bodies("agreed")}, "per_document": rows,
    });
    std::fs::write(out, serde_json::to_vec(&summary).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", out.display()))?;
    let before = value("--against").map(|path| read_json(Path::new(&path))).transpose()?;
    let compared = before.as_ref().map(|earlier| {
        let earlier: HashMap<&str, &Value> = earlier["per_document"].as_array().into_iter().flatten()
            .filter_map(|r| Some((r["sha256"].as_str()?, r))).collect();
        let common: Vec<(&Value, &Value)> = refs.iter().filter_map(|r| Some((*earlier.get(r["sha256"].as_str()?)?, *r))).collect();
        let (left, right): (Vec<&Value>, Vec<&Value>) = common.iter().copied().unzip();
        println!("{} documents in common with the earlier summary", common.len());
        (footnotes::totals(&left), footnotes::totals(&right))
    });
    println!("{} documents, {} pages, {} errors; bodies agreeing {}/{}", summary["documents"], summary["pages"],
        summary["errors"].as_array().map_or(0, Vec::len), summary["bodies"]["agreed"], summary["bodies"]["matched"]);
    println!("{:12} {:>6} {:>6} {:>6} {:>6} {:>6} {:>6}{}", "layer", "exp", "pred", "ok", "P", "R", "F1", if compared.is_some() { "     dP     dR    dF1" } else { "" });
    for layer in footnotes::LAYERS {
        let t = &summary["totals"][layer];
        let delta = compared.as_ref().map_or(String::new(), |(b, a)| {
            let d = |key: &str| a[layer][key].as_f64().unwrap_or(0.0) - b[layer][key].as_f64().unwrap_or(0.0);
            format!(" {:+6.3} {:+6.3} {:+6.3}", d("precision"), d("recall"), d("f1"))
        });
        println!("{layer:12} {:6} {:6} {:6} {:6.3} {:6.3} {:6.3}{delta}", t["expected"], t["predicted"], t["correct"],
            t["precision"].as_f64().unwrap_or(0.0), t["recall"].as_f64().unwrap_or(0.0), t["f1"].as_f64().unwrap_or(0.0));
    }
    if options.iter().any(|o| o == "--show") {
        for row in &refs {
            for (kind, key) in [("FALSE", "false_notes"), ("MISSED", "missed_notes")] {
                for note in row[key].as_array().into_iter().flatten() {
                    println!("{kind} {} {note}", row["document"].as_str().unwrap_or_default());
                }
            }
        }
    }
    for error in summary["errors"].as_array().into_iter().flatten() {
        eprintln!("ERROR {} {}", error["sha256"], error["error"]);
    }
    eprintln!("in {:.1}s -> {}", started.elapsed().as_secs_f64(), out.display());
    Ok(())
}

/// Each source's PDF extracted natively (no recognition), nothing parsed: one `sha<TAB>digest` line per document (the
/// SHA-256 of its extraction's JSON, its rules' underlines marked, or its error), sorted, to OUT. Two builds extract
/// the same where their files are the same.
fn extract_digest(store: &Path, out: &Path) -> Result<(), String> {
    use legal_pdf_extraction_processor::{extract_pdf, mark_rule_underlines, recognize_pdf};
    use sha2::Digest;
    let all = sources(store)?;
    let digests = parallel(&all, |s| std::fs::metadata(&s.pdf).map_or(0, |m| m.len()), |source| {
        let read = std::fs::read(&source.pdf).map_err(|e| e.to_string()).and_then(|pdf| {
            let mut extracted = extract_pdf(&pdf).map_err(|e| e.to_string())?;
            recognize_pdf(&pdf, &mut extracted, None, None).map_err(|e| e.to_string())?;
            extracted.pages.iter_mut().for_each(mark_rule_underlines);
            serde_json::to_vec(&extracted).map_err(|e| e.to_string())
        });
        sha2::Sha256::digest(read.unwrap_or_else(|error| format!("error {error}").into_bytes())).iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    });
    let mut lines: Vec<String> = all.iter().zip(digests).map(|(source, digest)| format!("{}\t{digest}", source.sha256)).collect();
    lines.sort();
    std::fs::write(out, lines.join("\n") + "\n").map_err(|e| format!("{}: {e}", out.display()))
}

/// Every STEP-th source by SHA extracted natively and read by the layout model (the pack PACK on the OpenVINO C runtime
/// RUNTIME, one thread a worker), nothing parsed: one `sha<TAB>digest` line per document (the SHA-256 of its pages'
/// JSON and the reading's diagnostics, or its error), sorted, to OUT. Two builds read layout the same where their files
/// are the same.
fn layout_digest(store: &Path, out: &Path, pack: &Path, runtime: &Path, step: usize) -> Result<(), String> {
    use sha2::Digest;
    use std::cell::RefCell;
    thread_local!(static LAYOUT: RefCell<Option<legalpdf::PPDocLayout>> = const { RefCell::new(None) });
    let mut all = sources(store)?;
    all.sort_by(|a, b| a.sha256.cmp(&b.sha256));
    let all: Vec<Source> = all.into_iter().step_by(step.max(1)).collect();
    let options = legalpdf::PPDocOptions { model_pack: Some(pack.to_owned()), runtime: Some(runtime.to_owned()), threads: 1, ..Default::default() };
    let digests = parallel(&all, |s| std::fs::metadata(&s.pdf).map_or(0, |m| m.len()), |source| {
        let read = std::fs::read(&source.pdf).map_err(|e| e.to_string()).and_then(|pdf| {
            let mut extracted = legal_pdf_extraction_processor::extract_pdf(&pdf).map_err(|e| e.to_string())?;
            let diagnostics = LAYOUT.with(|layout| {
                let mut layout = layout.borrow_mut();
                if layout.is_none() {
                    *layout = Some(legalpdf::PPDocLayout::new(&options).map_err(|e| e.to_string())?);
                }
                layout.as_mut().unwrap().annotate_pdf(&pdf, &mut extracted.pages).map_err(|e| e.to_string())
            })?;
            let mut bytes = serde_json::to_vec(&extracted.pages).map_err(|e| e.to_string())?;
            bytes.extend(serde_json::to_vec(&diagnostics).map_err(|e| e.to_string())?);
            Ok::<_, String>(bytes)
        });
        sha2::Sha256::digest(read.unwrap_or_else(|error| format!("error {error}").into_bytes())).iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    });
    let mut lines: Vec<String> = all.iter().zip(digests).map(|(source, digest)| format!("{}\t{digest}", source.sha256)).collect();
    lines.sort();
    std::fs::write(out, lines.join("\n") + "\n").map_err(|e| format!("{}: {e}", out.display()))
}

/// Each Word document under DIR read every way the parser reads one, nothing graded: one `path<TAB>digest` line per
/// file (the SHA-256 of its text, its drafting text, its table-of-authorities units, its supra cleanup and its
/// structure, each its result or its error), sorted, to OUT. Two builds read the same where their files are the same.
fn docx_digest(dir: &Path, out: &Path) -> Result<(), String> {
    use sha2::Digest;
    fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, found);
            } else if path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("docx")) {
                found.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, &mut files);
    files.sort();
    let read = |path: &PathBuf| {
        let bytes = std::fs::read(path).unwrap_or_default();
        let shown = |result: Result<String, String>| result.unwrap_or_else(|error| format!("error {error}"));
        let parts = [
            shown(legalpdf::docx_text(&bytes, false).map_err(|e| e.to_string())),
            shown(legalpdf::docx_text(&bytes, true).map_err(|e| e.to_string())),
            shown(legalpdf::docx_to_toa_text_units(&bytes).map(|units| json!(units).to_string()).map_err(|e| e.to_string())),
            shown(legalpdf::fix_docx_supra_cross_references(&bytes).map(|cleanup| format!("{cleanup:?}")).map_err(|e| e.to_string())),
            shown(legalpdf::analyze_docx_bytes(&bytes, "docx".to_owned()).map(|structure| json!(structure).to_string()).map_err(|e| e.to_string())),
        ];
        let mut hasher = sha2::Sha256::new();
        for part in parts {
            hasher.update(part.as_bytes());
            hasher.update([0]);
        }
        format!("{}\t{}", path.strip_prefix(dir).unwrap_or(path).display(), hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>())
    };
    let next = AtomicUsize::new(0);
    let lines = Mutex::new(Vec::with_capacity(files.len()));
    let threads = std::thread::available_parallelism().map_or(8, |n| n.get());
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let at = next.fetch_add(1, Ordering::Relaxed);
                let Some(path) = files.get(at) else { break };
                let line = read(path);
                lines.lock().unwrap().push(line);
            });
        }
    });
    let mut lines = lines.into_inner().unwrap();
    lines.sort();
    std::fs::write(out, lines.join("\n") + "\n").map_err(|e| format!("{}: {e}", out.display()))
}

struct Graded {
    score: score::Score,
    parse_ms: f64,
    score_ms: f64,
}

static PARTS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// A packet's gold cut at its document starts: each part is the units from one start to the
/// next, the typed lines they hold (one no unit holds goes with the typed line before it), the
/// gold's lines those name (one none names goes with the line before it), and the note pairs
/// within it. Units and note pairs point into the typed lines, which corrections can split or
/// merge, so the typed lines are cut first. A gold of one document is its own only part. Beside
/// the parts, each gold line's parts: its own, and any other whose typed lines also name it.
fn gold_parts(gold: &Value) -> Result<(Vec<Value>, Vec<Vec<usize>>), String> {
    let units = gold["units"].as_array().ok_or("A gold without units")?;
    let lines = gold["lines"].as_array().ok_or("A gold without lines")?;
    let typed = gold["typed"].as_array().ok_or("A gold without typed lines")?;
    let starts: Vec<usize> = (0..units.len()).filter(|&u| u == 0 || units[u]["starts_document"] == true).collect();
    if starts.len() < 2 {
        return Ok((vec![gold.clone()], vec![vec![0]; lines.len()]));
    }
    let unit_typed = |u: usize| units[u]["lines"].as_array().into_iter().flatten().filter_map(Value::as_u64).map(|n| n as usize);
    let part_of_unit: Vec<usize> = (0..units.len()).map(|u| starts.partition_point(|&s| s <= u) - 1).collect();
    let carry = |held: Vec<Option<usize>>| {
        let mut parts: Vec<usize> = Vec::with_capacity(held.len());
        for found in held {
            parts.push(found.or(parts.last().copied()).unwrap_or(0));
        }
        parts
    };
    let mut held: Vec<Option<usize>> = vec![None; typed.len()];
    for u in 0..units.len() {
        for t in unit_typed(u).filter(|&t| t < typed.len()) {
            held[t].get_or_insert(part_of_unit[u]);
        }
    }
    let typed_part = carry(held);
    // The extraction's lines each typed line's spans name.
    let index: HashMap<&str, usize> = lines.iter().enumerate().filter_map(|(n, line)| Some((line["id"].as_str()?, n))).collect();
    let named = |t: usize| -> Vec<usize> {
        typed[t]["spans"].as_array().into_iter().flatten()
            .filter_map(|span| index.get(span["line_id"].as_str()?).copied()).collect()
    };
    let mut held: Vec<Option<usize>> = vec![None; lines.len()];
    for t in 0..typed.len() {
        for n in named(t) {
            held[n].get_or_insert(typed_part[t]);
        }
    }
    let line_part = carry(held);
    let mut line_parts: Vec<Vec<usize>> = line_part.iter().map(|&p| vec![p]).collect();
    let parts = (0..starts.len()).map(|p| {
        let kept_typed: Vec<usize> = (0..typed.len()).filter(|&t| typed_part[t] == p).collect();
        let new_typed: HashMap<usize, usize> = kept_typed.iter().enumerate().map(|(i, &t)| (t, i)).collect();
        // Its own lines, and any line of another part its typed lines also name.
        let named_here: HashSet<usize> = kept_typed.iter().flat_map(|&t| named(t)).collect();
        let kept_lines: Vec<usize> = (0..lines.len()).filter(|&n| line_part[n] == p || named_here.contains(&n)).collect();
        for &n in &kept_lines {
            if !line_parts[n].contains(&p) {
                line_parts[n].push(p);
            }
        }
        let mut new_unit = HashMap::new();
        let mut part_units = Vec::new();
        for u in (0..units.len()).filter(|&u| part_of_unit[u] == p) {
            let own: Vec<usize> = unit_typed(u).filter_map(|t| new_typed.get(&t).copied()).collect();
            if own.is_empty() {
                continue;
            }
            let mut unit = units[u].clone();
            unit["lines"] = json!(own);
            // The part is a document of its own: nothing in it starts another.
            unit["starts_document"] = json!(false);
            new_unit.insert(u, part_units.len());
            part_units.push(unit);
        }
        let notes: Vec<Value> = gold["notes"].as_array().into_iter().flatten().filter_map(|pair| {
            let line = new_typed.get(&(pair["line"].as_u64()? as usize))?;
            let note = pair["note"].as_u64().and_then(|n| new_unit.get(&(n as usize)));
            Some(json!({"line": line, "reference": pair["reference"], "note": note}))
        }).collect();
        let mut part = gold.clone();
        part["lines"] = json!(kept_lines.iter().map(|&n| &lines[n]).collect::<Vec<_>>());
        part["typed"] = json!(kept_typed.iter().map(|&t| &typed[t]).collect::<Vec<_>>());
        part["units"] = json!(part_units);
        part["notes"] = json!(notes);
        part
    }).collect();
    Ok((parts, line_parts))
}

/// Each extraction line (id, page) and the gold line that holds most of its characters, through the
/// alignment of the extraction's lines, every one in extraction order, to the whole gold. A line the
/// gold erased (its correction empty: scan noise) is matched by the text it was read as, which is
/// still the page's.
fn gold_lines_of(extracted: &legalpdf::ExtractedPdf, whole_gold: &Gold) -> Result<Vec<(String, usize, Option<usize>)>, String> {
    let mut reference = Side::of_gold(whole_gold)?;
    for (line, gold_line) in reference.lines.iter_mut().zip(&whole_gold.lines) {
        if gold_line.corrected.as_deref() == Some("") {
            line.text = gold_line.text.chars().collect();
        }
    }
    let whole = Side::of_lines(extracted.pages.iter().flat_map(|p| &p.lines).enumerate().map(|(k, line)| side::Line {
        id: line.id.clone(),
        page: line.page_index + 1,
        text: line.text.chars().collect(),
        spatial: (line.page_index + 1, k as f64, 0.0),
    }).collect());
    let alignment = alignment::align(&reference, &whole)?;
    Ok(alignment.mappings.iter().zip(whole.lines).map(|(mappings, line)| {
        let mut characters: BTreeMap<usize, usize> = BTreeMap::new();
        for &(start, end, r, _, _) in mappings {
            *characters.entry(r).or_default() += end - start;
        }
        (line.id, line.page, characters.iter().max_by_key(|(&r, &n)| (n, std::cmp::Reverse(r))).map(|(&r, _)| r))
    }).collect())
}

/// Each extraction line's parts: those of its gold line (`gold_lines_of`). A line the alignment
/// leaves unmatched takes the part of the matched line before it on its page, else of the one after
/// it on its page, else of the line before it.
fn extraction_parts(
    extracted: &legalpdf::ExtractedPdf,
    whole_gold: &Gold,
    line_parts: &[Vec<usize>],
) -> Result<HashMap<String, Vec<usize>>, String> {
    let lines = gold_lines_of(extracted, whole_gold)?;
    let held: Vec<Option<&[usize]>> = lines.iter().map(|(_, _, r)| r.map(|r| line_parts[r].as_slice())).collect();
    let page = |c: usize| lines[c].1;
    let mut parts = HashMap::new();
    let mut last = 0;
    for c in 0..lines.len() {
        let found = match held[c] {
            Some(found) => found.to_vec(),
            None => {
                let before = (0..c).rev().take_while(|&k| page(k) == page(c)).find_map(|k| held[k]);
                let after = (c + 1..lines.len()).take_while(|&k| page(k) == page(c)).find_map(|k| held[k]);
                vec![before.or(after).map_or(last, |found| found[0])]
            }
        };
        last = found[0];
        parts.insert(lines[c].0.clone(), found);
    }
    Ok(parts)
}

/// STRUCTURE_GOLD_ORACLE_LAYOUT: the gold's regions handed to the parser as a page layout model's
/// labels would be (the product's model's vocabulary, each gold unit one model region), on the
/// lines the model labels, so that the readers are measured as they read with a perfect layout
/// model. A line the alignment leaves unmatched keeps the extraction's reading.
fn oracle_layout(mut extracted: legalpdf::ExtractedPdf, whole_gold: &Gold) -> Result<legalpdf::ExtractedPdf, String> {
    if std::env::var_os("STRUCTURE_GOLD_ORACLE_LAYOUT").is_none() {
        return Ok(extracted);
    }
    let typed = whole_gold.typed.len();
    let mut unit_of = vec![None; typed];
    for (u, unit) in whole_gold.units.iter().enumerate() {
        for &t in unit.lines.iter().filter(|&&t| t < typed) {
            unit_of[t].get_or_insert(u);
        }
    }
    // Each gold line's typed line: the one holding most of its characters.
    let mut typed_of: HashMap<&str, (usize, usize)> = HashMap::new();
    for (t, typed) in whole_gold.typed.iter().enumerate() {
        for span in &typed.spans {
            let held = typed_of.entry(span.line_id.as_str()).or_insert((0, t));
            if span.end - span.start > held.0 {
                *held = (span.end - span.start, t);
            }
        }
    }
    let matched: HashMap<String, Option<usize>> = gold_lines_of(&extracted, whole_gold)?.into_iter().map(|(id, _, r)| (id, r)).collect();
    for page in &mut extracted.pages {
        for line in &mut page.lines {
            if line.exclude_from_body || line.text.trim().is_empty() || legal_pdf_core::is_heading_role(&line.source_tag) || line.source_tag == "LI" {
                continue;
            }
            let Some(&(_, t)) = matched.get(&line.id).copied().flatten().and_then(|r| typed_of.get(whole_gold.lines[r].id.as_str())) else {
                continue;
            };
            let top = line.bbox[1] + line.bbox[3] < page.height;
            line.source_tag = match whole_gold.typed[t].region.as_str() {
                "none" => continue,
                "heading" => "paragraph_title",
                "title" => "doc_title",
                "note" | "note_quote" => "footnote",
                "table" => "table",
                "contents" => "content",
                "caption" => "figure_title",
                "furniture" | "page_label" if top => "header",
                "furniture" | "page_label" => "footer",
                _ => "text",
            }
            .to_owned();
            line.region_id = format!("{}-ppdoc-r{:04}", page.id, unit_of[t].unwrap_or(10_000 + t));
        }
    }
    Ok(extracted)
}

/// The parser's input for one part: every page kept (per-page tables index pages by position),
/// holding only that part's lines and the regions over them.
fn input_part(mut extracted: legalpdf::ExtractedPdf, ids: &HashSet<&str>) -> legalpdf::ExtractedPdf {
    for page in &mut extracted.pages {
        page.lines.retain(|line| ids.contains(line.id.as_str()));
        page.regions.retain_mut(|region| {
            let had = !region.line_ids.is_empty();
            region.line_ids.retain(|id| ids.contains(id.as_str()));
            !had || !region.line_ids.is_empty()
        });
    }
    extracted
}

/// A source's grades: one, or with --parts one per document of a packet.
/// The parses of a group of sources resumed from the dump together, DOC read over all of them at once
/// (`legalpdf::gold_structure_resume`): each one's structure where its entry holds this build's parse of it (`current`), else
/// None, for `parse` to read; and the gold's side its entry keeps for this gold, where it keeps one (`gold_side`). Each
/// entry is read once.
type Resumed = (Option<Result<DocumentStructure, String>>, Option<Side>);

fn resumed(group: &[Source]) -> Vec<Resumed> {
    let Some(dump) = dump_folder() else { return group.iter().map(|_| (None, None)).collect() };
    let (mut sides, mut current, mut present) = (Vec::with_capacity(group.len()), Vec::with_capacity(group.len()), Vec::new());
    for source in group {
        let entry = legalpdf::Entry::read(&dump, &source.sha256);
        sides.push(entry.as_ref().and_then(|entry| kept_side(entry, source)));
        let entry = entry.filter(|entry| is_current(entry, source));
        current.push(entry.is_some());
        present.extend(entry.map(|entry| (source.sha256.clone(), entry)));
    }
    let mut read = legalpdf::gold_structure_resume(present, &inputs_root()).into_iter();
    group.iter().zip(sides).zip(current).map(|((source, side), current)| {
        let structure = (if current { read.next() } else { None })
            .map(|output| output.map(|output| output.structure_graph).map_err(|e| format!("{}: {e}", source.sha256)));
        (structure, side)
    }).collect()
}

fn grade_one(
    source: &Source,
    selected: Option<&PathBuf>,
    (resumed, side): Resumed,
) -> Result<Vec<(Option<usize>, Graded)>, String> {
    let gold_at = Instant::now();
    let read = || -> Result<Value, String> { read_gzip_json(&source.gold).map_err(|e| e.to_string()) };
    // Without --parts the gold is its own only part, its side read from the dump where kept.
    let parted = PARTS.load(Ordering::Relaxed) && selected.is_none();
    if !parted {
        let reference = gold_side(source, side, || serde_json::from_value(read()?).map_err(|e| e.to_string()))?;
        let started = Instant::now();
        let structure = match resumed.filter(|_| selected.is_none()) {
            Some(structure) => structure?,
            None => candidate(source, selected)?,
        };
        return Ok(vec![(None, score_structure(source, reference, &structure, gold_at, started)?)]);
    }
    let raw = read()?;
    let (parts, line_parts) = gold_parts(&raw)?;
    if parts.len() <= 1 {
        let reference = gold_side(source, None, || serde_json::from_value(parts.into_iter().next().unwrap_or(raw)).map_err(|e| e.to_string()))?;
        let started = Instant::now();
        let structure = candidate(source, selected)?;
        return Ok(vec![(None, score_structure(source, reference, &structure, gold_at, started)?)]);
    }
    // Each document of the packet is parsed on the extraction's lines that read as its gold's, which
    // the extraction aligned to the whole gold says.
    let started = Instant::now();
    let whole_gold: Gold = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    let read = || -> Result<legalpdf::ExtractedPdf, String> { oracle_layout(extracted(source)?, &whole_gold) };
    let parts_of = extraction_parts(&read()?, &whole_gold, &line_parts)?;
    let mut graded = Vec::new();
    for (k, part) in parts.into_iter().enumerate() {
        let expected: Gold = serde_json::from_value(part).map_err(|e| format!("part {}: {e}", k + 1))?;
        let started = if k == 0 { started } else { Instant::now() };
        let ids: HashSet<&str> = parts_of.iter().filter(|(_, parts)| parts.contains(&k)).map(|(id, _)| id.as_str()).collect();
        let document = legalpdf::gold_structure_document(input_part(read()?, &ids), &source.sha256, None)
            .map_err(|e| format!("{} part {}: {e}", source.sha256, k + 1))?;
        graded.push((Some(k + 1), score_structure(source, Side::of_gold(&expected)?, document.structure(), gold_at, started)?));
    }
    Ok(graded)
}

/// A source's gold as the scorer reads it (`Side::of_gold`): `kept`, its entry's (`kept_side`), else read from the gold
/// (`gold`) and kept in its entry.
fn gold_side(source: &Source, kept: Option<Side>, gold: impl FnOnce() -> Result<Gold, String>) -> Result<Side, String> {
    if let Some(side) = kept {
        return Ok(side);
    }
    let side = Side::of_gold(&gold()?)?;
    if let Some(dump) = dump_folder() {
        let bytes = rmp_serde::to_vec_named(&(gold_stamp(source)?, &side)).map_err(|e| e.to_string())?;
        let mut entry = legalpdf::Entry::read(&dump, &source.sha256).unwrap_or_default();
        entry.set_bytes("gold", &bytes);
        entry.write(&dump, &source.sha256).map_err(|e| format!("{}: {e}", source.sha256))?;
    }
    Ok(side)
}

fn score_structure(
    source: &Source,
    reference: Side,
    structure: &DocumentStructure,
    gold_at: Instant,
    started: Instant,
) -> Result<Graded, String> {
    let parsed_at = Instant::now();
    if structure
        .source_sha256
        .as_deref()
        .is_some_and(|sha| sha != source.sha256)
    {
        return Err("Candidate belongs to another PDF".into());
    }
    let predicted = Side::of_parse(structure)?;
    // STRUCTURE_GOLD_BLOCKS_DIR: both frames' blocks (kind, lines, locator, marker) per document, for
    // censuses of how the parser's units differ from the gold's.
    if let Some(dir) = std::env::var_os("STRUCTURE_GOLD_BLOCKS_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        let dump = |side: &Side| -> Vec<serde_json::Value> {
            side.blocks.iter().map(|g| {
                let mut lines: Vec<&str> = Vec::new();
                g.spans.iter().map(|s| side.lines[s.line].id.as_str()).for_each(|id| if !lines.contains(&id) { lines.push(id) });
                serde_json::json!({
                    "kind": g.kind,
                    "lines": lines,
                    "spans": g.spans.iter().map(|s| serde_json::json!([side.lines[s.line].id, s.start, s.end])).collect::<Vec<_>>(),
                    "region": g.region,
                    "locator": g.locator,
                    "marker": !g.marker.is_empty(),
                    "heading_level": g.heading_level,
                    "depth": g.depth,
                })
            }).collect()
        };
        let lines: Vec<serde_json::Value> = predicted.lines.iter().map(|l| serde_json::json!([l.id, l.page, l.text.iter().collect::<String>()])).collect();
        let fragments: Vec<&str> = structure.source_fragments.iter().map(|f| f.id.as_str()).collect();
        let _ = std::fs::write(dir.join(format!("{}.json", source.sha256)),
            serde_json::to_vec(&serde_json::json!({"gold": dump(&reference), "parser": dump(&predicted), "lines": lines, "fragments": fragments})).unwrap_or_default());
    }
    let compared_at = Instant::now();
    let unmarked = source.groups.get("label_source").is_some_and(|label| label == "a2aj-align");
    let score = score::compare_as(&reference, &predicted, unmarked)?;
    if std::env::var_os("STRUCTURE_GOLD_TIMING").is_some() {
        eprintln!("timing	{}	parsed_ms	{:.1}	compare_ms	{:.1}	gold_ms	{:.1}", &source.sha256[..12],
            (compared_at - parsed_at).as_secs_f64() * 1e3, compared_at.elapsed().as_secs_f64() * 1e3,
            (started - gold_at).as_secs_f64() * 1e3);
    }
    Ok(Graded {
        score,
        parse_ms: (parsed_at - started).as_secs_f64() * 1e3,
        score_ms: parsed_at.elapsed().as_secs_f64() * 1e3,
    })
}

fn metrics_json(metrics: &BTreeMap<&'static str, score::Metric>) -> Value {
    Value::Object(metrics.iter().map(|(name, m)| (name.to_string(), json!({
        "expected": m.expected, "predicted": m.predicted, "correct": m.correct, "f1": m.f1(),
    }))).collect())
}

fn pooled(rows: &[&Value]) -> BTreeMap<String, score::Metric> {
    let mut totals: BTreeMap<String, score::Metric> = BTreeMap::new();
    for row in rows {
        for (name, m) in row["metrics"].as_object().into_iter().flatten() {
            let field = |key: &str| m[key].as_u64().unwrap_or(0) as usize;
            totals.entry(name.clone()).or_default().add(&score::Metric {
                expected: field("expected"),
                predicted: field("predicted"),
                correct: field("correct"),
            });
        }
    }
    totals
}

fn totals_json(rows: &[&Value]) -> Value {
    Value::Object(pooled(rows).into_iter().map(|(name, m)| {
        let p = if m.predicted > 0 { m.correct as f64 / m.predicted as f64 } else { 1.0 };
        let r = if m.expected > 0 { m.correct as f64 / m.expected as f64 } else { 1.0 };
        (name, json!({"expected": m.expected, "predicted": m.predicted, "correct": m.correct, "precision": p, "recall": r, "f1": m.f1()}))
    }).collect())
}

/// The layers the apps read, first and by name; every other layer follows. A parse that does not
/// tell its body units apart is read for them as one kind (BODY_LAYERS); one that does, for
/// paragraphs, provisions and list items apart.
const BODY_LAYERS: [(&str, &str); 2] = [("units_body", "body units"), ("markers_body", "body markers")];
const FINE_LAYERS: [&str; 6] = ["markers_text", "units_text", "markers_provision", "units_provision", "units_list_item", "markers_list_item"];
const KEY_LAYERS: [(&str, &str); 18] = [
    ("page_numbers", "page numbers"),
    ("units_heading", "headings"),
    ("markers_text", "paragraph markers"),
    ("units_text", "paragraphs"),
    ("markers_provision", "numbered sections, clauses"),
    ("units_provision", "provisions"),
    ("units_list_item", "list items"),
    ("markers_list_item", "list markers"),
    ("note_references", "footnote links"),
    ("note", "footnote content"),
    ("heading_steps", "heading levels"),
    ("depth_steps", "body depths"),
    ("sequence_steps", "numbered sequences"),
    ("line_numbers", "transcript line numbers"),
    ("speakers", "speaker turns"),
    ("order", "reading order"),
    ("coverage", "text coverage"),
    ("transcription", "transcription (characters matched)"),
];

fn table(title: &str, totals: &BTreeMap<String, score::Metric>, fine: bool) {
    println!("
{title}");
    println!(
        "{:34} {:>8} {:>8} {:>6} {:>6} {:>6}",
        "layer", "exp", "pred", "P", "R", "F1"
    );
    let row = |name: &str, m: &score::Metric| {
        let p = if m.predicted > 0 { m.correct as f64 / m.predicted as f64 } else { 1.0 };
        let r = if m.expected > 0 { m.correct as f64 / m.expected as f64 } else { 1.0 };
        println!("{name:34} {:8} {:8} {p:6.3} {r:6.3} {:6.3}", m.expected, m.predicted, m.f1());
    };
    let shown: Vec<(&str, &str)> = if fine {
        KEY_LAYERS.into_iter().collect()
    } else {
        BODY_LAYERS.into_iter().chain(KEY_LAYERS.into_iter().filter(|(layer, _)| !FINE_LAYERS.contains(layer))).collect()
    };
    for (layer, label) in &shown {
        if let Some(m) = totals.get(*layer) {
            row(&format!("{label} [{layer}]"), m);
        }
    }
    println!("{:34} {:>8}", "  other layers", "");
    for (name, m) in totals {
        // The other reading's body layers stay out of the table (they remain in the summary).
        let other_reading = if fine { BODY_LAYERS.iter().any(|(layer, _)| layer == name) } else { FINE_LAYERS.contains(&name.as_str()) };
        if !shown.iter().any(|(layer, _)| layer == name) && !other_reading {
            row(name, m);
        }
    }
}

/// The layers a change is first read on: numbered paragraphs, provisions, footnotes and their links, headings, tables.
const LOSS_LAYERS: [&str; 8] = ["page_numbers", "markers_text", "markers_provision", "note", "note_references", "heading_steps", "markers_heading", "units_table"];

/// The change from earlier summaries (`before`, each a grade's JSON; several, one per split) over the runs both
/// scored: each layer's counts and F1 before and after, marked BELOW where it falls; the same by mode and on the main
/// yardstick; and for each of `LOSS_LAYERS` the net correct and spurious and the documents losing most.
fn against(before: &[Value], after: &[&Value]) {
    let earlier: BTreeMap<&str, &Value> = before.iter()
        .flat_map(|summary| summary["per_run"].as_array().into_iter().flatten())
        .filter_map(|row| Some((row["run"].as_str()?, row)))
        .collect();
    let common: Vec<(&Value, &Value)> = after
        .iter()
        .filter_map(|row| Some((*earlier.get(row["run"].as_str()?)?, *row)))
        .collect();
    delta_table(&format!("against the earlier summary: {} of {} runs graded before", common.len(), after.len()), &common);
    // Each split apart: development is the fit's measure, train what it has seen.
    for split in ["development", "train", "test"] {
        let chosen: Vec<(&Value, &Value)> = common.iter().copied().filter(|(_, a)| a["split"] == split).collect();
        if !chosen.is_empty() && chosen.len() < common.len() {
            delta_table(&format!("split={split}: {} runs", chosen.len()), &chosen);
        }
    }
    let mut modes: Vec<&str> = common.iter().filter_map(|(_, a)| a["mode"].as_str()).collect();
    modes.sort_unstable();
    modes.dedup();
    for mode in modes {
        let chosen: Vec<(&Value, &Value)> = common.iter().copied().filter(|(_, a)| a["mode"] == mode).collect();
        delta_table(&format!("mode={mode}: {} runs", chosen.len()), &chosen);
    }
    let main: Vec<(&Value, &Value)> = common.iter().copied().filter(|(b, a)| b["yardstick"] == "main" && a["yardstick"] == "main").collect();
    if !main.is_empty() && main.len() < common.len() {
        delta_table(&format!("yardstick=main: {} runs", main.len()), &main);
    }
    let count = |row: &Value, layer: &str, key: &str| row["metrics"][layer][key].as_i64().unwrap_or(0);
    for layer in LOSS_LAYERS {
        // Each moved document: its change in correct, its change in spurious, and the run.
        let mut moved: Vec<(i64, i64, &Value, &Value)> = common.iter().filter_map(|&(b, a)| {
            let (cb, ca) = (count(b, layer, "correct"), count(a, layer, "correct"));
            let (sb, sa) = (count(b, layer, "predicted") - cb, count(a, layer, "predicted") - ca);
            (cb != ca || sb != sa).then_some((ca - cb, sa - sb, b, a))
        }).collect();
        let (correct, spurious): (i64, i64) = (moved.iter().map(|m| m.0).sum(), moved.iter().map(|m| m.1).sum());
        println!("\n== {layer}: net correct {correct:+}, net spurious {spurious:+} over {} documents", moved.len());
        let name = |a: &Value| format!("{}/{}/{}", &a["run"].as_str().unwrap_or_default()[..10],
            &a["mode"].as_str().unwrap_or_default().chars().take(3).collect::<String>(), a["genre_group"].as_str().unwrap_or_default());
        moved.sort_by_key(|m| m.0);
        let lost: Vec<String> = moved.iter().take_while(|m| m.0 < 0).take(8)
            .map(|m| format!("{}:{}>{}", name(m.3), count(m.2, layer, "correct"), count(m.3, layer, "correct"))).collect();
        println!("   lost     {}", lost.join(" "));
        moved.sort_by_key(|m| std::cmp::Reverse(m.1));
        let extra: Vec<String> = moved.iter().take_while(|m| m.1 > 0).take(6)
            .map(|m| format!("{}:{}>{}", name(m.3), count(m.2, layer, "predicted") - count(m.2, layer, "correct"),
                count(m.3, layer, "predicted") - count(m.3, layer, "correct"))).collect();
        println!("   spurious {}", extra.join(" "));
    }
}

fn delta_table(title: &str, common: &[(&Value, &Value)]) {
    let f1 = |m: &Value| {
        let field = |key: &str| m[key].as_u64().unwrap_or(0) as f64;
        let (e, p, c) = (field("expected"), field("predicted"), field("correct"));
        if e + p == 0.0 {
            1.0
        } else {
            2.0 * c / (e + p)
        }
    };
    let (left, right): (Vec<&Value>, Vec<&Value>) = common.iter().copied().unzip();
    let (pooled_before, pooled_after) = (pooled(&left), pooled(&right));
    println!("\n{title}");
    println!(
        "{:22} {:>10}  {:>7} {:>9} {:>9}  {:>7} {:>9} {:>9}  {:>7}  {:>6} {:>6}",
        "layer", "expected", "F1 before", "correct", "predicted", "after", "correct", "predicted", "delta", "better", "worse"
    );
    for (name, m) in &pooled_after {
        let (mut better, mut worse) = (0, 0);
        for (b, a) in common {
            let (Some(x), Some(y)) = (b["metrics"].get(name), a["metrics"].get(name)) else {
                continue;
            };
            let delta = f1(y) - f1(x);
            better += usize::from(delta > 1e-9);
            worse += usize::from(delta < -1e-9);
        }
        let earlier = pooled_before.get(name).cloned().unwrap_or_default();
        let below = if m.f1() < earlier.f1() - 0.0002 { "  BELOW" } else { "" };
        println!(
            "{name:22} {:10}  {:7.4} {:9} {:9}  {:7.4} {:9} {:9}  {:+7.4}  {better:6} {worse:6}{below}",
            m.expected, earlier.f1(), earlier.correct, earlier.predicted, m.f1(), m.correct, m.predicted, m.f1() - earlier.f1()
        );
    }
}

fn grade(store: &Path, options: &[String]) -> Result<(), String> {
    // The citation grammar's tables and regexes compile on first use; pay that once, outside
    // any document's timing.
    legal_pdf_core::profile::measure("warmup.citations", || {
        let _ = legal_structure::analysis::citation_spans("R. v. White, 2020 NSCA 33, [2008] 2 S.C.R. 3, para. 12.");
    });
    let flag = |name: &str| options.iter().any(|o| o == name);
    let value = |name: &str| {
        options
            .iter()
            .position(|o| o == name)
            .and_then(|n| options.get(n + 1))
            .cloned()
    };
    let inventory = value("--candidates");
    if flag("--candidates") && inventory.as_deref().is_none_or(|v| v.starts_with("--")) {
        return Err("--candidates requires an inventory file".into());
    }
    let selected = candidates(inventory.as_deref())?;
    PARTS.store(flag("--parts"), Ordering::Relaxed);
    // The parser's structure tells paragraphs, provisions and list items apart, and they are read apart.
    let fine = true;
    let split = value("--split");
    let mut groups = Vec::new();
    for (n, option) in options.iter().enumerate().filter(|(_, o)| *o == "--group") {
        let (field, value) = options.get(n + 1).and_then(|v| v.split_once('='))
            .filter(|(field, value)| GROUP_FIELDS.contains(field) && !value.is_empty())
            .ok_or_else(|| format!("{option} requires FIELD=VALUE; fields: {}", GROUP_FIELDS.join(", ")))?;
        groups.push((field, value));
    }
    let prefixes: Vec<&String> = options
        .iter()
        .skip_while(|o| *o != "--runs")
        .skip(1)
        .take_while(|o| !o.starts_with("--"))
        .collect();
    // Only the sources the runs name are read (and the candidates, which must each have one).
    let all = sources_where(store, |sha| prefixes.is_empty() || prefixes.iter().any(|p| sha.starts_with(p.as_str())) || selected.contains_key(sha))?;
    for sha in selected.keys() {
        if !all.iter().any(|s| &s.sha256 == sha) {
            return Err(format!("Candidate {sha} has no completed gold"));
        }
    }
    let all: Vec<Source> = all
        .into_iter()
        .filter(|s| inventory.is_none() || selected.contains_key(&s.sha256))
        .filter(|s| groups.iter().all(|(field, value)| s.groups[*field] == *value))
        .filter(|s| {
            split
                .as_deref()
                .map_or(s.split != "test", |want| want == "all" || s.split == want)
        })
        .filter(|s| {
            prefixes.is_empty() || prefixes.iter().any(|p| s.sha256.starts_with(p.as_str()))
        })
        .collect();
    if all.is_empty() {
        return Err("No documents selected".into());
    }
    let started = Instant::now();
    let weight = |s: &Source| {
        std::fs::metadata(&s.gold)
            .map_or(0, |m| m.len())
    };
    // The sources in groups, each group's parses resumed from the dump together (DOC read over all of them at once),
    // then each source graded.
    let groups: Vec<&[Source]> = all.chunks(GROUP).collect();
    let results: Vec<_> = parallel(&groups, |group| group.iter().map(&weight).sum(), |group| {
        let resumed = resumed(group);
        group.iter().zip(resumed).map(|(source, resumed)| {
            let began = Instant::now();
            let result = grade_one(source, selected.get(&source.sha256), resumed);
            if began.elapsed().as_secs() >= 10 {
                eprintln!("slow: {} took {:.0}s", source.sha256, began.elapsed().as_secs_f64());
            }
            result
        }).collect::<Vec<_>>()
    }).into_iter().flatten().collect();
    let elapsed = started.elapsed().as_secs_f64();
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    let (mut parse_ms, mut score_ms) = (0.0, 0.0);
    for (source, result) in all.iter().zip(results) {
        match result {
            Ok(parts) => for (part, graded) in parts {
                parse_ms += graded.parse_ms;
                score_ms += graded.score_ms;
                let s = &graded.score;
                // Transcription stands beside the structure layers: gold characters the parser's
                // text reproduces, so recognition quality is read on its own row.
                let mut metrics = s.metrics.clone();
                metrics.insert("transcription", score::Metric {
                    expected: s.text.characters, predicted: s.text.characters, correct: s.text.matched_characters,
                });
                let run = part.map_or_else(|| source.sha256.clone(), |k| format!("{}#{k}", source.sha256));
                rows.push(json!({
                    "run": run, "part": part, "source_sha256": source.sha256, "mode": source.mode, "split": source.split,
                    "language_layout": source.groups["language_layout"], "genre_group": source.groups["genre_group"],
                    "country": source.groups["country"], "yardstick": source.groups["yardstick"], "label_source": source.groups["label_source"],
                    "parse_ms": graded.parse_ms.round(),
                    "alignment": s.alignment,
                    "text": s.text, "metrics": metrics_json(&metrics),
                }));
            }
            Err(error) => {
                errors.push(json!({"run": source.sha256.clone(), "error": error}))
            }
        }
    }
    let refs: Vec<&Value> = rows.iter().collect();
    let totals = totals_json(&refs);
    let mut totals_by = Map::new();
    let mut splits: Vec<&str> = rows.iter().filter_map(|r| r["split"].as_str()).collect();
    splits.sort_unstable();
    splits.dedup();
    splits.sort_by_key(|s| match *s { "train" => 0, "development" => 1, "test" => 2, _ => 3 });
    for split in splits {
        let chosen: Vec<&Value> = rows.iter().filter(|r| r["split"] == split).collect();
        table(&format!("{split}: {} documents", chosen.len()), &pooled(&chosen), fine);
        let mut fields = Map::new();
        for field in ["yardstick", "language_layout", "genre_group"] {
            let mut grouped: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
            for row in &chosen {
                if field == "genre_group" && row["yardstick"] != "main" {
                    continue;
                }
                grouped.entry(row[field].as_str().unwrap_or("unknown")).or_default().push(row);
            }
            let mut values = Map::new();
            for (value, members) in grouped {
                let scope = if field == "genre_group" { " / yardstick=main" } else { "" };
                table(&format!("{split}{scope} / {field}={value}: {} documents", members.len()), &pooled(&members), fine);
                values.insert(value.to_owned(), totals_json(&members));
            }
            fields.insert(field.to_owned(), Value::Object(values));
        }
        totals_by.insert(split.to_owned(), Value::Object(fields));
    }
    let summary = json!({
        "source": if inventory.is_some() { "candidates" } else { "parse" },
        "candidates": inventory, "elapsed_seconds": elapsed, "runs": rows.len() + errors.len(), "errors": errors,
        "totals": totals, "totals_by": totals_by, "per_run": rows,
    });
    let out = value("--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_home().join("gold-grade.json"));
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &out,
        serde_json::to_vec(&summary).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if flag("--show") {
        for row in &rows {
            let layers = row["metrics"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, m)| format!("{k}={:.2}", m["f1"].as_f64().unwrap_or(0.0)))
                .collect::<Vec<_>>()
                .join(" ");
            println!(
                "{} {layers}",
                row["source_sha256"].as_str().unwrap_or_default()
            );
        }
    }
    // --against FILE[,FILE...]: earlier grades (one per split, as they were written) to read this one against.
    if let Some(paths) = value("--against") {
        let earlier = paths.split(',').map(|path| read_json(Path::new(path))).collect::<Result<Vec<Value>, String>>()?;
        against(&earlier, &refs);
    }
    for error in summary["errors"].as_array().into_iter().flatten() {
        eprintln!("ERROR {} {}", error["run"], error["error"]);
    }
    // (The stages' times not yet written: the last parse's own, and what runs after it.)
    legal_pdf_core::profile::tallied();
    eprintln!(
        "\n{} documents, {} errors -> {} in {elapsed:.1}s (reading and parsing {:.1}s, scoring {:.1}s, summed document times)",
        rows.len(),
        summary["errors"].as_array().map_or(0, Vec::len),
        out.display(),
        parse_ms / 1e3,
        score_ms / 1e3
    );
    if !errors.is_empty() {
        return Err(format!(
            "{} documents failed; see {}",
            errors.len(),
            out.display()
        ));
    }
    Ok(())
}

/// The gold against itself through the scorer (must be 1.0 everywhere), and the gold's own labels
/// decoded over the gold's own lines, order, markers and notes (any shortfall is the label
/// encoding or the decoder, never the gold): `selfcheck STORE self|labels`.
/// `self`: the gold against itself; `labels`: the gold's own labels decoded; `agree --run R`:
/// the gold against the same source's gold of run R (structure/<batch>-R), authored independently,
/// which is how far two authorings agree (sources without that run are left out).
fn selfcheck(store: &Path, mode: &str, options: &[String]) -> Result<(), String> {
    let value = |name: &str| options.iter().position(|o| o == name).and_then(|n| options.get(n + 1)).cloned();
    let split = value("--split");
    let run = value("--run");
    if !matches!(mode, "self" | "agree") {
        return Err("selfcheck's mode is self or agree".into());
    }
    if mode == "agree" && run.is_none() {
        return Err("agree needs --run R".into());
    }
    let other = |source: &Source| run.as_deref().and_then(|r| run_gold(&store.join(&source.sha256), r));
    let all: Vec<Source> = sources(store)?.into_iter()
        .filter(|s| split.as_deref().map_or(s.split != "test", |want| s.split == want))
        .filter(|s| mode != "agree" || other(s).is_some()).collect();
    let results = parallel(&all, |_| 0, |source| -> Result<score::Score, String> {
        let read = |path: &Path| -> Result<Gold, String> { read_gzip_json(path).map_err(|e| e.to_string()) };
        let expected = read(&source.gold)?;
        let reference = Side::of_gold(&expected)?;
        let candidate = if mode == "self" { Side::of_gold(&expected)? } else { Side::of_gold(&read(&other(source).expect("filtered above"))?)? };
        score::compare(&reference, &candidate)
    });
    let mut totals: BTreeMap<&str, score::Metric> = BTreeMap::new();
    let mut errors = 0;
    for (source, result) in all.iter().zip(&results) {
        match result {
            Ok(score) => for (name, m) in &score.metrics { totals.entry(name).or_default().add(m); },
            Err(error) => { errors += 1; eprintln!("ERROR {} {error}", &source.sha256[..12]); }
        }
    }
    println!("{mode}: {} documents, {errors} errors", all.len());
    for (name, m) in totals {
        println!("{name:22} {:8} {:8} {:8} {:.4}", m.expected, m.predicted, m.correct, m.f1());
    }
    // The documents losing most on each named layer: missed plus spurious items.
    for layer in value("--worst").map(|l| l.split(',').map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default() {
        let mut lost: Vec<(usize, &str)> = all.iter().zip(&results).filter_map(|(source, result)| {
            let m = result.as_ref().ok()?.metrics.get(layer.as_str())?;
            let lost = m.expected + m.predicted - 2 * m.correct;
            (lost > 0).then_some((lost, source.sha256.as_str()))
        }).collect();
        lost.sort_by(|a, b| b.cmp(a));
        let total: usize = lost.iter().map(|l| l.0).sum();
        println!("{layer}: {total} lost in {} documents; worst {}", lost.len(),
            lost.iter().take(8).map(|(n, sha)| format!("{}:{n}", &sha[..12])).collect::<Vec<_>>().join(" "));
    }
    Ok(())
}

/// One document's missed and spurious items, layer by layer.
fn explain(store: &Path, prefix: &str, options: &[String]) -> Result<(), String> {
    // PREFIX names one gold, or @FILE many (a SHA prefix a line), explained in turn over one reading of the store.
    let prefixes: Vec<String> = match prefix.strip_prefix('@') {
        Some(file) => std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?.lines()
            .map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect(),
        None => vec![prefix.to_owned()],
    };
    let all = sources(store)?;
    for prefix in &prefixes {
        let source = all.iter().find(|s| s.sha256.starts_with(prefix.as_str())).ok_or_else(|| format!("No such gold: {prefix}"))?;
        if let Err(error) = explain_one(source, options) {
            println!("{} ({}, {}): {error}", source.sha256, source.mode, source.split);
        }
    }
    Ok(())
}

fn explain_one(source: &Source, options: &[String]) -> Result<(), String> {
    let value = |name: &str| {
        options
            .iter()
            .position(|o| o == name)
            .and_then(|n| options.get(n + 1))
            .cloned()
    };
    let expected: Gold =
        read_gzip_json(&source.gold)
            .map_err(|e| e.to_string())?;
    let inventory = value("--candidates");
    if options.iter().any(|o| o == "--candidates")
        && inventory.as_deref().is_none_or(|v| v.starts_with("--"))
    {
        return Err("--candidates requires an inventory file".into());
    }
    let selected = candidates(inventory.as_deref())?;
    if inventory.is_some() && !selected.contains_key(&source.sha256) {
        return Err("No candidate selected for this source".into());
    }
    let structure = candidate(
        source,
        selected.get(&source.sha256),
    )?;
    let layers: Vec<String> = value("--layers")
        .map(|l| l.split(',').map(str::to_owned).collect())
        .unwrap_or_default();
    let limit = value("--limit").and_then(|n| n.parse().ok()).unwrap_or(40);
    if options.iter().any(|o| o == "--tree") {
        // The parser's own node tree: kind, role, grammar, label and the start of its text.
        let text: Vec<u16> = structure.text.encode_utf16().collect();
        let parents: HashMap<&str, &str> = structure.nodes.iter()
            .filter_map(|n| n.parent_id.as_deref().map(|p| (n.id.as_str(), p))).collect();
        for node in structure.nodes.iter().filter(|n| n.kind != legal_structure_model::NodeKind::Page) {
            let (mut depth, mut at) = (0, node.id.as_str());
            while let Some(p) = parents.get(at) { depth += 1; at = p; }
            let range = node.heading_range.as_ref().unwrap_or(&node.range);
            let end = range.end.min(range.start + 70).min(text.len());
            let snippet = String::from_utf16_lossy(&text[range.start.min(end)..end]).replace('\n', " / ");
            println!("{}{:?} {:?} {} {} [{}] {}..{} {} {snippet:?}", "  ".repeat(depth), node.kind, node.role,
                node.grammar.as_deref().unwrap_or("-"), node.label.as_deref().unwrap_or("-"),
                node.line_ids.first().map(String::as_str).unwrap_or("-"), node.range.start, node.range.end, node.origin_id);
        }
    }
    let candidate_state = Side::of_parse(&structure)?;
    let text = score::explain(
        &Side::of_gold(&expected)?,
        &candidate_state,
        &layers,
        limit,
    )?;
    println!(
        "{} ({}, {}){text}",
        source.sha256, source.mode, source.split
    );
    Ok(())
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let result = match arguments.as_slice() {
        [command, store, options @ ..] if command == "grade" => grade(Path::new(store), options),
        [command, store] if command == "inputs" => inputs(Path::new(store)),
        [command, store, out] if command == "digest" => digest(Path::new(store), Path::new(out)),
        [command, store, out] if command == "labels" => labels(Path::new(store), Some(Path::new(out))),
        [command, store, dump, out, options @ ..] if command == "training" => training(Path::new(store), Path::new(dump), Path::new(out), options),
        [command, gold, out, options @ ..] if command == "footnotes" => footnotes(Path::new(gold), Path::new(out), options),
        [command, dir, out] if command == "docx-digest" => docx_digest(Path::new(dir), Path::new(out)),
        [command, store, out] if command == "extract-digest" => extract_digest(Path::new(store), Path::new(out)),
        [command, store, out, pack, runtime, step] if command == "layout-digest" => step
            .parse()
            .map_err(|_| "STEP must be a number".to_owned())
            .and_then(|step| layout_digest(Path::new(store), Path::new(out), Path::new(pack), Path::new(runtime), step)),
        [command, store, mode, options @ ..] if command == "selfcheck" => selfcheck(Path::new(store), mode, options),
        [command, store, prefix, options @ ..] if command == "explain" => explain(Path::new(store), prefix, options),
        _ => Err("usage: structure-gold inputs|digest|docx-digest|extract-digest|grade|labels|training|footnotes|explain|selfcheck STORE [SHA|OUT|MODE] [options]".into()),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
