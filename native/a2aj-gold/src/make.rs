//! The gold each aligned record makes, and the store's aligned golds put right against their pages.
use super::book::Book;
use super::label::{self, refused_reason};
use super::record::{trimmed, LABEL_CODE};
use super::store::{self, BATCH, GOLD_RUN, LABEL_SOURCE};
use super::words::is_space;
use super::{conventions, pairs, pdf, printed};
use crate::freeze;
use regex::Regex;
use rusqlite::{types::Value as Sql, Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};

// The lines that print no text of a decision (what the gates measure unexplained lines against the rest of).
const NONTEXT: [&str; 5] = ["furniture", "page_label", "running_head", "margin_letter", "no_words"];
static FOLIO_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*-*\s*\d{1,4}\s*-*\s*$").unwrap());
static YEAR_CITED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[(\d{4})\]").unwrap());
static YEAR_DATED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{4})").unwrap());

fn unplaced_of(verdict: &Value) -> Vec<(&str, u64)> {
    verdict["unplaced"].as_object().into_iter().flat_map(|languages| languages.values())
        .filter_map(Value::as_object).flat_map(|runs| runs.iter().map(|(why, n)| (why.as_str(), n.as_u64().unwrap_or(0)))).collect()
}

/// A line the alignment leaves unexplained that the page explains itself: a folio, or a line set letter by letter ("R E A S O N
/// S"), which print the words the alignment reads whole.
fn explained_by_print(line: &Value) -> bool {
    let text = line["text"].as_str().unwrap_or("");
    let words: Vec<&str> = text.split_whitespace().collect();
    FOLIO_LINE.is_match(text) || words.len() >= 3 && words.iter().filter(|word| word.chars().count() <= 2).count() * 10 >= words.len() * 6
}

/// Why an aligned record makes no gold (None where it makes one). A language the PDF prints with under 97% of its words
/// placed; unexplained lines over 2% of the lines that print text; a line the reader ran across both columns of a bilingual
/// page; words placed out of order or elsewhere over 0.5% of those placed; or more than ten unexplained lines after A2AJ's
/// last placed word. What the print explains does not count against it: the title and cover A2AJ writes and the print does
/// not, a shared margin number, folios and letter-spaced lines; a line or two run across the columns are left untyped, as a
/// few unexplained lines are, the page's numbers being checked apart.
pub fn gate(record: &Value) -> Option<&'static str> {
    let (verdict, empty) = (&record["verdict"], Vec::new());
    let lines = record["lines"].as_array().unwrap_or(&empty);
    if !verdict["refused"].is_null() {
        return Some("alignment refused");
    }
    let not_printed = verdict["not_printed"].as_array().unwrap_or(&empty);
    for (language, share) in verdict["coverage"].as_object().into_iter().flatten() {
        if not_printed.iter().any(|lang| lang == language.as_str()) {
            continue;
        }
        let mut share = share.as_f64().unwrap_or(0.0);
        let runs = verdict["unplaced"][language.as_str()].as_object();
        let all: u64 = runs.into_iter().flatten().map(|(_, n)| n.as_u64().unwrap_or(0)).sum();
        let excused: u64 = runs.into_iter().flatten()
            .filter(|(why, _)| matches!(why.as_str(), "title" | "cover_unprinted" | "paragraph_number_shared" | "paragraph_number_unprinted" | "note_call"))
            .map(|(_, n)| n.as_u64().unwrap_or(0)).sum();
        if all > 0 {
            share = 1.0 - (1.0 - share) * (all - excused) as f64 / all as f64;
        }
        if share < 0.97 {
            return Some("printed language placed under 97%");
        }
    }
    let body = lines.iter().filter(|line| !line["why"].as_str().is_some_and(|why| NONTEXT.contains(&why))).count();
    let unexplained = lines.iter().filter(|line| line["why"] == "unexplained" && !explained_by_print(line)).count() as f64;
    if unexplained > (0.02 * body as f64).max(3.0) {
        return Some("unexplained lines over 2%");
    }
    if verdict["unmatched"]["joined_columns"].as_u64().unwrap_or(0) > 2 {
        return Some("lines joined across columns");
    }
    let astray: u64 = unplaced_of(verdict).iter().filter(|(why, _)| matches!(*why, "out_of_order" | "other" | "on_joined_columns")).map(|(_, n)| n).sum();
    let placed: usize = lines.iter().map(|line| line["words"].as_array().map_or(0, Vec::len)).sum();
    if astray as f64 > 0.005 * placed as f64 {
        return Some("words out of order over 0.5%");
    }
    let last = lines.iter().rposition(|line| line["words"].as_array().is_some_and(|words| !words.is_empty()));
    let after = last.map_or(0, |k| k + 1);
    if lines[after..].iter().filter(|line| line["why"] == "unexplained" && !explained_by_print(line)).count() > 10 {
        return Some("runs past A2AJ's last placed word");
    }
    None
}

/// The partition of a pair's decision, which every PDF of the decision shares: test, the Supreme Court's reports of the
/// 1990s (scanned, and the digital ones of 1996-99); development, its reports of 1973 and 1986; train, the rest.
pub fn partition(pair: &Value) -> &'static str {
    let citation = pair["citation"].as_str().unwrap_or("");
    let date = pair["date"].as_str().unwrap_or("");
    let year = YEAR_CITED.captures(citation).or_else(|| YEAR_DATED.captures(date)).and_then(|found| found[1].parse::<u32>().ok()).unwrap_or(0);
    let supreme = pair["court"] == "SCC";
    if supreme && (1990..=1999).contains(&year) {
        "test"
    } else if supreme && (year == 1973 || year == 1986) {
        "development"
    } else {
        "train"
    }
}

