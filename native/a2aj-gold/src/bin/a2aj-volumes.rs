//! Bound volumes. A report's volume, read once (`read-list`), holds many decisions; a file may hold the end of one volume
//! and the next, or a year in parts. Each page's printed number is the product's (the structure the parser builds on the
//! reading, its page labels). Each A2AJ decision is where its citation says: in the file holding the report it names, on
//! the page printing its citation page (of two such in a file of two volumes, the one holding its opening words), up to the
//! page printing the next decision's first page; the product's aligner reads it there. A decision not found so is a
//! problem to read, never looked for elsewhere.
//!
//! Each A2AJ word the aligner pairs with a printed word takes that page's number, and each run it leaves unplaced the page
//! of the line it names; a page turn is where the number changes. Two invariants of a report hold: a decision's pages run
//! from its citation page to the next decision's first page, and through its reasons they never go down (its notes, after
//! the reasons in A2AJ's text, stand on the pages of their calls).
//!
//! Checks, reported and never used to decide: each decision's first page against its citation, each page's number against
//! the folio the aligner found on it, the numbers through a decision one after another, A2AJ's own page marks ("[Page
//! 389") against the turns, and every decision placed. Writes OUT/sheet.jsonl (a line per decision: its pages over A2AJ's
//! text, by language, in characters of the store's text) and OUT/problems.jsonl.
//!
//!   a2aj-volumes READS OUT [--threads N]      READS: the volumes' readings (`a2aj-gold read-list`)
use a2aj_gold::record::{notes_start, record_of_reading, start_of, trimmed, Reading};
use a2aj_gold::store;
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

const OPENING_WORDS: usize = 40;
const OPENING_SHARE: f64 = 0.5;
const LONGEST: i64 = 300;

static OLD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\((\d{4})\)\s+(\d{1,2})\s+(?:SCR|S\.C\.R\.)\s+(\d+)").unwrap());
static NEW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[(\d{4})\]\s+(?:(\d)\s+)?(?:SCR|S\.C\.R\.)\s+(\d+)").unwrap());
static MARK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?mi)^\[Page (\d+)\s*$").unwrap());
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}]{4,}").unwrap());
static LINE_PAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^p(\d+)-").unwrap());
static FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"JU1-1-(\d{4})(?:-(\d))?").unwrap());
static TITLE_VOLUME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^VOL(?:UME)?\.?\s+(\d+|[IVXLC]+)\.?$").unwrap());
static HEAD_VOLUME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"S\.?\s*C\.?\s*R\.?\s*,?\s*VOL\.?\s+(\d+|[IVXLC]+)\b").unwrap());

/// A report a citation names: a Reports volume ("(1916) 53 SCR 128") or a Canada Law Reports year and part.
#[derive(Clone, PartialEq, Eq, Hash)]
enum Report {
    Volume(i64),
    Year(i64, i64),
}

struct Case {
    id: i64,
    report: Report,
    page: i64,
    citation: String,
    name: String,
    date: String,
    /// by language: the store's text
    texts: Vec<(&'static str, String)>,
    openings: Vec<HashSet<String>>,
}

fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    WORD.find_iter(text).map(|m| m.as_str().to_lowercase())
}

