//! Labels on each piece of the source, a line cut at every boundary of the frame's blocks: the
//! region of the unit holding it; whether it opens that unit, continues the unit open in its
//! stream, or resumes an earlier unit (pointed at); the unit a unit falls under (pointed at); and
//! whether a document opens or a paired note reference sits on it. Read alike from the gold
//! (training targets) and from the parser (tier 0), and decoded back into the gold's own form. The
//! gold's own labels decode to the gold: `selfcheck labels` must read 1.0 on every layer.
use crate::alignment::Alignment;
use crate::state::{block_id, Gold, State};
use legal_structure::SourceSpan;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const REGIONS: [&str; 13] = [
    "none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote", "marginal_note",
    "furniture", "page_label",
];
pub const STARTS: [&str; 3] = ["inside", "unit", "resume"];
pub const RELATIONS: [&str; 10] = ["none", "first", "child", "sibling", "up 1", "up 2", "up 3", "up 4", "up 5", "other"];

/// Characters [start, end) of one line of a frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Piece {
    pub line: usize,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Default, Debug)]
pub struct Label {
    pub region: usize,
    /// 0 continues the unit open in the piece's stream, 1 opens a unit, 2 resumes `continues`.
    pub start: usize,
    /// On a resuming piece, the first piece (line@offset) of the unit it resumes.
    pub continues: Option<String>,
    /// On a unit's first piece, the first piece of the unit it falls under.
    pub parent: Option<String>,
    /// On a ranked unit's first piece, its relation to the ranked unit before it, read from parents
    /// as the scorer reads them.
    pub relation: usize,
    pub document: bool,
    pub reference: bool,
}

pub fn anchor(state: &State, piece: &Piece) -> String {
    format!("{}@{}", state.lines[piece.line].id, piece.start)
}

fn index_of(values: &[&str], value: &str) -> usize {
    values.iter().position(|v| *v == value).unwrap_or(0)
}

fn relation_index(relation: &str) -> usize {
    match RELATIONS.iter().position(|v| *v == relation) {
        Some(n) => n,
        None if relation.starts_with("up ") => RELATIONS.len() - 1,
        None => 0,
    }
}

/// Units of one stream run on past the units of the others that interrupt them.
pub(crate) fn stream(region: usize) -> usize {
    match REGIONS[region] {
        "note" => 1,
        "marginal_note" => 2,
        "furniture" => 3,
        "page_label" => 4,
        _ => 0,
    }
}

fn spans_of(state: &State, spans: &[SourceSpan], line_ids: &[String]) -> Vec<SourceSpan> {
    if !spans.is_empty() {
        return spans.to_vec();
    }
    line_ids
        .iter()
        .filter_map(|id| state.index.get(id).map(|&n| SourceSpan { line_id: id.clone(), start: 0, end: state.lines[n].text.len() }))
        .collect()
}

fn span_list(value: Option<&Value>) -> Vec<SourceSpan> {
    serde_json::from_value(value.cloned().unwrap_or(Value::Null)).unwrap_or_default()
}

/// Every line cut at every boundary of the frame's block spans, in its reading order.
pub fn pieces(state: &State) -> Vec<Piece> {
    let mut cuts: Vec<Vec<usize>> = state.lines.iter().map(|l| vec![0, l.text.len()]).collect();
    for group in &state.groups {
        for span in spans_of(state, &group.spans, &group.line_ids) {
            if let Some(&n) = state.index.get(&span.line_id) {
                let length = state.lines[n].text.len();
                cuts[n].extend([span.start.min(length), span.end.min(length)]);
            }
        }
    }
    let mut result = Vec::new();
    for &n in &state.reading_order {
        let found = &mut cuts[n];
        found.sort_unstable();
        found.dedup();
        result.extend(found.windows(2).map(|w| Piece { line: n, start: w[0], end: w[1] }));
    }
    result
}

/// The piece holding a point of a line, by line.
pub struct Locator(HashMap<usize, Vec<(usize, usize, usize)>>);

