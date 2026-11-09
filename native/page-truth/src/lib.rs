//! Printed page numbers as their sources hold them, read where they live; nothing is exported to a copy.
//!
//! - `golds`: the structure gold store (run "a"), each page whose `page_label` line the gold marks, keyed by the number
//!   that line prints; composite where the gold's units start two documents or more; the gold's partition.
//! - `journals`: journals.db's confirmed page maps, with the working system's own reading (`raw_detected_page_map`).
//! - `judgments`: the A2AJ alignment records: where the first word after one of A2AJ's page marks ("[Page 389]") stands
//!   on a PDF page, that page is the mark's page; a page two marks fall on is left out. The citation gives the decision's
//!   first page.
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// One document's printed page numbers: `map` is pdf page (1-based) → the numbers it prints.
pub struct Truth {
    pub id: String,
    pub pdf: PathBuf,
    pub map: BTreeMap<u32, Vec<String>>,
    pub first_page: Option<u32>,
    /// The working system's own reading (journals), pdf page → printed.
    pub detected: HashMap<u32, String>,
    /// Several documents bound in one PDF; none when the source does not say.
    pub composite: Option<bool>,
    /// The gold's partition ("train", "development", "test").
    pub partition: Option<String>,
}

/// Where the corpus and the alignment records are (OPEN_LEGAL_DATA_HOME, else %LOCALAPPDATA%\\OpenLegalData).
fn data_home() -> PathBuf {
    match std::env::var_os("OPEN_LEGAL_DATA_HOME") {
        Some(home) => PathBuf::from(home),
        None => PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("OpenLegalData"),
    }
}

/// The repository this crate is in (the gold store is under it).
fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).unwrap().to_path_buf()
}

/// The number a folio line prints: the line alone ("12", "- 12 -", "xiv"), a page counter ("Page 3", "3 of 20"), else
/// the numbers it holds.
pub fn labels(text: &str) -> Vec<String> {
    // a compound folio whole: a chapter's page ("5-1"), a spread ("12-13")
    static COMPOUND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\s\W_]*(\d{1,4})\s*[-\u{2010}-\u{2015}]\s*(\d{1,5})[\s\W_]*$").unwrap());
    // a number alone, its digits perhaps spaced by the reading ("5 1"), or a roman numeral
    static BARE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[\s\-–—.,;:()\[\]|]*(\d(?:\s?\d){0,11}|[ivxlc]{1,8})[\s\-–—.,;:()\[\]|]*$").unwrap());
    // "Page 3", "p. 3", "3 of 20" / "3 sur 20" (a worded counter before a slashed one: "T-15.01 / 2 sur 46" is page 2)
    static COUNTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:\bpage\s*:?\s*|\bp\.\s*)(\d{1,5})|(\d{1,5})\s+(?:of|de|sur)\s+\d{1,5}|(\d{1,5})\s*/\s*\d{1,5}").unwrap());
    static WORDED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(\d{1,5})\s+(?:of|de|sur)\s+\d{1,5}").unwrap());
    // a lettered page ("E-162", "A - 2") as printed, and its number
    static LETTERED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\W_]*([A-Za-z]{1,6})\s?-?\s?(\d{1,8})[\W_]*$").unwrap());
    static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d{1,12}").unwrap());
    if let Some(found) = COMPOUND.captures(text) {
        return vec![format!("{}-{}", &found[1], &found[2])];
    }
    if let Some(bare) = BARE.captures(text) {
        return vec![bare[1].split_whitespace().collect()];
    }
    if let Some(counter) = COUNTER.captures(text) {
        let worded = WORDED.captures(text).map(|c| c.get(1).unwrap()).or(counter.get(1)).or(counter.get(2));
        let mut out = vec![worded.or(counter.get(3)).unwrap().as_str().to_owned()];
        // a counter a running number follows ("Page 1 101": a tab's page and the volume's): both are printed
        static RUNNING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bpage\s*:?\s*\d{1,5}\s+(\d{1,5})\s*$").unwrap());
        out.extend(RUNNING.captures(text).map(|c| c[1].to_owned()));
        return out;
    }
    let mut out: Vec<String> = LETTERED.captures(text).map(|c| vec![format!("{}-{}", &c[1], &c[2]), format!("{}{}", &c[1], &c[2])]).unwrap_or_default();
    out.extend(NUMBER.find_iter(text).map(|m| m.as_str().to_owned()));
    out
}

