//! A court record as the Court Records builder files it: its parts joined into one PDF, an affidavit with its exhibits
//! (each behind its certificate), or a record in volumes, each with its cover and index, numbered, labelled,
//! bookmarked and linked, and divided where the court limits a filing's pages or bytes.
use crate::dispatch::{Buffer, Bytes};
use legalpdf::compose::{map_outline, page_frames, read_outline, Composer, Face, Label, Meta, Outline, Position, Rgb, Target};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ops::Range;
use unicode_normalization::UnicodeNormalization;

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum CourtLayout { Pdf, Affidavit, Record }

/// A record to file. `fonts`: the fonts a character the standard ones lack is set in; none where only the court's
/// permitted fonts may be used.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct CourtRecord {
    pub layout: CourtLayout,
    pub filename: String,
    pub title: String,
    pub items: Vec<CourtItem>,
    pub technical: Technical,
    pub colour: String,
    pub cover: Option<CourtCover>,
    pub certificate: Option<Certificate>,
    pub form344: Option<Form344>,
    pub fonts: Option<Vec<Bytes>>,
}

/// A document of the record. Untitled (a PDF's one part), its own bookmarks stand at the outline's root. `output`: a
/// saved output, whose bookmarks are documents the index lists; `described`: a physical exhibit, its title set as its
/// description; `certificate`: the exhibit label whose certificate goes before it.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct CourtItem {
    pub title: String,
    pub tab: usize,
    pub group: Option<String>,
    pub date: Option<String>,
    pub bytes: Option<Bytes>,
    pub ocr_text_by_page: Vec<String>,
    pub output: bool,
    pub described: bool,
    pub form344: bool,
    pub certificate: Option<String>,
}

/// The court's technical requirements, as its profile states them.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct Technical {
    pub page_number_position: Position,
    pub page_number_size: Option<f64>,
    pub page_number_inset: Option<f64>,
    pub page_number_offset: Option<f64>,
    pub bookmarks_panel_open: bool,
    pub index_style: Option<String>,
    pub index_title: Option<String>,
    pub index_document_label: Option<String>,
    pub index_rows_per_page: Option<f64>,
    pub index_date: Option<String>,
    pub max_output_bytes: Option<usize>,
    pub max_output_pages: Option<usize>,
    pub volume_instructions: Option<String>,
    pub complete_index_each_volume: Option<bool>,
    pub volume_label_on_back_cover: Option<bool>,
}

#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub struct CoverGroup { pub names: String, pub role: String }

/// The Federal Courts' heading: the file number, the court, the parties in their roles, what an application is under.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
pub struct FederalHeading { pub number: String, pub court: String, pub groups: Vec<CoverGroup>, pub under: Option<String> }

/// A record's cover, its values as the filer gave them. `contacts`: the Federal record's two columns of (line, bold);
/// `filing` and `others`: the Alberta AP-5's lawyers' blocks.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(tag = "template", rename_all = "kebab-case")]
pub enum CourtCover {
    Generic { court: String, groups: Vec<CoverGroup>, title: String, number: String, filer: String },
    FederalRecord { heading: FederalHeading, title: String, subtitles: Vec<String>, contacts: Vec<Vec<(String, bool)>> },
    AbcaAp5 { rows: Vec<(String, String)>, rule: String, decision: Vec<String>, title: String, filing: Vec<String>, others: Vec<Vec<String>> },
}

/// What an exhibit's certificate names: the deponent and the date sworn, in Alberta's form or the Federal Courts'.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub struct Certificate { pub deponent: String, pub date: String, pub alberta: bool }

/// The Federal Courts' Form 344, the appeal book's certificate of completeness.
#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
pub struct Form344 { pub heading: FederalHeading, pub name: String, pub contact: Vec<String> }

#[derive(Serialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CourtPdf { pub filename: String, pub page_count: usize, pub bytes: Buffer }

const W: f64 = 612.0;
const H: f64 = 792.0;
const MARGIN: f64 = 99.21; // 3.5 cm, Federal Courts Rule 65(b)
const INK: Rgb = [0.05; 3];
const BLACK: Rgb = [0.0; 3];
const LINES_PER_DESCRIPTION: usize = 36;
const COVER_SPACE: &str = "The style of cause and filing details do not fit the prescribed one-page cover.";

pub fn render_court_record(record: &CourtRecord) -> Result<Vec<CourtPdf>, String> {
    let own: Vec<(usize, Vec<Outline>)> = record.items.iter().map(|item| match item.bytes.as_deref() {
        Some(pdf) => Ok((page_frames(pdf).map_err(|e| e.to_string())?.len(), read_outline(pdf, 0).map_err(|e| e.to_string())?)),
        None => Ok((0, Vec::new())),
    }).collect::<Result<_, String>>()?;
    let numbers = |pen: &mut Pen, start: usize| pen.number(&record.technical, start);
    match record.layout {
        CourtLayout::Pdf => {
            let mut pen = Pen::new(record, Face::Helvetica)?;
            let mut outline = Vec::new();
            for (item, (pages, mine)) in record.items.iter().zip(&own) {
                let start = pen.append(item, 0..*pages)?;
                let children = map_outline(mine, &|p| Some(start + p));
                if item.title.is_empty() { outline.extend(children); } else { outline.push(Outline::page(item.title.clone(), start, children)); }
            }
            Ok(vec![pen.save(record, record.filename.clone(), outline)?])
        }
        CourtLayout::Affidavit => {
            let mut pen = Pen::new(record, Face::Times)?;
            let mut outline = Vec::new();
            for (item, (pages, mine)) in record.items.iter().zip(&own) {
                if let (Some(label), Some(certificate)) = (&item.certificate, &record.certificate) {
                    let page = pen.c.add_page(W, H);
                    outline.push(Outline::page(format!("Exhibit {label} certificate"), page, Vec::new()));
                    pen.certificate(page, certificate, label);
                }
                let start = pen.append(item, 0..*pages)?;
                outline.push(Outline::page(item.title.clone(), start, map_outline(mine, &|p| Some(start + p))));
            }
            numbers(&mut pen, 1);
            Ok(vec![pen.save(record, record.filename.clone(), outline)?])
        }
        CourtLayout::Record => Volumes::of(record, &own)?.render(),
    }
}

