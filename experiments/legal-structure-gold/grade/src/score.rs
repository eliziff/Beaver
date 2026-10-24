//! A parser export scored against its gold, layer by layer, as `evaluate.compare` defined it:
//! the parser's page text is aligned to the gold, every boundary either side
//! draws cuts the source into pieces, and each layer compares multisets of features over them.
use crate::alignment::{align, Stats};
use crate::state::{anchor, block_id, State};
use crate::text_diff;
use legal_structure::{CompositionAnnotation, CompositionBlock, SourceSpan};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::Hash;

/// A source the pieces lie in: a gold line, or a parser line no gold line takes.
type Origin = u32;
const CANDIDATE: Origin = 1 << 31;
type Piece = (Origin, usize, usize);
type Point = (Origin, usize);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Document {
    Root,
    At(Point),
    Invalid,
}

#[derive(Clone, Copy, Default, Serialize)]
pub struct Metric {
    pub expected: usize,
    pub predicted: usize,
    pub correct: usize,
}

impl Metric {
    pub fn add(&mut self, other: &Metric) {
        self.expected += other.expected;
        self.predicted += other.predicted;
        self.correct += other.correct;
    }

    pub fn f1(&self) -> f64 {
        if self.expected + self.predicted == 0 {
            1.0
        } else {
            2.0 * self.correct as f64 / (self.expected + self.predicted) as f64
        }
    }
}

fn prf<T: Hash + Eq>(expected: &[T], actual: &[T]) -> Metric {
    let mut counts: HashMap<&T, (usize, usize)> = HashMap::new();
    for item in expected {
        counts.entry(item).or_default().0 += 1;
    }
    for item in actual {
        counts.entry(item).or_default().1 += 1;
    }
    Metric {
        expected: expected.len(),
        predicted: actual.len(),
        correct: counts.values().map(|(a, b)| *a.min(b)).sum(),
    }
}

#[derive(Default, Serialize)]
pub struct TextScore {
    pub exact_units: usize,
    pub units: usize,
    pub matched_characters: usize,
    pub characters: usize,
}

pub struct Score {
    pub metrics: BTreeMap<&'static str, Metric>,
    pub text: TextScore,
    pub alignment: Stats,
}

/// One side of the comparison: how its offsets reach the shared frame of gold lines.
struct Side<'a> {
    state: &'a State,
    candidate: bool,
    alignment: &'a crate::alignment::Alignment,
}

impl<'a> Side<'a> {
    fn new(state: &'a State, candidate: bool, alignment: &'a crate::alignment::Alignment) -> Self {
        Side {
            state,
            candidate,
            alignment,
        }
    }

    /// A text interval in the shared frame, split at line breaks.
    fn project(
        &self,
        line: usize,
        start: usize,
        end: usize,
        witness: &dyn Fn(Origin) -> &'a [char],
    ) -> Vec<Piece> {
        let mapped = if self.candidate {
            self.project_candidate(line, start, end)
        } else {
            vec![(line as Origin, start, end)]
        };
        let mut result = Vec::with_capacity(mapped.len());
        for (origin, a, b) in mapped {
            if a == b {
                result.push((origin, a, b));
                continue;
            }
            let text = witness(origin);
            let mut cursor = a;
            for point in a..b {
                if text.get(point) == Some(&'\n') {
                    if cursor < point {
                        result.push((origin, cursor, point));
                    }
                    cursor = point + 1;
                }
            }
            if cursor < b {
                result.push((origin, cursor, b));
            }
        }
        result
    }

    /// Candidate text with no gold counterpart that is only whitespace: a space the parser put
    /// between two gold lines it joined. It is no piece of any unit.
    fn blank(&self, line: usize, a: usize, b: usize) -> bool {
        self.state.lines[line].text[a.min(b)..b].iter().all(|c| c.is_whitespace())
    }

    /// A candidate interval in the frame of gold lines: on each gold line it reaches, the runs of
    /// gold characters it owns. A transcription difference inside a line is no boundary, so a
    /// unit matches when its edges match, whatever the recognizer read. Candidate text that owns
    /// no gold character at all stays in its own frame; a blank one is nothing.
    fn project_candidate(&self, line: usize, start: usize, end: usize) -> Vec<Piece> {
        let own = CANDIDATE | line as Origin;
        let spans = &self.alignment.mappings[line];
        let owners = &self.alignment.owners;
        let mine = |owner: &Option<(usize, usize)>, from: usize, to: usize| {
            matches!(owner, Some((c, p)) if *c == line && from <= *p && *p < to)
        };
        if start == end {
            // A point: the first gold character owned by the candidate line from here on.
            let mut best: Option<(usize, usize)> = None;
            for &(_, _, r, _, _) in spans {
                if let Some(at) = owners[r].iter().position(|o| mine(o, start, usize::MAX)) {
                    if best.is_none_or(|b| (r, at) < b) {
                        best = Some((r, at));
                    }
                }
            }
            return match (best, spans.last()) {
                (Some((r, at)), _) => vec![(r as Origin, at, at)],
                (None, Some(&(_, _, r, _, limit))) => vec![(r as Origin, limit, limit)],
                (None, None) => vec![(own, start, end)],
            };
        }
        let mut targets: Vec<usize> = spans
            .iter()
            .filter(|&&(lo, hi, _, _, _)| lo < end && start < hi)
            .map(|&(_, _, r, _, _)| r)
            .collect();
        targets.sort_unstable();
        targets.dedup();
        if targets.is_empty() {
            return if self.blank(line, start, end) {
                Vec::new()
            } else {
                vec![(own, start, end)]
            };
        }
        let mut result = Vec::new();
        for r in targets {
            let mut run: Option<usize> = None;
            for (at, owner) in owners[r].iter().enumerate() {
                match (mine(owner, start, end), run) {
                    (true, None) => run = Some(at),
                    (false, Some(from)) => {
                        result.push((r as Origin, from, at));
                        run = None;
                    }
                    _ => {}
                }
            }
            if let Some(from) = run {
                result.push((r as Origin, from, owners[r].len()));
            }
        }
        result
    }
}