impl Locator {
    pub fn new(pieces: &[Piece]) -> Self {
        let mut by_line: HashMap<usize, Vec<(usize, usize, usize)>> = HashMap::new();
        for (k, p) in pieces.iter().enumerate() {
            by_line.entry(p.line).or_default().push((p.start, p.end, k));
        }
        for found in by_line.values_mut() {
            found.sort_unstable();
        }
        Locator(by_line)
    }

    pub fn at(&self, line: usize, at: usize) -> Option<usize> {
        let found = self.0.get(&line)?;
        found.iter().find(|&&(a, b, _)| a <= at && at < b).or_else(|| found.iter().find(|&&(a, _, _)| a == at)).map(|&(_, _, k)| k)
    }

    fn within(&self, line: usize, start: usize, end: usize) -> impl Iterator<Item = usize> + '_ {
        self.0.get(&line).into_iter().flatten().filter(move |&&(a, b, _)| start <= a && b <= end).map(|&(_, _, k)| k)
    }
}

/// A line id or a line@offset anchor, as a line and an offset of `state`.
fn point(state: &State, id: &str) -> Option<(usize, usize)> {
    if let Some(&n) = state.index.get(id) {
        return Some((n, 0));
    }
    let (line, offset) = id.rsplit_once('@')?;
    Some((*state.index.get(line)?, offset.parse().ok()?))
}

fn find(parents: &mut [usize], x: usize) -> usize {
    let mut root = x;
    while parents[root] != root {
        root = parents[root];
    }
    let mut at = x;
    while parents[at] != root {
        let next = parents[at];
        parents[at] = root;
        at = next;
    }
    root
}

