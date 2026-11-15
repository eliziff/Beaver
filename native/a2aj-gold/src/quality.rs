//! Two runs compared, document by document, and a gold measured: against what its page prints (the numbers it sets at its
//! margin, read off its lines alone) and against A2AJ's paragraphs through the alignment's word pairs.
use super::book::Book;
use super::conventions::numbering;
use super::label::nodes;
use super::make::{a2aj_text, Listings};
use super::printed::{rising, Candidate, OPENS};
use super::store::{self, on_cores};
use crate::freeze;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// What a gold's row is made by: this measure and what it reads a gold and A2AJ's listings with.
static MEASURE_CODE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for source in [include_str!("quality.rs"), include_str!("book.rs"), include_str!("conventions.rs"), include_str!("label.rs"), include_str!("printed.rs"),
                   include_str!("freeze.rs"), include_str!("page.rs"), include_str!("make.rs"), include_str!("gold_store.rs")] {
        hash.update(source);
    }
    store::hex(&hash.finalize())
});

fn named(folder: &Path) -> BTreeSet<String> {
    fs::read_dir(folder).into_iter().flatten().flatten().filter_map(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        let sha = name.get(..64)?;
        sha.bytes().all(|byte| byte.is_ascii_hexdigit()).then(|| sha.to_owned())
    }).collect()
}

/// A source's gold or record in a folder: `<sha>.json.gz`, or the store's layout.
fn held(folder: &Path, sha: &str) -> Option<PathBuf> {
    let flat = folder.join(format!("{sha}.json.gz"));
    if flat.is_file() {
        return Some(flat);
    }
    store::structure_runs(&folder.join(sha)).into_iter().next().map(|run| run.join("gold.json.gz"))
}

fn layout_of(value: &Value) -> &'static str {
    let languages = value["authoring"]["languages"].as_array().map_or_else(|| value["pair"]["languages"].as_array().map_or(1, Vec::len), Vec::len);
    if languages > 1 { "parallel" } else { "one" }
}

fn mode_of(value: &Value) -> String {
    value["mode"].as_str().or(value["pair"]["mode"].as_str()).unwrap_or("?").to_owned()
}

/// Every place two values differ, by path with its indices masked. Numbers compare as numbers.
fn deep(a: &Value, b: &Value, path: &str, found: &mut BTreeMap<String, u64>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for key in x.keys().chain(y.keys().filter(|key| !x.contains_key(*key))) {
                let inner = format!("{path}.{key}");
                match (x.get(key), y.get(key)) {
                    (Some(p), Some(q)) => deep(p, q, &inner, found),
                    _ => *found.entry(format!("{inner} (one side)")).or_default() += 1,
                }
            }
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                *found.entry(format!("{path} (length)")).or_default() += 1;
            }
            for (p, q) in x.iter().zip(y) {
                deep(p, q, &format!("{path}[]"), found);
            }
        }
        (Value::Number(x), Value::Number(y)) if x.as_f64() == y.as_f64() => {}
        _ if a == b => {}
        _ => *found.entry(path.to_owned()).or_default() += 1,
    }
}

/// A gold as a reader of it sees it, by line.
struct View {
    texts: HashMap<String, String>,
    regions: HashMap<String, BTreeSet<String>>,
    opens: BTreeSet<String>,
    marks: BTreeSet<(String, String)>,
    count: Value,
    printings: BTreeMap<String, BTreeSet<BTreeSet<String>>>,
    numbers: HashMap<String, BTreeSet<String>>,
    speaks_for: BTreeSet<String>,
}

