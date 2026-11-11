//! A book of authorities: its cover (drawn, the Federal Court's Form 66, the Alberta Rules of Court's, or the filer's
//! own), its index, each authority behind its tab, bookmarks, links and page labels, divided into volumes where the
//! court limits a filing's pages or bytes.
use super::{citation_lines, fit, pdf_normalized, pdf_text, wrapped, Run};
use legal_structure::PartyGroup;
use legalpdf::compose::{map_outline, nested_outline, read_outline, source_outline, Composer, Face, Label, Meta, Outline, Position, Rgb, Target};
use serde::{Deserialize, Serialize};
use crate::dispatch::{Buffer, Bytes};
use std::collections::HashMap;

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct BookRow {
    pub key: String,
    pub name: String,
    /// How many of the name's first characters are italic: its style of cause or title.
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(as = "Option<usize>", optional))]
    pub italic: usize,
    pub tab: String,
    #[serde(default)]
    pub source_url: Option<String>,
}

/// One of an authority's PDFs, in the order they are joined, with the headings read from its text; or a page naming
/// what is missing ("French version").
#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BookPart {
    Pdf { bytes: Bytes, #[serde(default)] headings: Vec<BookHeading> },
    /// In Times for the Federal Court, else in Arial.
    Missing { detail: Option<String>, #[serde(default)] federal: bool },
}

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct BookHeading { pub title: String, pub level: usize, pub page_index: Option<usize> }

#[derive(Deserialize, Serialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BookMark { pub title: String, pub page_index: usize }

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub struct DatabaseReference { pub url: String, pub host: String }

/// An authority or a supplement as the book holds it. No parts: the book holds one page naming it in its place.
/// `header`: a line atop its first page (an excerpt's currency); `link`: an address printed there as a link.
#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct BookSource {
    #[serde(flatten)]
    pub row: BookRow,
    pub parts: Vec<BookPart>,
    /// The pages kept, of its parts joined; none listed, all of them.
    pub page_indices: Vec<usize>,
    #[serde(default)]
    pub ocr_text_by_page: Option<Vec<String>>,
    #[serde(default)]
    pub header: Option<String>,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub database_reference: Option<DatabaseReference>,
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(as = "Option<Vec<BookMark>>", optional))]
    pub bookmarks: Vec<BookMark>,
    /// Its own outline under its tab: its publisher's bookmarks with the headings read from it.
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(as = "Option<bool>", optional))]
    pub outline: bool,
}


#[derive(Deserialize, Clone, Default)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Contact { pub name: String, pub address: String, #[serde(default)] #[cfg_attr(feature = "binding-types", ts(as = "Option<String>", optional))] pub phone: String, #[serde(default)] #[cfg_attr(feature = "binding-types", ts(as = "Option<String>", optional))] pub fax: String, #[serde(default)] #[cfg_attr(feature = "binding-types", ts(as = "Option<String>", optional))] pub email: String }

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct Cover {
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(as = "Option<String>", optional))]
    pub court_file_number: String,
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(as = "Option<Vec<PartyGroup>>", optional))]
    pub party_groups: Vec<PartyGroup>,
    #[serde(default)]
    pub application_under: Option<String>,
    #[serde(default)]
    pub judicial_centre: Option<String>,
    #[serde(default)]
    pub contact: Option<Contact>,
}

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub struct PaperCover { pub rgb: Rgb, pub dark: bool }

#[derive(Deserialize, Clone, Default)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct Limits { pub max_pages: Option<usize>, pub max_bytes: Option<usize>, #[serde(default)] #[cfg_attr(feature = "binding-types", ts(as = "Option<bool>", optional))] pub complete_toc: bool, #[serde(default)] #[cfg_attr(feature = "binding-types", ts(as = "Option<bool>", optional))] pub cover_labels: bool }

#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub struct BookGroup { pub label: String, pub entries: Vec<BookRow> }

/// A book as the builder prepared it. `customCover`/`customIndex`: the filer's own PDFs.
#[derive(Deserialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct PreparedBook {
    pub filename: String,
    pub subtitle: String,
    pub document_title: String,
    pub book_title: String,
    pub federal: bool,
    pub electronic: bool,
    pub court: String,
    pub cover: Cover,
    pub cover_line: Option<String>,
    pub paper_cover: Option<PaperCover>,
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(as = "Option<bool>", optional))]
    pub alberta: bool,
    /// What the index gives beside each citation: its tab ("tabs"), or its tab and pages ("tabs-and-pages").
    #[serde(default)]
    pub index_shows: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(as = "Option<bool>", optional))]
    pub index_links: bool,
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(as = "Option<bool>", optional))]
    pub tab_pages: bool,
    #[serde(default)]
    pub custom_cover: Option<Bytes>,
    #[serde(default)]
    pub custom_index: Option<Bytes>,
    /// The cover's pages and the filer's index's, as counted of their PDFs (a drawn cover is one page).
    #[serde(skip)]
    pub cover_page_count: usize,
    #[serde(skip)]
    pub custom_index_pages: usize,
    #[serde(default)]
    pub limits: Option<Limits>,
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(as = "Option<bool>", optional))]
    pub right_hand_starts: bool,
    /// Only the cover and the index, for a preview: each source's pages are counted, none is copied.
    #[serde(default)]
    #[cfg_attr(feature = "binding-types", ts(as = "Option<bool>", optional))]
    pub front_only: bool,
    pub groups: Vec<BookGroup>,
    pub sources: Vec<BookSource>,
}

/// `pageIndex`: an authority's first page; `tabPageIndex`: its tab page, or its first page without one.
#[derive(Serialize, Clone)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Placement { pub key: String, pub page_index: usize, pub tab_page_index: usize, pub source_page_indices: Vec<usize> }

/// A volume of the book.
#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct BuiltBook { pub role: String, pub filename: String, pub page_count: usize, pub placements: Vec<Placement>, pub bytes: Buffer }

#[derive(Clone)]
struct Slice { source: usize, pages: Vec<usize> }
struct Token { label: String, entry: Option<BookRow>, lines: Vec<Vec<Run>>, height: f64 }
struct Placed { slice: Slice, local_start: usize, tab_start: usize, tabbed: bool, blank_before: bool, blank_after: bool }
struct Plan { slices: Vec<Placed>, global_start: usize }

const BLACK: Rgb = [0.0, 0.0, 0.0];
const LINK_BLUE: Rgb = [5.0 / 255.0, 99.0 / 255.0, 193.0 / 255.0];

