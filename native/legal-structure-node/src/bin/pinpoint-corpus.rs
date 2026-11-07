//! pinpoint-corpus: every judgment PDF of every store, its numbered paragraphs read by the product's own calls
//! (`derive_pdf_document`, `document_anchors`, `pdf_passage_pages_job`), each checked in the process that read it:
//!
//!   gold    the structure gold store: each gold carries its answer key (`paragraphs`: each number's printings' lines and the
//!           lines the key speaks for). A cited paragraph is whole when, of the lines the key speaks for, its highlight
//!           holds its printings' and no other (a line lies in a highlight by its middle).
//!   a2aj    the PDF's digital-born A2AJ decision, read by the case reader: every printed language's words, exactly.
//!   free    no reference: the numbers the count skips, and the page body's lines no paragraph took.
//!
//! The PDFs come from corpus.sqlite (documents of kind judgment or opinion, a2aj_pairs), the gold from the gold store.
//! One JSON line per PDF goes to OUT/rows.jsonl as it is read; a stopped run resumes after them, and a PDF the process
//! died on (OUT/started.log without its row) is that PDF's error. The table is printed at the end, and by
//!
//!   pinpoint-corpus run OUT [--store gold|pairs|all] [--workers N] [--limit N] [--cache DIR] [--ocr DIR] [--jobs FILE]
//!   pinpoint-corpus summary OUT
//!   pinpoint-corpus show SHA-PREFIX [--ocr DIR]
//!   pinpoint-corpus reader TEXT-FILE
//!
//! The gold store's readers and each gold's answer key are the a2aj-gold crate's (`a2aj-gold freeze` writes the keys).

#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    corpus::main();
}

#[cfg(not(target_arch = "wasm32"))]
mod corpus {
    use a2aj_gold::gold_store::{gold_lines, gold_sources, items, list_item, rows_of, GoldLine};
    use flate2::read::GzDecoder;
    use legal_structure::{ScalarText, StructureAnalysis, STRUCTURE_ANALYSIS};
    use legal_structure_node::engine;
    use rusqlite::{types::Value as Sql, Connection, OpenFlags};
    use serde_json::{json, Value};
    use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
    use std::fs::{self, File, OpenOptions};
    use std::io::{BufRead, BufReader, Write};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::path::{Path, PathBuf};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Instant;
    use unicode_normalization::UnicodeNormalization;

    const WORKER_STACK: usize = 32 << 20;
    const MOST_PARAGRAPHS: usize = 4000;

    struct Pair {
        a2aj: Sql,
        mode: String,
        citation: String,
    }

    #[derive(Default)]
    struct Job {
        sha: String,
        pdf: Option<PathBuf>,
        gold: Option<(PathBuf, String)>,
        pair: Option<Pair>,
    }

    struct Held {
        page: u64,
        rect: [f64; 4],
        text: String,
    }

    struct Reading {
        pages: usize,
        scanned: usize,
        paragraphs: BTreeMap<usize, Vec<Held>>,
        unavailable: usize,
        between: Vec<(String, String)>,
        /// The words of every line of those pages no paragraph holds, furniture or not.
        unheld: Vec<String>,
    }