fn view(gold: &Value) -> View {
    let book = Book::of(gold);
    let (mut regions, mut opens, mut marks): (HashMap<String, BTreeSet<String>>, BTreeSet<String>, BTreeSet<(String, String)>) = Default::default();
    for t in 0..book.typed.len() {
        for span in book.spans(t) {
            regions.entry(span["line_id"].as_str().unwrap_or("").to_owned()).or_default().insert(book.region(t).to_owned());
        }
        for mark in book.markers(t) {
            if let Some((said, line)) = book.printed(mark) {
                marks.insert((line.id.clone(), said.trim().to_owned()));
            }
        }
    }
    for u in 0..book.units.len() {
        if let Some(&t) = book.members(u).first() {
            opens.extend(book.spans(t).first().and_then(|span| span["line_id"].as_str()).map(str::to_owned));
        }
    }
    let computed;
    let key = if gold["paragraphs"].is_null() {
        computed = freeze::answer(gold, layout_of(gold) == "parallel");
        &computed
    } else {
        &gold["paragraphs"]
    };
    let (mut printings, mut numbers): (BTreeMap<String, BTreeSet<BTreeSet<String>>>, HashMap<String, BTreeSet<String>>) = Default::default();
    for (number, printed) in key["printings"].as_object().into_iter().flatten() {
        for printing in printed.as_array().into_iter().flatten() {
            let ids: BTreeSet<String> = printing.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
            for id in &ids {
                numbers.entry(id.clone()).or_default().insert(number.clone());
            }
            printings.entry(number.clone()).or_default().insert(ids);
        }
    }
    let speaks_for = key["speaks_for"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    let texts = book.lines.iter().map(|line| (line.id.clone(), line.spelled())).collect();
    View { texts, regions, opens, marks, count: key["count"].clone(), printings, numbers, speaks_for }
}

/// Two golds of one source: what differs, by what a reader would see.
fn gold_diff(a: &Value, b: &Value) -> Value {
    let (x, y) = (view(a), view(b));
    let text_differs = x.texts.iter().filter(|(id, text)| y.texts.get(*id).is_some_and(|other| other != *text)).count();
    let lines_only = x.texts.keys().filter(|id| !y.texts.contains_key(*id)).count() + y.texts.keys().filter(|id| !x.texts.contains_key(*id)).count();
    let mut regions: BTreeMap<String, u64> = BTreeMap::new();
    for id in x.texts.keys() {
        let (p, q) = (x.regions.get(id), y.regions.get(id));
        if p != q {
            let said = |set: Option<&BTreeSet<String>>| set.map_or("-".to_owned(), |set| set.iter().cloned().collect::<Vec<_>>().join("+"));
            *regions.entry(format!("{}>{}", said(p), said(q))).or_default() += 1;
        }
    }
    let lines_moved = x.texts.keys().filter(|id| x.numbers.get(*id) != y.numbers.get(*id)).count();
    let mine: BTreeSet<&String> = x.printings.keys().collect();
    let theirs: BTreeSet<&String> = y.printings.keys().collect();
    let numbers_differ = mine.intersection(&theirs).filter(|number| x.printings[**number] != y.printings[**number]).count();
    json!({
        "text_differs": text_differs, "lines_only": lines_only, "regions": regions,
        "opens": x.opens.symmetric_difference(&y.opens).count(), "marks_only_a": x.marks.difference(&y.marks).count(), "marks_only_b": y.marks.difference(&x.marks).count(),
        "count_a": x.count, "count_b": y.count, "numbers_only_a": mine.difference(&theirs).count(), "numbers_only_b": theirs.difference(&mine).count(),
        "numbers_differ": numbers_differ, "lines_moved": lines_moved, "speaks_for_differ": x.speaks_for.symmetric_difference(&y.speaks_for).count(),
    })
}

fn gold_same(row: &Value) -> bool {
    ["text_differs", "lines_only", "opens", "marks_only_a", "marks_only_b", "numbers_only_a", "numbers_only_b", "numbers_differ", "lines_moved", "speaks_for_differ"].iter().all(|name| row[name] == 0)
        && row["regions"].as_object().is_some_and(Map::is_empty) && row["count_a"] == row["count_b"]
}

type Tally = BTreeMap<String, BTreeMap<String, u64>>;

fn add(tally: &mut Tally, group: &str, name: &str, by: u64) {
    *tally.entry(group.to_owned()).or_default().entry(name.to_owned()).or_default() += by;
}

fn summary(out: &Path, name: &str, tally: &Tally) -> Result<(), String> {
    let mut text = String::new();
    for (group, names) in tally {
        text.push_str(&format!("{group}\n"));
        for (name, n) in names {
            text.push_str(&format!("  {name}: {n}\n"));
        }
    }
    print!("{text}");
    fs::write(out.join(name), text).map_err(|e| e.to_string())
}

/// Each document of two folders compared -> OUT/diff.jsonl and OUT/diff-summary.txt. Golds by what a reader sees of them, lines
/// by id; records (`records`) field by field, their stamps aside. A document on one side only is listed as that.
pub fn diff(a: &Path, b: &Path, out: &Path, records: bool) -> Result<(), String> {
    fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let mut rows = fs::File::create(out.join("diff.jsonl")).map_err(|e| e.to_string())?;
    let (left, right) = (named(a), named(b));
    let mut tally = Tally::new();
    for sha in left.union(&right) {
        let (p, q) = (held(a, sha).filter(|_| left.contains(sha)), held(b, sha).filter(|_| right.contains(sha)));
        let (Some(p), Some(q)) = (p.clone(), q.clone()) else {
            let side = if p.is_some() { "a" } else { "b" };
            writeln!(rows, "{}", json!({"sha": sha, "only": side})).map_err(|e| e.to_string())?;
            add(&mut tally, "documents", &format!("only {side}"), 1);
            continue;
        };
        let (x, y) = (store::read_json(&p)?, store::read_json(&q)?);
        let group = format!("{} {}", mode_of(&x), layout_of(&x));
        add(&mut tally, &group, "documents", 1);
        let mut row = json!({"sha": sha, "group": group});
        if records {
            let mut found = BTreeMap::new();
            deep(&x, &y, "", &mut found);
            found.retain(|path, _| !matches!(path.as_str(), ".code" | ".read"));
            add(&mut tally, &group, "identical", found.is_empty() as u64);
            for (path, n) in &found {
                add(&mut tally, &group, path, *n);
                add(&mut tally, &format!("{group}, documents with"), path, 1);
            }
            row["differs"] = json!(found);
        } else {
            let compared = gold_diff(&x, &y);
            add(&mut tally, &group, "identical", gold_same(&compared) as u64);
            add(&mut tally, &group, "key identical", (compared["numbers_differ"] == 0 && compared["numbers_only_a"] == 0 && compared["numbers_only_b"] == 0 && compared["lines_moved"] == 0 && compared["count_a"] == compared["count_b"]) as u64);
            add(&mut tally, &group, "count differs", (compared["count_a"] != compared["count_b"]) as u64);
            for name in ["text_differs", "lines_only", "opens", "marks_only_a", "marks_only_b", "numbers_only_a", "numbers_only_b", "numbers_differ", "lines_moved", "speaks_for_differ"] {
                add(&mut tally, &group, name, compared[name].as_u64().unwrap_or(0));
            }
            for (pair, n) in compared["regions"].as_object().into_iter().flatten() {
                add(&mut tally, &format!("{group}, regions"), pair, n.as_u64().unwrap_or(0));
            }
            row["differs"] = compared;
        }
        writeln!(rows, "{row}").map_err(|e| e.to_string())?;
    }
    summary(out, "diff-summary.txt", &tally)
}

/// The numbers a document's lines print in the one style and at the one place its count runs in, by stream (a parallel
/// report's left and right columns and its margin): the longest rising run of each style, the longest of them.
fn printed_numbers(lines: &[Value], parallel: bool) -> BTreeMap<&'static str, Vec<Candidate>> {
    let mut extent: HashMap<i64, (f64, f64)> = HashMap::new();
    let mut edges: HashMap<i64, Vec<(f64, usize)>> = HashMap::new();
    let bbox = |line: &Value| [0, 1, 2, 3].map(|at| line["bbox"][at].as_f64().unwrap_or(0.0));
    for (k, line) in lines.iter().enumerate() {
        let (page, b) = (line["page"].as_i64().unwrap_or(0), bbox(line));
        if line["text"].as_str().unwrap_or("").trim().chars().count() >= 20 {
            let entry = extent.entry(page).or_insert((f64::MAX, f64::MIN));
            *entry = (entry.0.min(b[0]), entry.1.max(b[2]));
        }
        edges.entry(page).or_default().push((b[1], k));
    }
    let mut edge: HashSet<usize> = HashSet::new();
    for on in edges.values_mut() {
        on.sort_by(|a, b| a.0.total_cmp(&b.0));
        edge.extend(on.iter().take(2).chain(on.iter().rev().take(2)).map(|entry| entry.1));
    }
    let mut groups: BTreeMap<(&'static str, &'static str), Vec<Candidate>> = BTreeMap::new();
    for (k, line) in lines.iter().enumerate() {
        let said = line["text"].as_str().unwrap_or("");
        let Some(found) = OPENS.captures(said) else { continue };
        let whole = found.get(0).unwrap();
        if !said[whole.end()..].chars().next().is_none_or(char::is_whitespace) {
            continue;
        }
        let marker = found.get(1).unwrap();
        let Some((style, number)) = numbering(marker.as_str()) else { continue };
        // (A number alone at a page's head or foot is its folio.)
        if style == "bare" && said.trim() == marker.as_str() && edge.contains(&k) {
            continue;
        }
        let (page, b) = (line["page"].as_i64().unwrap_or(0), bbox(line));
        let stream = match extent.get(&page) {
            Some(&(left, right)) if parallel => if b[2] < left - 2.0 || b[0] > right + 2.0 { "margin" } else if (b[0] + b[2]) / 2.0 <= (left + right) / 2.0 { "left" } else { "right" },
            _ => "one",
        };
        groups.entry((stream, style)).or_default().push(Candidate { place: (page, b[1]), number, line: k, start: 0, end: 0 });
    }
    let mut best: BTreeMap<&'static str, Vec<Candidate>> = BTreeMap::new();
    for ((stream, _), mut found) in groups {
        found.sort_by(|a, b| a.place.partial_cmp(&b.place).unwrap_or(std::cmp::Ordering::Equal));
        let chain = rising(&found);
        let last = chain.last().map_or(0, |c| c.number as usize);
        if chain.len() >= 3 && chain.len() * 2 >= last && best.get(stream).is_none_or(|known| known.len() < chain.len()) {
            best.insert(stream, chain);
        }
    }
    best
}