/// Volumes of whole authorities, in order, each as many as fit in `size` (each taking `added` pages more than its
/// own); only an authority longer than a volume is divided. `per_page`: what one of its pages weighs against `size`.
fn split_at_tabs(items: &[Slice], size: f64, added: usize, per_page: &dyn Fn(&Slice) -> f64) -> Vec<Vec<Slice>> {
    let mut volumes: Vec<Vec<Slice>> = vec![Vec::new()];
    let mut used = 0.0;
    for item in items {
        let each = per_page(item);
        let weight = (item.pages.len() + added) as f64 * each;
        if used > 0.0 && used + weight > size { volumes.push(Vec::new()); used = 0.0; }
        if weight <= size { volumes.last_mut().expect("volume").push(item.clone()); used += weight; continue; }
        let room = ((size / each).floor() as usize).saturating_sub(added).max(1);
        let parts: Vec<&[usize]> = item.pages.chunks(room).collect();
        for (index, part) in parts.iter().enumerate() {
            if index > 0 { volumes.push(Vec::new()); }
            volumes.last_mut().expect("volume").push(Slice { source: item.source, pages: part.to_vec() });
        }
        used = parts.last().map_or(0, |p| p.len()) as f64 * each;
    }
    volumes
}

/// Each source's PDFs by part, and where each part's pages begin in the source's joined pages.
struct SourcePdfs<'a> { parts: Vec<(Option<&'a [u8]>, usize)>, count: usize }

pub fn render_book(mut book: PreparedBook) -> Result<Vec<BuiltBook>, String> {
    let pages = |pdf: &[u8]| legalpdf::compose::page_frames(pdf).map(|frames| frames.len()).map_err(|e| e.to_string());
    book.cover_page_count = book.custom_cover.as_deref().map_or(Ok(1), pages)?;
    book.custom_index_pages = book.custom_index.as_deref().map_or(Ok(0), pages)?;
    let mut starts = Vec::new();
    for source in &mut book.sources {
        let (mut first, mut count) = (Vec::new(), 0);
        for part in &source.parts {
            first.push(count);
            count += match part { BookPart::Pdf { bytes, .. } => pages(bytes)?, BookPart::Missing { .. } => 1 };
        }
        if source.page_indices.is_empty() { source.page_indices = (0..count).collect(); }
        starts.push((first, count));
    }
    let book = &book;
    let (custom_cover, custom_index) = (book.custom_cover.as_deref(), book.custom_index.as_deref());
    let pdfs: Vec<SourcePdfs> = book.sources.iter().zip(starts).map(|(source, (first, count))| SourcePdfs { count,
        parts: source.parts.iter().zip(first).map(|(part, at)| (match part { BookPart::Pdf { bytes, .. } => Some(&bytes[..]), _ => None }, at)).collect() }).collect();
    let layout = Layout::of(book);
    let Layout { federal, show_pages, grouped, body, leading, title_x, page_right, pages_column, source_x, top, bottom, .. } = layout;
    let (tab_pages, right_hand, front_only) = (book.tab_pages, book.right_hand_starts, book.front_only);
    let limits = book.limits.clone().unwrap_or_default();
    // The index lists each citation in full, wrapped onto as many lines as it takes.
    let mut tokens = Vec::new();
    for group in &book.groups {
        if grouped { tokens.push(Token { label: group.label.clone(), entry: None, lines: Vec::new(), height: if federal { 27.0 } else { 30.0 } }); }
        for entry in &group.entries {
            let width = if federal {
                if entry.source_url.is_some() { source_x - title_x - 8.0 } else { page_right - title_x - if show_pages { pages_column } else { 8.0 } }
            } else { page_right - title_x - 58.0 - pages_column - 24.0 };
            let lines = citation_lines(Face::Times, Face::TimesItalic, &entry.name, entry.italic, body, width);
            let height = if federal { 25.0 } else { 12.0 } + (lines.len() as f64 - if federal { 1.0 } else { 0.0 }) * leading;
            tokens.push(Token { label: String::new(), entry: Some(entry.clone()), lines, height });
        }
    }
    let mut chunks: Vec<Vec<usize>> = vec![Vec::new()];
    let mut room = top - bottom;
    for (index, token) in tokens.iter().enumerate() {
        // A heading never ends a page.
        let needs = token.height + if token.entry.is_some() { 0.0 } else { tokens.get(index + 1).map_or(0.0, |t| t.height) };
        if !chunks.last().expect("chunk").is_empty() && needs > room { chunks.push(Vec::new()); room = top - bottom; }
        chunks.last_mut().expect("chunk").push(index);
        room -= token.height;
    }
    let cover_outline = match custom_cover { Some(pdf) => read_outline(pdf, 0).map_err(|e| e.to_string())?, None => Vec::new() };
    let index_outline = match custom_index { Some(pdf) => read_outline(pdf, 0).map_err(|e| e.to_string())?, None => Vec::new() };
    // Each source's own outline: each part's bookmarks with the headings read from it, on the joined pages.
    let mut outlines = Vec::new();
    for (source, pdf) in book.sources.iter().zip(&pdfs) {
        let mut outline = Vec::new();
        if source.outline && !front_only {
            for (part, (bytes, offset)) in source.parts.iter().zip(&pdf.parts) {
                let (BookPart::Pdf { headings, .. }, Some(bytes)) = (part, bytes) else { continue };
                let read = nested_outline(headings.iter().map(|h| (h.title.clone(), h.level, h.page_index.map(|p| p + offset))));
                outline.extend(source_outline(read_outline(bytes, *offset).map_err(|e| e.to_string())?, read));
            }
        }
        outlines.push(outline);
    }
    let all: Vec<Slice> = book.sources.iter().enumerate().map(|(index, s)| Slice { source: index, pages: s.page_indices.clone() }).collect();
    // The pages an authority may add around its own: its tab page, and the blanks that start it on the right.
    let added = usize::from(tab_pages) + if right_hand { if tab_pages { 2 } else { 1 } } else { 0 };
    let index_pages = if book.custom_index_pages > 0 { book.custom_index_pages } else { chunks.len() };
    let paper_back = book.paper_cover.is_some() && custom_cover.is_none();
    let single = book.cover_page_count + index_pages + all.iter().map(|s| s.pages.len() + added).sum::<usize>() + usize::from(paper_back);
    let overhead = book.cover_page_count + index_pages + usize::from(limits.cover_labels);
    if limits.max_pages.is_some_and(|max| overhead >= max) { return Err("The required volume front matter exceeds the filing page limit.".into()); }
    let mut volumes = match limits.max_pages { Some(max) if single > max => split_at_tabs(&all, (max - overhead) as f64, added, &|_| 1.0), _ => vec![all] };
    // A volume's bytes, each authority weighed by its own PDFs'.
    let per_page = |slice: &Slice| {
        let source = &book.sources[slice.source];
        let size: usize = source.parts.iter().map(|p| if let BookPart::Pdf { bytes, .. } = p { bytes.len() } else { 0 }).sum();
        size as f64 / source.page_indices.len().max(1) as f64
    };
    let parts = Parts { layout, pdfs, outlines, tokens, chunks, cover_outline, index_outline, custom_cover, custom_index };
    loop {
        let (built, placements) = assemble(book, &parts, &volumes)?;
        let oversized = built.iter().position(|(bytes, pages)| limits.max_pages.is_some_and(|m| *pages > m) || limits.max_bytes.is_some_and(|m| bytes.len() > m));
        let Some(oversized) = oversized else {
            let count = built.len();
            return Ok(built.into_iter().zip(placements).enumerate().map(|(index, ((bytes, page_count), placements))| {
                BuiltBook { role: if index > 0 { format!("book-{}", index + 1) } else { "book".into() }, page_count, placements, bytes: Buffer(bytes),
                    filename: if count > 1 { volume_filename(&book.filename, index + 1, count) } else { book.filename.clone() } }
            }).collect());
        };
        let volume = &volumes[oversized];
        if volume.iter().map(|s| s.pages.len()).sum::<usize>() < 2 { return Err("One PDF page exceeds the court's electronic filing size limit.".into()); }
        // As many volumes as its size asks for, a little room left in each; filled to nine tenths of the court's limit.
        let weight: f64 = volume.iter().map(|s| s.pages.len() as f64 * per_page(s)).sum();
        let parts = ((built[oversized].0.len() as f64 * 1.1 / limits.max_bytes.map_or(f64::INFINITY, |m| m as f64)).ceil() as usize).max(2);
        let size = match limits.max_bytes { Some(max) => (weight / 2.0).min(max as f64 * 0.9), None => weight / parts as f64 };
        let divided = split_at_tabs(volume, size, 0, &per_page);
        if divided.len() < 2 { return Err("The PDF could not be divided into filing-sized volumes.".into()); }
        volumes.splice(oversized..=oversized, divided);
    }
}