/// Every A2AJ Supreme Court decision with a report citation before 1970.
fn cases(db: &Connection) -> Result<Vec<Case>, String> {
    let mut query = db.prepare("select id, citation_en, citation_fr, name_en, name_fr, document_date_en, document_date_fr, \
        unofficial_text_en, unofficial_text_fr from document where doc_type = 'cases' and dataset = 'SCC'").map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let rows = query.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?,
        row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<String>>(6)?,
        row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?))).map_err(|e| e.to_string())?;
    for row in rows {
        let (id, cen, cfr, nen, nfr, den, dfr, en, fr) = row.map_err(|e| e.to_string())?;
        let citation = cen.filter(|c| !c.is_empty()).or(cfr).unwrap_or_default();
        let (report, page) = if let Some(old) = OLD.captures(&citation) {
            (Report::Volume(old[2].parse().unwrap_or(0)), old[3].parse().unwrap_or(0))
        } else if let Some(new) = NEW.captures(&citation).filter(|new| new[1].parse::<i64>().unwrap_or(9999) < 1970) {
            (Report::Year(new[1].parse().unwrap_or(0), new.get(2).map_or(0, |p| p.as_str().parse().unwrap_or(0))), new[3].parse().unwrap_or(0))
        } else {
            continue;
        };
        let texts: Vec<(&'static str, String)> = [("en", en), ("fr", fr)].into_iter()
            .filter_map(|(language, text)| text.filter(|t| !t.trim().is_empty()).map(|t| (language, t))).collect();
        let openings = texts.iter().map(|(language, text)| {
            let body = trimmed(text);
            words(&body[start_of(body, language)..]).take(OPENING_WORDS).collect()
        }).collect();
        out.push(Case { id, report, page, citation, name: nen.or(nfr).unwrap_or_default(),
            date: den.or(dfr).unwrap_or_default().chars().take(10).collect(), texts, openings });
    }
    Ok(out)
}

/// A volume file as the product reads it: its reading, each page's printed number (by physical page, from 1), and each
/// page's words.
struct Volume {
    name: String,
    reading: Reading,
    labels: Vec<Option<i64>>,
    words: Vec<HashSet<String>>,
    /// the physical pages printing each number
    by_label: HashMap<i64, Vec<i64>>,
    /// the reports the file holds: the Reports volumes its title pages and running heads name, or its year and part
    reports: Vec<Report>,
    structure_seconds: f64,
}

fn roman(text: &str) -> Option<i64> {
    let value = |c| match c { 'I' => Some(1), 'V' => Some(5), 'X' => Some(10), 'L' => Some(50), 'C' => Some(100), _ => None };
    let digits: Vec<i64> = text.chars().map(value).collect::<Option<_>>()?;
    Some(digits.iter().enumerate().map(|(at, &d)| if digits.get(at + 1).is_some_and(|&next| next > d) { -d } else { d }).sum())
}

/// The reports a file holds. A Canada Law Reports file (1923 on, which A2AJ cites by year): its year and part. A Reports
/// file: each volume a title page's line of nothing else ("VOL. XXIV.") or a running head ("S. C. R. VOL. XXIII.]") names;
/// a file may hold the end of one volume and the next.
fn reports_of(name: &str, reading: &Reading) -> Vec<Report> {
    let Some(found) = FILE.captures(name) else { return Vec::new() };
    let year: i64 = found[1].parse().unwrap_or(0);
    if year >= 1923 {
        let part = found.get(2).map_or(0, |p| p.as_str().parse().unwrap_or(0));
        return vec![Report::Year(year, part)];
    }
    let mut out = Vec::new();
    for page in &reading.pages {
        let height = page.height.unwrap_or(792.0);
        for line in &page.lines {
            let text = line.text.to_uppercase();
            let named = TITLE_VOLUME.captures(text.trim()).or_else(|| (line.bbox[1] < 0.12 * height).then(|| HEAD_VOLUME.captures(&text)).flatten());
            if let Some(number) = named.and_then(|found| found[1].parse().ok().or_else(|| roman(&found[1]))) {
                if !out.contains(&Report::Volume(number)) {
                    out.push(Report::Volume(number));
                }
            }
        }
    }
    out
}

