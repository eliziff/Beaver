//! One row per part of every note, as the note splitter gives them at the draft's tier: prose, books, reports and web
//! pages as well as citations. A reference stands for the authority its import resolved it to (the association Sources
//! and the quotation check read, and a user's relinking changes): its origin is the part that last cites that authority
//! in full before it, and its link is that origin's, reanchored to the reference's own pinpoint. With a model (an AI
//! run mode), the notes it reads take its parts and fields, each placed on the note's text, and a supra the import left
//! unresolved takes the earlier part the model names.

use crate::{
    sheet, CitedSource, Choice, Draft, Earlier, Host, IndexedCase, ModelNote, ModelNotePart,
    Question, QuoteCheck, Read, Request, Source, Written,
};
use legal_structure_features::{BriefAuthority as Authority, BriefOccurrence as Occurrence};
use legal_structure::citations::short_forms::{reanchor_reference, reference_info, supra_hint, ReferenceInfo};
use legal_structure::citations::source::{fragment_locator, FragmentLocator, SourceFields};
use legal_structure::citations::url::{
    canlii_pages, canlii_pdf_page, canlii_pinpoint_url, decision_canlii_page, legislation_canlii_page, passage_anchor, same_page,
    without_text_fragment,
};
use legal_structure::{trim_javascript_whitespace as js_trim, utf16_len, NodeKind};
use legal_structure_features::{
    cited_passage_link, footnote_propositions, host_source_url, quoted_as_written, QuoteContext, SourceLocator,
};
use serde::Serialize;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};

/// A row of sheet FootnoteReferences, its columns named as the Python app names them.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrRow", optional_fields))]
pub struct Row {
    pub footnote_id: usize,
    pub footnote_internal_id: usize,
    pub footnote_display_id: String,
    pub footnote_full: String,
    pub proposition_text: String,
    pub citation_part_index: usize,
    pub citation_part_kind: String,
    pub citation_part_text: String,
    pub citation_part_corrected: String,
    pub citation_part_link: String,
    /// Said where the citation names a different case than the one the brief names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citation_part_warning: Option<String>,
    pub citation_part_anchor_text: String,
    pub short_form: String,
    pub bare_citation: String,
    pub citation_with_style: String,
    pub pinpoint_fragments: String,
    pub page_pinpoints: String,
    pub first_page: String,
    pub has_quotes: &'static str,
    pub quote_count: usize,
    pub quotes_list_json: String,
    /// The note's quotations, by their ids in the quote check.
    pub _quote_ids: Vec<String>,
    #[serde(flatten)]
    pub checked: Checked,
    pub journal_match_info: &'static str,
    pub ref_kind: String,
    pub ref_target_footnote_id: String,
    #[cfg_attr(feature = "binding-types", ts(type = "number | \"\""))]
    pub ref_target_citation_part_index: Value,
    pub ref_target_citation_part_text: String,
    pub ref_target_footnote_full: String,
    pub ref_chain_origin_footnote_id: String,
    #[cfg_attr(feature = "binding-types", ts(type = "number | \"\""))]
    pub ref_chain_origin_citation_part_index: Value,
    pub ref_chain_origin_citation_part_text: String,
    pub ref_resolution_notes: String,
    pub ref_chain_path: String,
    /// The note's quotations as written, trimmed.
    #[serde(skip)]
    pub quotes: Vec<String>,
}

/// A part's quotation results, in the Python app's statuses.
#[derive(Serialize, Default)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS), ts(rename = "AlrChecked", optional_fields))]
pub struct Checked {
    pub quote_check_status: String,
    pub quote_corrected_citation: String,
    pub quote_check_notes: String,
    pub quote_match_pinpoint: String,
    pub quote_match_link: String,
    pub matched_source: String,
    pub matched_source_fragment: String,
    pub alternate_matched_source_fragment: String,
    /// Where a quotation the cited passage holds in part is found word for word, and the quotation as written there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _alternate_quote_check_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _alternate_quote_corrected_citation: Option<String>,
}

pub(crate) async fn written<D: Source + Send>(request: Request, host: Host<D>) -> Result<Written, String> {
    let rows = rows(&request, &host).await;
    sheet::written(&request, rows)
}

fn usable(link: &str) -> bool {
    let link = js_trim(link).as_bytes();
    let scheme = if link.len() >= 8 && link[..8].eq_ignore_ascii_case(b"https://") { 8 }
        else if link.len() >= 7 && link[..7].eq_ignore_ascii_case(b"http://") { 7 } else { return false };
    link.get(scheme).is_some_and(|&byte| byte != b'/' && !(byte as char).is_whitespace())
}

/// A web address written without its scheme ("www.example.org/x"), with it.
fn with_scheme(link: &str) -> String {
    static BARE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(||
        regex::Regex::new(r"(?i)^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]|$)").unwrap());
    if BARE.is_match(link) { format!("https://{link}") } else { link.to_owned() }
}

/// The UTF-16 units `start..end` of `text`, as JavaScript's slice takes them.
pub(crate) fn slice(text: &str, start: usize, end: usize) -> String {
    let units = text.encode_utf16().collect::<Vec<_>>();
    let end = end.min(units.len());
    String::from_utf16_lossy(&units[start.min(end)..end])
}

/// A list as Python's json.dumps writes it.
fn python_json(values: impl IntoIterator<Item = Value>, ascii: bool) -> String {
    let text = format!("[{}]", values.into_iter().map(|value| value.to_string()).collect::<Vec<_>>().join(", "));
    if !ascii { return text; }
    text.encode_utf16().map(|unit| if unit < 0x80 { char::from(unit as u8).to_string() } else { format!("\\u{unit:04x}") }).collect()
}

/// A decimal as JavaScript's Number reads it, written as JSON writes it: null where it is no number.
fn js_number(text: &str) -> Value {
    let text = js_trim(text);
    let value = if text.is_empty() { 0.0 } else { text.parse::<f64>().unwrap_or(f64::NAN) };
    if !value.is_finite() { return Value::Null; }
    serde_json::from_str(ryu_js::Buffer::new().format(value)).unwrap_or(Value::Null)
}