fn volume_filename(filename: &str, number: usize, count: usize) -> String {
    let lower = filename.to_lowercase();
    match lower.strip_suffix(".pdf") { Some(_) => format!("{}.volume-{number}-of-{count}.pdf", &filename[..filename.len() - 4]), None => filename.to_owned() }
}

/// The index's page geometry and type, as the court sets it: measured once, for the index's pages and its drawing alike.
#[derive(Clone, Copy)]
struct Layout { federal: bool, show_pages: bool, grouped: bool, margin: f64, body: f64, leading: f64, title_x: f64, page_right: f64,
    pages_column: f64, source_width: f64, source_x: f64, top: f64, bottom: f64 }

impl Layout {
    fn of(book: &PreparedBook) -> Self {
        let (federal, show_pages) = (book.federal, book.index_shows.as_deref() == Some("tabs-and-pages"));
        let margin = margin(federal);
        let body = if federal { 12.0 } else { 11.0 };
        let (page_right, pages_column, source_width) = (612.0 - margin, if show_pages { 66.0 } else { 0.0 }, Face::Times.width("source", 12.0));
        Layout { federal, show_pages, margin, body, leading: body + 3.0, title_x: if federal { margin + 52.0 } else { margin }, page_right,
            pages_column, source_width,
            // The Federal Court's source link stands clear of the page numbers when the index gives them.
            source_x: if show_pages { page_right - pages_column - source_width } else { 447.0 },
            top: if federal { 670.0 } else { 680.0 }, bottom: if federal { 100.0 } else { 84.0 },
            // Under headings where the authorities are grouped; one list, bookmarked tab by tab, where not.
            grouped: book.groups.len() > 1 || book.groups.first().is_some_and(|g| g.label != "Authorities") }
    }
}

/// What every volume is assembled from: the layout, each source's PDFs and outline, the index's entries and their pages,
/// and the filer's own cover and index.
struct Parts<'a> { layout: Layout, pdfs: Vec<SourcePdfs<'a>>, outlines: Vec<Vec<Outline>>, tokens: Vec<Token>, chunks: Vec<Vec<usize>>,
    cover_outline: Vec<Outline>, index_outline: Vec<Outline>, custom_cover: Option<&'a [u8]>, custom_index: Option<&'a [u8]> }

