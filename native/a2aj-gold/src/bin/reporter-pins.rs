//! reporter-pins: a reporter-pages sheet (any report's printed pages over A2AJ's texts) checked against the judgments
//! that cite those reports. Each A2AJ decision's full citations of a report the sheet covers, with a page pinpoint and a
//! quotation, are read by the citation engine: a citation in a note with the note's proposition (the note pairing's),
//! one in the reasons with the quotation that ends just before it or opens just after it. Each quotation is located in
//! the cited judgment's text by the product's quote location, the sheet's pages its page blocks and the pinpoint its
//! scope; the page it is found on is set against the page the citing judge pins.
//!
//!   reporter-pins SHEET OUT [--store a2aj.sqlite] [--threads N] [--limit N]
//!
//! SHEET is JSON lines {a2aj, citation, languages: {en|fr: [[page, start, end], ...]}}, offsets in characters. OUT gets a
//! line per pinned quotation; the counts are printed.
use legal_citations::{Authority, Citation, Form, Options, PinpointKind};
use legal_structure::{caselaw_citation_lookup_key, pair_numbered_footnotes};
use legal_structure_features::citator_graph::default_store;
use legal_structure_features::{locate_source_quotes, marked_quote_spans, QuoteBlockInput, QuoteSource, QuoteToLocate};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};

/// A quotation this close (bytes) to its citation, before or after it, is the one the citation is for.
const NEAR: usize = 300;
/// Fewer words than this locate nothing for sure.
const FEWEST_WORDS: usize = 6;

struct Cited {
    citation: String,
    /// by language: the text and its page blocks
    texts: Vec<(String, String, Vec<QuoteBlockInput>)>,
}

fn utf16_offsets(text: &str) -> Vec<usize> {
    let mut out = Vec::with_capacity(text.chars().count() + 1);
    let mut units = 0;
    for character in text.chars() {
        out.push(units);
        units += character.len_utf16();
    }
    out.push(units);
    out
}

fn page_pins(citation: &Citation) -> Vec<u32> {
    citation.pinpoints.iter().filter(|pin| pin.kind == PinpointKind::Page).filter_map(|pin| pin.first.trim().parse().ok()).collect()
}

struct Found {
    citing: i64,
    language: &'static str,
    cited_key: String,
    pin: u32,
    quote: String,
    how: &'static str,
}

