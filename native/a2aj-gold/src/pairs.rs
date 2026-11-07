//! PDFs paired with their A2AJ decision. A pair is the court's own item number on both (A2AJ's url_en is the item's page; the
//! PDF is the item's document); --by-citation adds PDFs without one, by the citation on their first pages and the words they
//! share. A PDF's words are the corpus's own indexed page text, or its text layer where the corpus has none.
use super::make::a2aj;
use super::pdf;
use super::record::trimmed;
use super::store;
use super::words::plain;
use regex::Regex;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

const SYNTHETIC: [&str; 7] = ["rebuilt", "synth", "warmup", "e2e-", "sample", "debug", "test"];
const MAX_PAGES: usize = 150;
static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/([^/]+/[^/]+)/[a-z]{2}/(?:item/)?(\d+)/(?:\d+/document\.do|index\.do)$").unwrap());

/// (site, item number) of a court's Decisia address: its item page or the item's document. The site is the address's first
/// two folders: an item number is the site's, whichever host serves it.
pub fn item_of(url: &str) -> Option<(String, String)> {
    let (_, rest) = url.split_once("://")?;
    let (host, path) = rest.split_once('/').map_or((rest, ""), |(host, _)| (host, &rest[host.len()..]));
    let path = path.split(['?', '#']).next().unwrap_or("");
    let found = ITEM.captures(path).filter(|_| !host.is_empty())?;
    Some((found[1].to_owned(), found[2].to_owned()))
}

struct Local {
    path: PathBuf,
    sha: String,
    url: Option<String>,
    label: Option<String>,
    collection: Option<String>,
}

fn corpus() -> Result<Connection, String> {
    Connection::open_with_flags(store::corpus_db(), OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(|error| error.to_string())
}

/// Every local PDF: the corpus store's, and the app's provider-PDF receipts (no collection).
fn local_pdfs(db: &Connection) -> Result<Vec<Local>, String> {
    let home = store::data_home();
    let mut out = Vec::new();
    let mut query = db.prepare("select f.path, d.sha256, d.url, d.label, d.collection from documents d join files f using (sha256) where lower(f.path) like '%.pdf'").map_err(|e| e.to_string())?;
    let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).map_err(|e| e.to_string())?;
    for row in rows {
        let (path, sha, url, label, collection) = row.map_err(|e| e.to_string())?;
        let path = PathBuf::from(&path);
        out.push(Local { path: store::spelled(&if path.is_absolute() { path } else { home.join(path) }), sha, url, label, collection });
    }
    let receipts = |folder: PathBuf, blobs: &dyn Fn(&str) -> PathBuf, out: &mut Vec<Local>| {
        for file in fs::read_dir(folder).into_iter().flatten().flatten() {
            if file.path().extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let Ok(record) = store::read_json(&file.path()) else { continue };
            let sha = record["source_sha256"].as_str().unwrap_or("").to_owned();
            let url = record["canonical_url"].as_str().filter(|url| !url.is_empty()).or(record["url"].as_str()).map(str::to_owned);
            out.push(Local { path: blobs(&sha), sha, url, label: None, collection: None });
        }
    };
    for base in ["apps/mike/launcher/data-20260904", "apps/mike/library-current", "apps/mike/library-v9"] {
        let content = home.join(base).join("projections/v1/content/pdf");
        receipts(home.join(base).join("projections/v1/source-pdf"), &|sha| content.join(sha.get(..2).unwrap_or("")).join(format!("{sha}.pdf")), &mut out);
    }
    let blobs = home.join("cache/a2aj/pdf/blobs");
    receipts(home.join("cache/a2aj/pdf/requests"), &|sha| blobs.join(format!("{sha}.pdf")), &mut out);
    Ok(out)
}

/// A PDF's pages' text, as the corpus indexed it; else its text layer.
fn page_texts(db: &Connection, sha: &str, path: &Path) -> Vec<String> {
    let indexed: Vec<String> = db.prepare_cached("select text from pages where sha256 = ? order by page")
        .and_then(|mut query| query.query_map([sha], |row| row.get::<_, Option<String>>(0)).map(|rows| rows.flatten().map(Option::unwrap_or_default).collect()))
        .unwrap_or_default();
    if indexed.is_empty() { pdf::page_texts(path) } else { indexed }
}

/// The pages of six spread through a PDF of `n`.
fn sampled(n: usize) -> BTreeSet<usize> {
    if n > 1 { (0..6).map(|k| ((k * (n - 1)) as f64 / 5.0).round_ties_even() as usize).collect() } else { [0].into() }
}