fn assemble(book: &PreparedBook, parts: &Parts, volumes: &[Vec<Slice>]) -> Result<(Vec<(Vec<u8>, usize)>, Vec<Vec<Placement>>), String> {
    let Parts { layout, pdfs, outlines, tokens, chunks, cover_outline, index_outline, custom_cover, custom_index } = parts;
    let (custom_cover, custom_index) = (*custom_cover, *custom_index);
    let Layout { federal, show_pages, grouped, margin, body, leading, title_x, page_right, source_width, source_x, top, .. } = *layout;
    let (tab_pages, right_hand, front_only) = (book.tab_pages, book.right_hand_starts, book.front_only);
    let limits = book.limits.clone().unwrap_or_default();
    let multi = volumes.len() > 1;
    let generated_toc = custom_index.is_none();
    if custom_index.is_some() && multi && limits.complete_toc {
        return Err("Remove the custom index so the builder can generate a complete index for every filing volume.".into());
    }
    // The index opens every volume where the court wants it complete in each, else the first.
    let indexed = |volume: usize| generated_toc && (volume == 0 || limits.complete_toc);
    let back_pages = usize::from(multi && limits.cover_labels || book.paper_cover.is_some() && custom_cover.is_none());
    let mut global_start = 0;
    let mut ranges: HashMap<String, Vec<String>> = HashMap::new();
    let mut volume_of: HashMap<String, usize> = HashMap::new();
    let mut plans = Vec::new();
    for (volume, slices) in volumes.iter().enumerate() {
        let mut local = book.cover_page_count + book.custom_index_pages + if indexed(volume) { chunks.len() } else { 0 };
        let mut placed = Vec::new();
        for slice in slices {
            let source = &book.sources[slice.source];
            // A tab page, and the blanks that put it on the right, open an authority, not each volume it runs into.
            let opens = slice.pages.first() == source.page_indices.first();
            let tabbed = tab_pages && opens;
            if opens { volume_of.entry(source.row.key.clone()).or_insert(volume); }
            let blank_before = right_hand && opens && local % 2 == 1;
            local += usize::from(blank_before);
            let (tab_start, blank_after) = (local, right_hand && tabbed);
            if tabbed { local += 1 + usize::from(blank_after); }
            let first = global_start + local + 1;
            let last = first + slice.pages.len().saturating_sub(1);
            ranges.entry(source.row.key.clone()).or_default().push(if first == last { first.to_string() } else { format!("{first}–{last}") });
            placed.push(Placed { slice: slice.clone(), local_start: local, tab_start, tabbed, blank_before, blank_after });
            local += slice.pages.len();
        }
        plans.push(Plan { slices: placed, global_start });
        global_start += local + back_pages;
    }
    let placements: Vec<Vec<Placement>> = plans.iter().map(|plan| plan.slices.iter().map(|p| Placement { key: book.sources[p.slice.source].row.key.clone(),
        page_index: p.local_start, tab_page_index: p.tab_start, source_page_indices: p.slice.pages.clone() }).collect()).collect();
    let mut built = Vec::new();
    for (volume, plan) in plans.iter().enumerate() {
        let mut c = Composer::new();
        // The Federal Court prescribes Times; other courts' covers, tab pages and page numbers are in Arial.
        let serif = c.font(Face::Times);
        let serif_italic = c.font(Face::TimesItalic);
        let serif_bold = c.font(Face::TimesBold);
        let regular = c.font(if federal { Face::Times } else { Face::Arial });
        let bold = c.font(if federal { Face::TimesBold } else { Face::ArialBold });
        let content_width = 612.0 - 2.0 * margin;
        let volume_label = format!("Volume {} of {}", volume + 1, volumes.len());
        // Where each authority begins in this volume: its tab page, or its first page without one.
        let tab_starts: HashMap<&str, usize> = plan.slices.iter().map(|p| (book.sources[p.slice.source].row.key.as_str(), p.tab_start)).collect();
        let index_start = book.cover_page_count + if generated_toc { book.custom_index_pages } else { 0 };
        let index_chunks: &[Vec<usize>] = if indexed(volume) { chunks } else { &[] };
        let index_title = if federal { "Table of Contents" } else { "Index" };
        let mut links: Vec<(usize, [f64; 4], Target)> = Vec::new();
        // The cover: the filer's own, or drawn.
        let mut cover_bottom = 400.0;
        if let Some(pdf) = custom_cover { c.append(pdf, None).map_err(|e| e.to_string())?; } else {
            let page = c.add_page(612.0, 792.0);
            if let Some(paper) = &book.paper_cover { c.rect(page, [0.0, 0.0, 612.0, 792.0], Some(paper.rgb), None, None); }
            let ink = if book.paper_cover.as_ref().is_some_and(|p| p.dark) { [1.0; 3] } else { [0.18; 3] };
            cover_bottom = if federal { form_66(&mut c, page, regular, bold, book, ink)? }
                else if book.alberta { alberta_cover(&mut c, page, regular, bold, book) }
                else {
                    c.line(page, [margin, 626.0], [612.0 - margin, 626.0], 2.0, ink);
                    // The title wraps rather than losing its end; the subtitle follows its last line.
                    let title: Vec<String> = wrapped(Face::ArialBold, &book.document_title, 28.0, content_width).into_iter().take(4).collect();
                    let extra = (title.len() as f64 - 1.0) * 34.0;
                    let lines: Vec<(String, f64, f64)> = title.iter().enumerate().map(|(i, l)| (l.clone(), margin, 500.0 - i as f64 * 34.0)).collect();
                    c.field(page, "Title", &lines, [margin - 4.0, 492.0 - extra, content_width + 8.0, extra + 36.0], bold, 28.0, false, ink, front_only);
                    if !book.subtitle.is_empty() && book.book_title != book.subtitle {
                        c.text(page, serif, &fit(Face::Times, &book.subtitle, 13.0, content_width), margin, 462.0 - extra, 13.0, ink);
                    }
                    432.0 - extra
                };
        }
        if multi && limits.cover_labels { c.text(0, bold, &volume_label, margin, cover_bottom.min(400.0), 12.0, BLACK); }
        if let Some(pdf) = custom_index { c.append(pdf, None).map_err(|e| e.to_string())?; }
        for (chunk_index, chunk) in index_chunks.iter().enumerate() {
            let page = c.add_page(612.0, 792.0);
            let heading = if chunk_index > 0 { format!("{index_title} — continued") } else { index_title.to_owned() };
            if federal { c.text(page, bold, &pdf_text(&heading), margin, 708.0, 12.0, BLACK); } else {
                let caps = pdf_text(&heading.to_uppercase());
                c.text(page, serif_bold, &caps, (612.0 - Face::TimesBold.width(&caps, 13.0)) / 2.0, 724.0, 13.0, BLACK);
            }
            let mut y = top;
            for &token_index in chunk {
                let token = &tokens[token_index];
                let Some(entry) = &token.entry else {
                    if federal {
                        c.rect(page, [margin, y - 8.0, content_width, 22.0], Some([0.92; 3]), None, None);
                        c.text(page, bold, &pdf_text(&token.label.to_uppercase()), margin + 8.0, y, 12.0, BLACK);
                        y -= 27.0;
                    } else {
                        y -= 8.0;
                        c.text(page, serif_bold, &pdf_text(&token.label.to_uppercase()), margin, y, body, BLACK);
                        y -= 22.0;
                    }
                    continue;
                };
                let tab_target = tab_starts.get(entry.key.as_str()).copied();
                let page_label = ranges.get(&entry.key).map_or("—".to_owned(), |r| r.join(", "));
                let last = y - (token.lines.len() as f64 - 1.0) * leading;
                // A linked citation is in Word's link blue, as most filed books show their index links.
                let url = (!federal && book.index_links).then(|| entry.source_url.clone()).flatten();
                let line_width = |line: &[Run]| -> f64 { line.iter().map(|(t, i)| if *i { Face::TimesItalic.width(t, body) } else { Face::Times.width(t, body) }).sum() };
                for (index, line) in token.lines.iter().enumerate() {
                    draw_runs(&mut c, page, line, title_x, y - index as f64 * leading, body, serif, serif_italic, if url.is_some() { LINK_BLUE } else { BLACK });
                }
                if federal {
                    // Only the Federal Court's index links each authority to its public source.
                    c.text(page, bold, &pdf_text(&entry.tab), margin + 6.0, y, 12.0, BLACK);
                    if entry.source_url.is_some() { c.text(page, regular, "source", source_x, y, 12.0, BLACK); }
                    if show_pages { c.text(page, bold, &pdf_text(&page_label), page_right - Face::TimesBold.width(&pdf_text(&page_label), 12.0), y, 12.0, BLACK); }
                    c.line(page, [title_x, last - 7.0], [page_right, last - 7.0], 0.45, [0.82; 3]);
                    if let (Some(target), false) = (tab_target, front_only) {
                        links.push((page, [margin, last - 10.0, if entry.source_url.is_some() { source_x - 5.0 } else { page_right }, y + 10.0], Target::Page(target)));
                    }
                    if let Some(source_url) = &entry.source_url { links.push((page, [source_x - 5.0, y - 10.0, source_x + source_width + 5.0, y + 10.0], Target::Uri(source_url.clone()))); }
                    y -= token.height;
                    continue;
                }
                // The citation, a dot leader, then the tab (and the pages) on its last line. An authority in another
                // volume is found there.
                let elsewhere = match volume_of.get(&entry.key) { Some(v) if multi && *v != volume => format!(" (Vol. {})", v + 1), None if multi => " (Vol. 1)".into(), _ => String::new() };
                let tab = pdf_text(&format!("{}{elsewhere}", entry.tab));
                let tab_width = Face::TimesBold.width(&tab, body);
                c.text(page, serif_bold, &tab, page_right - tab_width, last, body, BLACK);
                let mut leader_end = page_right - tab_width - 8.0;
                if show_pages {
                    let label = pdf_text(&page_label);
                    let (width, right) = (Face::Times.width(&label, body), page_right - 58.0);
                    c.text(page, serif, &label, right - width, last, body, BLACK);
                    leader_end = right - width - 8.0;
                }
                let leader_start = title_x + token.lines.last().map_or(0.0, |l| line_width(l)) + 6.0;
                let dot = Face::Times.width(" .", body);
                let dots = ((leader_end - leader_start) / dot).floor();
                if dots > 1.0 { c.text(page, serif, &" .".repeat(dots as usize), leader_end - dots * dot, last, body, BLACK); }
                // Linked, each line of the citation opens the authority online and the leader and tab its tab.
                if let Some(url) = &url {
                    for (index, line) in token.lines.iter().enumerate() {
                        let line_y = y - index as f64 * leading;
                        links.push((page, [title_x - 1.0, line_y - 4.0, title_x + line_width(line) + 1.0, line_y + body], Target::Uri(url.clone())));
                    }
                }
                if let (Some(target), false) = (tab_target, front_only) {
                    links.push((page, if url.is_some() { [leader_start - 4.0, last - 4.0, page_right + 2.0, last + body] } else { [margin - 2.0, last - 4.0, page_right + 2.0, y + body] }, Target::Page(target)));
                }
                y -= token.height;
            }
            if !(federal && book.electronic) {
                let number = plan.global_start + book.cover_page_count + book.custom_index_pages + chunk_index + 1;
                c.stamp(page, &number.to_string(), Some(number as i64), regular, Position::BottomCentre, if federal { 12.0 } else { 9.0 }, 72.0, if federal { 75.0 } else { 36.0 });
            }
        }
        if !front_only {
            for placed in &plan.slices {
                let source = &book.sources[placed.slice.source];
                if placed.blank_before { c.add_page(612.0, 792.0); }
                if placed.tabbed { let page = c.add_page(612.0, 792.0); tab_page(&mut c, page, &source.row.tab, bold); }
                if placed.blank_after { c.add_page(612.0, 792.0); }
                let decorate = |c: &mut Composer, page: usize, index: usize, links: &mut Vec<(usize, [f64; 4], Target)>| {
                    if Some(&index) == source.page_indices.first() {
                        if let Some(header) = &source.header { c.stamp(page, &pdf_text(header), None, regular, Position::TopCentre, 8.0, 72.0, 24.0); }
                        // The link as a header line of its own, in the size that fits the page's width, under a link to it.
                        if let Some(link) = &source.link {
                            let text = pdf_text(link);
                            let ([_, _, width, height], rotation) = c.frame(page);
                            let room = if rotation % 180 != 0 { height } else { width } - 72.0;
                            let size = (8.0 * room / c.width(regular, &text, 8.0)).clamp(5.0, 8.0);
                            let rect = c.stamp(page, &text, None, regular, Position::TopCentre, size, 36.0, 24.0);
                            links.push((page, rect, Target::Uri(link.clone())));
                        }
                    }
                    decorate_reference(c, page, source, bold, links);
                };
                if source.parts.is_empty() {
                    // So the PDF can be put in its place later.
                    let page = c.add_page(612.0, 792.0);
                    missing_page(&mut c, page, &source.row, None, federal);
                    decorate(&mut c, page, source.page_indices.first().copied().unwrap_or(0), &mut links);
                    continue;
                }
                // The kept pages, each from the part that holds it.
                let pdf = &pdfs[placed.slice.source];
                for (part_index, (bytes, offset)) in pdf.parts.iter().enumerate() {
                    let end = pdf.parts.get(part_index + 1).map_or(pdf.count, |p| p.1);
                    let wanted: Vec<usize> = placed.slice.pages.iter().filter(|p| **p >= *offset && **p < end).copied().collect();
                    if wanted.is_empty() { continue; }
                    let pages: Vec<usize> = match bytes {
                        Some(bytes) => c.append(bytes, Some(&wanted.iter().map(|p| p - offset).collect::<Vec<_>>())).map_err(|e| e.to_string())?.0,
                        None => {
                            let page = c.add_page(612.0, 792.0);
                            if let BookPart::Missing { detail, federal } = &source.parts[part_index] { missing_page(&mut c, page, &source.row, detail.as_deref(), *federal); }
                            vec![page]
                        }
                    };
                    for (page, index) in pages.into_iter().zip(wanted) {
                        if let Some(text) = source.ocr_text_by_page.as_ref().and_then(|t| t.get(index)) { c.ocr_text(page, regular, &pdf_text(text)); }
                        decorate(&mut c, page, index, &mut links);
                    }
                }
            }
            if back_pages > 0 {
                let page = c.add_page(612.0, 792.0);
                if let Some(paper) = &book.paper_cover { c.rect(page, [0.0, 0.0, 612.0, 792.0], Some(paper.rgb), None, None); }
                if multi && limits.cover_labels { c.text(page, bold, &volume_label, margin, 400.0, 12.0, BLACK); }
            }
        }
        // Where the index gives tabs, a viewer's page box gives them too ("Tab 3-2" is the second page of Tab 3);
        // where it gives book pages, the box gives those.
        if federal || show_pages { c.set_labels(vec![(0, Label::decimal(plan.global_start as i64 + 1))]); } else {
            let mut labels = vec![(0, Label::prefix("Cover", None))];
            if !index_chunks.is_empty() || custom_index.is_some() { labels.push((book.cover_page_count, Label::prefix("Index ", Some(1)))); }
            for placed in &plan.slices {
                let source = &book.sources[placed.slice.source];
                let tab = pdf_normalized(&source.row.tab);
                if placed.blank_before { labels.push((placed.tab_start - 1, Label::prefix(format!("{tab} blank"), None))); }
                if placed.tabbed { labels.push((placed.tab_start, Label::prefix(tab.clone(), None))); }
                if placed.blank_after { labels.push((placed.tab_start + 1, Label::prefix(format!("{tab} blank"), None))); }
                let first = source.page_indices.iter().position(|p| Some(p) == placed.slice.pages.first()).map_or(0, |p| p + 1);
                labels.push((placed.local_start, Label::prefix(format!("{tab}-"), Some(first as i64))));
            }
            if back_pages > 0 && !front_only { labels.push((c.page_count() - 1, Label::prefix("Back cover", None))); }
            labels.retain(|(at, _)| *at < c.page_count());
            c.set_labels(labels);
        }
        if federal && book.electronic {
            for page in 0..c.page_count() {
                let number = plan.global_start + page + 1;
                c.stamp(page, &number.to_string(), Some(number as i64), regular, Position::BottomRight, 12.0, 99.21, 54.0);
            }
        }
        for (page, rect, target) in links { c.link(page, rect, target); }
        if !front_only {
            let mut outline = vec![Outline::page(book.document_title.clone(), 0, cover_outline.to_vec())];
            if !index_chunks.is_empty() || custom_index.is_some() {
                let offset = book.cover_page_count;
                outline.push(Outline::page(index_title, index_start, map_outline(index_outline, &|p| Some(offset + p))));
            }
            for group in &book.groups {
                let tabs: Vec<Outline> = group.entries.iter().filter(|e| tab_starts.contains_key(e.key.as_str())).filter_map(|entry| {
                    let placed = plan.slices.iter().find(|p| book.sources[p.slice.source].row.key == entry.key)?;
                    let source = &book.sources[placed.slice.source];
                    let page = |p: usize| placed.slice.pages.iter().position(|q| *q == p).map(|offset| placed.local_start + offset);
                    let marks: Vec<Outline> = source.bookmarks.iter().map(|b| Outline::page(b.title.clone(), b.page_index, Vec::new())).collect();
                    let mut children = map_outline(&outlines[placed.slice.source], &page);
                    children.extend(map_outline(&marks, &page));
                    Some(Outline::page(format!("{} – {}", entry.tab, entry.name), tab_starts[entry.key.as_str()], children))
                }).collect();
                if tabs.is_empty() { continue; }
                if grouped { outline.push(Outline::page(group.label.clone(), tabs[0].page_index.unwrap_or(0), tabs)); } else { outline.extend(tabs); }
            }
            c.set_outline(outline, true);
        }
        let pages = c.page_count();
        let bytes = c.save(&Meta { title: &book.document_title, subject: "Navigable book of legal authorities", creator: "Beaver", producer: "Beaver", lang: Some("en-CA"), xmp: true }, true)
            .map_err(|e| e.to_string())?;
        built.push((bytes, pages));
    }
    Ok((built, placements))
}