/// Each piece's labels, in the frame's reading order; regions are read at each unit's first piece.
pub fn labels(state: &State, region: &dyn Fn(&Piece) -> usize) -> Result<(Vec<Piece>, Vec<Label>), String> {
    let pieces = pieces(state);
    let locate = Locator::new(&pieces);
    let mut key_of: HashMap<String, usize> = HashMap::new();
    for (g, group) in state.groups.iter().enumerate() {
        key_of.entry(block_id(group)).or_insert(g);
    }
    // Each piece's block is the first holding it.
    let mut holder: Vec<Option<usize>> = vec![None; pieces.len()];
    for (g, group) in state.groups.iter().enumerate() {
        for span in spans_of(state, &group.spans, &group.line_ids) {
            let Some(&n) = state.index.get(&span.line_id) else { continue };
            for k in locate.within(n, span.start, span.end).collect::<Vec<_>>() {
                holder[k].get_or_insert(g);
            }
        }
    }
    // A unit is a block with the fragments its continuations and logical blocks join to it.
    let mut joined: Vec<usize> = (0..state.groups.len()).collect();
    let mut link = |a: &str, b: &str, joined: &mut Vec<usize>| {
        if let (Some(&a), Some(&b)) = (key_of.get(a), key_of.get(b)) {
            let (a, b) = (find(joined, a), find(joined, b));
            joined[a.max(b)] = a.min(b);
        }
    };
    for (kind, links) in &state.continuations {
        if kind == "table" {
            continue;
        }
        for (from, next) in links {
            link(from, &next.next, &mut joined);
        }
    }
    let mut annotations = state.annotations.clone();
    if !annotations.iter().any(|a| a.kind == "document") && !state.reading_order.is_empty() {
        let first = &state.lines[state.reading_order[0]];
        annotations.push(legal_structure::CompositionAnnotation {
            id: "source".into(), kind: "document".into(), line_ids: vec![first.id.clone()],
            spans: vec![SourceSpan { line_id: first.id.clone(), start: 0, end: first.text.len() }],
            attributes: serde_json::json!({"parent": null}).as_object().unwrap().clone(),
        });
    }
    let composed = legal_structure::apply_structure_composition(legal_structure::CompositionRequest {
        lines: state.composition_lines(), groups: state.groups.clone(), annotations: annotations.clone(),
        reading_order: state.order_ids(), continuations: state.continuations.clone(),
    })?;
    for parts in composed.logical_blocks.values() {
        for pair in parts.windows(2) {
            link(&pair[0], &pair[1], &mut joined);
        }
    }
    let unit: Vec<Option<usize>> = holder.iter().map(|h| h.map(|g| find(&mut joined, g))).collect();
    let mut first: HashMap<usize, usize> = HashMap::new();
    for (k, u) in unit.iter().enumerate() {
        if let Some(u) = u {
            first.entry(*u).or_insert(k);
        }
    }
    let region_of: HashMap<usize, usize> = first.iter().map(|(&u, &k)| (u, region(&pieces[k]))).collect();
    let mut result = vec![Label::default(); pieces.len()];
    let mut open: [Option<usize>; 5] = [None; 5];
    for k in 0..pieces.len() {
        let Some(u) = unit[k] else { continue };
        let r = region_of[&u];
        if r == 0 {
            continue;
        }
        let s = stream(r);
        result[k].region = r;
        if first[&u] == k {
            result[k].start = 1;
        } else if open[s] != Some(u) {
            result[k].start = 2;
            result[k].continues = Some(anchor(state, &pieces[first[&u]]));
        }
        open[s] = Some(u);
    }
    // Parents: the unit holding the block a unit's first block names.
    let mut parent_of: HashMap<usize, usize> = HashMap::new();
    for (&u, &k) in &first {
        let Some(name) = holder[k].and_then(|g| state.groups[g].attributes.get("parent")).and_then(Value::as_str) else { continue };
        let target = key_of.get(name).copied().or_else(|| point(state, name).and_then(|(n, at)| locate.at(n, at)).and_then(|k| holder[k]));
        let Some(p) = target.map(|g| find(&mut joined, g)).filter(|&p| p != u) else { continue };
        if let Some(&pk) = first.get(&p) {
            result[k].parent = Some(anchor(state, &pieces[pk]));
            parent_of.insert(u, p);
        }
    }
    // Relations, as the scorer reads them over ranked units in reading order.
    let tables: Vec<SourceSpan> = annotations.iter().filter(|a| a.kind == "table").flat_map(|a| spans_of(state, &a.spans, &a.line_ids)).collect();
    let notes: Vec<SourceSpan> = annotations.iter().filter(|a| a.kind == "note").flat_map(|a| spans_of(state, &a.spans, &a.line_ids)).collect();
    let holds = |extents: &[SourceSpan], k: usize| {
        let p = &pieces[k];
        extents.iter().any(|s| state.index.get(&s.line_id) == Some(&p.line) && s.start <= p.start && p.start < s.end)
    };
    let mut ranked: Vec<(usize, usize)> = first.iter().map(|(&u, &k)| (k, u))
        .filter(|&(k, u)| !matches!(REGIONS[region_of[&u]], "furniture" | "page_label" | "marginal_note" | "contents") || holds(&tables, k))
        .filter(|&(k, _)| !holds(&notes, k))
        .collect();
    ranked.sort_unstable();
    for (n, &(k, u)) in ranked.iter().enumerate() {
        let relation = if n == 0 {
            "first".to_owned()
        } else {
            let (previous, parent) = (ranked[n - 1].1, parent_of.get(&u).copied());
            if parent == Some(previous) {
                "child".to_owned()
            } else {
                let (mut chain, mut at, mut seen) = (Vec::new(), Some(previous), HashSet::new());
                while let Some(current) = at.filter(|a| seen.insert(*a)) {
                    chain.push(current);
                    at = parent_of.get(&current).copied();
                }
                chain.iter().enumerate().find(|(_, a)| parent_of.get(a).copied() == parent)
                    .map_or("other".to_owned(), |(k, _)| if k == 0 { "sibling".to_owned() } else { format!("up {k}") })
            }
        };
        result[k].relation = relation_index(&relation);
    }
    for a in &annotations {
        // A document under another opens on its first piece; the source's own needs no label.
        if a.kind == "document" && a.attributes.get("parent").is_some_and(|p| !p.is_null()) {
            let opening = a.spans.first().map(|s| (s.line_id.as_str(), s.start)).or(a.line_ids.first().map(|id| (id.as_str(), 0)));
            if let Some(k) = opening.and_then(|(id, at)| state.index.get(id).and_then(|&n| locate.at(n, at))) {
                result[k].document = true;
            }
        }
        if a.kind == "note" {
            for s in span_list(a.attributes.get("references")) {
                if let Some(k) = state.index.get(&s.line_id).and_then(|&n| locate.at(n, s.start)) {
                    result[k].reference = true;
                }
            }
        }
    }
    Ok((pieces, result))
}

