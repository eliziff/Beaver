#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! How the reporter citations of a folder of documents link through Beaver's local A2AJ store, read as production
//! reads it: each full reporter citation found as Authorities asks the store (its citation, then its styled
//! citation, `a2aj_lookup::find`), the decision found linked as a passage's links are (`canlii_case_url` over the
//! decision's citations, its publisher's page), and, where a CanLII index is given, whether a Supreme Court
//! decision's CanLII page is one the index lists (measurement only: nothing of the index is written out).
//!
//!   reporter_links TEXT_DIR OUT.tsv [--store A2AJ.sqlite] [--canlii-index CANLII.db]
//!
//! TEXT_DIR holds one `.txt` per document. The name route's false-match rate is read two ways: for every citation
//! the store finds by its key (the Supreme Court Reports), the decision its style, year and court alone name; and
//! for every other reporter citation printed beside a neutral citation the store finds, the decision its name finds.

#[path = "../a2aj_lookup.rs"]
mod a2aj_lookup;

use legal_structure::a2aj::{Document, Source, StoreRow};
use legal_structure::citations::{extract, Authority, Form, Format, Options};
use legal_structure::{canlii_case_url, citation_lookup_key, reporter_decision};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let option = |name: &str| args.iter().position(|arg| arg == name).and_then(|at| args.get(at + 1)).cloned();
    let (dir, out) = (args.first().ok_or("TEXT_DIR")?, args.get(1).ok_or("OUT.tsv")?);
    let store = option("--store").unwrap_or_else(|| format!("{}/OpenLegalData/providers/a2aj/a2aj.sqlite",
        std::env::var("LOCALAPPDATA").unwrap_or_default()));
    let connection = Connection::open_with_flags(&store, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let index = option("--canlii-index").map(|path| Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY))
        .transpose()?;
    let mut out = std::io::BufWriter::new(std::fs::File::create(out)?);
    writeln!(out, "doc\treporter\tcourt\tstyled\troute\tdataset\tcitation\tcanlii\tpublisher\tcanlii_listed\tname_probe\tparallel_check\tform\tparentheticals\tany_court")?;
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut count = |name: &str| *counts.entry(name.to_owned()).or_default() += 1;
    let datasets = connection.prepare("SELECT DISTINCT dataset FROM document WHERE doc_type = 'cases'")?
        .query_map([], |row| row.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
    let mut entries = std::fs::read_dir(dir)?.flatten().map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "txt")).collect::<Vec<_>>();
    entries.sort();
    let unique = |found: Vec<i64>| match found.len() { 0 => "none".to_owned(), 1 => found[0].to_string(), _ => "ambiguous".to_owned() };
    for path in &entries {
        let doc = path.file_stem().unwrap().to_string_lossy().chars().take(12).collect::<String>();
        let text = std::fs::read_to_string(path)?;
        let citations = extract(&text, &Options { resolve: false, parallel: false, ..Default::default() });
        // The parallels printed side by side, by where each core starts.
        let grouped = extract(&text, &Options { resolve: false, ..Default::default() });
        let group_of: HashMap<usize, usize> = grouped.iter().filter_map(|citation|
            citation.parallel_group.map(|group| (citation.span.start, group))).collect();
        let neutral_of_group: HashMap<usize, &str> = grouped.iter().filter(|citation| citation.format == Some(Format::Neutral))
            .filter_map(|citation| citation.parallel_group.map(|group| (group, citation.span.text.as_str()))).collect();
        for citation in &citations {
            if citation.form != Form::Full || citation.format != Some(Format::Reporter) || citation.authority != Authority::Case {
                continue;
            }
            count("reporter citations");
            let canadian = citation.jurisdiction.as_deref().is_some_and(|jurisdiction| jurisdiction == "ca" || jurisdiction.starts_with("ca-"));
            if !canadian { count("  not Canadian (jurisdiction)"); continue; }
            count("canadian reporter citations");
            let core = citation.span.text.clone();
            let styled = citation.style.as_ref().map(|style| text[style.start..citation.span.end].to_owned());
            let reporter = citation.fields.reporter_id.clone().unwrap_or_else(|| "-".to_owned());
            let key = citation_lookup_key(&core);
            let by_key = a2aj_lookup::find(&connection, &core, Some("cases"), None, None)?;
            let by_form = match (&by_key, &styled) {
                (None, Some(styled)) => a2aj_lookup::find(&connection, styled, Some("cases"), None, None)?,
                _ => None,
            };
            let indexed = a2aj_lookup::reporter_indexed(&connection, &key)?;
            if indexed { count("  reporter the store indexes (by key)"); }
            let decision = styled.as_deref().and_then(reporter_decision);
            if styled.is_some() { count("  with a style of cause"); }
            if decision.is_some() { count("  with style, year and named court (name route can ask)"); }
            let route = if by_key.is_some() { "key" } else if by_form.is_some() { "name" } else { "none" };
            count(&format!("  found by {route}"));
            let mut row = ("".to_owned(), "".to_owned(), "".to_owned(), "".to_owned(), "".to_owned());
            if let Some(id) = by_key.or(by_form) {
                const COLUMNS: [&str; 4] = ["dataset", "citation_en", "citation2_en", "url_en"];
                let found = connection.query_row(&format!("SELECT {} FROM document WHERE id = ?", COLUMNS.join(", ")), [id],
                    |row| StoreRow::from_query(row, 0, &COLUMNS))?;
                let found = Document::new(&found, Source::Store);
                let (dataset, english, url) = (found.field("dataset")?.unwrap_or_default(), found.field("citation_en")?, found.field("url_en")?);
                let forms = [english.clone(), found.field("citation2_en")?].into_iter().flatten().collect::<Vec<_>>();
                let canlii = canlii_case_url(&forms, "en", Some(&dataset));
                count(&format!("  found by {route}: CanLII link {}", if canlii.is_some() { "made" } else { "not made" }));
                if url.is_some() { count(&format!("  found by {route}: publisher link")); }
                // The index files the Supreme Court's decisions under `csc-scc`, every other court under the database
                // its pages name (`…/onca/doc/2013/2013onca494/…`).
                let listed = match (&index, &canlii) {
                    (Some(index), Some(page)) => {
                        let parts = page.split('/').collect::<Vec<_>>();
                        let at = parts.iter().position(|part| *part == "doc").unwrap_or(0);
                        let database = if dataset == "SCC" { "csc-scc" } else { parts[at.saturating_sub(1)] };
                        let slug = parts.last().unwrap_or(&"").trim_end_matches(".html");
                        let found = index.query_row("SELECT 1 FROM cases WHERE databaseId = ? AND caseId = ?",
                            [database, slug], |_| Ok(())).optional()?.is_some();
                        let court = if dataset == "SCC" { "SCC" } else { "other courts'" };
                        count(&format!("  {court} CanLII slug {}", if found { "listed" } else { "NOT listed" }));
                        if found { "listed" } else { "not-listed" }
                    }
                    _ => "",
                };
                row = (dataset, english.unwrap_or_default(), canlii.unwrap_or_default(), url.unwrap_or_default(), listed.to_owned());
            }
            // The name route on its own, against the decision the key found.
            let mut probe = String::new();
            if let (Some(id), Some(decision)) = (by_key, &decision) {
                let named = unique(a2aj_lookup::named_decisions(&connection, decision)?);
                probe = if named == id.to_string() { "agree".to_owned() } else { named };
                count(&format!("  name probe on key-found: {}", if probe == "agree" { "agree" }
                    else if probe == "none" || probe == "ambiguous" { probe.as_str() } else { "DISAGREE" }));
            }
            // The name route against the neutral citation printed beside it.
            // What the name and year alone would find in any court, where no court is written: what a court read
            // from the reporter alone would reach (it is not asked: the store lacks most courts such reporters report).
            let mut any_court = String::new();
            if route == "none" && decision.is_none() && !indexed {
                if let (Some(style), Some(year)) = (citation.style.as_ref(), citation.fields.year_number) {
                    let anywhere = legal_structure::ReporterDecision { name: style.text.trim().to_owned(), year,
                        courts: datasets.clone() };
                    let found = a2aj_lookup::named_decisions(&connection, &anywhere)?;
                    any_court = unique(found.clone());
                    if let [id] = found[..] {
                        let dataset: String = connection.query_row("SELECT dataset FROM document WHERE id = ?", [id], |row| row.get(0))?;
                        any_court = format!("{id}:{dataset}");
                    }
                    count(&format!("  unfound, no court: name+year in any court {}", match found.len() { 0 => "none", 1 => "one", _ => "several" }));
                }
            }
            let mut parallel = String::new();
            if !indexed {
                let neutral = group_of.get(&citation.span.start).and_then(|group| neutral_of_group.get(group));
                if let Some(neutral) = neutral {
                    count("  non-indexed reporter beside a neutral citation");
                    if let (Some(truth), Some(decision)) = (a2aj_lookup::find(&connection, neutral, Some("cases"), None, None)?, &decision) {
                        let named = unique(a2aj_lookup::named_decisions(&connection, decision)?);
                        parallel = if named == truth.to_string() { "agree".to_owned() } else { named };
                        count(&format!("  parallel check: {}", if parallel == "agree" { "agree" }
                            else if parallel == "none" || parallel == "ambiguous" { parallel.as_str() } else { "DISAGREE" }));
                    }
                }
            }
            let clean = |value: &str| value.replace(['\t', '\n', '\r'], " ");
            writeln!(out, "{doc}\t{reporter}\t{}\t{}\t{route}\t{}\t{}\t{}\t{}\t{}\t{probe}\t{parallel}\t{}\t{}\t{any_court}",
                citation.court.as_ref().map_or("-", |court| court.id.as_str()), styled.is_some(), row.0, clean(&row.1),
                row.2, row.3, row.4, clean(styled.as_deref().unwrap_or(&core)),
                clean(&citation.parentheticals.iter().map(|part| format!("{:?}:{}", part.kind, part.content)).collect::<Vec<_>>().join("|")))?;
        }
    }
    println!("{} documents", entries.len());
    for (name, value) in &counts { println!("{value:>8}  {name}"); }
    Ok(())
}