/// A document's place in a volume: its source pages (a part of them where it was divided) or its description's lines.
#[derive(Clone)]
struct Entry { id: usize, item: usize, title: String, pages: Range<usize>, lines: Range<usize>, bytes: usize }

/// A line of the index: a document (a part of its title where long), or one of the documents its bookmarks name.
struct Row { id: usize, tab: Option<usize>, lines: Vec<String>, group: Option<String>, offset: Option<usize>, pages: usize, date: Option<String> }

struct Volumes<'a> { record: &'a CourtRecord, own: &'a [(usize, Vec<Outline>)], descriptions: Vec<Vec<String>>, ids: usize, style: &'a str, plans: Vec<Vec<Entry>> }

impl<'a> Volumes<'a> {
    fn of(record: &'a CourtRecord, own: &'a [(usize, Vec<Outline>)]) -> Result<Self, String> {
        let mut pen = Pen::new(record, Face::Helvetica)?;
        let descriptions = record.items.iter().map(|item| if item.described { pen.wrap(pen.times, &item.title, 12.0, W - 2.0 * MARGIN, false) } else { Vec::new() }).collect();
        let style = record.technical.index_style.as_deref().unwrap_or("standard");
        let mut volumes = Self { record, own, descriptions, ids: 0, style, plans: Vec::new() };
        let entries: Vec<Entry> = (0..record.items.len()).map(|item| {
            let lines = 0..volumes.descriptions[item].len();
            volumes.entry(item, record.items[item].title.clone(), 0..own[item].0, lines, record.items[item].bytes.as_ref().map_or(0, |b| b.len()))
        }).collect();
        volumes.plans = volumes.plan(&mut pen, entries);
        Ok(volumes)
    }

    fn entry(&mut self, item: usize, title: String, pages: Range<usize>, lines: Range<usize>, bytes: usize) -> Entry {
        self.ids += 1;
        Entry { id: self.ids, item, title, pages, lines, bytes }
    }

    fn page_count(&self, entry: &Entry) -> usize {
        let item = &self.record.items[entry.item];
        if item.form344 { 1 } else if item.described { entry.lines.len().div_ceil(LINES_PER_DESCRIPTION) } else { entry.pages.len() }
    }

    /// The index's lines for `entries`, measured in the index's type.
    fn rows(&self, pen: &mut Pen, entries: &[Entry]) -> Vec<Row> {
        let (font, size, width, most) = match self.style { "federal" => (pen.times, 12.0, 297.0, 20), "abca" => (pen.helvetica, 12.0, 400.0, 20), _ => (pen.helvetica, 8.5, 322.0, 40) };
        let dated = self.style == "abca" || self.style == "federal" && self.record.technical.index_date.as_deref() != Some("none");
        let mut rows = Vec::new();
        for entry in entries {
            let item = &self.record.items[entry.item];
            let mut lines = pen.wrap(font, &entry.title, size, width, false);
            if let Some(date) = item.date.as_ref().filter(|d| dated && !d.is_empty()) { lines.push(format!("Dated {date}")); }
            let pages = self.page_count(entry);
            let row = |lines: &[String], tab, offset, pages, date| Row { id: entry.id, tab, lines: lines.to_vec(), group: item.group.clone(), offset, pages, date };
            rows.extend(lines.chunks(most).map(|part| row(part, Some(item.tab), None, pages, item.date.clone())));
            let marks: Vec<&Outline> = self.own[entry.item].1.iter().filter(|o| o.page_index.is_some_and(|p| entry.pages.contains(&p))).collect();
            let exhibits = marks.iter().any(|o| o.title.get(..7).is_some_and(|t| t.eq_ignore_ascii_case("exhibit")) && !o.title[7..].starts_with(|c: char| c.is_alphanumeric()));
            if marks.len() > 1 && (item.output || exhibits) {
                for mark in marks {
                    let offset = mark.page_index.unwrap_or(0) - entry.pages.start;
                    rows.extend(pen.wrap(font, &mark.title, size, width - 14.0, false).chunks(most).map(|part| row(part, None, Some(offset), 1, None)));
                }
            }
        }
        rows
    }

    /// The index's pages: rows taken while they fit, a group's heading counted with its first row.
    fn chunks(&self, rows: Vec<Row>) -> Vec<Vec<Row>> {
        let (per_page, group) = (self.record.technical.index_rows_per_page.unwrap_or(25.0), match self.style { "federal" => 22.0 / 32.0, "abca" => 1.0, _ => 21.0 / 24.0 });
        let units = |row: &Row| {
            let lines = row.lines.len().max(1) as f64;
            match self.style { "federal" => (lines * 15.0 + 10.0).max(32.0) / 32.0, "abca" => 1.0 + (lines - 2.0).max(0.0) * 16.0 / 39.6, _ => (lines * 11.0 + 13.0).max(24.0) / 24.0 }
        };
        let (mut chunks, mut chunk, mut used, mut last): (Vec<Vec<Row>>, Vec<Row>, f64, Option<String>) = (Vec::new(), Vec::new(), 0.0, None);
        for row in rows {
            let heading = |last: &Option<String>| if row.group.is_some() && row.group != *last { group } else { 0.0 };
            if !chunk.is_empty() && used + heading(&last) + units(&row) > per_page { chunks.push(std::mem::take(&mut chunk)); used = 0.0; last = None; }
            used += heading(&last) + units(&row);
            last = row.group.clone();
            chunk.push(row);
        }
        chunks.push(chunk);
        chunks
    }

