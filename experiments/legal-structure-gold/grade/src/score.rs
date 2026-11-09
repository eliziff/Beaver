//! A parser export scored against its gold, layer by layer, as `evaluate.compare` defined it:
//! the parser's page text is aligned to the gold, every boundary either side
//! draws cuts the source into pieces, and each layer compares multisets of features over them.
use crate::alignment::{align, Alignment, Stats};
use crate::side::{At, Block, Side, Span};
use crate::text_diff;
use serde::Serialize;
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

/// One side of the comparison as the shared frame of gold lines reads it.
struct View<'a> {
    side: &'a Side,
    candidate: bool,
    alignment: &'a Alignment,
}

impl<'a> View<'a> {
    fn new(side: &'a Side, candidate: bool, alignment: &'a Alignment) -> Self {
        View { side, candidate, alignment }
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
        self.side.lines[line].text[a.min(b)..b].iter().all(|c| c.is_whitespace())
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

const UNRANKED: [&str; 6] = ["title", "furniture", "page_label", "line_label", "marginal_note", "contents"];

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
    hierarchy: Vec<(Option<Point>, String, String, Segments)>,
    hierarchy_units: Vec<Option<Point>>,
    hierarchy_roles: Vec<(Option<Point>, String)>,
    /// Each heading's step from the heading before it: deeper, the same level, or up k levels.
    heading_steps: Vec<(Option<Point>, String)>,
    /// Each body unit's step in depth from the body unit before it.
    depth_steps: Vec<(Option<Point>, String)>,
    /// The depth steps of the numbered body units alone.
    sequence_steps: Vec<(Option<Point>, String)>,
    /// The side gives depths (a gold the document pass has read); a parse's are read off its tree.
    depth_given: bool,
    hierarchy_marker: Vec<(Option<Point>, Segments)>,
    table: Vec<(Segments, usize, usize)>,
    table_cells: Vec<(Option<Point>, usize, usize, Option<Segments>)>,
    note: Vec<(Segments, Segments)>,
    note_references: Vec<(Segments, Segments)>,
    document: Vec<Document>,
    document_parts: Vec<(Document, Option<Document>, String)>,
    document_ownership: Vec<(Piece, Document)>,
    continuations: Vec<(Option<Point>, Option<Point>, String)>,
    /// Units and printed markers by what the unit is, for the headline table.
    units_kind: Vec<(String, Vec<Piece>)>,
    markers_kind: Vec<(String, Option<Point>, Segments)>,
    /// A transcript's printed line numbers: a line_label line, or the number printed on the line it numbers.
    line_numbers: Vec<Segments>,
    /// The labels that open a speaker's turn ("Q.", "MR. SMITH:").
    speakers: Vec<Segments>,
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
    view: &View<'a>,
    cuts: &Cuts,
    witness: &dyn Fn(Origin) -> &'a [char],
) -> Result<Features, String> {
    let side = view.side;
    let span = |s: &Span| -> Vec<Piece> { view.project(s.line, s.start, s.end, witness) };
    let spans = |values: &[Span]| -> Segments { merged(values.iter().flat_map(span)) };
    let span_pieces = |s: &Span| -> Vec<Piece> { cuts.pieces(&span(s)) };
    let point = |(line, offset): At| -> Point {
        let (origin, at, _) = view.project(line, offset, offset, witness)[0];
        (origin, at)
    };
    // A document is known by the line it opens on; the source's own by none.
    let roots: HashSet<usize> = side.documents.iter().filter(|d| d.root).map(|d| d.line).collect();
    let document = |line: usize| if roots.contains(&line) { Document::Root } else { Document::At(point((line, 0))) };
    let pieces = |n: usize| -> Vec<Piece> { cuts.pieces(&view.project(n, 0, side.lines[n].text.len(), witness)) };
    let mut result = Features::default();
    // A piece of blank space (the gap between a transcript's line number and its text) holds no text to cover or read
    // in order: a parser that reads the number apart drops it.
    let sequence: Vec<Piece> = side.reading_order.iter().flat_map(|&n| pieces(n))
        .filter(|&(origin, a, b)| witness(origin).get(a..b).is_some_and(|text| text.iter().any(|c| !c.is_whitespace())))
        .collect();
    result.order = sequence.windows(2).map(|w| (w[0], w[1])).collect();
    result.coverage = sequence;
    // Blocks are identified by their first source span, never by a line.
    let mut keys: Vec<At> = Vec::new();
    let mut groups: HashMap<At, &Block> = HashMap::new();
    for block in &side.blocks {
        if groups.insert(block.at(), block).is_none() {
            keys.push(block.at());
        }
    }
    // Each block's next fragment in its logical block.
    let text_links = side.text_links()?;
    let incoming: HashSet<At> = text_links.values().copied().collect();
    let mut notes: HashMap<usize, Vec<(usize, usize)>> = HashMap::new();
    let mut tables: HashMap<usize, Vec<(usize, usize)>> = HashMap::new();
    for s in side.notes.iter().flat_map(|n| &n.spans) {
        notes.entry(s.line).or_default().push((s.start, s.end));
    }
    for s in side.tables.iter().flat_map(|t| &t.spans) {
        tables.entry(s.line).or_default().push((s.start, s.end));
    }
    let inside = |block: &Block, extents: &HashMap<usize, Vec<(usize, usize)>>| {
        let first = &block.spans[0];
        extents.get(&first.line).is_some_and(|all| all.iter().any(|&(a, b)| a <= first.start && first.start < b))
    };
    let role = |block: &Block| -> String {
        if inside(block, &tables) {
            return "table".into();
        }
        // A block inside a note is a note unit, as a projected note unit's region says: a parser's footnote blocks are
        // its notes, not running text.
        if inside(block, &notes) {
            return "note".into();
        }
        // A block names its unit's region, which is its role as scored: the gold's as typed, a parser's as its node's
        // kind and role read; a parser's line no node holds is read by its kind.
        match block.region.as_deref() {
            Some("none" | "caption") => "text".into(),
            Some(region) => region.into(),
            None => alias(&block.kind).into(),
        }
    };
    let order = |(line, at): At| -> (usize, usize, usize) {
        match side.span_rank.get(&(line, at)) {
            Some(&rank) => (0, rank, 0),
            None => (1, side.positions[line], at),
        }
    };
    let mut units: Vec<At> = keys.iter().copied()
        .filter(|first| !incoming.contains(first) && !UNRANKED.contains(&role(groups[first]).as_str()) && !inside(groups[first], &notes))
        .collect();
    units.sort_by_key(|&at| order(at));
    // Levels: a gold gives each heading's level and each body unit's depth, as the model set them; a parse's are read
    // off its tree, one more than the headings above a heading, or than the body units above a body unit.
    let level = |first: At, heading: bool| -> usize {
        let block = groups[&first];
        if let Some(given) = if heading { block.heading_level } else { block.depth } {
            return given;
        }
        let (mut depth, mut at, mut seen) = (1, block.parent, HashSet::new());
        while let Some(ancestor) = at.filter(|a| seen.insert(*a)) {
            let Some(&g) = groups.get(&ancestor) else { break };
            if (role(g) == "heading") == heading {
                depth += 1;
            }
            at = g.parent;
        }
        depth
    };
    // A level is scored relative to the one before it of its kind (deeper, the same, up k), never absolutely: two
    // readings that nest alike agree however they number their depths.
    let step = |previous: Option<usize>, level: usize| match previous {
        None => "first".to_owned(),
        Some(p) if level > p => format!("down {}", level - p),
        Some(p) if level == p => "same".to_owned(),
        Some(p) => format!("up {}", p - level),
    };
    result.depth_given = units.iter().any(|first| groups[first].depth.is_some());
    let mut steps: HashMap<At, String> = HashMap::new();
    // A numbered body unit's step from the numbered body unit before it: where its numbering's sequence goes, on, in, or
    // back out.
    let mut sequence: HashMap<At, String> = HashMap::new();
    let mut numbered_before = None;
    let (mut heading_before, mut depth_before) = (None, None);
    // Each document's levels are its own: the first unit of a document steps from nothing.
    let document_starts: HashSet<usize> = side.documents.iter().map(|d| d.line).collect();
    for &first in &units {
        let g = groups[&first];
        if document_starts.contains(&g.spans[0].line) {
            (heading_before, depth_before, numbered_before) = (None, None, None);
        }
        if role(g) == "heading" {
            let at = level(first, true);
            steps.insert(first, format!("heading {}", step(heading_before, at)));
            heading_before = Some(at);
        } else {
            let at = level(first, false);
            steps.insert(first, format!("depth {}", step(depth_before, at)));
            depth_before = Some(at);
            if !g.marker.is_empty() {
                sequence.insert(first, step(numbered_before, at));
                numbered_before = Some(at);
            }
        }
    }
    for first in &keys {
        let g = groups[first];
        let kind = alias(&g.kind).to_owned();
        for s in &g.spans {
            result.roles.extend(span_pieces(s).into_iter().map(|p| (p, kind.clone())));
        }
        // A line number once: a line holding only its number is its own unit, and its block's line numbers name the
        // same span again.
        let own_number = (role(g) == "line_label").then(|| spans(&g.spans));
        if let Some(number) = &own_number {
            result.line_numbers.push(number.clone());
        }
        for s in &g.line_number {
            let number = spans(std::slice::from_ref(s));
            if own_number.as_ref() != Some(&number) {
                result.line_numbers.push(number);
            }
        }
        result.speakers.extend(g.speaker.iter().map(|s| spans(std::slice::from_ref(s))));
        if !incoming.contains(first) {
            let mut parts = g.spans.clone();
            let mut cursor = *first;
            let mut visited = HashSet::from([cursor]);
            while let Some(&next) = text_links.get(&cursor) {
                cursor = next;
                if !visited.insert(cursor) || !groups.contains_key(&cursor) {
                    break;
                }
                parts.extend(groups[&cursor].spans.iter().copied());
            }
            let mut found: Vec<Piece> = parts.iter().flat_map(span_pieces).collect();
            result.joins.extend(found.windows(2).map(|w| (w[0], w[1])));
            // A unit is the text it holds: the order its pieces are read in is the joins' and the reading order's to
            // score, so a hanging marker read after its text costs there, not here.
            found.sort_unstable();
            found.dedup();
            result.units_kind.push((role(g), found.clone()));
            result.groups.push(found);
        }
    }
    for first in &units {
        let g = groups[first];
        let unit = Some(point(*first));
        let kind = role(g);
        let marker_spans = spans(&g.marker);
        let at = steps.get(first).cloned().unwrap_or_default();
        result.hierarchy.push((unit, kind.clone(), at.clone(), marker_spans.clone()));
        result.hierarchy_units.push(unit);
        if !g.marker.is_empty() {
            result.markers_kind.push((kind.clone(), unit, marker_spans.clone()));
        }
        result.hierarchy_roles.push((unit, kind));
        if let Some(found) = at.strip_prefix("heading ") {
            result.heading_steps.push((unit, found.to_owned()));
        }
        if let Some(found) = at.strip_prefix("depth ") {
            result.depth_steps.push((unit, found.to_owned()));
        }
        if let Some(found) = sequence.get(first) {
            result.sequence_steps.push((unit, found.clone()));
        }
        if !g.marker.is_empty() {
            result.hierarchy_marker.push((unit, marker_spans));
        }
    }
    for table in side.whole_tables()? {
        let width = table.rows.first().ok_or("Table without rows")?.len();
        result.table.push((spans(&table.spans), table.rows.len(), width));
        let first = point((table.spans[0].line, 0));
        for (r, row) in table.rows.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                result.table_cells.push((Some(first), r, c, cell.as_ref().map(|found| spans(found))));
            }
        }
    }
    for note in side.whole_notes()? {
        let extent = spans(&note.spans);
        let label = spans(&note.label);
        result.note.push((extent.clone(), label.clone()));
        // A reference is right when its mark points at the right note: the note is known by its printed label (its
        // number where it stands), by its text only where it prints none. How far the note's text runs is the footnote
        // content layer's question, not the link's.
        let known = if label.is_empty() { extent } else { label };
        result.note_references.extend(note.references.iter().map(|s| (known.clone(), spans(std::slice::from_ref(s)))));
    }
    // A source's own first document opens wherever reading begins, so it is no evidence of splitting: the starts scored
    // are the internal ones. A part is right when its start, the next part's start (or the source's end) and its type all
    // are.
    let opened: Vec<(Document, String)> = side.documents.iter().map(|d| (document(d.line), d.kind.clone().unwrap_or_default())).collect();
    result.document = opened.iter().filter(|(d, _)| *d != Document::Root).map(|(d, _)| d.clone()).collect();
    result.document_parts = opened.iter().enumerate()
        .map(|(i, (d, kind))| (d.clone(), opened.get(i + 1).map(|(next, _)| next.clone()), kind.clone()))
        .collect();
    // Each line's text is the document's that owns the first block holding it; text before the first declared document
    // is the source's own.
    let mut by_line: HashMap<usize, Option<usize>> = HashMap::new();
    for (block, owner) in side.blocks.iter().zip(side.owners()?) {
        for s in &block.spans {
            by_line.entry(s.line).or_insert(owner);
        }
    }
    for &n in &side.reading_order {
        let Some(owner) = by_line.get(&n) else { continue };
        let start = owner.map_or(Document::Root, |d| document(side.documents[d].line));
        result.document_ownership.extend(pieces(n).into_iter().map(|p| (p, start.clone())));
    }
    for (kind, layer) in &side.links {
        for (&from, &to) in layer {
            result.continuations.push((Some(point(from)), Some(point(to)), kind.clone()));
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
    reference: &'a Side,
    predicted: &'a Side,
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
        }
    }
}

