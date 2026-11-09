//! page-map-score: the page map scored against printed page numbers as their source holds them, from saved evidence; no
//! PDF is read.
//!
//!   page-map-score SOURCE EVIDENCE [--partition P | --partition !P] [--except EVIDENCE] [--starts] [--wrong FILE] [--explain ID]
//!
//! SOURCE: golds, journals or judgments (`page_truth::truths`). EVIDENCE: JSON lines {id, pages: [PageEvidence, ...]}
//! (`page-evidence` writes them). --partition keeps the golds of one partition (or, with "!", the others); --except leaves
//! out the documents another evidence file holds (a tuning sample). With --starts, each document's own first page (what
//! its citation gives a caller) is the page map's start. With --explain, document ID's candidates, parts and shifts are
//! printed. Only the pages the source numbers are scored: a page the PDF holds outside them (a cover sheet, front matter,
//! the next article's opening) has no number to get right, and a number put on one is counted apart. A page is right when
//! its number, or another numbering it prints, is one of its labels.
use legal_pdf_pages::{page_map, PageEvidence};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};

#[derive(Deserialize)]
struct Evidence {
    id: serde_json::Value,
    pages: Vec<PageEvidence>,
}

#[derive(Deserialize)]
struct Id {
    id: serde_json::Value,
}

fn lines<T: for<'a> Deserialize<'a>>(path: &str) -> impl Iterator<Item = T> {
    BufReader::new(std::fs::File::open(path).unwrap_or_else(|e| panic!("{path}: {e}"))).lines().map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
}

fn name(id: &serde_json::Value) -> String {
    id.as_str().map_or_else(|| id.to_string(), str::to_owned)
}