/// Regions over spans of a frame's lines; a piece takes the region of the span holding it.
pub struct Regions(HashMap<usize, Vec<(usize, usize, usize)>>);

impl Regions {
    pub fn of(&self, piece: &Piece) -> usize {
        self.0.get(&piece.line)
            .and_then(|found| found.iter().find(|&&(a, b, _)| a <= piece.start && piece.end <= b && a < b))
            .map_or(0, |&(_, _, r)| r)
    }
}

/// The gold's regions: each unit's spans take the region of its first typed item.
pub fn gold_regions(gold: &Gold, state: &State) -> Regions {
    let mut found: HashMap<usize, Vec<(usize, usize, usize)>> = HashMap::new();
    for unit in &gold.units {
        let Some(&head) = unit.lines.first() else { continue };
        let region = index_of(&REGIONS, &gold.typed[head].region);
        for &t in &unit.lines {
            for span in &gold.typed[t].spans {
                if let Some(&n) = state.index.get(&span.line_id) {
                    found.entry(n).or_default().push((span.start, span.end, region));
                }
            }
        }
    }
    Regions(found)
}

/// The parser's regions, in the gold's terms: its block's role, a note or a table where an
/// annotation holds the block's span, a list item where the block is one.
pub fn parsed_regions(state: &State) -> Regions {
    let mut holders: HashMap<&str, Vec<(&str, usize, usize)>> = HashMap::new();
    for a in state.annotations.iter().filter(|a| a.kind == "note" || a.kind == "table") {
        for s in &a.spans {
            holders.entry(s.line_id.as_str()).or_default().push((a.kind.as_str(), s.start, s.end));
        }
        if a.spans.is_empty() {
            for id in &a.line_ids {
                holders.entry(id.as_str()).or_default().push((a.kind.as_str(), 0, usize::MAX));
            }
        }
    }
    let mut found: HashMap<usize, Vec<(usize, usize, usize)>> = HashMap::new();
    for group in &state.groups {
        let kind = match group.kind.as_str() { "prose" => "text", "header" | "footer" => "furniture", other => other };
        let list = kind == "text" && group.attributes.get("locator_kind").and_then(Value::as_str) == Some("list_item");
        for span in spans_of(state, &group.spans, &group.line_ids) {
            let Some(&n) = state.index.get(&span.line_id) else { continue };
            let held = holders.get(span.line_id.as_str())
                .and_then(|all| all.iter().find(|(_, a, b)| *a <= span.start && span.start < *b).map(|(k, _, _)| *k));
            let region = match held {
                Some(kind) => kind,
                None if list => "list_item",
                None => kind,
            };
            found.entry(n).or_default().push((span.start, span.end, index_of(&REGIONS, region)));
        }
    }
    Regions(found)
}

