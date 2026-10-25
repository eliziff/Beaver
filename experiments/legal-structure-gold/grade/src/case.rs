//! The A2AJ case grammar (`legal_structure::case_outline`) read over a judgment's units, each
//! unit's words on a line of their own as the providers give a judgment: the outline's headings
//! (each at its depth among the headings), numbered paragraphs (under the heading they fall
//! within), list items (under their paragraph, or the item they continue) and a paragraph's
//! other lines (under it) become the units' parents and, with `--regions`, the regions of its
//! headings, paragraphs and items. Units are the parser's, or with `--units gold` the gold's
//! carried onto the parser's pieces. `structure-gold case` writes them as labels for
//! `grade --labels`.
use crate::labels::{self, Label, Piece, REGIONS};
use crate::state::{self, State};
use legal_pdf_core::read_gzip_json;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

/// Each piece's unit, named by the unit's first piece, as `labels::decode` joins them.
fn units(frame: &State, pieces: &[Piece], found: &[Label]) -> Vec<Option<usize>> {
    let mut unit_of = vec![None; pieces.len()];
    let mut open: [Option<usize>; 5] = [None; 5];
    let mut head_at: HashMap<String, usize> = HashMap::new();
    for (k, label) in found.iter().enumerate() {
        if label.region == 0 {
            continue;
        }
        let s = labels::stream(label.region);
        let resumed = (label.start == 2).then(|| label.continues.as_deref().and_then(|a| head_at.get(a).copied())).flatten();
        let u = match (label.start, resumed, open[s]) {
            (2, Some(u), _) => u,
            (0 | 2, _, Some(u)) if found[u].region == label.region => u,
            _ => {
                head_at.insert(labels::anchor(frame, &pieces[k]), k);
                k
            }
        };
        open[s] = Some(u);
        unit_of[k] = Some(u);
    }
    unit_of
}

/// A unit's words on one line: its pieces in reading order, a line's hyphen joining the word it
/// breaks.
fn words(frame: &State, pieces: &[Piece], members: &[usize]) -> String {
    let mut text = String::new();
    let mut last: Option<&Piece> = None;
    for &k in members {
        let p = &pieces[k];
        let own: String = frame.lines[p.line].text[p.start..p.end].iter().map(|c| if c.is_control() { ' ' } else { *c }).collect();
        let own = own.trim();
        if own.is_empty() {
            continue;
        }
        let touching = last.is_some_and(|q| q.line == p.line && q.end == p.start);
        if !text.is_empty() && !touching {
            let broken = text.ends_with('-') && text[..text.len() - 1].ends_with(|c: char| c.is_lowercase()) && own.starts_with(|c: char| c.is_lowercase());
            if broken {
                text.pop();
            } else {
                text.push(' ');
            }
        }
        text.push_str(own);
        last = Some(p);
    }
    text
}

/// The labels with each main-stream unit's parent (and with `regions`, its region) read from the
/// case grammar's outline of the units.
fn outline(frame: &State, pieces: &[Piece], found: &[Label], regions: bool, show: bool) -> Result<Vec<Label>, String> {
    let unit_of = units(frame, pieces, found);
    let mut members: HashMap<usize, Vec<usize>> = HashMap::new();
    for (k, u) in unit_of.iter().enumerate() {
        if let Some(u) = u {
            members.entry(*u).or_default().push(k);
        }
    }
    let mut heads: Vec<usize> = members.keys().copied().filter(|&u| labels::stream(found[u].region) == 0).collect();
    heads.sort_unstable();
    // The units, a line each, and where each opens and closes in UTF-16 code units.
    let mut text = String::new();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut at = 0;
    for u in &heads {
        let line = words(frame, pieces, &members[u]);
        let length = line.encode_utf16().count();
        spans.push((at, at + length));
        text.push_str(&line);
        text.push('\n');
        at += length + 1;
    }
    let entries = legal_structure::case_outline(&text).map_err(|e| e.to_string())?;
    // Each unit's first entry.
    let mut first: Vec<Option<&legal_structure::CaseOutlineEntry>> = vec![None; heads.len()];
    for entry in &entries {
        let n = spans.partition_point(|&(start, _)| start <= entry.start).saturating_sub(1);
        if spans.get(n).is_some_and(|&(start, end)| start <= entry.start && entry.start <= end) && first[n].is_none() {
            first[n] = Some(entry);
        }
    }
    let mut result: Vec<Label> = found.to_vec();
    for label in result.iter_mut() {
        label.parent = None;
    }
    let mut headings: Vec<(usize, usize)> = Vec::new();
    let mut paragraph: Option<usize> = None;
    let mut items: Vec<usize> = Vec::new();
    let mut body = false;
    for (n, &u) in heads.iter().enumerate() {
        let top = headings.last().map(|h| h.0);
        let (parent, region) = match first[n] {
            Some(e) if e.kind == "heading" => {
                while headings.last().is_some_and(|h| h.1 >= e.level) {
                    headings.pop();
                }
                let p = headings.last().map(|h| h.0);
                headings.push((u, e.level));
                (paragraph, body) = (None, true);
                items.clear();
                (p, Some("heading"))
            }
            Some(e) if e.kind == "paragraph" => {
                (paragraph, body) = (Some(u), true);
                items.clear();
                (top, Some("text"))
            }
            Some(e) if e.kind == "item" => {
                items.truncate(e.level.max(1) - 1);
                let p = items.last().copied().or(paragraph).or(top);
                items.push(u);
                (p, Some("list_item"))
            }
            // A paragraph's other line: a passage it quotes, or its words after a list.
            Some(e) if e.level == 1 => (paragraph.or(top), None),
            // The matter before the reasons stands alone; lines among them fall within a heading.
            _ => ((body).then_some(top).flatten(), None),
        };
        result[u].parent = parent.map(|p| labels::anchor(frame, &pieces[p]));
        if show {
            let head = |anchor: Option<&str>| {
                let k = anchor.and_then(|a| (0..pieces.len()).find(|&k| labels::anchor(frame, &pieces[k]) == a));
                k.and_then(|k| heads.iter().position(|&h| h == k)).map_or("root".to_owned(), |n| format!("#{n}"))
            };
            let entry = first[n].map_or("-".to_owned(), |e| format!("{}{} {}", e.kind, e.level, e.label));
            let own: String = text.lines().nth(n).unwrap_or_default().chars().take(70).collect();
            let wanted = head(found[u].parent.as_deref());
            let chosen = head(result[u].parent.as_deref());
            println!("#{n:<4} {:10} {:14} gold {:>6} case {:>6}{} {own}", REGIONS[found[u].region], entry, wanted, chosen,
                     if wanted == chosen { " " } else { "*" });
        }
        if let (true, Some(name)) = (regions, region) {
            let r = REGIONS.iter().position(|v| *v == name).unwrap();
            for &k in &members[&u] {
                result[k].region = r;
            }
        }
    }
    Ok(result)
}