pub fn read_pairs(work: &Path, only: &[String]) -> Result<Vec<Value>, String> {
    let text = fs::read_to_string(work.join("pairs.jsonl")).map_err(|error| error.to_string())?;
    let rows = text.lines().map(serde_json::from_str::<Value>).collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(rows.into_iter().filter(|pair| {
        let (sha, citation) = (pair["sha256"].as_str().unwrap_or(""), pair["citation"].as_str());
        only.is_empty() || only.iter().any(|o| sha.starts_with(o.as_str()) || citation == Some(o.as_str()))
    }).collect())
}

pub fn a2aj() -> Result<Connection, String> {
    Connection::open_with_flags(store::a2aj_db(), OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|error| error.to_string())
}

fn id_of(pair: &Value) -> Sql {
    match &pair["a2aj"] {
        Value::Number(number) => Sql::Integer(number.as_i64().unwrap_or(0)),
        other => Sql::Text(other.as_str().unwrap_or("").to_owned()),
    }
}

/// A decision's text in a language, as the census read it.
pub fn a2aj_text(db: &Connection, id: Sql, language: &str) -> Result<Option<String>, String> {
    let query = format!("select unofficial_text_{language} from document where id = ?1");
    let text: Option<String> = db.query_row(&query, [id], |row| row.get(0)).map_err(|error| error.to_string())?;
    Ok(text.map(|text| trimmed(&text).to_owned()))
}

/// Where A2AJ's structure reading of each `<document id>:<language>` stands in the census listing: found in one pass, each read
/// when its document comes up, so a corpus's listings are never all in memory.
pub struct Listings {
    at: HashMap<String, (u64, usize)>,
}

impl Listings {
    pub fn of(keys: &BTreeSet<String>) -> Result<Listings, String> {
        let want: HashMap<String, &String> = keys.iter().map(|key| (format!("{{\"key\":\"{key}\""), key)).collect();
        let file = fs::File::open(store::listing()).map_err(|error| error.to_string())?;
        let mut reader = BufReader::with_capacity(1 << 20, &file);
        let (mut at, mut offset, mut line) = (HashMap::new(), 0u64, Vec::new());
        loop {
            line.clear();
            let size = reader.read_until(b'\n', &mut line).map_err(|error| error.to_string())?;
            if size == 0 {
                break;
            }
            let head = line.iter().position(|&byte| byte == b',').and_then(|comma| std::str::from_utf8(&line[..comma]).ok());
            if let Some(key) = head.and_then(|head| want.get(head)) {
                at.insert((*key).clone(), (offset, size));
            }
            offset += size as u64;
        }
        drop(reader);
        Ok(Listings { at })
    }

    pub fn holds(&self, key: &str) -> bool {
        self.at.contains_key(key)
    }

    pub fn read(&self, key: &str) -> Result<Option<String>, String> {
        let Some(&(offset, size)) = self.at.get(key) else { return Ok(None) };
        let mut line = vec![0; size];
        // A handle of its own, so threads read at once.
        let mut file = fs::File::open(store::listing()).map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(offset)).and_then(|_| file.read_exact(&mut line)).map_err(|error| error.to_string())?;
        let row: Value = serde_json::from_slice(&line).map_err(|error| error.to_string())?;
        Ok(row["nodes"].as_str().map(str::to_owned))
    }
}

fn outline(text: &str) -> Option<Value> {
    let entries = legal_structure::case_outline(text).ok()?;
    serde_json::to_value(entries).ok()
}

fn heights(record: &Value) -> HashMap<i64, f64> {
    record["pages"].as_object().into_iter().flatten().filter_map(|(page, size)| Some((page.parse().ok()?, size[1].as_f64()?))).collect()
}

fn styled(record: &Value) -> HashMap<String, (bool, bool)> {
    record["lines"].as_array().into_iter().flatten().filter_map(|line| Some((line["of"]["id"].as_str().or(line["id"].as_str())?.to_owned(), (line["bold"] == true, line["italic"] == true)))).collect()
}

/// A digital PDF's pages' images; a scan's images are its pages.
fn images_of(mode: &str, path: &Path) -> Vec<pdf::PageImages> {
    if mode == "digitalborn" { pdf::images(path) } else { Vec::new() }
}

