//! An authority's source as its book reads it: each of its PDFs' cited passages placed and marked, the pages its
//! excerpt keeps of them joined, its bookmarks, the currency line a statute's excerpt prints atop it, and the text
//! recognition read of its pages. The one reading of a source for its highlights, its excerpt and its book copy.
use crate::engine::{self, NativeDocument};
use legal_structure::{normalize_javascript_whitespace, trim_javascript_whitespace};
use legalpdf::{AnnotationFragment, AnnotationMark, PassageGeometry, PassageTarget, PdfLookupStatus, PlacedPassage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

type Rect = [f64; 4];

/// What the builder asks of a source: the passages to place in each of its PDFs (those cited, and the paragraphs an
/// excerpt keeps around them, "context:…"), how they are marked, and how its excerpt is cut.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SourceRequest {
    pub targets: Vec<PassageTarget>,
    pub citations: Vec<String>,
    /// "none", "paragraph", "text", "margin" or "sidelined".
    pub style: String,
    /// A paragraph counts as placed only where its number is printed on it (a PDF the filer attached).
    pub require_printed: bool,
    /// Passages left unmarked, by kind and label.
    pub exclusions: Vec<(String, String)>,
    pub excerpt: Option<Excerpt>,
    /// Its recognized pages' text is kept as the book's text layer.
    pub ocr: bool,
    /// The pages the book adds after its PDFs (a missing language's).
    pub extra_pages: usize,
}
/// How an excerpt is cut: a statute's, the Federal Court's extract of a decision, or another source's with `pages`
/// either side of each cited one and each PDF's first page where `first_page`.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(tag = "rule", rename_all = "camelCase")]
pub enum Excerpt {
    Statute,
    Extract,
    #[serde(rename_all = "camelCase")]
    Source { pages: usize, first_page: bool },
}

/// One of the source's PDFs, in the order the book joins them: its reading (the pages recognition read, where only
/// some were, are read from it and the rest from `native`), else its count of pages where its text could not be read;
/// and its marks where they were reviewed. None: a page the book adds in place of a missing PDF.
pub struct Part<'a> {
    pub document: Option<&'a NativeDocument>,
    pub pages: usize,
    pub native: Option<&'a NativeDocument>,
    pub recognized: Option<BTreeSet<usize>>,
    pub saved: Option<Vec<AnnotationMark>>,
    /// Its marks place a paragraph only where its number is printed on it (a PDF the filer attached).
    pub require_printed: bool,
    /// Only its cited pages are placed: it was not read for its passages.
    pub pages_only: bool,
}

#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PartReading {
    pub page_count: usize,
    /// Its marks, as reviewed, else as first placed; and the passages only a page's margin marks, its own not found.
    pub marks: Vec<AnnotationMark>,
    pub page_marked: Vec<String>,
    /// Its cited passages placed (never the excerpt's context).
    pub geometry: Option<PassageGeometry>,
}

#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AuthorityReading {
    pub parts: Vec<Option<PartReading>>,
    /// The pages its excerpt keeps of its PDFs joined; none where it goes in whole.
    pub pages: Option<Vec<usize>>,
    /// A statute's cited provisions placed ("section\u{0}12(2)"), and those not placed, to be rebuilt from its text.
    pub placed: Vec<String>,
    pub missing: Vec<(String, String)>,
    /// A statute whose excerpt keeps nothing cited of its own: it goes in whole unless its provisions are rebuilt.
    pub whole_unless_rebuilt: bool,
    pub bookmarks: Vec<crate::assembly::book::BookMark>,
    /// The currency a statute's print states, where the pages kept leave it out.
    pub header: Option<String>,
    pub ocr_text_by_page: Option<Vec<String>>,
}

/// A locator as the book writes it: "s 33(1)", "art 49", "r 20.01", "para 12", "p 4".
pub fn locator_label(kind: &str, value: &str) -> String {
    let short = match kind { "paragraph" => "para", "section" => "s", "article" => "art", "rule" => "r", _ => "p" };
    format!("{short} {value}")
}

fn key(kind: &str, label: &str) -> String {
    format!("{}\u{0}{}", trim_javascript_whitespace(kind), trim_javascript_whitespace(label))
}

/// The first `units` UTF-16 units of `value`, as JavaScript's `slice` takes them (never half a character).
fn utf16_prefix(value: &str, units: usize) -> &str {
    let mut count = 0;
    for (at, character) in value.char_indices() {
        count += character.len_utf16();
        if count > units { return &value[..at]; }
    }
    value
}

