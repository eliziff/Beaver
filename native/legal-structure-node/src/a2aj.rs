//! Beaver's local A2AJ store (a2aj.sqlite, which a2ajInstall.ts installs), read by the engine: a decision or statute
//! is found by its citation key, read and derived here, and JavaScript is given its metadata and documents, never its
//! text.

use crate::a2aj_lookup::{self, cell, js_trim, sql};
use crate::engine::{self, CoreResult, NativeDocument, StructureRequest};
use legal_structure::{citation_lookup_key, ProviderTextInput, ProviderTextSourceKind};
use regex::Regex;
use rusqlite::{types::ValueRef, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, Weak};
use std::time::SystemTime;

/// Which copy of a store a connection or a document came from: a store replaced in its place is another copy.
type Stamp = (u64, Option<SystemTime>);

fn stamp(path: &Path) -> Option<Stamp> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.len(), metadata.modified().ok()))
}

/// Read-only connections, kept while their copy of the store is: the installer writes the store in place, through its
/// write-ahead log, which readers may hold open. Opening and closing one costs more than most reads.
static CONNECTIONS: Mutex<Vec<(PathBuf, Stamp, Connection)>> = Mutex::new(Vec::new());

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs `work` on a read-only connection to the store; None where there is no store.
fn with_store<T>(path: &Path, work: impl FnOnce(&Connection, Stamp) -> CoreResult<T>) -> CoreResult<Option<T>> {
    let Some(stamp) = stamp(path) else { return Ok(None) };
    let kept = {
        let mut connections = lock(&CONNECTIONS);
        connections.retain(|(other, held, _)| other != path || *held == stamp);
        connections.iter().position(|(other, _, _)| other == path).map(|index| connections.swap_remove(index).2)
    };
    let connection = match kept {
        Some(connection) => connection,
        None => {
            let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(sql)?;
            // A decision's text runs over many pages: they are read from a mapping of the file, not a call each.
            connection.execute_batch("PRAGMA mmap_size=2147418112").map_err(sql)?;
            connection
        }
    };
    let result = work(&connection, stamp);
    lock(&CONNECTIONS).push((path.to_owned(), stamp, connection));
    result.map(Some)
}

/// The documents derived from a store, kept while JavaScript holds them: an operation's stages ask for the same
/// decision in each of its forms, and each asks the store again.
struct Derived {
    metadata: Metadata,
    native: Weak<NativeDocument>,
    search: Option<Weak<NativeDocument>>,
}
static DERIVED: Mutex<Vec<((PathBuf, Stamp, String), Derived)>> = Mutex::new(Vec::new());

fn derived(key: &(PathBuf, Stamp, String)) -> Option<Found> {
    let cache = lock(&DERIVED);
    let (_, kept) = cache.iter().find(|(other, _)| other == key)?;
    Some(Found {
        metadata: kept.metadata.clone(),
        native: kept.native.upgrade()?,
        search: match &kept.search {
            Some(search) => Some(search.upgrade()?),
            None => None,
        },
    })
}

fn keep(key: (PathBuf, Stamp, String), found: &Found) {
    let mut cache = lock(&DERIVED);
    cache.retain(|(other, kept)| *other != key && kept.native.strong_count() > 0);
    cache.push((key, Derived {
        metadata: found.metadata.clone(),
        native: Arc::downgrade(&found.native),
        search: found.search.as_ref().map(Arc::downgrade),
    }));
}

/// A GLOB that a text matches when it holds a character other than JavaScript's white space.
const NOT_BLANK: &str = "*[^\t\n\u{b}\u{c}\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*";

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    En,
    Fr,
}

impl Language {
    fn code(self) -> &'static str {
        match self {
            Language::En => "en",
            Language::Fr => "fr",
        }
    }
    fn other(self) -> Self {
        match self {
            Language::En => Language::Fr,
            Language::Fr => Language::En,
        }
    }
}

/// The document's small fields: every one but its texts and provisions.
const FIELDS: [&str; 13] = ["doc_type", "dataset", "citation_en", "citation_fr", "citation2_en", "citation2_fr",
    "name_en", "name_fr", "document_date_en", "document_date_fr", "url_en", "url_fr", "upstream_license"];