/// What A2AJ's reading of a decision holds besides its numbered paragraphs, over the languages the gold prints.
#[derive(Default)]
struct Held {
    headings: u64,
    notes: u64,
}

const MATTER: [&str; 3] = ["furniture", "page_label", "line_label"];

/// The gold's lines, typed lines and units against the page and A2AJ, class by class: the page matter it types as the
/// decision's text and the decision's text it types as page matter, the lines it leaves untyped or types where the alignment
/// placed none of their words, and its headings and notes against A2AJ's.
fn classes(gold: &Value, record: &Value, held: &Held) -> Value {
    let book = Book::of(gold);
    let sizes: HashMap<i64, (f64, f64)> = record["pages"].as_object().into_iter().flatten()
        .filter_map(|(page, size)| Some((page.parse().ok()?, (size[0].as_f64()?, size[1].as_f64()?)))).collect();
    let pages = sizes.len().max(1);
    let by_id: HashMap<&str, &Value> = record["lines"].as_array().into_iter().flatten()
        .map(|line| (line["of"]["id"].as_str().or(line["id"].as_str()).unwrap_or(""), line)).collect();
    let mut region_of: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    for t in 0..book.typed.len() {
        for span in book.spans(t) {
            region_of.entry(span["line_id"].as_str().unwrap_or("")).or_default().insert(book.region(t));
        }
    }
    // A running head or foot: its words, digits masked, at a page's head or foot on a quarter of the pages and three at least.
    let mut recurs: HashMap<String, BTreeSet<i64>> = HashMap::new();
    let key = |line: &super::book::PageLine| -> Option<String> {
        let size = sizes.get(&line.page).copied().unwrap_or(super::page::DEFAULT_PAGE);
        (super::page::margin(&line.bbox, size) == Some("head")).then(|| super::page::masked(&line.spelled())).filter(|key| key.chars().any(char::is_alphabetic))
    };
    for line in &book.lines {
        if let Some(key) = key(line) {
            recurs.entry(key).or_default().insert(line.page);
        }
    }
    let running = |line: &super::book::PageLine| key(line).is_some_and(|key| recurs[&key].len() >= 3 && recurs[&key].len() * 4 >= pages);
    let (mut matter_as_text, mut untyped, mut typed_unplaced, mut lettered, mut untyped_aligned) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut examples: Vec<Value> = Vec::new();
    for line in &book.lines {
        let letters = line.text.iter().filter(|c| c.is_alphabetic()).count();
        if letters < 2 {
            continue;
        }
        lettered += 1;
        let regions = region_of.get(line.id.as_str());
        let record_line = by_id.get(line.id.as_str());
        let matched = record_line.is_some_and(|l| l["status"] != "unmatched");
        match regions {
            None if matched => {
                untyped += 1;
                untyped_aligned += 1;
                if examples.len() < 10 {
                    examples.push(json!({"line": line.id, "class": "aligned, untyped", "text": line.spelled()}));
                }
            }
            None => untyped += 1,
            Some(regions) if regions.iter().all(|region| !MATTER.contains(region)) => {
                if running(line) {
                    matter_as_text += 1;
                    if examples.len() < 10 {
                        examples.push(json!({"line": line.id, "class": "running head typed as text", "text": line.spelled()}));
                    }
                }
                if !matched && record_line.is_some_and(|l| l["why"] == "unexplained") {
                    typed_unplaced += 1;
                }
            }
            Some(_) => {}
        }
    }
    let unit_regions: Vec<&str> = (0..book.units.len()).filter_map(|u| book.members(u).first().map(|&t| book.region(t))).collect();
    let count = |name: &str| unit_regions.iter().filter(|region| **region == name).count() as u64;
    let matter_words: u64 = record["verdict"]["unplaced"].as_object().into_iter().flatten().flat_map(|(_, runs)| runs.as_object().into_iter().flatten())
        .filter(|(why, _)| matches!(why.as_str(), "on_furniture" | "on_running_head" | "on_page_label" | "on_margin_letter")).map(|(_, n)| n.as_u64().unwrap_or(0)).sum();
    json!({"lettered_lines": lettered, "untyped_lines": untyped, "untyped_aligned": untyped_aligned, "running_heads_as_text": matter_as_text, "typed_unplaced": typed_unplaced,
           "decision_words_as_matter": matter_words, "heading_units": count("heading"), "a2aj_headings": held.headings,
           "note_units": count("note"), "a2aj_notes": held.notes, "note_calls": book.notes.len(), "class_examples": examples})
}