/// A paragraph counts only where its number is printed on it, when that is asked.
fn printed(target: &PlacedPassage, require_printed: bool) -> bool {
    !require_printed || target.locator_kind != "paragraph" || target.printed == Some(true)
}

fn found(target: &PlacedPassage, require_printed: bool) -> bool {
    matches!(target.status, PdfLookupStatus::Found) && printed(target, require_printed)
}

/// The pages (from 0) each cited locator is placed on: where its passage is found, and a cited printed page's even
/// where its text is not read yet.
fn located_pages(targets: &[&PlacedPassage], page_count: usize, offset: usize, require_printed: bool, into: &mut BTreeMap<String, BTreeSet<usize>>) {
    for target in targets {
        let unread_page = target.locator_kind == "page" && matches!(target.status, PdfLookupStatus::Unavailable);
        if !(found(target, require_printed) || unread_page && printed(target, require_printed)) { continue; }
        for page in &target.pages {
            let number = page.page_number as usize + offset;
            if number > 0 && number <= page_count {
                into.entry(key(&target.locator_kind, &target.locator)).or_default().insert(number - 1);
            }
        }
    }
}

fn valid(rect: &Rect) -> bool {
    rect.iter().all(|value| value.is_finite() && (0.0..=1.0).contains(value)) && rect[2] > rect[0] && rect[3] > rect[1]
}

fn normalized(rect: &Rect, width: f64, height: f64) -> Rect {
    [rect[0] / width, rect[1] / height, rect[2] / width, rect[3] / height].map(|value| value.clamp(0.0, 1.0))
}

/// A mark's identity, as the builder has always made it: the digest of its kind, label, excerpt and fragments as
/// JavaScript writes them.
fn mark_id(kind: &str, label: &str, excerpt: &str, fragments: &[AnnotationFragment]) -> String {
    let number = |value: f64| ryu_js::Buffer::new().format(value).to_owned();
    let string = |value: &str| serde_json::to_string(value).unwrap_or_default();
    let fragments = fragments.iter().map(|fragment| format!("{{\"pageNumber\":{},\"rects\":[{}]}}", fragment.page_number,
        fragment.rects.iter().map(|rect| format!("[{}]", rect.map(number).join(","))).collect::<Vec<_>>().join(",")))
        .collect::<Vec<_>>().join(",");
    let json = format!("[{},{},{},[{fragments}]]", string(kind), string(label), string(excerpt));
    format!("{:x}", Sha256::digest(json.as_bytes()))[..32].to_owned()
}