fn margin(federal: bool) -> f64 { if federal { 99.21 } else { 72.0 } }

#[allow(clippy::too_many_arguments)]
fn draw_runs(c: &mut Composer, page: usize, runs: &[Run], mut x: f64, y: f64, size: f64, roman: usize, italic: usize, rgb: Rgb) {
    for (text, slanted) in runs {
        let font = if *slanted { italic } else { roman };
        c.text(page, font, text, x, y, size, rgb);
        x += c.width(font, text, size);
    }
}

/// The court's extract names the database holding the decision in full, boxed on each page.
fn decorate_reference(c: &mut Composer, page: usize, source: &BookSource, bold: usize, links: &mut Vec<(usize, [f64; 4], Target)>) {
    let Some(reference) = &source.database_reference else { return };
    let ([cx, cy, _, ch], _) = c.frame(page);
    let label = pdf_text(&format!("FREE PUBLIC DATABASE: {}", reference.host));
    let width = c.width(bold, &label, 12.0) + 10.0;
    let (x, y) = (cx + 99.21, cy + ch - 80.0);
    c.rect(page, [x - 5.0, y - 3.0, width, 18.0], Some([1.0; 3]), Some(([0.15; 3], 0.6)), Some(0.94));
    c.text(page, bold, &label, x, y, 12.0, [0.08; 3]);
    links.push((page, [x - 5.0, y - 3.0, x - 5.0 + width, y + 15.0], Target::Uri(reference.url.clone())));
}

