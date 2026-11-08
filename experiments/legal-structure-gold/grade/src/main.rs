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
//!       gold-grade.json in the data home unless --out names another file. Totals are pooled per split; test is left out unless asked.
//!       --candidates reads the existing OCR cache manifest (inputs: source_sha256, candidate),
//!       scores only its exports, and never selects them by gold line IDs.
//!       --group FIELD=VALUE keeps matching source groups; repeat to require every match.
//!       --parts grades each document of a packet on its own (run <sha>#k): the gold cut at its
//!       document starts, the parser run on the extraction's lines that align to that document.
//!   structure-gold digest STORE OUT
//!       each source's parse hashed, nothing graded: `sha<TAB>digest` per document, every split; two builds parse the
//!       same where their files are (`fc /b`, `cmp`).
//!   structure-gold explain STORE SHA_PREFIX [--candidates FILE] [--layers a,b] [--limit N]
//!       one document's missed (-) and spurious (+) items per layer, as text.
//!   structure-gold selfcheck STORE self|agree [--run R] [--split S] [--worst a,b]
//!   structure-gold pairing STORE SHA_PREFIX [FIRST-LAST]
//!   structure-gold paragraph-data STORE OUT_DIR
//!       exports Rust boundary features and fixed-gold targets, excluding test.
mod paragraph_data;
mod paragraph_features;
mod score;

/// mimalloc, whose threads allocate from heaps of their own: on Windows' process heap the
/// documents graded at once waited on its lock for 70% of their time (a stack sample of the
/// whole store on twelve threads).
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

use legal_pdf_frame::{alignment, state, text_diff};

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
    let mut found = Vec::new();
    let mut held = 0;
    for entry in std::fs::read_dir(store).map_err(|e| format!("{}: {e}", store.display()))? {
        let folder = entry.map_err(|e| e.to_string())?.path();
        let Some(sha256) = folder.file_name().and_then(|n| n.to_str()).filter(|n| n.len() == 64).map(str::to_owned) else {
            continue;
        };
        let Some(gold) = run_gold(&folder, "a") else {
            continue;
        };
        let source = read_json(&folder.join("source.json"))?;
        if !source["hold"].is_null() {
            held += 1;
            continue;
        }
        let receipt = read_json(&gold.with_file_name("receipt.json"))?;
        let pdf = local(source["pdf"].as_str().ok_or_else(|| format!("{sha256}: source.json without pdf"))?);
        found.push(Source {
            mode: receipt["mode"].as_str().unwrap_or_default().to_owned(),
            split: source["partition"].as_str().ok_or_else(|| format!("{sha256}: source.json without partition"))?.to_owned(),
            groups: GROUP_FIELDS.iter().map(|&field| (
                field.to_owned(), source[field].as_str().unwrap_or("unknown").to_owned(),
            )).collect(),
            pdf: if pdf.is_absolute() { pdf } else { data_home().join(pdf) },
            gold,
            sha256,
        });
    }
    found.sort_by(|a, b| a.sha256.cmp(&b.sha256));
    if held > 0 {
        eprintln!("{held} sources held for repair (gold_store.py holds)");
    }
    Ok(found)
}

/// The structure-stage inputs this build makes, under the identity of the code and models that make
/// them (`legalpdf::gold_inputs_identity`), so a build never grades another build's pages: in
/// STRUCTURE_GOLD_INPUTS where set, else gold-inputs/ in the data home.
fn inputs_dir() -> PathBuf {
    std::env::var_os("STRUCTURE_GOLD_INPUTS")
        .map_or_else(|| data_home().join("gold-inputs"), PathBuf::from)
        .join(legalpdf::gold_inputs_identity())
}

