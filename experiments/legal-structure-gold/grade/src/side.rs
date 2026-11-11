//! Each side of a comparison as the scorer reads it, read once from what it is: the gold's typed lines and units
//! (`Side::of_gold`), a parse's nodes (`Side::of_parse`). A side is its source lines in reading order, its blocks over
//! exact source spans (a unit's text on one page, unbroken), its notes, tables and documents, and the links that
//! continue a block, note or table onto another.
use crate::gold::{Gold, SourceSpan, V4};
use legal_structure_model::{DocumentStructure, NodeKind, PrimaryRole, ScalarRange, ScalarText, StructureNode};
use std::collections::{BTreeMap, HashMap, HashSet};

/// A place in a side's source: a line (its index among the side's lines) and a character offset in it.
pub type At = (usize, usize);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Span {
    pub line: usize,
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn at(&self) -> At {
        (self.line, self.start)
    }
}

pub struct Line {
    pub id: String,
    pub page: usize,
    /// The line's text as this side reads it: the gold's correction, or the parser's own.
    pub text: Vec<char>,
    /// (page, place in reading order, 0): the gold's reading position stands for its geometry.
    pub spatial: (usize, f64, f64),
}

/// A unit's text on one page, unbroken: its kind and region, where it hangs (a parse's nearest enclosing block), the
/// level a heading or the depth a body unit is given at, and the spans its printed marker, line number and speaker's
/// label take.
#[derive(Clone)]
pub struct Block {
    pub kind: String,
    pub region: Option<String>,
    pub spans: Vec<Span>,
    pub parent: Option<At>,
    pub heading_level: Option<usize>,
    pub depth: Option<usize>,
    pub marker: Vec<Span>,
    pub line_number: Vec<Span>,
    pub speaker: Vec<Span>,
    /// The locator a unit is addressed by ("paragraph", "list_item", "section"), for the blocks' census.
    pub locator: Option<String>,
}

impl Block {
    /// The block's identity: its first span's place.
    pub fn at(&self) -> At {
        self.spans[0].at()
    }
}

#[derive(Clone)]
pub struct Note {
    pub spans: Vec<Span>,
    pub label: Vec<Span>,
    pub references: Vec<Span>,
}

/// A table's grid on one page: each cell's spans, none where a merged cell covers it.
#[derive(Clone)]
pub struct Table {
    pub spans: Vec<Span>,
    pub rows: Vec<Vec<Option<Vec<Span>>>>,
}

/// A document the source holds: the line it opens on, where in it, and its kind. The first opened is the source's own
/// (the root); every other is a constituent under it.
pub struct Document {
    pub line: usize,
    pub opening: At,
    pub root: bool,
    pub kind: Option<String>,
}

/// Each kind of continuation ("paragraph", "heading", "note", "table", "list", ...) from a place to the place it goes on.
pub type Links = BTreeMap<String, BTreeMap<At, At>>;

pub struct Side {
    pub lines: Vec<Line>,
    pub index: HashMap<String, usize>,
    pub reading_order: Vec<usize>,
    /// Each line's place in reading order.
    pub positions: Vec<usize>,
    /// Each typed span's reading rank by (line, start) when the side is a gold's: side-by-side columns share source
    /// lines, so reading order is finer than line order. A parse has none and reads in line order.
    pub span_rank: HashMap<At, usize>,
    pub blocks: Vec<Block>,
    pub notes: Vec<Note>,
    pub tables: Vec<Table>,
    /// In the order they open.
    pub documents: Vec<Document>,
    pub links: Links,
}

/// Each part's first span linked to the next part's as `kind` goes on, and as a list goes on where the unit is a list's
/// item.
fn link_parts(links: &mut Links, heads: &[At], kind: &str, list: bool) {
    for pair in heads.windows(2) {
        links.entry(kind.into()).or_default().insert(pair[0], pair[1]);
        if list {
            links.entry("list".into()).or_default().insert(pair[0], pair[1]);
        }
    }
}

/// How many of the reading positions before each some unit holds text on (`held`, by position).
fn held_before(held: &[bool]) -> Vec<usize> {
    let mut before = vec![0usize; held.len() + 1];
    for (p, &h) in held.iter().enumerate() {
        before[p + 1] = before[p] + usize::from(h);
    }
    before
}

/// The scorer's kinds for the gold's typed regions; the rest are running text (block quotes, notes and tables inside
/// their annotations, list items with a list_item locator).
fn kind_of(region: &str) -> &str {
    match region {
        "title" | "heading" | "caption" | "headnote" | "marginal_note" | "furniture" | "page_label" | "line_label" | "contents" => region,
        // A block quotation inside a note is scored as note until the parser tells them apart.
        "note_quote" => "note",
        _ => "text",
    }
}

/// The part a continuation names at `at`: the one opening there, else the one holding it, else the first with text on
/// its line after it. A parse's note continuation names the note's line on each page, where its label may stand after
/// other marks on the line.
fn named(parts: &[&[Span]], (line, offset): At) -> Option<usize> {
    parts.iter().position(|spans| spans[0].at() == (line, offset))
        .or_else(|| parts.iter().position(|spans| spans.iter().any(|s| s.line == line && s.start <= offset && offset < s.end)))
        .or_else(|| (0..parts.len())
            .filter_map(|k| parts[k].iter().filter(|s| s.line == line && s.end > offset).map(|s| (s.start, k)).min())
            .min().map(|(_, k)| k))
}

fn own(region: &str) -> bool {
    matches!(region, "furniture" | "page_label" | "line_label")
}

impl Side {
    /// A line's place in the side's reading.
    pub fn location(&self, (line, offset): At) -> (usize, usize) {
        (self.positions[line], offset)
    }

    /// The side's lines alone, in their own order: what an extraction reads, for aligning it to a gold.
    pub fn of_lines(lines: Vec<Line>) -> Side {
        let n = lines.len();
        Side {
            index: lines.iter().enumerate().map(|(k, l)| (l.id.clone(), k)).collect(),
            reading_order: (0..n).collect(),
            positions: (0..n).collect(),
            lines,
            span_rank: HashMap::new(),
            blocks: Vec::new(),
            notes: Vec::new(),
            tables: Vec::new(),
            documents: Vec::new(),
            links: Links::new(),
        }
    }