fn gunzip(path: &Path) -> Option<Value> {
    let mut text = String::new();
    flate2::read::GzDecoder::new(File::open(path).ok()?).read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

fn text_of(value: &Value) -> Option<String> {
    value.as_str().map(|s| s.trim().to_owned()).or_else(|| value.as_i64().map(|n| n.to_string()))
}

/// What a gold says of its pages: its typed lines' regions, pages and text, and whether each unit opens a document; the
/// rest of it is read past.
#[derive(serde::Deserialize)]
struct GoldPages {
    #[serde(default)]
    typed: Vec<Typed>,
    #[serde(default)]
    units: Vec<Unit>,
}

#[derive(serde::Deserialize)]
struct Typed {
    #[serde(default)]
    region: String,
    #[serde(default)]
    page: Option<u64>,
    #[serde(default)]
    text: String,
}

#[derive(serde::Deserialize)]
struct Unit {
    #[serde(default)]
    starts_document: Option<bool>,
}

/// One gold folder's truth, if its gold marks a page's number.
fn gold(folder: &Path, home: &Path) -> Option<Truth> {
    let source: Value = serde_json::from_slice(&fs::read(folder.join("source.json")).ok()?).ok()?;
    let path = fs::read_dir(folder.join("structure")).ok()?.flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with("-a"))
        .map(|entry| entry.path().join("gold.json.gz")).find(|path| path.is_file())?;
    let gold: GoldPages = serde_json::from_reader(std::io::BufReader::new(flate2::read::GzDecoder::new(File::open(path).ok()?))).ok()?;
    let mut map: BTreeMap<u32, Vec<String>> = BTreeMap::new();
    for typed in gold.typed.iter().filter(|typed| typed.region == "page_label") {
        let found = labels(&typed.text);
        if let Some(page) = typed.page.filter(|_| !found.is_empty()) {
            map.entry(page as u32).or_default().extend(found);
        }
    }
    if map.is_empty() {
        return None;
    }
    let relative = source["pdf"].as_str().unwrap_or_default();
    let pdf = [repo().join(relative), home.join("corpus").join(relative), home.join(relative)].into_iter().find(|path| path.is_file())?;
    // a PDF binding several documents (its gold's units start two or more): a composite, scored apart
    let starts = gold.units.iter().filter(|unit| unit.starts_document == Some(true)).count();
    Some(Truth {
        id: folder.file_name()?.to_string_lossy().into_owned(),
        pdf,
        map,
        first_page: None,
        detected: HashMap::new(),
        composite: Some(starts >= 2),
        partition: source["partition"].as_str().map(str::to_owned),
    })
}

