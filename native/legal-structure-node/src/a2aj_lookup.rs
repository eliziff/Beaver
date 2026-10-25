//! Finding a document in Beaver's local A2AJ store (a2aj.sqlite): by its citation's key, and a decision a reporter
//! citation names where the store does not index the reporter, by its style of cause. A2AJ gives reporter citations
//! for the Supreme Court's decisions alone, so an OR or a DLR citation is found by its name, year and court, and is
//! then linked by the decision's neutral citation. Only a name the store keys exactly, in one decision of that court
//! and year, finds it. The engine (a2aj.rs) and the store's census bins read the store through these.

use legal_structure::{citation_lookup_key, reporter_decision, ReporterDecision};
use regex::Regex;
use rusqlite::{types::ValueRef, Connection, OptionalExtension};
use std::collections::BTreeSet;
use std::sync::LazyLock;

pub fn sql(error: rusqlite::Error) -> String {
    error.to_string()
}

/// JavaScript's white space and line terminators, which `String.prototype.trim` removes.
pub fn js_space(character: char) -> bool {
    matches!(character, '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn js_trim(value: &str) -> &str {
    value.trim_matches(js_space)
}

/// A cell's text, trimmed; None where it is not text or only white space.
pub fn cell(value: ValueRef) -> Option<String> {
    match value {
        ValueRef::Text(bytes) => {
            let value = js_trim(&String::from_utf8_lossy(bytes)).to_owned();
            (!value.is_empty()).then_some(value)
        }
        _ => None,
    }
}

/// The one document the store holds under a citation's key, among the collections and at the address asked for.
pub fn find(connection: &Connection, citation: &str, doc_type: Option<&str>, dataset: Option<&str>, source_url: Option<&str>)
    -> Result<Option<i64>, String> {
    let citation = js_trim(citation);
    if citation.is_empty() {
        return Err("citation is required".to_owned());
    }
    let key = citation_lookup_key(citation);
    if key.is_empty() {
        return Ok(None);
    }
    let mut filters = vec!["document.id IN (SELECT document_id FROM citation_lookup WHERE citation_key = ?)",
        "document.doc_type = ?"].into_iter().map(str::to_owned).collect::<Vec<_>>();
    let mut values = vec![key, doc_type.unwrap_or("cases").to_owned()];
    let mut seen = BTreeSet::new();
    let datasets: Vec<String> = dataset.unwrap_or_default().split(',').map(js_trim)
        .filter(|name| !name.is_empty() && seen.insert(*name)).take(50).map(str::to_owned).collect();
    if !datasets.is_empty() {
        filters.push(format!("LOWER(document.dataset) IN ({})", vec!["LOWER(?)"; datasets.len()].join(", ")));
        values.extend(datasets.iter().cloned());
    }
    if let Some(url) = source_url.map(js_trim).filter(|url| !url.is_empty()) {
        filters.push("(document.url_en = ? OR document.url_fr = ?)".to_owned());
        values.extend([url.to_owned(), url.to_owned()]);
    }
    let mut statement = connection.prepare_cached(&format!(
        "SELECT document.id, document.name_en, document.name_fr, document.citation_en, document.citation2_en,
         document.citation_fr, document.citation2_fr FROM document WHERE {} ORDER BY document.id LIMIT 16",
        filters.join(" AND "))).map_err(sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(values.iter()), |row| {
        let text = |at: usize| row.get_ref(at).map(cell);
        Ok((row.get::<_, i64>(0)?, [text(1)?, text(2)?], [text(3)?, text(4)?, text(5)?, text(6)?]))
    }).map_err(sql)?.collect::<Result<Vec<_>, _>>().map_err(sql)?;
    if rows.len() == 1 {
        return Ok(Some(rows[0].0));
    }
    // A reporter the store does not index: the decision its style of cause names in its court and year.
    if rows.is_empty() && source_url.map_or(true, |url| js_trim(url).is_empty())
        && doc_type.map_or(true, |kind| kind == "cases") {
        return find_by_name(connection, citation, &datasets);
    }
    // Several documents under one key ("RSC 1985, c 1" is a statute and its supplements' chapters 1): the one whose
    // own citation the citation is ("RSC 1985, c 1 (2nd Supp)"), else the one whose name it writes ("Customs Act,
    // RSC 1985, c 1").
    let written = folded(citation);
    let only = |chosen: Vec<i64>| (chosen.len() == 1).then(|| chosen[0]);
    let cited = rows.iter().filter(|(_, _, citations)| citations.iter().flatten().any(|own| folded(own) == written))
        .map(|(id, _, _)| *id).collect::<Vec<_>>();
    let named = rows.iter().filter(|(_, names, _)| names.iter().flatten()
        .any(|name| folded(name).len() > 3 && written.contains(&folded(name)))).map(|(id, _, _)| *id).collect::<Vec<_>>();
    Ok(only(cited).or_else(|| only(named)))
}

/// Lowercase words, each set apart by one space: a name compared as written in a citation.
pub fn folded(value: &str) -> String {
    let words = value.split(|character: char| !character.is_alphanumeric()).filter(|word| !word.is_empty())
        .map(str::to_lowercase).collect::<Vec<_>>();
    format!(" {} ", words.join(" "))
}

/// A style of cause compared as its words, as the installer keys `name_lookup` (a2ajInstall.ts a2ajNameKey).
pub fn name_key(value: &str) -> String {
    static INITIALS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([A-Za-z0-9_])\.([A-Za-z0-9_])\.?").unwrap());
    static VERSUS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\s+v\.?\s+").unwrap());
    static DASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new("[-\u{2010}-\u{2015}/]+").unwrap());
    static OTHER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}_\s]").unwrap());
    let value = INITIALS.replace_all(value, "$1$2");
    let value = VERSUS.replace_all(&value, " v ");
    let value = DASHES.replace_all(&value, " ");
    let value = OTHER.replace_all(&value, "");
    value.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Whether the store indexes the reporter of the citation `key` names (`3:reporter:scr:scr:…`): a citation of a