/// One document's row, its long columns read only when asked for.
struct Row<'a> {
    connection: &'a Connection,
    id: i64,
    fields: HashMap<&'static str, Option<String>>,
}

impl<'a> Row<'a> {
    fn read(connection: &'a Connection, id: i64) -> CoreResult<Option<Self>> {
        let mut statement = connection.prepare_cached(&format!("SELECT {} FROM document WHERE id = ?", FIELDS.join(", ")))
            .map_err(sql)?;
        statement.query_row([id], |row| FIELDS.iter().enumerate()
            .map(|(index, field)| Ok((*field, cell(row.get_ref(index)?))))
            .collect::<rusqlite::Result<HashMap<_, _>>>())
            .optional().map_err(sql)
            .map(|fields| fields.map(|fields| Row { connection, id, fields }))
    }

    /// A column's text, trimmed; None where it is not text or only white space.
    fn text(&self, column: &str) -> CoreResult<Option<String>> {
        if let Some(value) = self.fields.get(column) {
            return Ok(value.clone());
        }
        let mut statement = self.connection.prepare_cached(&format!("SELECT {column} FROM document WHERE id = ?"))
            .map_err(sql)?;
        statement.query_row([self.id], |row| Ok(cell(row.get_ref(0)?))).map_err(sql)
    }

    /// Whether a long column holds text, without reading it all.
    fn holds(&self, column: &str) -> CoreResult<bool> {
        let mut statement = self.connection.prepare_cached(&format!(
            "SELECT typeof({column}) = 'text' AND {column} GLOB ? FROM document WHERE id = ?")).map_err(sql)?;
        statement.query_row(rusqlite::params![NOT_BLANK, self.id], |row| row.get::<_, bool>(0)).map_err(sql)
    }

    /// A field in the language asked for, else in the other.
    fn language_field(&self, field: &str, language: Language) -> CoreResult<Option<String>> {
        Ok(match self.text(&format!("{field}_{}", language.code()))? {
            Some(value) => Some(value),
            None => self.text(&format!("{field}_{}", language.other().code()))?,
        })
    }

    /// The document's provisions, in the order JavaScript gives an object's keys: whole-number keys first, in their
    /// order, then the others as written.
    fn sections(&self, language: Language) -> CoreResult<Option<Vec<(String, String)>>> {
        let Some(value) = self.language_field("unofficial_sections", language)? else { return Ok(None) };
        let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&value) else { return Ok(None) };
        let index = |key: &str| (key == "0" || (!key.starts_with('0') && key.bytes().all(|byte| byte.is_ascii_digit())))
            .then(|| key.parse::<u64>().ok()).flatten().filter(|value| *value < u32::MAX as u64);
        let mut entries: Vec<(String, String)> = parsed.into_iter()
            .filter_map(|(key, value)| match value { Value::String(text) => Some((key, text)), _ => None })
            .collect();
        entries.sort_by_key(|(key, _)| index(key).map_or((1, 0), |value| (0, value)));
        Ok((!entries.is_empty()).then_some(entries))
    }

    /// The document's metadata in a language, where it has a citation in it.
    fn metadata(&self, actual: Language) -> CoreResult<Option<Metadata>> {
        let Some(citation) = self.language_field("citation", actual)?.or(self.language_field("citation2", actual)?)
            else { return Ok(None) };
        let url = self.language_field("url", actual)?;
        Ok(Some(Metadata {
            doc_type: if self.text("doc_type")?.as_deref() == Some("laws") { "laws" } else { "cases" },
            dataset: self.text("dataset")?.unwrap_or_default(),
            citation,
            alternate_citation: self.language_field("citation2", actual)?,
            name: self.language_field("name", actual)?,
            // The first ten UTF-16 units, as the page reads a date: the store's dates are ASCII.
            date: self.language_field("document_date", actual)?.map(|date| date.chars().take(10).collect()),
            publisher_url: url.clone(),
            url,
            language: actual,
            upstream_license: self.text("upstream_license")?,
        }))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    doc_type: &'static str,
    dataset: String,
    citation: String,
    alternate_citation: Option<String>,
    name: Option<String>,
    date: Option<String>,
    url: Option<String>,
    publisher_url: Option<String>,
    language: Language,
    upstream_license: Option<String>,
}