    /// Volumes within the court's page and byte limits, as the documents' own sizes estimate them.
    fn plan(&self, pen: &mut Pen, entries: Vec<Entry>) -> Vec<Vec<Entry>> {
        const OVERHEAD: usize = 160_000;
        let t = &self.record.technical;
        let total = entries.iter().map(|e| e.bytes).sum::<usize>() + OVERHEAD;
        let max_bytes = t.max_output_bytes.filter(|max| total > *max).map(|max| (max as f64 * 0.92).floor() as usize);
        if t.max_output_pages.is_none() && max_bytes.is_none() { return vec![entries]; }
        let (tail, sources): (Vec<Entry>, Vec<Entry>) = entries.into_iter().partition(|e| self.record.items[e.item].form344);
        let mut volumes: Vec<Vec<Entry>> = Vec::new();
        let (mut current, mut pages, mut bytes) = (Vec::new(), 0, OVERHEAD);
        for entry in sources {
            let mut next = current.clone();
            next.push(entry.clone());
            let front = usize::from(self.record.cover.is_some()) + self.chunks(self.rows(pen, &next)).len();
            let count = self.page_count(&entry);
            let full = !current.is_empty() && (t.max_output_pages.is_some_and(|max| pages + count + front > max) || max_bytes.is_some_and(|max| bytes + entry.bytes > max));
            if full { volumes.push(std::mem::take(&mut current)); pages = 0; bytes = OVERHEAD; }
            pages += count;
            bytes += entry.bytes;
            current.push(entry);
        }
        if !current.is_empty() || volumes.is_empty() { volumes.push(current); }
        volumes.last_mut().expect("a volume").extend(tail);
        volumes
    }

    /// An oversized volume in two: its documents halved by their bytes, or its one document by its pages.
    fn split(&mut self, plan: &[Entry]) -> Option<[Vec<Entry>; 2]> {
        let (tail, sources): (Vec<Entry>, Vec<Entry>) = plan.iter().cloned().partition(|e| self.record.items[e.item].form344);
        let [mut first, mut second] = if sources.len() > 1 {
            let total: usize = sources.iter().map(|e| e.bytes.max(1)).sum();
            let (mut running, mut at, mut best) = (0, 1, usize::MAX);
            for index in 1..sources.len() {
                running += sources[index - 1].bytes.max(1);
                let distance = total.abs_diff(2 * running);
                if distance < best { best = distance; at = index; }
            }
            [sources[..at].to_vec(), sources[at..].to_vec()]
        } else {
            let entry = sources.first()?;
            let pages = self.page_count(entry);
            if self.record.items[entry.item].described && pages > 1 {
                let middle = entry.lines.start + pages.div_ceil(2) * LINES_PER_DESCRIPTION;
                let part = |v: &mut Self, lines| v.entry(entry.item, entry.title.clone(), 0..0, lines, 0);
                [vec![part(self, entry.lines.start..middle)], vec![part(self, middle..entry.lines.end)]]
            } else {
                let (start, end) = (entry.pages.start, entry.pages.end);
                if self.record.items[entry.item].bytes.is_none() || end - start < 2 { return None; }
                let middle = start + (end - start).div_ceil(2);
                let base = &self.record.items[entry.item].title;
                let mut part = |from: usize, to: usize| {
                    let bytes = (entry.bytes as f64 * (to - from) as f64 / (end - start) as f64).ceil() as usize;
                    self.entry(entry.item, format!("{base} — source pages {}–{to}", from + 1), from..to, 0..0, bytes)
                };
                [vec![part(start, middle)], vec![part(middle, end)]]
            }
        };
        if first.is_empty() || second.is_empty() { return None; }
        second.extend(tail);
        first.shrink_to_fit();
        Some([first, second])
    }

    fn filename(&self, number: usize, count: usize) -> String {
        let name = &self.record.filename;
        match name.len().checked_sub(4).filter(|at| count > 1 && name.is_char_boundary(*at) && name[*at..].eq_ignore_ascii_case(".pdf")) {
            Some(at) => format!("{}-Volume-{number}-of-{count}.pdf", &name[..at]),
            None => name.clone(),
        }
    }

    /// Every volume, divided again while one is over the court's limits and its instructions allow it.
    fn render(mut self) -> Result<Vec<CourtPdf>, String> {
        let t = &self.record.technical;
        loop {
            let built = self.build()?;
            let oversized = built.iter().position(|pdf| t.max_output_pages.is_some_and(|max| pdf.page_count > max) || t.max_output_bytes.is_some_and(|max| pdf.bytes.0.len() > max));
            let Some(at) = oversized else { return Ok(built) };
            let plan = self.plans[at].clone();
            let Some(halves) = t.volume_instructions.as_ref().and_then(|_| self.split(&plan)) else {
                let pdf = &built[at];
                return Err(match t.max_output_bytes.filter(|max| pdf.bytes.0.len() > *max) {
                    Some(max) => format!("{} is larger than the court's {} MB filing limit. Reduce that source file before building.", pdf.filename, (max as f64 / 1_048_576.0).round()),
                    None => format!("{} exceeds the court's {}-page limit. Reduce or divide the source material before building.", pdf.filename, t.max_output_pages.unwrap_or(0)),
                });
            };
            self.plans.splice(at..=at, halves);
        }
    }