/// The pinned quotations of one citing decision's text.
fn pinned_quotes(id: i64, language: &'static str, text: &str, cited: &HashMap<String, Cited>) -> Vec<Found> {
    let mut out = Vec::new();
    let words = |quote: &str| quote.split_whitespace().count();
    // the reasons: each full citation with a page pin and the quotation nearest it
    let quotes = marked_quote_spans(text);
    let citations = legal_citations::extract(text, &Options { resolve: false, ..Options::default() });
    for citation in &citations {
        if citation.form != Form::Full || citation.authority != Authority::Case {
            continue;
        }
        let Some(key) = citation.key.as_ref().filter(|key| cited.contains_key(*key)) else { continue };
        let Some(&pin) = page_pins(citation).first() else { continue };
        let before = quotes.iter().filter(|q| q.end <= citation.span.start && citation.span.start - q.end <= NEAR).last();
        let after = quotes.iter().find(|q| q.start >= citation.span.end && q.start - citation.span.end <= NEAR);
        // no other citation between the quotation and this one
        let clear = |from: usize, to: usize| !citations.iter().any(|other| !std::ptr::eq(other, citation) && other.span.start >= from && other.span.end <= to);
        let chosen = before.filter(|q| clear(q.end, citation.span.start)).map(|q| (q, "before"))
            .or_else(|| after.filter(|q| clear(citation.span.end, q.start)).map(|q| (q, "after")));
        if let Some((quote, how)) = chosen {
            if words(&quote.text) >= FEWEST_WORDS {
                out.push(Found { citing: id, language, cited_key: key.clone(), pin, quote: quote.text.clone(), how });
            }
        }
    }
    // the notes: each note's citations with a page pin, and its proposition's quotations
    let pairing = pair_numbered_footnotes(text, &[text.to_owned()]);
    let mut notes = String::new();
    let ranges: Vec<legal_citations::NoteRange> = pairing.notes.iter().map(|note| {
        if !notes.is_empty() { notes.push_str("\n\n"); }
        let start = notes.len();
        notes.push_str(&note.body);
        legal_citations::NoteRange { number: note.label.trim().parse().unwrap_or(0), start, end: notes.len(), sequence: note.restart_sequence as u32, anchor: None }
    }).collect();
    if ranges.is_empty() {
        return out;
    }
    let in_notes = legal_citations::extract(&notes, &Options { notes: Some(ranges.clone()), split_tier: Some(legal_citations::SplitTier::Safe), ..Options::default() });
    for citation in &in_notes {
        let full = &in_notes[citation.authority_index()];
        if full.form != Form::Full || full.authority != Authority::Case {
            continue;
        }
        let Some(key) = full.key.as_ref().filter(|key| cited.contains_key(*key)) else { continue };
        let Some(&pin) = page_pins(citation).first() else { continue };
        let Some(note) = ranges.iter().position(|r| r.start <= citation.span.start && citation.span.start < r.end) else { continue };
        let Some(proposition) = pairing.notes[note].proposition.as_deref() else { continue };
        for quote in marked_quote_spans(proposition) {
            if words(&quote.text) >= FEWEST_WORDS {
                out.push(Found { citing: id, language, cited_key: key.clone(), pin, quote: quote.text.clone(), how: "note" });
            }
        }
    }
    out
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let value = |name: &str| arguments.iter().position(|argument| argument == name).and_then(|at| arguments.get(at + 1)).cloned();
    let (Some(sheet), Some(out)) = (arguments.first(), arguments.get(1)) else {
        eprintln!("reporter-pins SHEET OUT [--store a2aj.sqlite] [--threads N] [--limit N]");
        std::process::exit(2);
    };
    let store = value("--store").map(PathBuf::from).unwrap_or_else(default_store);
    let threads: usize = value("--threads").and_then(|n| n.parse().ok()).unwrap_or(6);
    let limit: Option<usize> = value("--limit").and_then(|n| n.parse().ok());
    let db = Connection::open_with_flags(&store, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).expect("the A2AJ store");

    // the sheet's judgments, by the citation engine's key of their citation
    let mut cited: HashMap<String, Cited> = HashMap::new();
    for line in BufReader::new(std::fs::File::open(sheet).expect("the sheet")).lines() {
        let row: Value = serde_json::from_str(&line.expect("a sheet line")).expect("a sheet row");
        let citation = row["citation"].as_str().unwrap_or("").to_owned();
        let Ok(key) = caselaw_citation_lookup_key(&citation) else { continue };
        if key.is_empty() { continue; }
        let id = row["a2aj"].as_i64().unwrap_or(0);
        let mut texts = Vec::new();
        for (language, stretches) in row["languages"].as_object().into_iter().flatten() {
            let column = if language == "fr" { "unofficial_text_fr" } else { "unofficial_text_en" };
            let text: Option<String> = db.query_row(&format!("select {column} from document where id = ?"), [id], |r| r.get(0)).ok().flatten();
            let Some(text) = text else { continue };
            let units = utf16_offsets(&text);
            let blocks: Vec<QuoteBlockInput> = stretches.as_array().into_iter().flatten().filter_map(|s| {
                let (page, start, end) = (s[0].as_i64()?, s[1].as_u64()? as usize, s[2].as_u64()? as usize);
                serde_json::from_value(json!({"node_id": null, "ranges": [], "kind": "page", "label": format!("page {page}"),
                    "start": units[start.min(units.len() - 1)], "end": units[end.min(units.len() - 1)]})).ok()
            }).collect();
            texts.push((language.clone(), text, blocks));
        }
        cited.insert(key, Cited { citation, texts });
    }
    eprintln!("{} judgments in the sheet", cited.len());
    let cited = Arc::new(cited);

    // the citing decisions: every A2AJ case whose text pins a page at all ("at p. 245", "at pp. 12-13", "à la p. 245")
    let pins_a_page = Regex::new(r"(?i)\b(?:at|à\s+la|aux)\s+pp?\.\s*\d").unwrap();
    let (jobs, queue) = mpsc::sync_channel::<(i64, &'static str, String)>(threads * 4);
    let queue = Arc::new(Mutex::new(queue));
    let (done, results) = mpsc::channel::<Vec<Found>>();
    let mut workers = Vec::new();
    for _ in 0..threads {
        let (queue, done, cited) = (Arc::clone(&queue), done.clone(), Arc::clone(&cited));
        workers.push(std::thread::Builder::new().stack_size(64 << 20).spawn(move || loop {
            let Ok((id, language, text)) = queue.lock().unwrap().recv() else { break };
            let found = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pinned_quotes(id, language, &text, &cited))).unwrap_or_default();
            if done.send(found).is_err() { break; }
        }).unwrap());
    }
    drop(done);
    let reader = std::thread::spawn(move || {
        let db = Connection::open_with_flags(&store, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).expect("the A2AJ store");
        let mut statement = db.prepare("select id, unofficial_text_en, unofficial_text_fr from document where doc_type = 'cases'").unwrap();
        let mut rows = statement.query([]).unwrap();
        let mut sent = 0;
        while let Ok(Some(row)) = rows.next() {
            let id: i64 = row.get(0).unwrap_or(0);
            for (language, column) in [("en", 1), ("fr", 2)] {
                let text: Option<String> = row.get(column).ok().flatten();
                if let Some(text) = text.filter(|text| pins_a_page.is_match(text)) {
                    if jobs.send((id, language, text)).is_err() { return; }
                    sent += 1;
                }
            }
            if limit.is_some_and(|limit| sent >= limit) { break; }
        }
    });

    // each pinned quotation located in the cited judgment, scoped to its pinned page
    let mut output = std::fs::File::create(out).expect("OUT");
    let mut tally: BTreeMap<String, u64> = BTreeMap::new();
    let mut seen = 0u64;
    for found in results {
        for item in found {
            seen += 1;
            let target = &cited[&item.cited_key];
            let mut verdict = ("not found", Vec::new(), 0.0, false, String::new());
            for (language, text, blocks) in &target.texts {
                let quote: QuoteToLocate = serde_json::from_value(json!({"quote": item.quote, "scopes": {"pages": [[item.pin, item.pin]]}})).unwrap();
                let Some(located) = locate_source_quotes(QuoteSource::Pdf, text, blocks, &[quote], false).into_iter().next() else { continue };
                if located.found.location == "unmatched" { continue; }
                let on = located.found.labels.iter().any(|label| label == &format!("page {}", item.pin));
                verdict = (if on { "on the pinned page" } else if located.found.labels.is_empty() { "found on no page of the sheet" } else { "on another page" },
                           located.found.labels.clone(), located.found.score, located.found.perfect, language.clone());
                if on { break; }
            }
            *tally.entry(format!("{} ({})", verdict.0, item.how)).or_default() += 1;
            writeln!(output, "{}", json!({"citing": item.citing, "citing_language": item.language, "cited": target.citation, "pin": item.pin,
                "how": item.how, "quote": item.quote, "verdict": verdict.0, "found_on": verdict.1, "score": verdict.2, "perfect": verdict.3,
                "cited_language": verdict.4})).unwrap();
        }
    }
    reader.join().ok();
    for worker in workers { worker.join().ok(); }
    println!("{seen} pinned quotations");
    for (kind, count) in tally { println!("  {count:>7}  {kind}"); }
}