/// A block's or annotation's spans, whole lines where it names only lines.
fn members(state: &State, spans: &[SourceSpan], line_ids: &[String]) -> Vec<SourceSpan> {
    if !spans.is_empty() {
        return spans.to_vec();
    }
    line_ids
        .iter()
        .map(|id| SourceSpan {
            line_id: id.clone(),
            start: 0,
            end: state.line(id).text.len(),
        })
        .collect()
}

fn spans_of(value: Option<&Value>) -> Result<Vec<SourceSpan>, String> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value.clone()).map_err(|e| e.to_string()),
    }
}

const UNRANKED: [&str; 4] = ["furniture", "page_label", "marginal_note", "contents"];

fn alias(kind: &str) -> &str {
    match kind {
        "prose" => "text",
        // A caption (a judgment's style of cause block, a form's field label) is running text for
        // the parser's purposes: no layer scores it apart.
        "caption" => "text",
        "header" | "footer" => "furniture",
        other => other,
    }
}

type Segments = Vec<Piece>;

#[derive(Default)]
struct Features {
    coverage: Vec<Piece>,
    order: Vec<(Piece, Piece)>,
    roles: Vec<(Piece, String)>,
    groups: Vec<Vec<Piece>>,
    joins: Vec<(Piece, Piece)>,
    hierarchy: Vec<(Option<Point>, String, String, Option<Point>, Segments)>,
    hierarchy_units: Vec<Option<Point>>,
    hierarchy_roles: Vec<(Option<Point>, String)>,
    hierarchy_relation: Vec<(Option<Point>, String)>,
    hierarchy_parent: Vec<(Option<Point>, Option<Point>)>,
    hierarchy_marker: Vec<(Option<Point>, Segments)>,
    table: Vec<(Segments, usize, usize)>,
    table_cells: Vec<(Option<Point>, usize, usize, Option<Segments>)>,
    note: Vec<(Segments, Segments)>,
    note_references: Vec<(Segments, Segments)>,
    document: Vec<Document>,
    document_ownership: Vec<(Piece, Document)>,
    continuations: Vec<(Option<Point>, Option<Point>, String)>,
    /// Units and printed markers by what the unit is, for the headline table.
    units_kind: Vec<(String, Vec<Piece>)>,
    markers_kind: Vec<(String, Option<Point>, Segments)>,
}

fn merged(values: impl IntoIterator<Item = Piece>) -> Segments {
    let mut result: Segments = Vec::new();
    for (origin, start, end) in values {
        match result.last_mut() {
            Some(last) if last.0 == origin && last.2 == start => last.2 = end,
            _ => result.push((origin, start, end)),
        }
    }
    result
}

struct Cuts(HashMap<Origin, Vec<usize>>);

impl Cuts {
    fn pieces(&self, parts: &[Piece]) -> Vec<Piece> {
        let mut result = Vec::new();
        for &(key, a, b) in parts {
            let Some(cuts) = self.0.get(&key) else {
                continue;
            };
            let from = cuts.partition_point(|&c| c < a);
            let to = cuts.partition_point(|&c| c <= b);
            result.extend(cuts[from..to].windows(2).map(|w| (key, w[0], w[1])));
        }
        result
    }
}