    fn build(&self) -> Result<Vec<CourtPdf>, String> {
        let (record, t, count) = (self.record, &self.record.technical, self.plans.len());
        let cover = usize::from(record.cover.is_some());
        let back = usize::from(count > 1 && t.volume_label_on_back_cover == Some(true));
        let complete = t.complete_index_each_volume == Some(true);
        let mut measure = Pen::new(record, Face::Helvetica)?;
        let all: Vec<Entry> = self.plans.concat();
        let whole = complete.then(|| self.rows(&mut measure, &all));
        // Each document's printed pages, numbered on from volume to volume.
        let (mut ranges, mut starts, mut next) = (HashMap::new(), Vec::new(), 1);
        let mut indexes = Vec::new();
        for plan in &self.plans {
            let rows = match &whole { Some(_) => self.rows(&mut measure, &all), None => self.rows(&mut measure, plan) };
            let chunks = self.chunks(rows);
            starts.push(next);
            let mut at = next + cover + chunks.len();
            for entry in plan { let pages = self.page_count(entry); ranges.insert(entry.id, (at, (at + pages).saturating_sub(1), pages)); at += pages; }
            next = at + back;
            indexes.push(chunks);
        }
        let mut built = Vec::new();
        for (volume, (plan, chunks)) in self.plans.iter().zip(indexes).enumerate() {
            let (start, number) = (starts[volume], volume + 1);
            let mut pen = Pen::new(record, Face::Helvetica)?;
            let colour = hex(&record.colour);
            if let Some(drawn) = &record.cover {
                let page = pen.c.add_page(W, H);
                pen.c.rect(page, [0.0, 0.0, W, H], Some(colour), None, None);
                pen.cover(page, drawn, number, count)?;
            }
            let local: HashMap<usize, ()> = plan.iter().map(|e| (e.id, ())).collect();
            let mut links = Vec::new();
            let pages = chunks.len();
            for (index, chunk) in chunks.iter().enumerate() {
                let page = pen.c.add_page(W, H);
                let view = IndexPage { t, colour, page, start, ranges: &ranges, local: &local, volume: (number, count), index: (index, pages) };
                match self.style { "federal" => pen.federal_index(&view, chunk, &mut links), "abca" => pen.abca_index(&view, chunk, &mut links), _ => pen.standard_index(&view, chunk, &mut links) }
            }
            let mut outline = vec![Outline::page(t.index_title.clone().unwrap_or_else(|| "Table of contents".into()), cover, Vec::new())];
            let mut groups: HashMap<String, usize> = HashMap::new();
            for entry in plan {
                let item = &record.items[entry.item];
                let first = pen.c.page_count();
                if item.described {
                    let lines = &self.descriptions[entry.item][entry.lines.clone()];
                    for (index, part) in lines.chunks(LINES_PER_DESCRIPTION).enumerate() { let page = pen.c.add_page(W, H); pen.description(page, part, index); }
                } else if item.form344 {
                    let page = pen.c.add_page(W, H);
                    if let Some(form) = &record.form344 { pen.form_344(page, form)?; }
                } else if item.bytes.is_some() {
                    pen.append(item, entry.pages.clone())?;
                } else { continue; }
                let range = entry.pages.clone();
                let children = map_outline(&self.own[entry.item].1, &|p| range.contains(&p).then(|| first + p - range.start));
                let node = Outline::page(entry.title.clone(), first, children);
                match &item.group {
                    None => outline.push(node),
                    Some(group) => match groups.get(group) {
                        Some(at) => outline[*at].children.push(node),
                        None => { groups.insert(group.clone(), outline.len()); outline.push(Outline::page(group.clone(), first, vec![node])); }
                    },
                }
            }
            if back > 0 {
                let page = pen.c.add_page(W, H);
                pen.c.rect(page, [0.0, 0.0, W, H], Some(colour), None, None);
                pen.centred(page, &format!("VOLUME {number} OF {count}"), H / 2.0, pen.times_bold, 12.0, BLACK);
            }
            pen.number(t, start);
            for (page, rect, target) in links { pen.c.link(page, rect, Target::Page(target)); }
            built.push(pen.save(record, self.filename(number, count), outline)?);
        }
        Ok(built)
    }
}

/// What an index page is drawn with: where each document's pages are, which are in this volume, and which page of
/// how many in which volume of how many it is.
struct IndexPage<'a> { t: &'a Technical, colour: Rgb, page: usize, start: usize, ranges: &'a HashMap<usize, (usize, usize, usize)>, local: &'a HashMap<usize, ()>, volume: (usize, usize), index: (usize, usize) }

impl IndexPage<'_> {
    /// The row's printed pages ("" for none), joined by `dash`, and the page a link to it opens where it is here.
    fn pages(&self, row: &Row, dash: &str) -> (String, Option<usize>) {
        let (first, last, _) = self.ranges[&row.id];
        let (first, last) = match row.offset { Some(offset) => (first + offset, first + offset), None => (first, last) };
        let shown = if row.pages == 0 { String::new() } else if first == last { first.to_string() } else { format!("{first}{dash}{last}") };
        (shown, (row.pages > 0 && self.local.contains_key(&row.id)).then(|| first - self.start))
    }
}

type Links = Vec<(usize, [f64; 4], usize)>;

/// Draws a record's pages: in the standard fonts, a character they lack in the first fallback font that has it.
struct Pen { c: Composer, fallbacks: Option<Vec<usize>>, failed: Option<String>, ocr: usize, times: usize, times_bold: usize, helvetica: usize, helvetica_bold: usize }

impl Pen {
    fn new(record: &CourtRecord, ocr: Face) -> Result<Self, String> {
        let mut c = Composer::new();
        let fallbacks = record.fonts.as_ref().map(|fonts| fonts.iter().map(|font| c.font_file(font.0.clone())).collect::<Result<Vec<_>, _>>()).transpose().map_err(|e| e.to_string())?;
        let [ocr, times, times_bold, helvetica, helvetica_bold] = [ocr, Face::Times, Face::TimesBold, Face::Helvetica, Face::HelveticaBold].map(|face| c.font(face));
        Ok(Self { c, fallbacks, failed: None, ocr, times, times_bold, helvetica, helvetica_bold })
    }

    /// The source's pages (`pages` of it), each with its recognized text; where they begin.
    fn append(&mut self, item: &CourtItem, pages: Range<usize>) -> Result<usize, String> {
        let first = self.c.page_count();
        let Some(bytes) = &item.bytes else { return Ok(first) };
        let wanted: Vec<usize> = pages.collect();
        let (copied, _) = self.c.append(bytes, Some(&wanted)).map_err(|e| e.to_string())?;
        for (page, index) in copied.into_iter().zip(wanted) {
            if let Some(text) = item.ocr_text_by_page.get(index) { self.c.ocr_text(page, self.ocr, text); }
        }
        Ok(first)
    }

    /// Each page's number from `start`, as Acrobat stamps them, with page labels that match.
    fn number(&mut self, t: &Technical, start: usize) {
        let font = if t.index_style.as_deref() == Some("abca") { self.helvetica } else { self.times };
        for page in 0..self.c.page_count() {
            let number = start + page;
            self.c.stamp(page, &number.to_string(), Some(number as i64), font, t.page_number_position, t.page_number_size.unwrap_or(9.0), t.page_number_inset.unwrap_or(72.0), t.page_number_offset.unwrap_or(36.0));
        }
        self.c.set_labels(vec![(0, Label::decimal(start as i64))]);
    }

    fn save(mut self, record: &CourtRecord, filename: String, outline: Vec<Outline>) -> Result<CourtPdf, String> {
        if let Some(failed) = self.failed { return Err(failed); }
        self.c.set_outline(outline, record.technical.bookmarks_panel_open);
        let page_count = self.c.page_count();
        let bytes = self.c.save(&Meta { title: &record.title, subject: "Court filing record assembled from user-selected source PDFs",
            creator: "Beaver Court Record Builder", producer: "Beaver Court Record Builder", lang: Some("en-CA"), xmp: true }, true).map_err(|e| e.to_string())?;
        Ok(CourtPdf { filename, page_count, bytes: Buffer(bytes) })
    }

