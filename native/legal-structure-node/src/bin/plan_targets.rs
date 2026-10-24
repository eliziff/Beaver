#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! The text-fragment experiment's targets (experiments/text-fragment-fidelity/build-targets.mts writes the same rows):
//! every seed's links planned by the engine's own passage links over each document's stored structure (the
//! store_documents bin), on every core.
//!
//!   plan_targets SEEDS.jsonl REQUESTS.jsonl STORED_DIR OUT.jsonl [--threads N] [--only LABELS.txt]
//!
//! `--only` plans just the seeds a file names, one label per line (a gate id's `label~form` names its label).
//!
//! REQUESTS.jsonl names each stored structure (`{ key, input }`, as store_documents read it); a seed's document is
//! the request with its dataset and publisher address.
//!
//! `providerPassageTarget` is the seed's pinpoint (`par12`, `sec5`, `sec5(2)(b)`) linked on the publisher's page as a
//! citation's pinpoint is linked (`cited_passage_link`, the pinpoint's part passed as the citation's pinpoint), its
//! anchor then the one that publisher's page prints for it (`provider_anchor`), or none where it prints none.

use legal_structure::citations::url::source_anchor;
use legal_structure::{
    canlii_case_url, cited_passage_link, law_web_link, passage_link, DocumentQuery, DocumentStructure,
    PassageLinkRequest,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::error::Error;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

fn lines(path: &str) -> Result<Vec<Value>> {
    BufReader::new(File::open(path)?).lines()
        .filter(|line| line.as_ref().map_or(true, |line| !line.trim().is_empty()))
        .map(|line| Ok(serde_json::from_str(&line?)?)).collect()
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}

/// A seed's document key: its label without the dataset, up to its paragraph (`p85`) or section (`sec4`) part
/// (seed-document-key.mjs).
fn document_key(seed: &Value) -> Option<String> {
    let (label, dataset) = (text(seed, "label"), text(seed, "dataset"));
    let rest = label.strip_prefix(&format!("{dataset}_")).unwrap_or(label);
    let bytes = rest.as_bytes();
    (0..bytes.len()).filter(|&at| bytes[at] == b'_').find_map(|at| {
        let next = &rest[at + 1..];
        let part = next.split('_').next()?;
        let paragraph = part.strip_prefix('p').is_some_and(|digits| !digits.is_empty()
            && digits.bytes().all(|byte| byte.is_ascii_digit()));
        ((paragraph || part.starts_with("sec")) && next.len() > part.len()).then(|| rest[..at].to_owned())
    })
}

/// A seed's pinpoint as the engine reads a link's anchor (`par12`; `sec5subsec2`, `sec5`) with the pinpoint naming a
/// provision's deeper part (`sec5(2)(b)`, `sec5(a)`), and the provision's section and subsection numbers.
fn engine_pinpoint(anchor: &str) -> Option<(String, Vec<String>, &str, Option<&str>)> {
    if anchor.strip_prefix("par").is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())) {
        return Some((anchor.to_owned(), Vec::new(), &anchor[3..], None));
    }
    let label = anchor.strip_prefix("sec")?;
    let section_end = label.find('(').unwrap_or(label.len());
    let section = &label[..section_end];
    if section.is_empty() || !section.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return None;
    }
    let first_part = label[section_end..].strip_prefix('(').and_then(|rest| rest.split_once(')')).map(|(part, _)| part);
    let subsection = first_part.filter(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    let engine = match subsection {
        Some(subsection) => format!("sec{section}subsec{subsection}"),
        None => format!("sec{section}"),
    };
    let deeper = label.len() > section_end + subsection.map_or(0, |part| part.len() + 2);
    Some((engine, if deeper { vec![anchor.to_owned()] } else { Vec::new() }, section, subsection))
}

/// The seed's pinpoint linked on its publisher's page (`providerPassageTarget`), with the anchor the engine knows that
/// page prints for it (`source_anchor`: Decisia's `par12`, Justice Laws' `s-5`, BC Laws' `section5`, …), or its text
/// fragment alone where it prints none (bccourts, Alberta's King's Printer, Nova Scotia).
fn provider_passage(query: &DocumentQuery, structure: &DocumentStructure, url: &str, anchor: &str)
    -> Option<(String, String)> {
    let (engine, pinpoints, _, _) = engine_pinpoint(anchor)?;
    let page = url.split('#').next().unwrap_or(url);
    let linked = cited_passage_link(query, structure, &format!("{page}#{engine}"), &pinpoints)?;
    let (base, fragment) = linked.split_once('#')?;
    let directives = fragment.strip_prefix(engine.as_str()).unwrap_or("");
    let kind = if engine.starts_with("par") { "paragraph" } else { "section" };
    let own = source_anchor(base, kind, &engine).unwrap_or_default();
    let fragment = format!("{own}{directives}");
    Some((if fragment.is_empty() { base.to_owned() } else { format!("{base}#{fragment}") }, own))
}

