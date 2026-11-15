//! A gold as the rules that correct it read and change it: its lines, typed lines, units and notes. A typed line's index is
//! what units and notes name, so a line put in or a unit cut moves them along here, in one place.
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

pub struct PageLine {
    pub id: String,
    pub page: i64,
    pub text: Vec<char>,
    pub bbox: [f64; 4],
}

impl PageLine {
    pub fn slice(&self, start: usize, end: usize) -> String {
        self.text[start.min(self.text.len())..end.min(self.text.len())].iter().collect()
    }

    pub fn spelled(&self) -> String {
        self.text.iter().collect()
    }

    pub fn trimmed(&self) -> String {
        self.spelled().trim_matches(super::words::is_space).to_owned()
    }
}

pub struct Book {
    pub lines: Vec<PageLine>,
    pub by_id: HashMap<String, usize>,
    pub typed: Vec<Value>,
    pub units: Vec<Value>,
    pub notes: Vec<Value>,
    pub languages: usize,
}

/// A marker's span: as stored, a one-span list.
pub fn span_of(mark: &Value) -> &Value {
    if mark.is_array() { &mark[0] } else { mark }
}

pub fn numbers(value: &Value) -> Vec<usize> {
    value.as_array().map(Vec::as_slice).unwrap_or(&[]).iter().filter_map(|n| n.as_u64().map(|n| n as usize)).collect()
}

