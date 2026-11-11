//! A source's own PDF set from its provider's text, where there is no original PDF to put in a book: a statute laid
//! out from its provisions, a judgment from its paragraphs, anything else from its Markdown.
use super::pdf_text;
use legal_structure::PrimaryRole;
use legal_structure_features::{OutlineEntry, OutlineKind};
use legalpdf::compose::{nested_outline, Composer, Face, Meta, Outline};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::Deserialize;

#[derive(Deserialize)]
#[cfg_attr(feature = "binding-types", derive(ts_rs::TS))]
#[cfg_attr(feature = "binding-types", ts(optional_fields = nullable))]
#[serde(rename_all = "camelCase")]
pub struct SourceText {
    pub kind: String,
    pub name: Option<String>,
    pub citation: String,
    pub text: String,
    /// Who gave the text, and the day it was retrieved (YYYY-MM-DD): a statute says both.
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub retrieved: Option<String>,
    /// For a Federal Court book, whose pages are in Times; others' running heads are in Arial.
    #[serde(default)]
    pub federal: bool,
}

const WIDTH: f64 = 612.0;
const HEIGHT: f64 = 792.0;
const LEFT: f64 = 66.0;
const RIGHT: f64 = 66.0;
const TOP: f64 = 58.0;
const BOTTOM: f64 = 54.0;
const AVAILABLE: f64 = WIDTH - LEFT - RIGHT;

type Run = (String, usize);
struct Line { runs: Vec<Run>, opens: bool }
#[derive(Clone, Default)]
struct Placing { start: usize, heading: Option<usize>, title: Option<String>, note: Option<String> }
struct Placed { placing: Placing, page: usize }

struct Setter { c: Composer, page: usize, y: f64, placed: Vec<Placed>, placing: Option<Placing>, serif: usize, bold: usize, italic: usize, bold_italic: usize, mono: usize }

/// Paragraphs sit about half a line apart; a heading takes a little more above it. A gap never opens a page.
fn gap(size: f64) -> f64 { size * 0.6 }

impl Setter {
    fn new_page(&mut self) { self.page = self.c.add_page(WIDTH, HEIGHT); self.y = HEIGHT - TOP; }
    fn at_top(&self) -> bool { self.y >= HEIGHT - TOP }

    /// Lines within `available`: a newline opens a paragraph's line, whitespace is one space, and a word wider than a
    /// line is split, so long addresses stay on the page.
    fn layout(&self, runs: &[Run], size: f64, available: f64) -> Vec<Line> {
        let mut lines = vec![Line { runs: Vec::new(), opens: false }];
        let mut used = 0.0;
        let put = |lines: &mut Vec<Line>, text: &str, font: usize| {
            let line = &mut lines.last_mut().expect("a line").runs;
            match line.last_mut() { Some((last, f)) if *f == font => last.push_str(text), _ => line.push((text.to_owned(), font)) }
        };
        for (text, font) in runs {
            let text = pdf_text(text);
            let mut tokens = Vec::new();
            let mut rest = text.as_str();
            while let Some(c) = rest.chars().next() {
                let end = if c == '\n' { 1 } else {
                    let space = c.is_whitespace();
                    rest.find(|d: char| d == '\n' || d.is_whitespace() != space).unwrap_or(rest.len())
                };
                tokens.push(&rest[..end]);
                rest = &rest[end..];
            }
            for token in tokens {
                if token == "\n" { lines.push(Line { runs: Vec::new(), opens: true }); used = 0.0; continue; }
                let whitespace = token.chars().all(char::is_whitespace);
                let token = if whitespace { " " } else { token };
                let width = self.c.width(*font, token, size);
                if used > 0.0 && used + width > available { lines.push(Line { runs: Vec::new(), opens: false }); used = 0.0; }
                if whitespace && used == 0.0 { continue; }
                if width <= available { put(&mut lines, token, *font); used += width; continue; }
                for c in token.chars() {
                    let piece = c.to_string();
                    let advance = self.c.width(*font, &piece, size);
                    if used + advance > available && used > 0.0 { lines.push(Line { runs: Vec::new(), opens: false }); used = 0.0; }
                    put(&mut lines, &piece, *font);
                    used += advance;
                }
            }
        }
        lines
    }