/// One gold against its page and its record.
fn measured(gold: &Value, record: &Value, spans: &HashMap<String, Vec<(usize, usize, usize)>>) -> Value {
    let lines = record["lines"].as_array().map_or(&[][..], Vec::as_slice);
    let parallel = layout_of(gold) == "parallel";
    let keyed = view(gold);
    let of_number = |number: usize| keyed.printings.get(&number.to_string());
    let typed: HashSet<&str> = keyed.regions.keys().map(String::as_str).collect();
    let by_id: HashMap<&str, &Value> = lines.iter().map(|line| (line["id"].as_str().unwrap_or(""), line)).collect();
    let language_of = |id: &str| by_id.get(id).and_then(|line| line["lang"].as_str());
    // A2AJ's paragraph for each line: the one most of its placed words stand in.
    let (mut expected, mut ok, mut lost_typed, mut lost_untyped, mut moved, mut swapped, mut beyond, mut differs) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    // Each printed marker's line and its number's digits.
    let marked_numbers: Vec<(String, String)> = keyed.marks.iter().map(|(line, said)| (line.clone(), said.chars().filter(char::is_ascii_digit).collect())).collect();
    let marked: HashSet<(&str, &str)> = marked_numbers.iter().map(|(line, number)| (line.as_str(), number.as_str())).collect();
    // How far the print's numbered printings are off A2AJ's count, and the lines in printings the page shows no number of.
    let (mut shifted, mut unsure): (HashMap<i64, u64>, Vec<(&str, usize, &BTreeSet<String>, Vec<i64>)>) = (HashMap::new(), Vec::new());
    let mut lost: Vec<Value> = Vec::new();
    let mut other: Vec<Value> = Vec::new();
    // Each printing's language, by most of its lines.
    let mut own_language: HashMap<(String, usize), String> = HashMap::new();
    let (mut key_lines, mut wrong_language) = (0u64, 0u64);
    let mut wrong: Vec<Value> = Vec::new();
    for (number, printings) in &keyed.printings {
        for (at, printing) in printings.iter().enumerate() {
            let mut counts: BTreeMap<&str, u64> = BTreeMap::new();
            for id in printing {
                if let Some(language) = language_of(id) {
                    *counts.entry(language).or_default() += 1;
                }
            }
            let major = counts.iter().max_by_key(|(_, n)| **n).map_or("", |(language, _)| *language);
            own_language.insert((number.clone(), at), major.to_owned());
            key_lines += counts.values().sum::<u64>();
            for id in printing {
                if language_of(id).is_some_and(|language| language != major) {
                    wrong_language += 1;
                    if wrong.len() < 30 {
                        wrong.push(json!({"number": number, "line": id}));
                    }
                }
            }
        }
    }
    if !keyed.count.is_null() {
        for line in lines {
            let Some(language) = line["lang"].as_str() else { continue };
            let Some(numbered) = spans.get(language) else { continue };
            let mut seen: BTreeMap<usize, u64> = BTreeMap::new();
            let words = line["words"].as_array().map_or(&[][..], Vec::as_slice);
            for word in words {
                let at = word[2].as_u64().unwrap_or(0) as usize;
                let k = numbered.partition_point(|span| span.0 <= at);
                if k > 0 && at < numbered[k - 1].1 {
                    *seen.entry(numbered[k - 1].2).or_default() += 1;
                }
            }
            let Some((&number, &held)) = seen.iter().max_by_key(|(_, n)| **n) else { continue };
            if (held as usize) * 2 < words.len() || of_number(number).is_none() && keyed.printings.len() * 2 < spans.values().map(Vec::len).max().unwrap_or(0) {
                continue;
            }
            let id = line["id"].as_str().unwrap_or("");
            // (A line the key gives only numbers A2AJ's text numbers nowhere: its text stops numbering, its last paragraph
            // running on to the end, and says nothing of the print's count past it.)
            if keyed.numbers.get(id).is_some_and(|given| given.iter().all(|k| k.parse::<usize>().is_ok_and(|k| !numbered.iter().any(|span| span.2 == k)))) {
                beyond += 1;
                continue;
            }
            expected += 1;
            let Some(given) = keyed.numbers.get(id) else {
                if typed.contains(id) { lost_typed += 1 } else { lost_untyped += 1 }
                if lost.len() < 30 {
                    lost.push(json!({"line": id, "number": number, "typed": typed.contains(id)}));
                }
                continue;
            };
            if given.contains(&number.to_string()) {
                ok += 1;
                continue;
            }
            let crossed = given.iter().any(|name| keyed.printings[name].iter().enumerate().any(|(at, printing)| printing.contains(id) && own_language.get(&(name.clone(), at)).is_some_and(|major| major != language)));
            // (A printing the page opens with its own number, the key's, is the print's paragraph: there A2AJ's count is
            // what differs, its paragraphs cut or numbered otherwise than the report's.)
            let printed_here = given.iter().all(|name| keyed.printings[name].iter().any(|printing| printing.contains(id) && printing.iter().any(|line| marked.contains(&(line.as_str(), name.as_str())))));
            let offsets: Vec<i64> = given.iter().filter_map(|name| name.parse::<i64>().ok()).map(|k| k - number as i64).collect();
            if crossed {
                swapped += 1
            } else if printed_here {
                differs += 1;
                for offset in offsets { *shifted.entry(offset).or_default() += 1 }
            } else {
                unsure.push((id, number, given, offsets));
            }
        }
    }
    // (A line in a printing the page shows no number of, off A2AJ's count by what twenty lines or more of the print's own
    // numbered printings are off it in the document, follows the print as they do.)
    for (id, number, given, offsets) in unsure {
        if offsets.iter().any(|offset| shifted.get(offset).is_some_and(|&n| n >= 20)) {
            differs += 1;
            continue;
        }
        moved += 1;
        if other.len() < 30 {
            other.push(json!({"line": id, "number": number, "key": given, "crossed": false}));
        }
    }
    // The page's own numbers against the key's.
    let chains = printed_numbers(lines, parallel);
    let keyed_numbers: BTreeSet<u32> = keyed.printings.keys().filter_map(|number| number.parse().ok()).collect();
    let (mut printed, mut missing, mut misplaced): (u64, Vec<u32>, Vec<u32>) = (0, Vec::new(), Vec::new());
    for chain in chains.values() {
        for candidate in chain {
            printed += 1;
            let id = lines[candidate.line]["id"].as_str().unwrap_or("");
            if !keyed_numbers.contains(&candidate.number) {
                missing.push(candidate.number);
            } else if !keyed.numbers.get(id).is_some_and(|numbers| numbers.contains(&candidate.number.to_string())) {
                misplaced.push(candidate.number);
            }
        }
    }
    let page_numbers: BTreeSet<u32> = chains.values().flatten().map(|candidate| candidate.number).collect();
    let unprinted = keyed_numbers.difference(&page_numbers).count();
    // A count that the page's order breaks.
    let rank: HashMap<&str, usize> = lines.iter().enumerate().map(|(k, line)| (line["id"].as_str().unwrap_or(""), k)).collect();
    let mut inversions = 0;
    let starts: BTreeMap<u32, Vec<(Option<&str>, usize)>> = keyed.printings.iter().filter_map(|(number, printings)| {
        let number: u32 = number.parse().ok()?;
        Some((number, printings.iter().filter_map(|printing| printing.iter().filter_map(|id| rank.get(id.as_str()).map(|at| (language_of(id), *at))).min_by_key(|entry| entry.1)).collect()))
    }).collect();
    for (number, opening) in &starts {
        if let Some(next) = starts.get(&(number + 1)) {
            inversions += opening.iter().filter(|(language, at)| next.iter().any(|(other, there)| other == language && there < at)).count();
        }
    }
    let words_in = lines.iter().filter(|line| line["text"].as_str().unwrap_or("").chars().any(char::is_alphabetic) && line["why"].as_str().is_none_or(|why| !matches!(why, "furniture" | "page_label" | "running_head" | "margin_letter"))).count();
    let spoken = lines.iter().filter(|line| keyed.speaks_for.contains(line["id"].as_str().unwrap_or(""))).count();
    json!({"citation": record["pair"]["citation"], "mode": mode_of(gold), "layout": layout_of(gold), "pages": record["pair"]["pages"], "count": keyed.count, "numbers": keyed_numbers.len(),
           "expected": expected, "beyond_a2aj_count": beyond, "a2aj_count_differs": differs, "ok": ok, "lost_typed": lost_typed, "lost_untyped": lost_untyped, "moved": moved, "swapped": swapped, "lost": lost, "other": other,
           "key_lines": key_lines, "wrong_language": wrong_language, "wrong": wrong, "printed": printed, "printed_chain": !chains.is_empty(), "missing": missing, "misplaced": misplaced,
           "key_unprinted": unprinted, "inversions": inversions, "body_lines": words_in, "spoken_lines": spoken, "unmatched": record["verdict"]["unmatched"], "coverage": record["verdict"]["coverage"]})
}