    fn home() -> PathBuf {
        std::env::var_os("OPEN_LEGAL_DATA_HOME").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA")).join("OpenLegalData"))
    }

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn read_only(path: &Path) -> Connection {
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    fn string_list(db: &Connection, query: &str) -> Vec<(String, String)> {
        let mut statement = db.prepare(query).expect("query");
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?.unwrap_or_default())));
        rows.expect("rows").flatten().collect()
    }

    /// A PDF's job, made where it has none yet.
    fn job<'a>(jobs: &'a mut HashMap<String, Job>, order: &mut Vec<String>, files: &HashMap<String, PathBuf>, sha: &str) -> &'a mut Job {
        jobs.entry(sha.to_owned()).or_insert_with(|| {
            order.push(sha.to_owned());
            Job { sha: sha.to_owned(), pdf: files.get(sha).cloned(), ..Job::default() }
        })
    }

    /// Every PDF of the stores `store` names, gold first, then the A2AJ pairs, then the rest of the inventory.
    fn stores(store: &str) -> Vec<Job> {
        let home = home();
        let db = read_only(&home.join("corpus").join("corpus.sqlite"));
        let located = |path: &str| -> PathBuf {
            let path = Path::new(path);
            if path.is_absolute() { path.to_owned() } else { home.join(path) }
        };
        let files: HashMap<String, PathBuf> = string_list(&db, "select sha256, path from files where content_type like 'application/pdf%' or path like '%.pdf'").into_iter()
            .map(|(sha, path)| (sha, located(&path))).collect();
        let mut order = Vec::<String>::new();
        let mut jobs = HashMap::<String, Job>::new();
        if store != "pairs" {
            for source in gold_sources() {
                let entry = job(&mut jobs, &mut order, &files, &source.sha);
                entry.gold = Some((source.gold, source.layout));
                if entry.pdf.is_none() {
                    entry.pdf = [repo().join(&source.pdf), home.join("corpus").join(&source.pdf), home.join(&source.pdf)].into_iter().find(|path| path.is_file());
                }
            }
        }
        if store != "gold" {
            let mut statement = db.prepare("select sha256, a2aj_id, mode, citation from a2aj_pairs order by sha256").expect("pairs");
            let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, Pair {
                a2aj: row.get(1)?, mode: row.get(2)?, citation: row.get::<_, Option<String>>(3)?.unwrap_or_default() })));
            for (sha, pair) in rows.expect("pairs").flatten() {
                job(&mut jobs, &mut order, &files, &sha).pair = Some(pair);
            }
        }
        if store == "all" {
            for (sha, _) in string_list(&db, "select distinct sha256, kind from documents where kind in ('judgment', 'opinion') order by sha256") {
                // Many of the inventory's opinions are HTML or JSON: its PDFs are those read here.
                if files.contains_key(&sha) {
                    job(&mut jobs, &mut order, &files, &sha);
                }
            }
        }
        order.iter().filter_map(|sha| jobs.remove(sha)).collect()
    }

    /// The product's request for a PDF: the recognition stored for it (OCR/<sha>.json) where there is one, nothing read
    /// again.
    fn request_of(sha: &str, cache: &Path, ocr: Option<&Path>) -> Result<legalpdf::PdfRequest, String> {
        let mut request = json!({"expected_source_sha256": sha, "id": format!("pin:{sha}"), "cache_dir": cache});
        if let Some(stored) = ocr.map(|ocr| ocr.join(format!("{sha}.json"))).filter(|path| path.is_file()) {
            let file = File::open(&stored).map_err(|e| e.to_string())?;
            request["supplied_ocr"] = serde_json::from_reader(BufReader::new(file)).map_err(|e| e.to_string())?;
        }
        serde_json::from_value(request).map_err(|e| e.to_string())
    }

    fn read_pdf(bytes: &[u8], sha: &str, cache: &Path, ocr: Option<&Path>) -> Result<Reading, String> {
        let request = request_of(sha, cache, ocr)?;
        let document = engine::derive_pdf_document(bytes, &request)?;
        let summary = engine::pdf_document_summary(&document)?;
        let (pages, scanned) = (summary.page_count, summary.pages_needing_ocr.len().max(summary.scanned_pages.len()));
        let anchors = serde_json::to_value(engine::document_anchors(&document, None)).map_err(|e| e.to_string())?;
        let anchors = anchors.as_array().map(Vec::as_slice).unwrap_or_default();
        let furniture: HashSet<&str> = anchors.iter().filter_map(|anchor| anchor["nodeId"].as_str())
            .filter_map(|id| id.split_once(':')).filter(|(_, what)| ["page", "furniture", "line"].iter().any(|name| what.starts_with(name)))
            .map(|(id, _)| id).collect();
        let top = anchors.iter().filter(|anchor| anchor["kind"] == "paragraph")
            .filter_map(|anchor| anchor["label"].as_str()?.strip_prefix("par")?.parse::<usize>().ok()).max().unwrap_or(0).min(MOST_PARAGRAPHS);
        let targets = (1..=top).map(|n| serde_json::from_value(json!({"id": n.to_string(), "locatorKind": "paragraph", "locator": n.to_string()})))
            .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        let geometry = engine::pdf_passage_pages_job(&document, targets)?.compute()?;
        let (mut paragraphs, mut unavailable, mut held) = (BTreeMap::new(), 0, HashSet::new());
        for target in geometry["targets"].as_array().map(Vec::as_slice).unwrap_or_default() {
            if target["status"] == "unavailable" {
                unavailable += 1;
            }
            let Some(number) = target["id"].as_str().and_then(|id| id.parse::<usize>().ok()) else { continue };
            if target["status"] != "found" {
                continue;
            }
            let mut lines = Vec::new();
            for page in target["pages"].as_array().map(Vec::as_slice).unwrap_or_default() {
                for line in page["lines"].as_array().map(Vec::as_slice).unwrap_or_default() {
                    let id = line["id"].as_str().unwrap_or_default();
                    held.insert(id.split(':').next().unwrap_or(id).to_owned());
                    let rect = |at: usize| line["rect"][at].as_f64().unwrap_or(0.0);
                    lines.push(Held { page: page["pageNumber"].as_u64().unwrap_or(0), rect: [rect(0), rect(1), rect(2), rect(3)], text: words(line) });
                }
            }
            if !lines.is_empty() {
                paragraphs.insert(number, lines);
            }
        }
        // The body's lines no paragraph took, from the first paragraph's first line to the last's last.
        let printed = || paragraphs.values().flatten().map(|line: &Held| line.page);
        let (mut between, mut unheld) = (Vec::new(), Vec::new());
        if let (Some(first), Some(last)) = (printed().min(), printed().max()) {
            let pages_target = serde_json::from_value(json!({"id": "pages", "locatorKind": "page", "locator": "1", "physicalPages": (first..=last).collect::<Vec<_>>()}))
                .map_err(|e| e.to_string())?;
            let surface = engine::pdf_passage_pages_job(&document, vec![pages_target])?.compute()?;
            let lines: Vec<&Value> = items(&surface["targets"][0]["pages"]).iter().flat_map(|page| items(&page["lines"])).collect();
            let taken = |line: &&Value| held.contains(line["id"].as_str().unwrap_or_default());
            unheld = lines.iter().filter(|line| !taken(line)).map(|line| stream(&words(line))).filter(|line| !line.is_empty()).collect();
            let (start, end) = (lines.iter().position(|line| taken(&line)).unwrap_or(0), lines.iter().rposition(|line| taken(&line)).unwrap_or(0));
            for line in &lines[start..=end.max(start).min(lines.len().saturating_sub(1))] {
                let id = line["id"].as_str().unwrap_or_default();
                if !held.contains(id) && !furniture.contains(id) {
                    between.push((id.to_owned(), words(line).chars().take(90).collect()));
                }
            }
        }
        Ok(Reading { pages, scanned, paragraphs, unavailable, between, unheld })
    }

    fn words(line: &Value) -> String {
        line["words"].as_array().map(Vec::as_slice).unwrap_or_default().iter()
            .filter_map(|word| word["text"].as_str()).collect::<Vec<_>>().join(" ")
    }

    // -- the gold ---------------------------------------------------------------------------------------------------


    fn inflate(path: &Path) -> Result<Value, String> {
        let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_reader(BufReader::new(GzDecoder::new(file))).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// A gold's answer key, its `paragraphs`.
    struct Key {
        count: usize,
        printed: BTreeMap<usize, HashSet<String>>,
        speaks_for: HashSet<String>,
    }

    /// The key a gold carries; None where it says the judgment numbers no paragraphs.
    fn key_of(gold: &Value) -> Result<Option<Key>, String> {
        let key = &gold["paragraphs"];
        let speaks_for: HashSet<String> = key["speaks_for"].as_array().ok_or("the gold carries no key")?.iter().filter_map(Value::as_str).map(str::to_owned).collect();
        let Some(count) = key["count"].as_u64() else { return Ok(None) };
        let mut printed = BTreeMap::<usize, HashSet<String>>::new();
        for (number, printings) in key["printings"].as_object().ok_or("the key has no printings")? {
            let number = number.parse::<usize>().map_err(|_| format!("the key's number {number}"))?;
            let lines = items(printings).iter().flat_map(items).filter_map(Value::as_str).filter(|id| speaks_for.contains(*id)).map(str::to_owned);
            printed.entry(number).or_default().extend(lines);
        }
        Ok(Some(Key { count: count as usize, printed, speaks_for }))
    }

    fn check_gold(reading: &Reading, path: &Path, layout: &str) -> Result<Value, String> {
        let gold = inflate(path)?;
        let Some(key) = key_of(&gold)? else { return Ok(json!({"numbered": false})) };
        let lines = gold_lines(&gold);
        let by_id: HashMap<&str, &GoldLine> = lines.iter().map(|line| (line.id.as_str(), line)).collect();
        let regions: HashMap<&str, &str> = items(&gold["typed"]).iter()
            .flat_map(|typed| items(&typed["spans"]).iter().filter(|span| span["start"] != span["end"]).filter_map(move |span| Some((span["line_id"].as_str()?, typed["region"].as_str()?))))
            .collect();
        let mut by_page = HashMap::<u64, Vec<&GoldLine>>::new();
        for line in &lines {
            by_page.entry(line.page).or_default().push(line);
        }
        let place = |id: &String| by_id.get(id.as_str()).map_or((0, 0.0, id.clone()), |line| (line.page, line.bbox[1], id.clone()));
        let mut tally = BTreeMap::<&str, usize>::new();
        let (mut misses, mut covered, mut cited) = (Vec::new(), HashSet::<String>::new(), HashSet::<String>::new());
        // The gold's lines a number's highlights hold.
        let held_by = |number: usize| {
            let mut mine = HashSet::<String>::new();
            for held in reading.paragraphs.get(&number).map(Vec::as_slice).unwrap_or_default() {
                for line in by_page.get(&held.page).map(Vec::as_slice).unwrap_or_default() {
                    let y = (line.bbox[1] + line.bbox[3]) / 2.0;
                    if held.rect[0] <= line.bbox[2] && line.bbox[0] <= held.rect[2] && held.rect[1] <= y && y <= held.rect[3] {
                        mine.insert(line.id.clone());
                    }
                }
            }
            mine
        };
        for number in 1..=key.count {
            let printed = key.printed.get(&number).cloned().unwrap_or_default();
            let mine: HashSet<String> = held_by(number).into_iter().filter(|id| key.speaks_for.contains(id)).collect();
            // A number the gold prints nowhere, that nothing here holds, is no paragraph of this judgment's.
            if printed.is_empty() && mine.is_empty() {
                continue;
            }
            let mut lacking: Vec<String> = printed.difference(&mine).cloned().collect();
            let mut beyond: Vec<String> = mine.difference(&printed).cloned().collect();
            // A section heading between two numbers and a speck of recognition are no paragraph's words, whichever side holds them.
            let words = |id: &String| by_id.get(id.as_str()).is_some_and(|line| regions.get(id.as_str()) != Some(&"heading")
                && line.text.iter().filter(|c| c.is_alphanumeric()).count() >= 4);
            // A recognizer may give one printed line twice: holding either copy holds it.
            let same = |id: &String| by_id.get(id.as_str()).map(|line| (line.page, line.text.clone()));
            let (both, kept): (HashSet<_>, HashSet<_>) = (printed.iter().filter_map(same).collect(), mine.iter().filter_map(same).collect());
            lacking.retain(|id| same(id).is_none_or(|line| !kept.contains(&line)));
            beyond.retain(|id| same(id).is_none_or(|line| !both.contains(&line)));
            for list in [&mut lacking, &mut beyond] {
                list.retain(words);
                list.sort_by(|a, b| place(a).partial_cmp(&place(b)).unwrap_or(std::cmp::Ordering::Equal));
            }
            // (Nothing but those, on a number the gold prints nowhere, is no paragraph at all.)
            if printed.is_empty() && beyond.is_empty() {
                continue;
            }
            let kind = if !printed.is_empty() && lacking.is_empty() && beyond.is_empty() { "whole" } else if mine.is_empty() { "zero" }
                else if beyond.is_empty() { "short" } else if lacking.is_empty() { "spill" } else { "both" };
            *tally.entry("cited").or_default() += 1;
            *tally.entry(kind).or_default() += 1;
            if kind != "whole" {
                // Every line apart, each with the region the gold types it (or "-" where it types none).
                let named = |list: &[String]| list.iter().filter_map(|id| by_id.get(id.as_str()))
                    .map(|line| format!("p{} {} {}", line.page, regions.get(line.id.as_str()).copied().unwrap_or("-"), line.text.iter().take(70).collect::<String>())).collect::<Vec<_>>();
                misses.push(json!([number, kind, lacking.len(), beyond.len(), named(&lacking), named(&beyond)]));
            }
            cited.extend(printed);
            covered.extend(mine);
        }
        // A number past the gold's count, inside paragraphs the gold prints, is the reader's alone. (Past them the gold stops
        // short of the judgment's own numbers, and says nothing.)
        for number in reading.paragraphs.keys().filter(|number| **number > key.count && !held_by(**number).is_disjoint(&cited)) {
            *tally.entry("cited").or_default() += 1;
            *tally.entry("extra").or_default() += 1;
            misses.push(json!([number, "extra", 0, 0, [], []]));
        }
        let stray = covered.difference(&cited).count();
        // A PDF of several decisions reads apart from the usual case.
        let decisions = 1 + items(&gold["units"]).iter().skip(1).filter(|unit| unit["starts_document"] == true).count();
        let layout = if decisions > 1 { format!("{layout} multi") } else { layout.to_owned() };
        // A gold held for a repair (its source.json's `hold`, gold_store.py) reads apart until the repair is in.
        let source = path.ancestors().nth(3).map(|folder| folder.join("source.json"));
        let held = source.and_then(|path| fs::read(path).ok()).and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|source| !source["hold"].is_null());
        let layout = if held { format!("{layout} held") } else { layout };
        Ok(json!({"numbered": true, "mode": gold["mode"], "layout": layout, "tally": tally, "stray": stray, "misses": misses}))
    }

    // -- A2AJ -------------------------------------------------------------------------------------------------------

    /// A text's base letters and figures, in lower case: a word a PDF prints letter-spaced, hyphenated across a line or
    /// with its accents apart from their letters ("m\u{2c6}eme") reads as the decision writes it, and nothing else does.
    fn stream(text: &str) -> String {
        text.nfkd().flat_map(char::to_lowercase).filter(|c| c.is_alphanumeric() && !('\u{2b0}'..='\u{2ff}').contains(c))
            .collect::<String>().replace('\u{153}', "oe").replace('\u{e6}', "ae").replace('\u{131}', "i")
    }

    /// `text` without the paragraph's number at its head ("[12]", "12."); the same figure inside it stays.
    fn unnumbered(text: &str, number: usize) -> &str {
        let opened = text.trim_start_matches(|c: char| !c.is_alphanumeric());
        match opened.strip_prefix(&number.to_string()) {
            Some(rest) if !rest.starts_with(char::is_alphanumeric) => rest,
            _ => text,
        }
    }

    /// A provider's text and a PDF's differ by a letter here and there ("Morisson", "Morrison"): a few, whatever their order,
    /// and never a line's worth, are the same words.
    fn few_letters_apart(want: &str, got: &str) -> bool {
        few_letters(letters_apart(want, got), want.chars().count())
    }

    fn few_letters(apart: usize, of: usize) -> bool {
        apart <= 8 && apart * 20 <= of
    }

    fn letters_apart(want: &str, got: &str) -> usize {
        let mut count = HashMap::<char, i64>::new();
        want.chars().for_each(|c| *count.entry(c).or_default() += 1);
        got.chars().for_each(|c| *count.entry(c).or_default() -= 1);
        count.values().map(|difference| difference.unsigned_abs() as usize).sum()
    }

    /// A text's words but for what is no word of a paragraph: a translator's "[TRADUCTION]", which one text prints and the
    /// other may not, and a provider's "[Text redacted]".
    fn worded(text: &str) -> String {
        // (Either may wrap over a line: "[TRA-" / "DUCTION]", "[Text" / "redacted]".)
        match text {
            "duction" | "redacted" => String::new(),
            _ => text.replace("traduction", "").replace("textredacted", ""),
        }
    }

    /// The stretches of a language's words no line stands on, as byte ranges.
    fn open_stretches(taken: &[bool]) -> Vec<(usize, usize)> {
        let mut at = 0;
        taken.chunk_by(|a, b| a == b).filter_map(|run| {
            let from = at;
            at += run.len();
            (!run[0]).then_some((from, at))
        }).collect()
    }

    /// Lays a highlight's lines on the words each language wants of them: the language each line stands on, and which of
    /// those words have a line on them. A letter takes one line, and a line lies whole or not at all. A long line with one
    /// place open lies there, and each that lies may leave another with one; a long line a paragraph's words hold twice
    /// ("raisonnable et efficace de soumettre la question") goes where it follows on from the line before it in that language.
    /// A short one takes what the rest left ("tive", the end of "objec-", though the other language's "legislative" holds it
    /// too), in the narrowest stretch still open that holds it. Beyond that the page's order says nothing: a parallel report
    /// interleaves its languages, and a PDF's pieces come in any order.
    fn lay<'a>(lines: &[String], wants: &BTreeMap<&'a str, String>) -> (Vec<Option<&'a str>>, BTreeMap<&'a str, Vec<bool>>) {
        let mut taken: BTreeMap<&'a str, Vec<bool>> = wants.iter().map(|(language, want)| (*language, vec![false; want.len()])).collect();
        let mut order: Vec<usize> = (0..lines.len()).collect();
        order.sort_by_key(|&at| std::cmp::Reverse(lines[at].len()));
        let mut laid = vec![None; lines.len()];
        let (long, short): (Vec<usize>, Vec<usize>) = order.into_iter().partition(|&at| lines[at].len() >= ITS_OWN_PLACE);
        let lie = |at: usize, found: Option<(&'a str, usize, usize)>, taken: &mut BTreeMap<&'a str, Vec<bool>>, laid: &mut Vec<Option<&'a str>>| {
            if let Some((language, from, to)) = found {
                if let Some(letters) = taken.get_mut(language) {
                    letters[from..to].fill(true);
                }
                laid[at] = Some(language);
            }
        };
        let mut placed = vec![None; lines.len()];
        loop {
            let open: Vec<(usize, Vec<(&'a str, usize, usize)>)> = long.iter().filter(|&&at| placed[at].is_none()).map(|&at| (at, places(&lines[at], wants, &taken))).collect();
            let alone: Vec<(usize, (&'a str, usize, usize))> = open.iter().filter(|(_, places)| places.len() == 1).map(|(at, places)| (*at, places[0])).collect();
            // (Each that lies may take another's only place: the next round reads what is left.)
            if let Some(&(at, place)) = alone.first() {
                placed[at] = Some(place);
                lie(at, Some(place), &mut taken, &mut laid);
                continue;
            }
            // Of those a paragraph's words hold more than once, the first printed, where it follows closest on the line before it.
            let Some((at, places)) = open.iter().filter(|(_, places)| !places.is_empty()).min_by_key(|(at, _)| *at) else { break };
            let before = |language: &str| placed[..*at].iter().rev().flatten().find(|(other, ..)| *other == language).map_or(0, |(_, _, end)| *end);
            let place = places.iter().copied().min_by_key(|(language, from, _)| (*from < before(language), from.abs_diff(before(language))));
            placed[*at] = place;
            lie(*at, place, &mut taken, &mut laid);
        }
        // A line the report words otherwise than the provider ("(para. 151), and his belief was", "at para. 151 and his belief was"),
        // or that the provider runs another column's words into ("Rosenberg, cial Review of (2009)"), lies on the words open where it
        // stands, before a short line takes a word of them. What a highlight wrongly holds stands on no open words, and what it
        // lacks has no line to lie there.
        for &at in long.iter().filter(|&&at| lines[at].len() >= WORDED_OTHERWISE) {
            if laid[at].is_none() {
                let found = wants.iter().find_map(|(language, want)| open_stretches(&taken[language]).into_iter()
                    .find_map(|(from, to)| reworded_in(lines[at].as_bytes(), &want.as_bytes()[from..to]).map(|(start, end)| (*language, from + start, from + end))));
                lie(at, found, &mut taken, &mut laid);
            }
        }
        for &at in &short {
            let found = exactly(&lines[at], wants, &taken);
            lie(at, found, &mut taken, &mut laid);
        }
        (laid, taken)
    }

    /// A line this long has one place; a shorter one takes what the rest left.
    const ITS_OWN_PLACE: usize = 24;
    /// The fewest letters that can say they are one line worded otherwise.
    const WORDED_OTHERWISE: usize = 24;

    /// Every place a line stands exactly in the words still open.
    fn places<'a>(line: &str, wants: &BTreeMap<&'a str, String>, taken: &BTreeMap<&'a str, Vec<bool>>) -> Vec<(&'a str, usize, usize)> {
        wants.iter().flat_map(|(language, want)| open_stretches(&taken[language]).into_iter().flat_map(move |(from, to)| {
            want[from..to].match_indices(line).map(move |(at, _)| (*language, from + at, from + at + line.len())).collect::<Vec<_>>()
        })).collect()
    }

    /// Where a line stands exactly in the words still open: the narrowest stretch that holds it.
    fn exactly<'a>(line: &str, wants: &BTreeMap<&'a str, String>, taken: &BTreeMap<&'a str, Vec<bool>>) -> Option<(&'a str, usize, usize)> {
        let mut narrowest: Option<(usize, &'a str, usize)> = None;
        for (language, want) in wants {
            for (from, to) in open_stretches(&taken[language]) {
                if narrowest.is_none_or(|(width, ..)| to - from < width) {
                    if let Some(found) = want[from..to].find(line) {
                        narrowest = Some((to - from, *language, from + found));
                    }
                }
            }
        }
        narrowest.map(|(_, language, from)| (language, from, from + line.len()))
    }

    /// Where a line stands in open words that hold four in five of its letters in order within two fifths more than its length, an
    /// opening of it standing there: the span it covers. Chance reaches no such share: unrelated words agree on far fewer.
    fn reworded_in(line: &[u8], open: &[u8]) -> Option<(usize, usize)> {
        const OPENING: usize = 4;
        let need = (line.len() * 4).div_ceil(5);
        let span = line.len() * 7 / 5;
        for (offset, head) in line.windows(OPENING).enumerate().take(line.len() / 4) {
            for start in open.windows(OPENING).enumerate().filter(|(_, letters)| letters == &head).map(|(at, _)| at) {
                let window = &open[start..(start + span).min(open.len())];
                // (The longest run of the line's letters the window holds in order, row by row.)
                let mut row = vec![0usize; window.len() + 1];
                for &letter in line {
                    let mut diagonal = 0;
                    for (at, &other) in window.iter().enumerate() {
                        let above = row[at + 1];
                        row[at + 1] = if letter == other { diagonal + 1 } else { above.max(row[at]) };
                        diagonal = above;
                    }
                }
                let held = row[window.len()];
                if held + offset >= need {
                    let end = row.iter().position(|&count| count == held).unwrap_or(window.len());
                    return Some((start.saturating_sub(offset), start + end));
                }
            }
        }
        None
    }

    fn check_a2aj(reading: &Reading, sha: &str, pair: &Pair, a2aj: &Connection, records: &Path, vouched: bool) -> Result<Value, String> {
        let record = inflate(&records.join(format!("{sha}.json.gz"))).ok();
        let refused = record.as_ref().is_some_and(|record| !record["verdict"]["refused"].is_null());
        let printed: Vec<String> = record.as_ref().and_then(|record| record["page_breaks"].as_object()).map(|breaks| breaks.keys().cloned().collect()).unwrap_or_default();
        let texts: (Option<String>, Option<String>) = a2aj.query_row("select unofficial_text_en, unofficial_text_fr from document where id = ?1", [&pair.a2aj], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        // Each language's paragraphs, by number: the words of the first printing of each.
        let mut read = BTreeMap::<usize, BTreeMap<&str, String>>::new();
        let mut whole = BTreeMap::<&str, String>::new();
        let languages: Vec<&str> = ["en", "fr"].into_iter().filter(|language| printed.is_empty() || printed.iter().any(|p| p == language)).collect();
        for language in &languages {
            let Some(text) = (if *language == "en" { &texts.0 } else { &texts.1 }).as_deref().map(legal_structure::trim_javascript_whitespace).filter(|text| !text.is_empty()) else { continue };
            let scalar = ScalarText::new(text);
            whole.insert(*language, stream(text));
            for (number, ranges) in STRUCTURE_ANALYSIS.judgment_paragraphs(text) {
                let words = ranges.iter().filter_map(|range| scalar.slice_utf16(range.start..range.end)).collect::<Vec<_>>().join(" ");
                // (A number alone over an appendix, the PDF printing none, is no paragraph of the provider's.)
                let want = stream(unnumbered(&words, number));
                if !want.is_empty() {
                    read.entry(number).or_default().entry(language).or_insert(want);
                }
            }
        }
        // A provider's text may number a paragraph otherwise than its PDF ("85" printed twice, one language's reasons set in
        // another order): a paragraph opening on words one printed number alone opens on, and no other of the language's does,
        // goes to that number, where nothing stays. Nothing else moves, and what moves is counted apart.
        let opening = |words: &str| words.chars().take(32).collect::<String>();
        let mut opens = HashMap::<String, HashSet<usize>>::new();
        for (number, lines) in &reading.paragraphs {
            let first = &lines[..lines.len().min(6)];
            for line in first {
                let words = stream(unnumbered(&line.text, *number));
                // The words a number stands before, on their line or on its row.
                let numbered = words != stream(&line.text) || first.iter().any(|mark| stream(unnumbered(&mark.text, *number)).is_empty()
                    && mark.page == line.page && mark.rect[1] < line.rect[3] && line.rect[1] < mark.rect[3]);
                if numbered && words.chars().count() >= 16 {
                    opens.entry(opening(&words)).or_default().insert(*number);
                }
            }
        }
        let mut asked = HashMap::<(&str, String), usize>::new();
        for wants in read.values() {
            for (language, want) in wants {
                *asked.entry((*language, opening(want))).or_default() += 1;
            }
        }
        // (The numbers a text opens on: a printed line may stop short of the opening, "Notre Cour a souligné, à maintes".)
        let opened = |words: &str| -> HashSet<usize> {
            (16..=32).filter_map(|letters| opens.get(&words.chars().take(letters).collect::<String>())).flatten().copied().collect()
        };
        let mut moves = HashMap::<(usize, &str), usize>::new();
        for (number, wants) in &read {
            for (language, want) in wants {
                let numbers = opened(want);
                if numbers.len() == 1 && !numbers.contains(number) && asked[&(*language, opening(want))] == 1 {
                    moves.extend(numbers.iter().map(|to| ((*number, *language), *to)));
                }
            }
        }
        // (Each move in turn: a number that opens on its own paragraph's words takes no other.)
        loop {
            let held: Vec<(usize, &str)> = moves.iter().filter(|((_, language), to)| !moves.contains_key(&(**to, *language)) && read.get(*to).and_then(|wants| wants.get(*language))
                .is_some_and(|own| opened(own).contains(*to))).map(|(key, _)| *key).collect();
            if held.is_empty() {
                break;
            }
            held.iter().for_each(|key| { moves.remove(key); });
        }
        // A paragraph a move leaves no number for stays wrong, however the others read.
        let mut placed = BTreeMap::<usize, BTreeMap<&str, String>>::new();
        let mut stayed = Vec::new();
        let mut displaced = BTreeSet::<usize>::new();
        for (number, wants) in read {
            for (language, want) in wants {
                match moves.get(&(number, language)) {
                    Some(&to) if !placed.get(&to).is_some_and(|wants: &BTreeMap<&str, String>| wants.contains_key(language)) => { placed.entry(to).or_default().insert(language, want); }
                    Some(_) => { displaced.insert(number); }
                    None => stayed.push((number, language, want)),
                }
            }
        }
        for (number, language, want) in stayed {
            if placed.get(&number).is_some_and(|wants| wants.contains_key(language)) {
                displaced.insert(number);
            } else {
                placed.entry(number).or_default().insert(language, want);
            }
        }
        // (A number a language's words left: its words there are no provider's to answer for.)
        let vacated: HashSet<(usize, &str)> = moves.keys().filter(|(number, language)| !placed.get(number).is_some_and(|wants| wants.contains_key(language))).copied().collect();
        let read = placed;
        let mut tally = BTreeMap::<&str, usize>::new();
        if !moves.is_empty() {
            tally.insert("renumbered", moves.len());
        }
        let mut misses = Vec::new();
        for number in displaced {
            *tally.entry("cited").or_default() += 1;
            *tally.entry("displaced").or_default() += 1;
            misses.push(json!([number, "displaced", "", ""]));
        }
        // A number the provider's text holds nowhere is a number the reader alone says: wrong till something vouches for it, a
        // gold's key where the provider prints no numbers at all.
        for number in reading.paragraphs.keys().filter(|number| !read.contains_key(number) && (!read.is_empty() || !vouched && reading.paragraphs.len() <= legal_structure::LIST_NUMBERS)) {
            *tally.entry("cited").or_default() += 1;
            *tally.entry("extra").or_default() += 1;
            misses.push(json!([number, "extra", "", ""]));
        }
        for (number, wants) in &read {
            *tally.entry("cited").or_default() += 1;
            let Some(lines) = reading.paragraphs.get(number) else {
                *tally.entry("missing").or_default() += 1;
                misses.push(json!([number, "missing", "", ""]));
                continue;
            };
            // (A figure the paragraph's words hold is theirs, not its number: "13.07 (1) A judge" in paragraph 13.)
            let own = |text: &str| {
                let (whole, bare) = (stream(text), stream(unnumbered(text, *number)));
                // (A provider may leave out a list's labels: "a)".)
                let unlabelled = list_item(text).and_then(|_| text.trim_start().split_once(char::is_whitespace)).map(|(_, words)| stream(words)).filter(|words| !words.is_empty());
                match unlabelled {
                    _ if !bare.is_empty() && wants.values().any(|want| want.contains(&whole)) => whole,
                    Some(words) if !wants.values().any(|want| want.contains(&bare)) && wants.values().any(|want| want.contains(&words)) => words,
                    _ => bare,
                }
            };
            // (Its words, and whether it is a list's label alone: a provider may leave those out too.)
            let (lines, labels): (Vec<String>, Vec<bool>) = lines.iter().map(|line| (worded(&own(&line.text)), list_item(&line.text).is_some() && line.text.split_whitespace().count() == 1))
                .filter(|(line, _)| !line.is_empty()).unzip();
            let wants: BTreeMap<&str, String> = wants.iter().map(|(language, want)| (*language, worded(want))).collect();
            let (laid, taken) = lay(&lines, &wants);
            // A language's lines come in runs: a line no words hold is the language of the lines it is printed among.
            let mut run = laid.iter().flatten().next().copied().or(wants.keys().next().copied());
            // Each language's highlight, whatever the provider's words hold of it: its two ends are where it opens and closes.
            let mut ends = BTreeMap::<&str, String>::new();
            let mut extra = String::new();
            let mut loose = Vec::<&String>::new();
            let mut elsewhere = String::new();
            for ((line, place), label) in lines.iter().zip(&laid).zip(&labels) {
                run = place.or(run);
                if place.is_none() && !label {
                    let opening: String = line.chars().take(16).collect();
                    // (A language the provider numbers no paragraph here for speaks for nothing: its words are its own, somewhere.)
                    // (Nor one the provider numbers otherwise here, the other language answering: one number for a whole dissent.)
                    if whole.iter().any(|(language, words)| !wants.contains_key(language) && (!vacated.contains(&(*number, *language)) || laid.iter().any(Option::is_some)) && (words.contains(line.as_str()) || words.contains(&opening))) {
                        elsewhere.push_str(line);
                        continue;
                    }
                    // A line no language holds is the highlight's own.
                    extra.push_str(line);
                    loose.push(line);
                }
                if let Some(language) = run {
                    ends.entry(language).or_default().push_str(line);
                }
            }
            // (A language whose paragraph here the highlight holds none of, the highlight's other lines all in that language's text:
            // the provider numbers this stretch otherwise, one number for a whole dissent, and its words here answer for nothing.)
            let unanswered: Vec<&str> = wants.keys().copied().filter(|language| wants.len() > 1 && !laid.contains(&Some(*language)) && !loose.is_empty()
                && loose.iter().all(|line| whole.get(language).is_some_and(|words| words.contains(line.as_str())))).collect();
            if !unanswered.is_empty() {
                extra.clear();
            }
            let answering = || wants.iter().filter(|(language, _)| !unanswered.contains(language));
            let left = |language: &str, want: &str| open_stretches(&taken[language]).iter().map(|&(from, to)| want[from..to].to_owned()).collect::<String>();
            let head = |text: &str, letters: usize| text.chars().take(letters).collect::<String>();
            let tail = |text: &str, letters: usize| text.chars().rev().take(letters).collect::<Vec<_>>().into_iter().rev().collect::<String>();
            // Whether every language's highlight opens and closes on the provider's words.
            // (The same words but for a provider's edition: a few letters off, or half of them standing right at that end.)
            let ends_right = answering().all(|(language, want)| {
                let highlight = ends.get(language).map_or("", String::as_str);
                let (opening, closing) = (head(highlight, 24), tail(highlight, 24));
                opening.chars().count() == 24
                    && (letters_apart(&opening, &head(want, 24)) <= 8 || head(want, 60).contains(&head(&opening, 12)) || head(want, 60).contains(&tail(&opening, 12)))
                    && (letters_apart(&closing, &tail(want, 24)) <= 8 || tail(want, 60).contains(&head(&closing, 12)) || tail(want, 60).contains(&tail(&closing, 12)))
            });
            let (mut lost, mut more): (String, String) = (answering().map(|(language, want)| left(language, want)).collect(), extra);
            let sorted = |text: &str| { let mut letters: Vec<char> = text.chars().collect(); letters.sort_unstable(); letters };
            // A line read into the other language's words is held all the same: what one lacks the other holds. So is a line a
            // letter off the provider's, what it stands for going unread beside it. (What the other language's text holds may
            // answer what this one lost.)
            let answers = |more: &str| sorted(&lost) == sorted(more) || few_letters_apart(&lost, more);
            if answers(&more) || !lost.is_empty() && answers(&format!("{more}{elsewhere}")) {
                (lost, more) = (String::new(), String::new());
            }
            // (With nothing beside it, a few of a language's letters are the provider's, "Morisson", "Morrison", and so is a stretch the
            // page prints no line of: a word it writes twice, a line the report does not hold. A line the highlight left stands
            // among the lines no paragraph holds, or in another number's.)
            if more.is_empty() {
                let printed = |stretch: &str| {
                    let (opening, closing) = (head(stretch, 12), tail(stretch, 12));
                    reading.unheld.iter().any(|line| line.contains(&opening) || line.contains(&closing))
                        || reading.paragraphs.iter().filter(|(other, _)| *other != number).flat_map(|(_, lines)| lines).map(|line| stream(&line.text)).any(|line| line.chars().count() >= 16 && stretch.contains(&line))
                };
                lost = answering().filter(|(language, want)| !few_letters(left(language, want).chars().count(), want.chars().count()))
                    .flat_map(|(language, want)| open_stretches(&taken[language]).into_iter().map(|(from, to)| &want[from..to])).filter(|stretch| printed(stretch)).collect();
            }
            // Figures alone differ where a provider's text leaves out what the PDF prints (a list's own numbers, a note call).
            let figures = |text: &str| text.chars().all(|c| c.is_ascii_digit());
            // A provider vouches for where a paragraph opens and closes, not for a report's words: words apart inside two right
            // ends, as many either way, are its edition against the report's ("dominante", "determinante"). A hole is one-sided.
            let (lacking, beyond) = (lost.chars().count(), more.chars().count());
            let reworded = ends_right && lacking > 0 && beyond > 0 && lacking.abs_diff(beyond) <= 60.max(lacking.max(beyond) / 5);
            let kind = match (lost.is_empty(), more.is_empty()) {
                (true, true) => "whole",
                _ if figures(&lost) && figures(&more) || reworded => "whole",
                (false, true) => "short",
                (true, false) => "spill",
                _ => "both",
            };
            *tally.entry(kind).or_default() += 1;
            if kind != "whole" {
                let cut = |text: &str| text.chars().take(400).collect::<String>();
                misses.push(json!([number, kind, cut(&lost), cut(&more)]));
            }
        }
        Ok(json!({"mode": pair.mode, "citation": pair.citation, "refused": refused, "languages": languages, "tally": tally, "misses": misses}))
    }

    // -- the run ----------------------------------------------------------------------------------------------------

    fn measure(job: &Job, cache: &Path, ocr: Option<&Path>, a2aj: Option<&Connection>, records: &Path) -> Value {
        let started = Instant::now();
        let measured = (|| -> Result<Value, String> {
            let pdf = job.pdf.as_ref().ok_or("no PDF in the corpus")?;
            let bytes = fs::read(pdf).map_err(|e| format!("{}: {e}", pdf.display()))?;
            let reading = read_pdf(&bytes, &job.sha, cache, ocr)?;
            let count = reading.paragraphs.keys().next_back().copied().unwrap_or(0);
            let gaps: Vec<usize> = (1..=count).filter(|number| !reading.paragraphs.contains_key(number)).collect();
            let mut row = json!({"sha": job.sha, "pages": reading.pages, "scanned": reading.scanned, "paragraphs": reading.paragraphs.len(), "count": count,
                "gaps": gaps, "unavailable": reading.unavailable, "between": reading.between.len(),
                "between_lines": reading.between.iter().take(60).map(|(id, text)| json!([id, text])).collect::<Vec<_>>()});
            if let Some((path, layout)) = &job.gold {
                row["gold"] = check_gold(&reading, path, layout).unwrap_or_else(|error| json!({"error": error}));
                // What `regrade` needs to check the reading again without it.
                let held = reading.paragraphs.iter().map(|(number, lines)| (number.to_string(), json!(lines.iter().map(|line| json!([line.page, line.rect])).collect::<Vec<_>>())));
                row["held"] = json!({"path": path, "layout": layout, "paragraphs": held.collect::<serde_json::Map<String, Value>>()});
            }
            if let Some((pair, a2aj)) = job.pair.as_ref().filter(|pair| pair.mode == "digitalborn").zip(a2aj) {
                let vouched = row["gold"]["numbered"] != json!(false) && row["gold"].get("tally").is_some();
                row["a2aj"] = check_a2aj(&reading, &job.sha, pair, a2aj, records, vouched).unwrap_or_else(|error| json!({"error": error}));
            }
            Ok(row)
        })();
        let mut row = measured.unwrap_or_else(|error| json!({"sha": job.sha, "error": error.chars().take(300).collect::<String>()}));
        row["ms"] = json!(started.elapsed().as_millis() as u64);
        row
    }

    /// A row's reading against its gold as the gold stands now.
    fn regraded(row: &Value) -> Value {
        let mut row = row.clone();
        let (Some(path), Some(layout), Some(held)) = (row["held"]["path"].as_str(), row["held"]["layout"].as_str(), row["held"]["paragraphs"].as_object()) else { return row };
        let paragraphs = held.iter().filter_map(|(number, lines)| Some((number.parse().ok()?, items(lines).iter().map(|line| Held {
            page: line[0].as_u64().unwrap_or(0),
            rect: std::array::from_fn(|k| line[1][k].as_f64().unwrap_or(0.0)),
            text: String::new(),
        }).collect()))).collect();
        let reading = Reading { pages: 0, scanned: 0, paragraphs, unavailable: 0, between: Vec::new(), unheld: Vec::new() };
        row["gold"] = check_gold(&reading, Path::new(path), layout).unwrap_or_else(|error| json!({"error": error}));
        row
    }

    /// Grades `from`'s readings again against the golds as they stand, into `out`: no PDF read, seconds.
    fn regrade(from: &Path, out: &Path) {
        fs::create_dir_all(out).unwrap_or_else(|e| panic!("{}: {e}", out.display()));
        let rows = rows_of(&from.join("rows.jsonl"));
        let graded: Vec<Value> = std::thread::scope(|scope| {
            let handles: Vec<_> = rows.chunks(rows.len().div_ceil(4).max(1)).map(|chunk| scope.spawn(move || chunk.iter().map(regraded).collect::<Vec<_>>())).collect();
            handles.into_iter().flat_map(|handle| handle.join().expect("regrade")).collect()
        });
        let text: String = graded.iter().map(|row| format!("{row}
")).collect();
        fs::write(out.join("rows.jsonl"), text).expect("rows");
    }

    /// The jobs a file names ([{sha, pdf, gold, layout}]), for a machine that holds the PDFs and golds but not the corpus.
    fn listed(path: &Path) -> Vec<Job> {
        let jobs: Vec<Value> = serde_json::from_slice(&fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("jobs");
        jobs.iter().map(|job| Job {
            sha: job["sha"].as_str().unwrap_or_default().to_owned(),
            pdf: job["pdf"].as_str().map(PathBuf::from),
            gold: job["gold"].as_str().map(|gold| (PathBuf::from(gold), job["layout"].as_str().unwrap_or("?").to_owned())),
            pair: None,
        }).collect()
    }

    /// Whether a job is a digital-born PDF, by its A2AJ pair or its gold's receipt.
    fn digital_born(job: &Job) -> bool {
        let mode = |path: &PathBuf| fs::read(path.with_file_name("receipt.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|receipt| receipt["mode"] == "digitalborn");
        job.pair.as_ref().is_some_and(|pair| pair.mode == "digitalborn") || job.gold.as_ref().is_some_and(|(path, _)| mode(path))
    }

    /// What a worker says of a PDF.
    enum Heard {
        Started(String),
        Read(Value),
    }

    fn run(out: &Path, store: &str, workers: usize, limit: usize, cache: PathBuf, ocr: Option<PathBuf>, jobs: Option<PathBuf>) {
        fs::create_dir_all(out).unwrap_or_else(|e| panic!("{}: {e}", out.display()));
        let rows_path = out.join("rows.jsonl");
        let started_path = out.join("started.log");
        let done: HashSet<String> = rows_of(&rows_path).iter().filter_map(|row| row["sha"].as_str().map(str::to_owned)).collect();
        let mut rows = OpenOptions::new().create(true).append(true).open(&rows_path).expect("rows");
        // A PDF the last process started and never finished: its error, and the run goes on past it.
        let died: Vec<String> = fs::read_to_string(&started_path).unwrap_or_default().lines().filter(|sha| !done.contains(*sha)).map(str::to_owned).collect();
        for sha in &died {
            writeln!(rows, "{}", json!({"sha": sha, "error": "the process died on this PDF or beside it"})).expect("rows");
        }
        let mut started = OpenOptions::new().create(true).append(true).open(&started_path).expect("started");
        let queue: VecDeque<Job> = jobs.map_or_else(|| stores(store), |jobs| listed(&jobs)).into_iter()
            .filter(|job| !done.contains(&job.sha) && !died.contains(&job.sha) && (store != "digital" || digital_born(job))).take(limit).collect();
        let total = queue.len();
        eprintln!("{total} PDFs to read ({} read before, {} died before), {workers} workers", done.len(), died.len());
        let queue = Arc::new(Mutex::new(queue));
        let (send, receive) = mpsc::channel::<Heard>();
        let home = home();
        let handles: Vec<_> = (0..workers).map(|_| {
            let (queue, send, cache, ocr) = (Arc::clone(&queue), send.clone(), cache.clone(), ocr.clone());
            let (store_path, records) = (home.join("providers/a2aj/a2aj.sqlite"), PathBuf::from(r"E:\OpenLegalData\a2aj-gold\records"));
            std::thread::Builder::new().stack_size(WORKER_STACK).spawn(move || {
                let a2aj = store_path.is_file().then(|| read_only(&store_path));
                while let Some(job) = { let next = queue.lock().expect("queue").pop_front(); next } {
                    let _ = send.send(Heard::Started(job.sha.clone()));
                    let row = catch_unwind(AssertUnwindSafe(|| measure(&job, &cache, ocr.as_deref(), a2aj.as_ref(), &records)))
                        .unwrap_or_else(|_| json!({"sha": job.sha, "error": "panic"}));
                    let _ = send.send(Heard::Read(row));
                }
            }).expect("worker")
        }).collect();
        drop(send);
        let clock = Instant::now();
        let mut finished = 0;
        for message in receive {
            match message {
                Heard::Started(sha) => writeln!(started, "{sha}").expect("started"),
                Heard::Read(row) => {
                    writeln!(rows, "{row}").expect("rows");
                    finished += 1;
                    if finished % 100 == 0 || finished == total {
                        eprintln!("{finished}/{total}  {:.0} s", clock.elapsed().as_secs_f64());
                    }
                }
            }
        }
        for handle in handles {
            let _ = handle.join();
        }
    }

    // -- the table --------------------------------------------------------------------------------------------------

    fn count(value: &Value, key: &str) -> usize {
        value[key].as_u64().unwrap_or(0) as usize
    }

    fn summary(out: &Path) {
        let rows = rows_of(&out.join("rows.jsonl"));
        let mut gold = BTreeMap::<(String, String), BTreeMap<String, usize>>::new();
        let mut a2aj = BTreeMap::<String, BTreeMap<String, usize>>::new();
        let mut free = BTreeMap::<&str, BTreeMap<&str, usize>>::new();
        let (mut gold_misses, mut a2aj_misses, mut free_lines) = (String::new(), String::new(), String::new());
        for row in &rows {
            let sha = row["sha"].as_str().unwrap_or_default();
            let scan = if row.get("error").is_some() { "error" } else if count(row, "scanned") > 0 { "scanned" } else { "digital" };
            let group = free.entry(scan).or_default();
            *group.entry("pdfs").or_default() += 1;
            *group.entry("ms").or_default() += count(row, "ms");
            if count(row, "paragraphs") > 0 {
                *group.entry("numbered").or_default() += 1;
                *group.entry("paragraphs").or_default() += count(row, "paragraphs");
                *group.entry("gaps").or_default() += row["gaps"].as_array().map_or(0, Vec::len);
                *group.entry("between").or_default() += count(row, "between");
            }
            if scan == "digital" && count(row, "paragraphs") > 0 {
                for line in items(&row["between_lines"]) {
                    free_lines.push_str(&format!("{sha} {} {}\n", line[0].as_str().unwrap_or_default(), line[1].as_str().unwrap_or_default()));
                }
            }
            if row["gold"]["numbered"] == true {
                let key = (row["gold"]["mode"].as_str().unwrap_or("?").to_owned(), row["gold"]["layout"].as_str().unwrap_or("?").to_owned());
                let totals = gold.entry(key.clone()).or_default();
                *totals.entry("judgments".to_owned()).or_default() += 1;
                *totals.entry("stray".to_owned()).or_default() += count(&row["gold"], "stray");
                for (kind, number) in row["gold"]["tally"].as_object().into_iter().flatten() {
                    *totals.entry(kind.clone()).or_default() += number.as_u64().unwrap_or(0) as usize;
                }
                for miss in items(&row["gold"]["misses"]) {
                    gold_misses.push_str(&format!("{} {} {sha} {miss}\n", key.0, key.1));
                }
            } else if row["gold"].get("error").is_some() {
                *free.entry("gold errors").or_default().entry("pdfs").or_default() += 1;
            } else if row["gold"]["numbered"] == false && count(row, "paragraphs") > 0 {
                let group = free.entry(if scan == "digital" { "gold unnumbered, digital" } else { "gold unnumbered, scanned" }).or_default();
                *group.entry("pdfs").or_default() += 1;
                *group.entry("paragraphs").or_default() += count(row, "paragraphs");
            }
            if let Some(tally) = row["a2aj"]["tally"].as_object() {
                let key = if row["a2aj"]["refused"] == true { "refused pairing" } else { "aligned" }.to_owned();
                let totals = a2aj.entry(key).or_default();
                *totals.entry("judgments".to_owned()).or_default() += 1;
                for (kind, number) in tally {
                    *totals.entry(kind.clone()).or_default() += number.as_u64().unwrap_or(0) as usize;
                }
                for miss in items(&row["a2aj"]["misses"]) {
                    a2aj_misses.push_str(&format!("{} {sha} {miss}\n", row["a2aj"]["citation"].as_str().unwrap_or_default()));
                }
            }
        }
        for (name, text) in [("gold-misses.txt", gold_misses), ("a2aj-misses.txt", a2aj_misses), ("between-lines.txt", free_lines)] {
            fs::write(out.join(name), text).expect("write");
        }
        let at = |map: &BTreeMap<String, usize>, key: &str| map.get(key).copied().unwrap_or(0);
        println!("gold");
        for (key, c) in &gold {
            println!("  {:12} {:10} judgments {:5}  cited {:6}  whole {:6} ({:.2}%)  zero {:5}  short {:5}  spill {:5}  both {:5}  stray {:6}", key.0, key.1, at(c, "judgments"), at(c, "cited"),
                at(c, "whole"), at(c, "whole") as f64 * 100.0 / at(c, "cited").max(1) as f64, at(c, "zero"), at(c, "short"), at(c, "spill"), at(c, "both"), at(c, "stray"));
        }
        println!("a2aj digital-born");
        for (key, c) in &a2aj {
            println!("  {:16} judgments {:5}  cited {:6}  whole {:6} ({:.2}%)  missing {:5}  short {:5}  spill {:5}  both {:5}", key, at(c, "judgments"), at(c, "cited"),
                at(c, "whole"), at(c, "whole") as f64 * 100.0 / at(c, "cited").max(1) as f64, at(c, "missing"), at(c, "short"), at(c, "spill"), at(c, "both"));
            println!("  {:16} displaced {:5}  extra {:5}  renumbered {:5}", "", at(c, "displaced"), at(c, "extra"), at(c, "renumbered"));
        }
        println!("every PDF read");
        for (key, c) in &free {
            let at = |name: &str| c.get(name).copied().unwrap_or(0);
            println!("  {:24} pdfs {:6}  numbered {:6}  paragraphs {:8}  gaps {:6}  lines between {:7}  {:.2} s/pdf", key, at("pdfs"), at("numbered"), at("paragraphs"), at("gaps"), at("between"), at("ms") as f64 / 1000.0 / at("pdfs").max(1) as f64);
        }
    }

    /// One PDF as the engine reads it: its anchors, and each paragraph's lines.
    fn show(prefix: &str, cache: &Path, ocr: Option<&Path>) {
        let job = stores("all").into_iter().find(|job| job.sha.starts_with(prefix)).unwrap_or_else(|| panic!("{prefix}: no such PDF"));
        let pdf = job.pdf.as_ref().expect("a PDF");
        let bytes = fs::read(pdf).expect("the PDF");
        let mut document = engine::derive_pdf_document(&bytes, &request_of(&job.sha, cache, ocr).expect("request")).expect("derive");
        // A reading the caches hold runs no reader: where its dumps are asked for, the document is read again from its
        // cached extraction (LEGALPDF_ABLATE set to a name no reader takes keys the reader's cache apart).
        if std::env::var_os("LEGALPDF_JUDGMENT_STREAM").is_some() {
            let key = engine::pdf_document_summary(&document).expect("summary").cache_key.clone();
            let _ = fs::remove_file(cache.join("parse-v1").join("documents").join(format!("{key}.json.gz")));
            document = engine::derive_pdf_document(&bytes, &request_of(&job.sha, cache, ocr).expect("request")).expect("derive");
        }
        for anchor in items(&serde_json::to_value(engine::document_anchors(&document, None)).expect("anchors")) {
            println!("{}", json!([anchor["nodeId"], anchor["kind"], anchor["label"], anchor["status"]]));
        }
        // The structure's numbered paragraph nodes: each one's label, lines and pages.
        for node in document.structure().nodes.iter().filter(|node| node.kind == legal_structure::NodeKind::Paragraph) {
            println!("node {} {} lines {} first {} last {} pages {:?}", node.id, node.label.as_deref().unwrap_or("-"), node.line_ids.len(),
                node.line_ids.first().map_or("-", String::as_str), node.line_ids.last().map_or("-", String::as_str), node.page_indexes);
        }
        let reading = read_pdf(&bytes, &job.sha, cache, ocr).expect("read");
        for (number, lines) in &reading.paragraphs {
            println!("== {number}");
            for line in lines {
                println!("  p{} {}", line.page, line.text);
            }
        }
        println!("== between");
        for (id, text) in &reading.between {
            println!("  {id} {text}");
        }
    }

    pub fn main() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let flag = |name: &str| args.iter().position(|arg| arg == name).and_then(|at| args.get(at + 1)).cloned();
        match args.first().map(String::as_str) {
            Some("run") if args.len() >= 2 => {
                engine::install_structure_analysis();
                let out = Path::new(&args[1]);
                let store = flag("--store").unwrap_or_else(|| "all".to_owned());
                let workers = flag("--workers").and_then(|n| n.parse().ok()).unwrap_or(3);
                let limit = flag("--limit").and_then(|n| n.parse().ok()).unwrap_or(usize::MAX);
                let cache = flag("--cache").map_or_else(|| PathBuf::from(r"E:\OpenLegalData\pinpoint\cache"), PathBuf::from);
                run(out, &store, workers, limit, cache, flag("--ocr").map(PathBuf::from), flag("--jobs").map(PathBuf::from));
                summary(out);
            }
            Some("summary") if args.len() >= 2 => summary(Path::new(&args[1])),
            Some("regrade") if args.len() >= 3 => {
                regrade(Path::new(&args[1]), Path::new(&args[2]));
                summary(Path::new(&args[2]));
            }
            Some("show") if args.len() >= 2 => {
                engine::install_structure_analysis();
                let cache = flag("--cache").map_or_else(|| home().join("pinpoint-cache"), PathBuf::from);
                show(&args[1], &cache, flag("--ocr").as_deref().map(Path::new));
            }
            Some("reader") if args.len() >= 2 => {
                // The case reader on a text alone: each number it reads and where.
                let text = fs::read_to_string(&args[1]).unwrap_or_else(|e| panic!("{}: {e}", args[1]));
                let scalar = ScalarText::new(&text);
                for (number, ranges) in STRUCTURE_ANALYSIS.judgment_paragraphs(&text) {
                    let opening = ranges.first().and_then(|range| scalar.slice_utf16(range.start..range.end.min(range.start + 70))).unwrap_or_default().replace('\n', " ");
                    println!("{number}\t{}\t{opening}", ranges.first().map_or(0, |range| range.start));
                }
            }
            _ => {
                eprintln!("usage: pinpoint-corpus run OUT [--store gold|pairs|all] [--workers N] [--limit N] [--cache DIR] [--ocr DIR] | summary OUT | show SHA-PREFIX | reader TEXT-FILE");
                std::process::exit(2);
            }
        }
    }
}
