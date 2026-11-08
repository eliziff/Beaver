//! A presentation's text: each slide's text runs (`<a:t>`), slide by slide in their numeric order, under a
//! "## Slide N" heading. The package is bounded before it is read: its entry count, the sizes its entries declare, and
//! the bytes its slides inflate to. The bounded package reader and JavaScript's whitespace are shared with the email and
//! redline readers.

use std::cmp::Ordering;
use std::io::{Cursor, Read};
use zip::ZipArchive;

const MAX_ENTRIES: usize = 10_000;
const MAX_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SLIDE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SLIDES_BYTES: u64 = 64 * 1024 * 1024;

/// The text of a .pptx, or why its package was refused or could not be read.
pub fn text(bytes: &[u8]) -> Result<String, String> {
    let mut package = ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    let entries = bounded_entries(&mut package, &Bounds {
        label: "Presentation",
        max_entries: MAX_ENTRIES,
        max_expanded: MAX_EXPANDED_BYTES,
        selected: is_slide,
        max_selected_entry: MAX_SLIDE_BYTES,
        max_selected: MAX_SLIDES_BYTES,
        selected_name: "slide XML",
    })?;
    let mut slides: Vec<&Entry> = entries.iter().filter(|entry| is_slide(&entry.name)).collect();
    // The numeric order the TypeScript reader's collator gave: case ignored, digit runs compared by value (a stable
    // sort, so equal names keep the package's order).
    slides.sort_by(|left, right| compare_slide_names(&left.name, &right.name));

    let mut budget = MAX_SLIDES_BYTES;
    let mut out = Vec::new();
    for (index, slide) in slides.iter().enumerate() {
        let xml = read_entry(&mut package, slide.index, MAX_SLIDE_BYTES, &mut budget, "Presentation slide XML")?;
        let xml = String::from_utf8_lossy(&xml);
        if xml.is_empty() {
            continue;
        }
        let text = tag_texts(&xml)
            .iter()
            .map(|part| js_trim(part))
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            out.push(format!("## Slide {}\n\n{text}", index + 1));
        }
    }
    Ok(js_trim(&out.join("\n\n")).to_owned())
}

/// `ppt/slides/slideN.xml`, letters in any case.
fn is_slide(name: &str) -> bool {
    let bytes = name.as_bytes();
    let prefix = b"ppt/slides/slide";
    if bytes.len() < prefix.len() + 5 || !bytes[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return false;
    }
    let rest = &bytes[prefix.len()..];
    let digits = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
    digits > 0 && rest[digits..].eq_ignore_ascii_case(b".xml")
}

/// Two slide paths by their slide numbers: the digits after "slide", leading zeros ignored.
fn compare_slide_names(left: &str, right: &str) -> Ordering {
    let number = |name: &str| {
        let digits = &name["ppt/slides/slide".len()..name.len() - ".xml".len()];
        digits.trim_start_matches('0').to_owned()
    };
    let (left, right) = (number(left), number(right));
    left.len().cmp(&right.len()).then_with(|| left.cmp(&right))
}

/// The contents of each `<a:t ...>...</a:t>` (the tag's letters in any case), XML-decoded.
fn tag_texts(xml: &str) -> Vec<String> {
    let bytes = xml.as_bytes();
    let mut texts = Vec::new();
    let mut at = 0;
    while let Some(offset) = bytes[at..].iter().position(|&byte| byte == b'<') {
        let open = at + offset;
        let name_end = open + 4;
        let is_open = bytes.len() > name_end
            && bytes[open + 1..name_end].eq_ignore_ascii_case(b"a:t")
            && !is_ascii_word(bytes[name_end]);
        if !is_open {
            at = open + 1;
            continue;
        }
        let Some(close) = bytes[name_end..].iter().position(|&byte| byte == b'>') else { break };
        let content = name_end + close + 1;
        let Some(end) = find_ascii_ignore_case(&bytes[content..], b"</a:t>") else { break };
        texts.push(decode_xml_text(&xml[content..content + end]));
        at = content + end + b"</a:t>".len();
    }
    texts
}