fn plan_seed(query: &DocumentQuery, structure: &DocumentStructure, source: &Value, seed: &Value) -> Value {
    let dataset = text(source, "dataset");
    let citation = text(source, "citation");
    let laws = dataset.starts_with("LEGISLATION-") || dataset.starts_with("REGULATIONS-");
    let block_text = text(seed, "blockText");
    let quotes = seed.get("quotes").and_then(Value::as_array).into_iter().flatten()
        .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
    let anchor = seed.get("anchor").and_then(Value::as_str);
    let request = |url: &str, anchor: Option<&str>| PassageLinkRequest {
        url: url.to_owned(), anchor: anchor.map(str::to_owned), block_text: block_text.to_owned(),
        quotes: quotes.clone(), prefer_independent_html_blocks: false, verified_pdf: None,
    };
    let provider = passage_link(query, structure, &request(text(seed, "url"), anchor));
    let mut row = seed.as_object().cloned().unwrap_or_default();
    row.insert("target".into(), json!(provider.as_ref().map(|link| link.target.clone())));
    if let Some(Value::Object(plan)) = provider.and_then(|link| link.plan).map(|plan| json!(plan)) {
        row.extend(plan);
    }
    let canlii = if laws { legal_structure::canlii_law_url(citation, "en", true) } else { canlii_case_url(&[citation.to_owned()], "en", Some(dataset)) };
    if let Some(canlii) = canlii {
        let (kind, label) = match anchor {
            Some(anchor) if anchor.starts_with("par") => (Some("paragraph"), anchor),
            Some(anchor) if anchor.starts_with("sec") => (Some("section"), &anchor["sec".len()..]),
            _ => (None, ""),
        };
        let canlii_anchor = kind.and_then(|kind| source_anchor(&canlii, kind, label)).unwrap_or_default();
        row.insert("canliiTarget".into(), json!(passage_link(query, structure,
            &request(&canlii, Some(&canlii_anchor))).map(|link| link.target)));
        // The pinpoint's part below the page's anchor ("sec55.7(1)(a)" under #sec55.7subsec1) goes with it, as a
        // citation's does.
        let parts = anchor.and_then(engine_pinpoint).map(|(_, parts, _, _)| parts).unwrap_or_default();
        row.insert("canliiPassageTarget".into(), json!((!canlii_anchor.is_empty())
            .then(|| cited_passage_link(query, structure, &format!("{canlii}#{canlii_anchor}"), &parts)).flatten()));
        row.insert("canlii".into(), json!(canlii));
    }
    if let Some((target, own)) = anchor.and_then(|anchor| provider_passage(query, structure, text(seed, "url"), anchor)) {
        row.insert("providerPassageTarget".into(), json!(target));
        row.insert("providerPassageAnchor".into(), json!(own));
    }
    row.insert("lawWebTarget".into(), json!(law_web_link(query, structure, citation, if laws { "laws" } else { "cases" },
        block_text, &quotes)));
    Value::Object(row)
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [seeds, requests, stored, out, ..] = args.as_slice() else {
        return Err("usage: plan_targets SEEDS REQUESTS STORED_DIR OUT [--threads N]".into());
    };
    let threads = args.iter().position(|arg| arg == "--threads")
        .and_then(|at| args.get(at + 1)?.parse().ok()).unwrap_or(8usize);
    let only: Option<std::collections::HashSet<String>> = args.iter().position(|arg| arg == "--only")
        .and_then(|at| args.get(at + 1)).map(std::fs::read_to_string).transpose()?
        .map(|labels| labels.lines().map(|line| line.split('~').next().unwrap_or("").to_owned()).collect());
    let seeds: Vec<Value> = lines(seeds)?.into_iter()
        .filter(|seed| only.as_ref().is_none_or(|only| only.contains(text(seed, "label")))).collect();
    // Each stored structure's request by its dataset and publisher address, as a seed names its document.
    let stored_requests: HashMap<(String, String), (String, Value)> = lines(requests)?.into_iter().filter_map(|row| {
        let input = row.get("input")?.clone();
        Some(((text(&input, "dataset").to_owned(), text(&input, "url").to_owned()), (text(&row, "key").to_owned(), input)))
    }).collect();
    let mut documents: Vec<(String, Vec<usize>)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for (index, seed) in seeds.iter().enumerate() {
        let Some(key) = document_key(seed) else { continue };
        let slot = *at.entry(key.clone()).or_insert_with(|| { documents.push((key, Vec::new())); documents.len() - 1 });
        documents[slot].1.push(index);
    }
    let rows = Mutex::new(vec![Value::Null; seeds.len()]);
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let Some((key, members)) = documents.get(next.fetch_add(1, Ordering::Relaxed)) else { break };
                let first = &seeds[members[0]];
                let Some((stored_key, source)) = stored_requests.get(&(text(first, "dataset").to_owned(),
                    text(first, "url").to_owned())) else {
                    eprintln!("{key}: no stored request");
                    continue;
                };
                let Some(structure) = File::open(Path::new(stored).join(format!("{stored_key}.json"))).ok()
                    .and_then(|file| serde_json::from_reader::<_, DocumentStructure>(BufReader::new(file)).ok()) else {
                    eprintln!("{key}: no stored structure");
                    continue;
                };
                let query = DocumentQuery::new();
                let planned = members.iter().map(|&index| (index, plan_seed(&query, &structure, source, &seeds[index])))
                    .collect::<Vec<_>>();
                let mut rows = rows.lock().unwrap();
                for (index, row) in planned { rows[index] = row; }
            });
        }
    });
    let mut writer = BufWriter::new(File::create(out)?);
    let mut written = 0;
    for row in rows.into_inner().unwrap().into_iter().filter(|row| !row.is_null()) {
        serde_json::to_writer(&mut writer, &row)?;
        writer.write_all(b"\n")?;
        written += 1;
    }
    eprintln!("{written} targets of {} seeds", seeds.len());
    Ok(())
}