fn volume(file: &Path) -> Result<Volume, String> {
    let name = file.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_owned();
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    let extracted: legalpdf::ExtractedPdf = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    // the document's identity, a SHA-256 as the parser takes one: the reading's
    let identity: String = <sha2::Sha256 as sha2::Digest>::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect();
    let begun = Instant::now();
    let document = legalpdf::gold_structure_document(extracted, &identity, None).map_err(|e| e.to_string())?;
    let structure_seconds = begun.elapsed().as_secs_f64();
    let labels: Vec<Option<i64>> = document.page_labels().into_iter().map(|label| label.and_then(|l| l.trim().parse().ok())).collect();
    drop(document);
    let reading: Reading = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let words = reading.pages.iter().map(|page| page.lines.iter().flat_map(|line| words(&line.text)).collect()).collect();
    let mut by_label: HashMap<i64, Vec<i64>> = HashMap::new();
    for (at, label) in labels.iter().enumerate() {
        if let Some(label) = label {
            by_label.entry(*label).or_default().push(at as i64 + 1);
        }
    }
    let reports = reports_of(&name, &reading);
    Ok(Volume { name, reading, labels, words, by_label, reports, structure_seconds })
}

impl Volume {
    fn label(&self, page: i64) -> Option<i64> {
        self.labels.get((page - 1) as usize).copied().flatten()
    }

    /// The physical pages printing `number`.
    fn printing(&self, number: i64) -> Vec<i64> {
        self.by_label.get(&number).cloned().unwrap_or_default()
    }

    /// Whether the file holds the report a citation names ("[1952] SCR", no part, is either part's).
    fn holds(&self, report: &Report) -> bool {
        self.reports.iter().any(|held| match (held, report) {
            (Report::Year(year, part), Report::Year(cited, cited_part)) => year == cited && (cited_part == part || *cited_part == 0 || *part == 0),
            (held, report) => held == report,
        })
    }

    /// The share of a decision's opening words its first page and the next hold.
    fn opening_share(&self, case: &Case, page: i64) -> f64 {
        let here: HashSet<&String> = [page, page + 1].iter().filter_map(|p| self.words.get((p - 1) as usize)).flatten().collect();
        case.openings.iter().filter(|opening| !opening.is_empty())
            .map(|opening| opening.iter().filter(|word| here.contains(word)).count() as f64 / opening.len() as f64)
            .fold(0.0, f64::max)
    }
}

/// One try of a decision.
struct Try {
    opens_right: bool,
    coverage: f64,
    row: Value,
    problems: Vec<Value>,
    marks: [u64; 3],
}