/// Run `work` over the sources on every core, longest first, keeping each result in place.
fn parallel<T: Send>(
    sources: &[Source],
    weight: impl Fn(&Source) -> u64,
    work: impl Fn(&Source) -> T + Sync,
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
    let destination = inputs_dir();
    std::fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let results = parallel(
        &all,
        |s| std::fs::metadata(&s.pdf).map_or(0, |m| m.len()),
        |source| -> Result<(), String> {
            let target = destination.join(format!("{}.json.gz", source.sha256));
            if target.is_file() {
                return Ok(());
            }
            let pdf =
                std::fs::read(&source.pdf).map_err(|e| format!("{}: {e}", source.pdf.display()))?;
            // The PDF read as a parse of this build reads it, through the product's caches beside the
            // gold; nothing is chosen by the gold, which the scorer aligns to whatever lines these are.
            let extracted = legalpdf::gold_structure_inputs(&pdf, &data_home().join("gold-parsed").join(&source.sha256))
                .map_err(|e| format!("{}: {e}", source.sha256))?;
            write_gzip_json(&target, &extracted).map_err(|e| e.to_string())
        },
    );
    let failed: Vec<&String> = results.iter().filter_map(|r| r.as_ref().err()).collect();
    for error in &failed {
        eprintln!("ERROR {error}");
    }
    eprintln!(
        "{} inputs, {} failed, in {:.1}s, in {}",
        all.len(),
        failed.len(),
        started.elapsed().as_secs_f64(),
        destination.display()
    );
    Ok(())
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

/// The structure stage over a source's inputs, with the pages it wrote. With STRUCTURE_GOLD_DUMP
/// naming a folder, each source's structure and pages are kept there (<sha>.structure.json.gz,
/// <sha>.pages.json.gz), for comparing two builds' parses byte for byte.
fn parse(source: &Source) -> Result<(DocumentStructure, Vec<legal_pdf_core::model::Page>), String> {
    let read_at = Instant::now();
    let extracted: legalpdf::ExtractedPdf = read_gzip_json(&inputs_dir().join(format!("{}.json.gz", source.sha256)))
        .map_err(|e| format!("{}: {e}", source.sha256))?;
    let extracted = if std::env::var_os("STRUCTURE_GOLD_ORACLE_LAYOUT").is_some() {
        let whole: state::Gold = read_gzip_json(&source.gold).map_err(|e| e.to_string())?;
        oracle_layout(extracted, &whole)?
    } else {
        extracted
    };
    let structure_at = Instant::now();
    let mut pages = Vec::new();
    let document = legalpdf::gold_structure_document(extracted, &source.sha256, Some(&mut pages))
        .map_err(|e| format!("{}: {e}", source.sha256))?;
    if std::env::var_os("STRUCTURE_GOLD_TIMING").is_some() {
        eprintln!("timing	{}	inputs_ms	{:.1}	structure_ms	{:.1}", &source.sha256[..12],
            (structure_at - read_at).as_secs_f64() * 1e3, structure_at.elapsed().as_secs_f64() * 1e3);
    }
    let structure = document.structure().clone();
    if let Some(folder) = std::env::var_os("STRUCTURE_GOLD_DUMP").map(PathBuf::from) {
        std::fs::create_dir_all(&folder).map_err(|e| format!("{}: {e}", folder.display()))?;
        write_gzip_json(&folder.join(format!("{}.pages.json.gz", source.sha256)), &pages)
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
    let inputs = |s: &Source| std::fs::metadata(inputs_dir().join(format!("{}.json.gz", s.sha256))).map_or(0, |m| m.len());
    let digests = parallel(&all, inputs, |source| {
        let (structure, pages) = parse(source)?;
        let mut hasher = sha2::Sha256::new();
        hasher.update(serde_json::to_vec(&pages).map_err(|e| e.to_string())?);
        hasher.update(serde_json::to_vec(&structure).map_err(|e| e.to_string())?);
        Ok::<_, String>(format!("{:x}", hasher.finalize()))
    });
    let mut lines: Vec<String> = all.iter().zip(digests).map(|(source, digest)| format!("{}\t{}", source.sha256, digest.unwrap_or_else(|e| format!("error {e}")))).collect();
    lines.sort();
    std::fs::write(out, lines.join("\n") + "\n").map_err(|e| format!("{}: {e}", out.display()))
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
            let mut extracted = extract_pdf(&pdf, None, None).map_err(|e| e.to_string())?;
            recognize_pdf(&pdf, &mut extracted, None, None).map_err(|e| e.to_string())?;
            extracted.pages.iter_mut().for_each(mark_rule_underlines);
            serde_json::to_vec(&extracted).map_err(|e| e.to_string())
        });
        format!("{:x}", sha2::Sha256::digest(read.unwrap_or_else(|error| format!("error {error}").into_bytes())))
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
            let mut extracted = legal_pdf_extraction_processor::extract_pdf(&pdf, None, None).map_err(|e| e.to_string())?;
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
        format!("{:x}", sha2::Sha256::digest(read.unwrap_or_else(|error| format!("error {error}").into_bytes())))
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
        format!("{}\t{:x}", path.strip_prefix(dir).unwrap_or(path).display(), hasher.finalize())
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
fn gold_lines_of(extracted: &legalpdf::ExtractedPdf, whole_gold: &state::Gold) -> Result<Vec<(String, usize, Option<usize>)>, String> {
    let mut reference = state::projected(whole_gold)?;
    for (line, gold_line) in reference.lines.iter_mut().zip(&whole_gold.lines) {
        if gold_line.corrected.as_deref() == Some("") {
            line.text = gold_line.text.chars().collect();
        }
    }
    let lines: Vec<state::Line> = extracted.pages.iter().flat_map(|p| &p.lines).enumerate().map(|(k, line)| state::Line {
        id: line.id.clone(),
        page: line.page_index + 1,
        text: line.text.chars().collect(),
        spatial: (line.page_index + 1, k as f64, 0.0),
    }).collect();
    let whole = state::State {
        index: lines.iter().enumerate().map(|(n, l)| (l.id.clone(), n)).collect(),
        reading_order: (0..lines.len()).collect(),
        lines,
        span_rank: HashMap::new(),
        groups: Vec::new(),
        annotations: Vec::new(),
        continuations: Default::default(),
    };
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
    whole_gold: &state::Gold,
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
fn oracle_layout(mut extracted: legalpdf::ExtractedPdf, whole_gold: &state::Gold) -> Result<legalpdf::ExtractedPdf, String> {
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
            if line.exclude_from_body || line.text.trim().is_empty() || legal_pdf_core::is_heading_role(&line.region_type) || line.region_type == "LI" {
                continue;
            }
            let Some(&(_, t)) = matched.get(&line.id).copied().flatten().and_then(|r| typed_of.get(whole_gold.lines[r].id.as_str())) else {
                continue;
            };
            let top = line.bbox[1] + line.bbox[3] < page.height;
            line.region_type = match whole_gold.typed[t].region.as_str() {
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
fn grade_one(
    source: &Source,
    selected: Option<&PathBuf>,
) -> Result<Vec<(Option<usize>, Graded)>, String> {
    let gold_at = Instant::now();
    let raw: Value = read_gzip_json(&source.gold).map_err(|e| e.to_string())?;
    // Without --parts the gold is its own only part.
    let (parts, line_parts) = if PARTS.load(Ordering::Relaxed) && selected.is_none() { gold_parts(&raw)? } else { (Vec::new(), Vec::new()) };
    if parts.len() <= 1 {
        let expected: state::Gold = serde_json::from_value(parts.into_iter().next().unwrap_or(raw)).map_err(|e| e.to_string())?;
        let started = Instant::now();
        let structure = candidate(source, selected)?;
        return Ok(vec![(None, score_structure(source, &expected, &structure, gold_at, started)?)]);
    }
    // Each document of the packet is parsed on the extraction's lines that read as its gold's, which
    // the extraction aligned to the whole gold says.
    let started = Instant::now();
    let path = inputs_dir().join(format!("{}.json.gz", source.sha256));
    let whole_gold: state::Gold = serde_json::from_value(raw).map_err(|e| e.to_string())?;
    let read = || -> Result<legalpdf::ExtractedPdf, String> {
        oracle_layout(read_gzip_json(&path).map_err(|e| format!("{}: {e}", source.sha256))?, &whole_gold)
    };
    let parts_of = extraction_parts(&read()?, &whole_gold, &line_parts)?;
    let mut graded = Vec::new();
    for (k, part) in parts.into_iter().enumerate() {
        let expected: state::Gold = serde_json::from_value(part).map_err(|e| format!("part {}: {e}", k + 1))?;
        let started = if k == 0 { started } else { Instant::now() };
        let ids: HashSet<&str> = parts_of.iter().filter(|(_, parts)| parts.contains(&k)).map(|(id, _)| id.as_str()).collect();
        let document = legalpdf::gold_structure_document(input_part(read()?, &ids), &source.sha256, None)
            .map_err(|e| format!("{} part {}: {e}", source.sha256, k + 1))?;
        graded.push((Some(k + 1), score_structure(source, &expected, document.structure(), gold_at, started)?));
    }
    Ok(graded)
}

fn score_structure(
    source: &Source,
    expected: &state::Gold,
    structure: &DocumentStructure,
    gold_at: Instant,
    started: Instant,
) -> Result<Graded, String> {
    let parsed_at = Instant::now();
    if structure
        .source_sha256
        .as_deref()
        .is_some_and(|sha| sha != expected.source_sha256)
    {
        return Err("Candidate belongs to another PDF".into());
    }
    let reference = state::projected(expected)?;
    let predicted = state::parsed(structure)?;
    // STRUCTURE_GOLD_BLOCKS_DIR: both frames' blocks (kind, lines, locator, marker) per document, for
    // censuses of how the parser's units differ from the gold's.
    if let Some(dir) = std::env::var_os("STRUCTURE_GOLD_BLOCKS_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        let dump = |state: &state::State| -> Vec<serde_json::Value> {
            state.groups.iter().map(|g| serde_json::json!({
                "kind": g.kind,
                "lines": g.line_ids,
                "spans": g.spans.iter().map(|s| serde_json::json!([s.line_id, s.start, s.end])).collect::<Vec<_>>(),
                "region": g.attributes.get("region"),
                "locator": g.attributes.get("locator_kind"),
                "marker": g.attributes.get("marker").map(|m| !m.is_null() && m.as_array().is_some_and(|a| !a.is_empty())).unwrap_or(false),
                "heading_level": g.attributes.get("heading_level"),
                "depth": g.attributes.get("depth"),
            })).collect()
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
const KEY_LAYERS: [(&str, &str); 17] = [
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

/// The change from an earlier summary over the runs both scored: pooled F1 per layer, and per
/// document how many got better or worse.
fn against(before: &Value, after: &[&Value]) {
    let earlier: BTreeMap<&str, &Value> = before["per_run"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| Some((row["source_sha256"].as_str()?, row)))
        .collect();
    let common: Vec<(&Value, &Value)> = after
        .iter()
        .filter_map(|row| Some((*earlier.get(row["source_sha256"].as_str()?)?, *row)))
        .collect();
    delta_table("against the earlier summary", &common);
    let main: Vec<(&Value, &Value)> = common.into_iter()
        .filter(|(b, a)| b["yardstick"] == "main" && a["yardstick"] == "main").collect();
    if !main.is_empty() {
        delta_table("against the earlier summary / yardstick=main", &main);
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
    println!(
        "\n{title}: {} runs in common",
        common.len()
    );
    println!(
        "{:22} {:>9} {:>7} {:>7}   {:>6} {:>6}",
        "layer", "F1 before", "after", "delta", "better", "worse"
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
        let b = pooled_before.get(name).map_or(0.0, |m| m.f1());
        println!(
            "{name:22} {b:9.3} {:7.3} {:+7.3}   {better:6} {worse:6}",
            m.f1(),
            m.f1() - b
        );
    }
}

fn grade(store: &Path, options: &[String]) -> Result<(), String> {
    // The citation grammar's tables and regexes compile on first use; pay that once, outside
    // any document's timing.
    legal_pdf_core::profile::measure("warmup.citations", || {
        let _ = legal_pdf_core::layout_analysis().citations("R. v. White, 2020 NSCA 33, [2008] 2 S.C.R. 3, para. 12.");
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
    // The transition parser's structure tells paragraphs, provisions and list items apart, and they are read apart.
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
    let all = sources(store)?;
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
                .map_or(s.split != "test", |want| s.split == want)
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
    let results = parallel(&all, weight, |source| {
        let began = Instant::now();
        let result = grade_one(source, selected.get(&source.sha256));
        if began.elapsed().as_secs() >= 10 {
            eprintln!("slow: {} took {:.0}s", source.sha256, began.elapsed().as_secs_f64());
        }
        result
    });
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
    if let Some(path) = value("--against") {
        against(&read_json(Path::new(&path))?, &refs);
    }
    for error in summary["errors"].as_array().into_iter().flatten() {
        eprintln!("ERROR {} {}", error["run"], error["error"]);
    }
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

/// Diagnostic: the note pairer over one document's parsed pages, each line's note labels and calls beside it.
fn pairing(store: &Path, prefix: &str, options: &[String]) -> Result<(), String> {
    use legal_structure::StructureAnalysis;
    let source = sources(store)?.into_iter().find(|s| s.sha256.starts_with(prefix)).ok_or("No such gold")?;
    let (_, pages) = parse(&source)?;
    // The lines one after another, each its characters and a separator past them, so a range names its line.
    let mut starts = Vec::new();
    let mut at = 0;
    for line in pages.iter().flat_map(|page| &page.lines) {
        starts.push((at, line.id.as_str()));
        at += line.text.chars().count() + 1;
    }
    let start_of: HashMap<&str, usize> = starts.iter().map(|&(at, id)| (id, at)).collect();
    let place = |id: &str, start: usize, end: usize| start_of.get(id).map(|&at| legal_structure::ScalarRange { start: at + start, end: at + end });
    let line_of = |range: &legal_structure::ScalarRange| starts[starts.partition_point(|&(at, _)| at <= range.start) - 1].1.to_owned();
    let output = legal_structure::STRUCTURE_ANALYSIS.pair_footnotes(&pages, &BTreeMap::new(), &|_| 0, &place);
    let range = options.first().and_then(|r| r.split_once('-')).and_then(|(a, b)| Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?)));
    let mut by_line: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for note in &output.notes {
        let label = note.label.as_deref().unwrap_or("");
        for (role, range) in note.marker_range.iter().map(|range| ("fn_label", range)).chain(note.calls.iter().map(|call| ("fn_ref", call))) {
            by_line.entry(line_of(range)).or_default().push(format!("{role}:{label}"));
        }
    }
    for page in &pages {
        if range.is_some_and(|(a, b)| page.number < a || page.number > b) {
            continue;
        }
        for line in &page.lines {
            let marks = by_line.get(&line.id).map(|m| m.join(",")).unwrap_or_default();
            let text: String = line.text.chars().take(70).collect();
            println!("p{} {:>10} {:>9} {}{:<14} | {text}", page.number, line.region_type, line.note_region_mode,
                if line.exclude_from_body { "X " } else { "  " }, marks);
        }
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
        let read = |path: &Path| -> Result<state::Gold, String> { read_gzip_json(path).map_err(|e| e.to_string()) };
        let expected = read(&source.gold)?;
        let reference = state::projected(&expected)?;
        let candidate = if mode == "self" { state::projected(&expected)? } else { state::projected(&read(&other(source).expect("filtered above"))?)? };
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
    let value = |name: &str| {
        options
            .iter()
            .position(|o| o == name)
            .and_then(|n| options.get(n + 1))
            .cloned()
    };
    let source = sources(store)?
        .into_iter()
        .find(|s| s.sha256.starts_with(prefix))
        .ok_or("No such gold")?;
    let expected: state::Gold =
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
        &source,
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
    let candidate_state = state::parsed(&structure)?;
    let text = score::explain(
        &state::projected(&expected)?,
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
    legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let result = match arguments.as_slice() {
        [command, store, options @ ..] if command == "grade" => grade(Path::new(store), options),
        [command, store] if command == "inputs" => inputs(Path::new(store)),
        [command, store, out] if command == "digest" => digest(Path::new(store), Path::new(out)),
        [command, dir, out] if command == "docx-digest" => docx_digest(Path::new(dir), Path::new(out)),
        [command, store, out] if command == "extract-digest" => extract_digest(Path::new(store), Path::new(out)),
        [command, store, out, pack, runtime, step] if command == "layout-digest" => step
            .parse()
            .map_err(|_| "STEP must be a number".to_owned())
            .and_then(|step| layout_digest(Path::new(store), Path::new(out), Path::new(pack), Path::new(runtime), step)),
        [command, store, out] if command == "paragraph-data" => paragraph_data::export(Path::new(store), Path::new(out)),
        [command, store, mode, options @ ..] if command == "selfcheck" => selfcheck(Path::new(store), mode, options),
        [command, store, prefix, options @ ..] if command == "pairing" => pairing(Path::new(store), prefix, options),
        [command, store, prefix, options @ ..] if command == "explain" => explain(Path::new(store), prefix, options),
        _ => Err("usage: structure-gold inputs|digest|docx-digest|extract-digest|grade|rows|explain|selfcheck|pairing|paragraph-data STORE [SHA|OUT_DIR|MODE] [options]".into()),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
