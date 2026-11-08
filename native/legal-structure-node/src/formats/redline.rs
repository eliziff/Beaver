//! A Word document's text with its editorial content shown inline: tracked insertions `{++ ++}` and deletions
//! `{-- --}`, manual ink (struck-through runs as deletions, red runs as insertions, each marked `[ink]`), and each
//! comment `{>>author: text<<}` where its range ends. Runs of one kind are merged into one mark; paragraphs (those of
//! the body, its tables and its content controls) are joined by newlines. A package that cannot be read gives no text.
//!
//! The package is bounded as the backend's DOCX session bounded it, and its XML parts are read as fast-xml-parser read
//! them: element names as written, a closing tag closing whatever is open, only the five XML entities decoded, and a
//! numeric reference left as written unless XML forbids its character, which is dropped.

use super::slides::{bounded_entries, is_js_space, js_trim, read_entry, Bounds, Package};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::Cursor;
use zip::ZipArchive;

const MAX_DOCX_BYTES: usize = 25 * 1024 * 1024;
const MAX_ENTRIES: usize = 2_048;
const MAX_EXPANDED_BYTES: u64 = 96 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_XML_BYTES: u64 = 32 * 1024 * 1024;
const MAX_MARKUP_DEPTH: usize = 256;
// fast-xml-parser's maxNestedTags: an element opened under more open elements than this fails the part.
const MAX_NESTED_TAGS: usize = 100;

/// The redline projection's text of a .docx; empty when the package cannot be read.
pub fn text(bytes: &[u8]) -> String {
    project(bytes).unwrap_or_default()
}

fn project(bytes: &[u8]) -> Result<String, String> {
    let mut package = Docx::open(bytes)?;
    let document = package.xml("word/document.xml")?.ok_or("document.xml missing")?;
    let body = document.find_body().ok_or("w:body missing")?;
    let paragraphs = index_body(&document, body)?;

    // The session read every part that can hold tracked changes before the projection used the document, so a part
    // among them that does not read fails the projection.
    let mut comments = HashMap::new();
    for path in package.paths() {
        if path == "word/document.xml" || !is_revision_part(&path) {
            continue;
        }
        let tree = package.xml(&path)?.ok_or("part missing")?;
        if path == "word/comments.xml" {
            comments = read_comments(&tree);
        }
    }

    let lines: Vec<String> = paragraphs.iter().map(|events| render(events, &comments)).collect();
    Ok(lines.join("\n"))
}

/// `word/document.xml`, `footnotes`, `endnotes`, `comments`, `headerN` or `footerN`.
fn is_revision_part(path: &str) -> bool {
    let Some(name) = path.strip_prefix("word/").and_then(|name| name.strip_suffix(".xml")) else { return false };
    if matches!(name, "document" | "footnotes" | "endnotes" | "comments") {
        return true;
    }
    ["header", "footer"].iter().any(|stem| {
        name.strip_prefix(stem).is_some_and(|number| number.bytes().all(|byte| byte.is_ascii_digit()))
    })
}

/// A bounded .docx package: its parts by their names with backslashes read as slashes.
struct Docx<'a> {
    package: Package<'a>,
    parts: HashMap<String, usize>,
    budget: u64,
}

impl<'a> Docx<'a> {
    fn open(bytes: &'a [u8]) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() > MAX_DOCX_BYTES {
            return Err("DOCX is empty or exceeds the read limit".into());
        }
        let mut package = ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
        let entries = bounded_entries(&mut package, &Bounds {
            label: "DOCX",
            max_entries: MAX_ENTRIES,
            max_expanded: MAX_EXPANDED_BYTES,
            selected: is_xml_part,
            max_selected_entry: MAX_XML_ENTRY_BYTES,
            max_selected: MAX_XML_BYTES,
            selected_name: "XML part",
        })?;
        let mut parts = HashMap::new();
        let mut names: HashMap<String, String> = HashMap::new();
        for entry in entries {
            let canonical = entry.name.replace('\\', "/");
            if names.get(&canonical).is_some_and(|prior| *prior != entry.name) {
                return Err(format!("DOCX contains duplicate package part {canonical}"));
            }
            parts.insert(canonical.clone(), entry.index);
            names.insert(canonical, entry.name);
        }
        Ok(Docx { package, parts, budget: MAX_XML_BYTES })
    }

    /// The package's part names, sorted.
    fn paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self.parts.keys().cloned().collect();
        paths.sort();
        paths
    }

    /// A part's XML tree, or `None` when the package has no such part.
    fn xml(&mut self, path: &str) -> Result<Option<Tree>, String> {
        let Some(&index) = self.parts.get(path) else { return Ok(None) };
        let label = format!("DOCX part {path}");
        let bytes = read_entry(&mut self.package, index, MAX_XML_ENTRY_BYTES, &mut self.budget, &label)?;
        let xml = String::from_utf8_lossy(&bytes);
        if has_doctype(&xml) {
            return Err("DOCX XML must not contain a DOCTYPE declaration".into());
        }
        Tree::parse(&xml).map(Some)
    }
}