/// A store's document: its metadata, its provisions' document (or its text's, where it has no provisions), and its
/// full text's document where that is another.
pub struct Found {
    pub metadata: Metadata,
    pub native: Arc<NativeDocument>,
    pub search: Option<Arc<NativeDocument>>,
}

/// The engine's reading of a provider text, as the page derives an A2AJ document.
fn derive(metadata: &Metadata, doc_type: &str, text: String, sections: Option<Vec<(String, String)>>,
    id: Option<String>, excerpt_of: Option<String>) -> CoreResult<NativeDocument> {
    let present = |value: &Option<String>| value.clone().filter(|value| !value.is_empty());
    engine::derive_document_structure(StructureRequest::ProviderText { input: ProviderTextInput {
        provider: Some("a2aj".to_owned()),
        citation: metadata.citation.clone(),
        source_kind: if doc_type == "laws" { ProviderTextSourceKind::Laws } else { ProviderTextSourceKind::Cases },
        text,
        id,
        url: present(&metadata.url),
        dataset: present(&Some(metadata.dataset.clone())),
        name: present(&metadata.name),
        alternate_citation: present(&metadata.alternate_citation),
        section_map: sections,
        excerpt_of,
        require_report_start: doc_type == "cases" && metadata.dataset.to_uppercase() == "SCC",
    } })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    citation: String,
    doc_type: Option<String>,
    language: Option<Language>,
    dataset: Option<String>,
    source_url: Option<String>,
}

/// The one document the store holds under a citation, among the collections and at the address asked for.
fn find(connection: &Connection, lookup: &Lookup) -> CoreResult<Option<i64>> {
    a2aj_lookup::find(connection, &lookup.citation, lookup.doc_type.as_deref(), lookup.dataset.as_deref(),
        lookup.source_url.as_deref())
}

/// JavaScript's white space, as a regular expression's class holds it.
const SPACE: &str = r"\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";
static INITIALS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"((?-u:\w))\.((?-u:\w))\.?").expect("initials"));
static VERSUS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[{SPACE}]+[vV]\.?[{SPACE}]+")).expect("versus"));
static JOINERS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[-\u{2010}-\u{2015}/]+").expect("joiners"));
static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"[^\p{{L}}\p{{N}}_{SPACE}]")).expect("marks"));

/// A style of cause compared as its words, the key of the store's name_lookup and of CanLII's titles (the Python
/// app's canlii_search.normalize_title): initials closed up ("R.B.C." as "RBC"), "v." as "v", dashes and slashes as
/// spaces, other marks dropped, lowercase.
pub fn name_key(value: &str) -> String {
    let value = INITIALS.replace_all(value, "${1}${2}");
    let value = VERSUS.replace_all(&value, " v ");
    let value = JOINERS.replace_all(&value, " ");
    let value = MARKS.replace_all(&value, "");
    value.split(js_space).filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ").to_lowercase()
}

/// A decision asked for by its style of cause, its year and the courts that may have decided it.
#[derive(Deserialize)]
pub struct Named {
    name: String,
    year: String,
    #[serde(default)]
    courts: Vec<String>,
}

