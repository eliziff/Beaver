//! PDFs Beaver writes on the parser's page writer (legalpdf::compose): sources set from their text, books of
//! authorities and court records. Text is set in the fonts' WinAnsi range, measured as it is drawn.
pub mod authority;
pub mod book;
pub mod court;
pub mod statute;

use legalpdf::compose::Face;
use unicode_normalization::UnicodeNormalization;

/// Text as the court fonts set it: compatibility forms composed (an ellipsis three dots), and a dash their WinAnsi
/// codes lack a hyphen; their en and em dashes and curly quotes stand.
pub fn pdf_normalized(value: &str) -> String {
    value.nfkc().map(|c| match c { '\u{2010}'..='\u{2012}' | '\u{2015}' | '\u{2212}' => '-', c => c }).collect()
}

/// Normalized, with "?" for a character the fonts cannot set.
pub fn pdf_text(value: &str) -> String {
    pdf_normalized(value).chars().map(|c| if matches!(c, '\t' | '\n' | '\r') || legalpdf::compose::win_ansi(c).is_some() { c } else { '?' }).collect()
}

/// The value on one line within `width`, ending in an ellipsis where it would run past it.
pub fn fit(face: Face, value: &str, size: f64, width: f64) -> String {
    let value = pdf_text(value).split_whitespace().collect::<Vec<_>>().join(" ");
    if face.width(&value, size) <= width { return value; }
    let mut text: Vec<char> = value.chars().collect();
    while !text.is_empty() && face.width(&format!("{}…", text.iter().collect::<String>()), size) > width { text.pop(); }
    format!("{}…", text.into_iter().collect::<String>())
}

/// A run of a citation's line: its text, and whether it is in italics.
pub type Run = (String, bool);

/// A citation's lines within `width`: its first `italic` characters (the style of cause or title) in the italic face.
/// Lines break between words; a word wider than a line is split.
pub fn citation_lines(roman: Face, italic_face: Face, value: &str, italic: usize, size: f64, width: f64) -> Vec<Vec<Run>> {
    let split = value.char_indices().nth(italic).map_or(value.len(), |(at, _)| at);
    let mut words: Vec<Vec<Run>> = vec![Vec::new()];
    for (part, slanted) in [(&value[..split], true), (&value[split..], false)] {
        let text = pdf_text(part);
        let mut rest = text.as_str();
        while let Some(c) = rest.chars().next() {
            let space = c.is_whitespace();
            let end = rest.find(|d: char| d.is_whitespace() != space).unwrap_or(rest.len());
            if space { words.push(Vec::new()); } else { words.last_mut().expect("a word").push((rest[..end].to_owned(), slanted)); }
            rest = &rest[end..];
        }
    }
    let measure = |(text, slanted): &Run| if *slanted { italic_face.width(text, size) } else { roman.width(text, size) };
    let mut lines: Vec<Vec<Run>> = vec![Vec::new()];
    let mut used = 0.0;
    let put = |lines: &mut Vec<Vec<Run>>, used: &mut f64, run: Run| {
        *used += measure(&run);
        let line = lines.last_mut().expect("a line");
        match line.last_mut() { Some(last) if last.1 == run.1 => last.0.push_str(&run.0), _ => line.push(run) }
    };
    for word in words.into_iter().filter(|w| !w.is_empty()) {
        // A space between two italic words is italic too.
        let space = (" ".to_owned(), lines.last().and_then(|l| l.last()).is_some_and(|r| r.1) && word[0].1);
        let wide: f64 = word.iter().map(measure).sum();
        if used > 0.0 && used + measure(&space) + wide > width { lines.push(Vec::new()); used = 0.0; }
        if used > 0.0 { put(&mut lines, &mut used, space); }
        for (text, slanted) in word {
            let pieces: Vec<String> = if wide > width { text.chars().map(String::from).collect() } else { vec![text] };
            for piece in pieces {
                let run = (piece, slanted);
                if used > 0.0 && used + measure(&run) > width { lines.push(Vec::new()); used = 0.0; }
                put(&mut lines, &mut used, run);
            }
        }
    }
    lines
}

/// Lines within `width`, broken between words; each line of the value starts a line.
pub fn wrapped(face: Face, value: &str, size: f64, width: f64) -> Vec<String> {
    let mut lines = Vec::new();
    for raw in pdf_text(value).split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let mut line = String::new();
        for word in raw.split_whitespace() {
            let next = if line.is_empty() { word.to_owned() } else { format!("{line} {word}") };
            if line.is_empty() || face.width(&next, size) <= width { line = next; } else { lines.push(std::mem::replace(&mut line, word.to_owned())); }
        }
        lines.push(line);
    }
    lines
}
