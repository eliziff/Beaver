//! Each unit's parent, chosen in reading order among the open units on the right-most branch of
//! the tree built so far, as Detect-Order-Construct inserts headings (Wang et al., 2024): every
//! unit attaches under one unit of that branch, or under the document, and becomes its newest
//! child. A ranker scores the candidates from witnesses of each pair: numbering (a family
//! continued, a dotted prefix extended), type (the document's own heading ladder, the style of the
//! candidate's newest child), heading keywords (Part, Chapter, Section), lead-ins, regions, and the
//! parser's own choice. `structure-gold tree` writes training pairs over the gold's units and tree,
//! and decodes with a LightGBM model (its JSON dump) into labels for `grade --labels`.
use crate::assemble::Rows;
use legal_structure::LayoutAnalysis;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::OnceLock;

/// The parser's witnesses of a unit's first line the ranker reads (zero where the rows lack them).
const WITNESSES: [&str; 30] = [
    "w_counted", "w_backbone", "w_in_contents", "w_citation", "w_reader_heading", "w_style_rank", "w_style_lines", "w_body_style",
    "w_lead_in", "w_court", "w_party", "w_address", "w_defined_term", "w_dot_leader", "w_marker_only", "w_repeats", "w_own_font",
    "w_caps", "w_tag_heading", "w_tag_title", "w_tag_list", "w_tag_paragraph", "w_tag_quotation", "w_layout_title", "w_quoted",
    "w_form_title", "w_known_court", "w_m_word", "w_gap_above", "w_gap_below",
];

fn witness(doc: &Rows, row: usize, name: &str) -> f64 {
    static COLUMNS: OnceLock<HashMap<String, usize>> = OnceLock::new();
    let columns = COLUMNS.get_or_init(|| crate::rows::feature_names().into_iter().enumerate().map(|(k, n)| (n, k)).collect());
    columns.get(name).and_then(|&c| doc.features[row].get(c)).copied().unwrap_or(0.0)
}

const UNRANKED: [usize; 6] = [0, 5, 7, 10, 11, 12];
const HEADING: usize = 3;
const KEYWORDS: [(&str, f64); 18] = [
    ("book", 0.0), ("part", 1.0), ("title", 1.0), ("chapter", 2.0), ("division", 3.0), ("subdivision", 4.0),
    ("article", 5.0), ("section", 5.0), ("rule", 5.0), ("subsection", 6.0), ("paragraph", 7.0), ("item", 6.0),
    ("schedule", 1.0), ("appendix", 1.0), ("annex", 1.0), ("exhibit", 1.0), ("tab", 1.0), ("form", 1.0),
];

/// Region classes the features name: text, list item, heading, quote, table, caption, headnote, other.
fn class(region: usize) -> usize {
    match region {
        1 => 0,
        2 => 1,
        3 => 2,
        4 => 3,
        6 => 4,
        8 => 5,
        9 => 6,
        _ => 7,
    }
}

#[derive(Clone)]
struct Mark {
    family: String,
    count: f64,
    wrap: f64,
    ordinal: u32,
    prefix: Vec<u32>,
}

struct Unit {
    row: usize,
    region: usize,
    size: f64,
    bold: f64,
    italic: f64,
    upper: f64,
    centre: f64,
    indent: f64,
    underlined: f64,
    colon: f64,
    period: f64,
    length: f64,
    page: f64,
    mark: Option<Mark>,
    keyword: f64,
    sig: (i64, i64, i64, i64, i64),
    ladder: f64,
    witnesses: Vec<f64>,
    last: usize,
    /// The parser's level for the heading (0: none), whether its bookmark names it, at the top or
    /// under the heading starting at `nav_parent` (a row, or -1).
    level: f64,
    nav: f64,
    nav_root: f64,
    nav_parent: i64,
}

impl Unit {
    fn w(&self, name: &str) -> f64 {
        WITNESSES.iter().position(|n| *n == name).map_or(0.0, |k| self.witnesses[k])
    }
}

