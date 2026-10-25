//! A document's outline from its units' regions and evidence alone, by the conventions the
//! structure gold nests by, each read within the document: headings on a ladder of the
//! document's own heading types; a lead-in (a unit ending in a colon) holding what it introduces;
//! lists nesting by numbering family; a quotation under the paragraph that introduces it; a
//! statute section opening "N (1)" holding its later subsections and history note; a parallel
//! text's languages apart. `structure-gold assemble` measures it against the gold over the
//! exported rows, from the gold's own regions and starts or a model's, and writes its parents
//! as labels for `grade --labels`.
use crate::rows::FEATURES;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::Path;

const TEXT: usize = 1;
const LIST: usize = 2;
const HEADING: usize = 3;
const QUOTE: usize = 4;
const CAPTION: usize = 8;
const UNRANKED: [usize; 6] = [0, 5, 7, 10, 11, 12];
const NAMES: [&str; 13] = [
    "none", "text", "list", "heading", "quote", "note", "table", "contents", "caption", "headnote", "margin", "furniture", "label",
];

fn column(name: &str) -> usize {
    FEATURES.iter().position(|f| *f == name).expect("feature")
}

/// One document's rows as `structure-gold rows` exports them.
pub struct Rows {
    pub sha256: String,
    pub ids: Vec<Value>,
    pub(crate) features: Vec<Vec<f64>>,
    pub(crate) text: Vec<String>,
    pub(crate) family: Vec<String>,
    pub gold: Vec<Option<Vec<i64>>>,
    pub tier0: Vec<Vec<i64>>,
    /// Each row's bookmark parent: the first row of the heading line its bookmark nests under, or -1.
    pub navigation: Vec<i64>,
}

impl Rows {
    pub fn read(line: &str) -> Result<Rows, String> {
        let row: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        let numbers = |v: &Value| v.as_array().map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect::<Vec<f64>>()).unwrap_or_default();
        let labels = |v: &Value| v.as_array().map(|a| a.iter().map(|x| x.as_i64().unwrap_or(0)).collect::<Vec<i64>>());
        Ok(Rows {
            sha256: row["sha256"].as_str().unwrap_or_default().to_owned(),
            ids: row["ids"].as_array().cloned().unwrap_or_default(),
            features: row["features"].as_array().into_iter().flatten().map(numbers).collect(),
            text: row["text"].as_array().into_iter().flatten().map(|t| t[0].as_str().unwrap_or_default().to_owned()).collect(),
            family: row["text"].as_array().into_iter().flatten().map(|t| t[3].as_str().unwrap_or_default().to_owned()).collect(),
            gold: row["gold"].as_array().into_iter().flatten().map(labels).collect(),
            tier0: row["tier0"].as_array().into_iter().flatten().map(|v| labels(v).unwrap_or_default()).collect(),
            navigation: row["navigation"].as_array().map(|a| a.iter().map(|x| x.as_i64().unwrap_or(-1)).collect()).unwrap_or_default(),
        })
    }

    pub(crate) fn f(&self, row: usize, name: &str) -> f64 {
        self.features[row][column(name)]
    }
}

/// French and English function words, for telling a parallel text's languages apart.
fn language(text: &str) -> i32 {
    let (mut french, mut english) = (0, 0);
    for word in text.split(|c: char| !c.is_alphabetic()).filter(|w| !w.is_empty()) {
        match word.to_lowercase().as_str() {
            "le" | "la" | "les" | "des" | "du" | "une" | "est" | "sont" | "aux" | "dans" | "pour" | "qui" | "sur" | "par" | "au" | "ou" | "et" | "de" => french += 1,
            "the" | "of" | "and" | "to" | "in" | "is" | "for" | "that" | "by" | "with" | "or" | "any" | "shall" | "under" | "be" | "on" | "a" => english += 1,
            _ => {}
        }
    }
    french += text.chars().filter(|c| "éèêàçùâîô".contains(*c)).count();
    (french as i32 - english as i32).signum()
}

/// "19.013 (1) In this section…": a section that opens with its first subsection.
fn opens_section(text: &str) -> bool {
    let mut words = text.split_whitespace();
    let number = words.next().is_some_and(|w| w.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())));
    number && words.next() == Some("(1)")
}

/// "(2) The Tribunal shall…": a later subsection.
fn subsection(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with('(') && t[1..].split(')').next().is_some_and(|inner| !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit() || c == '.'))
}

/// "2001, c. 28, s. 20." or "R.S., c. C-25, s. 1.": a statute section's history.
fn history(text: &str) -> bool {
    let t = text.trim_start();
    let year = t.chars().take(4).filter(char::is_ascii_digit).count() == 4;
    t.starts_with("R.S.") || t.starts_with("L.R.") || (year && (t[4..].starts_with(", c.") || t[4..].starts_with(", ch.")))
}

#[derive(Default)]
struct Stream {
    headings: Vec<(usize, usize)>,
    section: Option<usize>,
    lead: Option<usize>,
    lists: Vec<(usize, String, i64)>,
    last_text: Option<usize>,
    last_unit: Option<usize>,
}