    /// A v4 gold: one block per unit fragment (a unit's lines on one page, unbroken), markers, continuations, notes
    /// with their references, tables and documents. The gold's reading order is the order the model typed its lines in.
    pub fn of_gold(gold: &Gold) -> Result<Side, String> {
        if gold.schema_version != V4 {
            return Err("Expected a legal-structure-gold.v4 file".into());
        }
        let index: HashMap<String, usize> = gold.lines.iter().enumerate().map(|(n, l)| (l.id.clone(), n)).collect();
        if index.len() != gold.lines.len() {
            return Err("Duplicate gold line ID".into());
        }
        let span = |s: &SourceSpan| -> Result<Span, String> {
            Ok(Span { line: *index.get(&s.line_id).ok_or_else(|| format!("Absent source line {}", s.line_id))?, start: s.start, end: s.end })
        };
        let spans = |found: &[SourceSpan]| found.iter().map(span).collect::<Result<Vec<Span>, String>>();
        let cut: Vec<(Vec<Span>, Vec<Span>)> = gold.line_labels().iter().map(|(labels, kept)| Ok((spans(labels)?, spans(kept)?))).collect::<Result<_, String>>()?;
        // Reading order: the typed order; a line never typed keeps its place after the typed line before it in the
        // extraction.
        let (mut typed_order, mut seen, mut span_rank) = (Vec::new(), HashSet::new(), HashMap::<At, usize>::new());
        for s in cut.iter().flat_map(|(labels, kept)| labels.iter().chain(kept)) {
            if seen.insert(s.line) {
                typed_order.push(s.line);
            }
            let rank = span_rank.len();
            span_rank.entry(s.at()).or_insert(rank);
        }
        let (mut leading, mut after, mut last) = (Vec::new(), HashMap::<usize, Vec<usize>>::new(), None);
        for n in 0..gold.lines.len() {
            if seen.contains(&n) {
                last = Some(n);
            } else if let Some(previous) = last {
                after.entry(previous).or_default().push(n);
            } else {
                leading.push(n);
            }
        }
        let mut order = leading;
        for n in &typed_order {
            order.push(*n);
            order.extend(after.get(n).into_iter().flatten());
        }
        let mut positions = vec![0usize; gold.lines.len()];
        for (k, &n) in order.iter().enumerate() {
            positions[n] = k;
        }
        let lines: Vec<Line> = gold.lines.iter().enumerate()
            .map(|(n, l)| Line { id: l.id.clone(), page: l.page, text: l.text().chars().collect(), spatial: (l.page, positions[n] as f64, 0.0) })
            .collect();
        let at = |s: &Span| (positions[s.line], s.start);
        // Reading rank of a span: its typed rank, finer than its line's position when columns or a marginal note share a
        // line with the unit.
        let rank_key = |s: &Span| span_rank.get(&s.at()).map_or((1, positions[s.line], s.start), |&rank| (0, rank, 0));
        let page_of = |s: &Span| gold.lines[s.line].page;
        let (typed, units) = (&gold.typed, &gold.units);
        // A unit's spans in reading order, split at each page and at each line of another unit that comes between: what
        // the source shows, never how the gold happened to group its typed spans.
        let mut placed: Vec<((usize, usize), usize, &Span)> = units.iter().enumerate()
            .flat_map(|(u, unit)| unit.lines.iter().flat_map(|&n| cut[n].1.iter()).map(move |s| (u, s)))
            .map(|(u, s)| (at(s), u, s))
            .collect();
        placed.sort_by_key(|&(_, u, s)| (rank_key(s), u));
        // Lines some unit holds text on, counted up to each reading position.
        let mut held = vec![false; gold.lines.len()];
        for &((line, _), _, _) in &placed {
            held[line] = true;
        }
        let before = held_before(&held);
        let mut parts: Vec<Vec<Vec<Span>>> = vec![Vec::new(); units.len()];
        let mut last: Vec<Option<(usize, &Span)>> = vec![None; units.len()];
        for &((line, _), u, s) in &placed {
            // A part's spans run forward in line position, so a unit that reads backwards through the extraction (a
            // second column, a marginal note typed first) takes a new part there.
            let split = last[u].is_none_or(|(previous, prior)| {
                page_of(prior) != page_of(s) || line > previous + 1 && before[line] > before[previous + 1] || (line, s.start) < (previous, prior.start)
            });
            if split {
                parts[u].push(Vec::new());
            }
            parts[u].last_mut().unwrap().push(*s);
            last[u] = Some((line, s));
        }
        let region = gold.regions();
        // The gold's hierarchy is the levels the model gave: a heading's level, and a body unit's depth. The scorer reads
        // them as given; nothing derives a tree.
        let (mut blocks, mut notes, mut links) = (Vec::new(), Vec::new(), Links::new());
        let mut note_of: HashMap<usize, usize> = HashMap::new();
        for (u, unit) in units.iter().enumerate() {
            let first = &typed[unit.lines[0]];
            // Every printed marker the unit opens with, on whichever of its lines ("6", then "(1) Every lot").
            let marker: Vec<Span> = spans(&unit.lines.iter().flat_map(|&n| typed[n].markers.iter().flatten()).cloned().collect::<Vec<_>>())?;
            for (k, part) in parts[u].iter().enumerate() {
                let r = region[u];
                let marked = k == 0 && !marker.is_empty();
                let (locator, marker) = match r {
                    "list_item" => (Some("list_item"), if k == 0 { marker.clone() } else { Vec::new() }),
                    "text" | "provision" | "quote" if marked => (Some("paragraph"), marker.clone()),
                    "heading" if marked => (None, marker.clone()),
                    _ => (None, Vec::new()),
                };
                // Line numbers and speaker labels the unit's lines print, on its first part.
                let (mut line_number, mut speaker) = (Vec::new(), Vec::new());
                if k == 0 {
                    for &n in &unit.lines {
                        line_number.extend(spans(&typed[n].line_number)?.into_iter().filter(|s| !cut[n].0.contains(s)));
                        speaker.extend(spans(&typed[n].speaker)?);
                    }
                }
                blocks.push(Block {
                    kind: kind_of(r).to_owned(),
                    region: Some(r.to_owned()),
                    spans: part.clone(),
                    parent: None,
                    heading_level: unit.level.or(unit.depth).filter(|_| r == "heading"),
                    depth: unit.depth.filter(|_| r != "heading"),
                    marker,
                    line_number,
                    speaker,
                    locator: locator.map(str::to_owned),
                });
                if r == "note" {
                    let label = if k == 0 { spans(&first.markers.first().cloned().unwrap_or_default())? } else { Vec::new() };
                    notes.push(Note { spans: part.clone(), label, references: Vec::new() });
                    if k == 0 {
                        note_of.insert(u, notes.len() - 1);
                    }
                }
            }
            if !own(region[u]) {
                let kind = match region[u] {
                    "heading" => "heading",
                    "note" => "note",
                    _ => "paragraph",
                };
                let heads: Vec<At> = parts[u].iter().map(|part| part[0].at()).collect();
                link_parts(&mut links, &heads, kind, region[u] == "list_item");
            }
        }
        // The line numbers cut from the lines they number, each a label of its own.
        for label in cut.iter().flat_map(|(labels, _)| labels) {
            blocks.push(Block {
                kind: "line_label".into(), region: Some("line_label".into()), spans: vec![*label], parent: None,
                heading_level: None, depth: None, marker: Vec::new(), line_number: Vec::new(), speaker: Vec::new(), locator: None,
            });
        }
        // Documents: the first block opens the source's own; each unit holding a document start opens another under it.
        // Each is of the type the document pass gave its first unit (the source's own takes the type given before any
        // start).
        let mut documents = Vec::new();
        let opened: Vec<usize> = (0..units.len()).filter(|&u| !parts[u].is_empty() && units[u].starts_document).collect();
        if let Some(start) = parts.iter().filter_map(|found| found.first().map(|part| part[0])).min_by_key(|s| at(s)) {
            let first_type = units.iter().take(opened.first().copied().unwrap_or(units.len()).max(1)).find_map(|u| u.document_type.clone());
            documents.push(Document { line: start.line, opening: start.at(), root: true, kind: first_type });
            for &u in &opened {
                let opening = parts[u][0][0];
                if opening != start {
                    documents.push(Document { line: opening.line, opening: opening.at(), root: false, kind: units[u].document_type.clone() });
                }
            }
        }
        // Each note reference with the note the notes pass paired it with.
        for pair in &gold.notes {
            let (Some(note), Some(reference)) = (pair.note, pair.reference) else { continue };
            let Some(&at) = note_of.get(&note) else { continue };
            notes[at].references.extend(spans(&typed[pair.line].references[reference].spans)?);
        }
        // Tables: table rows consecutive in reading order, with only furniture, page labels and notes between, form one
        // table, one grid per page linked across pages; a row is on the page of its first cell. A unit without text
        // stands nowhere and separates nothing.
        let mut tables = Vec::new();
        let (mut runs, mut current): (Vec<Vec<usize>>, bool) = (Vec::new(), false);
        let mut in_order: Vec<usize> = (0..units.len()).filter(|&u| !parts[u].is_empty()).collect();
        in_order.sort_by_key(|&u| (rank_key(&parts[u][0][0]), u));
        for u in in_order {
            if region[u] == "table" {
                if !current {
                    runs.push(Vec::new());
                    current = true;
                }
                runs.last_mut().unwrap().push(u);
            } else if !own(region[u]) && region[u] != "note" {
                current = false;
            }
        }
        for rows in runs {
            let mut pages: Vec<(usize, Vec<Vec<Vec<Span>>>)> = Vec::new();
            for u in rows {
                let mut cells: BTreeMap<usize, Vec<Span>> = BTreeMap::new();
                // A typed line of the row with one cell where the row's first line had several is a value wrapped onto
                // the next line: it goes on in the row's last column, not column 0.
                let columns = units[u].lines.first().and_then(|&n| typed[n].cells.as_ref()).map_or(0, Vec::len);
                for &n in &units[u].lines {
                    let line_cells = typed[n].cells.iter().flatten().collect::<Vec<_>>();
                    let wrapped = columns >= 2 && line_cells.len() == 1;
                    for (c, found) in line_cells.into_iter().enumerate() {
                        cells.entry(if wrapped { columns - 1 } else { c }).or_default().extend(spans(found)?);
                    }
                }
                // A cell's text in reading order.
                let width = cells.keys().next_back().map_or(0, |c| c + 1);
                let row: Vec<Vec<Span>> = (0..width).map(|c| {
                    let mut found = cells.remove(&c).unwrap_or_default();
                    found.sort_by_key(|s| at(s));
                    found
                }).collect();
                let Some(first) = row.iter().flatten().min_by_key(|s| at(s)) else { continue };
                let page = page_of(first);
                match pages.iter_mut().find(|(p, _)| *p == page) {
                    Some((_, grid)) => grid.push(row),
                    None => pages.push((page, vec![row])),
                }
            }
            let width = pages.iter().flat_map(|(_, grid)| grid.iter().map(Vec::len)).max().unwrap_or(0);
            let mut chain = Vec::new();
            for (_, grid) in pages {
                let rows: Vec<Vec<Option<Vec<Span>>>> = grid.into_iter().map(|mut row| {
                    row.resize(width, Vec::new());
                    row.into_iter().map(Some).collect()
                }).collect();
                let populated: Vec<Span> = rows.iter().flatten().flatten().flatten().copied().collect();
                chain.push(populated[0].at());
                tables.push(Table { spans: populated, rows });
            }
            for pair in chain.windows(2) {
                links.entry("table".into()).or_default().insert(pair[0], pair[1]);
            }
        }
        Ok(Side { lines, index, reading_order: order, positions, span_rank, blocks, notes, tables, documents, links }.finished())
    }