/// The gold an aligned record makes, or the reason it makes none. `labels_only`: without the rules that read the page.
pub fn convert(record: &Value, db: &Connection, found: &Listings, labels_only: bool) -> Result<Result<Value, String>, String> {
    // A2AJ_GOLD_TIMES set: each stage's time, on stderr.
    let timed = std::env::var_os("A2AJ_GOLD_TIMES").is_some();
    let mut clock = std::time::Instant::now();
    let mut lap = |stage: &str| if timed {
        eprintln!("  {stage:>12} {:7.1} ms", clock.elapsed().as_secs_f64() * 1000.0);
        clock = std::time::Instant::now();
    };
    let (pair, verdict) = (&record["pair"], &record["verdict"]);
    let id = pair["a2aj"].to_string().trim_matches('"').to_owned();
    let not_printed = verdict["not_printed"].as_array().cloned().unwrap_or_default();
    let printed: Vec<String> = verdict["coverage"].as_object().into_iter().flatten().map(|(language, _)| language.clone())
        .filter(|language| !not_printed.iter().any(|lang| lang == language.as_str())).collect::<BTreeSet<_>>().into_iter().collect();
    let missing: Vec<&str> = printed.iter().filter(|language| !found.holds(&format!("{id}:{language}"))).map(String::as_str).collect();
    if !missing.is_empty() {
        return Ok(Err(format!("no census listing in {}", missing.join(", "))));
    }
    let (mut texts, mut sets, mut shapes, mut failed) = (Map::new(), Map::new(), Map::new(), Vec::new());
    for language in &printed {
        let text = a2aj_text(db, id_of(pair), language)?.ok_or("no text")?;
        match outline(&text) {
            Some(read) => { shapes.insert(language.clone(), read); }
            None => failed.push(language.as_str()),
        }
        sets.insert(language.clone(), json!(found.read(&format!("{id}:{language}"))?));
        texts.insert(language.clone(), json!(text));
    }
    if !failed.is_empty() {
        return Ok(Err(format!("no case outline in {}", failed.join(", "))));
    }
    lap("text+outline");
    let labelled = match label::gold(record, &texts, &sets, &shapes, labels_only) {
        Ok(labelled) => labelled,
        Err(error) => return match refused_reason(&error) {
            Some(reason) => Ok(Err(reason.to_owned())),
            None => Err(error),
        },
    };
    lap("label");
    // The gold's lines are the reading's: a line run across a page's columns is one line, whichever half stands where. Each
    // says the language the alignment placed it in, where it placed it in one (a line run across both columns holds two, and a
    // paragraph number the margin prints marks every column's paragraph on its row).
    let (empty, mut told) = (Vec::new(), BTreeSet::new());
    let shared: BTreeSet<&str> = labelled["margin_lines"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let mut spoken: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    for line in record["lines"].as_array().unwrap_or(&empty) {
        if let (Some(id), Some(language)) = (line["of"]["id"].as_str().or(line["id"].as_str()), line["lang"].as_str()) {
            if !shared.contains(id) {
                spoken.entry(id).or_default().insert(language);
            }
        }
    }
    let language = |id: &str| spoken.get(id).filter(|languages| languages.len() == 1).and_then(|languages| languages.first().copied());
    let lines: Vec<Value> = record["lines"].as_array().unwrap_or(&empty).iter().filter_map(|line| {
        let whole = &line["of"];
        let mut out = if whole.is_null() {
            json!({"id": line["id"], "page": line["page"], "text": line["text"], "bbox": line["bbox"]})
        } else if told.insert(whole["id"].as_str()?) {
            json!({"id": whole["id"], "page": line["page"], "text": whole["text"], "bbox": whole["bbox"]})
        } else {
            return None;
        };
        if let Some(language) = out["id"].as_str().and_then(|id| language(id)) {
            out["lang"] = json!(language);
        }
        Some(out)
    }).collect();
    let mut value = json!({
        "schema_version": "legal-structure-gold.v4", "source_sha256": pair["sha256"], "mode": pair["mode"], "page_count": pair["pages"],
        "parser": {"reading": record["reading"], "read_sha256": record["read"]},
        "authoring": {"label_source": LABEL_SOURCE, "a2aj_document_id": pair["a2aj"], "languages": printed, "citation": pair["citation"], "dataset": pair["court"],
                      "listing": "fix.nodes.jsonl", "alignment_code": record["code"], "document_starts": []},
        "label_source": LABEL_SOURCE, "lines": lines,
        "typed": labelled["typed"], "units": labelled["units"], "notes": labelled["notes"], "report": labelled["report"],
    });
    let mut book = Book::of(&value);
    let mut done = Vec::new();
    if !labels_only {
        let images = images_of(pair["mode"].as_str().unwrap_or(""), Path::new(pair["path"].as_str().unwrap_or("")));
        lap("images");
        done = printed::apply(&mut book, &images, &styled(record), &record["page_breaks"]);
        lap("page rules");
    }
    done.extend(conventions::apply(&mut book, &heights(record)));
    lap("conventions");
    book.lines_back(&mut value);
    book.put_back(&mut value);
    value["postcorrections"] = Value::Array(done);
    if labels_only {
        value["paragraphs"] = freeze::answer(&value, printed.len() > 1);
    } else {
        keyed(&mut value, printed.len() > 1);
    }
    lap("answer key");
    Ok(Ok(value))
}

/// `convert`, where a panic on one document is that document's refusal.
fn converted(record: &Value, db: &Connection, found: &Listings, labels_only: bool) -> Result<Result<Value, String>, String> {
    catch_unwind(AssertUnwindSafe(|| convert(record, db, found, labels_only))).unwrap_or_else(|_| Ok(Err("the labelling panicked".to_owned())))
}

/// On the lines this gold and the store's gold of the same PDF read alike: this gold's paragraph markers and the store's
/// (same line, same number), and this gold's headings (their units' first lines) and the store's heading lines; and the
/// lines where the two part, each as this gold reads it.
fn agreement(value: &Value, stored: &Value) -> (BTreeMap<&'static str, u64>, Vec<String>) {
    let empty = Vec::new();
    let said = |gold: &Value| -> HashMap<String, String> {
        gold["lines"].as_array().unwrap_or(&empty).iter().map(|line| {
            let text = line.get("corrected").and_then(Value::as_str).filter(|t| !t.is_empty()).or(line["text"].as_str()).unwrap_or("");
            (line["id"].as_str().unwrap_or("").to_owned(), text.split_whitespace().collect::<Vec<_>>().join(" "))
        }).collect()
    };
    let (ours, theirs) = (said(value), said(stored));
    let shared: BTreeSet<&String> = ours.iter().filter(|(id, text)| theirs.get(*id) == Some(*text)).map(|(id, _)| id).collect();
    let markers = |gold: &Value| -> BTreeSet<(String, String)> {
        let book = Book::of(gold);
        (0..book.typed.len()).filter(|&t| matches!(book.region(t), "text" | "provision")).flat_map(|t| book.markers(t).iter().filter_map(|mark| {
            let (text, line) = book.printed(mark)?;
            shared.contains(&line.id).then(|| (line.id.clone(), text.trim_matches(['[', ']', '(', ')', '.', ' ']).to_owned()))
        }).collect::<Vec<_>>()).collect()
    };
    let (mine, gold_marks) = (markers(value), markers(stored));
    let book = Book::of(value);
    let heads: BTreeSet<String> = (0..book.units.len()).filter_map(|u| book.members(u).first().copied()).filter(|&t| book.region(t) == "heading")
        .filter_map(|t| book.spans(t).first().and_then(|s| s["line_id"].as_str()).map(str::to_owned)).collect();
    let other = Book::of(stored);
    let gold_heads: BTreeSet<String> = (0..other.typed.len()).filter(|&t| other.region(t) == "heading")
        .flat_map(|t| other.spans(t).iter().filter_map(|s| s["line_id"].as_str().map(str::to_owned)).collect::<Vec<_>>()).filter(|id| shared.contains(id)).collect();
    let mut parted: Vec<String> = mine.difference(&gold_marks).map(|(id, number)| format!("marker {number} on {id} {:?}", ours[id])).collect();
    parted.extend(heads.iter().filter(|h| shared.contains(h) && !gold_heads.contains(*h)).map(|id| {
        let held = (0..other.typed.len()).find(|&t| other.spans(t).iter().any(|s| s["line_id"] == id.as_str())).map_or("untyped", |t| other.region(t));
        format!("heading {id} ({held} in the store's) {:?}", ours[id])
    }));
    (BTreeMap::from([("lines", ours.len() as u64), ("shared", shared.len() as u64), ("markers", mine.len() as u64), ("markers_agreed", mine.intersection(&gold_marks).count() as u64),
                    ("markers_store", gold_marks.len() as u64), ("headings", heads.iter().filter(|h| shared.contains(h)).count() as u64),
                    ("headings_agreed", heads.intersection(&gold_heads).count() as u64), ("headings_store", gold_heads.len() as u64)]), parted)
}

pub struct GoldArgs {
    pub check: bool,
    pub only: Vec<String>,
    /// Writes new golds here in the store's layout, for the sources the store has no gold of.
    pub stage: Option<PathBuf>,
    /// With `stage`: the sources the store holds from this aligner too, to diff against them.
    pub all: bool,
    /// Only the pairs of this mode (digitalborn, ocr); the check still runs over every pair the store holds from elsewhere.
    pub mode: Option<String>,
    /// At most this many golds written.
    pub limit: Option<usize>,
    /// The labelling and the store's conventions alone, with no rule that reads the page.
    pub labels_only: bool,
    /// Golds made at once (the machine's cores by default).
    pub threads: Option<usize>,
}

/// Structure gold of label source a2aj-align for each aligned record that passes gate() and whose PDF the store does not
/// hold from another source. The PDFs the store does hold are the check, first: on them this gold's paragraph markers must
/// agree with the store's at 99% or more and its headings at 85% or more, or nothing is written. WORK/gold-results.json
/// lists each record's outcome. A run that writes into the store records it in the corpus registry.
pub fn gold(work: &Path, args: GoldArgs) -> Result<(), String> {
    let db = a2aj()?;
    let root = store::store_root();
    let chosen: Vec<Value> = read_pairs(work, &args.only)?.into_iter().filter(|p| work.join("records").join(format!("{}.json.gz", p["sha256"].as_str().unwrap_or(""))).is_file()).collect();
    let key = |pair: &Value, language: &Value| format!("{}:{}", pair["a2aj"].to_string().trim_matches('"'), language.as_str().unwrap_or(""));
    let keys: BTreeSet<String> = chosen.iter().flat_map(|p| p["languages"].as_array().into_iter().flatten().map(|l| key(p, l))).collect();
    let found = Listings::of(&keys)?;
    let held: HashMap<String, Value> = store::sources(&root).into_iter().map(|sha| { let source = store::source(&root, &sha); (sha, source) }).collect();
    let foreign = |sha: &str| held.get(sha).is_some_and(|source| source["label_source"] != LABEL_SOURCE);
    let record_of = |sha: &str| store::read_json(&work.join("records").join(format!("{sha}.json.gz")));
    let mut total: BTreeMap<&str, u64> = BTreeMap::new();
    for pair in chosen.iter().filter(|p| foreign(p["sha256"].as_str().unwrap_or(""))) {
        let sha = pair["sha256"].as_str().unwrap_or("");
        let record = record_of(sha)?;
        let value = match converted(&record, &db, &found, args.labels_only)? {
            Ok(value) => value,
            Err(reason) => { println!("check {}: refused, {reason}", pair["citation"]); continue }
        };
        let runs = store::structure_runs(&root.join(sha));
        let Some(run) = runs.first() else { continue };
        let (seen, parted) = agreement(&value, &store::read_json(&run.join("gold.json.gz"))?);
        for (name, n) in &seen {
            *total.entry(name).or_default() += n;
        }
        println!("check {:<16} gate {}; {seen:?}", pair["citation"].as_str().unwrap_or(""), gate(&record).unwrap_or("passes"));
        for line in parted {
            println!("    {line}");
        }
    }
    let at = |name: &str| total.get(name).copied().unwrap_or(0);
    let (markers, headings) = (at("markers_agreed") as f64 / at("markers").max(1) as f64, at("headings_agreed") as f64 / at("headings").max(1) as f64);
    println!("check: paragraph markers {}/{} = {:.1}% (store marks {}); headings {}/{} = {:.1}% (store's {})", at("markers_agreed"), at("markers"), markers * 100.0, at("markers_store"),
             at("headings_agreed"), at("headings"), headings * 100.0, at("headings_store"));
    if args.check || markers < 0.99 || headings < 0.85 {
        println!("nothing written{}", if args.check { "" } else { ": the check is under 99% markers / 85% headings" });
        return Ok(());
    }
    let target = args.stage.clone().unwrap_or_else(|| root.clone());
    let numbers = Regex::new(r"\d+").unwrap();
    let wanted: Vec<&Value> = chosen.iter().filter(|p| args.mode.as_ref().is_none_or(|mode| p["mode"] == mode.as_str())).collect();
    let threads = args.threads.unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get())).max(1);
    let (next, written_count, corpus) = (AtomicUsize::new(0), AtomicUsize::new(0), Mutex::new(()));
    let timed = std::env::var_os("A2AJ_GOLD_TIMES").is_some();
    // A pair's outcome, and why it makes no gold where it makes none.
    let one = |pair: &Value, db: &Connection| -> Result<(Value, Option<String>), String> {
        let sha = pair["sha256"].as_str().unwrap_or("");
        let mut outcome = json!({"sha256": sha, "citation": pair["citation"], "court": pair["court"], "mode": pair["mode"], "pages": pair["pages"], "a2aj": pair["a2aj"]});
        if foreign(sha) || args.stage.is_some() && !args.all && held.contains_key(sha) {
            outcome["refused"] = json!("in the gold store");
            return Ok((outcome, None));
        }
        let run = target.join(sha).join("structure").join(GOLD_RUN);
        let digest = store::read_digest(&store::reading(work, sha))?;
        if run.join("receipt.json").is_file() {
            let made = store::read_json(&run.join("receipt.json"))?;
            if made["label_code"] == LABEL_CODE.as_str() && made["read_sha256"] == digest.as_str() {
                return Ok((merged(outcome, &made["outcome"]), None));
            }
        }
        let started = std::time::Instant::now();
        let record = record_of(sha)?;
        if timed {
            eprintln!("{} {}\n  {:>12} {:7.1} ms", &sha[..8], pair["citation"].as_str().unwrap_or(""), "record", started.elapsed().as_secs_f64() * 1000.0);
        }
        if let Some(why) = gate(&record) {
            outcome["refused"] = json!(why);
            return Ok((outcome, Some(why.to_owned())));
        }
        let value = match converted(&record, db, &found, args.labels_only)? {
            Ok(value) => value,
            Err(reason) => {
                outcome["detail"] = json!(reason);
                let reason = format!("labelling: {}", numbers.replace_all(reason.split(" (").next().unwrap_or(&reason), "N"));
                outcome["refused"] = json!(reason);
                return Ok((outcome, Some(reason)));
            }
        };
        let book = Book::of(&value);
        let mut regions: BTreeMap<String, u64> = BTreeMap::new();
        for u in 0..book.units.len() {
            if let Some(&t) = book.members(u).first() {
                *regions.entry(book.region(t).to_owned()).or_default() += 1;
            }
        }
        let languages = value["authoring"]["languages"].clone();
        let written = json!({"written": true, "partition": partition(pair), "languages": languages, "regions": regions, "lines": book.lines.len(),
                             "unlabelled_lines": value["report"]["unlabelled_lines"].as_array().map_or(0, Vec::len), "notes": book.notes.len()});
        store::write_json(&run.join("gold.json.gz"), &value)?;
        store::write_json(&run.join("receipt.json"), &json!({"source_sha256": sha, "mode": pair["mode"], "status": "complete", "label_source": LABEL_SOURCE, "label_code": LABEL_CODE.as_str(),
            "read_sha256": digest, "authoring": value["authoring"], "pages": pair["pages"], "units": book.units.len(), "typed_lines": book.typed.len(),
            "postcorrections": value["postcorrections"].as_array().map_or(0, Vec::len), "outcome": written, "gold_sha256": store::digest(&run.join("gold.json.gz"))?}))?;
        // A hold stays until its repair is in.
        let printed = languages.as_array().map_or(0, Vec::len);
        // (A stage touches nothing of the corpus's; the corpus takes one writer at a time.)
        let pdf = if args.stage.is_some() {
            pairs::located(pair)?
        } else {
            let _alone = corpus.lock().map_err(|error| error.to_string())?;
            pairs::durable(pair)?
        };
        let mut source = json!({"partition": partition(pair), "language_layout": if printed > 1 { json!("parallel") } else { languages[0].clone() },
                                "genre_group": "judgment", "country": "ca", "yardstick": BATCH, "label_source": LABEL_SOURCE, "pdf": pdf});
        if let Some(hold) = held.get(sha).and_then(|s| s.get("hold")) {
            source["hold"] = hold.clone();
        }
        store::write_json(&target.join(sha).join("source.json"), &source)?;
        if timed {
            eprintln!("  {:>12} {:7.1} ms in all", "written", started.elapsed().as_secs_f64() * 1000.0);
        }
        let count = written_count.fetch_add(1, Ordering::SeqCst) + 1;
        if count % 50 == 0 {
            println!("{count} of {} written", wanted.len());
        }
        Ok((merged(outcome, &written), None))
    };
    // The pairs shared out over the threads, each with its own connection to A2AJ (a limit may be passed by the golds the
    // other threads had begun).
    let mut outcomes: Vec<(usize, Result<(Value, Option<String>), String>)> = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..threads).map(|_| scope.spawn(|| {
            let db = match a2aj() {
                Ok(db) => db,
                Err(error) => return vec![(0, Err(error))],
            };
            let mut mine = Vec::new();
            loop {
                let k = next.fetch_add(1, Ordering::SeqCst);
                if k >= wanted.len() || args.limit.is_some_and(|limit| written_count.load(Ordering::SeqCst) >= limit) {
                    break;
                }
                mine.push((k, one(wanted[k], &db)));
            }
            mine
        })).collect();
        workers.into_iter().flat_map(|worker| worker.join().unwrap_or_else(|_| vec![(0, Err("a gold's thread panicked".to_owned()))])).collect()
    });
    outcomes.sort_by_key(|(k, _)| *k);
    let (mut results, mut refused): (Vec<Value>, BTreeMap<String, u64>) = (Vec::new(), BTreeMap::new());
    for (_, outcome) in outcomes {
        let (value, why) = outcome?;
        if let Some(why) = why {
            *refused.entry(why).or_default() += 1;
        }
        results.push(value);
    }
    let results_path = args.stage.as_ref().map_or_else(|| work.join("gold-results.json"), |stage| stage.join("gold-results.json"));
    store::write_atomic(&results_path, serde_json::to_string(&json!({"results": results})).map_err(|e| e.to_string())?.as_bytes())?;
    println!("gold: {} of {} written; refused {refused:?}", results.iter().filter(|r| r["written"] == true).count(), results.len());
    if args.stage.is_none() {
        println!("registered {}", store::register()?);
    }
    Ok(())
}