    /// The text in runs of the font that sets them; the first character none sets fails the record.
    fn runs(&mut self, font: usize, text: &str) -> Vec<(usize, String)> {
        let (mut runs, mut missing): (Vec<(usize, String)>, Vec<char>) = (Vec::new(), Vec::new());
        for ch in text.chars() {
            let last = runs.last().map(|r| r.0);
            let chosen = if ch.is_whitespace() && last.is_some_and(|l| self.c.sets(l, ch)) { last }
                else if self.c.sets(font, ch) { Some(font) }
                else { self.fallbacks.iter().flatten().copied().find(|f| self.c.sets(*f, ch)) };
            match (chosen, runs.last_mut()) {
                (None, _) => missing.push(ch),
                (Some(f), Some((at, run))) if *at == f => run.push(ch),
                (Some(f), _) => runs.push((f, ch.to_string())),
            }
        }
        if !missing.is_empty() && self.failed.is_none() {
            self.failed = Some(match self.fallbacks {
                None => "Federal Court generated pages contain characters unavailable in the permitted fonts. Use a permitted-font spelling or prepare the filing outside the builder.".into(),
                Some(_) => format!("The bundled court PDF fonts cannot render {}.", missing.iter().map(|c| format!("\"{c}\" (U+{:04X})", u32::from(*c))).collect::<Vec<_>>().join(", ")),
            });
        }
        runs
    }

    fn width(&mut self, font: usize, text: &str, size: f64) -> f64 {
        self.runs(font, &court_text(text)).iter().map(|(f, run)| self.c.width(*f, run, size)).sum()
    }