    /// A parse's structure: its nodes read as blocks over its source lines, each the text the most specific node
    /// owns on one page, between the places its continuations join.
    pub fn of_parse(structure: &DocumentStructure) -> Result<Side, String> {
        if structure.offset_unit != "utf16" {
            return Err("Expected the native UTF-16 structure contract".into());
        }
        let units16: Vec<u16> = structure.text.encode_utf16().collect();
        let slice = |start: usize, end: usize| -> Result<String, String> {
            String::from_utf16(units16.get(start..end).ok_or("Invalid native source fragment")?).map_err(|e| e.to_string())
        };
        // Each source line: its id, text, page and range (UTF-16) in the structure's text.
        let mut sources: Vec<(String, String, usize, ScalarRange)> = Vec::new();
        if !structure.source_fragments.is_empty() {
            for fragment in &structure.source_fragments {
                sources.push((fragment.id.clone(), slice(fragment.range.start, fragment.range.end)?, fragment.page_index + 1, fragment.range));
            }
        } else {
            for page in structure.nodes.iter().filter(|n| n.kind == NodeKind::Page) {
                let (mut start, end) = (page.range.start, page.range.end);
                let content = slice(start, end)?;
                if page.line_ids.is_empty() && content.split('\n').next().unwrap_or("").is_empty() {
                    continue;
                }
                let pieces: Vec<&str> = content.split('\n').collect();
                if pieces.len() != page.line_ids.len() {
                    return Err("Native page source IDs do not match its text range".into());
                }
                for (id, text) in page.line_ids.iter().zip(pieces) {
                    let stop = start + text.encode_utf16().count();
                    sources.push((id.clone(), text.to_owned(), page.page_indexes[0] + 1, ScalarRange { start, end: stop }));
                    start = stop + 1;
                }
            }
        }
        // The parser's reading order is its text order, so the alignment's page-local diff follows it, as it follows the
        // gold's typed order on the other side; box geometry would interleave the columns of a two-column page.
        let lines: Vec<Line> = sources.iter().enumerate()
            .map(|(k, (id, text, page, _))| Line { id: id.clone(), page: *page, text: text.chars().collect(), spatial: (*page, k as f64, 0.0) })
            .collect();
        let index: HashMap<String, usize> = lines.iter().enumerate().map(|(n, l)| (l.id.clone(), n)).collect();
        if index.len() != lines.len() {
            return Err("Duplicate native line ID".into());
        }
        let text = ScalarText::new(&structure.text);
        // The lines by their range, each with where its text starts in scalars.
        let mut ordered: Vec<(usize, ScalarRange, usize)> = Vec::new();
        for (n, (_, _, _, range)) in sources.iter().enumerate() {
            ordered.push((n, *range, text.scalar_at_utf16(range.start).ok_or("Invalid source boundary")?));
        }
        ordered.sort_by_key(|(_, range, _)| (range.start, range.end));
        // A UTF-16 range as spans of the source lines it crosses.
        let line_spans = |ranges: &[ScalarRange]| -> Result<Vec<Span>, String> {
            let mut result = Vec::new();
            for range in ranges {
                for &(line, extent, scalar_start) in &ordered {
                    let (start, end) = (range.start.max(extent.start), range.end.min(extent.end));
                    if start < end {
                        result.push(Span {
                            line,
                            start: text.scalar_at_utf16(start).ok_or("Annotation splits a source character")? - scalar_start,
                            end: text.scalar_at_utf16(end).ok_or("Annotation splits a source character")? - scalar_start,
                        });
                    }
                }
            }
            Ok(result)
        };
        let nodes: HashMap<_, _> = structure.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
        let membership = |node: &StructureNode| if node.ranges.is_empty() { vec![node.range] } else { node.ranges.clone() };
        // A note as its page prints it, one unit: its label (its marker range), what stands between the label and its
        // body, and its body (its ranges).
        let note_extent = |node: &StructureNode| {
            let mut ranges = membership(node);
            if let Some(label) = node.marker_range {
                // The body opens at the first range after the label; the PDF's note holds its label as a range of its own.
                let opening = ranges.iter().map(|range| range.start).filter(|start| *start >= label.end).min().unwrap_or(label.end);
                ranges.push(ScalarRange { start: label.start, end: label.end.max(opening) });
            }
            ScalarRange::normalize_union(&mut ranges);
            ranges
        };
        let mut endpoints = structure.continuations.as_deref().unwrap_or_default().iter().flat_map(|link| [link.from, link.to]).collect::<Vec<_>>();
        endpoints.sort_unstable();
        endpoints.dedup();
        // Each unit's own membership (a heading's heading text), the most specific owning a span. A table row is a unit
        // too (the gold types a table one row at a time, cells joined): what the parser reads inside it (a cell's
        // paragraph, a heading) stays the row's.
        let mut rows: Vec<ScalarRange> = structure.nodes.iter().filter(|node| node.kind == NodeKind::Row).flat_map(membership).collect();
        rows.sort_by_key(|row| (row.start, row.end));
        // The row part a range opens in is the last to open at or before it; parts do not overlap.
        let in_row = |ranges: &[ScalarRange]| !ranges.is_empty() && ranges.iter().all(|range| {
            let at = rows.partition_point(|row| row.start <= range.start);
            at > 0 && range.end <= rows[at - 1].end
        });
        let mut candidates = Vec::new();
        for node in &structure.nodes {
            if node.kind != NodeKind::Row && in_row(&membership(node)) {
                continue;
            }
            let heading = node.kind == NodeKind::Heading || node.role == Some(PrimaryRole::Heading);
            if node.role.is_none() && !heading && !matches!(node.kind, NodeKind::Prose | NodeKind::Paragraph | NodeKind::Section
                | NodeKind::ListItem | NodeKind::Footnote | NodeKind::Endnote | NodeKind::Row) {
                continue;
            }
            let ranges = if heading { node.heading_range.map_or_else(|| membership(node), |range| vec![range]) }
                else if matches!(node.kind, NodeKind::Footnote | NodeKind::Endnote) { note_extent(node) } else { membership(node) };
            let size: usize = ranges.iter().map(|range| range.end.saturating_sub(range.start)).sum();
            let priority = if node.role.is_some() { 0 } else if node.kind == NodeKind::Heading { 1 }
                else if matches!(node.kind, NodeKind::Paragraph | NodeKind::ListItem) { 2 } else { 3 };
            candidates.push((node, ranges, size, priority));
        }
        // A display quotation is a passage, not a reproduced document: long quotation nodes (a book of authorities'
        // reprinted decisions) type nothing.
        let quote_ranges: Vec<ScalarRange> = structure.nodes.iter().filter(|node| node.kind == NodeKind::Quote && node.line_ids.len() <= 60).flat_map(membership).collect();
        let rank = |index: usize| (candidates[index].2, candidates[index].3, index);
        let mut owner_endpoints = HashMap::<usize, Vec<usize>>::new();
        for &offset in &endpoints {
            if let Some(index) = (0..candidates.len()).filter(|&index| candidates[index].1.iter().any(|range| range.start <= offset && offset < range.end))
                .min_by_key(|&index| rank(index)) {
                owner_endpoints.entry(index).or_default().push(offset);
            }
        }
        let mut intervals = candidates.iter().enumerate()
            .flat_map(|(index, (_, ranges, _, _))| ranges.iter().map(move |range| (index, range.start, range.end)))
            .collect::<Vec<_>>();
        intervals.sort_by_key(|(_, start, end)| (*start, *end));
        // Each line cut where units and continuations start and end; its pieces go to the block of their owning unit on
        // that page, and unowned text stays a block of its line.
        let mut parts: Vec<(Option<usize>, Vec<Span>)> = Vec::new();
        let mut buckets = BTreeMap::new();
        let (mut cursor, mut active) = (0, Vec::new());
        for &(line, line_range, scalar_start) in &ordered {
            active.retain(|&(_, _, end)| end > line_range.start);
            while cursor < intervals.len() && intervals[cursor].1 < line_range.end {
                if intervals[cursor].2 > line_range.start { active.push(intervals[cursor]); }
                cursor += 1;
            }
            let here = active.iter().map(|&(index, start, end)| (index, start.max(line_range.start), end.min(line_range.end))).collect::<Vec<_>>();
            let mut cuts = vec![line_range.start, line_range.end];
            cuts.extend(endpoints.iter().copied().filter(|at| line_range.start < *at && *at < line_range.end));
            cuts.extend(here.iter().flat_map(|&(_, start, end)| [start, end]));
            cuts.sort_unstable();
            cuts.dedup();
            for edges in cuts.windows(2) {
                let (start, end) = (edges[0], edges[1]);
                if start == end { continue; }
                let owner = here.iter().filter(|(_, a, b)| *a <= start && end <= *b).map(|(index, _, _)| *index).min_by_key(|&index| rank(index));
                let span = Span {
                    line,
                    start: text.scalar_at_utf16(start).ok_or("Block splits a source character")? - scalar_start,
                    end: text.scalar_at_utf16(end).ok_or("Block splits a source character")? - scalar_start,
                };
                let key = (owner, lines[line].page,
                    owner.and_then(|index| owner_endpoints.get(&index)).map_or(0, |points| points.partition_point(|at| *at <= start)),
                    owner.is_none().then_some(line));
                let position = *buckets.entry(key).or_insert_with(|| { parts.push((owner, Vec::new())); parts.len() - 1 });
                let found = &mut parts[position].1;
                match found.last_mut().filter(|last| last.line == span.line && last.end == span.start) {
                    Some(last) => last.end = span.end,
                    None => found.push(span),
                }
            }
        }
        let anchors: HashMap<&str, At> = parts.iter().rev().filter_map(|(owner, found)| owner.map(|index| (candidates[index].0.id.as_str(), found[0].at()))).collect();
        // A transcript reads by speakers' turns: a document whose lines open on speakers' labels often enough, numbered or
        // not (a reasons' record of an examination, a hearing's minutes); a document with a few stray line labels and its
        // form's own fields ("Email:") is none.
        let transcript = {
            let written: Vec<&str> = sources.iter().map(|(_, text, _, _)| text.as_str()).filter(|text| !text.trim().is_empty()).collect();
            let spoken = written.iter().filter(|text| legal_pdf_core::layout_analysis().speaker_label(text).is_some()).count();
            let numbered = structure.nodes.iter().any(|node| node.role == Some(PrimaryRole::LineLabel));
            let share = spoken as f64 / written.len().max(1) as f64;
            (numbered && share >= 0.02) || (spoken >= 20 && share >= 0.08)
        };
        let mut read: Vec<(Block, Option<&StructureNode>)> = Vec::new();
        for (owner, found) in parts {
            let node = owner.map(|index| candidates[index].0);
            let role = node.and_then(|node| node.role).unwrap_or(match node.map(|node| node.kind) {
                Some(NodeKind::Heading) => PrimaryRole::Heading,
                _ => PrimaryRole::Text,
            });
            let mut block = Block {
                kind: String::new(), region: None, spans: Vec::new(), parent: None, heading_level: None, depth: None,
                marker: Vec::new(), line_number: Vec::new(), speaker: Vec::new(), locator: None,
            };
            if let Some(node) = node {
                // The nearest ancestor that is a block of its own.
                let (mut parent, mut visited) = (node.parent_id.as_deref(), HashSet::new());
                while let Some(id) = parent.filter(|id| visited.insert(*id)) {
                    if let Some(&at) = anchors.get(id) {
                        block.parent = Some(at);
                        break;
                    }
                    parent = nodes.get(id).and_then(|node| node.parent_id.as_deref());
                }
                block.locator = node.locator_kind.clone().or(match node.kind {
                    NodeKind::Paragraph => Some("paragraph".into()),
                    NodeKind::ListItem => Some("list_item".into()),
                    NodeKind::Section => Some("section".into()),
                    _ => None,
                });
                // A level or depth the parser states (its outline's own, gaps and all) beside the tree's.
                let stated = |key: &str| node.markup_attributes.get(key).and_then(|v| v.parse::<usize>().ok());
                (block.heading_level, block.depth) = (stated("heading_level"), stated("depth"));
                if let Some(marker) = node.marker_range.filter(|_| !matches!(node.kind, NodeKind::Footnote | NodeKind::Endnote)) {
                    block.marker = line_spans(&[marker])?.into_iter().filter_map(|mut mark| {
                        let span = found.iter().find(|span| span.line == mark.line)?;
                        mark.start = mark.start.max(span.start);
                        mark.end = mark.end.min(span.end);
                        (mark.start < mark.end).then_some(mark)
                    }).collect();
                }
            }
            // A transcript's turn opens with its speaker's label ("Q.", "MR. SMITH:").
            if transcript && role == PrimaryRole::Text {
                let first = found[0];
                let opening: String = lines[first.line].text.iter().skip(first.start).take(first.end - first.start).collect();
                let at = |bytes: usize| first.start + opening[..bytes].chars().count();
                block.speaker = legal_pdf_core::layout_analysis().speaker_labels(&opening).into_iter()
                    .map(|(start, end)| Span { line: first.line, start: at(start), end: at(end) }).collect();
            }
            // A paragraph or item set inside a display quotation is another text's words, numbered or not: a quote block,
            // as the gold types quoted paragraphs one at a time.
            let quoted = node.is_some_and(|node| !matches!(node.kind, NodeKind::Heading | NodeKind::Footnote | NodeKind::Endnote)
                && node.role != Some(PrimaryRole::Heading)
                && quote_ranges.iter().any(|quote| {
                    let overlap = quote.end.min(node.range.end).saturating_sub(quote.start.max(node.range.start));
                    overlap * 2 > node.range.end.saturating_sub(node.range.start)
                }));
            // A passage the parser read wholly as a contents list is contents, whatever its kind.
            let contents = node.is_some_and(|node| node.grammar.as_deref() == Some("contents") && role == PrimaryRole::Text);
            let role_name = serde_json::to_value(role).unwrap().as_str().unwrap().to_owned();
            block.kind = if quoted { "quote".to_owned() } else if contents { "contents".to_owned() } else { role_name.clone() };
            // The region a node's block is scored as, as the gold names regions: a note, a list's item, a quotation (a
            // quotation node, or a block one mostly covers), a provision (a section the parser reads as text), a contents
            // list, else its role.
            block.region = node.map(|node| match node.kind {
                NodeKind::Footnote | NodeKind::Endnote => "note".to_owned(),
                NodeKind::ListItem => "list_item".to_owned(),
                NodeKind::Quote => "quote".to_owned(),
                NodeKind::Section if node.role == Some(PrimaryRole::Text) => "provision".to_owned(),
                _ if quoted => "quote".to_owned(),
                _ if contents => "contents".to_owned(),
                _ => role_name.clone(),
            });
            block.spans = found;
            read.push((block, node));
        }
        let source_at = |offset: usize| -> Result<At, String> {
            let &(line, _, scalar_start) = ordered.iter().find(|(_, range, _)| range.start <= offset && offset < range.end)
                .ok_or("Continuation has no source fragment")?;
            Ok((line, text.scalar_at_utf16(offset).ok_or("Continuation starts inside a source character")? - scalar_start))
        };
        let mut links = Links::new();
        for found in structure.continuations.as_deref().unwrap_or_default() {
            let kind = serde_json::to_value(found.kind).unwrap().as_str().unwrap().to_owned();
            links.entry(kind).or_default().insert(source_at(found.from)?, source_at(found.to)?);
        }
        // A unit printed on several pages is one object even where its text seam is not linked.
        let mut native_parts = HashMap::<&str, Vec<&Block>>::new();
        for (block, node) in &read {
            if let Some(node) = node {
                native_parts.entry(node.id.as_str()).or_default().push(block);
            }
        }
        for (id, found) in native_parts {
            let node = nodes[id];
            let kind = if node.kind == NodeKind::Heading || node.role == Some(PrimaryRole::Heading) { "heading" }
                else if matches!(node.kind, NodeKind::Footnote | NodeKind::Endnote) { "note" }
                else if node.kind == NodeKind::ListItem { "list" } else { "paragraph" };
            for pair in found.windows(2).filter(|pair| lines[pair[0].spans[0].line].page != lines[pair[1].spans[0].line].page) {
                let layer = links.entry(kind.to_owned()).or_default();
                if !layer.contains_key(&pair[0].at()) && !layer.values().any(|&next| next == pair[1].at()) {
                    layer.insert(pair[0].at(), pair[1].at());
                }
            }
        }
        // A block split at each page and at each line of another block that comes between, its parts linked as a unit's
        // parts are: the composition keeps a paragraph that runs over a page as one block; the gold writes it as parts
        // and a continuation; the two say the same.
        let mut held = vec![false; lines.len()];
        for (block, _) in &read {
            block.spans.iter().for_each(|s| held[s.line] = true);
        }
        let before = held_before(&held);
        let mut blocks = Vec::with_capacity(read.len());
        for (mut block, _) in read {
            block.spans.sort_by_key(|s| (s.line, s.start));
            let (mut pieces, mut last): (Vec<Vec<Span>>, Option<usize>) = (Vec::new(), None);
            for &s in &block.spans {
                if last.is_none_or(|previous| lines[previous].page != lines[s.line].page || s.line > previous + 1 && before[s.line] > before[previous + 1]) {
                    pieces.push(Vec::new());
                }
                pieces.last_mut().expect("part").push(s);
                last = Some(s.line);
            }
            let kind = match block.kind.as_str() {
                "heading" => "heading",
                "note" => "note",
                "furniture" | "page_label" | "line_label" => "",
                _ => "paragraph",
            };
            if pieces.len() <= 1 || kind.is_empty() {
                blocks.push(block);
                continue;
            }
            let heads: Vec<At> = pieces.iter().map(|p| p[0].at()).collect();
            // A link the block already had onward leaves from its last part.
            for layer in links.values_mut() {
                if let Some(onward) = layer.remove(&heads[0]) {
                    layer.insert(heads[heads.len() - 1], onward);
                }
            }
            link_parts(&mut links, &heads, kind, block.region.as_deref() == Some("list_item"));
            for (k, spans) in pieces.into_iter().enumerate() {
                let mut part = block.clone();
                // The block's printed spans (its marker, a turn's speaker, a line's number) are the first part's.
                if k > 0 {
                    (part.marker, part.speaker, part.line_number) = (Vec::new(), Vec::new(), Vec::new());
                }
                part.spans = spans;
                blocks.push(part);
            }
        }
        // Notes and tables over the source lines.
        let mut notes = Vec::new();
        for note in structure.nodes.iter().filter(|node| matches!(node.kind, NodeKind::Footnote | NodeKind::Endnote)) {
            let label: Vec<ScalarRange> = note.marker_range.into_iter().collect();
            let spans = line_spans(&note_extent(note))?;
            if spans.is_empty() { continue; }
            notes.push(Note { spans, label: line_spans(&label)?, references: line_spans(&note.calls)? });
        }
        let mut tables = Vec::new();
        for table in structure.nodes.iter().filter(|node| node.kind == NodeKind::Table) {
            let rows: Vec<_> = structure.nodes.iter().filter(|node| node.kind == NodeKind::Row && node.parent_id.as_deref() == Some(table.id.as_str())).collect();
            let row_ids: HashSet<_> = rows.iter().map(|node| node.id.as_str()).collect();
            let cells: Vec<_> = structure.nodes.iter().filter(|node| node.kind == NodeKind::Cell
                && node.parent_id.as_deref().is_some_and(|id| row_ids.contains(id))).collect();
            // A grid only where every row and cell has its one-based place.
            if rows.is_empty() || rows.iter().any(|row| !row.row.is_some_and(|n| n > 0))
                || cells.iter().any(|cell| !cell.row.is_some_and(|n| n > 0) || !cell.column.is_some_and(|n| n > 0)) {
                continue;
            }
            let last = |start: Option<usize>, extent: Option<usize>| start.unwrap() + extent.unwrap_or(1).max(1) - 1;
            let height = rows.iter().filter_map(|row| row.row).chain(cells.iter().map(|cell| last(cell.row, cell.row_span))).max().unwrap_or(0);
            let width = cells.iter().map(|cell| last(cell.column, cell.column_span)).max().unwrap_or(0);
            if width == 0 { continue; }
            let mut grid = vec![vec![Some(Vec::<Span>::new()); width]; height];
            for cell in &cells {
                let (r, c) = (cell.row.unwrap() - 1, cell.column.unwrap() - 1);
                let (h, w) = (cell.row_span.unwrap_or(1).max(1), cell.column_span.unwrap_or(1).max(1));
                for row in &mut grid[r..r + h] {
                    for slot in &mut row[c..c + w] { *slot = None; }
                }
                grid[r][c] = Some(line_spans(&membership(cell))?);
            }
            let spans: Vec<Span> = grid.iter().flatten().flatten().flatten().copied().collect();
            if spans.is_empty() { continue; }
            tables.push(Table { spans, rows: grid });
        }
        // The source's own document opens on its first line with text; a constituent the parser read opens another
        // under it, one a line.
        let mut documents = Vec::new();
        if let Some(&(first, _, _)) = ordered.iter().find(|&&(line, _, _)| !lines[line].text.is_empty()) {
            documents.push(Document { line: first, opening: (first, 0), root: true, kind: structure.doc_type.clone() });
            let mut opened: HashSet<&str> = HashSet::from([lines[first].id.as_str()]);
            let constituent = |n: &&StructureNode| n.kind == NodeKind::Section && n.grammar.as_deref().is_some_and(|g| g.starts_with("constituent_")) && !n.line_ids.is_empty();
            for node in structure.nodes.iter().filter(constituent) {
                if !opened.insert(node.line_ids[0].as_str()) {
                    continue;
                }
                let line = node.line_ids.iter().map(|id| index.get(id).copied().ok_or("Membership names absent source")).collect::<Result<Vec<usize>, _>>()?
                    .into_iter().min().expect("a constituent's lines");
                let kind = node.grammar.as_deref().unwrap()["constituent_".len()..].to_owned();
                documents.push(Document { line, opening: (line, 0), root: false, kind: Some(kind) });
            }
        }
        let n = lines.len();
        Ok(Side { lines, index, reading_order: (0..n).collect(), positions: (0..n).collect(), span_rank: HashMap::new(), blocks, notes, tables, documents, links }.finished())
    }