/// ocr when at least half of six sampled pages are mostly one image or carry no text, else digitalborn.
fn mode_of(path: &Path, texts: &[String]) -> &'static str {
    let images = pdf::images_of(path, |page, count| sampled(count).contains(&page));
    let n = images.len().max(texts.len());
    if n == 0 {
        return "ocr";
    }
    let sample = sampled(n);
    let scanned = sample.iter().filter(|&&page| {
        let on = images.get(page);
        let big = on.map_or(0.0, |on| {
            let area = (on.size.0 * on.size.1).max(1.0);
            on.boxes.iter().map(|b| {
                let (w, h) = ((b[2].min(on.size.0) - b[0].max(0.0)).max(0.0), (b[3].min(on.size.1) - b[1].max(0.0)).max(0.0));
                w * h / area
            }).fold(0.0, f64::max)
        });
        big >= 0.5 || texts.get(page).map_or(0, |text| text.trim().chars().count()) < 20
    }).count();
    if scanned * 2 >= sample.len() { "ocr" } else { "digitalborn" }
}

fn shingles(text: &str) -> HashSet<[String; 4]> {
    let words = plain(text);
    words.windows(4).map(|w| [w[0].clone(), w[1].clone(), w[2].clone(), w[3].clone()]).collect()
}

fn decision_shingles(db: &Connection, id: i64) -> HashSet<[String; 4]> {
    let mut out = HashSet::new();
    for language in ["en", "fr"] {
        if let Ok(Some(text)) = super::make::a2aj_text(db, rusqlite::types::Value::Integer(id), language) {
            out.extend(shingles(&text));
        }
    }
    out
}

/// For PDFs without an item address: the A2AJ case a citation on their first two pages names (a neutral citation, or a
/// report's: the Supreme Court Reports print no neutral one), of those, the one whose text (both its languages: a bilingual
/// report prints both) holds most of the PDF's four-word runs, at least half of them.
fn by_citation(wanted: &[&Local], db: &Connection, cases: &Connection) -> (HashMap<String, i64>, HashMap<String, String>) {
    let (mut out, mut why) = (HashMap::new(), HashMap::new());
    for local in wanted {
        let texts = page_texts(cases, &local.sha, &local.path);
        let first = texts.iter().take(2).cloned().collect::<Vec<_>>().join("\n");
        if first.trim().is_empty() {
            why.insert(local.sha.clone(), "no text on its first pages (a scan without a text layer): no citation to read".to_owned());
            continue;
        }
        let found = serde_json::to_value(legal_structure::provider_citations_in_text(&first)).unwrap_or(Value::Null);
        let mut cited: Vec<String> = Vec::new();
        for citation in found.as_array().into_iter().flatten() {
            let (text, family) = (citation["text"].as_str().unwrap_or(""), citation["family"].as_str().unwrap_or(""));
            if matches!(family, "neutral" | "reporter") && !cited.iter().any(|c| c == text) {
                cited.push(text.to_owned());
            }
        }
        let mut ids: Vec<i64> = Vec::new();
        for citation in cited.iter().take(8) {
            let key = legal_structure::citation_lookup_key(citation);
            let mut query = db.prepare_cached("select c.document_id from citation_lookup c join document d on d.id = c.document_id where c.citation_key = ? and d.doc_type = 'cases'").unwrap();
            ids.extend(query.query_map([&key], |row| row.get::<_, i64>(0)).map(|rows| rows.flatten().collect::<Vec<_>>()).unwrap_or_default());
        }
        ids.sort_unstable();
        ids.dedup();
        if ids.is_empty() {
            why.insert(local.sha.clone(), if cited.is_empty() { "no citation on its first pages" } else { "cites no decision A2AJ holds on its first pages" }.to_owned());
            continue;
        }
        let own = shingles(&texts.join("\n"));
        let share = |id: i64| decision_shingles(db, id).intersection(&own).count() as f64 / own.len().max(1) as f64;
        let best = ids.iter().map(|&id| (share(id), id)).fold((-1.0, 0), |best, entry| if entry.0 > best.0 { entry } else { best });
        if best.0 >= 0.5 {
            out.insert(local.sha.clone(), best.1);
        } else {
            why.insert(local.sha.clone(), format!("the A2AJ decisions it cites on its first pages share at most {:.0}% of its words", best.0 * 100.0));
        }
    }
    (out, why)
}

pub fn now() -> String {
    let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rest) = (seconds.div_euclid(86400), seconds.rem_euclid(86400));
    // Civil date from days since the epoch (Hinnant).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (day, month) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let year = yoe + era * 400 + (month <= 2) as i64;
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}+00:00", rest / 3600, rest % 3600 / 60, rest % 60)
}

fn known(sha: &str) -> Result<Option<String>, String> {
    Ok(corpus()?.query_row("select path from files where sha256 = ?", [sha], |row| row.get::<_, String>(0)).ok().map(|path| path.replace('\\', "/")))
}