/// A unit's leading enumerator (after a heading keyword: "PART II", "Section 3.") and the keyword's
/// rank. A bare letter counts only standing alone ("I", "A"), never as a sentence's first word.
fn mark_and_keyword(text: &str) -> (Option<Mark>, f64) {
    let text = text.trim();
    let mut words = text.split_whitespace();
    let Some(first) = words.next() else { return (None, -1.0) };
    let bare = first.trim_end_matches(['.', ':']).to_lowercase();
    let keyword = KEYWORDS.iter().find(|(k, _)| *k == bare).map_or(-1.0, |(_, r)| *r);
    let token = if keyword >= 0.0 { words.next() } else { Some(first) };
    let mark = token.filter(|t| {
        t.ends_with(['.', ')', ':']) || t.starts_with(['(', '[']) || t.chars().all(|c| c.is_ascii_digit() || c == '.')
            || *t == text || keyword >= 0.0
    }).and_then(|t| legal_structure::STRUCTURE_ANALYSIS.numbering_marker(t, None)).map(|m| {
        let (wrap, count) = m.family.split_once(':').unwrap_or(("", m.family.as_str()));
        Mark {
            count: match count { "1" => 1.0, "A" => 2.0, "a" => 3.0, "I" => 4.0, "i" => 5.0, _ => 6.0 },
            wrap: if wrap.contains('(') { 1.0 } else if wrap.contains(')') { 2.0 } else if wrap.contains('.') { 3.0 } else if wrap.contains('[') { 4.0 } else { 5.0 },
            family: m.family.clone(),
            ordinal: m.ordinal,
            prefix: m.prefix.clone(),
        }
    });
    (mark, keyword)
}

/// The units a document's labels start (region, start per row), with their evidence; headings
/// ranked on the document's own ladder of heading types, most prominent first.
fn units(doc: &Rows, labels: &[Vec<i64>]) -> Vec<Unit> {
    let n = labels.len();
    let mut last: HashMap<usize, usize> = HashMap::new();
    let mut open: HashMap<i64, usize> = HashMap::new();
    for r in 0..n {
        let (region, start) = (labels[r][0], labels[r][1]);
        if region <= 0 {
            continue;
        }
        if start == 1 {
            open.insert(region, r);
            last.insert(r, r);
        } else if let Some(&u) = open.get(&region) {
            last.insert(u, r);
        }
    }
    let mut found: Vec<Unit> = (0..n).filter(|&r| labels[r][0] > 0 && labels[r][1] == 1).map(|r| {
        let f = |name: &str| doc.f(r, name);
        let end = last.get(&r).copied().unwrap_or(r);
        let (mark, keyword) = mark_and_keyword(&doc.text[r]);
        let (size, bold, upper, centre, italic) = (f("size"), f("bold"), f("upper"), f("centre"), f("italic"));
        Unit {
            row: r,
            region: labels[r][0] as usize,
            size, bold, italic, upper,
            centre: centre.abs(),
            indent: f("indent"),
            underlined: f("underlined"),
            colon: doc.f(end, "ends_colon"),
            period: doc.f(end, "ends_period"),
            length: f("length"),
            page: f("page_position"),
            mark,
            keyword,
            sig: ((size * 10.0).round() as i64, i64::from(bold > 0.5), i64::from(upper > 0.6), i64::from(centre.abs() < 0.04), i64::from(italic > 0.5)),
            ladder: -1.0,
            witnesses: WITNESSES.iter().map(|name| witness(doc, r, name)).collect(),
            last: end,
            level: witness(doc, r, "o_level"),
            nav: witness(doc, r, "o_nav"),
            nav_root: witness(doc, r, "o_nav_root"),
            nav_parent: doc.navigation.get(r).copied().unwrap_or(-1),
        }
    }).collect();
    let mut ladder: Vec<(i64, i64, i64, i64, i64)> = found.iter().filter(|u| u.region == HEADING).map(|u| u.sig).collect();
    ladder.sort_by_key(|s| (-s.0, -s.2, -s.1, -s.3, -s.4));
    ladder.dedup();
    for u in found.iter_mut().filter(|u| u.region == HEADING) {
        u.ladder = ladder.iter().position(|s| *s == u.sig).unwrap_or(0) as f64;
    }
    found
}