/// The citation of the one decision the store holds under a style of cause, dated in the year asked for, of one of
/// the courts asked for (of any where none is): how a decision cited by an identifier A2AJ does not carry ("1991
/// CanLII 45 (SCC)") is found, as the Python app's identity_hints does. None where no decision answers, or several.
pub fn named_case(path: &Path, named: &Named) -> CoreResult<Option<String>> {
    let key = name_key(&named.name);
    let year = js_trim(&named.year);
    if key.is_empty() || year.len() != 4 || !year.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(None);
    }
    Ok(with_store(path, |connection, _| {
        let mut statement = connection.prepare_cached("SELECT document.dataset, document.document_date_en,
             document.document_date_fr, document.citation_en, document.citation_fr FROM name_lookup
             JOIN document ON document.id = name_lookup.document_id
             WHERE name_lookup.name_key = ? AND document.doc_type = 'cases'").map_err(sql)?;
        let rows = statement.query_map([&key], |row| {
            let text = |at: usize| row.get_ref(at).map(cell);
            Ok([text(0)?, text(1)?, text(2)?, text(3)?, text(4)?])
        }).map_err(sql)?.collect::<Result<Vec<_>, _>>().map_err(sql)?;
        let citations = rows.into_iter().filter(|[dataset, date_en, date_fr, _, _]| {
            let court = named.courts.is_empty() || dataset.as_deref()
                .is_some_and(|dataset| named.courts.iter().any(|court| court.eq_ignore_ascii_case(dataset)));
            court && date_en.as_deref().or(date_fr.as_deref()).is_some_and(|date| date.starts_with(year))
        }).filter_map(|[_, _, _, english, french]| english.or(french)).collect::<BTreeSet<_>>();
        Ok((citations.len() == 1).then(|| citations.into_iter().next()).flatten())
    })?.flatten())
}

/// A document the store holds under a citation, derived once while JavaScript holds it.
pub fn document(path: &Path, lookup: &Lookup) -> CoreResult<Option<Found>> {
    let language = lookup.language.unwrap_or(Language::En);
    Ok(with_store(path, |connection, stamp| {
        let Some(id) = find(connection, lookup)? else { return Ok(None) };
        let key = (path.to_owned(), stamp, format!("{id}\0{}", language.code()));
        if let Some(found) = derived(&key) {
            return Ok(Some(found));
        }
        let Some(row) = Row::read(connection, id)? else { return Ok(None) };
        // The document is read in the language asked for where it has text in it, else in the other.
        let (actual, text) = match row.text(&format!("unofficial_text_{}", language.code()))? {
            Some(text) => (language, text),
            None => match row.text(&format!("unofficial_text_{}", language.other().code()))? {
                Some(text) => (language.other(), text),
                None => return Ok(None),
            },
        };
        let Some(metadata) = row.metadata(actual)? else { return Ok(None) };
        let doc_type = metadata.doc_type;
        let found = match row.sections(actual)? {
            // The provisions make the structured read; searches read the provider's own full text.
            Some(sections) => Found {
                native: Arc::new(derive(&metadata, doc_type, String::new(), Some(sections), None, None)?),
                search: Some(Arc::new(derive(&metadata, doc_type, text, None, None, None)?)),
                metadata,
            },
            None => Found {
                native: Arc::new(derive(&metadata, doc_type, text, None, None, None)?),
                search: None,
                metadata,
            },
        };
        keep(key, &found);
        Ok(Some(found))
    })?.flatten())
}

/// What a provision's excerpt carries of the document it comes from.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Excerpt {
    citation: String,
    url: Option<String>,
    alternate_citation: Option<String>,
    dataset: Option<String>,
    name: Option<String>,
}

/// One provision of a statute the store holds: None where the store lacks the statute, Some(None) where it lacks the
/// provision.
pub fn section(path: &Path, lookup: &Lookup, section: &str, excerpt: Excerpt)
    -> CoreResult<Option<Option<Arc<NativeDocument>>>> {
    let language = lookup.language.unwrap_or(Language::En);
    Ok(with_store(path, |connection, stamp| {
        let Some(id) = find(connection, lookup)? else { return Ok(None) };
        let Some(row) = Row::read(connection, id)? else { return Ok(None) };
        // The store holds the statute where it holds its text, in the language asked for or the other, and citation.
        let actual = if row.holds(&format!("unofficial_text_{}", language.code()))? { language }
            else if row.holds(&format!("unofficial_text_{}", language.other().code()))? { language.other() }
            else { return Ok(None) };
        let Some(metadata) = row.metadata(actual)? else { return Ok(None) };
        let text = row.sections(actual)?.and_then(|sections| sections.into_iter().find(|(key, _)| key == section))
            .map(|(_, text)| text).unwrap_or_default();
        if js_trim(section).is_empty() || js_trim(&text).is_empty() {
            return Ok(Some(None));
        }
        let key = (path.to_owned(), stamp, serde_json::to_string(&(id, language.code(), section, &excerpt.citation,
            &excerpt.url, &excerpt.alternate_citation, &excerpt.dataset, &excerpt.name)).map_err(|error| error.to_string())?);
        if let Some(found) = derived(&key) {
            return Ok(Some(Some(found.native)));
        }
        let metadata = Metadata { citation: excerpt.citation.clone(), url: excerpt.url, alternate_citation:
            excerpt.alternate_citation, dataset: excerpt.dataset.unwrap_or_default(), name: excerpt.name, ..metadata };
        let native = Arc::new(derive(&metadata, "laws", text.clone(), Some(vec![(section.to_owned(), text)]),
            Some(excerpt.citation.clone()), Some(excerpt.citation))?);
        keep(key, &Found { metadata, native: native.clone(), search: None });
        Ok(Some(Some(native)))
    })?.flatten())
}