    fn draw_runs(&mut self, runs: &[Run], mut x: f64, size: f64) {
        for (text, font) in runs {
            self.c.text(self.page, *font, text, x, self.y, size, [0.0, 0.0, 0.0]);
            x += self.c.width(*font, text, size);
        }
    }

    fn place(&mut self) {
        if let Some(placing) = self.placing.take() { self.placed.push(Placed { placing, page: self.c.page_count() - 1 }); }
    }

    /// A block: a short one keeps together, a longer one runs on from the page it starts on. `marker` hangs in the
    /// margin of its first line, `x` from the left margin: a paragraph's number, a list item's enumerator.
    fn draw(&mut self, runs: &[Run], indent: f64, size: f64, heading: bool, marker: Option<(&[Run], f64)>) {
        let leading = size + 4.0;
        let lines = self.layout(runs, size, AVAILABLE - indent);
        if heading && !self.at_top() { self.y -= gap(size); }
        let extent = lines.len().min(6) as f64 * leading + lines.iter().filter(|l| l.opens).count() as f64 * gap(size);
        if extent <= HEIGHT - TOP - BOTTOM - 18.0 && self.y - extent < BOTTOM + 18.0 { self.new_page(); }
        for (index, line) in lines.iter().enumerate() {
            if line.opens && !self.at_top() { self.y -= gap(size); }
            if self.y < BOTTOM + leading { self.new_page(); }
            self.place();
            if let (Some((runs, x)), 0) = (marker, index) { self.draw_runs(runs, LEFT + x, size); }
            self.draw_runs(&line.runs, LEFT + indent, size);
            self.y -= leading;
        }
        self.y -= gap(if heading { 10.5 } else { size });
    }

