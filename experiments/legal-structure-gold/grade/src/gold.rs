//! The gold store's own format (`legal-structure-gold.v4`): the source's lines, each typed line's region and spans, the
//! units the typed lines make, and the notes' pairs.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const V4: &str = "legal-structure-gold.v4";

/// Characters `start..end` of a source line, in Unicode scalars.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceSpan {
    pub line_id: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Deserialize)]
pub struct Gold {
    pub schema_version: String,
    pub source_sha256: String,
    pub lines: Vec<GoldLine>,
    pub typed: Vec<Typed>,
    pub units: Vec<Unit>,
    pub notes: Vec<NotePair>,
}

#[derive(Deserialize)]
pub struct GoldLine {
    pub id: String,
    pub page: usize,
    pub text: String,
    #[serde(default)]
    pub corrected: Option<String>,
}

#[derive(Deserialize)]
pub struct Typed {
    pub region: String,
    #[serde(default)]
    pub spans: Vec<SourceSpan>,
    #[serde(default)]
    pub markers: Vec<Vec<SourceSpan>>,
    #[serde(default)]
    pub references: Vec<Reference>,
    #[serde(default)]
    pub cells: Option<Vec<Vec<SourceSpan>>>,
    /// A transcript line number printed on the line it numbers, which the extraction read into it.
    #[serde(default)]
    pub line_number: Vec<SourceSpan>,
    /// The label that opens a speaker's turn on this line ("Q.", "MR. SMITH:").
    #[serde(default)]
    pub speaker: Vec<SourceSpan>,
}

#[derive(Deserialize)]
pub struct Reference {
    #[serde(default)]
    pub spans: Vec<SourceSpan>,
}

#[derive(Deserialize)]
pub struct Unit {
    pub lines: Vec<usize>,
    /// A heading's level, as the model gave it: 1 the outermost in its document.
    #[serde(default)]
    pub level: Option<usize>,
    /// A body unit's depth, as the model gave it: 1 directly under the headings, 2 inside a unit
    /// of depth 1; a unit sits inside the nearest unit before it of a smaller depth.
    #[serde(default)]
    pub depth: Option<usize>,
    #[serde(default)]
    pub starts_document: bool,
    /// On a document's first unit, what the document is, as the document pass gave it.
    #[serde(default)]
    pub document_type: Option<String>,
}

#[derive(Deserialize)]
pub struct NotePair {
    pub line: usize,
    pub reference: Option<usize>,
    pub note: Option<usize>,
}

impl GoldLine {
    /// The line's text as the gold reads it: its correction, else as extracted.
    pub fn text(&self) -> &str {
        self.corrected.as_deref().unwrap_or(&self.text)
    }
}

impl Gold {
    /// Each unit's region as scored: the region of its first typed line, as the gold stores it. What a numbered body
    /// unit is by the document's type (a provision in a contract or legislation, a quote in a judgment, submission or
    /// article) is written into the gold by its postcorrections (experiments/legal-structure-gold/postcorrect.py), so
    /// training and grading read the same gold.
    pub fn regions(&self) -> Vec<&str> {
        self.units.iter().map(|unit| self.typed[unit.lines[0]].region.as_str()).collect()
    }

    /// A transcript's line number printed at the start of the line it numbers is a label of its own, as a line holding
    /// only its number is (line_label): the unit's text starts after it. Each typed line's spans so cut, with the labels
    /// cut from them.
    pub fn line_labels(&self) -> Vec<(Vec<SourceSpan>, Vec<SourceSpan>)> {
        let index: HashMap<&str, usize> = self.lines.iter().enumerate().map(|(n, l)| (l.id.as_str(), n)).collect();
        self.typed.iter().map(|item| {
            let (mut labels, mut spans) = (Vec::new(), item.spans.clone());
            for number in &item.line_number {
                let Some(&n) = index.get(number.line_id.as_str()) else { continue };
                let text: Vec<char> = self.lines[n].text().chars().collect();
                let blank = |a: usize, b: usize| text.get(a..b).is_some_and(|gap| gap.iter().all(|c| c.is_whitespace()));
                let Some(span) = spans.iter_mut().find(|s| s.line_id == number.line_id && s.start <= number.start && blank(s.start, number.start)) else {
                    continue;
                };
                let mut rest = number.end;
                while rest < span.end && text.get(rest).is_some_and(|c| c.is_whitespace()) {
                    rest += 1;
                }
                if rest < span.end {
                    span.start = rest;
                    labels.push(number.clone());
                }
            }
            (labels, spans)
        }).collect()
    }
}