/// The PDF's path in the corpus home where the corpus holds it, else where it stands now.
pub fn located(pair: &Value) -> Result<String, String> {
    Ok(known(pair["sha256"].as_str().unwrap_or(""))?.unwrap_or_else(|| pair["path"].as_str().unwrap_or("").to_owned()))
}

/// The PDF's path in the corpus home, as the corpus's files table has it: a PDF the corpus does not hold (the disposable A2AJ
/// PDF cache's, the app library's) is stored there first (legal-pdf, judgment), with its pages' text.
pub fn durable(pair: &Value) -> Result<String, String> {
    let sha = pair["sha256"].as_str().unwrap_or("");
    if let Some(path) = known(sha)? {
        return Ok(path);
    }
    let source = Path::new(pair["path"].as_str().unwrap_or(""));
    let body = fs::read(source).map_err(|error| format!("{}: {error}", source.display()))?;
    let relative = format!("corpus/legal-pdf/ca/judgment/{sha}.pdf");
    let target = store::data_home().join(&relative);
    if !target.exists() {
        store::write_atomic(&target, &body)?;
    }
    let texts = pdf::page_texts(source);
    let mut db = store::corpus_writer()?;
    let done = db.transaction().map_err(|e| e.to_string())?;
    done.execute("insert into files values (?,?,?,?,?,?,?)", params![sha, relative, body.len() as i64, "application/pdf", texts.len() as i64, store::hex(&Sha256::digest(texts.join("\u{c}").as_bytes())), now()]).map_err(|e| e.to_string())?;
    for (page, text) in texts.iter().enumerate() {
        done.execute("insert into pages(sha256, page, text) values (?,?,?)", params![sha, page as i64 + 1, text]).map_err(|e| e.to_string())?;
    }
    let provenance = format!("{}, paired with its A2AJ decision and stored for its {} structure gold", source.display(), store::LABEL_SOURCE);
    let noted: bool = done.query_row("select exists(select 1 from documents where url is null and sha256 = ? and collection is ?)", params![sha, "legal-pdf"], |row| row.get(0)).map_err(|e| e.to_string())?;
    if !noted {
        done.execute("insert into documents(sha256, collection, jurisdiction, kind, label, fetched_at, last_seen_at, provenance) values (?,?,?,?,?,?,?,?)",
                     params![sha, "legal-pdf", "ca", "judgment", pair["citation"].as_str(), None::<String>, now(), provenance]).map_err(|e| e.to_string())?;
    }
    done.commit().map_err(|e| e.to_string())?;
    Ok(relative)
}