/// `structure-gold case GOLD MANIFEST --out FILE [--split S] [--genre FOLDER] [--units parser|gold]
/// [--regions]`: the case grammar's parents over each selected source's units, as labels.
pub fn run(gold: &Path, manifest: &Path, options: &[String]) -> Result<(), String> {
    let value = |name: &str| options.iter().position(|o| o == name).and_then(|n| options.get(n + 1)).cloned();
    let split = value("--split").unwrap_or_else(|| "development".into());
    if split == "test" {
        return Err("The test split is read once, at the end".into());
    }
    let genre = value("--genre");
    let gold_units = value("--units").as_deref() == Some("gold");
    let regions = options.iter().any(|o| o == "--regions");
    // The units' own parents, without the grammar: with --units gold, the parser frame's ceiling.
    let keep = options.iter().any(|o| o == "--keep");
    let out = value("--out").ok_or("--out FILE is required")?;
    let all: Vec<crate::Source> = crate::sources(gold, manifest)?
        .into_iter()
        .filter(|s| s.split == split)
        .filter(|s| genre.as_ref().is_none_or(|g| s.pdf.to_string_lossy().replace('\\', "/").contains(&format!("/{g}/"))))
        .collect();
    let started = std::time::Instant::now();
    let weight = |s: &crate::Source| std::fs::metadata(crate::inputs_dir(gold).join(format!("{}.json.gz", s.sha256))).map_or(0, |m| m.len());
    let results = crate::parallel(&all, weight, |source| -> Result<String, String> {
        let extracted: legalpdf::ExtractedPdf = read_gzip_json(&crate::inputs_dir(gold).join(format!("{}.json.gz", source.sha256)))
            .map_err(|e| format!("{}: {e}", source.sha256))?;
        let mut pages = Vec::new();
        let document = legalpdf::gold_structure_document(extracted, &source.sha256, Some(&mut pages)).map_err(|e| format!("{}: {e}", source.sha256))?;
        let boxes: Vec<state::ExtractionPage> = pages.iter().map(|p| state::ExtractionPage {
            width: p.width, height: p.height, lines: p.lines.iter().map(|l| (l.id.clone(), l.bbox)).collect(),
        }).collect();
        let candidate = state::parsed(document.structure(), &boxes)?;
        let parsed_regions = labels::parsed_regions(&candidate);
        let (pieces, tier0) = labels::labels(&candidate, &|p| parsed_regions.of(p))?;
        let found = if gold_units {
            let expected: state::Gold = read_gzip_json(&gold.join("v4").join(&source.sha256).join("gold.json.gz")).map_err(|e| e.to_string())?;
            let reference = state::projected(&expected)?;
            let gold_regions = labels::gold_regions(&expected, &reference);
            let (gold_pieces, wanted) = labels::labels(&reference, &|p| gold_regions.of(p))?;
            let alignment = crate::alignment::align(&reference, &candidate)?;
            labels::carry(&reference, &gold_pieces, &wanted, &candidate, &pieces, &alignment).into_iter().map(Option::unwrap_or_default).collect()
        } else {
            tier0
        };
        let show = value("--show").is_some_and(|prefix| source.sha256.starts_with(&prefix));
        let assigned = if keep { found } else { outline(&candidate, &pieces, &found, regions, show)? };
        let ids: Vec<String> = pieces.iter().map(|p| labels::anchor(&candidate, p)).collect();
        let row_of: HashMap<&str, usize> = ids.iter().enumerate().map(|(k, id)| (id.as_str(), k)).collect();
        let pointer = |a: &Option<String>| a.as_deref().and_then(|a| row_of.get(a)).map_or(-1, |&k| k as i64);
        let rows: Vec<Value> = assigned.iter().map(|l| json!([l.region, l.start, l.relation, u8::from(l.document), u8::from(l.reference), pointer(&l.parent), pointer(&l.continues)])).collect();
        Ok(json!({"sha256": source.sha256, "ids": ids, "labels": rows}).to_string())
    });
    let mut file = std::io::BufWriter::new(std::fs::File::create(&out).map_err(|e| format!("{out}: {e}"))?);
    let mut failed = 0;
    for result in results {
        match result {
            Ok(line) => writeln!(file, "{line}").map_err(|e| e.to_string())?,
            Err(error) => {
                failed += 1;
                eprintln!("ERROR {error}");
            }
        }
    }
    eprintln!("{} {split} documents, {failed} failed, in {:.1}s -> {out}", all.len(), started.elapsed().as_secs_f64());
    Ok(())
}
