//! The gold's labels on a parse's lines, which Detect-Order-Construct is fitted on (the parser's LEGALPDF_DOC_GOLD:
//! `{sha256, ids, labels}`, each id a parse line's `id@0`). Each line takes the gold unit its first aligned character
//! falls in (the scorer's alignment): the unit's region; whether the line opens it (its first line in the parse's
//! order, whatever character it starts on, so a misread first character opens what the gold opens), continues it (the
//! unit open in its stream) or resumes it (pointing at the row of its first line); the unit's marker; whether it opens
//! a document under the source's own; whether the gold text it covers holds a paired note reference; the gold's
//! heading level and body depth, each a step from the one before it in this order (a document's first stepping from
//! nothing); and the gold's reading rank of its first character.
//!
//! Row: region, start (0 continues, 1 opens, 2 resumes), document, reference, level step, marker, resumed row, depth
//! step, rank, and on a note's first row the row holding its paired reference (-1 elsewhere). A line the alignment places nowhere is no region's with its level unknown; a line on gold text no unit
//! types is region 0. A machine-aligned gold (label source a2aj-align) gives no levels or depths, and what it types no
//! region's it did not place: those are unknown (-1), and its body text, where a quotation or list item may stand in
//! it unmarked, is `UNMARKED_BODY`.
use crate::alignment::Alignment;
use crate::gold::Gold;
use crate::side::Side;
use std::collections::HashMap;

/// Levels and depths run 1 to `DEEPEST`.
const DEEPEST: usize = 9;
/// The streams units run on in (`legalpdf::stream_of`).
const STREAMS: usize = 6;
/// Body text a machine-aligned gold may hold a quotation or list item in unmarked: text, a quotation or a list item.
const UNMARKED_BODY: i64 = 101;
/// The labelling rule's version: a dump's kept labels are read back only where it is the one they were made by. A change
/// to what `rows` gives a line bumps it.
pub const VERSION: u32 = 3;

/// A level (or depth) as a step from the one before it in its document, the first stepping from 1: 10 plus the change.
fn step(previous: Option<usize>, level: usize) -> usize {
    DEEPEST + 1 + level.clamp(1, DEEPEST) - previous.unwrap_or(1)
}