fn features<'a>(
    side: &Side<'a>,
    cuts: &Cuts,
    witness: &dyn Fn(Origin) -> &'a [char],
) -> Result<Features, String> {
    let state = side.state;
    let mut annotations: Vec<CompositionAnnotation> = state.annotations.clone();
    if !annotations.iter().any(|a| a.kind == "document") && !state.reading_order.is_empty() {
        // A source without declared documents is one document, as its projection states.
        let first = &state.lines[state.reading_order[0]];
        annotations.push(CompositionAnnotation {
            id: "source".into(), kind: "document".into(), line_ids: vec![first.id.clone()],
            spans: vec![SourceSpan { line_id: first.id.clone(), start: 0, end: first.text.len() }],
            attributes: serde_json::json!({"kind": null, "parent": null, "relationship": null, "title": [], "facets": {}})
                .as_object().unwrap().clone(),
        });
    }
    let line_of = |id: &str| {
        state
            .index
            .get(id)
            .copied()
            .ok_or_else(|| format!("Absent source line {id}"))
    };
    let span = |s: &SourceSpan| -> Result<Vec<Piece>, String> {
        let n = line_of(&s.line_id)?;
        Ok(side.project(n, s.start, s.end, witness))
    };
    let spans = |values: &[SourceSpan]| -> Result<Segments, String> {
        let mut parts = Vec::new();
        for s in values {
            parts.extend(span(s)?);
        }
        Ok(merged(parts))
    };
    let span_pieces = |s: &SourceSpan| -> Result<Vec<Piece>, String> { Ok(cuts.pieces(&span(s)?)) };
    let point = |id: &str| -> Result<Point, String> {
        let (n, offset) = match state.index.get(id) {
            Some(&n) => (n, 0),
            None => {
                let (line, offset) = id
                    .rsplit_once('@')
                    .ok_or_else(|| format!("Absent source line {id}"))?;
                (
                    line_of(line)?,
                    offset.parse::<usize>().map_err(|e| e.to_string())?,
                )
            }
        };
        let start = offset;
        let (origin, at, _) = side.project(n, start, start, witness)[0];
        Ok((origin, at))
    };
    let anchor_of =
        |id: Option<&str>| -> Result<Option<Point>, String> { id.map(point).transpose() };
    let roots: HashSet<&str> = annotations
        .iter()
        .filter(|a| a.kind == "document" && a.attributes.get("parent").is_none_or(Value::is_null))
        .map(|a| a.line_ids[0].as_str())
        .collect();
    let openings: HashMap<&str, &str> = annotations
        .iter()
        .filter(|a| a.kind == "document")
        .map(|a| (a.id.as_str(), a.line_ids[0].as_str()))
        .collect();
    let document = |id: &str| -> Result<Document, String> {
        let id = openings.get(id).copied().unwrap_or(id);
        if roots.contains(id) {
            Ok(Document::Root)
        } else {
            Ok(Document::At(point(id)?))
        }
    };
    let pieces = |n: usize| -> Vec<Piece> {
        cuts.pieces(&side.project(n, 0, state.lines[n].text.len(), witness))
    };
    let mut result = Features::default();
    let sequence: Vec<Piece> = state
        .reading_order
        .iter()
        .flat_map(|&n| pieces(n))
        .collect();
    result.order = sequence.windows(2).map(|w| (w[0], w[1])).collect();
    result.coverage = sequence;
    // Blocks are identified by their first source span (line@start), never by a line.
    let mut keys: Vec<String> = Vec::new();
    let mut groups: HashMap<String, &CompositionBlock> = HashMap::new();
    for group in &state.groups {
        let id = block_id(group);
        if groups.insert(id.clone(), group).is_none() {
            keys.push(id);
        }
    }
    let composed =
        legal_structure::apply_structure_composition(legal_structure::CompositionRequest {
            lines: state.composition_lines(),
            groups: state.groups.clone(),
            annotations: annotations.clone(),
            reading_order: state.order_ids(),
            continuations: state.continuations.clone(),
        })?;
    // Each block's next fragment in its logical block, from the shared assembly.
    let mut text_links: HashMap<String, String> = HashMap::new();
    for parts in composed.logical_blocks.values() {
        for pair in parts.windows(2) {
            text_links.insert(pair[0].clone(), pair[1].clone());
        }
    }
    let incoming: HashSet<&str> = text_links.values().map(String::as_str).collect();
    let mut notes: HashMap<&str, Vec<(usize, usize)>> = HashMap::new();
    let mut tables: HashMap<&str, Vec<(usize, usize)>> = HashMap::new();
    let mut annotation_members = Vec::new();
    for a in &annotations {
        if a.kind == "note" || a.kind == "table" {
            annotation_members.push((a.kind.as_str(), members(state, &a.spans, &a.line_ids)));
        }
    }
    for (kind, found) in &annotation_members {
        let target = if *kind == "note" {
            &mut notes
        } else {
            &mut tables
        };
        for s in found {
            target
                .entry(s.line_id.as_str())
                .or_default()
                .push((s.start, s.end));
        }
    }
    let inside = |block: &CompositionBlock, extents: &HashMap<&str, Vec<(usize, usize)>>| {
        let found = members(state, &block.spans, &block.line_ids);
        let first = &found[0];
        extents.get(first.line_id.as_str()).is_some_and(|all| {
            all.iter()
                .any(|&(a, b)| a <= first.start && first.start < b)
        })
    };
    let role = |block: &CompositionBlock| -> String {
        let kind = alias(&block.kind);
        if inside(block, &tables) {
            return "table".into();
        }
        // A block inside a note annotation is a note unit, as a projected note unit's region says: a
        // parser's footnote blocks are its notes, not running text.
        if inside(block, &notes) {
            return "note".into();
        }
        // A projected or tagged state names each unit's region, which is its role as scored;
        // parser output is read through its kind and locator.
        if let Some(region) = block.attributes.get("region").and_then(Value::as_str) {
            return match region { "none" | "caption" => "text", other => other }.to_owned();
        }
        if kind == "text" && side.candidate && crate::state::parser_list_item(block) {
            return "list_item".into();
        }
        kind.to_owned()
    };
    let position: HashMap<&str, usize> = state
        .reading_order
        .iter()
        .enumerate()
        .map(|(k, &n)| (state.lines[n].id.as_str(), k))
        .collect();
    let order = |id: &str| -> (usize, usize, usize) {
        let (line, at) = id.split_once('@').unwrap_or((id, ""));
        let at: usize = at.parse().unwrap_or(0);
        match state.index.get(line).and_then(|&n| state.span_rank.get(&(n, at))) {
            Some(&rank) => (0, rank, 0),
            None => (1, position.get(line).copied().unwrap_or(position.len()), at),
        }
    };
    let mut units: Vec<&str> = keys
        .iter()
        .map(String::as_str)
        .filter(|first| {
            !incoming.contains(first)
                && !UNRANKED.contains(&role(groups[*first]).as_str())
                && !inside(groups[*first], &notes)
        })
        .collect();
    units.sort_by_key(|id| order(id));
    let parent_of: HashMap<&str, Option<&str>> = units
        .iter()
        .map(|first| {
            (
                *first,
                groups[*first]
                    .attributes
                    .get("parent")
                    .and_then(Value::as_str),
            )
        })
        .collect();
    // A unit's structure is scored relative to the unit before it in reading order (its child,
    // its sibling, a sibling of its k-th ancestor), never by absolute depth.
    let mut relation: HashMap<&str, String> = HashMap::new();
    for (n, first) in units.iter().enumerate() {
        if n == 0 {
            relation.insert(first, "first".into());
            continue;
        }
        let (previous, parent) = (units[n - 1], parent_of[first]);
        if parent == Some(previous) {
            relation.insert(first, "child".into());
            continue;
        }
        let (mut chain, mut at, mut seen) = (Vec::new(), Some(previous), HashSet::new());
        while let Some(current) = at.filter(|a| seen.insert(*a)) {
            chain.push(current);
            at = parent_of.get(current).copied().flatten();
        }
        let found = chain
            .iter()
            .enumerate()
            .find(|(_, a)| parent_of.get(**a).copied().flatten() == parent)
            .map(|(k, _)| {
                if k == 0 {
                    "sibling".to_owned()
                } else {
                    format!("up {k}")
                }
            });
        relation.insert(first, found.unwrap_or_else(|| "other".into()));
    }
    for first in &keys {
        let g = groups[first.as_str()];
        let own = members(state, &g.spans, &g.line_ids);
        let kind = alias(&g.kind).to_owned();
        for s in &own {
            result
                .roles
                .extend(span_pieces(s)?.into_iter().map(|p| (p, kind.clone())));
        }
        if !incoming.contains(first.as_str()) {
            let mut parts = own;
            let mut cursor = first.as_str();
            let mut visited = HashSet::from([cursor]);
            while let Some(next) = text_links.get(cursor) {
                cursor = next.as_str();
                if !visited.insert(cursor) || !groups.contains_key(cursor) {
                    break;
                }
                let g = groups[cursor];
                parts.extend(members(state, &g.spans, &g.line_ids));
            }
            let mut found = Vec::new();
            for s in &parts {
                found.extend(span_pieces(s)?);
            }
            result.joins.extend(found.windows(2).map(|w| (w[0], w[1])));
            result.units_kind.push((role(g), found.clone()));
            result.groups.push(found);
        }
    }
    for first in &units {
        let g = groups[*first];
        let unit = Some(point(first)?);
        let kind = role(g);
        let parent = anchor_of(parent_of[first])?;
        let marker = spans_of(g.attributes.get("marker"))?;
        let marker_spans = spans(&marker)?;
        result.hierarchy.push((
            unit,
            kind.clone(),
            relation[first].clone(),
            parent,
            marker_spans.clone(),
        ));
        result.hierarchy_units.push(unit);
        if !marker.is_empty() {
            result.markers_kind.push((kind.clone(), unit, marker_spans.clone()));
        }
        result.hierarchy_roles.push((unit, kind));
        result
            .hierarchy_relation
            .push((unit, relation[first].clone()));
        result.hierarchy_parent.push((unit, parent));
        if !marker.is_empty() {
            result.hierarchy_marker.push((unit, marker_spans));
        }
    }
    let logical = legal_structure::resolve_composition_annotations(
        legal_structure::CompositionAnnotationsRequest {
            lines: state.composition_lines(),
            reading_order: state.order_ids(),
            annotations: annotations.clone(),
            continuations: state.continuations.clone(),
        },
    )?;
    for a in &logical.annotations {
        let extent = spans(&members(state, &a.spans, &a.line_ids))?;
        match a.kind.as_str() {
            "table" => {
                let rows = a
                    .attributes
                    .get("rows")
                    .and_then(Value::as_array)
                    .ok_or("Table without rows")?;
                let width = rows
                    .first()
                    .and_then(Value::as_array)
                    .ok_or("Table without rows")?
                    .len();
                result.table.push((extent, rows.len(), width));
                let first = point(&a.line_ids[0])?;
                for (r, row) in rows.iter().enumerate() {
                    for (c, cell) in row.as_array().into_iter().flatten().enumerate() {
                        let found = if cell.is_null() {
                            None
                        } else {
                            Some(spans(&spans_of(Some(cell))?)?)
                        };
                        result.table_cells.push((Some(first), r, c, found));
                    }
                }
            }
            "note" => {
                result.note.push((
                    extent.clone(),
                    spans(&spans_of(a.attributes.get("label"))?)?,
                ));
                for s in spans_of(a.attributes.get("references"))? {
                    result
                        .note_references
                        .push((extent.clone(), spans(std::slice::from_ref(&s))?));
                }
            }
            "document" => result.document.push(document(&a.line_ids[0])?),
            _ => {}
        }
    }
    // Text before the first declared document is the source's own: the root's.
    let ownership = || -> Result<Vec<(Piece, Document)>, String> {
        let owners: HashMap<&str, Option<&str>> = composed
            .groups
            .iter()
            .map(|g| (g.id.as_str(), g.document.as_deref()))
            .collect();
        let mut starts: HashMap<&str, Document> = HashMap::from([("source", Document::Root)]);
        for a in composed.annotations.iter().filter(|a| a.kind == "document") {
            starts.insert(a.id.as_str(), document(&a.line_ids[0])?);
        }
        let mut by_line: HashMap<&str, Option<&str>> = HashMap::new();
        for g in &state.groups {
            let parts = members(state, &g.spans, &g.line_ids);
            let owner = owners
                .get(anchor(&parts[0]).as_str())
                .or_else(|| owners.get(parts[0].line_id.as_str()))
                .copied()
                .flatten();
            for member in &parts {
                let id = state
                    .index
                    .get(&member.line_id)
                    .map(|&n| state.lines[n].id.as_str())
                    .ok_or("Absent source line")?;
                by_line.entry(id).or_insert(owner);
            }
        }
        let mut found = Vec::new();
        for &n in &state.reading_order {
            let Some(owner) = by_line.get(state.lines[n].id.as_str()) else {
                continue;
            };
            let here = pieces(n);
            if here.is_empty() {
                continue;
            }
            let start = owner
                .and_then(|o| starts.get(o))
                .ok_or("Unowned block")?
                .clone();
            found.extend(here.into_iter().map(|p| (p, start.clone())));
        }
        Ok(found)
    };
    result.document_ownership = match ownership() {
        Ok(found) => found,
        Err(_) => state
            .reading_order
            .iter()
            .flat_map(|&n| pieces(n))
            .map(|p| (p, Document::Invalid))
            .collect(),
    };
    for layer in state.continuations.values() {
        for (from, link) in layer {
            let kind = link
                .attributes
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            result
                .continuations
                .push((anchor_of(Some(from))?, anchor_of(Some(&link.next))?, kind));
        }
    }
    Ok(result)
}