/// A name ending `.xml` or `.xml.rels`, in any case.
fn is_xml_part(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.ends_with(".xml") || name.ends_with(".xml.rels")
}

/// `<!DOCTYPE` (any case) followed by whitespace or `>`.
fn has_doctype(xml: &str) -> bool {
    let bytes = xml.as_bytes();
    let mut at = 0;
    while let Some(offset) = bytes[at..].windows(9).position(|window| window.eq_ignore_ascii_case(b"<!doctype")) {
        let after = at + offset + 9;
        match xml[after..].chars().next() {
            Some(next) if next == '>' || is_js_space(next) => return true,
            _ => at = after,
        }
    }
    false
}

/// A part's XML: elements and the text between them, the way the backend's parser kept them.
struct Tree {
    nodes: Vec<Node>,
    top: Vec<usize>,
}

enum Node {
    Element { name: String, attributes: Vec<(String, String)>, children: Vec<usize> },
    Text(String),
}

impl Tree {
    fn parse(xml: &str) -> Result<Tree, String> {
        let xml = xml.replace("\r\n", "\n").replace('\r', "\n");
        let mut reader = Reader::from_str(&xml);
        let config = reader.config_mut();
        config.check_end_names = false;
        config.allow_unmatched_ends = true;
        config.allow_dangling_amp = true;

        let mut tree = Tree { nodes: Vec::new(), top: Vec::new() };
        let mut open: Vec<usize> = Vec::new();
        // The raw text read since the last markup that ends it, decoded when it is kept.
        let mut text = String::new();
        let mut xml_11 = false;
        loop {
            match reader.read_event().map_err(|error| error.to_string())? {
                Event::Start(start) => {
                    if !open.is_empty() {
                        tree.keep_text(&mut text, open.last().copied(), xml_11);
                    }
                    text.clear();
                    if open.len() > MAX_NESTED_TAGS {
                        return Err("Maximum nested tags exceeded".into());
                    }
                    let id = tree.add_element(&start, open.last().copied(), xml_11);
                    open.push(id);
                }
                Event::Empty(start) => {
                    if !open.is_empty() {
                        tree.keep_text(&mut text, open.last().copied(), xml_11);
                    }
                    text.clear();
                    tree.add_element(&start, open.last().copied(), xml_11);
                }
                Event::End(_) => {
                    tree.keep_text(&mut text, open.last().copied(), xml_11);
                    open.pop();
                }
                // The text as written: entities are decoded when it is kept, as the backend's parser decoded them.
                Event::Text(raw) => text.push_str(&raw),
                Event::GeneralRef(name) => {
                    text.push('&');
                    text.push_str(&name);
                    text.push(';');
                }
                Event::CData(data) => {
                    tree.keep_text(&mut text, open.last().copied(), xml_11);
                    tree.add(Node::Text(data.into_inner().into_owned()), open.last().copied());
                }
                Event::Decl(declaration) => {
                    tree.keep_text(&mut text, open.last().copied(), xml_11);
                    if let Ok(version) = declaration.version() {
                        xml_11 = js_trim(&version).parse::<f64>().is_ok_and(|number| number == 1.1);
                    }
                }
                Event::PI(_) => tree.keep_text(&mut text, open.last().copied(), xml_11),
                Event::Comment(_) | Event::DocType(_) => {}
                Event::Eof => break,
            }
        }
        Ok(tree)
    }

    fn add(&mut self, node: Node, parent: Option<usize>) -> usize {
        let id = self.nodes.len();
        self.nodes.push(node);
        match parent {
            Some(parent) => {
                if let Node::Element { children, .. } = &mut self.nodes[parent] {
                    children.push(id);
                }
            }
            None => self.top.push(id),
        }
        id
    }