/// The marks a PDF's placed passages take before any review: each passage highlighted, or barred down the margin of
/// each column it runs in, or its quotations highlighted; and a page's margin marked where a cited passage on it is
/// not found itself. A bare reference another mark of its kind covers gets none of its own. Also the passages only
/// a page's margin marks.
fn first_marks(geometry: &[&PlacedPassage], sizes: &[(f64, f64)], request: &SourceRequest, require_printed: bool, cited_pages: &BTreeSet<usize>) -> (Vec<AnnotationMark>, Vec<String>) {
    let style = request.style.as_str();
    let marginal = matches!(style, "margin" | "sidelined");
    let mut marks: Vec<AnnotationMark> = Vec::new();
    let mut unlocated = Vec::new();
    let add = |marks: &mut Vec<AnnotationMark>, kind: &str, label: String, excerpt: &str, fragments: Vec<AnnotationFragment>| {
        let fragments = fragments.into_iter().map(|f| AnnotationFragment { rects: f.rects.into_iter().filter(valid).collect(), ..f })
            .filter(|f| !f.rects.is_empty()).collect::<Vec<_>>();
        if fragments.is_empty() { return; }
        let id = mark_id(kind, &label, excerpt, &fragments);
        if marks.iter().any(|mark| mark.id == id) { return; }
        let highlight = kind == "highlight";
        let mut fragments = fragments;
        fragments.sort_by_key(|fragment| fragment.page_number);
        marks.push(AnnotationMark { id, kind: kind.into(), origin: "automatic".into(), label, excerpt: utf16_prefix(excerpt, 2_000).into(),
            rgb: if highlight { [1.0, 0.92, 0.6] } else if style == "sidelined" { [0.08, 0.08, 0.08] } else { [0.75, 0.08, 0.08] },
            opacity: if highlight { 0.45 } else { 0.9 }, fragments });
    };
    let excluded = |target: &&&PlacedPassage| request.exclusions.iter().any(|(kind, label)| key(kind, label) == key(&target.locator_kind, &target.locator));
    let targets = geometry.iter().filter(|target| !excluded(target)).copied().collect::<Vec<_>>();
    let size = |number: u32| sizes.get((number as usize).wrapping_sub(1)).copied();
    if style != "none" {
        for target in &targets {
            let label = locator_label(&target.locator_kind, &target.locator);
            let text = target.pages.iter().map(|page| page.text.as_str()).collect::<Vec<_>>().join(" ");
            let excerpt = utf16_prefix(trim_javascript_whitespace(&text), 2_000).to_owned();
            let fragments = if found(target, require_printed) {
                target.pages.iter().filter(|page| page.source == "native" && size(page.page_number).is_some() && page.width > 0.0 && page.height > 0.0)
                    .filter_map(|page| {
                        let rects = page.passage_rects.iter().map(|rect| normalized(rect, page.width, page.height)).filter(valid).collect::<Vec<_>>();
                        (!rects.is_empty()).then_some(AnnotationFragment { page_number: page.page_number, rects })
                    }).collect::<Vec<_>>()
            } else { Vec::new() };
            if fragments.is_empty() && target.locator_kind != "page" { unlocated.push(label.clone()); }
            if style == "paragraph" { add(&mut marks, "highlight", label.clone(), &excerpt, fragments.clone()); }
            if marginal {
                // One line down the margin of each column the passage runs in: a line's bar joins the bar above it
                // where it stands in the same column, and a line in another column starts its own.
                add(&mut marks, "margin", label.clone(), &excerpt, fragments.iter().map(|fragment| {
                    let width = size(fragment.page_number).map_or(1.0, |(width, _)| width);
                    let mut bars: Vec<Rect> = Vec::new();
                    for rect in &fragment.rects {
                        let x = (rect[0] - 7.0 / width).max(0.0);
                        match bars.last_mut() {
                            Some(last) if (last[0] - x).abs() < 0.02 && rect[1] >= last[1] => last[3] = last[3].max(rect[3]),
                            _ => bars.push([x, rect[1], x + 2.0 / width, rect[3]]),
                        }
                    }
                    AnnotationFragment { page_number: fragment.page_number, rects: bars }
                }).collect());
            }
            if matches!(style, "text" | "margin") {
                // Each quotation is marked on its own, however many cite the same passage.
                for quote in &target.quotes {
                    let pieces = quote.fragments.as_ref().map(|fragments| fragments.iter().map(|f| (f.page_number, &f.rects)).collect::<Vec<_>>())
                        .unwrap_or_else(|| quote.page_number.map(|number| vec![(number, &quote.rects)]).unwrap_or_default());
                    let fragments = pieces.into_iter().filter_map(|(number, rects)| {
                        let page = target.pages.iter().find(|page| page.page_number == number)?;
                        size(page.page_number)?;
                        Some(AnnotationFragment { page_number: number, rects: rects.iter().map(|rect| normalized(rect, page.width, page.height)).filter(valid).collect() })
                    }).collect::<Vec<_>>();
                    if !matches!(quote.status, PdfLookupStatus::Found) || fragments.is_empty() || fragments.iter().any(|f| f.rects.is_empty()) { continue; }
                    add(&mut marks, "highlight", format!("{label} · Quote"), &quote.text, fragments);
                }
            }
        }
    }
    // A cited page, and a passage found on a page, anchor the page's margin; so does a passage whose own extent could
    // not be located: its page carries the mark.
    if (marginal || !unlocated.is_empty()) && !(!geometry.is_empty() && targets.is_empty()) {
        for (index, &(width, height)) in sizes.iter().enumerate() {
            let number = index as u32 + 1;
            let has_mark = marks.iter().any(|mark| mark.kind == "margin" && mark.fragments.iter().any(|f| f.page_number == number));
            let has_target = marginal && targets.iter().any(|target| found(target, require_printed)
                && target.pages.iter().any(|page| page.page_number == number));
            if !has_mark && (cited_pages.contains(&index) || has_target) {
                add(&mut marks, "margin", "Cited page".into(), "", vec![AnnotationFragment { page_number: number,
                    rects: vec![[6.75 / width, 18.0 / height, 9.25 / width, 1.0 - 18.0 / height]] }]);
            }
        }
    }
    let page_marked = if marks.iter().any(|mark| mark.label == "Cited page") {
        let mut seen = BTreeSet::new();
        unlocated.into_iter().filter(|label| seen.insert(label.clone())).collect()
    } else { Vec::new() };
    let inside = |a: &Rect, b: &Rect| a[0] >= b[0] - 1e-3 && a[1] >= b[1] - 1e-3 && a[2] <= b[2] + 1e-3 && a[3] <= b[3] + 1e-3;
    let covers = |outer: &AnnotationMark, inner: &AnnotationMark| !std::ptr::eq(outer, inner) && outer.kind == inner.kind
        && inner.fragments.iter().all(|f| f.rects.iter().all(|rect| outer.fragments.iter().any(|o| o.page_number == f.page_number && o.rects.iter().any(|b| inside(rect, b)))));
    let quote = |mark: &AnnotationMark| mark.label.ends_with("· Quote");
    let kept = marks.iter().enumerate().filter(|&(index, mark)| quote(mark) || !marks.iter().enumerate()
        .any(|(at, other)| !quote(other) && covers(other, mark) && (!covers(mark, other) || at < index)))
        .map(|(_, mark)| mark.clone()).collect();
    (kept, page_marked)
}