    /// Each object's spans in reading order; a source with no documents one of its own, opening where reading begins;
    /// the documents in the order they open.
    fn finished(mut self) -> Side {
        let positions = &self.positions;
        let order = |s: &Span| (positions[s.line], s.start, s.end);
        for spans in self.blocks.iter_mut().map(|b| &mut b.spans).chain(self.notes.iter_mut().map(|n| &mut n.spans)).chain(self.tables.iter_mut().map(|t| &mut t.spans)) {
            spans.sort_by_key(order);
        }
        if self.documents.is_empty() {
            if let Some(&first) = self.reading_order.first() {
                self.documents.push(Document { line: first, opening: (first, 0), root: true, kind: None });
            }
        }
        let positions = &self.positions;
        self.documents.sort_by_key(|d| ((positions[d.opening.0], d.opening.1), !d.root));
        self
    }

    /// Each block's next fragment in its logical block: blocks joined by their paragraph and heading continuations, and
    /// by a note's (the block holding the note part's last text to the one where the next part begins).
    pub fn text_links(&self) -> Result<HashMap<At, At>, String> {
        let blocks: HashSet<At> = self.blocks.iter().map(Block::at).collect();
        let mut links: BTreeMap<At, At> = BTreeMap::new();
        for kind in ["paragraph", "heading"] {
            links.extend(self.links.get(kind).into_iter().flatten().map(|(&from, &to)| (from, to)));
        }
        let parts: Vec<&[Span]> = self.notes.iter().map(|n| n.spans.as_slice()).collect();
        for (&id, &next) in self.links.get("note").into_iter().flatten() {
            let note = &self.notes[named(&parts, id).ok_or("Note continuation names absent fragment")?];
            let following = named(&parts, next).map_or(note, |k| &self.notes[k]);
            // A parser's note printed over pages may hold the next page's block outside its note text.
            let Some(first) = following.spans.iter().filter(|s| s.line == next.0 && s.end > next.1).min_by_key(|s| s.start) else { continue };
            let last = if std::ptr::eq(following, note) {
                note.spans.iter().filter(|s| (self.positions[s.line], s.end) <= self.location(next)).last().ok_or("Note continuation has no preceding body")?
            } else {
                note.spans.last().unwrap()
            };
            let block = |test: &dyn Fn(&Span) -> bool| self.blocks.iter().find(|b| b.spans.iter().any(test)).map(Block::at);
            let left = block(&|s| s.line == last.line && s.start < last.end && last.end <= s.end).ok_or("Note body has no containing block")?;
            let right = block(&|s| s.line == first.line && s.start <= first.start && first.start < s.end).ok_or("Note target has no containing block")?;
            links.insert(left, right);
        }
        let mut incoming = HashSet::new();
        for (from, next) in &links {
            if !blocks.contains(from) || !blocks.contains(next) || !incoming.insert(*next) {
                return Err("Text continuation must connect distinct blocks".into());
            }
        }
        let (mut chained, mut emitted) = (HashMap::new(), HashSet::new());
        for block in self.blocks.iter().map(Block::at).filter(|at| !incoming.contains(at)) {
            let mut at = block;
            while let Some(&next) = links.get(&at) {
                if !emitted.insert(next) {
                    return Err("Text continuation cycle".into());
                }
                chained.insert(at, next);
                at = next;
            }
        }
        Ok(chained)
    }