fn is_ascii_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn find_ascii_ignore_case(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window.eq_ignore_ascii_case(needle))
}

/// The five XML entities and numeric character references, decoded one kind after another in the order the backend's
/// decodeXmlText applied them (`&amp;` last). A reference past U+10FFFF is kept as written; one to a surrogate, which no
/// Rust string holds, becomes U+FFFD.
fn decode_xml_text(value: &str) -> String {
    let value = value.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'");
    let value = replace_references(&value, false);
    let value = replace_references(&value, true);
    value.replace("&amp;", "&")
}

/// Replaces each `&#123;` (or `&#x7B;` when `hex`) with its character.
fn replace_references(value: &str, hex: bool) -> String {
    let prefix = if hex { "&#x" } else { "&#" };
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find(prefix) {
        out.push_str(&rest[..start]);
        let tail = &rest[start + prefix.len()..];
        let digits = tail
            .bytes()
            .take_while(|byte| if hex { byte.is_ascii_hexdigit() } else { byte.is_ascii_digit() })
            .count();
        if digits == 0 || !tail[digits..].starts_with(';') {
            out.push_str(prefix);
            rest = tail;
            continue;
        }
        let code = u64::from_str_radix(&tail[..digits], if hex { 16 } else { 10 }).unwrap_or(u64::MAX);
        if code <= 0x10ffff {
            out.push(char::from_u32(code as u32).unwrap_or('\u{fffd}'));
        } else {
            out.push_str(&rest[start..start + prefix.len() + digits + 1]);
        }
        rest = &tail[digits + 1..];
    }
    out.push_str(rest);
    out
}

/// Whether `c` is whitespace as JavaScript's `\s` and `trim` read it.
pub(super) fn is_js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// `text` without the whitespace JavaScript's `trim` removes.
pub(super) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// An open package over the bytes it was read from.
pub(super) type Package<'a> = ZipArchive<Cursor<&'a [u8]>>;

/// A package entry that is not a folder: its index in the package, its name and the size it declares.
pub(super) struct Entry {
    pub index: usize,
    pub name: String,
    pub size: u64,
}

/// What a package may declare: how many entries, how many bytes they expand to, and for the parts `selected` names,
/// each one's size and their total.
pub(super) struct Bounds {
    pub label: &'static str,
    pub max_entries: usize,
    pub max_expanded: u64,
    pub selected: fn(&str) -> bool,
    pub max_selected_entry: u64,
    pub max_selected: u64,
    pub selected_name: &'static str,
}

/// The package's entries (folders left out), or the bound its declared sizes break.
pub(super) fn bounded_entries(package: &mut Package, bounds: &Bounds) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for index in 0..package.len() {
        let entry = package.by_index_raw(index).map_err(|error| error.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().map_err(|error| error.to_string())?.into_owned();
        entries.push(Entry { index, name, size: entry.size() });
    }
    let label = bounds.label;
    if entries.len() > bounds.max_entries {
        return Err(format!("{label} contains too many package entries"));
    }
    let (mut expanded, mut selected) = (0u64, 0u64);
    for entry in &entries {
        expanded = expanded.saturating_add(entry.size);
        if (bounds.selected)(&entry.name) {
            if entry.size > bounds.max_selected_entry {
                return Err(format!("{label} contains an oversized {}", bounds.selected_name));
            }
            selected = selected.saturating_add(entry.size);
        }
    }
    if expanded > bounds.max_expanded || selected > bounds.max_selected {
        return Err(format!("{label} expands beyond the read limit"));
    }
    Ok(entries)
}

/// An entry's inflated bytes, counted as they are read whatever size the entry declares: at most `max_bytes`, and at
/// most what remains of `budget`, which the read spends.
pub(super) fn read_entry(package: &mut Package, index: usize, max_bytes: u64, budget: &mut u64, label: &str)
    -> Result<Vec<u8>, String> {
    let limit = max_bytes.min(*budget);
    let entry = package.by_index(index).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    entry.take(limit + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("{label} expands beyond the read limit"));
    }
    *budget -= bytes.len() as u64;
    Ok(bytes)
}
