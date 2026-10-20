//! Rust geometry and typography witnesses for paragraph-boundary training.
use legal_pdf_core::{line_font_size, Line, Page};

pub const PARAGRAPH_FEATURES: [&str; 30] = [
    "previous_width",
    "current_width",
    "previous_left",
    "current_left",
    "vertical_gap",
    "line_advance",
    "left_shift",
    "right_shift",
    "font_ratio",
    "height_ratio",
    "previous_length",
    "current_length",
    "previous_sentence_end",
    "previous_semicolon",
    "previous_colon",
    "previous_hyphen",
    "current_lowercase",
    "current_uppercase",
    "current_digit",
    "current_bullet",
    "previous_bold",
    "current_bold",
    "previous_italic",
    "current_italic",
    "rust_start",
    "native_typography",
    "page_y",
    "previous_measure",
    "remaining_measure",
    "first_word_width",
];

pub fn paragraph_body_line(line: &Line) -> bool {
    line.region_type == "body" && !line.exclude_from_body && line.note_region_mode.is_empty()
}

fn style(line: &Line, flag: u32, names: &[&str]) -> f64 {
    let total: usize = line.spans.iter().map(|s| s.text.chars().count()).sum();
    let styled: usize = line
        .spans
        .iter()
        .filter(|s| {
            s.flags & flag != 0
                || names
                    .iter()
                    .any(|name| s.font.to_ascii_lowercase().contains(name))
        })
        .map(|s| s.text.chars().count())
        .sum();
    styled as f64 / total.max(1) as f64
}

pub fn paragraph_boundary_features(page: &Page, a: &Line, b: &Line, rust_start: bool) -> Vec<f32> {
    let width = |line: &Line| (line.bbox[2] - line.bbox[0]).max(1.0);
    let height = |line: &Line| (line.bbox[3] - line.bbox[1]).max(1.0);
    let size = |line: &Line| line_font_size(line).max(height(line));
    let ha = height(a);
    let cw = width(a) / a.text.trim().chars().count().max(1) as f64;
    let left = page
        .lines
        .iter()
        .filter(|l| paragraph_body_line(l))
        .map(|l| l.bbox[0])
        .fold(a.bbox[0], f64::min);
    let right = page
        .lines
        .iter()
        .filter(|l| paragraph_body_line(l))
        .map(|l| l.bbox[2])
        .fold(a.bbox[2], f64::max);
    let tail = a.text.trim_end();
    let first = b.text.trim_start().chars().next().unwrap_or(' ');
    let first_word = b.words.first().map_or_else(
        || {
            width(b)
                * b.text
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .count() as f64
                / b.text.trim().chars().count().max(1) as f64
        },
        |word| word.bbox[2] - word.bbox[0],
    );
    let yes = |value: bool| if value { 1.0 } else { 0.0 };
    vec![
        width(a) / page.width,
        width(b) / page.width,
        a.bbox[0] / page.width,
        b.bbox[0] / page.width,
        (b.bbox[1] - a.bbox[3]) / ha,
        (b.bbox[1] - a.bbox[1]) / ha,
        (b.bbox[0] - a.bbox[0]) / cw,
        (b.bbox[2] - a.bbox[2]) / cw,
        size(b) / size(a),
        height(b) / ha,
        (a.text.chars().count() as f64).ln_1p(),
        (b.text.chars().count() as f64).ln_1p(),
        yes(tail.ends_with(['.', '?', '!'])),
        yes(tail.ends_with(';')),
        yes(tail.ends_with(':')),
        yes(tail.ends_with('-')),
        yes(first.is_lowercase()),
        yes(first.is_uppercase()),
        yes(first.is_numeric()),
        yes("•◦▪‣–—*".contains(first)),
        style(a, 16, &["bold", "black", "heavy"]),
        style(b, 16, &["bold", "black", "heavy"]),
        style(a, 2, &["italic", "oblique"]),
        style(b, 2, &["italic", "oblique"]),
        yes(rust_start),
        yes(!a.spans.is_empty() && !b.spans.is_empty()),
        b.bbox[1] / page.height,
        width(a) / (right - left).max(1.0),
        (right - a.bbox[2]) / cw,
        first_word / cw,
    ]
    .into_iter()
    .map(|v| v as f32)
    .collect()
}