    fn add_element(&mut self, start: &BytesStart, parent: Option<usize>, xml_11: bool) -> usize {
        let name = start.name().as_ref().to_owned();
        let mut attributes = Vec::new();
        for attribute in start.attributes().with_checks(false).flatten() {
            attributes.push((attribute.key.as_ref().to_owned(), decode_entities(&attribute.value, xml_11)));
        }
        self.add(Node::Element { name, attributes, children: Vec::new() }, parent)
    }

    /// Keeps the pending text under `parent` when it decodes to something.
    fn keep_text(&mut self, text: &mut String, parent: Option<usize>, xml_11: bool) {
        if !text.is_empty() {
            let decoded = decode_entities(text, xml_11);
            if !decoded.is_empty() {
                self.add(Node::Text(decoded), parent);
            }
        }
        text.clear();
    }

    fn name(&self, id: usize) -> Option<&str> {
        match &self.nodes[id] {
            Node::Element { name, .. } => Some(name),
            Node::Text(_) => None,
        }
    }

    fn children(&self, id: usize) -> &[usize] {
        match &self.nodes[id] {
            Node::Element { children, .. } => children,
            Node::Text(_) => &[],
        }
    }

    /// An attribute's value; the last of that name, as the backend's parser kept it.
    fn attribute(&self, id: usize, key: &str) -> Option<&str> {
        match &self.nodes[id] {
            Node::Element { attributes, .. } => {
                attributes.iter().rev().find(|(name, _)| name == key).map(|(_, value)| value.as_str())
            }
            Node::Text(_) => None,
        }
    }

    /// The element's own text: its text children, joined.
    fn own_text(&self, id: usize) -> String {
        self.children(id)
            .iter()
            .filter_map(|&child| match &self.nodes[child] {
                Node::Text(text) => Some(text.as_str()),
                Node::Element { .. } => None,
            })
            .collect()
    }

    fn child_named(&self, id: usize, name: &str) -> Option<usize> {
        self.children(id).iter().copied().find(|&child| self.name(child) == Some(name))
    }

    /// The first top-level `w:document`'s first `w:body`.
    fn find_body(&self) -> Option<usize> {
        let document = self.top.iter().copied().find(|&id| self.name(id) == Some("w:document"))?;
        self.child_named(document, "w:body")
    }
}

/// fast-xml-parser's entity decoding with its defaults: `&amp;`, `&apos;`, `&gt;`, `&lt;` and `&quot;` are replaced in
/// one pass; a numeric reference is dropped when its character is NUL, a surrogate or (in XML 1.0) a C0 control other
/// than tab, newline and carriage return, and is otherwise left as written, as is any other reference. A reference is
/// an `&` with a `;` at most 32 characters after it.
fn decode_entities(raw: &str, xml_11: bool) -> String {
    if !raw.contains('&') {
        return raw.to_owned();
    }
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut at = 0;
    while at < chars.len() {
        if chars[at] != '&' {
            out.push(chars[at]);
            at += 1;
            continue;
        }
        let mut end = at + 1;
        while end < chars.len() && chars[end] != ';' && end - at <= 32 {
            end += 1;
        }
        if end >= chars.len() || chars[end] != ';' || end == at + 1 {
            out.push('&');
            at += 1;
            continue;
        }
        let token: String = chars[at + 1..end].iter().collect();
        let replacement = if let Some(number) = token.strip_prefix('#') {
            dropped_reference(number, xml_11).then_some("")
        } else {
            match token.as_str() {
                "amp" => Some("&"),
                "apos" => Some("'"),
                "gt" => Some(">"),
                "lt" => Some("<"),
                "quot" => Some("\""),
                _ => None,
            }
        };
        match replacement {
            Some(replacement) => {
                out.push_str(replacement);
                at = end + 1;
            }
            None => {
                out.push('&');
                at += 1;
            }
        }
    }
    out
}