/// Each unit start's parent row (-1 for none), given each row's region and start.
pub fn parents(doc: &Rows, region: &[usize], start: &[usize]) -> Vec<i64> {
    let n = region.len();
    let units: Vec<usize> = (0..n).filter(|&r| start[r] == 1 && region[r] != 0).collect();
    // Each unit's last row: the rows that continue it.
    let mut last_row: HashMap<usize, usize> = units.iter().map(|&u| (u, u)).collect();
    let mut open_by_region: HashMap<usize, usize> = HashMap::new();
    for r in 0..n {
        if region[r] == 0 {
            continue;
        }
        if start[r] == 1 {
            open_by_region.insert(region[r], r);
        } else if let Some(&u) = open_by_region.get(&region[r]) {
            last_row.insert(u, r);
        }
    }
    let languages: Vec<i32> = units.iter().map(|&u| language(&doc.text[u])).collect();
    let bilingual = {
        let (fr, en) = (languages.iter().filter(|&&l| l > 0).count(), languages.iter().filter(|&&l| l < 0).count());
        fr.min(en) * 5 > units.len()
    };
    // Heading levels: each heading type's place among the document's own, most prominent first.
    let mut family_order: HashMap<(String, i64), usize> = HashMap::new();
    let mut signature = |row: usize| {
        let numbered = doc.f(row, "marker") > 0.0;
        let depth = (doc.f(row, "prefix_depth") * 3.0).round() as i64;
        let order = if numbered {
            let next = family_order.len();
            *family_order.entry((doc.family[row].clone(), depth)).or_insert(next) as i64
        } else {
            99
        };
        (-((doc.f(row, "size") * 10.0).round() as i64), -i64::from(doc.f(row, "upper") > 0.6), -i64::from(doc.f(row, "bold") > 0.5),
         -i64::from(doc.f(row, "centre").abs() < 0.04), order, depth, (doc.f(row, "indent") * 20.0).round() as i64)
    };
    let signatures: HashMap<usize, _> = units.iter().filter(|&&u| region[u] == HEADING).map(|&u| (u, signature(u))).collect();
    let mut ladder: Vec<_> = signatures.values().cloned().collect();
    ladder.sort();
    ladder.dedup();
    let level: HashMap<usize, usize> = signatures.iter().map(|(&u, s)| (u, ladder.binary_search(s).unwrap())).collect();
    let mut streams: HashMap<i32, Stream> = HashMap::new();
    let mut parent = vec![-1i64; n];
    for (k, &u) in units.iter().enumerate() {
        let r = region[u];
        if UNRANKED.contains(&r) {
            continue;
        }
        let key = if bilingual { languages[k] } else { 0 };
        let next = units[k + 1..].iter().copied().find(|&v| !UNRANKED.contains(&region[v]) && (!bilingual || language(&doc.text[v]) == key));
        let s = streams.entry(key).or_default();
        let top = |s: &Stream| s.section.or(s.headings.last().map(|h| h.0));
        let chosen: Option<usize> = match r {
            HEADING => {
                let own = level[&u];
                // A statute subsection's marginal note falls under its section.
                if s.section.is_some() && next.is_some_and(|v| subsection(&doc.text[v])) {
                    s.lead = None;
                    s.lists.clear();
                    s.section
                } else {
                    s.section = None;
                    while s.headings.last().is_some_and(|h| h.1 >= own) {
                        s.headings.pop();
                    }
                    s.lead = None;
                    s.lists.clear();
                    let p = s.headings.last().map(|h| h.0);
                    s.headings.push((u, own));
                    p
                }
            }
            LIST => {
                let family = doc.family[u].clone();
                let depth = (doc.f(u, "prefix_depth") * 3.0).round() as i64;
                if let Some(at) = s.lists.iter().rposition(|(_, f, d)| *f == family && *d == depth && !family.is_empty()) {
                    // A sibling in its numbering: its parent, and the deeper items close.
                    let sibling = s.lists[at].0;
                    s.lists.truncate(at);
                    s.lists.push((u, family, depth));
                    (parent[sibling] >= 0).then(|| parent[sibling] as usize)
                } else if let Some(&(item, _, _)) = s.lists.last() {
                    s.lists.push((u, family, depth));
                    Some(item)
                } else {
                    s.lists.push((u, family, depth));
                    let leading = s.last_unit.filter(|&p| region[p] == TEXT && doc.f(last_row[&p], "ends_period") == 0.0);
                    s.lead.or(leading).or_else(|| top(s))
                }
            }
            QUOTE => s.last_text.filter(|&t| s.headings.last().is_none_or(|h| h.0 < t)).or_else(|| top(s)),
            CAPTION => None,
            _ => {
                s.lists.clear();
                if opens_section(&doc.text[u]) {
                    s.lead = None;
                    let p = s.headings.last().map(|h| h.0);
                    s.section = Some(u);
                    p
                } else if s.section.is_some() && history(&doc.text[u]) {
                    s.section
                } else if let Some(lead) = s.lead.filter(|&l| s.last_unit == Some(l) || doc.f(u, "indent") > doc.f(l, "indent") + 0.01) {
                    Some(lead)
                } else {
                    s.lead = None;
                    if s.section.is_some() && s.last_unit.is_some_and(|l| region[l] == HEADING) {
                        s.headings.last().map(|h| h.0).filter(|&h| s.last_unit == Some(h)).or(s.section)
                    } else {
                        top(s)
                    }
                }
            }
        };
        parent[u] = chosen.map_or(-1, |p| p as i64);
        if r == TEXT {
            s.last_text = Some(u);
            if doc.f(last_row[&u], "ends_colon") > 0.0 {
                s.lead = Some(u);
            }
        }
        s.last_unit = Some(u);
    }
    parent
}