/// reporter it indexes that it does not find is not found by name instead.
pub fn reporter_indexed(connection: &Connection, key: &str) -> Result<bool, String> {
    let parts = key.split(':').collect::<Vec<_>>();
    if parts.len() < 5 || parts[1] != "reporter" { return Ok(false); }
    let prefix = format!("{}:", parts[..4].join(":"));
    connection.prepare_cached("SELECT 1 FROM citation_lookup WHERE citation_key >= ? AND citation_key < ? LIMIT 1")
        .and_then(|mut statement| statement.query_row([&prefix, &format!("{prefix}\u{10ffff}")], |_| Ok(()))
            .optional()).map(|found| found.is_some()).map_err(sql)
}

/// The decisions of the citation's court and year that bear its name in the store.
pub fn named_decisions(connection: &Connection, decision: &ReporterDecision) -> Result<Vec<i64>, String> {
    let key = name_key(&decision.name);
    if key.is_empty() { return Ok(Vec::new()); }
    let mut statement = connection.prepare_cached("SELECT document.id, document.dataset, document.document_date_en,
        document.document_date_fr FROM name_lookup JOIN document ON document.id = name_lookup.document_id
        WHERE name_lookup.name_key = ? AND document.doc_type = 'cases'").map_err(sql)?;
    let rows = statement.query_map([&key], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?,
        row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?)))
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>()).map_err(sql)?;
    let year = |date: &Option<String>| date.as_deref().and_then(|date| date.get(..4)).and_then(|year| year.parse::<i32>().ok());
    Ok(rows.into_iter().filter(|(_, dataset, english, french)|
        dataset.as_deref().is_some_and(|dataset| decision.courts.iter().any(|court| court.eq_ignore_ascii_case(dataset)))
            && year(english).or(year(french)).is_some_and(|year| year == decision.year))
        .map(|(id, ..)| id).collect())
}

/// The one decision a reporter citation names by its style, year and court, among `datasets` where any are given,
/// where the store does not index its reporter.
pub fn find_by_name(connection: &Connection, citation: &str, datasets: &[String]) -> Result<Option<i64>, String> {
    let Some(mut decision) = reporter_decision(citation) else { return Ok(None) };
    if reporter_indexed(connection, &citation_lookup_key(citation))? { return Ok(None); }
    if !datasets.is_empty() {
        decision.courts.retain(|court| datasets.iter().any(|dataset| dataset.eq_ignore_ascii_case(court)));
    }
    let found = named_decisions(connection, &decision)?;
    Ok((found.len() == 1).then(|| found[0]))
}