/// Footnote numbers from "1-5, 9, 12-14"; None means every note.
fn footnote_filter(text: &str) -> Option<BTreeSet<i64>> {
    let read = |value: &str| { let value = js_trim(value); if value.is_empty() { Some(0.0) } else { value.parse::<f64>().ok() } }
        .filter(|value| value.fract() == 0.0);
    let mut ids = BTreeSet::new();
    for part in text.split(',').map(js_trim).filter(|part| !part.is_empty()) {
        let mut pieces = part.split('-');
        let (a, b) = match (pieces.next(), pieces.next()) { (Some(a), Some(b)) => (read(a), read(b)), _ => (read(part), read(part)) };
        if let (Some(a), Some(b)) = (a, b) { ids.extend(a.min(b) as i64..=a.max(b) as i64); }
    }
    (!ids.is_empty()).then_some(ids)
}

/// Up to `limit` locations, then how many more.
pub(crate) fn pinpoint_summary(pinpoints: impl IntoIterator<Item = String>, limit: usize) -> String {
    let values = pinpoints.into_iter().map(|value| js_trim(&value).to_owned()).filter(|value| !value.is_empty()).collect::<Vec<_>>();
    let more = values.len().saturating_sub(limit);
    values.iter().take(limit).cloned().collect::<Vec<_>>().join(", ")
        + &if more > 0 { format!(" [+{more} more instances]") } else { String::new() }
}

/// Each once, in order.
fn distinct(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values { if !seen.contains(&value) { seen.push(value); } }
    seen
}

const LEGISLATION: [&str; 3] = ["statute", "regulation", "gazette"];

/// A note of the draft, where it starts in the article as the citation engine read it (its units joined by a blank
/// line).
struct Range { unit: usize, start: usize }

/// A part of a note, placed in the article and in its note.
struct Part { start: usize, end: usize, text: String, range: usize, local: usize }

/// Where a part's link is made: here, or from the host's private CanLII index (`case`), else `fallback`.
enum Plan { Made(String), Asked { case: IndexedCase, fallback: String } }

/// A part's quotation check, with the quotation as written and as the article sets it.
struct Quoted { check: QuoteCheck, quote: String, raw: String }

struct Reader<'a> {
    draft: &'a Draft,
    canlii_index: bool,
    journals: Option<&'a legal_structure_features::journal_store::JournalStores>,
    ranges: Vec<Range>,
    unit_start: HashMap<&'a str, usize>,
}

impl<'a> Reader<'a> {
    fn note(&self, range: usize) -> &'a legal_structure_model::AuthorityTextUnit { &self.draft.units[self.ranges[range].unit].unit }
    fn note_number(&self, range: usize) -> usize {
        let note = self.note(range);
        note.note_number.map_or(note.footnote_id.unwrap_or_default(), |number| number as usize)
    }
    fn at(&self, item: &Occurrence) -> Option<usize> { self.unit_start.get(item.unit_id.as_str()).map(|start| start + item.start) }

    /// The citations Authorities found in a part: those starting in it.
    fn part_occurrences<'p>(&'p self, part: &'p Part) -> impl Iterator<Item = &'a Occurrence> + 'p {
        let unit = &self.draft.units[self.ranges[part.range].unit];
        let length = part.end - part.start;
        unit.occurrence_ids.iter().filter_map(|id| self.draft.occurrences.get(id))
            .filter(move |item| item.start >= part.local && item.start < part.local + length)
    }

    /// The authority Authorities found in a part: the one an occurrence starting in it names.
    fn part_authority(&self, part: &Part) -> Option<&'a Authority> {
        self.part_occurrences(part).filter_map(|item| item.authority_id.as_ref()).find_map(|id| self.draft.authorities.get(id))
    }

    /// A part's link: the author's own; else its source's page: CanLII for a Canadian decision or statute A2AJ
    /// identifies or its citation names, an article's PDF at its cited page, another provider's page. Its paragraph or
    /// section anchor is added after, as the Python app adds it.
    fn part_link(&self, part: &Part, field: &SourceFields) -> Plan {
        let address = with_scheme(js_trim(&field.link_candidate));
        if usable(&address) { return Plan::Made(address); }
        let authority = self.part_authority(part);
        let identity = authority.and_then(|authority| authority.source_identity.as_ref());
        if let Some(identity) = identity.filter(|identity| identity.provider == "journal") {
            let external = identity.external_url.clone().unwrap_or_default();
            let page = field.page_pinpoints.first().zip(self.journals).and_then(|(page, stores)|
                legal_structure_features::journal_store::page_link(stores, &identity.stable_source_id, page).ok().flatten());
            return Plan::Made(page.unwrap_or(external));
        }
        if let (Some(authority), Some(identity)) = (authority, identity.filter(|identity| identity.provider == "a2aj")) {
            let mut id = identity.stable_source_id.split(':').skip(1);
            let language = if id.next() == Some("fr") { "fr" } else { "en" };
            // A statute A2AJ holds is at its consolidation as the record's own citation names it (the record's page,
            // `canlii_url`): the brief's citation carries its pinpoint and short name after the chapter.
            let canlii = if authority.kind == "legislation" { identity.canlii_url.clone() } else {
                decision_canlii_page(&authority.canlii, language, id.next()).or_else(|| identity.canlii_url.clone())
            };
            if let Some(canlii) = canlii { return Plan::Made(canlii); }
        }
        let statute = LEGISLATION.contains(&field.kind.as_str());
        // The pages the import read off the authority's citations; a part citing no authority of the draft (a bill, a
        // statute only a reference names) is read for its own written citation's.
        let cited = if field.citation_with_style.is_empty() { &field.bare_citation } else { &field.citation_with_style };
        let read;
        let pages = match authority.filter(|authority| !authority.canlii.is_empty()) {
            Some(authority) => &authority.canlii[..],
            None => { read = canlii_pages(cited); &read[..] }
        };
        let written = if statute { legislation_canlii_page(pages, "en", false) } else { decision_canlii_page(pages, "en", None) };
        if let Some(written) = written { return Plan::Made(written); }
        // Another provider's page, as every legal link is written (a court website's with the parameters its viewer
        // needs).
        let page = authority.and_then(authority_source_url).and_then(|page| host_source_url(page, None)).unwrap_or_default();
        // A decision's page from a supplied private CanLII index, where the host has one, before another provider's
        // page: a Supreme Court decision goes on CanLII rather than the Court's own site.
        if self.canlii_index && !statute {
            if let Some(case) = indexed_case(cited, field.pinpoint_fragments.first()) { return Plan::Asked { case, fallback: page }; }
        }
        Plan::Made(page)
    }
}