/// One page number however it is spelled: "001" is 1, "XIV" is "xiv", "E - 162" is "E-162".
fn same_label(label: &str, got: &str) -> bool {
    let compact = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    match (label.parse::<u64>(), got.parse::<u64>()) {
        (Ok(a), Ok(b)) => a == b,
        _ => compact(label) == compact(got),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(source), Some(evidence)) = (args.first(), args.get(1)) else {
        eprintln!("page-map-score SOURCE EVIDENCE [--partition P|!P] [--except EVIDENCE] [--starts] [--wrong FILE] [--explain ID]");
        std::process::exit(2);
    };
    let value = |flag: &str| args.iter().position(|arg| arg == flag).and_then(|at| args.get(at + 1));
    let with_starts = args.iter().any(|arg| arg == "--starts");
    let partition = value("--partition").cloned();
    let except: HashSet<String> = value("--except").map(|path| lines::<Id>(path).map(|row| name(&row.id)).collect()).unwrap_or_default();
    // --explain scores its documents alone ("a,b,c")
    let explained: Option<Vec<String>> = value("--explain").map(|ids| ids.split(',').map(|id| id.trim_matches('"').to_owned()).collect());
    let keep = |truth: &page_truth::Truth| explained.as_ref().is_none_or(|ids| ids.contains(&truth.id)) && match partition.as_deref() {
        Some(p) if p.starts_with('!') => truth.partition.as_deref() != Some(&p[1..]),
        Some(p) => truth.partition.as_deref() == Some(p),
        None => true,
    } && !except.contains(&truth.id);
    let begun = std::time::Instant::now();
    let truths: HashMap<String, page_truth::Truth> = page_truth::truths(source).into_iter().filter(keep).map(|truth| (truth.id.clone(), truth)).collect();
    eprintln!("{} {source} read in {:.1} s", truths.len(), begun.elapsed().as_secs_f64());
    let mut mapping = std::time::Duration::ZERO;
    let mut tally: BTreeMap<&str, u64> = BTreeMap::new();
    let mut parts: BTreeMap<(&str, &str), u64> = BTreeMap::new();
    let mut by_source: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let mut wrong = value("--wrong").map(|path| std::fs::File::create(path).expect("--wrong"));

    // the evidence's lines parsed on every core, the documents the source does not number left unparsed
    let raw: Vec<String> = BufReader::new(std::fs::File::open(evidence).unwrap_or_else(|e| panic!("{evidence}: {e}"))).lines().map_while(Result::ok).collect();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let chunk = raw.len().div_ceil(threads).max(1);
    let articles: Vec<Evidence> = std::thread::scope(|scope| {
        let workers: Vec<_> = raw.chunks(chunk).map(|part| scope.spawn(|| part.iter().filter_map(|line| {
            // the id leads each line ({"id":…,"pages":…}): read alone, the rest parsed only for a document kept
            let id = line.strip_prefix("{\"id\":").and_then(|rest| rest.split_once(',')).map(|(id, _)| id.trim_matches('"').to_owned())?;
            truths.contains_key(&id).then(|| serde_json::from_str::<Evidence>(line).ok()).flatten()
        }).collect::<Vec<_>>())).collect();
        workers.into_iter().flat_map(|worker| worker.join().unwrap()).collect()
    });
    drop(raw);
    eprintln!("{} documents' evidence parsed at {:.1} s", articles.len(), begun.elapsed().as_secs_f64());
    for article in articles {
        let id = name(&article.id);
        let Some(truth) = truths.get(&id) else { continue };
        let expected = &truth.map;
        if explained.is_some() {
            println!("== {id}: first page {:?}", truth.first_page);
            for (page, candidates) in legal_pdf_pages::candidates_of(&article.pages).into_iter().enumerate().take(6) {
                for candidate in candidates {
                    println!("page {:>4}: {candidate}", page + 1);
                }
            }
            println!("parts {:?}", legal_pdf_pages::parts_of(&article.pages));
            for (shift, anchors) in legal_pdf_pages::weighed(&article.pages).into_iter().take(6) {
                println!("shift {shift:+}: {} anchors on pdf pages {}", anchors.len(), anchors.iter().map(|a| a.0.to_string()).collect::<Vec<_>>().join(","));
                for (page, number, text) in anchors.iter().take(8) {
                    println!("    pdf {page:>4} -> {number:<6} {text}");
                }
            }
        }
        let starts: Vec<u32> = if with_starts { truth.first_page.into_iter().collect() } else { Vec::new() };
        let mapped = std::time::Instant::now();
        let map = page_map(&article.pages, &starts, &|_, _| false);
        mapping += mapped.elapsed();
        if explained.is_some() {
            let shown: Vec<String> = map.iter().map(|b| format!("{}:{}", b.pdf_page, b.label.as_deref().unwrap_or("-"))).collect();
            println!("map {}", shown.join(" "));
        }
        *tally.entry("articles").or_default() += 1;
        let mut all_right = true;
        let mut candidates_of: Option<Vec<Vec<String>>> = None;
        // a key whose numbers never come near the document's own first page (a map of some other copy's count)
        let numbers: Vec<u32> = expected.values().flatten().filter_map(|label| label.parse().ok()).collect();
        let contradicted = truth.first_page.is_some_and(|first| !numbers.is_empty()
            && (numbers.iter().max().unwrap() + 3 < first || *numbers.iter().min().unwrap() > first + 3));
        // single documents and composites (a book of authorities, a full issue, a compilation) are counted apart
        let composite = truth.composite.unwrap_or(article.pages.len() > expected.len() + 4);
        let part = if composite { "composite" } else { "single" };
        *parts.entry((part, "documents")).or_default() += 1;
        for (&page, printed) in &truth.detected {
            let Some(labels) = expected.get(&page) else { continue };
            *tally.entry("pages the working system numbered").or_default() += 1;
            let got = map.get(page as usize - 1).and_then(|b| b.label.as_deref());
            *tally.entry(match got {
                Some(got) if same_label(printed, got) => "  of those, numbered the same",
                Some(_) => "  of those, numbered otherwise",
                None => "  of those, not numbered",
            }).or_default() += 1;
            if labels.iter().any(|label| same_label(label, printed)) {
                *tally.entry("  of those, the working system right").or_default() += 1;
            }
        }
        for (&page, labels) in expected {
            *tally.entry("pages").or_default() += 1;
            let binding = map.get(page as usize - 1);
            let got = binding.and_then(|b| b.label.as_deref());
            let source = binding.and_then(|b| b.source.clone()).unwrap_or_else(|| "none".to_owned());
            // the page's number, or any other numbering it prints that the source names (a Bates number, an exhibit's page)
            let numbers: Vec<&str> = binding.map(|b| b.numbers.iter().map(|n| n.label.as_str()).collect()).unwrap_or_default();
            let own = got.is_some_and(|got| labels.iter().any(|label| same_label(label, got)));
            let right = own || numbers.iter().any(|number| labels.iter().any(|label| same_label(label, number)));
            if right && !own {
                *tally.entry("right by another numbering the page prints").or_default() += 1;
            }
            *parts.entry((part, "pages")).or_default() += 1;
            *parts.entry((part, if right { "right" } else if got.is_some() { "wrong" } else { "no number" })).or_default() += 1;
            let entry = by_source.entry(source).or_default();
            entry.0 += 1;
            if right {
                entry.1 += 1;
                *tally.entry("right").or_default() += 1;
            } else {
                all_right = false;
                *tally.entry(if got.is_some() { "wrong number" } else { "no number" }).or_default() += 1;
                if contradicted {
                    *tally.entry("  of those misses, in a key that never comes near its own first page").or_default() += 1;
                }
                // what the page itself prints where a folio stands: the number given, or the key's
                let anchors: Vec<String> = candidates_of.get_or_insert_with(|| legal_pdf_pages::candidates_of(&article.pages))[page as usize - 1].iter()
                    .filter(|c| c.contains(" ANCHOR ")).filter_map(|c| c.split(' ').next().map(str::to_owned)).collect();
                let prints = |label: &str| anchors.iter().any(|a| same_label(label, a));
                // the key's neighbours run n+1 across this page, and the key's own number here breaks the run, while the
                // number given keeps it: the key misreads the page
                let key_number = |at: u32| expected.get(&at).and_then(|labels| labels.iter().find_map(|l| l.parse::<i64>().ok()));
                let run = match (key_number(page - 1), key_number(page + 1)) {
                    (Some(before), Some(after)) if after == before + 2 => Some(before + 1),
                    _ => None,
                };
                if run.is_some_and(|n| got.and_then(|g| g.parse::<i64>().ok()) == Some(n) && !labels.iter().any(|l| l.parse::<i64>().ok() == Some(n))) {
                    *tally.entry("  of those misses, the key breaking its own n+1 run where the number given keeps it").or_default() += 1;
                }
                // the page's lines that hold the key's number, with their height on the page
                let evidence = &article.pages[page as usize - 1];
                let holding: Vec<String> = evidence.lines.iter().filter(|line| labels.iter().any(|label| line.text.split(|c: char| !c.is_alphanumeric()).any(|word| same_label(label, word))))
                    .map(|line| format!("{:.2} {}", (line.rect[1] + line.rect[3]) / 2.0 / evidence.height.max(1.0), line.text)).collect();
                if holding.is_empty() {
                    *tally.entry("  of those misses, the key's number nowhere in the page's lines").or_default() += 1;
                }
                if got.is_some_and(prints) {
                    *tally.entry("  of those misses, the page printing the number given").or_default() += 1;
                } else if labels.iter().any(|label| prints(label)) {
                    *tally.entry("  of those misses, the page printing the key's number").or_default() += 1;
                }
                if let Some(file) = wrong.as_mut() {
                    let _ = writeln!(file, "{}", serde_json::json!({"id": article.id, "pdf_page": page, "labels": labels, "got": got, "anchors": anchors, "holding": holding,
                        "observed": binding.and_then(|b| b.observed.clone()), "source": binding.and_then(|b| b.source.clone()),
                        "working": truth.detected.get(&page), "pages": article.pages.len()}));
                }
            }
        }
        if all_right {
            *tally.entry("articles with every page right").or_default() += 1;
        }
        *tally.entry("pages outside the article given a number").or_default() +=
            map.iter().filter(|b| b.label.is_some() && !expected.contains_key(&b.pdf_page)).count() as u64;
    }
    eprintln!("scored in {:.1} s, {:.1} s of it the page map", begun.elapsed().as_secs_f64(), mapping.as_secs_f64());
    for (what, n) in &tally {
        println!("  {n:>8}  {what}");
    }
    let pages = tally.get("pages").copied().unwrap_or(0).max(1) as f64;
    println!("  page numbers right: {:.2}%", 100.0 * tally.get("right").copied().unwrap_or(0) as f64 / pages);
    for part in ["single", "composite"] {
        let at = |what: &str| parts.get(&(part, what)).copied().unwrap_or(0);
        if at("documents") > 0 {
            println!("  {part:<9} {:>6} documents {:>7} pages: {:.2}% right, {} wrong, {} no number", at("documents"), at("pages"),
                100.0 * at("right") as f64 / at("pages").max(1) as f64, at("wrong"), at("no number"));
        }
    }
    for (source, (n, right)) in &by_source {
        println!("    by source {source:<9} {n:>7} pages, {:.2}% right", 100.0 * *right as f64 / (*n).max(1) as f64);
    }
}