fn same_family(a: &Unit, b: &Unit) -> bool {
    matches!((&a.mark, &b.mark), (Some(x), Some(y)) if x.family == y.family && x.prefix.len() == y.prefix.len())
}

/// `a` goes on with `b`'s count: "3." after "2.", "(c)" after "(b)", "2.4" after "2.3".
fn continues(a: &Unit, b: &Unit) -> bool {
    matches!((&a.mark, &b.mark), (Some(x), Some(y)) if x.family == y.family && x.prefix == y.prefix && x.ordinal == y.ordinal + 1)
}

/// `a`'s dotted number opens under `b`'s: "2.1" under "2.", "2.3.1" under "2.3".
fn extends(a: &Unit, b: &Unit) -> bool {
    matches!((&a.mark, &b.mark), (Some(x), Some(y)) if !x.prefix.is_empty() && x.prefix.len() == y.prefix.len() + 1
        && x.prefix[..y.prefix.len()] == y.prefix[..] && x.prefix[y.prefix.len()] == y.ordinal)
}

fn compare(a: f64, b: f64) -> f64 {
    if a < 0.0 || b < 0.0 { -9.0 } else { a - b }
}

pub const NAMES: [&str; 79] = [
    "root", "up", "depth", "branch",
    "u_text", "u_list", "u_heading", "u_quote", "u_table", "u_caption", "u_headnote", "u_other",
    "v_text", "v_list", "v_heading", "v_quote", "v_table", "v_caption", "v_headnote", "v_other",
    "c_text", "c_list", "c_heading", "c_quote", "c_table", "c_caption", "c_headnote", "c_other",
    "c_exists",
    "u_size", "u_bold", "u_italic", "u_upper", "u_centre", "u_indent", "u_underlined", "u_colon", "u_period", "u_length",
    "u_marked", "u_count", "u_wrap", "u_ordinal", "u_dotted", "u_keyword", "u_ladder",
    "v_size_diff", "v_bold", "v_upper", "v_centre", "v_indent_diff", "v_colon", "v_marked", "v_keyword", "v_ladder",
    "sig_v", "family_v", "continues_v", "keyword_v", "ladder_v", "extends_v",
    "sig_c", "family_c", "continues_c", "region_c", "c_size_diff", "c_indent_diff", "ladder_c",
    "family_below", "family_above", "parser_says", "distance", "u_page",
    "deepest_heading", "headings_below", "heading_sig_below", "heading_sig_above", "last_text_colon", "region_v",
];