/// The decision's pages over one language's text, from its record: each placed word's page number and each unplaced run's
/// (the line it names), the reasons kept to the decision's pages and never going down, the notes on their own pages.
fn stretches(record: &Value, volume: &Volume, language: &str, text: &str, first: i64, next: Option<i64>) -> Vec<[i64; 3]> {
    let inner = trimmed(text);
    let lead = text[..inner.as_ptr() as usize - text.as_ptr() as usize].chars().count() as i64;
    let notes = notes_start(inner).map_or(i64::MAX, |at| at as i64);
    let in_report = |label: i64| label >= first && next.is_none_or(|next| label <= next);
    let mut placed: Vec<(i64, i64, i64)> = Vec::new();
    for line in record["lines"].as_array().into_iter().flatten().filter(|line| line["lang"] == language) {
        let Some(label) = line["page"].as_i64().and_then(|page| volume.label(page)) else { continue };
        for word in line["words"].as_array().into_iter().flatten() {
            if let (Some(start), Some(end)) = (word[2].as_i64(), word[3].as_i64()) {
                placed.push((start, end, label));
            }
        }
    }
    for run in record["unplaced"][language].as_array().into_iter().flatten() {
        let page = run["pdf"]["line"].as_str().and_then(|line| LINE_PAGE.captures(line)).and_then(|found| found[1].parse::<i64>().ok());
        if let (Some(label), Some(start), Some(end)) = (page.and_then(|page| volume.label(page)), run["at"][0].as_i64(), run["at"][1].as_i64()) {
            placed.push((start, end, label));
        }
    }
    placed.retain(|&(_, _, label)| in_report(label));
    placed.sort_unstable();
    let (reasons, notes_placed): (Vec<_>, Vec<_>) = placed.into_iter().partition(|&(start, _, _)| start < notes);
    // the heaviest run of the reasons' placements whose page numbers never fall
    let reasons = if reasons.is_empty() { reasons } else {
        let low = reasons.iter().map(|p| p.2).min().unwrap();
        let width = (reasons.iter().map(|p| p.2).max().unwrap() - low + 1) as usize;
        let (mut best, mut best_at, mut before) = (vec![0i64; width], vec![usize::MAX; width], vec![usize::MAX; reasons.len()]);
        for (at, &(start, end, label)) in reasons.iter().enumerate() {
            let slot = (label - low) as usize;
            let (prior, from) = (0..=slot).map(|s| (best[s], best_at[s])).max_by_key(|&(value, _)| value).unwrap();
            before[at] = from;
            if prior + (end - start).max(1) > best[slot] {
                best[slot] = prior + (end - start).max(1);
                best_at[slot] = at;
            }
        }
        let mut keep = vec![false; reasons.len()];
        let mut at = (0..width).max_by_key(|&s| best[s]).map(|s| best_at[s]).unwrap();
        while at != usize::MAX {
            keep[at] = true;
            at = before[at];
        }
        reasons.into_iter().zip(keep).filter(|(_, kept)| *kept).map(|(p, _)| p).collect()
    };
    // a stretch from each page's first placement to the next page's; the reasons end where the notes begin
    let mut out: Vec<[i64; 3]> = Vec::new();
    let text_end = inner.chars().count() as i64;
    for (part, end) in [(reasons, notes.min(text_end)), (notes_placed, text_end)] {
        let mut runs: Vec<[i64; 3]> = Vec::new();
        for (start, _, label) in part {
            if runs.last().is_none_or(|last| last[0] != label) {
                if let Some(last) = runs.last_mut() {
                    last[2] = start;
                }
                runs.push([label, start, end]);
            }
        }
        out.extend(runs.into_iter().filter(|s| s[2] > s[1]));
    }
    out.into_iter().map(|[label, start, end]| [label, start + lead, end + lead]).collect()
}