fn register_pairs(rows: &[Value]) -> Result<(), String> {
    let mut db = store::corpus_writer()?;
    let done = db.transaction().map_err(|e| e.to_string())?;
    done.execute("delete from a2aj_pairs", []).map_err(|e| e.to_string())?;
    for row in rows {
        let languages: Vec<&str> = row["languages"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        done.execute("insert into a2aj_pairs(sha256, a2aj_id, citation, mode, route, languages, paired_at) values (?,?,?,?,?,?,?)",
                     params![row["sha256"].as_str(), row["a2aj"].as_i64(), row["citation"].as_str(), row["mode"].as_str(), row["route"].as_str(), languages.join(","), now()]).map_err(|e| e.to_string())?;
    }
    done.commit().map_err(|e| e.to_string())
}

/// WORK/pairs.jsonl; and WORK/unpaired.jsonl: each PDF of the collections --by-citation names that pairs with no A2AJ
/// decision, and why.
pub fn pairs(work: &Path, citation: Option<Vec<String>>, register: bool) -> Result<(), String> {
    fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let (cases, files) = (a2aj()?, corpus()?);
    let mut by_item: HashMap<(String, String), i64> = HashMap::new();
    {
        let mut query = cases.prepare("select id, url_en, url_fr from document where doc_type = 'cases'").map_err(|e| e.to_string())?;
        let rows = query.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?))).map_err(|e| e.to_string())?;
        for (id, en, fr) in rows.flatten() {
            for url in [en, fr].into_iter().flatten() {
                if let Some(item) = item_of(&url) {
                    by_item.entry(item).or_insert(id);
                }
            }
        }
    }
    let wanted = |collection: &Option<String>| citation.as_ref().is_some_and(|names| names.is_empty() || collection.as_ref().is_some_and(|c| names.contains(c)));
    let locals = local_pdfs(&files)?;
    let (mut found, mut unpaired, mut considered, mut refused, mut why): (BTreeMap<String, (PathBuf, i64, &str)>, Vec<&Local>, BTreeMap<String, &Local>, BTreeMap<&str, u64>, HashMap<String, String>) =
        (BTreeMap::new(), Vec::new(), BTreeMap::new(), BTreeMap::new(), HashMap::new());
    for local in &locals {
        if wanted(&local.collection) {
            considered.entry(local.sha.clone()).or_insert(local);
        }
        if found.contains_key(&local.sha) || !local.path.is_file() {
            continue;
        }
        if SYNTHETIC.iter().any(|word| local.label.as_deref().unwrap_or("").to_lowercase().contains(word)) {
            *refused.entry("synthetic copy").or_default() += 1;
            why.insert(local.sha.clone(), "a synthetic copy".to_owned());
            continue;
        }
        if let Some(&id) = local.url.as_deref().and_then(item_of).and_then(|item| by_item.get(&item)) {
            found.insert(local.sha.clone(), (local.path.clone(), id, "item"));
        } else if wanted(&local.collection) {
            unpaired.push(local);
        }
    }
    if citation.is_some() {
        let mut distinct: BTreeMap<&str, &Local> = BTreeMap::new();
        for local in &unpaired {
            distinct.insert(&local.sha, local);
        }
        let list: Vec<&Local> = distinct.into_values().collect();
        let (cited, not_cited) = by_citation(&list, &cases, &files);
        why.extend(not_cited);
        for (sha, id) in cited {
            let path = list.iter().find(|local| local.sha == sha).unwrap().path.clone();
            found.entry(sha).or_insert((path, id, "citation"));
        }
    }
    let (mut rows, mut printed): (Vec<Value>, HashMap<String, String>) = (Vec::new(), HashMap::new());
    for (sha, (path, id, route)) in &found {
        let texts = page_texts(&files, sha, path);
        let filed: Option<usize> = files.query_row("select pages from files where sha256 = ?", [sha], |row| row.get::<_, Option<i64>>(0)).ok().flatten().filter(|&n| n > 0).map(|n| n as usize);
        let pages = filed.or_else(|| pdf::page_count(path)).unwrap_or(texts.len());
        if pages > MAX_PAGES {
            *refused.entry("over 150 pages").or_default() += 1;
            why.insert(sha.clone(), "over 150 pages".to_owned());
            continue;
        }
        // A re-saved or highlighted copy of a PDF prints the same text: one of them is the document.
        let text = texts.join("\u{c}");
        if !text.trim().is_empty() && printed.entry(store::hex(&Sha256::digest(text.as_bytes()))).or_insert_with(|| sha.clone()) != sha {
            *refused.entry("copy of another PDF").or_default() += 1;
            why.insert(sha.clone(), "a copy of another PDF".to_owned());
            continue;
        }
        let mode = mode_of(path, &texts);
        let row = cases.query_row("select citation_en, citation_fr, name_en, name_fr, document_date_en, document_date_fr, dataset from document where id = ?", [id], |row| {
            Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<String>>(6)?))
        }).map_err(|e| e.to_string())?;
        let some = |a: Option<String>, b: Option<String>| a.filter(|t| !t.is_empty()).or(b.filter(|t| !t.is_empty()));
        let date: String = some(row.4, row.5).unwrap_or_default().chars().take(10).collect();
        let languages: Vec<&str> = ["en", "fr"].into_iter().filter(|language| super::make::a2aj_text(&cases, rusqlite::types::Value::Integer(*id), language).ok().flatten().is_some_and(|t| !trimmed(&t).is_empty())).collect();
        rows.push(json!({"sha256": sha, "path": path, "pages": pages, "mode": mode, "route": route, "a2aj": id, "citation": some(row.0, row.1), "name": some(row.2, row.3),
                         "date": date, "court": row.6, "languages": languages}));
    }
    let mut body = String::new();
    for row in &rows {
        body.push_str(&row.to_string());
        body.push('\n');
    }
    store::write_atomic(&work.join("pairs.jsonl"), body.as_bytes())?;
    if register {
        for row in &rows {
            durable(row)?;
        }
        register_pairs(&rows)?;
    }
    if citation.is_some() {
        let paired: HashSet<&str> = rows.iter().filter_map(|row| row["sha256"].as_str()).collect();
        let mut out = fs::File::create(work.join("unpaired.jsonl")).map_err(|e| e.to_string())?;
        for (sha, local) in &considered {
            if !paired.contains(sha.as_str()) {
                let because = why.get(sha).cloned().unwrap_or_else(|| if local.path.is_file() { "no item address A2AJ holds".to_owned() } else { "no PDF file".to_owned() });
                writeln!(out, "{}", json!({"sha256": sha, "path": local.path, "url": local.url, "label": local.label, "collection": local.collection, "why": because})).map_err(|e| e.to_string())?;
            }
        }
    }
    let count = |field: &str| { let mut seen: BTreeMap<String, u64> = BTreeMap::new(); for row in &rows { *seen.entry(row[field].as_str().unwrap_or("").to_owned()).or_default() += 1; } seen };
    println!("{} pairs ({:?}; {:?}); refused {refused:?} -> {}", rows.len(), count("route"), count("mode"), work.join("pairs.jsonl").display());
    Ok(())
}
