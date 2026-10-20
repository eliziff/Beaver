//! Training rows for the tier-1 tagger: one row per piece of the parser's lines (a line cut at
//! the parser's block boundaries), in its reading order, with the line's own evidence (geometry,
//! typography, the readers' flags), the piece's text shape and place in its line, the parser's
//! labels (tier 0) and the gold's labels carried onto the piece. A join only: every value is read
//! from the parser's pages and structure or from the gold, never decided here.
use crate::labels::{anchor, Label, Locator, Piece};
use crate::state::State;
use legalpdf::Page;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Names of the numeric features, in row order.
pub const FEATURES: [&str; 81] = [
    "x0", "y0", "x1", "y1", "height", "gap_above", "gap_below", "indent", "right_gap", "width", "centre",
    "size", "bold", "italic", "superscript", "monospace", "size_change", "font_change", "underlined",
    "length", "upper", "digits", "punctuation", "spaces", "starts_digit", "starts_upper", "starts_lower",
    "starts_open", "starts_mark", "ends_period", "ends_colon", "ends_comma", "ends_hyphen", "ends_digit",
    "ocr", "confidence", "page_quality", "page_position", "line_position", "first_on_page", "last_on_page",
    "excluded", "label_candidate", "note_mode", "piece_start", "piece_share",
    "marker", "ordinal", "prefix_depth",
    "u0_exists", "u0_indent", "u0_size", "u0_bold", "u0_family", "u0_next", "u0_region", "u0_distance",
    "u1_exists", "u1_indent", "u1_size", "u1_bold", "u1_family", "u1_next", "u1_region", "u1_distance",
    "u2_exists", "u2_indent", "u2_size", "u2_bold", "u2_family", "u2_next", "u2_region", "u2_distance",
    "u3_exists", "u3_indent", "u3_size", "u3_bold", "u3_family", "u3_next", "u3_region", "u3_distance",
];

fn median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn quantile(mut values: Vec<f64>, q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    values[((values.len() - 1) as f64 * q).round() as usize]
}

/// Each span's share of the line's characters with a flag set.
fn flagged(line: &legalpdf::Line, flag: u32) -> f64 {
    let total: usize = line.spans.iter().map(|s| s.text.chars().count()).sum();
    if total == 0 {
        return 0.0;
    }
    line.spans.iter().filter(|s| s.flags & flag != 0).map(|s| s.text.chars().count()).sum::<usize>() as f64 / total as f64
}

fn dominant(line: &legalpdf::Line) -> Option<(&str, f64)> {
    let mut weight: HashMap<(&str, u64), usize> = HashMap::new();
    for span in &line.spans {
        *weight.entry((span.font.as_str(), span.size.to_bits())).or_default() += span.text.chars().count();
    }
    weight.into_iter().max_by_key(|(_, n)| *n).map(|((font, size), _)| (font, f64::from_bits(size)))
}

fn text_shape(text: &str) -> [f64; 15] {
    let chars: Vec<char> = text.trim().chars().collect();
    let n = chars.len().max(1) as f64;
    let letters = chars.iter().filter(|c| c.is_alphabetic()).count().max(1) as f64;
    let first = chars.first().copied().unwrap_or(' ');
    let last = chars.last().copied().unwrap_or(' ');
    let flag = |b: bool| f64::from(u8::from(b));
    [
        (1.0 + chars.len() as f64).ln() / 5.0,
        chars.iter().filter(|c| c.is_uppercase()).count() as f64 / letters,
        chars.iter().filter(|c| c.is_ascii_digit()).count() as f64 / n,
        chars.iter().filter(|c| c.is_ascii_punctuation()).count() as f64 / n,
        chars.iter().filter(|c| c.is_whitespace()).count() as f64 / n,
        flag(first.is_ascii_digit()),
        flag(first.is_uppercase()),
        flag(first.is_lowercase()),
        flag("([{".contains(first)),
        flag("•·▪–—-*†‡§¶".contains(first)),
        flag(last == '.'),
        flag(last == ':'),
        flag(last == ',' || last == ';'),
        flag(last == '-' || last == '\u{00AD}'),
        flag(last.is_ascii_digit()),
    ]
}