/// `structure-gold assemble ROWS_DIR SPLIT [--labels FILE] [--out FILE]`: parents by convention
/// over the gold's own regions and starts (or a labels file's), measured against the gold's per
/// document, with the misses by kind; `--out` writes the labels with these parents.
pub fn run(rows_dir: &Path, split: &str, options: &[String]) -> Result<(), String> {
    let value = |name: &str| options.iter().position(|o| o == name).and_then(|n| options.get(n + 1)).cloned();
    let given: HashMap<String, Vec<Vec<i64>>> = match value("--labels") {
        Some(path) => std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?.lines().filter(|l| !l.trim().is_empty())
            .map(|l| -> Result<(String, Vec<Vec<i64>>), String> {
                let row: Value = serde_json::from_str(l).map_err(|e| e.to_string())?;
                let labels = row["labels"].as_array().into_iter().flatten()
                    .map(|v| v.as_array().into_iter().flatten().map(|x| x.as_i64().unwrap_or(0)).collect()).collect();
                Ok((row["sha256"].as_str().unwrap_or_default().to_owned(), labels))
            }).collect::<Result<_, _>>()?,
        None => HashMap::new(),
    };
    let file = std::fs::File::open(rows_dir.join(format!("rows-{split}.jsonl"))).map_err(|e| e.to_string())?;
    let mut out = value("--out").map(|p| std::fs::File::create(p).map(std::io::BufWriter::new)).transpose().map_err(|e| e.to_string())?;
    let (mut right, mut asked) = (0usize, 0usize);
    let mut per_doc: Vec<f64> = Vec::new();
    let mut misses: HashMap<(String, String, String), usize> = HashMap::new();
    for line in std::io::BufReader::new(file).lines() {
        let doc = Rows::read(&line.map_err(|e| e.to_string())?)?;
        let source: Vec<Vec<i64>> = match given.get(&doc.sha256) {
            Some(labels) => labels.clone(),
            None => doc.gold.iter().map(|g| g.clone().unwrap_or_else(|| vec![0, 0, 0, 0, 0, -1, -1])).collect(),
        };
        let region: Vec<usize> = source.iter().map(|l| l[0].max(0) as usize).collect();
        let start: Vec<usize> = source.iter().map(|l| if l[0] > 0 { l[1].max(0) as usize } else { 0 }).collect();
        let chosen = parents(&doc, &region, &start);
        let (mut doc_right, mut doc_asked) = (0usize, 0usize);
        for (u, g) in doc.gold.iter().enumerate() {
            let Some(g) = g else { continue };
            if g[1] != 1 || g[0] <= 0 || UNRANKED.contains(&(g[0] as usize)) || start[u] != 1 {
                continue;
            }
            doc_asked += 1;
            if chosen[u] == g[5] {
                doc_right += 1;
            } else {
                let name = |p: i64| if p < 0 { "root".to_owned() } else { NAMES[doc.gold[p as usize].as_ref().map_or(0, |g| g[0].max(0) as usize)].to_owned() };
                *misses.entry((NAMES[g[0] as usize].to_owned(), name(g[5]), name(chosen[u]))).or_default() += 1;
            }
        }
        right += doc_right;
        asked += doc_asked;
        if doc_asked >= 10 {
            per_doc.push(doc_right as f64 / doc_asked as f64);
        }
        if let Some(out) = out.as_mut() {
            let labels: Vec<Value> = source.iter().enumerate().map(|(r, l)| {
                let mut l = l.clone();
                l.resize(7, -1);
                l[5] = chosen[r];
                json!(l)
            }).collect();
            writeln!(out, "{}", json!({"sha256": doc.sha256, "ids": doc.ids, "labels": labels})).map_err(|e| e.to_string())?;
        }
    }
    per_doc.sort_by(f64::total_cmp);
    let q = |p: f64| per_doc.get(((per_doc.len().max(1) - 1) as f64 * p) as usize).copied().unwrap_or(0.0);
    println!("{split}: {} documents with 10+ units: quartiles {:.3} / median {:.3} / {:.3}; pooled {:.3} over {asked} units",
             per_doc.len(), q(0.25), q(0.5), q(0.75), right as f64 / asked.max(1) as f64);
    let mut misses: Vec<_> = misses.into_iter().collect();
    misses.sort_by(|a, b| b.1.cmp(&a.1));
    for ((unit, gold, mine), count) in misses.into_iter().take(12) {
        println!("{count:7} {:.3}  {unit:8} gold under {gold:8} assembled under {mine}", count as f64 / asked.max(1) as f64);
    }
    Ok(())
}