    /// Markdown's blocks, as GitHub reads them: headings, paragraphs, lists, quotations, rules and tables.
    fn markdown(&mut self, text: &str, offset: usize) {
        let (mut runs, mut strong, mut emphasis, mut indent) = (Vec::<Run>::new(), 0, 0, 0.0);
        let (mut lists, mut items_open): (Vec<Option<u64>>, Vec<bool>) = (Vec::new(), Vec::new());
        let mut table: Option<(Vec<Vec<Vec<Run>>>, bool)> = None;
        let mut heading_start = 0;
        for (event, range) in Parser::new_ext(text, Options::ENABLE_TABLES).into_offset_iter() {
            let font = match (strong > 0 || table.as_ref().is_some_and(|t| t.1), emphasis > 0) {
                (true, true) => self.bold_italic, (true, false) => self.bold, (false, true) => self.italic, _ => self.serif };
            match event {
                Event::Start(Tag::Strong) => strong += 1,
                Event::End(TagEnd::Strong) => strong -= 1,
                Event::Start(Tag::Emphasis) => emphasis += 1,
                Event::End(TagEnd::Emphasis) => emphasis -= 1,
                Event::Text(t) | Event::InlineHtml(t) | Event::Html(t) => runs.push((t.into_string(), font)),
                Event::Code(t) => runs.push((t.into_string(), self.mono)),
                Event::SoftBreak | Event::HardBreak => runs.push(("\n".into(), font)),
                Event::Start(Tag::Heading { .. }) => { heading_start = range.start; strong += 1; }
                Event::End(TagEnd::Heading(level)) => {
                    strong -= 1;
                    let depth = level as usize;
                    let title = runs.iter().map(|r| r.0.as_str()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
                    self.placing = Some(Placing { start: offset + heading_start, heading: Some(depth), title: Some(title), note: None });
                    let block = std::mem::take(&mut runs);
                    self.draw(&block, indent, 17.0 - depth as f64, true, None);
                }
                Event::Start(Tag::Paragraph) => self.placing = Some(Placing { start: offset + range.start, ..Placing::default() }),
                Event::End(TagEnd::Paragraph | TagEnd::HtmlBlock) => self.item_block(std::mem::take(&mut runs), &lists, &mut items_open, indent),
                Event::End(TagEnd::CodeBlock) => {
                    let block: Vec<Run> = std::mem::take(&mut runs).into_iter().map(|(t, _)| (t.trim_end_matches('\n').to_owned(), self.mono)).collect();
                    self.draw(&block, indent, 10.5, false, None);
                }
                // A tight item's words come without a paragraph of their own.
                Event::Start(Tag::List(start)) => {
                    if !runs.is_empty() { self.item_block(std::mem::take(&mut runs), &lists, &mut items_open, indent); }
                    lists.push(start);
                    indent += 14.0;
                }
                Event::End(TagEnd::List(_)) => { lists.pop(); indent -= 14.0; }
                Event::Start(Tag::Item) => items_open.push(true),
                Event::End(TagEnd::Item) => {
                    if !runs.is_empty() { self.item_block(std::mem::take(&mut runs), &lists, &mut items_open, indent); }
                    items_open.pop();
                    if let Some(Some(n)) = lists.last_mut() { *n += 1; }
                }
                Event::Start(Tag::BlockQuote(_)) => indent += 18.0,
                Event::End(TagEnd::BlockQuote(_)) => indent -= 18.0,
                Event::Rule => {
                    if self.y < BOTTOM + 20.0 { self.new_page(); }
                    self.c.line(self.page, [LEFT + indent, self.y], [WIDTH - RIGHT, self.y], 0.5, [0.0, 0.0, 0.0]);
                    self.y -= 14.0;
                }
                Event::Start(Tag::Table(_)) => table = Some((Vec::new(), false)),
                Event::Start(Tag::TableHead) => if let Some(t) = &mut table { t.1 = true; t.0.push(Vec::new()); },
                Event::End(TagEnd::TableHead) => if let Some(t) = &mut table { t.1 = false; },
                Event::Start(Tag::TableRow) => if let Some(t) = &mut table { t.0.push(Vec::new()); },
                Event::End(TagEnd::TableCell) => if let Some(t) = &mut table { if let Some(row) = t.0.last_mut() { row.push(std::mem::take(&mut runs)); } },
                Event::End(TagEnd::Table) => if let Some((rows, _)) = table.take() { self.table(&rows, indent); },
                _ => {}
            }
        }
    }

    /// A paragraph; a list item's first carries its enumerator ("3. ", or a bullet).
    fn item_block(&mut self, mut block: Vec<Run>, lists: &[Option<u64>], items_open: &mut [bool], indent: f64) {
        if let Some(first @ true) = items_open.last_mut() {
            *first = false;
            let marker = match lists.last().copied().flatten() { Some(n) => format!("{n}. "), None => "\u{b7} ".into() };
            block.insert(0, (marker, self.serif));
        }
        self.draw(&block, indent, 10.5, false, None);
    }

    fn table(&mut self, rows: &[Vec<Vec<Run>>], indent: f64) {
        let columns = rows.first().map_or(1, Vec::len).max(1);
        let column_width = (AVAILABLE - indent) / columns as f64;
        for (index, row) in rows.iter().enumerate() {
            let cells: Vec<Vec<Line>> = row.iter().map(|cell| self.layout(cell, 10.5, column_width - 12.0)).collect();
            let count = cells.iter().map(Vec::len).max().unwrap_or(0);
            if count as f64 * 14.5 < HEIGHT - TOP - BOTTOM - 18.0 && self.y - count as f64 * 14.5 < BOTTOM + 18.0 { self.new_page(); }
            for line in 0..count {
                if self.y < BOTTOM + 14.5 { self.new_page(); }
                for (column, cell) in cells.iter().enumerate() {
                    if let Some(l) = cell.get(line) { self.draw_runs(&l.runs, LEFT + indent + column as f64 * column_width, 10.5); }
                }
                self.y -= 14.5;
            }
            self.c.line(self.page, [LEFT + indent, self.y + 4.0], [WIDTH - RIGHT, self.y + 4.0], if index > 0 { 0.25 } else { 0.75 }, [0.6, 0.6, 0.6]);
            self.y -= 6.0;
        }
        self.y -= 3.0;
    }

    /// A judgment's front matter line, centred or at the right margin; a line set in capitals is bold, as the judgment sets it.
    fn aligned(&mut self, text: &str, centre: bool) {
        let capitals = text == text.to_uppercase() && text.chars().collect::<Vec<_>>().windows(3).any(|w| w.iter().all(|c| c.is_uppercase()));
        let font = if capitals { self.bold } else { self.serif };
        let lines = self.layout(&[(text.to_owned(), font)], 10.5, AVAILABLE);
        if self.y - lines.len() as f64 * 14.5 < BOTTOM + 18.0 { self.new_page(); }
        for line in &lines {
            self.place();
            let used: f64 = line.runs.iter().map(|(t, f)| self.c.width(*f, t, 10.5)).sum();
            self.draw_runs(&line.runs, LEFT + if centre { (AVAILABLE - used) / 2.0 } else { AVAILABLE - used }, 10.5);
            self.y -= 14.5;
        }
        self.y -= gap(10.5);
    }
}

/// The source's pages, how many there are, and its bookmarks.
pub fn render_source_pdf(input: &SourceText) -> Result<(Vec<u8>, usize, Vec<Outline>), String> {
    if input.text.trim().is_empty() { return Err("Authority source text is empty.".into()); }
    let mut c = Composer::new();
    let (serif, bold, italic, bold_italic, mono) = (c.font(Face::Times), c.font(Face::TimesBold), c.font(Face::TimesItalic), c.font(Face::TimesBoldItalic), c.font(Face::Courier));
    // The running head and page numbers are in Arial outside the Federal Court, as the book's own pages are.
    let sans = c.font(if input.federal { Face::Times } else { Face::Arial });
    let title = pdf_text(input.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(input.citation.trim()));
    let citation = pdf_text(input.citation.trim());
    let mut s = Setter { c, page: 0, y: 0.0, placed: Vec::new(), placing: None, serif, bold, italic, bold_italic, mono };
    s.new_page();
    s.y = HEIGHT - TOP - 40.0;
    for line in super::wrapped(Face::TimesBold, &title, 23.0, AVAILABLE) { s.c.text(s.page, bold, &line, LEFT, s.y, 23.0, [0.0; 3]); s.y -= 29.0; }
    s.y -= 8.0;
    if citation != title {
        for line in super::wrapped(Face::Times, &citation, 13.0, AVAILABLE) { s.c.text(s.page, serif, &line, LEFT, s.y, 13.0, [0.2; 3]); s.y -= 18.0; }
    }
    // A statute rebuilt from text says whose text it is and when it was retrieved: the court asks how current it is.
    if let (true, Some(provider), Some(day)) = (input.kind == "legislation", &input.provider, input.retrieved.as_deref().and_then(long_date)) {
        s.c.text(s.page, italic, &pdf_text(&format!("Unofficial text from {provider}, retrieved {day}")), LEFT, s.y, 10.5, [0.2; 3]);
        s.y -= 16.0;
    }
    s.c.line(s.page, [LEFT, s.y - 6.0], [WIDTH - RIGHT, s.y - 6.0], 0.8, [0.6; 3]);
    s.y -= 34.0;
    let outline: Vec<OutlineEntry> = match input.kind.as_str() {
        "case" => legal_structure_features::text_outline(&input.text, legal_structure::ProviderTextSourceKind::Cases).map_err(|e| e.to_string())?,
        "legislation" => legal_structure_features::text_outline(&input.text, legal_structure::ProviderTextSourceKind::Laws).map_err(|e| e.to_string())?,
        _ => Vec::new(),
    };
    let statute = input.kind == "legislation" && outline.iter().any(|e| e.kind == OutlineKind::Section);
    let judgment = input.kind == "case" && outline.iter().any(|e| matches!(e.kind, OutlineKind::Paragraph | OutlineKind::Prose));
    let mut openings = std::collections::BTreeSet::new();
    if statute {
        // A statute is laid out from its outline: its headings, and each provision under its marginal note, indented a
        // step for each level below the provision that opens it.
        let (mut base, mut section_level, mut carried, mut opened) = (0usize, 0usize, Vec::<Run>::new(), false);
        for (index, entry) in outline.iter().enumerate() {
            let text = entry.text.as_str();
            // The title over it all repeats the title block.
            if entry.kind == OutlineKind::Span { continue; }
            if entry.kind == OutlineKind::Text {
                // The words before the first heading or provision (the long title, an enacting formula) are in italics.
                s.draw(&[(text.to_owned(), if opened { serif } else { italic })], if opened { 18.0 * entry.level.saturating_sub(section_level) as f64 } else { 0.0 }, 10.5, false, None);
                continue;
            }
            opened = true;
            // A part, a division or a schedule the grammar reads as a provision holds the provisions after it.
            let container = entry.kind == OutlineKind::Section && !matches!(entry.locator.as_deref().unwrap_or("section"), "section" | "subsection");
            if entry.kind == OutlineKind::Heading || container {
                // A heading keeps a marginal note and a few lines of what it heads with it.
                if s.y - 110.0 < BOTTOM + 18.0 { s.new_page(); }
                let title = if entry.kind == OutlineKind::Heading { entry.title.clone().unwrap_or_default() } else {
                    [entry.label.as_str(), entry.title.as_deref().unwrap_or_else(|| text.split('\n').next().unwrap_or(""))].iter().filter(|p| !p.is_empty()).copied().collect::<Vec<_>>().join(" ")
                };
                s.placing = Some(Placing { start: entry.start, heading: Some(entry.level + 2), title: Some(title.clone()), note: None });
                s.draw(&[(title, bold)], 0.0, [13.0, 12.0, 11.0][entry.level.min(2)], true, None);
                if container { base = entry.level + 1; }
                // What a heading heads before its first provision (a schedule's table, a form) is laid out from its Markdown.
                if entry.kind == OutlineKind::Heading && !text.is_empty() {
                    let kept = s.placed.len();
                    let from = input.text.get(entry.start..).and_then(|t| t.find('\n')).map_or(entry.end, |n| entry.start + n + 1).min(entry.end);
                    s.markdown(input.text.get(from..entry.end).unwrap_or(""), from);
                    s.placed.truncate(kept);
                    s.placing = None;
                }
                continue;
            }
            let opens = entry.level <= base;
            if opens { section_level = entry.level; openings.insert(entry.start); }
            let indent = if carried.is_empty() { 18.0 * entry.level.saturating_sub(section_level) as f64 } else { 0.0 };
            let label = (format!("{} ", entry.label), if opens { bold } else { serif });
            // A section whose words start in its first subsection prints on one line with it: "2 (1) In this Act,".
            let mut paragraphs = text.split('\n');
            let first = paragraphs.next().unwrap_or("");
            let mut opening: Vec<Run> = carried.clone();
            opening.extend([label.clone(), (first.to_owned(), serif)]);
            if let Some(note) = &entry.title {
                // A marginal note keeps the opening lines of its provision (up to six) with it on its page.
                let lead = match outline.get(index + 1) {
                    Some(next) if opens && text.is_empty() => { let mut l = opening.clone(); l.push((next.text.split('\n').next().unwrap_or("").to_owned(), serif)); l }
                    _ => opening.clone(),
                };
                let lines = s.layout(&lead, 10.5, AVAILABLE - indent).len().min(6) as f64;
                if s.y - (14.0 + gap(10.0) + gap(10.5) + lines * 14.5) < BOTTOM + 18.0 { s.new_page(); }
                s.placing = Some(Placing { start: entry.start, note: Some(note.clone()), ..Placing::default() });
                s.draw(&[(note.clone(), bold)], indent, 10.0, true, None);
            }
            if s.placing.is_none() { s.placing = Some(Placing { start: entry.start, ..Placing::default() }); }
            if opens && text.is_empty() { carried = vec![label]; continue; }
            // Each of its paragraphs (a definitions list's entries) is laid out on its own.
            s.draw(&opening, indent, 10.5, false, None);
            for paragraph in paragraphs { s.draw(&[(paragraph.to_owned(), serif)], indent, 10.5, false, None); }
            carried.clear();
        }
    } else if judgment {
        // A judgment is laid out from its outline: its headings by level, each numbered paragraph with its number hanging
        // in the margin, the lists within a paragraph a step in for each level, its front matter as a judgment sets it.
        let (mut list, mut previous) = (0usize, None);
        for entry in &outline {
            let (text, title) = (entry.text.as_str(), entry.title.clone().unwrap_or_default());
            s.placing = Some(Placing { start: entry.start, heading: (entry.kind == OutlineKind::Heading).then_some(entry.level + 2),
                title: (entry.kind == OutlineKind::Heading).then(|| title.clone()), note: None });
            if entry.kind == OutlineKind::ListItem && previous != Some(OutlineKind::ListItem) { list = entry.level; }
            previous = Some(entry.kind);
            match entry.role {
                // The provider's title line repeats the title block; its catalogue record is none of the judgment.
                Some(PrimaryRole::Title | PrimaryRole::Furniture) => continue,
                Some(PrimaryRole::Party) => { s.aligned(text, false); continue; }
                Some(PrimaryRole::Caption) => { s.aligned(text, true); continue; }
                _ => {}
            }
            match entry.kind {
                OutlineKind::Heading => s.draw(&[(title, bold)], 0.0, [13.0, 12.0, 11.0][entry.level.min(2)], true, None),
                OutlineKind::Paragraph | OutlineKind::Prose => s.draw(&[(text.to_owned(), serif)], 36.0, 10.5, false, Some((&[(entry.label.clone(), bold)], 0.0))),
                OutlineKind::ListItem => {
                    let depth = (entry.level + 1).saturating_sub(list) as f64;
                    s.draw(&[(text.to_owned(), serif)], 36.0 + 22.0 * depth, 10.5, false, Some((&[(entry.label.clone(), serif)], 36.0 + 22.0 * (depth - 1.0))));
                }
                _ => s.draw(&[(text.to_owned(), serif)], if entry.level > 0 { 36.0 } else { 0.0 }, 10.5, false, None),
            }
        }
    } else {
        s.markdown(&input.text, 0);
    }
    // Headings below the title, then each provision that opens its own place, titled with its marginal note.
    let title_of = |p: &Placing| pdf_text(p.title.as_deref().unwrap_or(""));
    let bookmarks: Vec<Outline> = if judgment {
        nested_outline(s.placed.iter().filter(|p| p.placing.heading.is_some()).map(|p| (title_of(&p.placing), p.placing.heading.unwrap_or(0), Some(p.page))))
    } else if statute {
        let mut at = std::collections::HashMap::new();
        for entry in outline.iter().rev() { at.insert(entry.start, entry); }
        let mut heading_level = 0;
        nested_outline(s.placed.iter().filter(|p| p.placing.heading.is_some() || p.placing.note.is_none() && openings.contains(&p.placing.start)).map(|p| {
            if let Some(level) = p.placing.heading { heading_level = level; }
            let entry = at.get(&p.placing.start);
            let title = match p.placing.heading { Some(_) => title_of(&p.placing), None => pdf_text(&[entry.map_or("", |e| e.label.as_str()), entry.and_then(|e| e.title.as_deref()).unwrap_or("")]
                .iter().filter(|t| !t.is_empty()).copied().collect::<Vec<_>>().join(" ")) };
            (title, p.placing.heading.unwrap_or(heading_level + 1), Some(p.page))
        }).collect::<Vec<_>>())
    } else {
        nested_outline(s.placed.iter().filter(|p| p.placing.heading.unwrap_or(0) > 1).map(|p| (title_of(&p.placing), p.placing.heading.unwrap_or(0), Some(p.page))))
    };
    let mut c = s.c;
    if !bookmarks.is_empty() { c.set_outline(bookmarks.clone(), false); }
    let pages = c.page_count();
    for page in 0..pages {
        if page > 0 {
            c.text(page, sans, &super::fit(c.face(sans), &format!("{title}  |  {citation}"), 7.5, AVAILABLE), LEFT, HEIGHT - 34.0, 7.5, [0.42; 3]);
            c.line(page, [LEFT, HEIGHT - 41.0], [WIDTH - RIGHT, HEIGHT - 41.0], 0.5, [0.75; 3]);
        }
        c.text(page, sans, &(page + 1).to_string(), WIDTH - RIGHT - 12.0, 25.0, 8.0, [0.4; 3]);
    }
    let bytes = c.save(&Meta { title: &title, subject: &citation, creator: "Beaver", producer: "Beaver", lang: None, xmp: false }, false)
        .map_err(|e| e.to_string())?;
    Ok((bytes, pages, bookmarks))
}

/// A day (YYYY-MM-DD) as Canadian English writes it in full: "January 5, 2026".
fn long_date(day: &str) -> Option<String> {
    const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let mut parts = day.splitn(3, '-').map(|p| p.parse::<usize>().ok());
    let (year, month, date) = (parts.next()??, parts.next()??, parts.next()??);
    Some(format!("{} {date}, {year}", MONTHS.get(month.checked_sub(1)?)?))
}