    /// Each part of `parts` that a link of `kind` continues, with the part it goes on in.
    fn next_parts(&self, parts: &[&[Span]], kind: &str) -> Result<HashMap<usize, usize>, String> {
        let mut next_of = HashMap::new();
        for (&from, &to) in self.links.get(kind).into_iter().flatten() {
            let (left, right) = named(parts, from).zip(named(parts, to)).ok_or("Continuation names absent annotation fragment")?;
            if left != right {
                next_of.insert(left, right);
            }
        }
        Ok(next_of)
    }

    /// Objects of one kind continued across fragments read as one: each chain of `parts` (each part's spans) the links of
    /// `kind` join, in reading order, each link naming the part `named` reads at its place.
    fn chains(&self, parts: &[&[Span]], kind: &str) -> Result<Vec<Vec<usize>>, String> {
        let next_of = self.next_parts(parts, kind)?;
        let mut ordered: Vec<usize> = (0..parts.len()).collect();
        ordered.sort_by_key(|&k| self.location(parts[k][0].at()));
        let (mut consumed, mut chains) = (HashSet::new(), Vec::new());
        for k in ordered {
            if !consumed.insert(k) { continue; }
            let mut chain = vec![k];
            // A part two chains claim stays with the chain that reached it first in reading order.
            while let Some(&next) = next_of.get(chain.last().unwrap()) {
                if !consumed.insert(next) { break; }
                chain.push(next);
            }
            chains.push(chain);
        }
        Ok(chains)
    }