const CHAIN: usize = 4;

/// Each piece's place among the parser's ranked units: the unit before it in reading order and that
/// unit's ancestors as the parser assembled them, each compared with the piece by indentation,
/// type and the engine's numbering grammar (same family, the next ordinal). Per candidate piece.
fn unit_context(candidate: &State, pieces: &[Piece], tier0: &[Label], geometry: &dyn Fn(usize) -> Option<(f64, f64, f64, bool)>)
    -> (Vec<Vec<f64>>, Vec<String>) {
    use legal_structure::LayoutAnalysis;
    let locate = Locator::new(pieces);
    let ranked = |k: usize| tier0[k].start == 1 && !matches!(tier0[k].region, 0 | 5 | 7 | 10 | 11 | 12);
    let start_of = |group: &legal_structure::CompositionBlock| group.spans.first()
        .and_then(|s| candidate.index.get(&s.line_id).and_then(|&n| locate.at(n, s.start)));
    // The parser's blocks by the piece they start on, their markers and their parents' pieces.
    let mut block_start: HashMap<String, usize> = HashMap::new();
    for group in &candidate.groups {
        if let Some(k) = start_of(group) {
            block_start.insert(crate::state::block_id(group), k);
        }
    }
    let mut parent_of: HashMap<usize, usize> = HashMap::new();
    let mut marker_of: HashMap<usize, legal_structure::layout::NumberingMarker> = HashMap::new();
    for group in &candidate.groups {
        let Some(k) = start_of(group) else { continue };
        if let Some(parent) = group.attributes.get("parent").and_then(Value::as_str).and_then(|a| block_start.get(a)) {
            parent_of.entry(k).or_insert(*parent);
        }
        let spans: Vec<legal_structure::SourceSpan> = serde_json::from_value(group.attributes.get("marker").cloned().unwrap_or_default()).unwrap_or_default();
        let text: String = spans.iter().filter_map(|s| candidate.index.get(&s.line_id).map(|&m| {
            let chars = &candidate.lines[m].text;
            chars[s.start.min(chars.len())..s.end.min(chars.len())].iter().collect::<String>()
        })).collect::<Vec<_>>().join(" ");
        if !text.trim().is_empty() {
            if let Some(marker) = legal_structure::STRUCTURE_ANALYSIS.numbering_marker(text.trim(), None) {
                marker_of.entry(k).or_insert(marker);
            }
        }
    }
    let mut rows = vec![Vec::new(); pieces.len()];
    let mut families = vec![String::new(); pieces.len()];
    let mut previous: Option<usize> = None;
    for k in 0..pieces.len() {
        let own = marker_of.get(&k).filter(|_| tier0[k].start == 1);
        let mut values = vec![
            f64::from(u8::from(own.is_some())),
            own.map_or(0.0, |m| (1.0 + f64::from(m.ordinal)).ln() / 5.0),
            own.map_or(0.0, |m| m.prefix.len().min(3) as f64 / 3.0),
        ];
        families[k] = own.map(|m| m.family.clone()).unwrap_or_default();
        let mut chain = Vec::new();
        let mut at = previous;
        while let Some(unit) = at.filter(|u| chain.len() < CHAIN && !chain.contains(u)) {
            chain.push(unit);
            at = parent_of.get(&unit).copied();
        }
        let here = geometry(k);
        for slot in 0..CHAIN {
            let Some(&unit) = chain.get(slot) else {
                values.extend([0.0; 8]);
                continue;
            };
            let there = geometry(unit);
            let theirs = marker_of.get(&unit);
            let (indent, size, bold) = match (here, there) {
                (Some((x, s, w, b)), Some((x2, s2, _, b2))) => (
                    ((x - x2) / w).clamp(-1.0, 1.0),
                    if s2 > 0.0 && s > 0.0 { (s / s2).min(4.0) } else { 1.0 },
                    f64::from(u8::from(b == b2)),
                ),
                _ => (0.0, 1.0, 0.0),
            };
            let family = match (own, theirs) {
                (Some(a), Some(b)) => f64::from(u8::from(a.family == b.family)),
                _ => -1.0,
            };
            let next = match (own, theirs) {
                (Some(a), Some(b)) => f64::from(u8::from(a.family == b.family && a.ordinal == b.ordinal + 1)),
                _ => 0.0,
            };
            let distance = k.saturating_sub(unit) as f64;
            values.extend([1.0, indent, size, bold, family, next, f64::from(u8::from(tier0[k].region == tier0[unit].region)),
                (1.0 + distance).ln() / 8.0]);
        }
        rows[k] = values;
        if ranked(k) {
            previous = Some(k);
        }
    }
    (rows, families)
}