/// The gold's labels carried onto another frame's pieces through the scorer's alignment: a piece
/// takes the label of the gold piece its first aligned character falls in, opening what that gold
/// piece opens only where it holds the gold piece's first character; pointers move to the piece
/// holding the start of the gold piece they name.
pub fn carry(reference: &State, gold_pieces: &[Piece], gold: &[Label], candidate: &State, pieces: &[Piece], alignment: &Alignment)
    -> Vec<Option<Label>> {
    let gold_at = Locator::new(gold_pieces);
    // Each candidate piece's aligned stretches of gold lines.
    let mut aligned: HashMap<usize, Vec<(usize, usize, usize)>> = HashMap::new();
    let mut stretches: Vec<Vec<(usize, usize, usize)>> = vec![Vec::new(); pieces.len()];
    for (k, piece) in pieces.iter().enumerate() {
        for &(lo, hi, r, offset, limit) in &alignment.mappings[piece.line] {
            let (a, b) = (piece.start.max(lo), piece.end.min(hi));
            if a >= b {
                continue;
            }
            let exact = hi - lo == limit - offset;
            let (ga, gb) = if exact { (offset + a - lo, offset + b - lo) } else { (offset, limit) };
            stretches[k].push((r, ga, gb));
            aligned.entry(r).or_default().push((ga, gb, k));
        }
    }
    let moved = |name: &str| -> Option<String> {
        let (r, at) = point(reference, name)?;
        let k = aligned.get(&r)?.iter().find(|&&(a, b, _)| a <= at && at < b)?.2;
        Some(anchor(candidate, &pieces[k]))
    };
    (0..pieces.len()).map(|k| {
        let &(r, at, _) = stretches[k].first()?;
        let g = gold_at.at(r, at)?;
        let source = &gold[g];
        let mut label = Label { region: source.region, ..Label::default() };
        if at == gold_pieces[g].start {
            label.start = source.start;
            label.continues = source.continues.as_deref().and_then(moved);
            label.parent = source.parent.as_deref().and_then(moved);
            label.relation = source.relation;
            label.document = source.document;
        }
        // A paired reference anywhere in the gold this piece covers.
        label.reference = stretches[k].iter().any(|&(r, a, b)| {
            gold_at.0.get(&r).into_iter().flatten().any(|&(start, end, g)| start < b && a < end && gold[g].reference)
        });
        Some(label)
    }).collect()
}