    /// Each note read whole across its continued parts: their spans, labels and references together.
    pub fn whole_notes(&self) -> Result<Vec<Note>, String> {
        let parts: Vec<&[Span]> = self.notes.iter().map(|n| n.spans.as_slice()).collect();
        Ok(self.chains(&parts, "note")?.into_iter().map(|chain| {
            let parts = chain.iter().map(|&k| &self.notes[k]);
            Note {
                spans: parts.clone().flat_map(|n| n.spans.iter().copied()).collect(),
                label: parts.clone().flat_map(|n| n.label.iter().copied()).collect(),
                references: parts.flat_map(|n| n.references.iter().copied()).collect(),
            }
        }).collect())
    }

    /// Each table read whole across its continued grids: their rows one after another.
    pub fn whole_tables(&self) -> Result<Vec<Table>, String> {
        let parts: Vec<&[Span]> = self.tables.iter().map(|t| t.spans.as_slice()).collect();
        Ok(self.chains(&parts, "table")?.into_iter().map(|chain| Table {
            spans: chain.iter().flat_map(|&k| self.tables[k].spans.iter().copied()).collect(),
            rows: chain.iter().flat_map(|&k| self.tables[k].rows.iter().cloned()).collect(),
        }).collect())
    }

    /// The document that owns each block: the one holding its note's references where they name one document, else the
    /// innermost opened at or before it; none (the source's own) before the first.
    pub fn owners(&self) -> Result<Vec<Option<usize>>, String> {
        let root = self.documents.iter().position(|d| d.root);
        for (k, d) in self.documents.iter().enumerate() {
            if !d.root && root.is_none_or(|root| root > k) {
                return Err("Constituent parent must enclose its start".into());
            }
        }
        let owner = |at: At| self.documents.iter().rposition(|d| self.location(d.opening) <= self.location(at));
        // A note belongs to the document holding its references when they name one document, its continued parts with it.
        let parts: Vec<&[Span]> = self.notes.iter().map(|n| n.spans.as_slice()).collect();
        let next_of = self.next_parts(&parts, "note")?;
        let mut note_owners = Vec::<(&[Span], Option<usize>)>::new();
        for (first, note) in self.notes.iter().enumerate() {
            let documents: HashSet<Option<usize>> = note.references.iter().map(|r| owner(r.at())).collect();
            if documents.len() != 1 { continue; }
            let document = documents.into_iter().next().unwrap();
            let (mut current, mut seen) = (first, HashSet::new());
            loop {
                let part = &self.notes[current];
                if !seen.insert(current) || current != first && !part.references.is_empty() { break; }
                note_owners.push((&part.spans, document));
                let Some(&next) = next_of.get(&current) else { break };
                current = next;
            }
        }
        Ok(self.blocks.iter().map(|block| note_owners.iter()
            .find(|(note, _)| block.spans.iter().all(|s| note.iter().any(|n| n.line == s.line && n.start <= s.start && s.end <= n.end)))
            .map_or_else(|| owner(block.at()), |&(_, document)| document)).collect())
    }
}