    /// Each line of the text 24 points under the one before.
    #[allow(clippy::too_many_arguments)]
    fn text(&mut self, page: usize, font: usize, text: &str, x: f64, y: f64, size: f64, rgb: Rgb) {
        for (index, line) in court_text(text).split('\n').enumerate() {
            let mut x = x;
            for (f, run) in self.runs(font, line.trim_end_matches('\r')) {
                self.c.text(page, f, &run, x, y - index as f64 * 24.0, size, rgb);
                x += self.c.width(f, &run, size);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn centred_at(&mut self, page: usize, text: &str, centre: f64, y: f64, font: usize, size: f64, rgb: Rgb) {
        let x = centre - self.width(font, text, size) / 2.0;
        self.text(page, font, text, x, y, size, rgb);
    }
    fn centred(&mut self, page: usize, text: &str, y: f64, font: usize, size: f64, rgb: Rgb) { self.centred_at(page, text, W / 2.0, y, font, size, rgb); }
    #[allow(clippy::too_many_arguments)]
    fn right(&mut self, page: usize, text: &str, x: f64, y: f64, font: usize, size: f64, rgb: Rgb) {
        let x = x - self.width(font, text, size);
        self.text(page, font, text, x, y, size, rgb);
    }
    fn rule(&mut self, page: usize, from: [f64; 2], to: [f64; 2]) { self.c.line(page, from, to, 0.7, [0.08; 3]); }

    /// Lines within `width`, broken between words; with `paragraphs` each line of the text starts one, else a word
    /// wider than a line is split and an empty text is one empty line.
    fn wrap(&mut self, font: usize, text: &str, size: f64, width: f64, paragraphs: bool) -> Vec<String> {
        let text = court_text(text);
        let parts: Vec<&str> = if paragraphs { text.split('\n').map(|p| p.trim_end_matches('\r')).collect() } else { vec![&text] };
        let mut lines = Vec::new();
        for paragraph in parts {
            let mut current = String::new();
            for word in paragraph.split_whitespace() {
                let next = if current.is_empty() { word.to_owned() } else { format!("{current} {word}") };
                if self.width(font, &next, size) <= width { current = next; continue; }
                if !current.is_empty() { lines.push(std::mem::take(&mut current)); }
                let mut word: Vec<char> = word.chars().collect();
                while !paragraphs && self.width(font, &word.iter().collect::<String>(), size) > width {
                    let mut split = 1;
                    while split < word.len() && self.width(font, &word[..=split].iter().collect::<String>(), size) <= width { split += 1; }
                    lines.push(word.drain(..split).collect());
                }
                current = word.into_iter().collect();
            }
            if !current.is_empty() { lines.push(current); }
        }
        if lines.is_empty() && !paragraphs { lines.push(String::new()); }
        lines
    }

    /// Lines set down from `top`, each `step` below the last; where the last ended.
    #[allow(clippy::too_many_arguments)]
    fn block(&mut self, page: usize, values: &[(String, bool)], x: f64, top: f64, width: f64, step: f64) -> f64 {
        let mut y = top;
        for (value, strong) in values.iter().filter(|(v, _)| !v.is_empty()) {
            let font = if *strong { self.times_bold } else { self.times };
            for line in self.wrap(font, value, 12.0, width, true) { self.text(page, font, &line, x, y, 12.0, BLACK); y -= step; }
        }
        y
    }

    fn cover(&mut self, page: usize, cover: &CourtCover, number: usize, count: usize) -> Result<(), String> {
        let volume = (count > 1).then(|| format!("VOLUME {number} OF {count}"));
        let (regular, bold) = (self.times, self.times_bold);
        let bottom = match cover {
            CourtCover::Generic { court, groups, title, number, filer } => {
                self.centred(page, &court.to_uppercase(), H - 88.0, bold, 12.0, INK);
                self.rule(page, [56.0, H - 112.0], [W - 56.0, H - 112.0]);
                let mut y = H - 170.0;
                for (index, group) in groups.iter().enumerate() {
                    if index > 0 { self.centred(page, "and", y, regular, 11.0, INK); y -= 18.0; }
                    for name in self.wrap(bold, &group.names, 11.0, W - 112.0, true) { self.centred(page, &name, y, bold, 11.0, INK); y -= 14.0; }
                    self.centred(page, &group.role, y, regular, 10.0, INK);
                    y -= 22.0;
                }
                let title_y = (H - 348.0).min(y - 24.0);
                if title_y - if volume.is_some() { 45.0 } else { 20.0 } < 170.0 { return Err(COVER_SPACE.into()); }
                self.centred(page, &title.to_uppercase(), title_y, bold, 18.0, INK);
                if let Some(volume) = &volume { self.centred(page, volume, title_y - 27.0, bold, 10.0, INK); }
                self.text(page, regular, number, 64.0, 148.0, 9.0, BLACK);
                self.text(page, bold, filer, 64.0, 130.0, 9.0, BLACK);
                return Ok(());
            }
            CourtCover::FederalRecord { heading, title, subtitles, contacts } => {
                let mut y = self.federal_heading(page, heading);
                self.rule(page, [MARGIN, y], [W - MARGIN, y]);
                y -= 39.0;
                for line in self.wrap(bold, &title.to_uppercase(), 12.0, W - 2.0 * MARGIN, true) { self.centred(page, &line, y, bold, 12.0, INK); y -= 16.0; }
                for subtitle in subtitles {
                    for line in self.wrap(bold, subtitle, 12.0, W - 2.0 * MARGIN, true) { self.centred(page, &line, y - 4.0, bold, 12.0, INK); y -= 17.0; }
                }
                if let Some(volume) = &volume { self.centred(page, volume, y - 4.0, bold, 12.0, INK); y -= 18.0; }
                self.rule(page, [MARGIN, y - 8.0], [W - MARGIN, y - 8.0]);
                let (gap, column) = (28.0, (W - 2.0 * MARGIN - 28.0) / 2.0);
                contacts.iter().enumerate().map(|(index, values)| self.block(page, values, MARGIN + index as f64 * (column + gap), y - 40.0, column, 15.0)).fold(y - 40.0, f64::min)
            }
            CourtCover::AbcaAp5 { rows, rule, decision, title, filing, others } => {
                let (regular, bold) = (self.helvetica, self.helvetica_bold);
                self.centred(page, "COURT OF APPEAL OF ALBERTA", H - 83.28, bold, 12.0, INK);
                self.text(page, bold, "Form AP-5", 468.0, H - 95.64, 10.0, BLACK);
                self.text(page, regular, rule, 468.0, H - 107.64, 10.0, BLACK);
                self.c.rect(page, [470.5, H - 226.7, 118.1, 107.3], Some([1.0; 3]), Some(([0.35; 3], 0.7)), None);
                self.text(page, regular, "Registrar's Stamp", 489.84, H - 132.72, 10.0, BLACK);
                // More than two parties' rows (the court's three file rows and the document's beside them) are closer.
                let step: f64 = if rows.len() > 8 { 22.0 } else { 27.84 };
                let mut y = H - 133.44;
                for (label, value) in rows {
                    self.text(page, regular, label, 77.4, y, 12.0, BLACK);
                    let font = if label == "DOCUMENT:" { bold } else { regular };
                    let lines = self.wrap(font, value, 12.0, W - 305.0, true);
                    for (index, line) in lines.iter().enumerate() { self.text(page, font, line, 289.8, y - index as f64 * 13.0, 12.0, BLACK); }
                    y -= step.max(lines.len() as f64 * 13.0 + 5.0);
                }
                let heading = y + step / 2.0;
                self.rule(page, [70.56, heading], [W - 70.56, heading]);
                for (index, line) in decision.iter().enumerate() { self.centred_at(page, line, 321.0, heading - 26.0 - index as f64 * 15.88, regular, 12.0, INK); }
                let decided = heading - 93.0;
                self.rule(page, [70.56, decided], [W - 70.56, decided]);
                let mut lines = self.wrap(regular, &title.to_uppercase(), 12.0, W - 141.12, true);
                lines.extend(volume);
                for (index, line) in lines.iter().enumerate() { self.centred(page, line, decided - 25.0 - index as f64 * 15.0, regular, 12.0, INK); }
                let titled = decided - 28.0 - lines.len() as f64 * 15.0;
                self.rule(page, [70.56, titled], [W - 70.56, titled]);
                let top = titled - 25.0;
                let plain = |values: &[String]| values.iter().map(|v| (v.clone(), false)).collect::<Vec<_>>();
                // The AP-5's lawyers' blocks are in its own type, not Times.
                let (times, times_bold) = (self.times, self.times_bold);
                (self.times, self.times_bold) = (regular, bold);
                let filed = self.block(page, &plain(filing), 77.4, top, 212.0, 13.8);
                let mut other = top;
                for block in others { other = self.block(page, &plain(block), 329.16, other - if other == top { 0.0 } else { 5.0 }, 212.0, 13.8); }
                (self.times, self.times_bold) = (times, times_bold);
                let bottom = (top - 87.0).min(filed.min(other) - 3.0);
                if bottom >= 71.0 { self.rule(page, [70.56, bottom], [W - 70.56, bottom]); }
                bottom
            }
        };
        if bottom < 71.0 { return Err(COVER_SPACE.into()); }
        Ok(())
    }

    /// The Federal Courts' heading; where it ends.
    fn federal_heading(&mut self, page: usize, heading: &FederalHeading) -> f64 {
        let (regular, bold) = (self.times, self.times_bold);
        self.right(page, &format!("Court File No. {}", heading.number), W - MARGIN, H - 78.0, regular, 12.0, BLACK);
        self.centred(page, &heading.court, H - 118.0, bold, 12.0, INK);
        self.text(page, regular, "BETWEEN:", MARGIN, H - 157.0, 12.0, BLACK);
        let mut y = H - 193.0;
        for (index, group) in heading.groups.iter().enumerate() {
            for name in self.wrap(regular, &group.names, 12.0, W - 2.0 * MARGIN, true) { self.centred(page, &name, y, regular, 12.0, INK); y -= 14.0; }
            let role_y = y - 20.0;
            self.right(page, &group.role, W - MARGIN, role_y, regular, 12.0, BLACK);
            if index + 1 < heading.groups.len() { self.centred(page, "and", role_y - 26.0, regular, 12.0, INK); y = role_y - 52.0; } else { y = role_y - 32.0; }
        }
        if let Some(under) = heading.under.as_ref().filter(|u| !u.trim().is_empty()) {
            for line in self.wrap(regular, &format!("APPLICATION UNDER {under}"), 12.0, W - 2.0 * MARGIN, true) { self.centred(page, &line, y, regular, 12.0, INK); y -= 15.0; }
            y -= 17.0;
        }
        y
    }

    fn form_344(&mut self, page: usize, form: &Form344) -> Result<(), String> {
        let (regular, bold) = (self.times, self.times_bold);
        let y = self.federal_heading(page, &form.heading);
        self.centred(page, "Certificate of Completeness of Appeal Book", y - 8.0, bold, 12.0, INK);
        let statement = format!("I, {}, solicitor for the appellant (or appellant), certify that the contents of the appeal book in this appeal are complete and legible.", form.name);
        for (index, line) in self.wrap(regular, &statement, 12.0, W - 2.0 * MARGIN, true).iter().enumerate() { self.text(page, regular, line, MARGIN, y - 50.0 - index as f64 * 16.0, 12.0, BLACK); }
        self.text(page, regular, "(Date)", MARGIN, y - 116.0, 12.0, BLACK);
        self.rule(page, [352.0, y - 116.0], [W - MARGIN, y - 116.0]);
        self.text(page, regular, "(Signature of solicitor or appellant)", 352.0, y - 134.0, 12.0, BLACK);
        if y - 158.0 - form.contact.len() as f64 * 16.0 < 71.0 { return Err(COVER_SPACE.into()); }
        for (index, line) in form.contact.iter().enumerate() { self.text(page, regular, line, 352.0, y - 158.0 - index as f64 * 16.0, 12.0, BLACK); }
        Ok(())
    }

    fn certificate(&mut self, page: usize, certificate: &Certificate, label: &str) {
        let (regular, bold) = (self.times, self.times_bold);
        let Certificate { deponent, date, alberta } = certificate;
        if *alberta {
            let (left, right, top) = (126.0, W - 126.0, H - 180.0);
            self.text(page, regular, &format!("This is Exhibit \"{label}\" referred to in the Affidavit of:"), left, top, 12.0, BLACK);
            self.text(page, regular, deponent, left + 6.0, top - 31.0, 12.0, BLACK);
            self.text(page, regular, date, left + 6.0, top - 122.0, 12.0, BLACK);
            for at in [35.0, 126.0, 184.0, 254.0] { self.rule(page, [left, top - at], [right, top - at]); }
            for (text, at) in [("(name of person making the affidavit)", 52.0), ("Commissioner for Oaths, Justice of the Peace,", 201.0),
                ("or Notary Public in and for Alberta", 215.0), ("Print Name and Expiry Date", 271.0)] { self.centred(page, text, top - at, regular, 10.0, INK); }
            for (x, text) in [(left, "Sworn"), (left + 82.0, "Affirmed before me this")] {
                self.c.rect(page, [x, top - 90.0, 10.0, 10.0], Some([1.0; 3]), Some((BLACK, 0.8)), None);
                self.text(page, regular, text, x + 16.0, top - 89.0, 12.0, BLACK);
            }
            self.text(page, regular, "/", left + 66.0, top - 89.0, 12.0, BLACK);
            return;
        }
        self.centred(page, &format!("EXHIBIT {label}"), H - 118.0, bold, 12.0, INK);
        let wording = format!("This is Exhibit “{label}” referred to in the affidavit of {deponent}, sworn (or affirmed) before me on {date}.");
        for (index, line) in self.wrap(regular, &wording, 12.0, W - 2.0 * MARGIN, true).iter().enumerate() { self.text(page, regular, line, MARGIN, H - 206.0 - index as f64 * 19.0, 12.0, BLACK); }
        self.rule(page, [286.0, 276.0], [W - MARGIN, 276.0]);
        let signature = "Signature and capacity of the person before whom the affidavit was sworn or affirmed";
        for (index, line) in self.wrap(regular, signature, 12.0, W - MARGIN - 286.0, true).iter().enumerate() { self.text(page, regular, line, 286.0, 255.0 - index as f64 * 15.0, 12.0, BLACK); }
        self.text(page, regular, "Federal Courts Rule 80(3)", MARGIN, 75.0, 12.0, BLACK);
    }

    fn description(&mut self, page: usize, lines: &[String], index: usize) {
        let heading = format!("DESCRIPTION OF PHYSICAL EXHIBIT{}", if index > 0 { " — CONTINUED" } else { "" });
        self.centred(page, &heading, 708.0, self.times_bold, 12.0, BLACK);
        for (at, line) in lines.iter().enumerate() { self.text(page, self.times, line, MARGIN, 660.0 - at as f64 * 16.0, 12.0, BLACK); }
    }

    fn standard_index(&mut self, view: &IndexPage, rows: &[Row], links: &mut Links) {
        let (page, t, white) = (view.page, view.t, [1.0; 3]);
        let (regular, bold, sans, sans_bold) = (self.times, self.times_bold, self.helvetica, self.helvetica_bold);
        self.c.rect(page, [44.0, H - 92.0, 8.0, 40.0], Some(view.colour), None, None);
        self.text(page, bold, t.index_title.as_deref().unwrap_or("TABLE OF CONTENTS"), 64.0, H - 70.0, 15.0, BLACK);
        let ((number, count), (index, pages)) = (view.volume, view.index);
        let suffix = [(count > 1).then(|| format!("Volume {number} of {count}")), (pages > 1).then(|| format!("Page {} of {pages}", index + 1))].into_iter().flatten().collect::<Vec<_>>().join(" · ");
        self.right(page, &suffix, W - 48.0, H - 69.0, regular, 9.0, [0.3; 3]);
        let top = H - 112.0;
        self.c.rect(page, [48.0, top - 19.0, W - 96.0, 22.0], Some([0.12, 0.14, 0.17]), None, None);
        for (text, x) in [("TAB", 56.0), (t.index_document_label.as_deref().unwrap_or("DOCUMENT"), 96.0), ("DATE", 430.0)] { self.text(page, sans_bold, text, x, top - 12.0, 8.0, white); }
        self.right(page, "PAGE", W - 56.0, top - 12.0, sans_bold, 8.0, white);
        let (mut y, mut last) = (top - 37.0, None);
        for row in rows {
            if row.group.is_some() && row.group != last {
                self.c.rect(page, [48.0, y - 3.0, W - 96.0, 18.0], Some([0.94, 0.95, 0.96]), None, None);
                self.text(page, sans_bold, row.group.as_deref().unwrap_or_default(), 56.0, y + 2.0, 8.0, [0.22, 0.24, 0.27]);
                y -= 21.0;
                last = row.group.clone();
            }
            let (shown, target) = view.pages(row, "–");
            self.text(page, sans, &row.tab.map_or(String::new(), |t| t.to_string()), 57.0, y, 8.5, BLACK);
            for (index, line) in row.lines.iter().enumerate() { self.text(page, sans, line, 96.0 + if row.offset.is_some() { 12.0 } else { 0.0 }, y - index as f64 * 11.0, 8.5, BLACK); }
            self.text(page, sans, row.date.as_deref().unwrap_or_default(), 430.0, y, 8.2, BLACK);
            self.right(page, &shown, W - 56.0, y, sans, 8.5, [0.12; 3]);
            let bottom = y - (row.lines.len().max(1) as f64 - 1.0) * 11.0 - 7.0;
            self.c.line(page, [48.0, bottom], [W - 48.0, bottom], 0.5, [0.86, 0.87, 0.89]);
            if let Some(target) = target { links.push((page, [48.0, bottom, W - 48.0, y + 10.0], target)); }
            y -= (row.lines.len() as f64 * 11.0 + 13.0).max(24.0);
        }
    }

    fn federal_index(&mut self, view: &IndexPage, rows: &[Row], links: &mut Links) {
        let (page, t, (left, right)) = (view.page, view.t, (MARGIN, W - MARGIN));
        let (regular, bold, grey) = (self.times, self.times_bold, [0.25; 3]);
        self.centred(page, t.index_title.as_deref().unwrap_or("TABLE OF CONTENTS"), H - 78.0, bold, 12.0, BLACK);
        let verticals = |pen: &mut Self, bottom: f64, top: f64| for x in [left + 48.0, right - 50.0] { pen.c.line(page, [x, bottom], [x, top], 0.7, grey); };
        let mut top = H - 134.0;
        self.c.rect(page, [left, top, right - left, 24.0], Some([0.82; 3]), Some((grey, 0.7)), None);
        verticals(self, top, top + 24.0);
        self.text(page, bold, "TAB", left + 8.0, top + 7.0, 12.0, BLACK);
        self.text(page, bold, t.index_document_label.as_deref().unwrap_or("DOCUMENT"), left + 56.0, top + 7.0, 12.0, BLACK);
        self.right(page, "PAGE", right - 8.0, top + 7.0, bold, 12.0, INK);
        let mut last = None;
        for row in rows {
            if row.group.is_some() && row.group != last {
                self.c.rect(page, [left, top - 22.0, right - left, 22.0], Some([0.93; 3]), Some((grey, 0.7)), None);
                self.centred(page, row.group.as_deref().unwrap_or_default(), top - 16.0, bold, 12.0, BLACK);
                top -= 22.0;
                last = row.group.clone();
            }
            let bottom = top - (row.lines.len() as f64 * 15.0 + 10.0).max(32.0);
            self.c.rect(page, [left, bottom, right - left, top - bottom], None, Some((grey, 0.7)), None);
            verticals(self, bottom, top);
            let (shown, target) = view.pages(row, "-");
            self.centred_at(page, &row.tab.map_or(String::new(), |t| t.to_string()), left + 24.0, top - 20.0, regular, 12.0, BLACK);
            for (index, line) in row.lines.iter().enumerate() { self.text(page, regular, line, left + 56.0 + if row.offset.is_some() { 12.0 } else { 0.0 }, top - 20.0 - index as f64 * 15.0, 12.0, BLACK); }
            self.centred_at(page, &shown, right - 25.0, top - 20.0, regular, 12.0, BLACK);
            if let Some(target) = target { links.push((page, [left, bottom, right, top], target)); }
            top = bottom;
        }
    }

    fn abca_index(&mut self, view: &IndexPage, rows: &[Row], links: &mut Links) {
        let (page, (left, right)) = (view.page, (76.08, 533.26));
        let (regular, bold) = (self.helvetica, self.helvetica_bold);
        self.centred_at(page, view.t.index_title.as_deref().unwrap_or("Table of Contents"), 315.35, H - 49.44, regular, 12.0, BLACK);
        let mut y = H - 80.64;
        self.text(page, regular, "Page", 512.64, y, 12.0, BLACK);
        let (mut last, mut first) = (None, true);
        for row in rows {
            if row.group.is_some() && row.group != last {
                if !first { y -= 32.4; }
                self.centred_at(page, row.group.as_deref().unwrap_or_default(), 279.06, y, bold, 12.0, BLACK);
                y -= if first { 33.12 } else { 39.84 };
                last = row.group.clone();
            } else { y -= if first { 33.12 } else { 39.6 }; }
            first = false;
            for (index, line) in row.lines.iter().enumerate() { self.text(page, regular, line, left + if row.offset.is_some() { 12.0 } else { 0.0 }, y - index as f64 * 16.0, 12.0, BLACK); }
            let (shown, target) = view.pages(row, "-");
            self.right(page, &shown, right, y, regular, 12.0, INK);
            if let Some(target) = target { links.push((page, [left, y - row.lines.len().max(1) as f64 * 16.0 - 8.0, right, y + 12.0], target)); }
            y -= (row.lines.len() as f64 - 2.0).max(0.0) * 16.0;
        }
    }
}

/// Text as the record sets it: composed, a tab a space.
fn court_text(value: &str) -> String { value.nfc().map(|c| if c == '\t' { ' ' } else { c }).collect() }

/// A colour written "#rgb" or "#rrggbb"; white where it is neither.
fn hex(value: &str) -> Rgb {
    let digits = value.trim_start_matches('#');
    let digits: String = if digits.len() == 3 { digits.chars().flat_map(|c| [c, c]).collect() } else { digits.to_owned() };
    match u32::from_str_radix(&digits, 16) {
        Ok(n) if digits.len() == 6 => [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(|v| f64::from(v) / 255.0),
        _ => [1.0; 3],
    }
}