/// Each gold of a folder (the store's aligned golds where none is named), with its record in WORK/records, measured ->
/// OUT/quality.jsonl and OUT/quality-summary.txt, by mode and layout.
pub fn quality(work: &Path, out: &Path, golds: Option<PathBuf>) -> Result<(), String> {
    fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let folder = golds.unwrap_or_else(store::store_root);
    let shas: Vec<String> = named(&folder).into_iter().filter(|sha| work.join("records").join(format!("{sha}.json.gz")).is_file()).collect();
    let mut chosen: Vec<(String, PathBuf, Value)> = Vec::new();
    let mut keys = BTreeSet::new();
    for sha in shas {
        let Some(path) = held(&folder, &sha) else { continue };
        let Ok(receipt) = store::read_json(&path.with_file_name("receipt.json")) else { continue };
        let authoring = receipt["authoring"].clone();
        if receipt["label_source"] != store::LABEL_SOURCE {
            continue;
        }
        for language in authoring["languages"].as_array().into_iter().flatten() {
            keys.insert(format!("{}:{}", authoring["a2aj_document_id"], language.as_str().unwrap_or("")));
        }
        chosen.push((sha, path, authoring));
    }
    let found = Listings::of(&keys)?;
    let one = |(sha, path, authoring): &(String, PathBuf, Value), db: &rusqlite::Connection| -> Result<Value, String> {
        let record_path = work.join("records").join(format!("{sha}.json.gz"));
        let (gold_file, record_file) = (fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?, fs::read(&record_path).map_err(|e| format!("{}: {e}", record_path.display()))?);
        row_kept(work, sha, &gold_file, &record_file, None, authoring, &found, db)
    };
    let measured_rows = on_cores(&chosen, one)?;
    write_rows(out, measured_rows)
}