#[derive(Serialize)]
pub struct AliasGroup {
    keys: Vec<String>,
    forms: Vec<String>,
    ambiguous: bool,
}

/// A citation's keys for a note-up: every key of the one decision the store holds under it, else its own key.
pub fn alias_keys(path: &Path, citation: &str) -> CoreResult<Vec<String>> {
    let key = legal_structure::caselaw_citation_lookup_key(citation).map_err(str::to_owned)?;
    Ok(match alias_groups(path, &[citation.to_owned()])?.into_iter().next() {
        Some(group) if !group.ambiguous && !group.keys.is_empty() => group.keys,
        _ => vec![key],
    })
}

/// Each citation's exact aliases and authored forms in the store's inventory; its own key alone where no store is
/// installed.
pub fn alias_groups(path: &Path, citations: &[String]) -> CoreResult<Vec<AliasGroup>> {
    let found = with_store(path, |connection, _| {
        let mut targets = connection.prepare_cached("SELECT DISTINCT document_id FROM citation_lookup WHERE citation_key = ?")
            .map_err(sql)?;
        let mut aliases = connection.prepare_cached("SELECT citation_key FROM citation_lookup WHERE document_id = ?")
            .map_err(sql)?;
        let mut forms = connection.prepare_cached(
            "SELECT citation_en, citation2_en, citation_fr, citation2_fr FROM document WHERE id = ?").map_err(sql)?;
        let text = |value: ValueRef| match value {
            ValueRef::Text(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            _ => None,
        };
        citations.iter().map(|citation| {
            let key = citation_lookup_key(citation);
            if key.is_empty() {
                return Ok(AliasGroup { keys: Vec::new(), forms: Vec::new(), ambiguous: false });
            }
            let ids = targets.query_map([&key], |row| row.get::<_, i64>(0)).map_err(sql)?
                .collect::<Result<Vec<_>, _>>().map_err(sql)?;
            if ids.len() != 1 {
                return Ok(AliasGroup { keys: vec![key], forms: Vec::new(), ambiguous: ids.len() > 1 });
            }
            let mut keys = aliases.query_map([ids[0]], |row| row.get_ref(0).map(|value| text(value).unwrap_or_default()))
                .map_err(sql)?.collect::<Result<Vec<_>, _>>().map_err(sql)?;
            keys.push(key);
            // In JavaScript's order: by UTF-16 code units.
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            keys.dedup();
            let forms = match forms.query_row([ids[0]], |row| (0..4).map(|index| row.get_ref(index).map(text))
                .collect::<Result<Vec<_>, _>>()) {
                Ok(forms) => forms.into_iter().flatten().filter(|form| !js_trim(form).is_empty()).collect(),
                Err(rusqlite::Error::QueryReturnedNoRows) => Vec::new(),
                Err(error) => return Err(sql(error)),
            };
            Ok(AliasGroup { keys, forms, ambiguous: false })
        }).collect()
    })?;
    Ok(found.unwrap_or_else(|| citations.iter().map(|citation| {
        let key = citation_lookup_key(citation);
        AliasGroup { keys: if key.is_empty() { Vec::new() } else { vec![key] }, forms: Vec::new(), ambiguous: false }
    }).collect()))
}
