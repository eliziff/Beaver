#![recursion_limit = "512"]
#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! CourtListener's opinion records through the structure parser (legal_structure::opinion::opinion_structure): their pages,
//! paragraphs, notes, headings and headnotes. Records come as folders (fields.json and one file per rendition) or
//! packed, one JSON line each ({"id", "files": {name: text}}, experiments/courtlistener-census/pack_kept.py).
//!
//!   courtlistener-structure run --pack FILE --out DIR [--clusters FILE] [--citations FILE] [--receipts FILE] [--threads N] [--every K]    the structure's measures, OUT/rows.jsonl
//!   courtlistener-structure one FOLDER [--clusters FILE] [--citations FILE]                                             one record's structure as JSON
//!   courtlistener-structure grade --pack FILE[,FILE] --pins FILE --out DIR [--clusters FILE] [--citations FILE] [--threads N]    judges' pins as the answer key (grade.rs)
//!
//! --receipts takes the census reads ({"id", "new_items": [{what, quote, nearest_family}]}): every finding the structure does not
//! hold goes to OUT/misses.jsonl.
//!
//! Clusters come one JSON line each ({"id", "fields": {field: text}}, experiments/courtlistener-census/pack_clusters.py),
//! citations likewise ({"id", "citations": [[volume, reporter, page, type]]}, pack_citations.py).
//! A row carries each list's size and the lines worth reading (page labels, heading texts) but no text. A run also writes
//! OUT/failures.jsonl, each failure by class and record, and OUT/summary.json, each class's count and the timings. Built with
//! --no-default-features: no PDF stack is needed here.

#[cfg(not(target_arch = "wasm32"))]
#[path = "courtlistener_grade/grade.rs"]
mod grade;

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    tool::main();
}

#[cfg(not(target_arch = "wasm32"))]
mod tool {
    use legal_structure::opinion::{front_lines, headnotes, marks_in_notes, parse_failures, parse_screens, nodes, opinion_structure, quote_miss, reading, receipt_miss, source_faults_left, spans, unheld_text, OpinionCitation, OpinionRecord};
    use legal_structure::{DocumentStructure, NodeKind, StructureNode};
    use serde_json::{json, Value};
    use std::collections::{BTreeMap, HashMap, HashSet};
    use std::fs::{self, File, OpenOptions};
    use std::io::{BufRead, BufReader, Write};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::path::Path;
    use std::sync::mpsc::sync_channel;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    pub(crate) const WORKER_STACK: usize = 64 << 20;

    pub(crate) type Clusters = HashMap<String, Vec<(String, String)>>;