/// The decision a part's citation names, as the host's CanLII index finds it: its first full citation with a year and a
/// style of cause, and of its citations the Supreme Court Reports one, whose page is the report's PDF where no
/// paragraph is pinpointed.
fn indexed_case(text: &str, pinpoint: Option<&String>) -> Option<IndexedCase> {
    use legal_structure::citations::{Citation, Form, Format, PinpointKind};
    let cites = legal_structure::read_citations(text);
    let court = |cite: &Citation| cite.court.as_ref().map(|court| court.text.chars().filter(|c| !c.is_whitespace() && *c != '.').collect::<String>().to_uppercase());
    let full = cites.iter().filter(|cite| cite.form == Form::Full && cite.fields.year.is_some() && cite.style.as_ref().is_some_and(|style| !style.text.is_empty()))
        .collect::<Vec<_>>();
    let cite = full.first()?;
    let paragraph = pinpoint.is_some_and(|pinpoint| pinpoint.starts_with("par"));
    let report = full.iter().find(|item| court(item).as_deref() == Some("SCR") && item.fields.page.is_some())
        .filter(|scr| !paragraph && !scr.pinpoints.iter().any(|pin| pin.kind == PinpointKind::Paragraph))
        .map(|scr| (scr.fields.page.clone().unwrap_or_default(), scr.pinpoints.iter().find(|pin| pin.kind == PinpointKind::Page).map(|pin| pin.first.clone())));
    Some(IndexedCase { year: cite.fields.year.clone()?, style: cite.style.as_ref()?.text.clone(), court: court(cite),
        number: cite.fields.number.clone().filter(|_| cite.format == Some(Format::CanLii)), jurisdiction: cite.jurisdiction.clone(),
        report, pinpoint: pinpoint.cloned() })
}

/// The page an authority's source is at, as Authorities records it (authorities-sources.mjs authoritySourceUrl).
fn authority_source_url(authority: &Authority) -> Option<&str> {
    let external = || authority.source_identity.as_ref().and_then(|identity| identity.external_url.as_deref())
        .or(authority.source_url.as_deref());
    match authority.source.kind.as_str() {
        "attached" => authority.source.sources.iter().find_map(|source| source.source_url.as_deref()).or_else(external),
        "pending-canlii" => authority.source.page_url.as_deref(),
        _ => external(),
    }
}

/// Each part's link made, the decisions only the host's index finds asked for at once.
async fn links<D>(host: &Host<D>, plans: Vec<Plan>) -> Vec<String> {
    let cases = plans.iter().filter_map(|plan| match plan { Plan::Asked { case, .. } => Some(case.clone()), _ => None })
        .collect::<Vec<_>>();
    let mut answers = if cases.is_empty() { Vec::new() } else { host.ask(Question::Links { cases }).await.links }.into_iter();
    plans.into_iter().map(|plan| match plan {
        Plan::Made(link) => link,
        Plan::Asked { fallback, .. } => answers.next().flatten().unwrap_or(fallback),
    }).collect()
}