fn attempt(case: &Case, volume: &Volume, first: i64, next: Option<i64>, db: &Connection, how: &str) -> Option<Try> {
    // from the page printing the citation page to the one printing the next decision's first page
    let end = next.and_then(|n| volume.printing(n).into_iter().find(|&page| page >= first))
        .unwrap_or_else(|| (first + LONGEST).min(volume.labels.len() as i64));
    let window = [first, end.max(first)];
    let piece = Reading { pages: volume.reading.pages.iter().filter(|page| window[0] <= page.number && page.number <= window[1]).cloned().collect() };
    let languages: Vec<&str> = case.texts.iter().map(|(language, _)| *language).collect();
    let pair = json!({"sha256": format!("{}-{}", volume.name, case.id), "path": volume.name, "pages": window[1] - window[0] + 1, "mode": "ocr",
        "route": "volume", "a2aj": case.id, "citation": case.citation, "name": case.name, "date": case.date, "court": "SCC",
        "languages": languages, "window": window});
    let made = record_of_reading(&pair, piece, String::new(), db).ok()?;
    let record: Value = serde_json::from_slice(&made.json).ok()?;
    let coverage = made.verdict["coverage"].as_object().map_or(0.0, |c| c.values().filter_map(Value::as_f64).fold(0.0, f64::max));
    let (mut pages_by_language, mut problems, mut marks, mut opens_right) = (serde_json::Map::new(), Vec::new(), [0u64; 3], false);
    for (language, text) in &case.texts {
        let pages = stretches(&record, volume, language, text, case.page, next);
        let Some(opening) = pages.first() else { continue };
        if opening[0] == case.page {
            opens_right = true;
        } else {
            problems.push(json!({"citation": case.citation, "language": language, "problem": "first page", "first": opening[0], "volume": volume.name}));
        }
        // the numbers through the decision one after another
        let mut numbers: Vec<i64> = pages.iter().map(|s| s[0]).collect();
        numbers.sort_unstable();
        numbers.dedup();
        if numbers.windows(2).any(|w| w[1] != w[0] + 1) {
            problems.push(json!({"citation": case.citation, "language": language, "problem": "a page missing", "pages": numbers}));
        }
        // A2AJ's own marks: the first word after "[Page N" opens page N
        let chars: Vec<usize> = text.char_indices().map(|(at, _)| at).collect();
        for mark in MARK.captures_iter(text) {
            let page: i64 = mark[1].parse().unwrap_or(0);
            let end = mark.get(0).unwrap().end();
            let after = text[end..].find(|c: char| !c.is_whitespace()).map(|at| chars.partition_point(|&b| b < end + at) as i64);
            match (pages.iter().find(|s| s[0] == page), after) {
                (Some(stretch), Some(after)) if stretch[1] == after => marks[0] += 1,
                (Some(stretch), Some(after)) => {
                    marks[1] += 1;
                    problems.push(json!({"citation": case.citation, "problem": "mark", "page": page, "ours": stretch[1], "mark": after}));
                }
                _ => {
                    marks[2] += 1;
                    problems.push(json!({"citation": case.citation, "problem": "mark without stretch", "page": page}));
                }
            }
        }
        pages_by_language.insert((*language).to_owned(), json!(pages));
    }
    if pages_by_language.is_empty() {
        return None;
    }
    // each page's number against the folio the aligner found on it
    for line in record["lines"].as_array().into_iter().flatten().filter(|line| line["why"] == "page_label") {
        let (Some(page), Ok(printed)) = (line["page"].as_i64(), line["text"].as_str().unwrap_or("").trim().parse::<i64>()) else { continue };
        if !(1870..1976).contains(&printed) && volume.label(page) != Some(printed) {
            problems.push(json!({"citation": case.citation, "problem": "label against folio", "volume": volume.name, "pdf_page": page,
                "label": volume.label(page), "folio": printed}));
        }
    }
    let row = json!({"a2aj": case.id, "citation": case.citation, "volume": volume.name, "window": window, "how": how,
        "verdict": made.verdict, "languages": pages_by_language});
    Some(Try { opens_right, coverage, row, problems, marks })
}