/// The features of `u` under candidate `v` (None: the document) at branch position `at`, `branch`
/// holding the open units from the outermost; `c` is `v`'s newest child on the branch.
fn pair(us: &[Unit], u: usize, branch: &[usize], at: Option<usize>, parser_parent: i64) -> Vec<f64> {
    let unit = &us[u];
    let v = at.map(|i| &us[branch[i]]);
    let c_at = at.map_or(0, |i| i + 1);
    let c = branch.get(c_at).map(|&k| &us[k]);
    let below = &branch[c_at.min(branch.len())..];
    let above = &branch[..c_at.min(branch.len())];
    let onehot = |x: Option<&Unit>| -> [f64; 8] {
        let mut h = [0.0; 8];
        if let Some(x) = x {
            h[class(x.region)] = 1.0;
        }
        h
    };
    let mut x = Vec::with_capacity(NAMES.len());
    x.extend([f64::from(u8::from(v.is_none())), (branch.len() - c_at) as f64, c_at as f64, branch.len() as f64]);
    x.extend(onehot(Some(unit)));
    x.extend(onehot(v));
    x.extend(onehot(c));
    x.push(f64::from(u8::from(c.is_some())));
    let m = unit.mark.as_ref();
    x.extend([unit.size, unit.bold, unit.italic, unit.upper, unit.centre, unit.indent, unit.underlined, unit.colon, unit.period, unit.length,
        f64::from(u8::from(m.is_some())), m.map_or(0.0, |m| m.count), m.map_or(0.0, |m| m.wrap),
        m.map_or(0.0, |m| (1.0 + f64::from(m.ordinal)).ln()), m.map_or(0.0, |m| m.prefix.len() as f64), unit.keyword, unit.ladder]);
    match v {
        Some(v) => x.extend([v.size - unit.size, v.bold, v.upper, v.centre, unit.indent - v.indent, v.colon, f64::from(u8::from(v.mark.is_some())),
            v.keyword, v.ladder, f64::from(u8::from(v.sig == unit.sig)), f64::from(u8::from(same_family(unit, v))),
            f64::from(u8::from(continues(unit, v))), compare(unit.keyword, v.keyword), compare(unit.ladder, v.ladder),
            f64::from(u8::from(extends(unit, v)))]),
        None => x.extend([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, -1.0, 0.0, 0.0, 0.0, -9.0, -9.0, 0.0]),
    }
    match c {
        Some(c) => x.extend([f64::from(u8::from(c.sig == unit.sig)), f64::from(u8::from(same_family(unit, c))),
            f64::from(u8::from(continues(unit, c))), f64::from(u8::from(c.region == unit.region)), c.size - unit.size,
            unit.indent - c.indent, compare(unit.ladder, c.ladder)]),
        None => x.extend([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -9.0]),
    }
    let family_in = |part: &[usize]| f64::from(u8::from(part.iter().any(|&k| same_family(unit, &us[k]))));
    x.extend([family_in(below), family_in(above)]);
    x.push(f64::from(u8::from(v.map_or(parser_parent < 0, |v| parser_parent == v.row as i64))));
    x.push(v.map_or(0.0, |v| ((unit.row - v.row) as f64 + 1.0).ln()));
    x.push(unit.page);
    let headings_below = below.iter().filter(|&&k| us[k].region == HEADING).count();
    x.push(f64::from(u8::from(v.is_some_and(|v| v.region == HEADING) && headings_below == 0)));
    x.push(headings_below as f64);
    let sig_in = |part: &[usize]| f64::from(u8::from(part.iter().any(|&k| us[k].region == HEADING && us[k].sig == unit.sig)));
    x.extend([sig_in(below), sig_in(above)]);
    x.push(branch.last().map_or(0.0, |&k| us[k].colon));
    x.push(v.map_or(-1.0, |v| v.region as f64));
    // The parser's witnesses: the unit's own, and its style rank, backbone and contents beside the
    // candidate's and the candidate's newest child's.
    x.extend(unit.witnesses.iter().copied());
    let rank = |a: &Unit| a.w("w_style_rank");
    let both = |a: &Unit, name: &str| f64::from(u8::from(unit.w(name) > 0.0 && a.w(name) > 0.0));
    x.extend([v.map_or(-9.0, |v| rank(unit) - rank(v)), c.map_or(-9.0, |c| rank(unit) - rank(c)),
        v.map_or(0.0, |v| both(v, "w_backbone")), c.map_or(0.0, |c| both(c, "w_backbone")), v.map_or(0.0, |v| both(v, "w_in_contents"))]);
    // The parser's outline evidence: its heading levels beside the candidate's and the newest
    // child's, and the bookmark naming the unit's parent (or the top).
    let level = |a: &Unit| if unit.level > 0.0 && a.level > 0.0 { unit.level - a.level } else { -9.0 };
    x.extend([unit.level, unit.nav, v.map_or(-9.0, level), c.map_or(-9.0, level),
        v.map_or(0.0, |v| f64::from(u8::from(unit.nav_parent >= v.row as i64 && unit.nav_parent <= v.last as i64))),
        f64::from(u8::from(unit.nav_root > 0.0 && v.is_none())), v.map_or(0.0, |v| v.nav)]);
    debug_assert_eq!(x.len(), names().len());
    x
}