/// One document's rows, over the candidate's pieces in its reading order; `gold` holds the gold's
/// labels carried onto each piece.
pub fn document(pages: &[Page], candidate: &State, pieces: &[Piece], tier0: &[Label], gold: &[Option<Label>]) -> Value {
    let mut by_id: HashMap<&str, (usize, usize)> = HashMap::new();
    for (p, page) in pages.iter().enumerate() {
        for (n, line) in page.lines.iter().enumerate() {
            by_id.insert(line.id.as_str(), (p, n));
        }
    }
    // Per page: the reading order of its lines, its body's edges and its typical line.
    struct PageStats {
        order: Vec<usize>,
        rank: HashMap<usize, usize>,
        height: f64,
        left: f64,
        right: f64,
        size: f64,
    }
    let stats: Vec<PageStats> = pages.iter().map(|page| {
        let mut order: Vec<usize> = (0..page.lines.len()).collect();
        order.sort_by_key(|&n| (page.lines[n].reading_order, n));
        let rank = order.iter().enumerate().map(|(k, &n)| (n, k)).collect();
        let sizes: Vec<f64> = page.lines.iter().filter_map(|l| dominant(l).map(|d| d.1)).filter(|s| *s > 0.0).collect();
        PageStats {
            height: median(page.lines.iter().map(|l| (l.bbox[3] - l.bbox[1]).max(0.1)).collect()).max(0.1),
            left: quantile(page.lines.iter().map(|l| l.bbox[0]).collect(), 0.1),
            right: quantile(page.lines.iter().map(|l| l.bbox[2]).collect(), 0.9),
            size: median(sizes),
            order,
            rank,
        }
    }).collect();
    let page_count = pages.len().max(1) as f64;
    let mut ids = Vec::new();
    let mut page_of = Vec::new();
    let mut features = Vec::new();
    let mut texts = Vec::new();
    let mut tier0_rows = Vec::new();
    let mut gold_rows = Vec::new();
    // Rows are the pieces the pages place; a pointer is the row of the piece it names, or -1.
    let kept: Vec<usize> = (0..pieces.len()).filter(|&k| by_id.contains_key(candidate.lines[pieces[k].line].id.as_str())).collect();
    let row_of: HashMap<String, i64> = kept.iter().enumerate().map(|(row, &k)| (anchor(candidate, &pieces[k]), row as i64)).collect();
    let pointer = |name: &Option<String>| name.as_deref().and_then(|a| row_of.get(a)).copied().unwrap_or(-1);
    let row = |label: &Label| json!([label.region, label.start, label.relation, u8::from(label.document), u8::from(label.reference),
        pointer(&label.parent), pointer(&label.continues)]);
    let geometry = |k: usize| -> Option<(f64, f64, f64, bool)> {
        let &(p, n) = by_id.get(candidate.lines[pieces[k].line].id.as_str())?;
        let line = &pages[p].lines[n];
        Some((line.bbox[0], dominant(line).map_or(0.0, |d| d.1), pages[p].width.max(1.0), flagged(line, 16) > 0.5))
    };
    let (context, families) = unit_context(candidate, pieces, tier0, &geometry);
    for &k in &kept {
        let piece = &pieces[k];
        let line = &candidate.lines[piece.line];
        let (p, n) = by_id[line.id.as_str()];
        let page = &pages[p];
        let stats = &stats[p];
        let own = &page.lines[n];
        let rank = stats.rank[&n];
        let neighbour = |offset: isize| (rank as isize + offset).try_into().ok().and_then(|r: usize| stats.order.get(r)).map(|&m| &page.lines[m]);
        let (w, h) = (page.width.max(1.0), page.height.max(1.0));
        let [x0, y0, x1, y1] = own.bbox;
        let body = (stats.right - stats.left).max(1.0);
        let above = neighbour(-1).map_or(3.0, |prev| ((y0 - prev.bbox[3]) / stats.height).clamp(-3.0, 3.0));
        let below = neighbour(1).map_or(3.0, |next| ((next.bbox[1] - y1) / stats.height).clamp(-3.0, 3.0));
        let style = dominant(own);
        let previous_style = neighbour(-1).and_then(dominant);
        let size = style.map_or(0.0, |s| s.1);
        let underlined = if own.words.is_empty() { 0.0 } else { own.words.iter().filter(|w| w.underlined).count() as f64 / own.words.len() as f64 };
        let text: String = line.text[piece.start.min(line.text.len())..piece.end.min(line.text.len())].iter().collect();
        let length = line.text.len().max(1) as f64;
        let mut values = vec![
            x0 / w, y0 / h, x1 / w, y1 / h,
            ((y1 - y0) / stats.height).min(5.0), above, below,
            ((x0 - stats.left) / w).clamp(-1.0, 1.0), ((stats.right - x1) / w).clamp(-1.0, 1.0),
            ((x1 - x0) / body).min(2.0), (((x0 + x1) / 2.0 - w / 2.0) / w).clamp(-1.0, 1.0),
            if stats.size > 0.0 { (size / stats.size).min(4.0) } else { 0.0 },
            flagged(own, 16), flagged(own, 2), flagged(own, 1), flagged(own, 8),
            match (style, previous_style) { (Some(a), Some(b)) if b.1 > 0.0 => (a.1 / b.1).min(4.0), _ => 1.0 },
            match (style, previous_style) { (Some(a), Some(b)) => f64::from(u8::from(a.0 != b.0)), _ => 0.0 },
            underlined,
        ];
        values.extend(text_shape(&text));
        values.extend([
            f64::from(u8::from(own.source != "native")),
            own.ocr.as_ref().map_or(1.0, |o| o.confidence),
            page.text_quality,
            p as f64 / page_count,
            rank as f64 / page.lines.len().max(1) as f64,
            f64::from(u8::from(rank == 0)),
            f64::from(u8::from(rank + 1 == page.lines.len())),
            f64::from(u8::from(own.exclude_from_body)),
            f64::from(u8::from(own.paragraph_label_candidate)),
            f64::from(u8::from(!own.note_region_mode.is_empty())),
            piece.start as f64 / length,
            (piece.end - piece.start) as f64 / length,
        ]);
        values.extend(context[k].iter().copied());
        debug_assert_eq!(values.len(), FEATURES.len());
        ids.push(anchor(candidate, piece));
        page_of.push(p);
        features.push(values.into_iter().map(|v| (v * 1e4).round() / 1e4).collect::<Vec<f64>>());
        texts.push(json!([text.chars().take(48).collect::<String>(), own.region_type, own.note_region_mode, families[k]]));
        tier0_rows.push(row(&tier0[k]));
        gold_rows.push(gold[k].as_ref().map_or(json!(null), row));
    }
    json!({"ids": ids, "pages": page_of, "features": features, "text": texts, "tier0": tier0_rows, "gold": gold_rows})
}