/// Items of a layer the parser missed, and items it found that the gold does not hold.
fn differences<'t, T: Hash + Eq>(expected: &'t [T], actual: &'t [T]) -> (Vec<&'t T>, Vec<&'t T>) {
    let mut left: HashMap<&T, isize> = HashMap::new();
    for item in expected {
        *left.entry(item).or_default() += 1;
    }
    for item in actual {
        *left.entry(item).or_default() -= 1;
    }
    let mut missing = Vec::new();
    let mut spurious = Vec::new();
    let mut budget = left.clone();
    for item in expected {
        let n = budget.get_mut(item).unwrap();
        if *n > 0 {
            *n -= 1;
            missing.push(item);
        }
    }
    for item in actual {
        let n = budget.get_mut(item).unwrap();
        if *n < 0 {
            *n += 1;
            spurious.push(item);
        }
    }
    (missing, spurious)
}

/// Text of the shared frame for reading a layer's differences.
struct Render<'a> {
    reference: &'a State,
    predicted: &'a State,
}

impl Render<'_> {
    fn line(&self, origin: Origin) -> (&str, &[char]) {
        if origin & CANDIDATE != 0 {
            let line = &self.predicted.lines[(origin & !CANDIDATE) as usize];
            (&line.id, &line.text)
        } else {
            let line = &self.reference.lines[origin as usize];
            (&line.id, &line.text)
        }
    }

    fn piece(&self, (origin, a, b): Piece) -> String {
        let (id, text) = self.line(origin);
        let slice: String = text[a.min(text.len())..b.min(text.len())].iter().collect();
        let mark = if origin & CANDIDATE != 0 {
            "parser:"
        } else {
            ""
        };
        format!("{mark}{id}[{a}:{b}] {slice:?}")
    }

    fn point(&self, point: Option<Point>) -> String {
        let Some((origin, at)) = point else {
            return "-".into();
        };
        let (id, text) = self.line(origin);
        let after: String = text.iter().skip(at).take(40).collect();
        format!("{id}@{at} {after:?}")
    }

    fn segments(&self, found: &Segments) -> String {
        let text: Vec<String> = found
            .iter()
            .map(|&(origin, a, b)| {
                let (_, line) = self.line(origin);
                line[a.min(line.len())..b.min(line.len())].iter().collect()
            })
            .collect();
        let joined = text.join(" | ");
        let short: String = joined.chars().take(80).collect();
        format!("{short:?}")
    }

    fn document(&self, document: &Document) -> String {
        match document {
            Document::Root => "root".into(),
            Document::At(point) => self.point(Some(*point)),
            Document::Invalid => "invalid".into(),
        }
    }
}

