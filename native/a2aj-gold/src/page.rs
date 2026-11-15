//! Where a PDF's lines stand on their pages: columns, the reading order they give, the gutter's letters, page furniture.
use super::words::{is_digits, is_space, plain, strip};
use regex::Regex;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

static MARGIN_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A[\[(]?\d{1,4}[\].)]?\z").unwrap());

pub const DEFAULT_PAGE: (f64, f64) = (612.0, 792.0);
pub type Sizes = HashMap<i64, (f64, f64)>;
pub type Bbox = [f64; 4];

/// A line as these rules read it.
pub struct Placed<'a> {
    pub page: i64,
    pub bbox: Bbox,
    pub text: &'a str,
}

/// Whether a page's lines keep to either side of its middle, a quarter of them at least on each side.
pub fn two_columns(boxes: &[Bbox], middle: f64) -> bool {
    let across = boxes.iter().filter(|b| b[0] < 0.95 * middle && b[2] > 1.05 * middle).count();
    let left = boxes.iter().filter(|b| (b[0] + b[2]) / 2.0 <= middle).count();
    let total = boxes.len() as f64;
    across as f64 <= 0.1 * total && left.min(boxes.len() - left) as f64 >= 0.25 * total
}

/// Whether two lines stand on one row of their page: their boxes share more than three tenths of the shorter one's height.
pub fn same_row(a: &Bbox, b: &Bbox) -> bool {
    a[3].min(b[3]) - a[1].max(b[1]) > 0.3 * (a[3] - a[1]).min(b[3] - b[1])
}

fn members(lines: &[Placed], page: i64) -> Vec<usize> {
    lines.iter().enumerate().filter(|(_, line)| line.page == page).map(|(i, _)| i).collect()
}

fn pages(lines: &[Placed]) -> BTreeSet<i64> {
    lines.iter().map(|line| line.page).collect()
}

/// Indices in reading order by column: a page whose lines keep to either side of its centre (the bilingual reports print
/// English left, French right) is read left column, then right; a word broken across two lines needs them neighbours. A
/// page whose lines run across the centre is one column, its short lines and the pieces the reader splits off a line's
/// end included, and keeps the reader's order. A paragraph number the margin prints beside a line's start, which the
/// reader puts on a line of its own after that line, is read before it, as the text reads it: in the reader's order "Some
/// context to begin." then "[88]", an alignment in order could take the number or the words, never both, and each
/// one-line paragraph's words would go to the paragraph before.
pub fn column_order(lines: &[Placed], sizes: &Sizes) -> Vec<usize> {
    let mut order = Vec::with_capacity(lines.len());
    for page in pages(lines) {
        let on_page = members(lines, page);
        let middle = sizes[&page].0 / 2.0;
        let boxes: Vec<Bbox> = on_page.iter().map(|&i| lines[i].bbox).collect();
        if two_columns(&boxes, middle) {
            let is_left = |i: &&usize| (lines[**i].bbox[0] + lines[**i].bbox[2]) / 2.0 <= middle;
            order.extend(on_page.iter().filter(is_left));
            order.extend(on_page.iter().filter(|i| !is_left(i)));
        } else {
            order.extend(on_page);
        }
    }
    for k in 1..order.len() {
        let (number, row) = (&lines[order[k]], &lines[order[k - 1]]);
        if MARGIN_NUMBER.is_match(strip(number.text)) && number.bbox[2] <= row.bbox[0] && number.page == row.page && same_row(&number.bbox, &row.bbox) {
            order.swap(k - 1, k);
        }
    }
    order
}

/// Which lines stand in the gutter of a page in two columns, a few characters long: the letters a to j the bilingual
/// reports print there to locate lines, however the recognizer reads them ("g" as "62"). They print no text of the
/// decision and take part in no alignment (a "62" there would take paragraph 62's number).
pub fn in_gutter(lines: &[Placed], sizes: &Sizes) -> Vec<bool> {
    let mut out = vec![false; lines.len()];
    for page in pages(lines) {
        let on_page = members(lines, page);
        let width = sizes[&page].0;
        let boxes: Vec<Bbox> = on_page.iter().map(|&i| lines[i].bbox).collect();
        if !two_columns(&boxes, width / 2.0) {
            continue;
        }
        for i in on_page {
            let line = &lines[i];
            out[i] = ((line.bbox[0] + line.bbox[2]) / 2.0 - width / 2.0).abs() < 0.04 * width
                && line.text.chars().filter(|&c| !is_space(c)).count() <= 4;
        }
    }
    out
}