/// Whether the reference `&#…;` names a character the parser drops. Its number is read as JavaScript's parseInt reads
/// it: leading whitespace and a sign allowed, digits up to the first that is not one, `0x` allowed before hex digits.
fn dropped_reference(number: &str, xml_11: bool) -> bool {
    let (digits, radix) = match number.strip_prefix(['x', 'X']) {
        Some(hex) => (hex, 16),
        None => (number, 10),
    };
    let digits = digits.trim_start_matches(is_js_space);
    let (negative, digits) = match digits.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, digits.strip_prefix('+').unwrap_or(digits)),
    };
    let digits = if radix == 16 {
        digits.strip_prefix("0x").or_else(|| digits.strip_prefix("0X")).unwrap_or(digits)
    } else {
        digits
    };
    let count = digits.chars().take_while(|c| c.is_digit(radix)).count();
    if count == 0 {
        return false;
    }
    let mut code: u64 = 0;
    for c in digits.chars().take(count) {
        code = code.saturating_mul(u64::from(radix)).saturating_add(u64::from(c.to_digit(radix).unwrap_or(0)));
    }
    if negative && code != 0 {
        return false;
    }
    if code > 0x10ffff {
        return false;
    }
    code == 0
        || (0xd800..=0xdfff).contains(&code)
        || (!xml_11 && (0x01..=0x1f).contains(&code) && !matches!(code, 0x09 | 0x0a | 0x0d))
}

/// What a paragraph's inline markup holds, in order: runs with the revision they sit in, and comment range ends.
enum Inline {
    Run { text: String, ins: bool, del: bool, strike: bool, color: Option<String> },
    CommentEnd(Option<String>),
}

/// Each body paragraph's inline events: paragraphs of the body and of the tables, rows, cells and content controls in it.
fn index_body(tree: &Tree, body: usize) -> Result<Vec<Vec<Inline>>, String> {
    let mut paragraphs = Vec::new();
    for &child in tree.children(body) {
        collect(tree, child, 0, &mut paragraphs)?;
    }
    Ok(paragraphs)
}

const TRUNCATED: &str = "DOCX markup nests beyond the read limit";