/// Every feature's name, in the order `pair` writes them.
pub fn names() -> Vec<String> {
    NAMES.iter().map(|n| n.to_string())
        .chain(WITNESSES.iter().map(|n| format!("u_{n}")))
        .chain(["style_rank_v", "style_rank_c", "backbone_v", "backbone_c", "contents_v"].map(str::to_owned))
        .chain(["u_level", "u_nav", "level_v", "level_c", "nav_v", "nav_root", "v_nav"].map(str::to_owned))
        .collect()
}

/// Each row's unit, by the row its unit starts on: a piece opening a unit starts it, one inside
/// goes on with the unit open in its region, one resuming joins the unit it names.
fn membership(labels: &[Vec<i64>]) -> Vec<Option<usize>> {
    let mut member = vec![None; labels.len()];
    let mut open: HashMap<i64, usize> = HashMap::new();
    for r in 0..labels.len() {
        let (region, start) = (labels[r][0], labels[r][1]);
        if region <= 0 {
            continue;
        }
        member[r] = match start {
            1 => {
                open.insert(region, r);
                Some(r)
            }
            2 => labels[r].get(6).filter(|&&c| c >= 0).and_then(|&c| member[c as usize]).or_else(|| open.get(&region).copied()),
            _ => open.get(&region).copied(),
        };
    }
    member
}

/// Each unit's parent in the gold's tree, carried onto these units: the unit holding the first piece
/// of the gold parent of the gold unit its first piece belongs to (`Some(None)`: the document;
/// `None`: the gold gives it none among these units).
fn targets(doc: &Rows, labels: &[Vec<i64>], us: &[Unit]) -> Vec<Option<Option<usize>>> {
    let gold: Vec<Vec<i64>> = doc.gold.iter().map(|g| g.clone().unwrap_or_else(|| vec![0, 0, 0, 0, 0, -1, -1])).collect();
    let gold_member = membership(&gold);
    let member = membership(labels);
    let index: HashMap<usize, usize> = us.iter().enumerate().map(|(k, u)| (u.row, k)).collect();
    us.iter().enumerate().map(|(k, u)| {
        let head = gold_member[u.row]?;
        let parent = gold[head][5];
        if parent < 0 {
            return Some(None);
        }
        let t = member[parent as usize].and_then(|row| index.get(&row).copied())?;
        (t != k && !UNRANKED.contains(&us[t].region)).then_some(Some(t))
    }).collect()
}

/// A LightGBM model from its JSON dump, its trees flattened.
struct Model(Vec<Vec<(i32, f64, usize, usize, f64, bool)>>);

impl Model {
    fn load(path: &str) -> Result<Model, String> {
        let dump: Value = serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?).map_err(|e| e.to_string())?;
        fn flatten(node: &Value, out: &mut Vec<(i32, f64, usize, usize, f64, bool)>) -> usize {
            let at = out.len();
            if let Some(value) = node.get("leaf_value").and_then(Value::as_f64) {
                out.push((-1, 0.0, 0, 0, value, false));
                return at;
            }
            out.push((node["split_feature"].as_i64().unwrap_or(0) as i32, node["threshold"].as_f64().unwrap_or(0.0), 0, 0, 0.0,
                node["default_left"].as_bool().unwrap_or(true)));
            let left = flatten(&node["left_child"], out);
            let right = flatten(&node["right_child"], out);
            out[at].2 = left;
            out[at].3 = right;
            at
        }
        let trees = dump["tree_info"].as_array().ok_or("No tree_info in the model dump")?.iter().map(|t| {
            let mut out = Vec::new();
            flatten(&t["tree_structure"], &mut out);
            out
        }).collect();
        Ok(Model(trees))
    }

    fn score(&self, x: &[f64]) -> f64 {
        self.0.iter().map(|tree| {
            let mut at = 0;
            loop {
                let (feature, threshold, left, right, value, default_left) = tree[at];
                if feature < 0 {
                    return value;
                }
                let v = x[feature as usize];
                at = if v.is_nan() { if default_left { left } else { right } } else if v <= threshold { left } else { right };
            }
        }).sum()
    }
}