async fn rows<D: Source>(request: &Request, host: &Host<D>) -> Vec<Row> {
    let (draft, options) = (&request.draft, &request.options);
    let units = draft.units.iter().map(|unit| unit.unit.clone()).collect::<Vec<_>>();
    let propositions = footnote_propositions(&units, options.quote_context.unwrap_or(QuoteContext::Passage)).propositions
        .into_iter().map(|proposition| (proposition.footnote_id as usize, proposition.text)).collect::<HashMap<_, _>>();
    let proposition = |footnote: Option<usize>| footnote.and_then(|id| propositions.get(&id)).cloned().unwrap_or_default();
    let wanted = footnote_filter(options.footnotes.as_deref().unwrap_or(""));
    // Each unit where it starts in the article as the citation engine read it (its units joined by a blank line).
    let mut next = 0;
    let starts = units.iter().map(|unit| { let start = next; next += utf16_len(&unit.text) + 2; start }).collect::<Vec<_>>();
    let reader = Reader {
        draft, canlii_index: request.canlii_index, journals: request.journals.as_ref(),
        ranges: units.iter().enumerate().filter(|(_, unit)| unit.kind == "footnote" && unit.footnote_id.is_some())
            .map(|(unit, _)| Range { unit, start: starts[unit] }).collect(),
        unit_start: units.iter().zip(&starts).map(|(unit, &start)| (unit.key.as_str(), start)).collect(),
    };
    let ranges = &reader.ranges;
    // The notes' parts and their fields as the import's citation engine split them, each placed in the article.
    let engine = ranges.iter().enumerate().flat_map(|(range, placed)| draft.units[placed.unit].parts.iter().flatten().map(move |part| (Part {
        start: placed.start + part.source.start, end: placed.start + part.source.end, text: part.source.text.clone(), range,
        local: part.source.start }, part)))
        .collect::<Vec<_>>();
    let engine_kinds = engine.iter().map(|(part, _)| reference_info(&part.text)).collect::<Vec<_>>();
    // A full part's link: the author's own, else the source's page (CanLII for Canadian law).
    let engine_links = links(host, engine.iter().zip(&engine_kinds).map(|((part, note), kind)| if kind.kind.is_empty() {
        reader.part_link(part, &note.source.fields) } else { Plan::Made(String::new()) }).collect()).await;
    // The notes the model reads take its parts, in place of the engine's.
    let mut model = HashMap::new();
    if request.model {
        let notes = ranges.iter().enumerate().map(|(index, placed)| ModelNote { index, number: reader.note_number(index) as u32,
            text: units[placed.unit].text.clone(), parts: engine.iter().enumerate().filter(|(_, (part, _))| part.range == index)
                .map(|(at, (part, note))| ModelNotePart { text: part.text.clone(), reference: engine_kinds[at].kind.to_owned(),
                    link: engine_links[at].clone(), kind: note.source.fields.kind.clone() }).collect() }).collect();
        model = host.ask(Question::Split { notes }).await.parts.into_iter().collect::<HashMap<_, _>>();
    }
    // Each row's part, and the engine's part it is (none for a model's).
    let mut parts = Vec::new();
    let mut fields = Vec::new();
    let mut from = Vec::new();
    for (index, placed) in ranges.iter().enumerate() {
        let note = &units[placed.unit];
        if let Some(read) = model.get(&index) {
            for part in read {
                let text = slice(&note.text, part.start, part.end);
                // The author's own link stays with the part that holds it.
                let link = engine.iter().filter(|(engine, _)| engine.range == index).map(|(_, note)| &note.source.fields.link_candidate)
                    .find(|link| usable(link) && text.contains(js_trim(link))).cloned().unwrap_or_default();
                fields.push(SourceFields { status: "model".into(), reasons: Vec::new(), link_candidate: link, ..part.fields.clone() });
                parts.push(Part { start: placed.start + part.start, end: placed.start + part.end, text, range: index, local: part.start });
                from.push(None);
            }
        } else {
            for (at, (part, note)) in engine.iter().enumerate().filter(|(_, (part, _))| part.range == index) {
                fields.push(note.source.fields.clone());
                parts.push(Part { start: part.start, end: part.end, text: part.text.clone(), range: index, local: part.local });
                from.push(Some(at));
            }
        }
    }
    let kinds = from.iter().zip(&parts).map(|(at, part)| match at {
        Some(at) => ReferenceInfo { kind: engine_kinds[*at].kind, notes: engine_kinds[*at].notes.clone(), normalized: String::new() },
        None => reference_info(&part.text),
    }).collect::<Vec<_>>();
    let mut part_links = Vec::new();
    let mut plans = Vec::new();
    for (index, at) in from.iter().enumerate() {
        match at {
            Some(at) => part_links.push(Some(engine_links[*at].clone())),
            None => {
                part_links.push(None);
                plans.push(if kinds[index].kind.is_empty() { reader.part_link(&parts[index], &fields[index]) } else { Plan::Made(String::new()) });
            }
        }
    }
    let mut asked = links(host, plans).await.into_iter();
    let links = part_links.into_iter().map(|link| link.unwrap_or_else(|| asked.next().unwrap_or_default())).collect::<Vec<_>>();
    let part_at = |offset: usize| parts.iter().position(|part| part.start <= offset && offset < part.end);
    // The draft's citations where they stand in the article.
    let mut occurrences = draft.occurrences.values().filter_map(|item| reader.at(item).map(|at| (at, item))).collect::<Vec<_>>();
    occurrences.sort_by_key(|(at, _)| *at);
    // Each part's reference: the first it holds that stands for an authority.
    let reference = parts.iter().map(|part| occurrences.iter().find(|(at, item)| item.kind == "reference" && item.authority_id.is_some()
        && part.start <= *at && *at < part.end).map(|(at, item)| (*at, *item))).collect::<Vec<_>>();
    // The part holding a citation the import stored for a reference, where it still cites the reference's authority.
    let stored = |item: &Occurrence, id: Option<&String>| id.and_then(|id| draft.occurrences.get(id))
        .filter(|cites| cites.authority_id == item.authority_id).and_then(|cites| reader.at(cites)).and_then(part_at);
    // A reference's origin, the part its import's resolution ends at; for one the user linked, the part that last cites
    // its authority in full before it (else first does).
    let mut origin = reference.iter().map(|found| {
        let (at, item) = (*found)?;
        if let Some(resolved) = stored(item, item.reference.as_ref().and_then(|reference| reference.origin_id.as_ref())) {
            return Some(resolved);
        }
        let full = occurrences.iter().filter(|(_, other)| other.authority_id == item.authority_id && other.kind != "reference")
            .collect::<Vec<_>>();
        let cites = full.iter().filter(|(other, _)| *other < at).last().or(full.first())?;
        part_at(cites.0)
    }).collect::<Vec<_>>();
    // The part a reference names directly, else its origin.
    let mut target = reference.iter().zip(&origin).map(|(found, origin)| found.and_then(|(_, item)|
        stored(item, item.reference.as_ref().and_then(|reference| reference.named_id.as_ref()))).or(*origin)).collect::<Vec<_>>();
    // The link an editor gave the part's citation, or one carried to it from another citation of the same authority
    // (Beaver's set-occurrence-links), where the author gave none: kept as written, a reference's included.
    let editor = parts.iter().zip(&fields).map(|(part, field)| if usable(&field.link_candidate) { String::new() } else {
        reader.part_occurrences(part).filter_map(|item| item.link.clone()).find(|link| usable(link)).unwrap_or_default()
    }).collect::<Vec<_>>();
    // The author's hyperlinks in a note, each on the first part it covers: the part's own link, kept as written and
    // carried to its references as a link the author wrote out is; an editor's link, given since, comes first.
    let mut author = vec![String::new(); parts.len()];
    for (index, placed) in ranges.iter().enumerate() {
        for (start, end, url) in &units[placed.unit].links {
            let at = parts.iter().position(|part| part.range == index && part.local.max(*start) < (part.local + utf16_len(&part.text)).min(*end));
            if let Some(at) = at.filter(|&at| author[at].is_empty()) { author[at] = url.clone(); }
        }
    }
    // A full part's link at its first paragraph or section pinpoint, as the Python app anchors a CanLII link; the
    // author's own link stays as written.
    let anchored = links.iter().enumerate().map(|(index, link)| if !link.is_empty() && kinds[index].kind.is_empty()
        && !usable(&fields[index].link_candidate) { canlii_pinpoint_url(link, &fields[index].pinpoint_fragments) } else { link.clone() })
        .collect::<Vec<_>>();
    // A part's paragraph and section pinpoints, each the citation engine's fragment ("par12", "sec6(1)(c)") with the
    // passage the engine reads it as naming.
    let pinpoints = fields.iter().map(|field| field.pinpoint_fragments.iter()
        .filter_map(|fragment| fragment_locator(fragment).map(|locator| (fragment.clone(), locator))).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let mut chain = Chain { kinds: &kinds, parts: &parts, editor: &editor, author: &author, anchored: &anchored, pinpoints: &pinpoints,
        origin: origin.clone(), target: target.clone(), linked: RefCell::new(HashMap::new()) };
    if request.model {
        // A supra the import left unresolved: the model chooses among the earlier notes' parts, as resolved so far.
        let open = (0..parts.len()).filter(|&index| kinds[index].kind == "supra" && origin[index].is_none()).collect::<Vec<_>>();
        let offered = open.iter().map(|&index| {
            let first = parts.iter().position(|part| part.range == parts[index].range).unwrap_or(0);
            (0..first).filter(|&at| kinds[at].kind.is_empty() || origin[at].is_some()).map(|at| (at, Earlier {
                note: reader.note_number(parts[at].range).to_string(), short_form: fields[at].short_form.clone(),
                text: parts[at].text.clone(), link: chain.link_of(at, 0) })).collect::<Vec<_>>()
        }).collect::<Vec<_>>();
        if !open.is_empty() {
            let references = open.iter().zip(&offered).map(|(&index, offered)| Choice { text: parts[index].text.clone(),
                earlier: offered.iter().map(|(_, earlier)| earlier.clone()).collect(),
                proposition: proposition(reader.note(parts[index].range).footnote_id) }).collect();
            let chosen = host.ask(Question::Choose { references }).await.chosen;
            for ((&index, offered), chosen) in open.iter().zip(&offered).zip(chosen) {
                if let Some((at, _)) = chosen.and_then(|chosen| offered.get(chosen)) {
                    origin[index] = Some(*at);
                    target[index] = Some(*at);
                }
            }
        }
        chain = Chain { origin: origin.clone(), target: target.clone(), linked: RefCell::new(HashMap::new()), ..chain };
    }
    let mut quotes_of = HashMap::<&str, Vec<&crate::Quote>>::new();
    let mut checked_on = HashMap::<usize, Vec<Quoted>>::new();
    for quote in &request.check.quotes {
        if let Some(candidate) = quote.candidates.first() { quotes_of.entry(candidate.unit_id.as_str()).or_default().push(quote); }
        // Each citation part's row carries the quotation's check against that part's own source.
        for check in &quote.checks {
            let candidate = quote.candidates.iter().find(|candidate| Some(&candidate.id) == check.candidate_id.as_ref());
            let at = candidate.and_then(|candidate| ranges.iter().find(|placed| units[placed.unit].key == candidate.unit_id)
                .and_then(|placed| part_at(placed.start + candidate.start)));
            if let Some(at) = at {
                checked_on.entry(at).or_default().push(Quoted { check: check.clone(), quote: quote.quote.clone(),
                    raw: slice(&quote.context, quote.start.saturating_sub(1), quote.end + 1) });
            }
        }
    }
    // The source a part cites, read where its link names a paragraph or provision or it pinpoints one (a reference reads
    // the authority it stands for): the passage gives the link its text fragment, and the row its anchor text.
    let cited = |index: usize| -> Option<CitedSource> {
        let (mut index, mut depth) = (index, 0);
        loop {
            // A reference reads the authority it stands for; one a model chose for, its origin's.
            let stands = reference[index].and_then(|(_, item)| item.authority_id.as_ref()).and_then(|id| draft.authorities.get(id));
            if !kinds[index].kind.is_empty() {
                if let Some(authority) = stands { return Some(of(authority)); }
                match origin[index].filter(|&origin| origin != index && depth < 50) {
                    Some(origin) => { index = origin; depth += 1; continue; }
                    None => return None,
                }
            }
            if let Some(authority) = reader.part_authority(&parts[index]) { return Some(of(authority)); }
            let field = &fields[index];
            let kind = if field.kind == "case" { "case" } else if LEGISLATION.contains(&field.kind.as_str()) { "legislation" } else { return None };
            let citation = if field.citation_with_style.is_empty() { &field.bare_citation } else { &field.citation_with_style };
            return Some(CitedSource { authority_id: None, kind: kind.into(), citation: citation.clone() });
        }
    };
    // The quotation found in a decision's or statute's A2AJ text, linked where the quote check routed it.
    let a2aj_found = |index: usize| checked_on.get(&index).is_some_and(|quotes| quotes.iter().any(|quote| quote.check.receipt.as_ref()
        .is_some_and(|receipt| receipt.link.as_deref().is_some_and(|link| !link.is_empty()) && receipt.location.location != "unmatched"
            && receipt.source.provider == "a2aj")));
    let sources = (0..parts.len()).map(|index| (passage_anchor(&chain.link_of(index, 0)).is_some()
        || !chain.pinpointed(index).is_empty() || a2aj_found(index)).then(|| cited(index)).flatten()).collect::<Vec<_>>();
    let read: Vec<Option<Read<D>>> = if sources.iter().all(Option::is_none) { (0..parts.len()).map(|_| None).collect() } else {
        let mut reads = host.ask(Question::Read { sources }).await.reads;
        reads.resize_with(parts.len(), || None);
        reads
    };
    let document = |index: usize| read[index].as_ref().map(|read| &read.document);
    // The text of the passage a locator names in the source a part cites, read once for the parts that cite it.
    let texts = RefCell::new(HashMap::<(usize, &'static str, String), String>::new());
    let passage_text = |index: usize, locator: &FragmentLocator| -> String {
        let Some(document) = document(index) else { return String::new() };
        let key = (document.key(), locator.kind, locator.label.clone());
        if let Some(text) = texts.borrow().get(&key) { return text.clone(); }
        let kind = if locator.kind == "section" { NodeKind::Section } else { NodeKind::Paragraph };
        let text = document.query().read_range(document.structure(), kind, &locator.label, &locator.label, 0)
            .and_then(|range| range.selected.into_iter().next()).map(|passage| js_trim(&passage.text).to_owned()).unwrap_or_default();
        texts.borrow_mut().insert(key, text.clone());
        text
    };
    // A passage of an A2AJ source is linked where the engine routes it best: the publisher's page where it prints an
    // anchor for the passage, else CanLII's. Cited without a quotation, it is linked at the citation's pinpoints.
    let routed = |index: usize, locator: Option<&FragmentLocator>, block_text: String, pinpoints: &[String]| -> Option<String> {
        let found = read[index].as_ref()?;
        if block_text.is_empty() && pinpoints.is_empty() { return None; }
        found.source.as_ref()?.routed_link(found.document.query(), found.document.structure(), found.document.canlii(),
            locator.map(|locator| SourceLocator { kind: locator.kind.into(), label: locator.label.clone() }),
            block_text, Vec::new(), pinpoints.to_vec())
    };
    // A link this app makes: its anchor given its passage's text fragment where the passage can be read, then as the
    // text fragments option keeps it. The author's and the editor's own links stay as written.
    let own = |index: usize| !editor[index].is_empty() || !author[index].is_empty()
        || (kinds[index].kind.is_empty() && usable(&fields[index].link_candidate));
    let fragments = options.text_fragments.as_deref().unwrap_or("all");
    let keeps_fragment = |index: usize| own(index) || fragments == "all" || (fragments == "pinpointless" && chain.pinpointed(index).is_empty());
    // A passage's link at the part the citation pinpoints (a reference without a pinpoint of its own, that of the part
    // it takes its link from, as its anchor text shows), made once for the parts that cite it.
    let made = RefCell::new(HashMap::<(Option<usize>, String, Vec<String>), String>::new());
    let passage_link = |link: &str, index: usize| -> String {
        let at = chain.pinpointed_at(index, 0);
        let pinpoints = chain.pinpointed(at);
        let key = (document(index).map(|document| document.key()), link.to_owned(), pinpoints.clone());
        if let Some(link) = made.borrow().get(&key) { return link.clone(); }
        let first = chain.pinpoints[at].first().map(|(_, locator)| locator);
        let linked = match first.filter(|_| read[index].as_ref().is_some_and(|read| read.source.is_some())) {
            // At the link's own anchor ("sec6subsec1" for "s 6(1)(c)"), else the pinpoint's.
            Some(first) => {
                let anchor = passage_anchor(link).map(|anchor| fragment_locator(&anchor));
                let locator = match &anchor { Some(locator) => locator.as_ref(), None => Some(first) };
                routed(index, locator, passage_text(index, first), &pinpoints)
            }
            None => host_source_url(link, None).map(|url| match document(index) {
                Some(document) => cited_passage_link(document.query(), document.structure(), &url, &pinpoints).unwrap_or(url),
                None => url,
            }),
        }.unwrap_or_else(|| link.to_owned());
        made.borrow_mut().insert(key, linked.clone());
        linked
    };
    let part_links = (0..parts.len()).map(|index| {
        let link = canlii_pdf_page(&chain.link_of(index, 0));
        if own(index) { return link; }
        let passage = if passage_anchor(&link).is_some()
            || (read[index].as_ref().is_some_and(|read| read.source.is_some()) && !chain.pinpointed(chain.pinpointed_at(index, 0)).is_empty()) {
            passage_link(&link, index)
        } else { link };
        if keeps_fragment(index) { passage } else { without_text_fragment(&passage) }
    }).collect::<Vec<_>>();
    let passages = (0..parts.len()).map(|index| pinpoints[index].iter().map(|(_, locator)| passage_text(index, locator))
        .filter(|text| !text.is_empty()).collect::<Vec<_>>().join(" ")).collect::<Vec<_>>();
    let index_in_note = parts.iter().map(|part| parts.iter().filter(|other| other.range == part.range && other.start < part.start).count())
        .collect::<Vec<_>>();
    let parts_of = |range: usize| parts.iter().filter(|part| part.range == range).count();
    // A reference's chain, hop by hop, and the Python app's notes on it.
    let hop = |index: usize| if kinds[index].kind != "supra" { kinds[index].kind.to_uppercase() } else {
        let target = target[index].unwrap_or(index);
        format!("SUPRA→{}:{}", reader.note_number(parts[target].range), index_in_note[target] + 1)
    };
    let chain_path = |index: usize| {
        let (mut hops, mut index, mut depth) = (Vec::new(), index, 0);
        while let Some(next) = target[index].filter(|&next| !kinds[index].kind.is_empty() && next != index) {
            hops.push(hop(index));
            if kinds[next].kind.is_empty() || depth >= 50 { break; }
            index = next;
            depth += 1;
        }
        hops.join(" → ")
    };
    let resolution_notes = |index: usize| {
        let kind = kinds[index].kind;
        let previous = index.checked_sub(1).map(|previous| &parts[previous]);
        let mut notes = Vec::new();
        // An ibid after a note of several parts, whichever it names.
        if kind == "ibid" && previous.is_some_and(|previous| previous.range != parts[index].range && parts_of(previous.range) > 1) {
            notes.push("Previous footnote has multiple references; style guidance prefers supra over ibid in this situation.".to_owned());
        }
        if kind == "ibid" && previous.is_none() { notes.push("Ibid appears as the first reference; no preceding reference exists.".to_owned()); }
        let named = kinds[index].notes.first();
        if let Some(named) = named.filter(|_| kind == "supra" && origin[index].is_none()) {
            let note = (0..ranges.len()).find(|&range| reader.note(range).note_number.is_some_and(|number| number.to_string() == *named));
            notes.push(match note {
                None => format!("Supra target footnote (note {named}) not found in this DOCX."),
                Some(note) if parts_of(note) > 1 => "Supra target footnote has multiple references; could not infer intended citation-part.".to_owned(),
                Some(_) => String::new(),
            });
        }
        notes.into_iter().filter(|note| !note.is_empty()).collect::<Vec<_>>().join(" ")
    };
    // A full part's first page: its first citation's, as a reporter or journal gives it and the import read it; a model's
    // part takes that of the first of the import's parts it overlaps that gives one.
    let first_page = |index: usize| -> String {
        if !kinds[index].kind.is_empty() { return String::new(); }
        let page = match from[index] {
            Some(at) => engine[at].1.first_page.clone(),
            None => engine.iter().find(|(part, note)| part.range == parts[index].range && part.start < parts[index].end
                && parts[index].start < part.end && note.first_page.as_deref().is_some_and(|page| !page.is_empty()))
                .and_then(|(_, note)| note.first_page.clone()),
        };
        page.unwrap_or_default()
    };
    let quoted = |text: &str, quote: &Quoted| quoted_as_written(text, &quote.raw);
    let none = Vec::new();
    parts.iter().enumerate().filter_map(|(index, part)| {
        let note = reader.note(part.range);
        let number = reader.note_number(part.range);
        if wanted.as_ref().is_some_and(|wanted| !wanted.contains(&(number as i64))) { return None; }
        let quotes = quotes_of.get(note.key.as_str()).unwrap_or(&none);
        let field = &fields[index];
        let mut checked = quote_fields(checked_on.get(&index).map_or(&[][..], Vec::as_slice), &quoted);
        if !keeps_fragment(index) { checked.quote_match_link = without_text_fragment(&checked.quote_match_link); }
        let reference_kind = !kinds[index].kind.is_empty();
        let tgt = target[index].filter(|_| reference_kind);
        let org = origin[index].filter(|_| reference_kind);
        let authority = reader.part_authority(org.map_or(part, |org| &parts[org]));
        let warning = authority.and_then(|authority| authority.cited_case.as_ref())
            .filter(|mismatch| !draft.discrepancy_decisions.contains_key(&mismatch.id))
            .map(|mismatch| format!("Citation names a different case: {} ({}).", mismatch.name, mismatch.citation));
        let hint = if kinds[index].kind == "supra" { supra_hint(&part.text, true) } else { String::new() };
        let footnote = note.footnote_id.unwrap_or_default();
        let place = |at: Option<usize>| at.map_or(Value::String(String::new()), |at| Value::from(index_in_note[at] + 1));
        let trimmed = quotes.iter().map(|quote| js_trim(&quote.quote).to_owned()).collect::<Vec<_>>();
        Some(Row {
            footnote_id: footnote, footnote_internal_id: footnote,
            footnote_display_id: match (&note.note_number, &note.note_mark) {
                (None, Some(mark)) if !mark.is_empty() => mark.clone(),
                _ => number.to_string(),
            },
            footnote_full: js_trim(&note.text).to_owned(), proposition_text: proposition(note.footnote_id),
            citation_part_index: index_in_note[index] + 1, citation_part_kind: field.kind.clone(), citation_part_text: part.text.clone(),
            citation_part_corrected: field.corrected.clone(), citation_part_link: part_links[index].clone(),
            citation_part_warning: warning,
            // A reference without a pinpoint of its own shows the passage of the part it takes its link from.
            citation_part_anchor_text: passages[chain.pinpointed_at(index, 0)].clone(),
            short_form: field.short_form.clone(), bare_citation: field.bare_citation.clone(),
            citation_with_style: field.citation_with_style.clone(),
            pinpoint_fragments: python_json(field.pinpoint_fragments.iter().map(|fragment| Value::from(fragment.as_str())), true),
            page_pinpoints: python_json(field.page_pinpoints.iter().map(|page| js_number(page)), true), first_page: first_page(index),
            has_quotes: if quotes.is_empty() { "NO" } else { "YES" }, quote_count: quotes.len(),
            quotes_list_json: python_json(trimmed.iter().map(|quote| Value::from(quote.as_str())), false),
            _quote_ids: quotes.iter().map(|quote| quote.id.clone()).collect(), checked, journal_match_info: "",
            ref_kind: kinds[index].kind.to_uppercase(),
            ref_target_footnote_id: tgt.map(|at| reader.note(parts[at].range).footnote_id.unwrap_or_default().to_string()).unwrap_or_default(),
            ref_target_citation_part_index: place(tgt),
            ref_target_citation_part_text: tgt.map(|at| if hint.is_empty() { parts[at].text.clone() } else { format!("{hint}, {}", parts[at].text) })
                .unwrap_or_default(),
            ref_target_footnote_full: tgt.map(|at| js_trim(&reader.note(parts[at].range).text).to_owned()).unwrap_or_default(),
            ref_chain_origin_footnote_id: org.map(|at| reader.note(parts[at].range).footnote_id.unwrap_or_default().to_string()).unwrap_or_default(),
            ref_chain_origin_citation_part_index: place(org),
            ref_chain_origin_citation_part_text: org.map(|at| parts[at].text.clone()).unwrap_or_default(),
            ref_resolution_notes: resolution_notes(index), ref_chain_path: chain_path(index), quotes: trimmed,
        })
    }).collect()
}

fn of(authority: &Authority) -> CitedSource {
    CitedSource { authority_id: Some(authority.id.clone()), kind: authority.kind.clone(), citation: authority.citation.clone() }
}

/// How references take their links: each from the part it stands for, reanchored to its own pinpoint.
struct Chain<'a> {
    kinds: &'a [ReferenceInfo],
    parts: &'a [Part],
    editor: &'a [String],
    author: &'a [String],
    anchored: &'a [String],
    pinpoints: &'a [Vec<(String, FragmentLocator)>],
    origin: Vec<Option<usize>>,
    target: Vec<Option<usize>>,
    linked: RefCell<HashMap<usize, String>>,
}

impl Chain<'_> {
    fn pinpointed(&self, index: usize) -> Vec<String> { self.pinpoints[index].iter().map(|(fragment, _)| fragment.clone()).collect() }
    fn reference(&self, index: usize) -> bool { !self.kinds[index].kind.is_empty() }

    /// A reference's link is its origin's link, at the reference's own pinpoint; an ibid without one takes the link of the
    /// reference it names directly where that opens the same page, keeping its anchor. A reference the import left
    /// unresolved has none. The author's and an editor's own links stay as written.
    fn link_of(&self, index: usize, depth: usize) -> String {
        if let Some(link) = self.linked.borrow().get(&index) { return link.clone(); }
        let own = if self.editor[index].is_empty() { &self.author[index] } else { &self.editor[index] };
        let link = if !own.is_empty() || !self.reference(index) {
            if own.is_empty() { self.anchored[index].clone() } else { own.clone() }
        } else {
            match self.origin[index].filter(|&origin| origin != index && depth < 50) {
                None => String::new(),
                Some(_) => reanchor_reference(&self.link_of(self.linked_from(index, depth), depth + 1), &self.parts[index].text),
            }
        };
        self.linked.borrow_mut().insert(index, link.clone());
        link
    }

    fn linked_from(&self, index: usize, depth: usize) -> usize {
        let origin = self.origin[index].unwrap_or(index);
        match self.target[index] {
            Some(named) if self.kinds[index].kind == "ibid" && self.pinpoints[index].is_empty() && named != origin && named != index
                && depth < 50 && same_page(&self.link_of(named, depth + 1), &self.link_of(origin, depth + 1)) => named,
            _ => origin,
        }
    }

    /// The part whose pinpoint a reference's link opens at, and whose passage it shows: its own, else that of the part it
    /// takes its link from.
    fn pinpointed_at(&self, index: usize, depth: usize) -> usize {
        if !self.pinpoints[index].is_empty() || !self.reference(index) || depth >= 50
            || self.origin[index].is_none_or(|origin| origin == index) { return index; }
        self.pinpointed_at(self.linked_from(index, 0), depth + 1)
    }
}

/// A part's quotation results, in the Python app's statuses.
fn quote_fields(quotes: &[Quoted], quoted: &impl Fn(&str, &Quoted) -> String) -> Checked {
    let supported = |quote: &Quoted| quote.check.status == "verified" && quote.check.receipt.as_ref().is_some_and(|receipt| receipt.comparison.is_some());
    if quotes.is_empty() { return Checked::default(); }
    let found = quotes.iter().filter(|quote| quote.check.receipt.as_ref().is_some_and(|receipt| receipt.location.location != "unmatched"))
        .collect::<Vec<_>>();
    let join = |values: Vec<String>| values.into_iter().filter(|value| !value.is_empty()).collect::<Vec<_>>().join("\n\n");
    if found.is_empty() {
        let read = quotes.iter().any(|quote| quote.check.receipt.is_some());
        let short = quotes.iter().any(|quote| quote.check.receipt.as_ref().is_some_and(|receipt| receipt.location.short_in_long));
        return Checked { quote_check_status: "NO_MATCH".into(),
            quote_corrected_citation: quotes.iter().map(|quote| quoted(&quote.quote, quote)).collect::<Vec<_>>().join("\n\n"),
            quote_check_notes: if !read { "No source text found for this citation." } else if short {
                "Quote too short for full-document fuzzy checking in a long source; exact search found no match." } else {
                "Quote not found in source text." }.into(), ..Checked::default() };
    }
    let receipt = |quote: &Quoted| quote.check.receipt.clone().expect("a found quotation's receipt");
    let matches = found.iter().map(|quote| receipt(quote).location).collect::<Vec<_>>();
    let link = found.iter().filter_map(|quote| receipt(quote).link).find(|link| !link.is_empty()).unwrap_or_default();
    let family = if found.iter().any(|quote| receipt(quote).source.provider == "attached") { "CANLII" } else { "A2AJ" };
    // A PDF attached for a decision stands where the Python app read CanLII's page: a quotation the cited passage holds
    // only in part (under 0.90) and another holds word for word is a partial match at the pinpoint, the perfect match
    // elsewhere given beside it.
    if family == "CANLII" && found.len() == quotes.len() && found.iter().all(|quote| supported(quote)) && matches.iter().all(|location|
        location.location.starts_with("alternate") && location.perfect && location.cited.as_ref().is_some_and(|cited| cited.score < 0.9)) {
        let cited = matches.iter().map(|location| location.cited.clone().expect("a cited match")).collect::<Vec<_>>();
        return Checked { quote_check_status: "OG_PINPOINT_PARTIAL".into(),
            quote_corrected_citation: cited.iter().zip(&found).map(|(cited, quote)| quoted(&cited.corrected, quote)).collect::<Vec<_>>().join("\n\n"),
            quote_match_pinpoint: pinpoint_summary(distinct(cited.iter().flat_map(|cited| cited.labels.iter().map(|label| label.shown.clone()))), 2),
            quote_match_link: link,
            matched_source: join(cited.iter().map(|cited| cited.region.replace('\n', " ")).collect()),
            matched_source_fragment: join(cited.iter().map(|cited| cited.fragment.clone()).collect()),
            alternate_matched_source_fragment: join(matches.iter().map(|location| location.fragment.clone()).collect()),
            _alternate_quote_check_notes: Some(pinpoint_summary(distinct(matches.iter().flat_map(|location| location.labels.iter()
                .map(|label| label.shown.clone()))), 2)),
            _alternate_quote_corrected_citation: Some(found.iter().map(|quote| quoted(&quote.quote, quote)).collect::<Vec<_>>().join("\n\n")),
            ..Checked::default() };
    }
    let accepted = found.len() == quotes.len() && found.iter().all(|quote| supported(quote));
    let alternate = matches.iter().filter(|location| location.location.starts_with("alternate")).collect::<Vec<_>>();
    let shown = if alternate.is_empty() { matches.iter().collect::<Vec<_>>() } else { alternate.clone() };
    let pinpoint = pinpoint_summary(distinct(shown.iter().flat_map(|location| if location.labels.is_empty() {
        (!location.pinpoint.is_empty()).then(|| location.pinpoint.clone()).into_iter().collect::<Vec<_>>() } else {
        location.labels.iter().map(|label| label.shown.clone()).collect() })), 2);
    let level = if accepted && alternate.len() == matches.len() { "MATCH" } else { "PARTIAL" };
    let limited = matches.iter().any(|location| location.location.starts_with("scope_unavailable") || location.location == "cited_parent");
    let notes = [
        if !alternate.is_empty() { pinpoint.clone() } else if limited {
            "The cited pinpoint could not be isolated in the available source structure.".to_owned() } else { String::new() },
        if quotes.iter().any(|quote| quote.check.receipt.is_none()) { "No source text was found for one or more quotations." } else { "" }.to_owned(),
        if quotes.iter().any(|quote| quote.check.receipt.as_ref().is_some_and(|receipt| receipt.location.location == "unmatched")) {
            "One or more quotations were not found in the source text." } else { "" }.to_owned(),
        if quotes.iter().any(|quote| quote.check.receipt.as_ref().is_some_and(|receipt| receipt.comparison.is_none())) {
            "One or more quotations have not been compared with the source wording." } else { "" }.to_owned(),
    ];
    Checked {
        quote_check_status: if !alternate.is_empty() { format!("ALT_PINPOINT{}_{level}_{family}", if pinpoint.is_empty() { "LESS" } else { "" }) }
            else if accepted && !limited { "OG_PINPOINT_MATCH".into() } else { "OG_PINPOINT_PARTIAL".into() },
        quote_check_notes: notes.into_iter().filter(|note| !note.is_empty()).collect::<Vec<_>>().join(" "),
        quote_corrected_citation: quotes.iter().map(|quote| {
            let corrected = quote.check.receipt.as_ref().filter(|receipt| receipt.comparison.is_some() && receipt.location.location != "unmatched"
                && !supported(quote)).map(|receipt| receipt.location.corrected.as_str());
            quoted(corrected.unwrap_or(&quote.quote), quote)
        }).collect::<Vec<_>>().join("\n\n"),
        quote_match_pinpoint: pinpoint,
        quote_match_link: link,
        matched_source: join(matches.iter().map(|location| location.region.replace('\n', " ")).collect()),
        matched_source_fragment: join(matches.iter().map(|location| location.fragment.clone()).collect()),
        ..Checked::default()
    }
}