/// Each layer's missed and spurious items for one document, as text.
pub fn explain(
    reference: &State,
    predicted: &State,
    layers: &[String],
    limit: usize,
) -> Result<String, String> {
    let alignment = align(reference, predicted)?;
    let gold = Side::new(reference, false, &alignment);
    let parser = Side::new(predicted, true, &alignment);
    let witness = |origin: Origin| -> &[char] {
        if origin & CANDIDATE != 0 {
            &predicted.lines[(origin & !CANDIDATE) as usize].text
        } else {
            &reference.lines[origin as usize].text
        }
    };
    let cuts = cuts_of(&gold, &parser, &witness)?;
    let wanted = features(&gold, &cuts, &witness)?;
    let got = features(&parser, &cuts, &witness)?;
    let render = Render {
        reference,
        predicted,
    };
    let mut out = String::new();
    let mut section = |name: &str, missing: Vec<String>, spurious: Vec<String>| {
        if !layers.is_empty() && !layers.iter().any(|l| l == name) {
            return;
        }
        out.push_str(&format!(
            "\n== {name}: {} missed, {} spurious\n",
            missing.len(),
            spurious.len()
        ));
        for item in missing.iter().take(limit) {
            out.push_str(&format!("  - {item}\n"));
        }
        for item in spurious.iter().take(limit) {
            out.push_str(&format!("  + {item}\n"));
        }
    };
    macro_rules! layer {
        ($name:ident, $show:expr) => {{
            let (missing, spurious) = differences(&wanted.$name, &got.$name);
            section(
                stringify!($name),
                missing.into_iter().map($show).collect(),
                spurious.into_iter().map($show).collect(),
            );
        }};
    }
    layer!(roles, |(p, kind): &(Piece, String)| format!(
        "{kind} {}",
        render.piece(*p)
    ));
    layer!(groups, |g: &Vec<Piece>| g
        .iter()
        .take(3)
        .map(|p| render.piece(*p))
        .collect::<Vec<_>>()
        .join(" … "));
    layer!(joins, |(a, b): &(Piece, Piece)| format!(
        "{} ⇒ {}",
        render.piece(*a),
        render.piece(*b)
    ));
    layer!(hierarchy_units, |u: &Option<Point>| render.point(*u));
    layer!(
        hierarchy_roles,
        |(u, kind): &(Option<Point>, String)| format!("{kind} {}", render.point(*u))
    );
    layer!(
        hierarchy_relation,
        |(u, rel): &(Option<Point>, String)| format!("{rel} {}", render.point(*u))
    );
    layer!(hierarchy_parent, |(u, parent): &(
        Option<Point>,
        Option<Point>
    )| format!(
        "{} under {}",
        render.point(*u),
        render.point(*parent)
    ));
    layer!(hierarchy_marker, |(u, marker): &(
        Option<Point>,
        Segments
    )| format!(
        "{} marker {}",
        render.point(*u),
        render.segments(marker)
    ));
    layer!(note, |(extent, label): &(Segments, Segments)| format!(
        "label {} {}",
        render.segments(label),
        render.segments(extent)
    ));
    layer!(note_references, |(extent, reference): &(
        Segments,
        Segments
    )| format!(
        "ref {} -> {}",
        render.segments(reference),
        render.segments(extent)
    ));
    layer!(table, |(extent, rows, columns): &(
        Segments,
        usize,
        usize
    )| format!(
        "{rows}x{columns} {}",
        render.segments(extent)
    ));
    layer!(table_cells, |(table, r, c, cell): &(
        Option<Point>,
        usize,
        usize,
        Option<Segments>
    )| format!(
        "{} [{r},{c}] {}",
        render.point(*table),
        cell.as_ref()
            .map_or("merged".into(), |s| render.segments(s))
    ));
    layer!(document, |d: &Document| render.document(d));
    layer!(continuations, |(a, b, kind): &(
        Option<Point>,
        Option<Point>,
        String
    )| format!(
        "{kind} {} ⇒ {}",
        render.point(*a),
        render.point(*b)
    ));
    Ok(out)
}