/// Repairs read off the page by hand (a JSON list), each named by its line ids and checked against the words the page prints
/// there: a line that no longer says what the list says stops the repair, so a list can never land on the wrong line. A run
/// is any gold's, not only an aligned one's.
///   {"sha": prefix, "op": "region", "lines": [[id, words the line opens on], ...], "region": R}
///   {"sha": prefix, "op": "cut", "lines": [...], "region": R}     out of their unit, into one of their own
///   {"sha": prefix, "op": "line_break", "line": id, "at": "[80]", "region": R}   the line's words before `at` take R and the
///                                                                  unit before them, the rest opens a unit with `at` its marker
pub fn hand(list: &Path, ledger_path: &Path, write: bool) -> Result<(), String> {
    let root = store::store_root();
    let items: Vec<Value> = serde_json::from_slice(&fs::read(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut ledger = if write { Some(fs::OpenOptions::new().create(true).append(true).open(ledger_path).map_err(|e| e.to_string())?) } else { None };
    let shas = store::sources(&root);
    if write {
        wait_for_corpus();
    }
    for item in &items {
        let prefix = item["sha"].as_str().ok_or("an item with no sha")?;
        let sha = shas.iter().find(|sha| sha.starts_with(prefix)).ok_or_else(|| format!("no source {prefix}"))?;
        let run = store::structure_runs(&root.join(sha)).into_iter().next().ok_or_else(|| format!("no gold of {prefix}"))?;
        let path = run.join("gold.json.gz");
        let mut value = store::read_json(&path)?;
        let before = value.clone();
        let parallel = value["authoring"]["languages"].as_array().is_some_and(|languages| languages.len() > 1);
        let mut book = Book::of(&value);
        let check = |book: &Book, id: &str, words: &str| -> Result<usize, String> {
            let line = book.line(id).ok_or_else(|| format!("{prefix}: no line {id}"))?;
            if !line.trimmed().starts_with(words) {
                return Err(format!("{prefix} {id}: the line says {:?}, not {words:?}", line.trimmed()));
            }
            book.typed_on(id).ok_or_else(|| format!("{prefix} {id}: typed by no line"))
        };
        let region = item["region"].as_str().unwrap_or("");
        let mut changed = 0;
        match item["op"].as_str().unwrap_or("") {
            "region" | "cut" => {
                let mut typed = Vec::new();
                for pair in item["lines"].as_array().ok_or("no lines")? {
                    typed.push(check(&book, pair[0].as_str().unwrap_or(""), pair[1].as_str().unwrap_or(""))?);
                }
                if item["op"] == "cut" {
                    let first = typed[0];
                    book.split_at(first);
                    if let Some(&after) = book.unit_of(first).map(|u| book.members(u)).unwrap_or_default().iter().find(|t| !typed.contains(t)) {
                        book.split_at(after);
                    }
                    // The cut unit opens on its first line.
                    changed += (book.typed[first]["start"] != true) as usize;
                    book.typed[first]["start"] = json!(true);
                }
                for &t in &typed {
                    changed += (book.region(t) != region) as usize;
                    book.typed[t]["region"] = json!(region);
                    if matches!(region, "furniture" | "page_label" | "line_label") {
                        book.typed[t]["start"] = json!(true);
                        book.set_apart(t);
                    }
                }
            }
            "move" => {
                let anchor = check(&book, item["into_unit_of"][0].as_str().unwrap_or(""), item["into_unit_of"][1].as_str().unwrap_or(""))?;
                let target = book.unit_of(anchor).ok_or("an anchor in no unit")?;
                for pair in item["lines"].as_array().ok_or("no lines")? {
                    let t = check(&book, pair[0].as_str().unwrap_or(""), pair[1].as_str().unwrap_or(""))?;
                    let from = book.unit_of(t).ok_or("a line in no unit")?;
                    if from == target {
                        continue;
                    }
                    book.units[from]["lines"] = json!(book.members(from).into_iter().filter(|&line| line != t).collect::<Vec<_>>());
                    let mut lines = book.members(target);
                    lines.push(t);
                    lines.sort_unstable();
                    book.units[target]["lines"] = json!(lines);
                    changed += 1;
                }
                book.in_order();
            }
            "line_break" => {
                let id = item["line"].as_str().ok_or("no line")?;
                let at = item["at"].as_str().ok_or("no at")?;
                let t = check(&book, id, "")?;
                let line = book.line(id).unwrap();
                let spelled = line.spelled();
                let byte = spelled.find(at).ok_or_else(|| format!("{prefix} {id}: no {at:?} on the line"))?;
                let cut = spelled[..byte].chars().count();
                let (before, after, length) = (spelled[..byte].trim_end_matches(is_space).to_owned(), spelled[byte..].to_owned(), line.text.len());
                let end = cut + at.chars().count();
                let page = line.page;
                // (Done already where the line's first typed words are the heading's.)
                if book.region(t) != region && !before.is_empty() {
                    // The words before the number go to the heading above, whose unit the line follows.
                    let above = (0..t).rev().find(|&k| book.region(k) == region).ok_or_else(|| format!("{prefix} {id}: no heading above"))?;
                    book.split_at(t);
                    book.in_order();
                    book.insert_typed(t, json!({"markers": [], "page": page, "references": [], "region": region, "spans": [{"end": before.chars().count(), "line_id": id, "start": 0}], "start": false, "text": before}));
                    let unit = book.unit_of(above).ok_or("a heading in no unit")?;
                    let mut lines = book.members(unit);
                    lines.push(t);
                    book.units[unit]["lines"] = json!(lines);
                    let next = t + 1;
                    book.typed[next]["spans"] = json!([{"end": length, "line_id": id, "start": cut}]);
                    book.typed[next]["markers"] = json!([[{"end": end, "line_id": id, "start": cut}]]);
                    book.typed[next]["start"] = json!(true);
                    book.typed[next]["text"] = json!(after.replacen(at, &format!("{at}\t"), 1).replacen("\t ", "\t", 1));
                    book.in_order();
                    changed += 1;
                }
            }
            other => return Err(format!("no operation {other:?}")),
        }
        println!("{} {}: {} {} line(s) changed", &sha[..8], item["op"].as_str().unwrap_or(""), region, changed);
        if changed == 0 {
            continue;
        }
        if let Some(ledger) = &mut ledger {
            let reason = item["reason"].as_str().unwrap_or("read off the printed page");
            corrections(&mut value).push(json!({"rule": "hand", "op": item["op"], "region": region, "reason": reason}));
            book.put_back(&mut value);
            rekeyed(&before, &mut value, parallel);
            store::write_atomic(&path, &store::patched(&path, &before, &value)?)?;
            let receipt_path = path.with_file_name("receipt.json");
            let mut receipt = store::read_json(&receipt_path)?;
            receipt["gold_sha256"] = json!(store::digest(&path)?);
            receipt["postcorrections"] = json!(value["postcorrections"].as_array().map_or(0, Vec::len));
            store::write_json(&receipt_path, &receipt)?;
            writeln!(ledger, "{}", json!({"sha256": sha, "rule": "hand", "count": changed, "reason": reason})).map_err(|e| e.to_string())?;
            ledger.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn merged(mut outcome: Value, more: &Value) -> Value {
    for (key, value) in more.as_object().into_iter().flatten() {
        outcome[key] = value.clone();
    }
    outcome
}

fn corpus_running() -> bool {
    std::process::Command::new("tasklist").args(["/fo", "csv", "/nh"]).output()
        .is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains("pinpoint-corpus"))
}

pub struct RepairArgs {
    pub only: Vec<String>,
    pub write: bool,
    pub ledger: PathBuf,
    /// Every correction, one per line, with its gold's citation: what a dry run is read by.
    pub changes: Option<PathBuf>,
}

fn rule_of(correction: &Value) -> String {
    correction["rule"].as_str().unwrap_or("").to_owned()
}

/// A gold's answer key, from its units as they stand; where the key says the judgment numbers no paragraphs, its numbered
/// units are the lists they are.
fn keyed(gold: &mut Value, parallel: bool) {
    let key = freeze::answer(gold, parallel);
    if key["count"].is_null() {
        let mut book = Book::of(gold);
        let listed = printed::set_out_lists(&mut book);
        book.put_back(gold);
        corrections(gold).extend(listed);
    }
    corrections(gold).push(freeze::key_entry(&key));
    gold["paragraphs"] = key;
}

/// A repaired gold's key: worked out again, unless the key it held differs from what its units gave, a hand repair, which
/// stays and is listed to be read.
fn rekeyed(before: &Value, gold: &mut Value, parallel: bool) {
    let stored = &before["paragraphs"];
    if stored.is_null() || *stored == freeze::answer(before, parallel) {
        keyed(gold, parallel);
    } else {
        println!("{}: a hand-repaired key stays; read it against the repair", gold["source_sha256"].as_str().unwrap_or(""));
    }
}

/// A gold's corrections: the earliest runs' golds have none yet.
fn corrections(gold: &mut Value) -> &mut Vec<Value> {
    let list = gold.as_object_mut().expect("a gold is an object").entry("postcorrections").or_insert_with(|| json!([]));
    list.as_array_mut().expect("corrections are a list")
}

fn wait_for_corpus() {
    while corpus_running() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
}

/// The store's aligned golds put right against their own pages: each gold as it stands, so a repair already made stays and
/// every line keeps its id and text, unless the repair is the line's own number. Dry unless `write`. All of a run's golds are
/// computed first and swapped in as one batch, begun only while no pinpoint-corpus runs. Each gold changed goes in the ledger
/// with a line per rule.
pub fn repair(work: &Path, args: RepairArgs) -> Result<(), String> {
    let root = store::store_root();
    let (mut rules, mut golds): (BTreeMap<String, u64>, BTreeMap<String, u64>) = (BTreeMap::new(), BTreeMap::new());
    let mut large: Vec<String> = Vec::new();
    let (mut batch, mut entries): (store::Batch, Vec<String>) = (store::Batch::default(), Vec::new());
    let (mut changed_golds, mut seen_golds) = (0u64, 0u64);
    for sha in store::sources(&root) {
        if !args.only.is_empty() && !args.only.iter().any(|o| sha.starts_with(o.as_str())) {
            continue;
        }
        let path = root.join(&sha).join("structure").join(GOLD_RUN).join("gold.json.gz");
        if !path.is_file() {
            continue;
        }
        seen_golds += 1;
        let mut value = store::read_json(&path)?;
        let was = value.clone();
        let parallel = value["authoring"]["languages"].as_array().is_some_and(|languages| languages.len() > 1);
        let mode = value["mode"].as_str().unwrap_or("").to_owned();
        let mut book = Book::of(&value);
        let source = store::source(&root, &sha);
        let pdf_path = store::data_home().join(source["pdf"].as_str().unwrap_or(""));
        let images = images_of(&mode, &pdf_path);
        let record_path = work.join("records").join(format!("{sha}.json.gz"));
        let record = if record_path.is_file() { store::read_json(&record_path)? } else { Value::Null };
        let style = if book.markers_any() { styled(&record) } else { HashMap::new() };
        let before = printed::marks_of(&book).into_iter().map(|m| m.0).collect::<BTreeSet<_>>().len();
        let mut done = printed::apply(&mut book, &images, &style, &record["page_breaks"]);
        if done.is_empty() {
            continue;
        }
        done.extend(conventions::margin_numbers(&mut book));
        let after = printed::marks_of(&book).into_iter().map(|m| m.0).collect::<BTreeSet<_>>().len();
        let mut counted: BTreeMap<String, u64> = BTreeMap::new();
        for correction in &done {
            *counted.entry(rule_of(correction)).or_default() += 1;
        }
        let touched = counted.iter().filter(|(rule, _)| matches!(rule.as_str(), "number_at_margin" | "number_printed" | "number_printed_as_image")).map(|(_, n)| *n).sum::<u64>();
        for (rule, n) in &counted {
            *rules.entry(rule.clone()).or_default() += n;
            *golds.entry(rule.clone()).or_default() += 1;
        }
        changed_golds += 1;
        let citation = value["authoring"]["citation"].as_str().unwrap_or("").to_owned();
        if let Some(path) = &args.changes {
            let mut file = fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
            for correction in &done {
                writeln!(file, "{}", json!({"sha": sha, "citation": citation, "mode": mode, "correction": correction})).map_err(|e| e.to_string())?;
            }
        }
        if touched > 0 && touched * 20 > before as u64 {
            large.push(format!("{} {citation}: {touched} of {before}", &sha[..8]));
        }
        println!("{} {citation}: {counted:?} numbers {before} -> {after}", &sha[..8]);
        if args.write {
            book.lines_back(&mut value);
            book.put_back(&mut value);
            corrections(&mut value).extend(done.iter().cloned());
            rekeyed(&was, &mut value, parallel);
            let digest = batch.add_bytes(&path, &store::patched(&path, &was, &value)?)?;
            let receipt_path = path.with_file_name("receipt.json");
            let mut receipt = store::read_json(&receipt_path)?;
            receipt["gold_sha256"] = json!(digest);
            receipt["postcorrections"] = json!(value["postcorrections"].as_array().map_or(0, Vec::len));
            batch.add(&receipt_path, &receipt)?;
            for (rule, n) in &counted {
                let reason = done.iter().find(|c| rule_of(c) == *rule).and_then(|c| c["reason"].as_str()).unwrap_or(rule);
                entries.push(json!({"sha256": sha, "citation": citation, "rule": rule, "count": n, "reason": reason}).to_string());
            }
        }
    }
    if args.write && batch.len() > 0 {
        if let Some(parent) = args.ledger.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut ledger = fs::OpenOptions::new().create(true).append(true).open(&args.ledger).map_err(|e| e.to_string())?;
        wait_for_corpus();
        let files = batch.len();
        batch.swap()?;
        writeln!(ledger, "{}", entries.join("\n")).map_err(|e| e.to_string())?;
        ledger.flush().map_err(|e| e.to_string())?;
        println!("{files} files swapped in");
    }
    println!("{seen_golds} golds, {changed_golds} changed");
    println!("corrections {rules:?}");
    println!("golds {golds:?}");
    println!("over 5% of a gold's numbers: {large:?}");
    if args.write {
        println!("registered {}", store::register()?);
    }
    Ok(())
}