fn collect(tree: &Tree, node: usize, depth: usize, paragraphs: &mut Vec<Vec<Inline>>) -> Result<(), String> {
    if depth > MAX_MARKUP_DEPTH {
        return Err(TRUNCATED.into());
    }
    match tree.name(node) {
        Some("w:p") => {
            let mut events = Vec::new();
            for &child in tree.children(node) {
                visit(tree, child, false, false, 0, &mut events)?;
            }
            paragraphs.push(events);
        }
        Some("w:tbl" | "w:tr" | "w:tc" | "w:sdt" | "w:sdtContent") => {
            for &child in tree.children(node) {
                collect(tree, child, depth + 1, paragraphs)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Markup that holds no run text of the paragraph.
fn is_skipped(name: &str) -> bool {
    matches!(name, "w:pPr" | "w:rPr" | "w:sectPr" | "w:tblPr" | "w:trPr" | "w:tcPr" | "w:tblGrid" | "w:sdtPr"
        | "w:sdtEndPr" | "w:bookmarkStart" | "w:bookmarkEnd" | "w:proofErr" | "w:commentReference" | "mc:Fallback")
}

fn visit(tree: &Tree, node: usize, ins: bool, del: bool, depth: usize, events: &mut Vec<Inline>)
    -> Result<(), String> {
    if depth > MAX_MARKUP_DEPTH {
        return Err(TRUNCATED.into());
    }
    let Some(name) = tree.name(node) else { return Ok(()) };
    if is_skipped(name) || name == "w:commentRangeStart" {
        return Ok(());
    }
    match name {
        "w:commentRangeEnd" => events.push(Inline::CommentEnd(tree.attribute(node, "w:id").map(str::to_owned))),
        "w:r" => events.push(read_run(tree, node, ins, del)),
        _ => {
            let (ins, del) = match name {
                "w:ins" => (true, del),
                "w:del" => (ins, true),
                _ => (ins, del),
            };
            for &child in tree.children(node) {
                visit(tree, child, ins, del, depth + 1, events)?;
            }
        }
    }
    Ok(())
}

/// A run's text (`w:t`, and `w:delText` inside a deletion) and its strike-through and colour.
fn read_run(tree: &Tree, run: usize, ins: bool, del: bool) -> Inline {
    let mut strike = false;
    let mut color = None;
    if let Some(properties) = tree.child_named(run, "w:rPr") {
        for &property in tree.children(properties) {
            let value = tree.attribute(property, "w:val");
            match tree.name(property) {
                Some("w:strike") => {
                    strike = value.is_none_or(|value| !value.eq_ignore_ascii_case("false") && value != "0");
                }
                Some("w:color") => {
                    if let Some(value) = value.filter(|value| value.to_lowercase() != "auto") {
                        color = Some(value.to_owned());
                    }
                }
                _ => {}
            }
        }
    }
    let mut text = String::new();
    for &child in tree.children(run) {
        match tree.name(child) {
            Some("w:t") => text.push_str(&tree.own_text(child)),
            Some("w:delText") if del => text.push_str(&tree.own_text(child)),
            _ => {}
        }
    }
    Inline::Run { text, ins, del, strike, color }
}

/// A comment's author and its text: the words of its paragraphs, a space after each, whitespace collapsed.
struct Comment {
    author: String,
    text: String,
}

fn read_comments(tree: &Tree) -> HashMap<String, Comment> {
    let mut comments = HashMap::new();
    let mut pending: Vec<usize> = tree.top.iter().rev().copied().collect();
    while let Some(node) = pending.pop() {
        let Some(name) = tree.name(node) else { continue };
        if name == "w:comment" {
            if let Some(id) = tree.attribute(node, "w:id") {
                let author = js_trim(tree.attribute(node, "w:author").unwrap_or("")).to_owned();
                let text = collapse_whitespace(&subtree_text(tree, node));
                comments.insert(id.to_owned(), Comment { author, text });
            }
            continue;
        }
        pending.extend(tree.children(node).iter().rev().copied());
    }
    comments
}

fn subtree_text(tree: &Tree, node: usize) -> String {
    let Some(name) = tree.name(node) else { return String::new() };
    if name == "w:t" || name == "w:delText" {
        return tree.own_text(node);
    }
    let mut out: String = tree.children(node).iter().map(|&child| subtree_text(tree, child)).collect();
    if name == "w:p" {
        out.push(' ');
    }
    out
}

/// Each run of whitespace as one space, and none at either end.
fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if is_js_space(c) {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

/// A colour in the red family: `#RRGGBB` or `RRGGBB` with red at least B0 and green and blue at most 60.
fn is_red_family(value: &str) -> bool {
    let value = js_trim(value);
    let hex = value.strip_prefix('#').unwrap_or(value);
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return false;
    }
    let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).unwrap_or(0);
    channel(0) >= 0xb0 && channel(2) <= 0x60 && channel(4) <= 0x60
}

#[derive(Clone, Copy, PartialEq)]
enum Mark {
    Plain,
    Insertion,
    Deletion,
    InkInsertion,
    InkDeletion,
}

/// A paragraph's line: its runs, consecutive runs of one mark under one wrapper, and its comments where they end.
fn render(events: &[Inline], comments: &HashMap<String, Comment>) -> String {
    let mut out = String::new();
    let mut pending: Option<(Mark, String)> = None;
    let flush = |out: &mut String, pending: &mut Option<(Mark, String)>| {
        if let Some((mark, text)) = pending.take() {
            let (open, close) = match mark {
                Mark::Plain => ("", ""),
                Mark::Insertion => ("{++", "++}"),
                Mark::Deletion => ("{--", "--}"),
                Mark::InkInsertion => ("{++", "++}[ink]"),
                Mark::InkDeletion => ("{--", "--}[ink]"),
            };
            out.push_str(open);
            out.push_str(&text);
            out.push_str(close);
        }
    };
    for event in events {
        match event {
            Inline::CommentEnd(id) => {
                let Some(comment) = id.as_ref().and_then(|id| comments.get(id)) else { continue };
                flush(&mut out, &mut pending);
                let author = if comment.author.is_empty() { "unattributed" } else { &comment.author };
                out.push_str(&format!("{{>>{author}: {}<<}}", comment.text));
            }
            Inline::Run { text, ins, del, strike, color } => {
                if text.is_empty() {
                    continue;
                }
                let mark = if *del {
                    Mark::Deletion
                } else if *ins {
                    Mark::Insertion
                } else if *strike {
                    Mark::InkDeletion
                } else if color.as_deref().is_some_and(is_red_family) {
                    Mark::InkInsertion
                } else {
                    Mark::Plain
                };
                if matches!(&pending, Some((current, _)) if *current == mark) {
                    if let Some((_, merged)) = &mut pending {
                        merged.push_str(text);
                    }
                } else {
                    flush(&mut out, &mut pending);
                    pending = Some((mark, text.clone()));
                }
            }
        }
    }
    flush(&mut out, &mut pending);
    out
}