fn cuts_of<'a>(
    gold: &Side<'a>,
    parser: &Side<'a>,
    witness: &dyn Fn(Origin) -> &'a [char],
) -> Result<Cuts, String> {
    // Every boundary either side draws on a source: its lines and its blocks' spans.
    let mut cuts: HashMap<Origin, Vec<usize>> = HashMap::new();
    for side in [gold, parser] {
        let state = side.state;
        for (n, line) in state.lines.iter().enumerate() {
            for (key, a, b) in side.project(n, 0, line.text.len(), witness) {
                cuts.entry(key).or_default().extend([a, b]);
            }
        }
        for group in &state.groups {
            for s in members(state, &group.spans, &group.line_ids) {
                let n = *state
                    .index
                    .get(&s.line_id)
                    .ok_or("Block names an absent line")?;
                let (a, b) = (s.start, s.end);
                for (key, a, b) in side.project(n, a, b, witness) {
                    cuts.entry(key).or_default().extend([a, b]);
                }
            }
        }
    }
    for found in cuts.values_mut() {
        found.sort_unstable();
        found.dedup();
    }
    Ok(Cuts(cuts))
}

pub fn compare(reference: &State, predicted: &State) -> Result<Score, String> {
    let alignment = align(reference, predicted)?;
    let gold = Side::new(reference, false, &alignment);
    let parser = Side::new(predicted, true, &alignment);
    let witness = |origin: Origin| -> &[char] {
        if origin & CANDIDATE != 0 {
            &predicted.lines[(origin & !CANDIDATE) as usize].text
        } else {
            &reference.lines[origin as usize].text
        }
    };
    let cuts = cuts_of(&gold, &parser, &witness)?;
    let wanted = features(&gold, &cuts, &witness)?;
    let got = features(&parser, &cuts, &witness)?;
    let mut metrics = BTreeMap::new();
    metrics.insert("coverage", prf(&wanted.coverage, &got.coverage));
    metrics.insert("order", prf(&wanted.order, &got.order));
    metrics.insert("roles", prf(&wanted.roles, &got.roles));
    metrics.insert("groups", prf(&wanted.groups, &got.groups));
    metrics.insert("joins", prf(&wanted.joins, &got.joins));
    metrics.insert("hierarchy", prf(&wanted.hierarchy, &got.hierarchy));
    metrics.insert(
        "hierarchy_units",
        prf(&wanted.hierarchy_units, &got.hierarchy_units),
    );
    metrics.insert(
        "hierarchy_roles",
        prf(&wanted.hierarchy_roles, &got.hierarchy_roles),
    );
    metrics.insert(
        "hierarchy_relation",
        prf(&wanted.hierarchy_relation, &got.hierarchy_relation),
    );
    metrics.insert(
        "hierarchy_parent",
        prf(&wanted.hierarchy_parent, &got.hierarchy_parent),
    );
    metrics.insert(
        "hierarchy_marker",
        prf(&wanted.hierarchy_marker, &got.hierarchy_marker),
    );
    metrics.insert("table", prf(&wanted.table, &got.table));
    metrics.insert("table_cells", prf(&wanted.table_cells, &got.table_cells));
    metrics.insert("note", prf(&wanted.note, &got.note));
    metrics.insert(
        "note_references",
        prf(&wanted.note_references, &got.note_references),
    );
    metrics.insert("document", prf(&wanted.document, &got.document));
    metrics.insert(
        "document_ownership",
        prf(&wanted.document_ownership, &got.document_ownership),
    );
    metrics.insert(
        "continuations",
        prf(&wanted.continuations, &got.continuations),
    );
    // The headline layers: what the apps read, by kind of unit.
    const KINDS: [(&str, &str, &str); 6] = [
        ("heading", "units_heading", "markers_heading"),
        ("text", "units_text", "markers_text"),
        ("list_item", "units_list_item", "markers_list_item"),
        ("note", "units_note", "markers_note"),
        ("quote", "units_quote", "markers_quote"),
        ("table", "units_table", "markers_table"),
    ];
    for (kind, units_name, markers_name) in KINDS {
        let units = |f: &Features| f.units_kind.iter().filter(|(k, _)| k == kind).map(|(_, p)| p.clone()).collect::<Vec<_>>();
        metrics.insert(units_name, prf(&units(&wanted), &units(&got)));
        let marks = |f: &Features| f.markers_kind.iter().filter(|(k, _, _)| k == kind).map(|(_, u, s)| (*u, s.clone())).collect::<Vec<_>>();
        metrics.insert(markers_name, prf(&marks(&wanted), &marks(&got)));
    }
    let text = recognition(reference, predicted, &alignment)?;
    Ok(Score {
        metrics,
        text,
        alignment: alignment.stats,
    })
}