/// The source read for its book: each PDF's passages placed and marked, then what its excerpt keeps of them joined.
pub fn authority_reading(parts: &[Option<Part>], request: &SourceRequest) -> engine::CoreResult<AuthorityReading> {
    let (mut readings, mut texts, mut ocr) = (Vec::new(), Vec::new(), Vec::new());
    let (mut placed, mut context, mut marked, mut starts) = (BTreeMap::new(), BTreeSet::new(), BTreeSet::new(), Vec::new());
    let (mut bookmarks, mut bookmarked) = (Vec::new(), BTreeSet::new());
    let count = |part: &Part| part.document.map_or(Ok(part.pages), |document| engine::pdf(document).map(|pdf| pdf.page_count()));
    let page_count = parts.iter().map(|part| part.as_ref().map_or(Ok(1), count)).sum::<engine::CoreResult<usize>>()? + request.extra_pages;
    let mut offset = 0;
    for part in parts {
        starts.push(offset);
        let (Some(part), Some(document)) = (part, part.as_ref().and_then(|part| part.document)) else {
            let pages = part.as_ref().map_or(1, |part| part.pages);
            texts.extend(std::iter::repeat_n(String::new(), pages)); ocr.extend(std::iter::repeat_n(String::new(), pages));
            // Its reviewed marks stand whether or not its text was read.
            let marks = part.as_ref().and_then(|part| part.saved.clone()).unwrap_or_default();
            marked.extend(marks.iter().flat_map(|mark| mark.fragments.iter().map(|f| offset + f.page_number as usize - 1)));
            readings.push(part.as_ref().map(|_| PartReading { page_count: pages, marks, page_marked: Vec::new(), geometry: None }));
            offset += pages; continue;
        };
        let pdf = engine::pdf(document)?;
        let count = pdf.page_count();
        let sizes = pdf.passage_pages().iter().map(|page| (page.width, page.height)).collect::<Vec<_>>();
        let targets = request.targets.iter().filter(|target| !part.pages_only || target.locator_kind == "page").cloned().collect::<Vec<_>>();
        let geometry = (!targets.is_empty()).then(|| engine::passage_geometry(document, targets, Some(request.citations.clone()))).transpose()?;
        let recognized_texts = pdf.page_texts();
        let native_texts = match (&part.recognized, part.native) { (Some(_), Some(native)) => engine::pdf(native)?.page_texts(), _ => Vec::new() };
        let routed = if request.ocr { pdf.summary().ocr_routed_pages.iter().copied().collect::<BTreeSet<_>>() } else { BTreeSet::new() };
        for index in 0..count {
            let text = match &part.recognized { Some(pages) if !pages.contains(&index) => native_texts.get(index), _ => recognized_texts.get(index) };
            let text = text.cloned().unwrap_or_default();
            ocr.push(if routed.contains(&index) { text.clone() } else { String::new() });
            texts.push(text);
        }
        // The paragraphs placed for an excerpt's context are its pages, never passages of their own.
        let (own, around): (Vec<_>, Vec<_>) = geometry.iter().flat_map(|g| &g.targets).partition(|target| !target.id.starts_with("context:"));
        for target in around.iter().filter(|target| matches!(target.status, PdfLookupStatus::Found)) {
            context.extend(target.pages.iter().map(|page| offset + page.page_number as usize - 1));
        }
        let mut cited_pages = BTreeMap::new();
        located_pages(&own, count, 0, part.require_printed, &mut cited_pages);
        located_pages(&own, page_count, offset, request.require_printed, &mut placed);
        let cited_pages = cited_pages.into_values().flatten().collect::<BTreeSet<_>>();
        let (marks, page_marked) = match &part.saved {
            Some(saved) => (saved.clone(), Vec::new()),
            None => first_marks(&own, &sizes, request, part.require_printed, &cited_pages),
        };
        marked.extend(marks.iter().flat_map(|mark| mark.fragments.iter().map(|f| offset + f.page_number as usize - 1)));
        // One bookmark for each cited passage found, where it begins.
        for target in own.iter().filter(|target| found(target, request.require_printed)) {
            if let Some(first) = target.pages.first().filter(|_| bookmarked.insert(format!("{}\u{0}{}", target.locator_kind, target.locator))) {
                bookmarks.push(crate::assembly::book::BookMark { title: locator_label(&target.locator_kind, &target.locator),
                    page_index: offset + first.page_number as usize - 1 });
            }
        }
        let geometry = geometry.map(|mut g| { g.targets.retain(|target| !target.id.starts_with("context:")); g });
        readings.push(Some(PartReading { page_count: count, marks, page_marked, geometry }));
        offset += count;
    }
    let cited = placed.values().flatten().copied().chain(marked.iter().copied()).collect::<BTreeSet<_>>();
    let trailing = |kept: &mut BTreeSet<usize>| kept.extend(offset..page_count);
    let mut statute: (Vec<String>, Vec<(String, String)>, bool) = (Vec::new(), Vec::new(), false);
    let pages: Option<Vec<usize>> = match &request.excerpt {
        None => None,
        Some(Excerpt::Statute) => {
            let mut kept = marked.iter().copied().chain(placed.values().flatten().copied()).collect::<BTreeSet<_>>();
            kept.extend(starts.iter().copied());
            trailing(&mut kept);
            let mut seen = BTreeSet::new();
            let wanted = request.targets.iter().filter(|target| !target.id.starts_with("context:"))
                .filter(|target| seen.insert(key(&target.locator_kind, &target.locator))).collect::<Vec<_>>();
            let missing = wanted.iter().filter(|target| target.locator_kind != "page" && !placed.contains_key(&key(&target.locator_kind, &target.locator)))
                .map(|target| (target.locator_kind.clone(), trim_javascript_whitespace(&target.locator).to_owned())).collect::<Vec<_>>();
            let whole = placed.is_empty() && marked.is_empty();
            let pages = (!wanted.is_empty() || !placed.is_empty()).then(|| kept.into_iter().filter(|&page| page < page_count).collect::<Vec<_>>());
            statute = (placed.keys().cloned().collect(), missing, whole);
            if whole && statute.1.is_empty() { None } else { pages }
        }
        Some(Excerpt::Extract) => {
            // Every page through the one the reasons begin on, and each cited page with the pages either side.
            context.first().copied().filter(|_| !cited.is_empty()).map(|reasons| {
                let mut kept = (0..=reasons).collect::<BTreeSet<_>>();
                for &page in &cited { kept.extend(page.saturating_sub(1)..=(page + 1).min(page_count.saturating_sub(1))); }
                kept.into_iter().collect()
            })
        }
        Some(Excerpt::Source { pages, first_page }) => (!cited.is_empty()).then(|| {
            let mut kept = context.clone();
            for &page in &cited { kept.extend(page.saturating_sub(*pages)..=page + pages); }
            if *first_page { kept.extend(starts.iter().copied()); }
            trailing(&mut kept);
            kept.into_iter().filter(|&page| page < page_count).collect()
        }),
    };
    bookmarks.sort_by_key(|mark| mark.page_index);
    // A statute's excerpt that leaves out the page saying how current it is says it atop its first page.
    let header = matches!(request.excerpt, Some(Excerpt::Statute)).then_some(()).and(pages.as_ref())
        .and_then(|kept| legal_structure_features::statute_currency(&texts).filter(|currency| {
            let currency = currency.to_lowercase();
            !kept.iter().any(|&page| texts.get(page).is_some_and(|text| normalize_javascript_whitespace(text).to_lowercase().contains(&currency)))
        }));
    let (placed, missing, whole_unless_rebuilt) = statute;
    Ok(AuthorityReading { parts: readings, pages, placed, missing, whole_unless_rebuilt, bookmarks, header,
        ocr_text_by_page: ocr.iter().any(|text| !text.is_empty()).then_some(ocr) })
}