/// The parse's line ids (`id@0`) in its reading order, and each line's row.
pub fn rows(gold: &Gold, reference: &Side, candidate: &Side, alignment: &Alignment, machine_aligned: bool) -> (Vec<String>, Vec<[i64; 10]>) {
    let region_index = |name: &str| legalpdf::REGIONS.iter().position(|r| *r == name).unwrap_or(0);
    let regions = gold.regions();
    let units = &gold.units;
    // Each gold line's typed stretches, with the unit holding each; a transcript's line number is a unit of its own.
    let mut unit_of_typed = vec![None; gold.typed.len()];
    for (u, unit) in units.iter().enumerate() {
        for &t in &unit.lines {
            unit_of_typed[t] = Some(u);
        }
    }
    let mut region_of: Vec<usize> = regions.iter().map(|r| region_index(r)).collect();
    let mut stretches: Vec<Vec<(usize, usize, usize)>> = vec![Vec::new(); reference.lines.len()];
    for (t, (labels, kept)) in gold.line_labels().iter().enumerate() {
        for label in labels {
            if let Some(&n) = reference.index.get(&label.line_id) {
                stretches[n].push((label.start, label.end, region_of.len()));
                region_of.push(region_index("line_label"));
            }
        }
        let Some(u) = unit_of_typed[t] else { continue };
        for span in kept {
            if let Some(&n) = reference.index.get(&span.line_id) {
                stretches[n].push((span.start, span.end, u));
            }
        }
    }
    let unit_at = |line: usize, at: usize| stretches[line].iter().find(|&&(a, b, _)| a <= at && at < b).map(|&(_, _, u)| u);
    // The source's own document opens at its first unit in the gold's reading; every other unit starting a document
    // opens one under it.
    let root = stretches.iter().enumerate()
        .flat_map(|(n, found)| found.iter().map(move |&(a, _, u)| ((reference.positions[n], a), u)))
        .min().map(|(_, u)| u);
    let opens_document = |u: usize| units.get(u).is_some_and(|unit| unit.starts_document) && Some(u) != root;
    let marked = |u: usize| units.get(u).is_some_and(|unit| unit.lines.iter().any(|&t| gold.typed[t].markers.iter().any(|m| !m.is_empty())));
    let level_of = |u: usize| units.get(u).filter(|_| regions[u] == "heading").and_then(|unit| unit.level.or(unit.depth));
    let depth_of = |u: usize| units.get(u).filter(|_| regions[u] != "heading").and_then(|unit| unit.depth);
    // The paired note references, by gold line, each with the note's unit.
    let mut references: HashMap<usize, Vec<(usize, usize, usize)>> = HashMap::new();
    for pair in &gold.notes {
        let (Some(note), Some(k)) = (pair.note, pair.reference) else { continue };
        for span in gold.typed[pair.line].references.get(k).map_or(&[][..], |r| &r.spans) {
            if let Some(&n) = reference.index.get(&span.line_id) {
                references.entry(n).or_default().push((span.start, span.end, note));
            }
        }
    }
    // Each note's unit, the first row (in the parse's order) covering one of its paired references.
    let mut referenced: HashMap<usize, usize> = HashMap::new();
    let ids: Vec<String> = candidate.reading_order.iter().map(|&c| format!("{}@0", candidate.lines[c].id)).collect();
    let mut first_here: HashMap<usize, usize> = HashMap::new();
    let mut open: [Option<usize>; STREAMS] = [None; STREAMS];
    let (mut heading, mut body): (Option<usize>, Option<usize>) = (None, None);
    let mut rows: Vec<[i64; 10]> = candidate.reading_order.iter().enumerate().map(|(k, &c)| {
        let mappings = &alignment.mappings[c];
        let Some(&(_, _, line, at, _)) = mappings.first() else {
            return if machine_aligned { [-1; 10] } else { [0, 0, 0, 0, -1, 0, -1, -1, -1, -1] };
        };
        // A line of no letters (a printed line number, a folio, a rule) a machine alignment places only by its figures'
        // like somewhere in a decision's text: its line was taught as that text's body (2026-11-13: the silver mix took
        // line numbers from 0.86 to 0.73). Such a line is unknown, as a line placed nowhere is. Not every short line: a
        // paragraph's last ("court.") is its own, and leaving those unknown cost body 0.04 and text 0.05.
        if machine_aligned && !candidate.lines[c].text.iter().any(|c| c.is_alphabetic()) {
            return [-1; 10];
        }
        let rank = (reference.positions[line] * 100_000 + at.min(99_999)) as i64;
        // A paired reference anywhere in the gold text the line covers, and the notes it is the reference of.
        let mut paired = false;
        for &(_, _, r, a, b) in mappings {
            for &(s, e, note) in references.get(&r).map_or(&[][..], Vec::as_slice) {
                if s < b && a < e {
                    paired = true;
                    referenced.entry(note).or_insert(k);
                }
            }
        }
        let Some(u) = unit_at(line, at) else {
            return if machine_aligned { [-1, -1, -1, -1, -1, -1, -1, -1, rank, -1] } else { [0, 0, 0, i64::from(paired), 0, 0, -1, 0, rank, -1] };
        };
        let region = region_of[u];
        if machine_aligned && region == 0 {
            return [-1, -1, -1, -1, -1, -1, -1, -1, rank, -1];
        }
        let stream = legalpdf::stream_of(region as u8);
        let mut row = [region as i64, 0, 0, i64::from(paired), 0, 0, -1, 0, rank, -1];
        match first_here.get(&u) {
            None => {
                row[1] = 1;
                row[5] = i64::from(marked(u));
                if opens_document(u) {
                    row[2] = 1;
                    (heading, body) = (None, None);
                }
                if let Some(level) = level_of(u) {
                    row[4] = step(heading, level) as i64;
                    heading = Some(level.clamp(1, DEEPEST));
                }
                if let Some(depth) = depth_of(u) {
                    row[7] = step(body, depth) as i64;
                    body = Some(depth.clamp(1, DEEPEST));
                }
                first_here.insert(u, k);
            }
            Some(&first) if open[stream] != Some(u) => {
                row[1] = 2;
                row[6] = first as i64;
            }
            Some(_) => {}
        }
        open[stream] = Some(u);
        if machine_aligned {
            (row[4], row[7]) = (-1, -1);
            if region == region_index("text") {
                row[0] = UNMARKED_BODY;
            }
        }
        row
    }).collect();
    // A note's first row names the row holding its paired reference.
    for (note, at) in referenced {
        if let Some(&first) = first_here.get(&note) {
            rows[first][9] = at as i64;
        }
    }
    (ids, rows)
}