    pub(crate) fn clusters_of(args: &[String]) -> Clusters {
        // Comma-separated files, each adding its fields to the case: the cluster's, the docket's.
        let mut clusters = Clusters::new();
        for file in flag(args, "--clusters").iter().flat_map(|files| files.split(',')) {
            for row in BufReader::new(File::open(file).unwrap()).lines().map_while(Result::ok).filter_map(|line| serde_json::from_str::<Value>(&line).ok()) {
                let (Some(id), Some(fields)) = (row["id"].as_str(), row["fields"].as_object()) else { continue };
                clusters.entry(id.to_owned()).or_default().extend(fields.iter().filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned()))));
            }
        }
        clusters
    }

    pub(crate) type Citations = HashMap<String, Vec<OpinionCitation>>;
    /// Each record's findings: family, quote, what the reader said.
    type Receipts = HashMap<String, Vec<(String, String, String)>>;

    fn receipts_of(args: &[String]) -> Receipts {
        let Some(file) = flag(args, "--receipts") else { return Receipts::new() };
        BufReader::new(File::open(file).unwrap()).lines().map_while(Result::ok).filter_map(|line| {
            let row = serde_json::from_str::<Value>(&line).ok()?;
            let items = row["new_items"].as_array()?.iter().filter_map(|item| {
                Some((item["nearest_family"].as_str()?.to_owned(), item["quote"].as_str()?.to_owned(), item["what"].as_str()?.to_owned()))
            }).collect();
            Some((row["id"].as_str()?.to_owned(), items))
        }).collect()
    }

    /// Every Luna label's target, from a file of {label: target}; a label's "pt-pt-" repeats are the label.
    fn targets_of(args: &[String]) -> HashMap<String, &'static str> {
        let Some(file) = flag(args, "--targets") else { return HashMap::new() };
        let map: HashMap<String, String> = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
        map.into_iter().filter_map(|(label, target)| {
            let target = ["page", "note", "heading", "paragraph number", "headnote"].into_iter().find(|known| *known == target)?;
            Some((label, target))
        }).collect()
    }

    pub(crate) fn citations_of(args: &[String]) -> Citations {
        let Some(file) = flag(args, "--citations") else { return Citations::new() };
        BufReader::new(File::open(file).unwrap()).lines().map_while(Result::ok).filter_map(|line| {
            let row = serde_json::from_str::<Value>(&line).ok()?;
            let citations = row["citations"].as_array()?.iter().filter_map(|citation| {
                let field = |at: usize| citation.get(at).and_then(Value::as_str).map(str::to_owned);
                Some(OpinionCitation { volume: field(0)?, reporter: field(1)?, page: field(2)?, kind: field(3)? })
            }).collect();
            Some((row["id"].as_str()?.to_owned(), citations))
        }).collect()
    }

    pub(crate) fn record_of(id: String, files: Vec<(String, String)>, clusters: &Clusters, citations: &Citations) -> (OpinionRecord, Value) {
        let fields: Value = files.iter().find(|(name, _)| name == "fields.json")
            .and_then(|(_, text)| serde_json::from_str(text).ok()).unwrap_or(Value::Null);
        let field = |name: &str| fields.get(name).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned);
        let record = OpinionRecord {
            id, opinion_type: field("type"), author: field("author_str"), page_count: field("page_count").and_then(|count| count.parse().ok()),
            cluster: field("cluster_id").and_then(|cluster| clusters.get(&cluster)).cloned().unwrap_or_default(),
            citations: field("cluster_id").and_then(|cluster| citations.get(&cluster)).cloned().unwrap_or_default(),
            renditions: files.into_iter().filter(|(name, _)| name != "fields.json").collect(),
            witness: false,
        };
        (record, fields)
    }

    fn measures(structure: &DocumentStructure, milliseconds: u128, fields: &Value) -> Value {
        let opinion = reading(structure);
        let (faults, unheld) = (source_faults_left(structure), unheld_text(structure));
        let (pages, notes, headings, parts) = (|| nodes(structure, NodeKind::Page), || nodes(structure, NodeKind::Footnote), || nodes(structure, NodeKind::Heading), || nodes(structure, NodeKind::Section));
        let paragraphs = || legal_structure::opinion::paragraphs(structure);
        let mut series = BTreeMap::<&str, Vec<&str>>::new();
        let mut sources = BTreeMap::<&str, usize>::new();
        for page in pages() {
            if !page.properties.contains_key("in_note") { series.entry(&page.series).or_default().push(page.label.as_deref().unwrap_or("")); }
            *sources.entry(page.grammar.as_deref().unwrap_or("")).or_default() += 1;
        }
        let mut heading_sources = BTreeMap::<&str, usize>::new();
        for heading in headings() {
            *heading_sources.entry(heading.grammar.as_deref().unwrap_or("")).or_default() += 1;
        }
        let mut headnote_kinds = BTreeMap::<&str, usize>::new();
        for (kind, _, _) in headnotes(structure) {
            *headnote_kinds.entry(kind).or_default() += 1;
        }
        let blocks = || spans(structure, "block-counter");
        let title = |heading: &StructureNode| heading.display_value.clone().unwrap_or_default();
        let note_items = notes().map(|note| property(note, "items").map_or(0, |items| items.split('\n').count())).sum::<usize>();
        json!({
            "id": structure.document_id, "cell": fields.get("_cell"), "stratum": fields.get("_stratum"), "rate": fields.get("_rate"), "page_count": fields.get("page_count"), "rendition": opinion.rendition, "ms": milliseconds, "text": structure.text.len(),
            "pages": series, "page_sources": sources, "note_pages": pages().filter(|page| page.properties.contains_key("in_note")).count(),
            "paragraphs": paragraphs().count(), "numbered": paragraphs().filter(|paragraph| paragraph.label.is_some()).count(), "items": paragraphs().filter(|paragraph| property(paragraph, "item").is_some()).count() + note_items, "titled_items": headings().filter(|heading| title(heading).split_whitespace().next().is_some_and(|word| word.len() <= 6 && word.ends_with(['.', ')']))).count(), "quote_paragraphs": nodes(structure, NodeKind::Quote).count(), "named_items": paragraphs().filter(|paragraph| property(paragraph, "item").is_some_and(|item| item.len() > 6)).count(), "blocks": blocks().count(), "blocks_reckoned": blocks().filter(|block| property(block, "source") == Some("reckoned")).count(),
            "numbers": paragraphs().filter_map(|paragraph| paragraph.label.as_deref()).take(400).collect::<Vec<_>>(),
            "notes": notes().count(), "note_refs": notes().map(|note| note.calls.len()).sum::<usize>(),
            "note_labels": notes().map(|note| note.label.as_deref().unwrap_or("")).take(200).collect::<Vec<_>>(),
            "headings": headings().map(|heading| title(heading).chars().take(70).collect::<String>()).take(60).collect::<Vec<_>>(),
            "heading_sources": heading_sources, "headnotes": headnote_kinds, "headnote_marks": spans(structure, "headnote-mark").count(),
            "parts": parts().map(|part| (part.display_value.as_deref().unwrap_or(""), property(part, "author"))).collect::<Vec<_>>(),
            "headnotes_placed": spans(structure, "headnote").count(),
            "front": front_lines(structure).fold(BTreeMap::<&str, usize>::new(), |mut roles, (role, _)| { *roles.entry(role).or_default() += 1; roles }),
            "furniture": spans(structure, "furniture").count(),
            "page_series": opinion.page_series, "defined_terms": spans(structure, "defined-term").count(), "quotes": spans(structure, "quotation").count(),
            "instruments": spans(structure, "instrument").filter_map(|instrument| property(instrument, "kind")).collect::<Vec<_>>(),
            "record_gaps": opinion.record_gaps.iter().map(|gap| gap.kind.as_str()).collect::<Vec<_>>(),
            "outcomes": opinion.outcomes, "tables": nodes(structure, NodeKind::Table).count(), "unmatched_calls": spans(structure, "unmatched-call").count(), "document_kind": opinion.document_kind,
            "note_longest": notes().map(|note| note.ranges.iter().map(|range| range.end.saturating_sub(range.start)).sum::<usize>()).max().unwrap_or(0), "note_share": notes().flat_map(|note| note.ranges.iter()).map(|range| range.end.saturating_sub(range.start)).sum::<usize>(), "marks_in_notes": marks_in_notes(structure), "shifted_left": faults.0, "margins_left": faults.1, "other_opinion": opinion.other_opinion, "unheld": unheld.0, "unheld_at": unheld.1, "page_witness": opinion.page_witness, "note_witness": opinion.note_witness, "heading_witness": opinion.heading_witness, "paragraph_witness": opinion.paragraph_witness, "paragraphs_run_on": opinion.paragraphs_run_on, "paragraphs_split": opinion.paragraphs_split, "union_test": opinion.union_test, "union_samples": opinion.union_samples, "titles_not_held": opinion.titles_not_held,
        })
    }

    fn property<'a>(node: &'a StructureNode, name: &str) -> Option<&'a str> {
        node.properties.get(name).map(String::as_str)
    }

    pub(crate) fn flag(args: &[String], name: &str) -> Option<String> {
        args.iter().position(|arg| arg == name).and_then(|at| args.get(at + 1)).cloned()
    }

    fn run(args: &[String]) {
        let pack = flag(args, "--pack").expect("--pack FILE");
        let out = flag(args, "--out").expect("--out DIR");
        let threads = flag(args, "--threads").and_then(|value| value.parse().ok()).unwrap_or(4);
        let every = flag(args, "--every").and_then(|value| value.parse().ok()).unwrap_or(1usize);
        let witness = args.iter().any(|arg| arg == "--witness");
        fs::create_dir_all(&out).unwrap();
        let rows = Path::new(&out).join("rows.jsonl");
        let done = File::open(&rows).map(|file| BufReader::new(file).lines().map_while(Result::ok)
            .filter_map(|line| Some(serde_json::from_str::<Value>(&line).ok()?["id"].as_str()?.to_owned()))
            .collect::<HashSet<_>>()).unwrap_or_default();
        let clusters = Arc::new(clusters_of(args));
        let citations = Arc::new(citations_of(args));
        let receipts = Arc::new(receipts_of(args));
        let targets = Arc::new(targets_of(args));
        let (send, receive) = sync_channel::<String>(threads * 4);
        let receive = Arc::new(Mutex::new(receive));
        let sink = Arc::new(Mutex::new(OpenOptions::new().create(true).append(true).open(&rows).unwrap()));
        let failures = Arc::new(Mutex::new(File::create(Path::new(&out).join("failures.jsonl")).unwrap()));
        let tally = Arc::new(Mutex::new((BTreeMap::<String, u64>::new(), Vec::<u128>::new())));
        let misses = Arc::new(Mutex::new(File::create(Path::new(&out).join("misses.jsonl")).unwrap()));
        let started = Instant::now();
        let workers = (0..threads).map(|_| {
            let (receive, sink, clusters, citations) = (receive.clone(), sink.clone(), clusters.clone(), citations.clone());
            let (failures, tally, misses, receipts, targets) = (failures.clone(), tally.clone(), misses.clone(), receipts.clone(), targets.clone());
            std::thread::Builder::new().stack_size(WORKER_STACK).spawn(move || loop {
                let Ok(line) = receive.lock().unwrap().recv() else { break };
                let Ok(row) = serde_json::from_str::<Value>(&line) else { continue };
                let id = row["id"].as_str().unwrap_or_default().to_owned();
                let files = row["files"].as_object().into_iter().flatten()
                    .filter_map(|(name, text)| Some((name.clone(), text.as_str()?.to_owned()))).collect();
                let (mut record, fields) = record_of(id.clone(), files, &clusters, &citations);
                record.witness = witness;
                let began = Instant::now();
                let line = match catch_unwind(AssertUnwindSafe(|| opinion_structure(&record, None))) {
                    Ok(structure) => {
                        let milliseconds = began.elapsed().as_millis();
                        let mut found = parse_failures(&structure);
                        found.extend(parse_screens(&structure, &record));
                        {
                            let mut counted = tally.lock().unwrap();
                            counted.1.push(milliseconds);
                            for (class, _) in &found {
                                *counted.0.entry((*class).to_owned()).or_default() += 1;
                            }
                        }
                        {
                            let mut written = failures.lock().unwrap();
                            for (class, detail) in found {
                                writeln!(written, "{}", json!({ "class": class, "id": id, "detail": detail })).unwrap();
                            }
                        }
                        for (family, quote, what) in receipts.get(&id).into_iter().flatten() {
                            // "No footnote is present" is the reader saying what is not there.
                            if what.starts_with("No ") || what.starts_with("Absent") {
                                continue;
                            }
                            let label = family.trim_start_matches("pt-");
                            let wide = targets.get(label).copied();
                            if let Some(target) = wide {
                                *tally.lock().unwrap().0.entry(format!("luna tested: {target}")).or_default() += 1;
                            }
                            if let Some(target) = wide.map_or_else(|| receipt_miss(&structure, family, quote), |target| quote_miss(&structure, target, quote)) {
                                *tally.lock().unwrap().0.entry(format!("luna miss: {target}")).or_default() += 1;
                                writeln!(misses.lock().unwrap(), "{}", json!({ "target": target, "id": id, "rendition": reading(&structure).rendition, "family": family, "quote": quote, "what": what })).unwrap();
                            }
                        }
                        measures(&structure, milliseconds, &fields).to_string()
                    }
                    Err(_) => {
                        *tally.lock().unwrap().0.entry("panic".to_owned()).or_default() += 1;
                        json!({ "id": id, "panic": true }).to_string()
                    }
                };
                writeln!(sink.lock().unwrap(), "{line}").unwrap();
            }).unwrap()
        }).collect::<Vec<_>>();
        let mut read = 0;
        for line in BufReader::new(File::open(pack).unwrap()).lines().map_while(Result::ok).step_by(every) {
            read += 1;
            if read % 5000 == 0 {
                eprintln!("{read} {:.0}s", started.elapsed().as_secs_f64());
            }
            if !line.ends_with('}') || done.contains(line.get(8..line.len().min(32)).and_then(|head| head.split('"').next()).unwrap_or_default()) {
                continue;
            }
            send.send(line).unwrap();
        }
        drop(send);
        for worker in workers {
            worker.join().unwrap();
        }
        let (classes, mut times) = std::mem::take(&mut *tally.lock().unwrap());
        times.sort_unstable();
        let at = |share: f64| times.get((times.len() as f64 * share) as usize).copied().unwrap_or(0);
        let summary = json!({ "records": read, "seconds": started.elapsed().as_secs(), "cpu_seconds": times.iter().sum::<u128>() / 1000,
            "ms": { "p50": at(0.5), "p90": at(0.9), "p99": at(0.99), "max": times.last() }, "failures": classes });
        fs::write(Path::new(&out).join("summary.json"), serde_json::to_string_pretty(&summary).unwrap()).unwrap();
        eprintln!("done {read} {:.0}s", started.elapsed().as_secs_f64());
    }

    pub fn main() {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        match args.first().map(String::as_str) {
            Some("run") => {
                std::panic::set_hook(Box::new(|_| {}));
                run(&args[1..])
            }
            Some("grade") => crate::grade::grade(&args),
        Some("holdout") => crate::grade::holdout(&args),
        Some("pdfkey") => crate::grade::pdfkey(&args),
            Some("one") => {
                let folder = Path::new(&args[1]);
                let files = fs::read_dir(folder).unwrap().filter_map(|entry| {
                    let entry = entry.ok()?;
                    Some((entry.file_name().to_str()?.to_owned(), String::from_utf8_lossy(&fs::read(entry.path()).ok()?).into_owned()))
                }).collect();
                let id = folder.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_owned();
                let (record, _) = record_of(id, files, &clusters_of(&args), &citations_of(&args));
                println!("{}", serde_json::to_string_pretty(&opinion_structure(&record, None)).unwrap());
            }
            _ => eprintln!("courtlistener-structure run|one"),
        }
    }
}