/// Connected components let recognition ignore line splits/merges without hiding extra text.
fn recognition(
    reference: &State,
    predicted: &State,
    alignment: &crate::alignment::Alignment,
) -> Result<TextScore, String> {
    let count = reference.lines.len();
    let mut edges = vec![Vec::new(); count + predicted.lines.len()];
    for (c, spans) in alignment.mappings.iter().enumerate() {
        for &(_, _, r, _, _) in spans {
            edges[r].push(count + c);
            edges[count + c].push(r);
        }
    }
    let mut component = vec![usize::MAX; edges.len()];
    let mut texts: Vec<(Vec<char>, Vec<char>)> = Vec::new();
    for start in 0..edges.len() {
        if component[start] != usize::MAX {
            continue;
        }
        let key = texts.len();
        texts.push((Vec::new(), Vec::new()));
        component[start] = key;
        let mut stack = vec![start];
        while let Some(n) = stack.pop() {
            for &next in &edges[n] {
                if component[next] == usize::MAX {
                    component[next] = key;
                    stack.push(next);
                }
            }
        }
    }
    for (candidate, state) in [(false, reference), (true, predicted)] {
        let key = |n: usize| {
            if candidate {
                if let Some(position) = alignment.mappings[n]
                    .iter()
                    .map(|m| (reference.lines[m.2].spatial, m.3))
                    .min_by(|a, b| a.partial_cmp(b).unwrap())
                {
                    return position;
                }
            }
            (state.lines[n].spatial, 0)
        };
        let mut order: Vec<usize> = (0..state.lines.len()).collect();
        order.sort_by(|&a, &b| key(a).partial_cmp(&key(b)).unwrap());
        for n in order {
            let pair = &mut texts[component[if candidate { count + n } else { n }]];
            let out = if candidate { &mut pair.1 } else { &mut pair.0 };
            out.extend(state.lines[n].text.iter().copied().filter(|&ch| ch != '\n'));
        }
    }
    let mut text = TextScore::default();
    for (wanted, got) in texts {
        text.matched_characters += text_diff::matching_blocks(&wanted, &got)?
            .iter()
            .map(|b| b.2)
            .sum::<usize>();
        text.characters += wanted.len().max(got.len());
        text.exact_units += usize::from(wanted == got);
        text.units += 1;
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Line;
    use serde_json::json;

    // Independently invented text; no corpus documents or model submissions are fixtures.
    fn sample(prefix: &str, rows: &[(&str, usize)], groups: &[&[usize]]) -> State {
        let lines: Vec<Line> = rows
            .iter()
            .enumerate()
            .map(|(n, &(text, page))| Line {
                id: format!("{prefix}{n}"),
                page,
                text: text.chars().collect(),
                spatial: (page, n as f64, 0.0),
                page_band: None,
            })
            .collect();
        let blocks = groups
            .iter()
            .map(|members| CompositionBlock {
                id: String::new(),
                kind: "text".into(),
                document: None,
                attributes: Default::default(),
                line_ids: members.iter().map(|&n| lines[n].id.clone()).collect(),
                spans: members
                    .iter()
                    .map(|&n| SourceSpan {
                        line_id: lines[n].id.clone(),
                        start: 0,
                        end: lines[n].text.len(),
                    })
                    .collect(),
            })
            .collect();
        State {
            index: lines
                .iter()
                .enumerate()
                .map(|(n, l)| (l.id.clone(), n))
                .collect(),
            reading_order: (0..lines.len()).collect(),
            lines,
            groups: blocks,
            annotations: Vec::new(),
            continuations: Default::default(),
        }
    }

    fn perfect(score: &Score) {
        for (name, metric) in &score.metrics {
            assert_eq!(
                (metric.expected, metric.predicted),
                (metric.correct, metric.correct),
                "{name}"
            );
        }
        assert_eq!(score.text.matched_characters, score.text.characters);
    }

    #[test]
    fn renamed_split_and_merged_lines_preserve_structure_and_recognition() {
        let r = sample(
            "gold",
            &[("Sailors mend ", 0), ("canvas. 🦉", 0)],
            &[&[0, 1]],
        );
        let c = sample(
            "ocr",
            &[("Sailors ", 0), ("mend canvas. 🦉", 0)],
            &[&[0, 1]],
        );
        let score = compare(&r, &c).unwrap();
        perfect(&score);
        assert_eq!(score.alignment.shared_witness_sources, 0);
        assert_eq!(score.alignment.split_reference_sources, 1);
        assert_eq!(score.alignment.merged_candidate_sources, 1);
    }

    #[test]
    fn alignment_does_not_repair_wrong_order_or_grouping() {
        let r = sample(
            "gold",
            &[("Copper bells.", 0), ("Velvet sails.", 0)],
            &[&[0], &[1]],
        );
        let mut c = sample(
            "ocr",
            &[("Velvet sails.", 0), ("Copper bells.", 0)],
            &[&[0], &[1]],
        );
        let score = compare(&r, &c).unwrap();
        assert!(score.metrics["order"].f1() < 1.0);
        assert_eq!(score.text.matched_characters, score.text.characters);
        c.reading_order.reverse();
        let score = compare(&r, &c).unwrap();
        perfect(&score);
        let c = sample(
            "ocr",
            &[("Copper bells.", 0), ("Velvet sails.", 0)],
            &[&[0, 1]],
        );
        assert!(compare(&r, &c).unwrap().metrics["groups"].f1() < 1.0);
    }

    #[test]
    fn missing_and_duplicate_text_remain_errors_and_pages_do_not_cross_match() {
        let r = sample("gold", &[("Orchard yield: 42 pears.", 0)], &[&[0]]);
        for rows in [
            vec![("Orchard yield:", 0)],
            vec![("Orchard yield: 42 pears.", 0), ("42 pears.", 0)],
            vec![("Orchard yield: 42 pears.", 1)],
        ] {
            let c = sample("ocr", &rows, &[&[0]]);
            let score = compare(&r, &c).unwrap();
            assert!(score.text.matched_characters < score.text.characters);
            assert!(score.metrics["coverage"].f1() < 1.0);
        }
    }

    #[test]
    fn note_references_keep_exact_offsets_after_a_line_split() {
        let mut r = sample(
            "gold",
            &[("Maps¹ guide ships.", 0), ("¹ Survey log.", 0)],
            &[&[0], &[1]],
        );
        let mut c = sample(
            "ocr",
            &[("Maps¹ ", 0), ("guide ships.", 0), ("¹ Survey log.", 0)],
            &[&[0, 1], &[2]],
        );
        for (state, note_line) in [(&mut r, 1), (&mut c, 2)] {
            let note = &state.lines[note_line];
            let reference = &state.lines[0];
            state.annotations.push(CompositionAnnotation {
                id: "note".into(),
                kind: "note".into(),
                line_ids: vec![note.id.clone()],
                spans: vec![SourceSpan {
                    line_id: note.id.clone(),
                    start: 0,
                    end: note.text.len(),
                }],
                attributes: serde_json::from_value(json!({"kind": "footnote",
                    "label": [{"line_id": note.id, "start": 0, "end": 1}],
                    "references": [{"line_id": reference.id, "start": 4, "end": 5}]}))
                .unwrap(),
            });
        }
        perfect(&compare(&r, &c).unwrap());
        c.annotations[0].attributes["references"][0]["start"] = json!(3);
        c.annotations[0].attributes["references"][0]["end"] = json!(4);
        let score = compare(&r, &c).unwrap();
        assert_eq!(score.metrics["note"].f1(), 1.0);
        assert_eq!(score.metrics["note_references"].f1(), 0.0);
    }

    #[test]
    fn corrected_gold_is_the_reference_even_when_corrections_insert_characters() {
        for original in ["A teal blrd rests.", "A teal brd rests."] {
            let corrected = "A teal bird rests.";
            let gold = serde_json::from_value(json!({
                "schema_version": crate::state::V4, "source_sha256": "invented",
                "lines": [{"id": "gold", "page": 0, "text": original, "corrected": corrected}],
                "typed": [{"region": "text", "spans": [{"line_id": "gold", "start": 0, "end": corrected.chars().count()}]}],
                "units": [{"lines": [0], "parent": null}], "notes": []
            })).unwrap();
            let r = crate::state::projected(&gold).unwrap();
            let c = sample("ocr", &[(corrected, 0)], &[&[0]]);
            perfect(&compare(&r, &c).unwrap());
        }
    }
}