/// Labels decoded into the gold's own form over a frame's pieces in its reading order. A piece that
/// opens a unit opens one; one that continues joins the unit open in its stream; one that resumes
/// joins the unit it names. The frame supplies what the labels do not say: markers, the paired
/// note references the labels keep, the notes they pair with, and table cells.
pub fn decode(candidate: &State, pieces: &[Piece], labels: &[Label], source_sha256: &str) -> Gold {
    use crate::state::{GoldLine, NotePair, Reference, Typed, Unit, V4};
    let locate = Locator::new(pieces);
    let piece_at = |span: &SourceSpan| candidate.index.get(&span.line_id).and_then(|&n| locate.at(n, span.start));
    let mut markers: HashMap<usize, Vec<SourceSpan>> = HashMap::new();
    for group in &candidate.groups {
        let found = span_list(group.attributes.get("marker"));
        let start = spans_of(candidate, &group.spans, &group.line_ids).into_iter().next();
        if let (false, Some(k)) = (found.is_empty(), start.as_ref().and_then(piece_at)) {
            markers.entry(k).or_insert(found);
        }
    }
    let mut note_labels: HashMap<usize, Vec<SourceSpan>> = HashMap::new();
    let mut references: HashMap<usize, Vec<SourceSpan>> = HashMap::new();
    for a in candidate.annotations.iter().filter(|a| a.kind == "note") {
        let label = span_list(a.attributes.get("label"));
        if let (false, Some(k)) = (label.is_empty(), a.spans.first().and_then(piece_at)) {
            note_labels.entry(k).or_insert(label);
        }
        for s in span_list(a.attributes.get("references")) {
            if let Some(k) = piece_at(&s) {
                references.entry(k).or_default().push(s);
            }
        }
    }
    // Table cells by piece, each with its column and the width of its row.
    let mut cells: HashMap<usize, Vec<(usize, usize, SourceSpan)>> = HashMap::new();
    for a in candidate.annotations.iter().filter(|a| a.kind == "table") {
        for row in a.attributes.get("rows").and_then(Value::as_array).into_iter().flatten() {
            let row = row.as_array().cloned().unwrap_or_default();
            for (c, cell) in row.iter().enumerate() {
                for span in span_list(Some(cell)) {
                    if let Some(k) = piece_at(&span) {
                        cells.entry(k).or_default().push((c, row.len(), span));
                    }
                }
            }
        }
    }
    let lines: Vec<GoldLine> = candidate.lines.iter().map(|l| GoldLine {
        id: l.id.clone(), page: l.page, text: l.text.iter().collect(), corrected: None,
    }).collect();
    let mut typed: Vec<Typed> = Vec::new();
    let mut typed_of: HashMap<usize, usize> = HashMap::new();
    let mut units: Vec<Unit> = Vec::new();
    let mut unit_region: Vec<usize> = Vec::new();
    let mut head: Vec<usize> = Vec::new();
    let mut unit_at: HashMap<String, usize> = HashMap::new();
    let mut open: [Option<usize>; 5] = [None; 5];
    for (k, piece) in pieces.iter().enumerate() {
        let label = &labels[k];
        if label.region == 0 {
            continue;
        }
        let s = stream(label.region);
        let resumed = if label.start == 2 { label.continues.as_deref().and_then(|a| unit_at.get(a).copied()) } else { None };
        let u = match (label.start, resumed, open[s]) {
            (2, Some(u), _) => u,
            (0 | 2, _, Some(u)) if unit_region[u] == label.region => u,
            _ => {
                units.push(Unit { lines: Vec::new(), parent: None, starts_document: label.document });
                unit_region.push(label.region);
                head.push(k);
                unit_at.insert(anchor(candidate, piece), units.len() - 1);
                units.len() - 1
            }
        };
        open[s] = Some(u);
        let region = REGIONS[unit_region[u]];
        let line = &candidate.lines[piece.line];
        let own = |s: &SourceSpan| piece_at(s) == Some(k);
        let marker = if head[u] != k { None } else if region == "note" { note_labels.get(&k) } else { markers.get(&k) };
        let mut own_references: Vec<SourceSpan> = if label.reference {
            references.get(&k).into_iter().flatten().filter(|s| own(s)).cloned().collect()
        } else {
            Vec::new()
        };
        own_references.sort_by_key(|s| s.start);
        let row_cells = (region == "table").then(|| cells.get(&k)).flatten().map(|found| {
            let width = found.iter().map(|(c, w, _)| (*w).max(c + 1)).max().unwrap_or(0);
            let mut grid = vec![Vec::new(); width];
            for (c, _, span) in found {
                grid[*c].push(span.clone());
            }
            grid
        });
        typed_of.insert(k, typed.len());
        units[u].lines.push(typed.len());
        typed.push(Typed {
            region: region.to_owned(),
            spans: vec![SourceSpan { line_id: line.id.clone(), start: piece.start, end: piece.end }],
            markers: marker.map(|m| vec![m.clone()]).unwrap_or_default(),
            references: own_references.into_iter().map(|s| Reference { spans: vec![s] }).collect(),
            cells: row_cells,
        });
    }
    for u in 0..units.len() {
        units[u].parent = labels[head[u]].parent.as_deref().and_then(|a| unit_at.get(a).copied()).filter(|&p| p != u);
    }
    // Note pairs: each frame note's references, to the unit holding the note's first piece.
    let mut notes: Vec<NotePair> = Vec::new();
    let unit_of_typed: HashMap<usize, usize> = units.iter().enumerate().flat_map(|(u, unit)| unit.lines.iter().map(move |&t| (t, u))).collect();
    for a in candidate.annotations.iter().filter(|a| a.kind == "note") {
        let Some(&t) = a.spans.first().and_then(piece_at).and_then(|k| typed_of.get(&k)) else { continue };
        let note = unit_of_typed[&t];
        if REGIONS[unit_region[note]] != "note" {
            continue;
        }
        for s in span_list(a.attributes.get("references")) {
            let Some(&t) = piece_at(&s).and_then(|k| typed_of.get(&k)) else { continue };
            if let Some(r) = typed[t].references.iter().position(|reference| reference.spans[0] == s) {
                notes.push(NotePair { line: t, reference: Some(r), note: Some(note) });
            }
        }
    }
    Gold { schema_version: V4.to_owned(), source_sha256: source_sha256.to_owned(), parser: Value::Null, lines, typed, units, notes }
}
