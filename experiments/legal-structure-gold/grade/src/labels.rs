//! Each source line's labels in the scorer's frame: its region, whether a unit or a continued
//! fragment starts on it, the unit's relation to the unit before, and whether a document opens or
//! a note reference sits on it. Read alike from the gold (training targets) and from the parser
//! (tier 0, a feature), and decoded back into the gold's own form to score a model's labels.
use crate::state::{block_id, Gold, State};
use legal_structure::{CompositionBlock, SourceSpan};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const REGIONS: [&str; 13] = [
    "none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote", "marginal_note",
    "furniture", "page_label",
];
pub const STARTS: [&str; 3] = ["inside", "unit", "continuation"];
pub const RELATIONS: [&str; 10] = ["none", "first", "child", "sibling", "up 1", "up 2", "up 3", "up 4", "up 5", "other"];

#[derive(Clone, Copy, Default)]
pub struct LineLabel {
    pub region: usize,
    pub start: usize,
    pub relation: usize,
    pub document: bool,
    pub reference: bool,
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

/// Per line of `state`, in its line order: what starts on it, its unit's relation, documents and
/// note references, from the same composition the scorer reads. Regions come from `region`.
pub fn labels(state: &State, region: &dyn Fn(usize) -> usize) -> Result<Vec<LineLabel>, String> {
    let mut result: Vec<LineLabel> = (0..state.lines.len()).map(|n| LineLabel { region: region(n), ..LineLabel::default() }).collect();
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
    let incoming: HashSet<&str> = composed.logical_blocks.values().flat_map(|parts| parts.iter().skip(1).map(String::as_str)).collect();
    let mut groups: HashMap<String, &CompositionBlock> = HashMap::new();
    let mut keys = Vec::new();
    for group in &state.groups {
        let id = block_id(group);
        if groups.insert(id.clone(), group).is_none() {
            keys.push(id);
        }
    }
    let line_of = |id: &str| state.index.get(id).copied();
    // The earliest start on each line decides what starts there.
    let mut starts: HashMap<usize, (usize, usize)> = HashMap::new();
    for key in &keys {
        let group = groups[key];
        let Some(first) = group.spans.first() else { continue };
        let Some(n) = line_of(&first.line_id) else { continue };
        let kind = if incoming.contains(key.as_str()) { 2 } else { 1 };
        let entry = starts.entry(n).or_insert((first.start, kind));
        if first.start < entry.0 {
            *entry = (first.start, kind);
        }
    }
    for (n, (_, kind)) in starts {
        result[n].start = kind;
    }
    // Ranked units, in reading order, and their relation to the unit before, as the scorer has them.
    let notes: Vec<&SourceSpan> = annotations.iter().filter(|a| a.kind == "note").flat_map(|a| a.spans.iter()).collect();
    let tables: Vec<&SourceSpan> = annotations.iter().filter(|a| a.kind == "table").flat_map(|a| a.spans.iter()).collect();
    let inside = |group: &CompositionBlock, extents: &[&SourceSpan]| group.spans.first()
        .is_some_and(|f| extents.iter().any(|s| s.line_id == f.line_id && s.start <= f.start && f.start < s.end));
    let unranked = |group: &CompositionBlock| {
        let kind = match group.kind.as_str() { "header" | "footer" => "furniture", other => other };
        !inside(group, &tables) && matches!(kind, "furniture" | "page_label" | "marginal_note" | "contents")
    };
    let position: HashMap<&str, usize> = state.reading_order.iter().enumerate().map(|(k, &n)| (state.lines[n].id.as_str(), k)).collect();
    let order = |id: &str| {
        let (line, at) = id.split_once('@').unwrap_or((id, ""));
        (position.get(line).copied().unwrap_or(position.len()), at.parse::<usize>().unwrap_or(0))
    };
    let mut units: Vec<&str> = keys.iter().map(String::as_str)
        .filter(|k| !incoming.contains(k) && !unranked(groups[*k]) && !inside(groups[*k], &notes)).collect();
    units.sort_by_key(|k| order(k));
    let parent_of: HashMap<&str, Option<&str>> = units.iter().map(|k| (*k, groups[*k].attributes.get("parent").and_then(Value::as_str))).collect();
    for (n, first) in units.iter().enumerate() {
        let relation = if n == 0 {
            "first".to_owned()
        } else {
            let (previous, parent) = (units[n - 1], parent_of[first]);
            if parent == Some(previous) {
                "child".to_owned()
            } else {
                let (mut chain, mut at, mut seen) = (Vec::new(), Some(previous), HashSet::new());
                while let Some(current) = at.filter(|a| seen.insert(*a)) {
                    chain.push(current);
                    at = parent_of.get(current).copied().flatten();
                }
                chain.iter().enumerate().find(|(_, a)| parent_of.get(**a).copied().flatten() == parent)
                    .map_or("other".to_owned(), |(k, _)| if k == 0 { "sibling".to_owned() } else { format!("up {k}") })
            }
        };
        if let Some(line) = groups[*first].spans.first().and_then(|s| line_of(&s.line_id)) {
            result[line].relation = relation_index(&relation);
        }
    }
    for a in &annotations {
        // A document under another starts on its line; the source's own needs no label.
        if a.kind == "document" && a.attributes.get("parent").is_some_and(|p| !p.is_null()) {
            if let Some(n) = a.spans.first().map(|s| s.line_id.as_str()).or(a.line_ids.first().map(String::as_str)).and_then(line_of) {
                result[n].document = true;
            }
        }
        if a.kind == "note" {
            let references: Vec<SourceSpan> = serde_json::from_value(a.attributes.get("references").cloned().unwrap_or(Value::Null))
                .unwrap_or_default();
            for s in references {
                if let Some(n) = line_of(&s.line_id) {
                    result[n].reference = true;
                }
            }
        }
    }
    Ok(result)
}

/// The gold's region of each of its lines: the typed line holding the line's earliest text.
pub fn gold_regions(gold: &Gold, state: &State) -> Vec<usize> {
    let mut best: Vec<Option<(usize, usize)>> = vec![None; state.lines.len()];
    for item in &gold.typed {
        let region = index_of(&REGIONS, &item.region);
        for span in &item.spans {
            if let Some(&n) = state.index.get(&span.line_id) {
                if best[n].is_none_or(|(start, _)| span.start < start) {
                    best[n] = Some((span.start, region));
                }
            }
        }
    }
    best.into_iter().map(|found| found.map_or(0, |(_, region)| region)).collect()
}

/// The parser's region of each of its lines, in the gold's terms: its block's role, a note or a
/// table where an annotation holds the line, a list item where the block is one.
pub fn parsed_regions(state: &State) -> Vec<usize> {
    let mut holders: HashMap<&str, Vec<(&str, usize, usize)>> = HashMap::new();
    for a in &state.annotations {
        if a.kind == "note" || a.kind == "table" {
            for s in &a.spans {
                holders.entry(s.line_id.as_str()).or_default().push((a.kind.as_str(), s.start, s.end));
            }
            if a.spans.is_empty() {
                for id in &a.line_ids {
                    holders.entry(id.as_str()).or_default().push((a.kind.as_str(), 0, usize::MAX));
                }
            }
        }
    }
    let mut best: Vec<Option<(usize, usize)>> = vec![None; state.lines.len()];
    for group in &state.groups {
        let kind = match group.kind.as_str() { "prose" => "text", "header" | "footer" => "furniture", other => other };
        let list = kind == "text" && group.attributes.get("locator_kind").and_then(Value::as_str) == Some("list_item");
        for span in &group.spans {
            let Some(&n) = state.index.get(&span.line_id) else { continue };
            let held = holders.get(span.line_id.as_str()).and_then(|found| found.iter()
                .find(|(_, a, b)| *a <= span.start && span.start < *b).map(|(k, _, _)| *k));
            let region = match held {
                Some(kind) => kind,
                None if list => "list_item",
                None => kind,
            };
            if best[n].is_none_or(|(start, _)| span.start < start) {
                best[n] = Some((span.start, index_of(&REGIONS, region)));
            }
        }
    }
    best.into_iter().map(|found| found.map_or(0, |(_, region)| region)).collect()
}

/// Labels decoded into the gold's own form, over the parser's lines in its reading order. A line
/// that starts a unit opens one; any other joins the open unit of its stream (notes, the body), so
/// a paragraph runs on past the notes and running heads that interrupt it. Parents follow each
/// ranked unit's relation to the one before. The parser supplies what the labels do not say:
/// markers, the note references the labels keep, and the notes they pair with.
pub fn decode(candidate: &State, labels: &[LineLabel], source_sha256: &str) -> Gold {
    use crate::state::{GoldLine, NotePair, Reference, Typed, Unit, V4};
    let region_of = |n: usize| REGIONS[labels[n].region];
    // The parser's markers by the line their block starts on, its note labels and references.
    let mut markers: HashMap<&str, Vec<SourceSpan>> = HashMap::new();
    for group in &candidate.groups {
        let Some(first) = group.spans.first() else { continue };
        let found: Vec<SourceSpan> = serde_json::from_value(group.attributes.get("marker").cloned().unwrap_or(Value::Null)).unwrap_or_default();
        if !found.is_empty() {
            markers.entry(first.line_id.as_str()).or_insert(found);
        }
    }
    let mut note_labels: HashMap<String, Vec<SourceSpan>> = HashMap::new();
    let mut references: HashMap<&str, Vec<SourceSpan>> = HashMap::new();
    for a in candidate.annotations.iter().filter(|a| a.kind == "note") {
        let label: Vec<SourceSpan> = serde_json::from_value(a.attributes.get("label").cloned().unwrap_or(Value::Null)).unwrap_or_default();
        if let Some(first) = label.first() {
            note_labels.entry(first.line_id.clone()).or_insert_with(|| label.clone());
        }
        let found: Vec<SourceSpan> = serde_json::from_value(a.attributes.get("references").cloned().unwrap_or(Value::Null)).unwrap_or_default();
        for s in found {
            references.entry(candidate.lines[candidate.index[&s.line_id]].id.as_str()).or_default().push(s);
        }
    }
    // The parser's table cells on each line, column by column.
    let mut table_cells: HashMap<String, Vec<Vec<SourceSpan>>> = HashMap::new();
    for a in candidate.annotations.iter().filter(|a| a.kind == "table") {
        for row in a.attributes.get("rows").and_then(Value::as_array).into_iter().flatten() {
            let cells = row.as_array().cloned().unwrap_or_default();
            for (c, cell) in cells.iter().enumerate() {
                let spans: Vec<SourceSpan> = serde_json::from_value(cell.clone()).unwrap_or_default();
                for span in spans {
                    let line = table_cells.entry(span.line_id.clone()).or_insert_with(|| vec![Vec::new(); cells.len()]);
                    if line.len() < cells.len() {
                        line.resize(cells.len(), Vec::new());
                    }
                    line[c].push(span);
                }
            }
        }
    }
    let lines: Vec<GoldLine> = candidate.lines.iter().map(|l| GoldLine {
        id: l.id.clone(), page: l.page, text: l.text.iter().collect(), corrected: None,
    }).collect();
    // Units: each region family's open unit takes the lines that do not start one of their own,
    // over the parser's reading order; a unit's lines are then typed together, as the gold types
    // them, so two columns read side by side do not cut every unit into its lines.
    let kept: Vec<usize> = candidate.reading_order.iter().copied()
        .filter(|&n| labels[n].region != 0 && !candidate.lines[n].text.iter().all(|c| c.is_whitespace())).collect();
    let stream = |region: &str| match region {
        "note" => 1,
        "marginal_note" => 2,
        "furniture" => 3,
        "page_label" => 4,
        _ => 0,
    };
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut unit_region: Vec<&str> = Vec::new();
    let mut open: [Option<usize>; 5] = [None; 5];
    for &n in &kept {
        let region = region_of(n);
        let s = stream(region);
        let u = match open[s] {
            Some(u) if labels[n].start != 1 && (unit_region[u] == region || s == 0 && labels[n].start == 2) => u,
            _ => {
                members.push(Vec::new());
                unit_region.push(region);
                members.len() - 1
            }
        };
        members[u].push(n);
        open[s] = Some(u);
    }
    let mut typed: Vec<Typed> = Vec::new();
    let mut typed_line: Vec<usize> = Vec::new();
    let mut units: Vec<Unit> = Vec::new();
    let mut unit_of_typed: Vec<usize> = Vec::new();
    for (u, lines_of_unit) in members.iter().enumerate() {
        let mut unit = Unit { lines: Vec::new(), parent: None, starts_document: labels[lines_of_unit[0]].document };
        for &n in lines_of_unit {
            let line = &candidate.lines[n];
            let region = region_of(n);
            let whole = SourceSpan { line_id: line.id.clone(), start: 0, end: line.text.len() };
            let marker = if region == "note" { note_labels.get(line.id.as_str()) } else if labels[n].start == 1 { markers.get(line.id.as_str()) } else { None };
            let mut own_references: Vec<SourceSpan> = if labels[n].reference { references.get(line.id.as_str()).cloned().unwrap_or_default() } else { Vec::new() };
            own_references.sort_by_key(|s| s.start);
            unit.lines.push(typed.len());
            unit_of_typed.push(u);
            typed_line.push(n);
            typed.push(Typed {
                region: unit_region[u].to_owned(),
                spans: vec![whole.clone()],
                markers: marker.map(|m| vec![m.clone()]).unwrap_or_default(),
                references: own_references.into_iter().map(|s| Reference { spans: vec![s] }).collect(),
                cells: (region == "table").then(|| table_cells.get(line.id.as_str()).cloned().unwrap_or_else(|| vec![vec![whole.clone()]])),
            });
        }
        units.push(unit);
    }
    // Parents: a ranked unit's relation to the ranked unit before it, up its ancestors.
    let ranked = |region: &str| !matches!(region, "furniture" | "page_label" | "marginal_note" | "contents" | "note");
    let mut previous: Option<usize> = None;
    for u in 0..units.len() {
        if !ranked(unit_region[u]) {
            continue;
        }
        let relation = labels[typed_line[units[u].lines[0]]].relation;
        let parent_of = |unit: usize, units: &[Unit]| units[unit].parent;
        let parent = match (relation, previous) {
            (_, None) | (1, _) | (9, _) => None,
            (2, Some(p)) => Some(p),
            (k @ 4..=8, Some(p)) => {
                let mut at = Some(p);
                for _ in 0..(k - 3) {
                    at = at.and_then(|a| parent_of(a, &units));
                }
                at.and_then(|a| parent_of(a, &units))
            }
            (_, Some(p)) => parent_of(p, &units),
        };
        units[u].parent = parent;
        previous = Some(u);
    }
    // Note pairs: each parser note's references, to the unit that holds the note's first line.
    let mut notes: Vec<NotePair> = Vec::new();
    let typed_of_line: HashMap<usize, usize> = typed_line.iter().enumerate().map(|(t, &n)| (n, t)).collect();
    for a in candidate.annotations.iter().filter(|a| a.kind == "note") {
        let Some(first) = a.spans.first() else { continue };
        let Some(&t) = candidate.index.get(&first.line_id).and_then(|n| typed_of_line.get(n)) else { continue };
        let note = unit_of_typed[t];
        if unit_region[note] != "note" {
            continue;
        }
        let found: Vec<SourceSpan> = serde_json::from_value(a.attributes.get("references").cloned().unwrap_or(Value::Null)).unwrap_or_default();
        for s in found {
            let Some(&t) = candidate.index.get(&s.line_id).and_then(|n| typed_of_line.get(n)) else { continue };
            if let Some(r) = typed[t].references.iter().position(|reference| reference.spans[0] == s) {
                notes.push(NotePair { line: t, reference: Some(r), note: Some(note) });
            }
        }
    }
    Gold { schema_version: V4.to_owned(), source_sha256: source_sha256.to_owned(), parser: Value::Null, lines, typed, units, notes }
}