fn keep_best(best: &Mutex<HashMap<i64, Try>>, id: i64, made: Try) {
    let mut best = best.lock().unwrap();
    if best.get(&id).is_none_or(|old| (made.opens_right, made.coverage) > (old.opens_right, old.coverage)) {
        best.insert(id, made);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let threads = args.iter().position(|arg| arg == "--threads").and_then(|at| args.get(at + 1)).and_then(|n| n.parse().ok()).unwrap_or(4);
    // a2aj-volumes --labels READING: each page's number as the product reads it, beside its head's first lines
    if args.first().map(String::as_str) == Some("--labels") {
        legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
        let volume = volume(Path::new(&args[1])).unwrap_or_else(|error| panic!("{error}"));
        for (page, label) in volume.reading.pages.iter().zip(&volume.labels) {
            let height = page.height.unwrap_or(792.0);
            let head: Vec<&str> = page.lines.iter().filter(|line| line.bbox[1] < 0.12 * height).map(|line| line.text.as_str()).collect();
            println!("{}\t{}\t{}", page.number, label.map_or("-".to_owned(), |l| l.to_string()), head.join(" | "));
        }
        println!("reports {:?}", volume.reports.iter().map(|r| match r { Report::Volume(n) => format!("vol {n}"), Report::Year(y, p) => format!("{y}/{p}") }).collect::<Vec<_>>());
        return;
    }
    let (Some(reads), Some(out)) = (args.first(), args.get(1)) else {
        eprintln!("a2aj-volumes READS OUT [--threads N]");
        std::process::exit(2);
    };
    if let Err(error) = volumes(Path::new(reads), Path::new(out), threads) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn volumes(reads: &Path, out: &Path, threads: usize) -> Result<(), String> {
    let started = Instant::now();
    legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
    fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let db_path = store::a2aj_db();
    let open = || Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|e| e.to_string());
    let cases = cases(&open()?)?;
    let mut starts: HashMap<Report, Vec<i64>> = HashMap::new();
    for case in &cases {
        starts.entry(case.report.clone()).or_default().push(case.page);
    }
    for pages in starts.values_mut() {
        pages.sort_unstable();
        pages.dedup();
    }
    let next_of = |case: &Case| starts[&case.report].iter().copied().find(|&page| page > case.page);
    let mut files: Vec<PathBuf> = fs::read_dir(reads).map_err(|e| e.to_string())?.filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    let best: Mutex<HashMap<i64, Try>> = Mutex::new(HashMap::new());
    let (tries, failures) = (AtomicUsize::new(0), Mutex::new(Vec::new()));
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            scope.spawn(|| {
                let Ok(db) = open() else { return };
                loop {
                    let Some(file) = files.get(next.fetch_add(1, Ordering::SeqCst)) else { break };
                    let volume = match volume(file) {
                        Ok(volume) => volume,
                        Err(error) => { failures.lock().unwrap().push(json!({"volume": file.display().to_string(), "problem": error})); continue; }
                    };
                    // the decisions of the reports this file holds, each on the page printing its citation page
                    let begun = Instant::now();
                    let (mut wanted, mut done) = (0, 0);
                    for case in cases.iter().filter(|case| volume.holds(&case.report)) {
                        wanted += 1;
                        for first in volume.printing(case.page) {
                            if volume.opening_share(case, first) < OPENING_SHARE {
                                continue;
                            }
                            tries.fetch_add(1, Ordering::Relaxed);
                            if let Some(made) = attempt(case, &volume, first, next_of(case), &db, "on its citation page") {
                                done += 1;
                                keep_best(&best, case.id, made);
                            }
                        }
                    }
                    eprintln!("{}: {done} of {wanted} aligned; structure {:.1} s, alignment {:.1} s", volume.name, volume.structure_seconds, begun.elapsed().as_secs_f64());
                }
            });
        }
    });

    let best = best.into_inner().unwrap();
    let mut sheet = fs::File::create(out.join("sheet.jsonl")).map_err(|e| e.to_string())?;
    let mut problems = fs::File::create(out.join("problems.jsonl")).map_err(|e| e.to_string())?;
    let mut tally: BTreeMap<String, u64> = BTreeMap::new();
    for failure in failures.into_inner().unwrap() {
        *tally.entry("volume not read".to_owned()).or_default() += 1;
        let _ = writeln!(problems, "{failure}");
    }
    for case in &cases {
        let Some(made) = best.get(&case.id) else {
            *tally.entry("decision placed nowhere".to_owned()).or_default() += 1;
            let _ = writeln!(problems, "{}", json!({"citation": case.citation, "problem": "placed nowhere"}));
            continue;
        };
        *tally.entry("decisions placed".to_owned()).or_default() += 1;
        if !made.opens_right {
            *tally.entry("first page differs from the citation".to_owned()).or_default() += 1;
        }
        for problem in &made.problems {
            *tally.entry(format!("problem: {}", problem["problem"].as_str().unwrap_or(""))).or_default() += 1;
            let _ = writeln!(problems, "{problem}");
        }
        for (k, what) in ["mark: the turn is on it", "mark: the turn is off it", "mark: its page has no stretch"].into_iter().enumerate() {
            *tally.entry(what.to_owned()).or_default() += made.marks[k];
        }
        let _ = writeln!(sheet, "{}", made.row);
    }
    println!("{:.0} s, {} alignments tried, {} decisions", started.elapsed().as_secs_f64(), tries.into_inner(), cases.len());
    for (what, n) in tally {
        println!("  {n:>7}  {what}");
    }
    Ok(())
}
// touched
