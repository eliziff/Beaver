//! Training rows for the tier-1 line tagger: one row per source line, in the parser's reading
//! order, with the line's own evidence (geometry, typography, text shape, the readers' flags), the
//! parser's labels (tier 0) and the gold's labels. A join only: every value is read from the
//! parser's pages and structure or from the gold, never decided here.
use crate::labels::LineLabel;
use crate::state::State;
use legalpdf::Page;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Names of the numeric features, in row order.
pub const FEATURES: [&str; 44] = [
    "x0", "y0", "x1", "y1", "height", "gap_above", "gap_below", "indent", "right_gap", "width", "centre",
    "size", "bold", "italic", "superscript", "monospace", "size_change", "font_change", "underlined",
    "length", "upper", "digits", "punctuation", "spaces", "starts_digit", "starts_upper", "starts_lower",
    "starts_open", "starts_mark", "ends_period", "ends_colon", "ends_comma", "ends_hyphen", "ends_digit",
    "ocr", "confidence", "page_quality", "page_position", "line_position", "first_on_page", "last_on_page",
    "excluded", "label_candidate", "note_mode",
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

/// One document's rows, over the candidate's lines in its reading order.
pub fn document(
    pages: &[Page],
    candidate: &State,
    tier0: &[LineLabel],
    gold: &HashMap<String, LineLabel>,
) -> Value {
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
    let row = |label: &LineLabel| json!([label.region, label.start, label.relation, u8::from(label.document), u8::from(label.reference)]);
    for &n in &candidate.reading_order {
        let line = &candidate.lines[n];
        let Some(&(p, k)) = by_id.get(line.id.as_str()) else { continue };
        let page = &pages[p];
        let stats = &stats[p];
        let own = &page.lines[k];
        let rank = stats.rank[&k];
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
        values.extend(text_shape(&own.text));
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
        ]);
        debug_assert_eq!(values.len(), FEATURES.len());
        ids.push(line.id.clone());
        page_of.push(p);
        features.push(values.into_iter().map(|v| (v * 1e4).round() / 1e4).collect::<Vec<f64>>());
        texts.push(json!([own.text.chars().take(48).collect::<String>(), own.region_type, own.note_region_mode]));
        tier0_rows.push(row(&tier0[n]));
        gold_rows.push(gold.get(&line.id).map_or(json!(null), row));
    }
    json!({"ids": ids, "pages": page_of, "features": features, "text": texts, "tier0": tier0_rows, "gold": gold_rows})
}