/// Every gold in the structure gold store that marks a page's number, the golds read on every core.
pub fn golds() -> Vec<Truth> {
    let home = data_home();
    let root = repo().join("benchmarks/local-data/gold");
    let mut folders: Vec<PathBuf> = fs::read_dir(&root).expect("gold store").flatten().map(|entry| entry.path()).collect();
    folders.sort();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let next = std::sync::atomic::AtomicUsize::new(0);
    let mut found: Vec<(usize, Truth)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads).map(|_| scope.spawn(|| {
            let mut mine = Vec::new();
            loop {
                let at = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(folder) = folders.get(at) else { break };
                if let Some(truth) = gold(folder, &home) {
                    mine.push((at, truth));
                }
            }
            mine
        })).collect();
        workers.into_iter().flat_map(|worker| worker.join().unwrap()).collect()
    });
    found.sort_by_key(|(at, _)| *at);
    found.into_iter().map(|(_, truth)| truth).collect()
}
/// journals.db's confirmed page maps (their PDFs live on E:); the first page the article's citation
/// gives is its confirmed one (`confirmed_first_page`: the range the map projects), else its metadata's.
pub fn journals() -> Vec<Truth> {
    let db = Connection::open_with_flags(r"C:\Users\elias\Desktop\Open Access Journals Database\oajd\journals.db", OpenFlags::SQLITE_OPEN_READ_ONLY).expect("journals.db");
    // the table is read whole: mapped, not 4 KB page by page
    db.execute_batch("PRAGMA mmap_size = 4000000000; PRAGMA cache_size = -1000000;").expect("journals.db pragmas");
    let mut query = db.prepare(
        "select article_id, pdf_path, confirmed_page_map, coalesce(confirmed_first_page, first_page), raw_detected_page_map from articles \
         where confirmed_page_map is not null and confirmed_page_map not in ('', '[]') and pdf_path is not null and pdf_path <> ''").unwrap();
    let rows = query.query_map([], |row| {
        Ok((row.get::<_, rusqlite::types::Value>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, rusqlite::types::Value>(3)?, row.get::<_, Option<String>>(4)?))
    }).unwrap();
    let sql_text = |value: &rusqlite::types::Value| match value {
        rusqlite::types::Value::Integer(n) => Some(n.to_string()),
        rusqlite::types::Value::Text(s) => Some(s.trim().to_owned()),
        _ => None,
    };
    let mut out = Vec::new();
    for (id, path, map, first, detected) in rows.flatten() {
        let rest = path.replace('/', "\\");
        let rest = rest.split_once("data\\pdfs\\").map_or(rest.as_str(), |(_, rest)| rest);
        let pdf = Path::new(r"E:\oajd-production-tier\pdfs").join(rest);
        let Ok(map) = serde_json::from_str::<Vec<Value>>(&map) else { continue };
        let map = map.iter().filter_map(|page| {
            Some((page["pdf_page"].as_u64()? as u32, page["labels"].as_array()?.iter().filter_map(text_of).collect()))
        }).collect();
        let detected = detected.and_then(|d| serde_json::from_str::<Vec<Vec<Value>>>(&d).ok()).unwrap_or_default().iter()
            .filter_map(|row| Some((row.first()?.as_u64()? as u32, text_of(row.get(1)?)?))).collect();
        out.push(Truth {
            id: sql_text(&id).unwrap_or_default(),
            pdf,
            map,
            first_page: sql_text(&first).and_then(|s| s.parse().ok()),
            detected,
            composite: None,
            partition: None,
        });
    }
    out
}

/// Every decision whose A2AJ page marks stand on its PDF's pages.
pub fn judgments() -> Vec<Truth> {
    static FIRST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+)\s*$").unwrap());
    let home = data_home();
    let db = Connection::open_with_flags(home.join("corpus/corpus.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).expect("corpus.sqlite");
    let mut query = db.prepare("select sha256, path from files where content_type like 'application/pdf%' or path like '%.pdf'").unwrap();
    let files: HashMap<String, PathBuf> = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).unwrap().flatten()
        .map(|(sha, path)| { let path = PathBuf::from(&path); (sha, if path.is_absolute() { path } else { home.join(path) }) }).collect();
    let mut records: Vec<PathBuf> = fs::read_dir(home.join("a2aj-gold/work/records")).expect("records").flatten().map(|entry| entry.path()).collect();
    records.sort();
    let mut out = Vec::new();
    for path in records {
        let Some(record) = gunzip(&path) else { continue };
        let sha = path.file_name().unwrap().to_string_lossy().trim_end_matches(".json.gz").to_owned();
        let Some(pdf) = files.get(&sha).filter(|pdf| pdf.is_file()) else { continue };
        let main = record["verdict"]["main"].as_str().unwrap_or("en");
        let breaks = record["page_breaks"].get(main).or_else(|| record["page_breaks"].as_object().and_then(|all| all.values().next()));
        let mut map: BTreeMap<u32, Vec<String>> = BTreeMap::new();
        for mark in breaks.and_then(Value::as_array).into_iter().flatten() {
            if let (Some(number), Some(page)) = (mark["page"].as_str(), mark["pdf"]["page"].as_u64()) {
                map.entry(page as u32).or_default().push(number.to_owned());
            }
        }
        map.retain(|_, numbers| numbers.len() == 1);
        if map.is_empty() {
            continue;
        }
        let citation = record["pair"]["citation"].as_str().unwrap_or_default();
        out.push(Truth {
            id: sha,
            pdf: pdf.clone(),
            map,
            first_page: FIRST.captures(citation).and_then(|c| c[1].parse().ok()),
            detected: HashMap::new(),
            // one decision's record: a single document, whatever pages its marks leave unkeyed
            composite: Some(false),
            partition: None,
        });
    }
    out
}

/// The named source's truths: "golds", "journals" or "judgments".
pub fn truths(source: &str) -> Vec<Truth> {
    match source {
        "golds" => golds(),
        "journals" => journals(),
        "judgments" => judgments(),
        other => panic!("unknown source {other}: golds, journals or judgments"),
    }
}