/// A gold's row: made once for its gold's and record's bytes and A2AJ's listings by this measure's code, kept in
/// WORK/quality-made, and read back after. The gold step makes it as it writes the gold, from the record it has read
/// (`record`, the record file's bytes decoded), so no step decodes a record twice.
#[allow(clippy::too_many_arguments)]
pub fn row_kept(work: &Path, sha: &str, gold_file: &[u8], record_file: &[u8], record: Option<&Value>, authoring: &Value, found: &Listings, db: &rusqlite::Connection) -> Result<Value, String> {
    {
        let (path, record_path) = (Path::new(sha), Path::new(sha));
        let mut listed = String::new();
        for language in authoring["languages"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            listed.push_str(&found.read(&format!("{}:{language}", authoring["a2aj_document_id"]))?.unwrap_or_default());
            listed.push('\u{1}');
        }
        let key = {
            use sha2::{Digest, Sha256};
            let mut hash = Sha256::new();
            for part in [MEASURE_CODE.as_bytes(), gold_file, record_file, listed.as_bytes()] {
                hash.update((part.len() as u64).to_le_bytes());
                hash.update(part);
            }
            store::hex(&hash.finalize())
        };
        let made_path = work.join("quality-made").join(format!("{sha}.json"));
        if let Ok(made) = store::read_json(&made_path) {
            if made["key"] == key.as_str() {
                return Ok(made["row"].clone());
            }
        }
        let parse = |file: &[u8], at: &Path| -> Result<Value, String> { serde_json::from_slice(&store::gunzip(file)?).map_err(|e| format!("{}: {e}", at.display())) };
        let gold = parse(gold_file, path)?;
        let parsed;
        let record = match record {
            Some(record) => record,
            None => { parsed = parse(record_file, record_path)?; &parsed }
        };
        let mut spans: HashMap<String, Vec<(usize, usize, usize)>> = HashMap::new();
        let mut held = Held::default();
        for language in authoring["languages"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let Some(listing) = found.read(&format!("{}:{language}", authoring["a2aj_document_id"]))? else { continue };
            let text = a2aj_text(db, rusqlite::types::Value::Integer(authoring["a2aj_document_id"].as_i64().unwrap_or(0)), language)?.unwrap_or_default();
            let chars: Vec<char> = text.chars().collect();
            let mut units = Vec::with_capacity(chars.len() + 1);
            for (at, c) in chars.iter().enumerate() {
                units.push(at);
                if *c as u32 > 0xFFFF {
                    units.push(at);
                }
            }
            units.push(chars.len());
            let cp = |unit: usize| units[unit.min(units.len() - 1)];
            let (read, notes) = nodes(&listing)?;
            held.headings += read.iter().filter(|node| node.kind == "heading").count() as u64;
            held.notes += notes.len() as u64;
            let mut numbered: Vec<(usize, usize, usize)> = read.iter().filter(|node| node.kind == "paragraph" && node.label.starts_with("par"))
                .filter_map(|node| Some((cp(node.start), cp(node.end), node.label.get(3..)?.parse().ok()?))).collect();
            numbered.sort_unstable();
            spans.insert(language.to_owned(), numbered);
        }
        let mut row = measured(&gold, record, &spans);
        for (name, value) in classes(&gold, record, &held).as_object().into_iter().flatten() {
            row[name] = value.clone();
        }
        row["sha"] = json!(sha);
        // (As made, its fields in their order: the row is written out again as it stands.)
        store::write_atomic(&made_path, &serde_json::to_vec(&json!({"key": key, "row": row})).map_err(|e| e.to_string())?)?;
        Ok(row)
    }
}