fn read_labels(path: &str) -> Result<HashMap<String, Vec<Vec<i64>>>, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?.lines().filter(|l| !l.trim().is_empty()).map(|l| {
        let row: Value = serde_json::from_str(l).map_err(|e| e.to_string())?;
        let labels = row["labels"].as_array().into_iter().flatten()
            .map(|v| v.as_array().into_iter().flatten().map(|x| x.as_i64().unwrap_or(0)).collect()).collect();
        Ok((row["sha256"].as_str().unwrap_or_default().to_owned(), labels))
    }).collect()
}

/// `structure-gold tree ROWS_DIR SPLIT --pairs FILE`: the gold's units with each one's candidates
/// on the gold tree's branch (CSV: unit, chosen, features); `--model FILE --out FILE [--units
/// gold|tier0|LABELS]`: parents decoded over the units, written as labels.
pub fn run(rows_dir: &Path, split: &str, options: &[String]) -> Result<(), String> {
    let value = |name: &str| options.iter().position(|o| o == name).and_then(|n| options.get(n + 1)).cloned();
    let file = std::fs::File::open(rows_dir.join(format!("rows-{split}.jsonl"))).map_err(|e| e.to_string())?;
    let source = value("--units").unwrap_or_else(|| "gold".into());
    let given = if source != "gold" && source != "tier0" { read_labels(&source)? } else { HashMap::new() };
    let labels_of = |doc: &Rows| -> Result<Vec<Vec<i64>>, String> {
        Ok(match source.as_str() {
            "gold" => doc.gold.iter().map(|g| g.clone().unwrap_or_else(|| vec![0, 0, 0, 0, 0, -1, -1])).collect(),
            "tier0" => doc.tier0.clone(),
            _ => given.get(&doc.sha256).cloned().ok_or_else(|| format!("{} has no labels", doc.sha256))?,
        })
    };
    if let Some(path) = value("--pairs") {
        let mut out = std::io::BufWriter::new(std::fs::File::create(&path).map_err(|e| e.to_string())?);
        writeln!(out, "unit,chosen,{}", names().join(",")).map_err(|e| e.to_string())?;
        let (mut group, mut skipped, mut asked) = (0usize, 0usize, 0usize);
        for line in std::io::BufReader::new(file).lines() {
            let doc = Rows::read(&line.map_err(|e| e.to_string())?)?;
            let labels = labels_of(&doc)?;
            let us = units(&doc, &labels);
            let ranked: Vec<usize> = (0..us.len()).filter(|&k| !UNRANKED.contains(&us[k].region)).collect();
            let wanted = targets(&doc, &labels, &us);
            let parent_of = |k: usize| -> Option<usize> { wanted[k].flatten() };
            for &k in &ranked {
                asked += 1;
                // The branch the gold tree leaves open before this unit: the previous unit's ancestors.
                let mut branch = Vec::new();
                let mut at = ranked.iter().take_while(|&&q| q != k).last().copied();
                while let Some(q) = at.filter(|q| !branch.contains(q) && branch.len() < 64) {
                    branch.push(q);
                    at = parent_of(q);
                }
                branch.reverse();
                let chosen = match wanted[k] {
                    Some(None) => Some(None),
                    Some(Some(p)) => branch.iter().position(|&q| q == p).map(Some),
                    None => None,
                };
                let Some(chosen) = chosen else {
                    skipped += 1;
                    continue;
                };
                let parser_parent = doc.tier0[us[k].row].get(5).copied().unwrap_or(-1);
                for candidate in std::iter::once(None).chain((0..branch.len()).map(Some)) {
                    let x = pair(&us, k, &branch, candidate, parser_parent);
                    write!(out, "{group},{}", u8::from(candidate == chosen)).map_err(|e| e.to_string())?;
                    for v in x {
                        write!(out, ",{}", (v * 1e4).round() / 1e4).map_err(|e| e.to_string())?;
                    }
                    writeln!(out).map_err(|e| e.to_string())?;
                }
                group += 1;
            }
        }
        eprintln!("{split}: {group} units written, {skipped} of {asked} skipped (gold parent off the branch or unranked)");
        return Ok(());
    }
    let model = Model::load(&value("--model").ok_or("--model FILE (or --pairs FILE)")?)?;
    let mut out = value("--out").map(|p| std::fs::File::create(p).map(std::io::BufWriter::new)).transpose().map_err(|e| e.to_string())?;
    let (mut right, mut asked) = (0usize, 0usize);
    let mut per_doc: Vec<f64> = Vec::new();
    for line in std::io::BufReader::new(file).lines() {
        let doc = Rows::read(&line.map_err(|e| e.to_string())?)?;
        let labels = labels_of(&doc)?;
        let us = units(&doc, &labels);
        let mut parent = vec![-1i64; labels.len()];
        let mut branch: Vec<usize> = Vec::new();
        for k in (0..us.len()).filter(|&k| !UNRANKED.contains(&us[k].region)) {
            let parser_parent = doc.tier0[us[k].row].get(5).copied().unwrap_or(-1);
            let (mut best, mut choice) = (f64::NEG_INFINITY, None);
            for candidate in std::iter::once(None).chain((0..branch.len()).map(Some)) {
                let s = model.score(&pair(&us, k, &branch, candidate, parser_parent));
                if s > best {
                    best = s;
                    choice = candidate;
                }
            }
            match choice {
                Some(i) => {
                    parent[us[k].row] = us[branch[i]].row as i64;
                    branch.truncate(i + 1);
                }
                None => branch.clear(),
            }
            branch.push(k);
        }
        let (mut doc_right, mut doc_asked) = (0usize, 0usize);
        for (r, g) in doc.gold.iter().enumerate() {
            let Some(g) = g else { continue };
            if g[1] != 1 || g[0] <= 0 || UNRANKED.contains(&(g[0] as usize)) || labels[r][1] != 1 {
                continue;
            }
            doc_asked += 1;
            doc_right += usize::from(parent[r] == g[5]);
        }
        right += doc_right;
        asked += doc_asked;
        if doc_asked >= 10 {
            per_doc.push(doc_right as f64 / doc_asked as f64);
        }
        if let Some(out) = out.as_mut() {
            let rows: Vec<Value> = labels.iter().enumerate().map(|(r, l)| {
                let mut l = l.clone();
                l.resize(7, -1);
                l[5] = parent[r];
                json!(l)
            }).collect();
            writeln!(out, "{}", json!({"sha256": doc.sha256, "ids": doc.ids, "labels": rows})).map_err(|e| e.to_string())?;
        }
    }
    per_doc.sort_by(f64::total_cmp);
    let q = |p: f64| per_doc.get(((per_doc.len().max(1) - 1) as f64 * p) as usize).copied().unwrap_or(0.0);
    println!("{split} ({source} units): {} documents with 10+ units: quartiles {:.3} / median {:.3} / {:.3}; pooled {:.3} over {asked} units",
             per_doc.len(), q(0.25), q(0.5), q(0.75), right as f64 / asked.max(1) as f64);
    Ok(())
}