/// Each layer's missed and spurious items for one document, as text.
pub fn explain(
    reference: &Side,
    predicted: &Side,
    layers: &[String],
    limit: usize,
) -> Result<String, String> {
    let alignment = align(reference, predicted)?;
    let gold = View::new(reference, false, &alignment);
    let parser = View::new(predicted, true, &alignment);
    let witness = |origin: Origin| -> &[char] {
        if origin & CANDIDATE != 0 {
            &predicted.lines[(origin & !CANDIDATE) as usize].text
        } else {
            &reference.lines[origin as usize].text
        }
    };
    let cuts = cuts_of(&gold, &parser, &witness);
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
        heading_steps,
        |(u, at): &(Option<Point>, String)| format!("{at} {}", render.point(*u))
    );
    layer!(
        depth_steps,
        |(u, at): &(Option<Point>, String)| format!("{at} {}", render.point(*u))
    );
    layer!(
        sequence_steps,
        |(u, at): &(Option<Point>, String)| format!("{at} {}", render.point(*u))
    );
    layer!(hierarchy_marker, |(u, marker): &(
        Option<Point>,
        Segments
    )| format!(
        "{} marker {}",
        render.point(*u),
        render.segments(marker)
    ));
    layer!(markers_kind, |(kind, u, marker): &(String, Option<Point>, Segments)| format!(
        "{kind} {} marker {}",
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
    layer!(coverage, |p: &Piece| render.piece(*p));
    layer!(order, |(a, b): &(Piece, Piece)| format!("{} ⇒ {}", render.piece(*a), render.piece(*b)));
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
    gold: &View<'a>,
    parser: &View<'a>,
    witness: &dyn Fn(Origin) -> &'a [char],
) -> Cuts {
    // Every boundary either side draws on a source: its lines and its blocks' spans.
    let mut cuts: HashMap<Origin, Vec<usize>> = HashMap::new();
    for view in [gold, parser] {
        let lines = view.side.lines.iter().enumerate().map(|(n, line)| (n, 0, line.text.len()));
        let blocks = view.side.blocks.iter().flat_map(|block| block.spans.iter().map(|s| (s.line, s.start, s.end)));
        for (n, a, b) in lines.chain(blocks) {
            for (key, a, b) in view.project(n, a, b, witness) {
                cuts.entry(key).or_default().extend([a, b]);
            }
        }
    }
    for found in cuts.values_mut() {
        found.sort_unstable();
        found.dedup();
    }
    Cuts(cuts)
}

pub fn compare(reference: &Side, predicted: &Side) -> Result<Score, String> {
    compare_as(reference, predicted, false)
}

/// `compare`, for a gold that may leave things unsaid. `unmarked`: a machine-aligned gold (`gold_labels.LEVELLESS`) leaves a
/// quotation or a list item set in its body unmarked and gives no levels, so neither side's text, quotations and list items
/// are told apart, only the units' extents scored, and the layers that read roles or levels are not scored at all.
pub fn compare_as(reference: &Side, predicted: &Side, unmarked: bool) -> Result<Score, String> {
    let alignment = align(reference, predicted)?;
    let gold = View::new(reference, false, &alignment);
    let parser = View::new(predicted, true, &alignment);
    let witness = |origin: Origin| -> &[char] {
        if origin & CANDIDATE != 0 {
            &predicted.lines[(origin & !CANDIDATE) as usize].text
        } else {
            &reference.lines[origin as usize].text
        }
    };
    let cuts = cuts_of(&gold, &parser, &witness);
    let mut wanted = features(&gold, &cuts, &witness)?;
    let mut got = features(&parser, &cuts, &witness)?;
    if unmarked {
        for side in [&mut wanted, &mut got] {
            let body = |kind: &mut String| if *kind == "quote" || *kind == "list_item" { *kind = "text".to_owned() };
            side.units_kind.iter_mut().for_each(|(kind, _)| body(kind));
            side.markers_kind.iter_mut().for_each(|(kind, _, _)| body(kind));
        }
    }
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
    metrics.insert("heading_steps", prf(&wanted.heading_steps, &got.heading_steps));
    // A gold without depths (machine silver) scores none.
    if wanted.depth_given {
        metrics.insert("depth_steps", prf(&wanted.depth_steps, &got.depth_steps));
        metrics.insert("sequence_steps", prf(&wanted.sequence_steps, &got.sequence_steps));
    }
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
    metrics.insert("line_numbers", prf(&wanted.line_numbers, &got.line_numbers));
    metrics.insert("speakers", prf(&wanted.speakers, &got.speakers));
    metrics.insert("document", prf(&wanted.document, &got.document));
    metrics.insert("document_parts", prf(&wanted.document_parts, &got.document_parts));
    metrics.insert(
        "document_ownership",
        prf(&wanted.document_ownership, &got.document_ownership),
    );
    metrics.insert(
        "continuations",
        prf(&wanted.continuations, &got.continuations),
    );
    // The headline layers: what the apps read, by kind of unit.
    const KINDS: [(&str, &str, &str); 7] = [
        ("heading", "units_heading", "markers_heading"),
        ("text", "units_text", "markers_text"),
        ("provision", "units_provision", "markers_provision"),
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
    // Whether a numbered body unit is a paragraph, a list item or a provision turns on what the
    // document is, which a parse alone does not know: its body units are scored as one kind too.
    const BODY: [&str; 3] = ["text", "provision", "list_item"];
    let body = |f: &Features| f.units_kind.iter().filter(|(k, _)| BODY.contains(&k.as_str())).map(|(_, p)| p.clone()).collect::<Vec<_>>();
    metrics.insert("units_body", prf(&body(&wanted), &body(&got)));
    let body_marks = |f: &Features| f.markers_kind.iter().filter(|(k, _, _)| BODY.contains(&k.as_str())).map(|(_, u, s)| (*u, s.clone())).collect::<Vec<_>>();
    metrics.insert("markers_body", prf(&body_marks(&wanted), &body_marks(&got)));
    // Contents read piece by piece: every reader cuts a list into entries its own way; which of the
    // source's lines are the list's is what an app reads.
    let contents = |f: &Features| f.units_kind.iter().filter(|(k, _)| k == "contents").flat_map(|(_, p)| p.iter().map(|piece| vec![piece.clone()])).collect::<Vec<_>>();
    metrics.insert("contents_lines", prf(&contents(&wanted), &contents(&got)));
    if unmarked {
        for layer in ["roles", "hierarchy", "hierarchy_units", "hierarchy_roles", "hierarchy_marker", "heading_steps"] {
            metrics.remove(layer);
        }
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
    reference: &Side,
    predicted: &Side,
    alignment: &Alignment,
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