fn write_rows(out: &Path, measured_rows: Vec<Value>) -> Result<(), String> {
    let mut rows = fs::File::create(out.join("quality.jsonl")).map_err(|e| e.to_string())?;
    let mut tally = Tally::new();
    for row in measured_rows {
        writeln!(rows, "{row}").map_err(|e| e.to_string())?;
        let group = format!("{} {}", row["mode"].as_str().unwrap_or("?"), row["layout"].as_str().unwrap_or("?"));
        add(&mut tally, &group, "documents", 1);
        add(&mut tally, &group, "numbered", (!row["count"].is_null()) as u64);
        add(&mut tally, &group, "numbers printed on the page, no key", (row["count"].is_null() && row["printed_chain"] == true) as u64);
        for name in ["expected", "beyond_a2aj_count", "a2aj_count_differs", "ok", "lost_typed", "lost_untyped", "moved", "swapped", "key_lines", "wrong_language", "printed", "key_unprinted", "inversions", "body_lines", "spoken_lines",
                     "lettered_lines", "untyped_lines", "untyped_aligned", "running_heads_as_text", "typed_unplaced", "decision_words_as_matter", "heading_units", "a2aj_headings", "note_units", "a2aj_notes", "note_calls"] {
            add(&mut tally, &group, name, row[name].as_u64().unwrap_or(0));
        }
        let count = |name: &str| row[name].as_array().map_or(0, Vec::len) as u64;
        add(&mut tally, &group, "missing", count("missing"));
        add(&mut tally, &group, "misplaced", count("misplaced"));
        let at = |name: &str| row[name].as_u64().unwrap_or(0);
        let clean = at("expected") == at("ok") && at("wrong_language") == 0 && count("missing") == 0 && count("misplaced") == 0 && at("inversions") == 0;
        add(&mut tally, &group, "documents clean", clean as u64);
        add(&mut tally, &group, "documents with fewer note units than A2AJ's notes", (at("note_units") < at("a2aj_notes")) as u64);
        add(&mut tally, &group, "documents with fewer heading units than half A2AJ's headings", (at("heading_units") * 2 < at("a2aj_headings")) as u64);
        add(&mut tally, &group, "documents with a running head typed as text", (at("running_heads_as_text") > 0) as u64);
    }
    summary(out, "quality-summary.txt", &tally)
}