/// The page standing in for an authority without a PDF: its name in bold, its style of cause in bold italic, and what
/// is missing ("French version").
fn missing_page(c: &mut Composer, page: usize, row: &BookRow, detail: Option<&str>, federal: bool) {
    let faces = if federal { [Face::TimesBold, Face::TimesBoldItalic, Face::Times] } else { [Face::ArialBold, Face::ArialBoldItalic, Face::Arial] };
    let [bold, bold_italic, regular] = faces.map(|face| c.font(face));
    let (margin, size) = (margin(federal), if federal { 12.0 } else { 14.0 });
    let mut y = 620.0;
    for line in citation_lines(c.face(bold), c.face(bold_italic), &row.name, row.italic, size, 612.0 - 2.0 * margin) {
        draw_runs(c, page, &line, margin, y, size, bold, bold_italic, BLACK);
        y -= size + 6.0;
    }
    if let Some(detail) = detail { c.text(page, regular, &pdf_text(detail), margin, y - 6.0, 12.0, BLACK); }
}

/// The page that opens an authority: its tab, large and alone.
fn tab_page(c: &mut Composer, page: usize, tab: &str, font: usize) {
    let text = pdf_text(tab).to_uppercase();
    let size = 54f64.min(468.0 / c.width(font, &text, 1.0).max(1.0));
    c.text(page, font, &text, (612.0 - c.width(font, &text, size)) / 2.0, 396.0 - size / 3.0, size, BLACK);
}