impl Book {
    pub fn of(gold: &Value) -> Book {
        let lines: Vec<PageLine> = gold["lines"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter().map(|line| {
            let at = |n: usize| line["bbox"][n].as_f64().unwrap_or(0.0);
            let text = line.get("corrected").and_then(Value::as_str).filter(|text| !text.is_empty()).or(line["text"].as_str()).unwrap_or("");
            PageLine { id: line["id"].as_str().unwrap_or("").to_owned(), page: line["page"].as_i64().unwrap_or(0), text: text.chars().collect(), bbox: [at(0), at(1), at(2), at(3)] }
        }).collect();
        let by_id = lines.iter().enumerate().map(|(k, line)| (line.id.clone(), k)).collect();
        let list = |name: &str| gold[name].as_array().cloned().unwrap_or_default();
        Book { lines, by_id, typed: list("typed"), units: list("units"), notes: list("notes"), languages: gold["authoring"]["languages"].as_array().map_or(1, Vec::len) }
    }

    /// The lines' texts and boxes back in the gold, where a rule gave a line its number.
    pub fn lines_back(&self, gold: &mut Value) {
        let Some(lines) = gold["lines"].as_array_mut() else { return };
        for (line, page) in lines.iter_mut().zip(&self.lines) {
            if line["text"].as_str() != Some(page.spelled().as_str()) && line.get("corrected").is_none() {
                line["text"] = json!(page.spelled());
                line["bbox"][0] = json!(page.bbox[0]);
            }
        }
    }

    /// Whether any typed line carries a marker.
    pub fn markers_any(&self) -> bool {
        (0..self.typed.len()).any(|t| !self.markers(t).is_empty())
    }

    pub fn put_back(self, gold: &mut Value) {
        gold["typed"] = Value::Array(self.typed);
        gold["units"] = Value::Array(self.units);
        gold["notes"] = Value::Array(self.notes);
    }

    pub fn line(&self, id: &str) -> Option<&PageLine> {
        self.by_id.get(id).map(|&k| &self.lines[k])
    }

    pub fn region(&self, t: usize) -> &str {
        self.typed[t]["region"].as_str().unwrap_or("")
    }

    pub fn markers(&self, t: usize) -> &[Value] {
        self.typed[t]["markers"].as_array().map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn spans(&self, t: usize) -> &[Value] {
        self.typed[t]["spans"].as_array().map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn members(&self, u: usize) -> Vec<usize> {
        numbers(&self.units[u]["lines"])
    }

    pub fn regions(&self, u: usize) -> BTreeSet<String> {
        self.members(u).into_iter().map(|t| self.region(t).to_owned()).collect()
    }

    pub fn unit_of(&self, t: usize) -> Option<usize> {
        (0..self.units.len()).find(|&u| self.units[u]["lines"].as_array().is_some_and(|lines| lines.iter().any(|line| line.as_u64() == Some(t as u64))))
    }

    /// Each unit's document type: its document's, given on the document's first unit.
    pub fn kinds(&self) -> Vec<Option<String>> {
        let mut kind = None;
        self.units.iter().map(|unit| {
            if let Some(given) = unit["document_type"].as_str() {
                kind = Some(given.to_owned());
            }
            kind.clone()
        }).collect()
    }

    pub fn unit_text(&self, unit: &Value) -> String {
        let said: Vec<String> = numbers(&unit["lines"]).iter().map(|&t| self.typed[t]["text"].as_str().unwrap_or("").trim_matches(super::words::is_space).to_owned()).collect();
        said.join(" ").trim_matches(super::words::is_space).to_owned()
    }

    /// The unit's printed markers' texts (a bullet is no number: only markers with a letter or digit).
    pub fn printed_markers(&self, unit: &Value) -> Vec<String> {
        let mut found = Vec::new();
        for t in numbers(&unit["lines"]) {
            for mark in self.markers(t) {
                let spans: Vec<&Value> = if mark.is_array() { mark.as_array().unwrap().iter().collect() } else { vec![mark] };
                let said: String = spans.iter().filter_map(|span| {
                    let line = self.line(span["line_id"].as_str()?)?;
                    Some(line.slice(span["start"].as_u64()? as usize, span["end"].as_u64()? as usize))
                }).collect();
                if said.chars().any(|c| c.is_alphanumeric()) {
                    found.push(said);
                }
            }
        }
        found
    }

    /// The text a marker prints, and its line.
    pub fn printed(&self, mark: &Value) -> Option<(String, &PageLine)> {
        let span = span_of(mark);
        let line = self.line(span["line_id"].as_str()?)?;
        Some((line.slice(span["start"].as_u64()? as usize, span["end"].as_u64()? as usize), line))
    }

    /// `entry` as typed line `at`, the lines after it moving along in the units and notes that name them.
    pub fn insert_typed(&mut self, at: usize, entry: Value) {
        self.typed.insert(at, entry);
        for unit in &mut self.units {
            unit["lines"] = json!(numbers(&unit["lines"]).into_iter().map(|t| t + (t >= at) as usize).collect::<Vec<_>>());
        }
        for pair in &mut self.notes {
            if let Some(line) = pair["line"].as_u64() {
                pair["line"] = json!(line + (line as usize >= at) as u64);
            }
        }
    }

    fn renumber_units(&mut self, order: Vec<usize>) {
        let moved: HashMap<usize, usize> = order.iter().enumerate().map(|(new, &old)| (old, new)).collect();
        let mut taken: Vec<Option<Value>> = std::mem::take(&mut self.units).into_iter().map(Some).collect();
        self.units = order.iter().map(|&old| taken[old].take().unwrap()).collect();
        for pair in &mut self.notes {
            if let Some(&new) = pair["note"].as_u64().and_then(|note| moved.get(&(note as usize))) {
                pair["note"] = json!(new);
            }
        }
    }

    /// Units in the order of their first typed lines, empty ones gone; the document's type stays on its first unit.
    pub fn in_order(&mut self) {
        // (Each unit's first typed line read once, not again for every comparison of the sort.)
        let first = |unit: &Value| unit["lines"].as_array().and_then(|lines| lines.iter().find_map(|line| line.as_u64()));
        let mut order: Vec<(u64, usize)> = self.units.iter().enumerate().filter_map(|(u, unit)| Some((first(unit)?, u))).collect();
        order.sort_by_key(|&(first, _)| first);
        let order: Vec<usize> = order.into_iter().map(|(_, u)| u).collect();
        let kind = self.units.iter().find_map(|unit| unit.get("document_type").cloned());
        self.renumber_units(order);
        if let Some(kind) = kind {
            for unit in &mut self.units {
                if let Some(map) = unit.as_object_mut() {
                    map.shift_remove("document_type");
                }
            }
            if let Some(first) = self.units.first_mut() {
                first["document_type"] = kind;
            }
        }
    }

    fn cut_unit(&mut self, u: usize, parts: Vec<Vec<usize>>) {
        let unit = self.units[u].clone();
        let rest: serde_json::Map<String, Value> = unit.as_object().unwrap().iter()
            .filter(|(key, _)| !matches!(key.as_str(), "lines" | "document_type" | "starts_document")).map(|(key, value)| (key.clone(), value.clone())).collect();
        let made: Vec<Value> = parts.into_iter().enumerate().map(|(i, part)| {
            let mut piece = if i == 0 { unit.clone() } else { let mut piece = Value::Object(rest.clone()); piece["starts_document"] = json!(false); piece };
            piece["lines"] = json!(part);
            piece
        }).collect();
        self.replace_units(u, u, made);
    }

    /// Units `from` to `to` replaced by `made`, the notes' pairs, which name units by place, moving with them: a pair naming a
    /// unit replaced names the first made (which holds the first replaced unit's first line), one naming a unit after its place now.
    pub fn replace_units(&mut self, from: usize, to: usize, made: Vec<Value>) {
        let count = made.len();
        self.units.splice(from..=to, made);
        for pair in &mut self.notes {
            if let Some(note) = pair["note"].as_u64().map(|note| note as usize) {
                let moved = if note > to { note + count - (to - from + 1) } else if note >= from { from } else { note };
                pair["note"] = json!(moved);
            }
        }
    }

    /// Typed line t alone in a unit of its own; the lines before and after it keep theirs.
    pub fn set_apart(&mut self, t: usize) {
        let Some(u) = self.unit_of(t) else { return };
        let lines = self.members(u);
        let k = lines.iter().position(|&line| line == t).unwrap();
        let parts: Vec<Vec<usize>> = [lines[..k].to_vec(), vec![t], lines[k + 1..].to_vec()].into_iter().filter(|part| !part.is_empty()).collect();
        self.cut_unit(u, parts);
    }

    /// The unit holding typed line t goes on as a new unit from t.
    pub fn split_at(&mut self, t: usize) {
        let Some(u) = self.unit_of(t) else { return };
        let lines = self.members(u);
        let k = lines.iter().position(|&line| line == t).unwrap();
        if k > 0 {
            self.cut_unit(u, vec![lines[..k].to_vec(), lines[k..].to_vec()]);
        }
    }

    /// The typed line a page line stands on, the first.
    pub fn typed_on(&self, id: &str) -> Option<usize> {
        (0..self.typed.len()).find(|&t| self.spans(t).iter().any(|span| span["line_id"] == id))
    }
}