/// A page number as printed: one or two numbers or short roman numerals, with at most the words page/of/p.
pub fn number_like(text: &str) -> bool {
    let words = plain(text);
    let rest: Vec<&String> = words.iter().filter(|w| !matches!(w.as_str(), "page" | "of" | "p" | "pg")).collect();
    !rest.is_empty() && rest.len() <= 2
        && rest.iter().all(|w| is_digits(w) || (w.chars().count() <= 5 && w.chars().all(|c| "ivxlc".contains(c))))
}

/// A line's words with their digits masked.
pub fn masked(text: &str) -> String {
    plain(text).iter().map(|w| if is_digits(w) { "#" } else { w.as_str() }).collect::<Vec<_>>().join(" ")
}

/// Where a line sits: 'head' (top or bottom tenth of the page), 'side' (outside the middle four fifths across, or set
/// sideways) or none.
pub fn margin(b: &Bbox, (width, height): (f64, f64)) -> Option<&'static str> {
    if b[1] < 0.12 * height || b[3] > 0.9 * height {
        return Some("head");
    }
    if b[2] < 0.12 * width || b[0] > 0.88 * width || (b[3] - b[1]) > 2.5 * (b[2] - b[0]).max(1.0) && b[3] - b[1] > 30.0 {
        return Some("side");
    }
    None
}

/// A number in the page head or foot that is no paragraph's number: not bracketed, and no text begins just after it on
/// its row. `others`: the other lines of its page.
pub fn page_number(text: &str, b: Option<&Bbox>, others: &[(&str, Option<Bbox>)]) -> bool {
    if !number_like(text) || text.contains(['[', '(']) {
        return false;
    }
    let Some(b) = b else { return false };
    !others.iter().any(|(other, there)| {
        let Some(there) = there.filter(|_| !strip(other).is_empty()) else { return false };
        let row = b[3].min(there[3]) - b[1].max(there[1]) > 0.5 * (b[3] - b[1]).min(there[3] - there[1]);
        row && 0.0 <= there[0] - b[2] && there[0] - b[2] < 60.0
    })
}

/// Whether words that stand in the page margins of `seen` pages of a document of `pages` recur as running matter does: on a
/// quarter of its pages, and two at least. A note at a page's foot citing a report ("(1946), 329 U.S. 40.", digits masked)
/// recurs on a few pages of a long judgment; a running head on every other page.
pub fn recurring(seen: usize, pages: usize) -> bool {
    seen >= pages.div_ceil(4).max(2)
}

/// 'furniture' or 'page_label' for each line in the page margins that is a page number, or whose words (digits masked)
/// recur in the margins of other pages (`recurring`).
pub fn furniture(lines: &[Placed], sizes: &Sizes) -> Vec<Option<&'static str>> {
    let count = pages(lines).len();
    let place: Vec<Option<&'static str>> =
        lines.iter().map(|line| margin(&line.bbox, sizes.get(&line.page).copied().unwrap_or(DEFAULT_PAGE))).collect();
    let mut seen: HashMap<String, HashSet<i64>> = HashMap::new();
    let mut on_page: HashMap<i64, Vec<usize>> = HashMap::new();
    let mut keys = vec![String::new(); lines.len()];
    for (i, line) in lines.iter().enumerate() {
        on_page.entry(line.page).or_default().push(i);
        if place[i].is_some() {
            keys[i] = masked(line.text);
            seen.entry(keys[i].clone()).or_default().insert(line.page);
        }
    }
    let mut out = vec![None; lines.len()];
    for (i, line) in lines.iter().enumerate() {
        let Some(place) = place[i] else { continue };
        let others = || -> Vec<(&str, Option<Bbox>)> {
            on_page[&line.page].iter().filter(|&&other| other != i).map(|&other| (lines[other].text, Some(lines[other].bbox))).collect()
        };
        if place == "head" && page_number(line.text, Some(&line.bbox), &others()) {
            out[i] = Some("page_label");
        } else if !number_like(line.text) && !keys[i].is_empty() && recurring(seen[&keys[i]].len(), count) {
            out[i] = Some("furniture");
        }
    }
    out
}