/// The Federal Courts Rules' Form 66 cover: the file number, the court, the parties and their roles, what the
/// application is under, the title and who files it. The file number, the parties and the title are fields.
fn form_66(c: &mut Composer, page: usize, regular: usize, bold: usize, book: &PreparedBook, color: Rgb) -> Result<f64, String> {
    let (margin, width, height, flatten) = (99.21, 612.0, 792.0, book.front_only);
    let clean = |value: &str| -> Result<String, String> {
        let text = pdf_normalized(value);
        if text.chars().any(|c| !matches!(c, '\t' | '\n' | '\r' | ' '..='~' | '\u{a0}'..='\u{ff}')) {
            return Err("The Federal cover contains characters unavailable in the prescribed court fonts.".into());
        }
        Ok(text)
    };
    let (rf, bf) = (c.face(regular), c.face(bold));
    let centred = |c: &mut Composer, value: &str, y: f64, font: usize| -> Result<(), String> {
        let text = clean(value)?;
        c.text(page, font, &text, (width - c.width(font, &text, 12.0)) / 2.0, y, 12.0, color);
        Ok(())
    };
    let cover = &book.cover;
    let (file, label) = (clean(&cover.court_file_number)?, "Court File No. ");
    let file_x = width - margin - rf.width(&format!("{label}{file}"), 12.0) + rf.width(label, 12.0);
    c.text(page, regular, label.trim(), file_x - rf.width(label, 12.0), height - 78.0, 12.0, color);
    c.field(page, "Court file number", &[(file, file_x, height - 78.0)], [file_x - 1.0, height - 82.0, (width - margin - file_x + 1.0).max(80.0), 16.0], regular, 12.0, false, color, flatten);
    centred(c, &book.court, height - 118.0, bold)?;
    c.text(page, regular, "BETWEEN:", margin, height - 157.0, 12.0, color);
    let mut y = height - 193.0;
    for (index, group) in cover.party_groups.iter().enumerate() {
        let names = wrapped(rf, &clean(&group.parties.join(", "))?, 12.0, width - 2.0 * margin);
        let lines: Vec<(String, f64, f64)> = names.iter().enumerate().map(|(line, n)| (n.clone(), (width - rf.width(n, 12.0)) / 2.0, y - line as f64 * 14.0)).collect();
        let count = names.len() as f64;
        c.field(page, &format!("Parties {}", index + 1), &lines, [margin - 4.0, y - 14.0 * (count - 1.0) - 5.0, width - 2.0 * margin + 8.0, 14.0 * count + 4.0], regular, 12.0, true, color, flatten);
        y -= 14.0 * count + 20.0;
        let role = clean(&group.role)?;
        c.text(page, regular, &role, width - margin - rf.width(&role, 12.0), y, 12.0, color);
        if index + 1 < cover.party_groups.len() { centred(c, "and", y - 26.0, regular)?; y -= 52.0; } else { y -= 32.0; }
    }
    if let Some(under) = cover.application_under.as_ref().filter(|u| !u.is_empty()) {
        for line in wrapped(rf, &clean(&format!("APPLICATION UNDER {under}"))?, 12.0, width - 2.0 * margin) { centred(c, &line, y, regular)?; y -= 15.0; }
        y -= 17.0;
    }
    y -= 8.0;
    let title = wrapped(bf, &clean(&book.document_title.to_uppercase())?, 12.0, width - 2.0 * margin);
    let lines: Vec<(String, f64, f64)> = title.iter().enumerate().map(|(i, l)| (l.clone(), (width - bf.width(l, 12.0)) / 2.0, y - i as f64 * 16.0)).collect();
    let count = title.len() as f64;
    c.field(page, "Title", &lines, [margin - 4.0, y - 16.0 * (count - 1.0) - 5.0, width - 2.0 * margin + 8.0, 16.0 * count + 4.0], bold, 12.0, true, color, flatten);
    y -= 16.0 * count;
    if let Some(filed_by) = &book.cover_line { y -= 10.0; centred(c, filed_by, y, regular)?; y -= 16.0; }
    if y < 135.0 { return Err("The Federal style of cause is too long for one Form 66 cover page.".into()); }
    Ok(y - 10.0)
}

/// The Alberta Rules of Court's cover (r 13.19): each value beside its label, the clerk's stamp box at the top right.
/// Its values but the court's name are fields.
fn alberta_cover(c: &mut Composer, page: usize, regular: usize, bold: usize, book: &PreparedBook) -> f64 {
    let (left, value_x, right, size, leading) = (72.0, 214.0, 540.0, 10.0, 13.0);
    let (stamp_x, stamp_top, stamp_bottom) = (396.0, 740.0, 596.0);
    c.rect(page, [stamp_x, stamp_bottom, right - stamp_x, stamp_top - stamp_bottom], None, Some((BLACK, 0.75)), None);
    let stamp = "Clerk's Stamp";
    c.text(page, regular, stamp, stamp_x + (right - stamp_x - c.width(regular, stamp, 8.0)) / 2.0, stamp_top - 12.0, 8.0, BLACK);
    let cover = &book.cover;
    let contact = cover.contact.as_ref().map_or(String::new(), |k| [Some(k.name.clone()), Some(k.address.clone()),
        (!k.phone.is_empty()).then(|| format!("Telephone: {}", k.phone)), (!k.fax.is_empty()).then(|| format!("Fax: {}", k.fax)), (!k.email.is_empty()).then(|| format!("Email: {}", k.email))]
        .into_iter().flatten().filter(|v| !v.is_empty()).collect::<Vec<_>>().join("\n"));
    // [label, value, the field it is in (none for the court's name), its font]
    let mut rows: Vec<(String, String, Option<String>, usize)> = vec![
        ("COURT FILE NUMBER".into(), cover.court_file_number.clone(), Some("Court file number".into()), regular),
        ("COURT".into(), book.court.clone(), None, regular),
        ("JUDICIAL CENTRE".into(), cover.judicial_centre.clone().unwrap_or_default().to_uppercase(), Some("Judicial centre".into()), regular)];
    if let Some(under) = cover.application_under.as_ref().filter(|u| !u.is_empty()) { rows.push(("MATTER".into(), under.clone(), Some("Matter".into()), regular)); }
    for (index, group) in cover.party_groups.iter().enumerate() { rows.push((group.role.to_uppercase(), group.parties.join("\n"), Some(format!("Parties {}", index + 1)), regular)); }
    rows.push(("DOCUMENT".into(), book.document_title.to_uppercase(), Some("Title".into()), bold));
    rows.push(("ADDRESS FOR SERVICE AND CONTACT INFORMATION OF PARTY FILING THIS DOCUMENT".into(), contact, Some("Address for service".into()), regular));
    let mut y = 724.0;
    for (label, value, field, font) in rows {
        // A value beside the stamp box stops short of it: its field's top, 10 points over its first line, too.
        let width = if y + 10.0 > stamp_bottom { stamp_x - 12.0 } else { right } - value_x;
        let labels = wrapped(c.face(bold), &label, 8.0, value_x - left - 14.0);
        let values = wrapped(c.face(font), &value, size, width);
        for (index, line) in labels.iter().enumerate() { c.text(page, bold, line, left, y - index as f64 * 10.0, 8.0, BLACK); }
        let lines: Vec<(String, f64, f64)> = values.iter().enumerate().map(|(i, l)| (l.clone(), value_x, y - i as f64 * leading)).collect();
        let count = values.len().max(1) as f64;
        match field {
            Some(name) => c.field(page, &name, &lines, [value_x - 2.0, y - count * leading + 8.0, width + 4.0, count * leading + 2.0], font, size, false, BLACK, book.front_only),
            None => for (line, x, line_y) in &lines { c.text(page, font, line, *x, *line_y, size, BLACK); },
        }
        y -= (labels.len() as f64 * 10.0).max(values.len() as f64 * leading) + 16.0;
    }
    y
}

/// An authority the filing's table lists: appended (its parts) where it has no public link.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct FilingEntry { #[serde(flatten)] pub row: BookRow, #[serde(default)] #[cfg_attr(feature = "binding-types", ts(as = "Option<Vec<BookPart>>", optional))] pub parts: Vec<BookPart> }

/// A filing PDF with its table of authorities after it: each authority in full, its link printed beneath it for a
/// reader on paper, linked to its PDF appended after the table or else to its address.
pub fn render_filing(filing: &[u8], entries: &[FilingEntry]) -> Result<(Vec<u8>, usize), String> {
    let mut c = Composer::new();
    let (regular, italic, bold) = (c.font(Face::Times), c.font(Face::TimesItalic), c.font(Face::TimesBold));
    c.append(filing, None).map_err(|_| "The imported filing PDF could not be opened.".to_owned())?;
    if c.page_count() == 0 { return Err("The imported filing PDF is empty.".into()); }
    let table_start = c.page_count();
    let mut rows = Vec::new();
    let (mut page, mut y) = (None, 0.0);
    for (index, entry) in entries.iter().enumerate() {
        let name = citation_lines(Face::Times, Face::TimesItalic, &entry.row.name, entry.row.italic, 10.0, 430.0);
        let url = entry.row.source_url.as_deref().map_or_else(Vec::new, |u| citation_lines(Face::Times, Face::TimesItalic, u, 0, 8.5, 430.0));
        let height = name.len() as f64 * 13.0 + url.len() as f64 * 11.0 + 10.0;
        if page.is_none() || y - height < 60.0 {
            let heading = if page.is_some() { "TABLE OF AUTHORITIES - CONTINUED" } else { "TABLE OF AUTHORITIES" };
            let next = c.add_page(612.0, 792.0);
            c.text(next, bold, heading, 54.0, 730.0, 16.0, BLACK);
            (page, y) = (Some(next), 690.0);
        }
        let at = page.expect("a table page");
        c.text(at, regular, &format!("{}.", index + 1), 54.0, y, 10.0, BLACK);
        for (line, runs) in name.iter().enumerate() { draw_runs(&mut c, at, runs, 82.0, y - line as f64 * 13.0, 10.0, regular, italic, BLACK); }
        let below = y - name.len() as f64 * 13.0;
        for (line, runs) in url.iter().enumerate() { draw_runs(&mut c, at, runs, 82.0, below - line as f64 * 11.0, 8.5, regular, italic, LINK_BLUE); }
        rows.push((at, [78.0, y - height + 12.0, 520.0, y + 12.0]));
        y -= height;
    }
    if entries.is_empty() { let at = c.add_page(612.0, 792.0); c.text(at, bold, "TABLE OF AUTHORITIES", 54.0, 730.0, 16.0, BLACK); }
    let mut starts = vec![None; entries.len()];
    for (index, entry) in entries.iter().enumerate() {
        for part in &entry.parts {
            let first = c.page_count();
            match part {
                BookPart::Pdf { bytes, .. } => { c.append(bytes, None).map_err(|e| e.to_string())?; }
                BookPart::Missing { detail, federal } => { let page = c.add_page(612.0, 792.0); missing_page(&mut c, page, &entry.row, detail.as_deref(), *federal); }
            }
            starts[index].get_or_insert(first);
        }
    }
    // An authority with neither a public link nor an appended PDF is listed without a link.
    for ((at, rect), (entry, start)) in rows.into_iter().zip(entries.iter().zip(&starts)) {
        match (start, &entry.row.source_url) { (Some(start), _) => c.link(at, rect, Target::Page(*start)), (None, Some(url)) => c.link(at, rect, Target::Uri(url.clone())), _ => {} }
    }
    let appended: Vec<Outline> = entries.iter().zip(&starts).filter_map(|(e, s)| Some(Outline::page(e.row.name.clone(), (*s)?, Vec::new()))).collect();
    let mut outline = vec![Outline::page("Filing document", 0, Vec::new()), Outline::page("Table of Authorities", table_start, Vec::new())];
    if let Some(first) = appended.first().and_then(|a| a.page_index) { outline.push(Outline::page("Appended authorities", first, appended)); }
    c.set_outline(outline, true);
    let pages = c.page_count();
    let out = c.save(&Meta { title: "Filing with Table of Authorities", subject: "", creator: "Beaver", producer: "Beaver", lang: None, xmp: false }, false).map_err(|e| e.to_string())?;
    Ok((out, pages))
}
/// The final PDF: the brief (`brief` long, first in the bytes), a blank page after it where the book starts on a
/// right-hand page, then each volume of the book under its title; the brief's own links to the book retargeted or taken
/// out, links added over its citations, and bookmarks: the brief's own (else its headings) and each volume's.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct FinalPlan { pub brief: usize, pub headings: Vec<BookHeading>, pub blank_page: bool, pub books: Vec<FinalBook>, pub relinks: Vec<FinalLink>, pub links: Vec<FinalLink> }

#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub struct FinalBook { pub bytes: usize, pub title: String }

/// A link on `page`: the brief's own to `uri` (none where it is new, over `rect`), to `to` (a page, at the top of the
/// part of it given in page fractions from its top left as displayed), or taken out where `to` is none.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
pub struct FinalLink { pub page: usize, #[serde(default)] pub uri: Option<String>, #[serde(default)] pub rect: Option<[f64; 4]>, pub to: Option<(usize, Option<[f64; 4]>)> }

pub fn render_final(plan: &FinalPlan, bytes: &[u8]) -> Result<(Vec<u8>, usize), String> {
    let (brief, mut rest) = bytes.split_at_checked(plan.brief).ok_or("The final PDF's parts are shorter than it says.")?;
    let mut c = Composer::open(brief).map_err(|_| "The brief PDF could not be opened for final export.".to_owned())?;
    if c.page_count() == 0 { return Err("The brief PDF is empty.".into()); }
    let own = read_outline(brief, 0).map_err(|e| e.to_string())?;
    let brief_outline = if own.is_empty() { nested_outline(plan.headings.iter().map(|h| (h.title.clone(), h.level, h.page_index))) } else { own };
    let mut outline = vec![Outline::page("Brief", 0, brief_outline)];
    if plan.blank_page { let ([_, _, w, h], _) = c.frame(c.page_count() - 1); c.add_page(w, h); }
    for book in &plan.books {
        let (pdf, after) = rest.split_at_checked(book.bytes).ok_or("The final PDF's parts are shorter than it says.")?;
        rest = after;
        let offset = c.page_count();
        outline.push(Outline::page(book.title.clone(), offset, read_outline(pdf, offset).map_err(|e| e.to_string())?));
        c.append(pdf, None).map_err(|e| e.to_string())?;
    }
    let target = |c: &Composer, (page, rect): (usize, Option<[f64; 4]>)| match rect.and_then(|rect| c.top(page, rect)) {
        Some(top) => Target::At(page, top), None => Target::Page(page) };
    for link in &plan.relinks { if let Some(uri) = &link.uri { c.relink(link.page, uri, link.to.map(|to| target(&c, to))).map_err(|e| e.to_string())?; } }
    for link in &plan.links { if let (Some(rect), Some(to)) = (link.rect, link.to) { let to = target(&c, to); c.link(link.page, rect, to); } }
    c.set_outline(outline, true);
    let pages = c.page_count();
    let out = c.save(&Meta { title: "Brief and Book of Authorities", subject: "Brief and its book of legal authorities", creator: "Beaver", producer: "Beaver", lang: None, xmp: true }, true)
        .map_err(|e| e.to_string())?;
    Ok((out, pages))
}