//! The fit's training data, whole: every pack Detect-Order-Construct steps on, written once from the dump's documents
//! (the parser's arrays and the grader's targets, `labels`), so the fit maps each pack's file and trains. What a pack
//! is: its documents' lines, templates, regions (each document's padded to whole Order blocks), region pairs and trees
//! laid end to end, each one's indexes past the documents before it, no attention, pair or tree crossing documents;
//! each line once, as the parser writes it (its own features as bytes, its tokens, box, size, page and t0), what DOC
//! reads of the lines around it, of every two lines or regions and of a tree's node pairs made in the step; each head's
//! weight on a line or region one over its document's count of them; the pages in batches of like length with each
//! line's gold link as a place in its batch's row; the Order stage's block window. The epochs' plan (every gold and
//! window pack, a rotating share of the silver, the giants every few epochs) is the manifest's.

use legalpdf::tensors::{self, Tensor};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

const BLOCK: usize = 64;
const HEADING: i64 = 3;
const LINE_HEADS: [&str; 5] = ["role", "marked", "start", "successor", "predecessor"];
const STAGES: [&str; 5] = ["detect", "templates", "order", "headings", "bodies"];
const TREE_INPUTS: [&str; 11] = ["templates", "anchors", "family", "value", "prefix", "section", "x0", "size", "looks", "pages", "roles"];
/// A pack file's layout: a change to what a pack holds bumps it, so the kept packs are written again.
const LAYOUT: u32 = 1;

/// The stages each head reads: a head is fitted where any of its stages is.
fn head_stages(head: &str) -> &'static [&'static str] {
    match head {
        "role" | "marked" | "start" | "successor" | "predecessor" => &["detect", "templates"],
        "goes_on" | "note_of" | "order" => &["detect", "templates", "order"],
        "heading" => &["detect", "templates", "order", "headings"],
        _ => &["detect", "templates", "order", "bodies"],
    }
}

const HEADS: [&str; 10] = ["role", "marked", "start", "successor", "predecessor", "goes_on", "note_of", "order", "heading", "body"];

/// What the fit is packed for: its packs' sizes, the giants' windows, the screening share, the stages fitted, the epochs
/// and their silver share and giants' rhythm.
pub struct Options {
    pub pack_docs: usize,
    pub pack_lines: usize,
    pub window_lines: usize,
    pub buckets: bool,
    pub sample: f64,
    pub train: Vec<String>,
    /// The text model the dump embeds each line's text with (its folder), named in the manifest for the fit's export.
    pub text: Option<String>,
    pub epochs: usize,
    pub silver_share: f64,
    pub giant_every: usize,
    pub page_pairs: usize,
}

impl Options {
    pub fn read(options: &[String]) -> Result<Self, String> {
        let value = |name: &str| options.iter().position(|o| o == name).and_then(|n| options.get(n + 1)).cloned();
        let number = |name: &str, default: f64| value(name).map_or(Ok(default), |v| v.parse::<f64>().map_err(|_| format!("{name} {v}: not a number")));
        Ok(Self {
            pack_docs: number("--pack-docs", 32.0)? as usize,
            pack_lines: number("--pack-lines", 24000.0)? as usize,
            window_lines: number("--window-lines", 12000.0)? as usize,
            buckets: options.iter().any(|o| o == "--buckets"),
            sample: number("--sample", 1.0)?,
            text: value("--text").map(|t| std::path::absolute(&t).map_or(t, |p| p.display().to_string())),
            train: value("--train").map_or_else(|| STAGES.iter().map(|s| s.to_string()).collect(), |t| t.split(',').map(str::to_owned).collect()),
            epochs: number("--epochs", 10.0)? as usize,
            silver_share: number("--silver-share", 0.34)?,
            giant_every: number("--giant-every", 2.0)?.max(1.0) as usize,
            page_pairs: number("--page-pairs", 2_000_000.0)? as usize,
        })
    }

    fn heads(&self) -> BTreeSet<&'static str> {
        HEADS.into_iter().filter(|h| head_stages(h).iter().any(|s| self.train.iter().any(|t| t == s))).collect()
    }
}

/// A set entry (`set.json`, the grader's `labels`): what is known of a document before its arrays are read.
struct Entry {
    sha: String,
    split: String,
    silver: bool,
    key: String,
    lines: usize,
    regions: usize,
    page_lines: Vec<usize>,
    has: BTreeSet<String>,
}

/// One document of a pack as the pack reads it: the dump's arrays (a page window's lines alone: `window`).
#[derive(Clone)]
struct Doc {
    sha: String,
    key: String,
    kind: &'static str,
    window: Option<(usize, usize)>,
    n: usize,
    regions: usize,
    page_lines: Vec<usize>,
    has: BTreeSet<String>,
}

/// A tree of one document (headings' or the body's): its nodes (region indexes), gold and inputs.
#[derive(Default)]
struct TreeArrays {
    nodes: Vec<i64>,
    parent: Vec<i64>,
    sibling: Vec<i64>,
    sibling_from: Vec<i64>,
    gap: Vec<i64>,
    enclosing: Vec<i64>,
    ints: Vec<Vec<i64>>,
    x0: Vec<f32>,
    size: Vec<f32>,
}

/// A document's arrays, read from its dump.
struct Arrays {
    n: usize,
    m: usize,
    own: Vec<i8>,
    shape: Vec<i8>,
    tokens: Vec<i64>,
    token_counts: Vec<i64>,
    t0: Vec<u8>,
    boxes: Vec<f32>,
    pages: Vec<i64>,
    anchors: Vec<i64>,
    templates: Vec<i64>,
    rows: Vec<f32>,
    free: Vec<bool>,
    lines: [Vec<i64>; 5],
    region_lines: Vec<i64>,
    line_region: Vec<i64>,
    region_role: Vec<i64>,
    region_pages: Vec<i64>,
    region_boxes: Vec<f32>,
    goes_on: Vec<i64>,
    note_of: Vec<i64>,
    region_order: Vec<i64>,
    pair_i: Vec<i64>,
    pair_j: Vec<i64>,
    pair_match: Vec<bool>,
    pairs_gold: [Vec<i64>; 3],
    partial: bool,
    trees: [TreeArrays; 2],
    has: BTreeSet<String>,
}

fn read_arrays(dump: &Path, doc: &Doc, width: usize, t0_width: usize) -> Result<Arrays, String> {
    // A page window's arrays are its document's (`sha#wK` names the window).
    let sha = doc.sha.split('#').next().unwrap_or(&doc.sha);
    let entry = legalpdf::Entry::read(dump, sha).ok_or_else(|| format!("{sha}: no dump entry"))?;
    let (inputs, targets) = (entry.part("inputs"), entry.part("targets"));
    fn get<'a>(from: &'a std::collections::HashMap<String, Tensor>, name: &str, sha: &str) -> Result<&'a Tensor, String> {
        from.get(name).ok_or_else(|| format!("{sha}: no {name}"))
    }
    let i = |name: &str| get(&inputs, name, &doc.sha).map(|t| t.i64s());
    let t = |name: &str| get(&targets, name, &doc.sha).map(|t| t.i64s());
    let tf = |name: &str| get(&targets, name, &doc.sha).map(|t| t.f32s());
    let tb = |name: &str| get(&targets, name, &doc.sha).map(|t| t.bools());
    let tree = |name: &str| -> Result<TreeArrays, String> {
        Ok(TreeArrays {
            nodes: t(if name == "heading" { "headings" } else { "bodies" })?,
            parent: t(&format!("{name}_parent"))?,
            sibling: t(&format!("{name}_sibling"))?,
            sibling_from: t(&format!("{name}_sibling_from"))?,
            gap: t(&format!("{name}_gap"))?,
            enclosing: t(&format!("{name}_enclosing"))?,
            ints: TREE_INPUTS.iter().filter(|f| !matches!(**f, "x0" | "size")).map(|f| t(&format!("{name}_{f}"))).collect::<Result<_, _>>()?,
            x0: tf(&format!("{name}_x0"))?,
            size: tf(&format!("{name}_size"))?,
        })
    };
    let n_all = get(&inputs, "pages", &doc.sha)?.shape[0];
    let mut a = Arrays {
        n: n_all,
        m: get(&targets, "region_role", &doc.sha)?.shape[0],
        own: get(&inputs, "own", &doc.sha)?.bytes.iter().map(|&b| b as i8).collect(),
        shape: get(&inputs, "shape", &doc.sha)?.bytes.iter().map(|&b| b as i8).collect(),
        tokens: get(&inputs, "tokens", &doc.sha)?.i64s(),
        token_counts: get(&inputs, "token_counts", &doc.sha)?.i64s(),
        t0: get(&inputs, "t0", &doc.sha)?.bytes.clone(),
        boxes: get(&inputs, "boxes", &doc.sha)?.f32s(),
        pages: i("pages")?,
        anchors: i("anchors")?,
        templates: i("templates")?,
        rows: get(&inputs, "template_rows", &doc.sha)?.f32s(),
        free: tb("free")?,
        lines: [t("role")?, t("marked")?, t("start")?, t("successor")?, t("predecessor")?],
        region_lines: t("region_lines")?,
        line_region: t("line_region")?,
        region_role: t("region_role")?,
        region_pages: t("region_pages")?,
        region_boxes: tf("region_boxes")?,
        goes_on: t("goes_on")?,
        note_of: t("note_of")?,
        region_order: t("region_order")?,
        pair_i: t("pair_i")?,
        pair_j: t("pair_j")?,
        pair_match: tb("pair_match")?,
        pairs_gold: [t("goes_on_pair")?, t("note_of_pair")?, t("order_pair")?],
        partial: tb("partial_bodies")?.first().copied().unwrap_or(false),
        trees: [tree("heading")?, tree("body")?],
        has: doc.has.clone(),
    };
    if a.own.len() != a.n * width || a.token_counts.len() != a.n || a.t0.len() != a.n * t0_width {
        return Err(format!("{}: arrays of other widths than the set's", doc.sha));
    }
    if a.rows.is_empty() {
        a.rows = vec![0.0; ROW];
    }
    // A page window: its lines' inputs and line heads' gold, no regions or trees.
    if let Some((lo, hi)) = doc.window {
        let cut = |v: &mut Vec<f32>, w: usize| *v = v[lo * w..hi * w].to_vec();
        a.own = a.own[lo * width..hi * width].to_vec();
        // The window's tokens: those of its lines.
        let first: usize = a.token_counts[..lo].iter().sum::<i64>() as usize;
        let count: usize = a.token_counts[lo..hi].iter().sum::<i64>() as usize;
        a.tokens = a.tokens[first..first + count].to_vec();
        a.token_counts = a.token_counts[lo..hi].to_vec();
        cut(&mut a.boxes, 4);
        a.t0 = a.t0[lo * t0_width..hi * t0_width].to_vec();
        for v in [&mut a.pages, &mut a.anchors, &mut a.templates] {
            *v = v[lo..hi].to_vec();
        }
        a.free = a.free[lo..hi].to_vec();
        for (h, v) in a.lines.iter_mut().enumerate() {
            *v = v[lo..hi].iter().map(|&g| if h >= 3 && g >= 0 { g - lo as i64 } else { g }).collect();
        }
        a.n = hi - lo;
        a.m = 0;
        for v in [&mut a.region_lines, &mut a.line_region, &mut a.region_role, &mut a.region_pages, &mut a.goes_on, &mut a.note_of,
            &mut a.region_order, &mut a.pair_i, &mut a.pair_j] {
            v.clear();
        }
        a.pairs_gold.iter_mut().for_each(Vec::clear);
        a.region_boxes.clear();
        a.pair_match.clear();
        a.trees = Default::default();
    }
    Ok(a)
}

const ROW: usize = 20;

/// A document of nothing: `lines` lines (each its own page, each feature at its scale's centre, no gold), `regions`
/// regions (region i of line i alone, no gold) and `rows` template rows of zeros: what a pack is padded with to its
/// buckets.
fn padding(lines: usize, regions: usize, rows: usize, width: usize, t0_width: usize) -> Arrays {
    let none = |k: usize| vec![-100i64; k];
    Arrays {
        n: lines,
        m: regions,
        own: vec![0; lines * width],
        shape: vec![0; 4],
        tokens: Vec::new(),
        token_counts: vec![0; lines],
        t0: vec![0; lines * t0_width],
        boxes: [0.0, 0.0, 1.0, 1.0].repeat(lines),
        pages: (0..lines as i64).collect(),
        anchors: vec![0; lines],
        templates: vec![0; lines],
        rows: vec![0.0; rows.max(1) * ROW],
        free: vec![false; lines],
        lines: [none(lines), none(lines), none(lines), none(lines), none(lines)],
        region_lines: (0..regions as i64).collect(),
        line_region: (0..regions as i64).collect(),
        region_role: vec![0; regions],
        region_pages: (0..regions as i64).collect(),
        region_boxes: [0.0, 0.0, 1.0, 1.0].repeat(regions),
        goes_on: none(regions),
        note_of: none(regions),
        region_order: none(regions),
        pair_i: Vec::new(),
        pair_j: Vec::new(),
        pair_match: Vec::new(),
        pairs_gold: [none(regions), none(regions), none(regions)],
        partial: false,
        trees: Default::default(),
        has: BTreeSet::new(),
    }
}

/// The least of a ladder of sizes (each about 30% past the last, a multiple of `step`) at or above `x`.
fn bucket(x: usize, step: usize) -> usize {
    let mut v = step;
    while v < x {
        v = (v + step).max((v as f64 * 1.3 / step as f64).ceil() as usize * step);
    }
    v
}

/// Trees (their node counts `sizes`) cut into groups of like size, each padded to its largest: the largest first, each
/// next joining while the group's padded pairs stay within `slack` of its real ones; trees of at most `small` nodes
/// share a group whatever their sizes.
fn tree_groups(sizes: &[usize]) -> Vec<Vec<usize>> {
    let (slack, small) = (1.25, 512);
    let mut order: Vec<usize> = (0..sizes.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(sizes[i]));
    let (mut groups, mut real): (Vec<Vec<usize>>, f64) = (Vec::new(), 0.0);
    for i in order {
        let square = (sizes[i] * sizes[i]) as f64;
        let joins = groups.last().is_some_and(|g: &Vec<usize>| {
            let top = sizes[g[0]] as f64;
            sizes[g[0]] <= small || (g.len() + 1) as f64 * top * top <= slack * (real + square)
        });
        if joins {
            groups.last_mut().expect("a group").push(i);
            real += square;
        } else {
            groups.push(vec![i]);
            real = square;
        }
    }
    groups
}

/// The documents grouped for steps by kind (a step reads one kind) and size (regions, then lines): `most` a group at
/// most while their lines stay within `lines`, a longer document alone.
fn groups(mut docs: Vec<Doc>, most: usize, lines: usize) -> Vec<Vec<Doc>> {
    docs.sort_by(|a, b| (a.kind, a.regions, a.n).cmp(&(b.kind, b.regions, b.n)));
    let mut out: Vec<Vec<Doc>> = Vec::new();
    for d in docs {
        match out.last_mut() {
            Some(g) if g[0].kind == d.kind && g.len() < most && g.iter().map(|x| x.n).sum::<usize>() + d.n <= lines => g.push(d),
            _ => out.push(vec![d]),
        }
    }
    out
}

/// A giant's page windows: whole pages of at most `limit` lines each (a longer page alone).
fn windows(d: &Doc, limit: usize) -> Vec<Doc> {
    let (mut spans, mut a, mut at) = (Vec::new(), 0usize, 0usize);
    for &len in &d.page_lines {
        if at + len - a > limit && at > a {
            spans.push((a, at));
            a = at;
        }
        at += len;
    }
    spans.push((a, at));
    let line_heads: BTreeSet<String> = d.has.iter().filter(|h| LINE_HEADS.contains(&h.as_str())).cloned().collect();
    spans.into_iter().enumerate().map(|(k, (lo, hi))| {
        let mut pages = Vec::new();
        let mut seen = 0usize;
        for &len in &d.page_lines {
            if seen >= lo && seen < hi {
                pages.push(len);
            }
            seen += len;
        }
        Doc { sha: format!("{}#w{k}", d.sha), key: d.key.clone(), kind: "window", window: Some((lo, hi)), n: hi - lo, regions: 0, page_lines: pages,
            has: line_heads.clone() }
    }).collect()
}

/// zlib's CRC-32, as the fit's screening share reads a document's name.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn bf16(v: f32) -> [u8; 2] {
    let bits = v.to_bits();
    let rounded = bits.wrapping_add(0x7FFF + ((bits >> 16) & 1));
    ((rounded >> 16) as u16).to_le_bytes()
}

// The arrays a pack file holds, by dtype.
fn t_i64(name: &str, shape: Vec<usize>, v: &[i64]) -> Tensor { Tensor::raw(name, "I64", shape, v.iter().flat_map(|x| x.to_le_bytes()).collect()) }
fn t_i32(name: &str, shape: Vec<usize>, v: &[i64]) -> Tensor { Tensor::raw(name, "I32", shape, v.iter().flat_map(|&x| (x as i32).to_le_bytes()).collect()) }
fn t_f32(name: &str, shape: Vec<usize>, v: &[f32]) -> Tensor { Tensor::raw(name, "F32", shape, v.iter().flat_map(|x| x.to_le_bytes()).collect()) }
fn t_bf16(name: &str, shape: Vec<usize>, v: &[f32]) -> Tensor { Tensor::raw(name, "BF16", shape, v.iter().flat_map(|&x| bf16(x)).collect()) }
fn t_bool(name: &str, shape: Vec<usize>, v: &[bool]) -> Tensor { Tensor::raw(name, "BOOL", shape, v.iter().map(|&x| u8::from(x)).collect()) }
fn t_i8(name: &str, shape: Vec<usize>, v: &[i8]) -> Tensor { Tensor::raw(name, "I8", shape, v.iter().map(|&x| x as u8).collect()) }

/// Each place's weight in its document's mean: one over its document's count of places `known`, nought where not known.
fn share(known: &[bool], doc: &[usize], k: usize) -> Vec<f32> {
    let mut count = vec![0f32; k];
    known.iter().zip(doc).filter(|(&kn, _)| kn).for_each(|(_, &d)| count[d] += 1.0);
    known.iter().zip(doc).map(|(&kn, &d)| if kn { 1.0 / count[d].max(1.0) } else { 0.0 }).collect()
}

/// Runs [a, z) as rows of a matrix, -1 past each run's end.
fn padded(starts: &[usize], ends: &[usize]) -> (Vec<i64>, usize) {
    let width = starts.iter().zip(ends).map(|(a, z)| z - a).max().unwrap_or(0);
    let rows = starts.iter().zip(ends).flat_map(|(&a, &z)| (0..width).map(move |c| if a + c < z { (a + c) as i64 } else { -1 })).collect();
    (rows, width)
}

/// One pack's arrays, its documents laid end to end (`docs`, the padding document last where there are buckets).
fn pack(docs: &[Arrays], real: usize, options: &Options, width: usize, t0_width: usize, budget: usize) -> (Vec<Tensor>, Value) {
    let k = docs.len();
    let mut out = Vec::new();
    let n: Vec<usize> = docs.iter().map(|d| d.n).collect();
    let m: Vec<usize> = docs.iter().map(|d| d.m).collect();
    let blocks: Vec<usize> = m.iter().map(|&x| x.div_ceil(BLOCK) * BLOCK).collect();
    let firsts = |sizes: &[usize]| -> Vec<i64> { sizes.iter().scan(0i64, |at, &s| { let first = *at; *at += s as i64; Some(first) }).collect() };
    let line0 = firsts(&n);
    let region0 = firsts(&blocks);
    let pair0 = firsts(&docs.iter().map(|d| d.pair_i.len()).collect::<Vec<_>>());
    let rows_of: Vec<usize> = docs.iter().map(|d| d.rows.len() / ROW).collect();
    let template0 = firsts(&rows_of);
    let total: usize = n.iter().sum();
    let regions_total: usize = blocks.iter().sum();
    let offset = |v: &[i64], at: i64| -> Vec<i64> { v.iter().map(|&x| if x >= 0 { x + at } else { x }).collect() };
    let cat = |part: &dyn Fn(usize) -> Vec<i64>| -> Vec<i64> { (0..k).flat_map(part).collect() };
    // Each document's per-region values padded to whole blocks with `fill`.
    let to_blocks = |part: &dyn Fn(usize) -> Vec<i64>, fill: i64| -> Vec<i64> {
        (0..k).flat_map(|d| { let mut v = part(d); v.resize(blocks[d], fill); v }).collect()
    };
    // The lines as the parser wrote them: each one's own features (bytes on their scales), its document's shape and
    // where each document's lines start, its tokens and their count.
    out.push(t_i8("own", vec![total, width], &docs.iter().flat_map(|d| d.own.iter().copied()).collect::<Vec<_>>()));
    out.push(t_i8("shape", vec![k, 4], &docs.iter().flat_map(|d| d.shape.iter().copied()).collect::<Vec<_>>()));
    out.push(t_i32("docs", vec![k + 1], &line0.iter().copied().chain(std::iter::once(total as i64)).collect::<Vec<_>>()));
    let tokens: Vec<i64> = docs.iter().flat_map(|d| d.tokens.iter().copied()).collect();
    out.push(t_i32("tokens", vec![tokens.len()], &tokens));
    out.push(t_i32("token_counts", vec![total], &docs.iter().flat_map(|d| d.token_counts.iter().copied()).collect::<Vec<_>>()));
    let z: Vec<f32> = docs.iter().flat_map(|d| d.t0.iter().map(|&v| f32::from(v))).collect();
    out.push(t_bf16("z", vec![total, t0_width], &z));
    out.push(t_f32("b", vec![total, 4], &docs.iter().flat_map(|d| d.boxes.iter().copied()).collect::<Vec<_>>()));
    out.push(t_i32("anchors", vec![total], &cat(&|d| docs[d].anchors.clone())));
    let free: Vec<bool> = docs.iter().flat_map(|d| d.free.iter().copied()).collect();
    out.push(t_bool("free", vec![total], &free));
    let line_doc: Vec<usize> = (0..k).flat_map(|d| std::iter::repeat(d).take(n[d])).collect();
    let (mut line_gold, mut line_weight): (Vec<Vec<i64>>, Vec<Vec<f32>>) = (Vec::new(), Vec::new());
    for (h, name) in LINE_HEADS.iter().enumerate() {
        let gold = if h >= 3 { cat(&|d| offset(&docs[d].lines[h], line0[d])) } else { cat(&|d| docs[d].lines[h].clone()) };
        out.push(t_i64(name, vec![total], &gold));
        let known: Vec<bool> = gold.iter().map(|&g| g >= 0).collect();
        let weight = share(&known, &line_doc, k);
        out.push(t_f32(&format!("w.{name}"), vec![total], &weight));
        line_gold.push(gold);
        line_weight.push(weight);
    }
    // The evaluation's gold: each line's role where the gold names it (not free), and the heading openings.
    let role = &line_gold[0];
    out.push(t_i64("role_named", vec![total], &role.iter().zip(&free).map(|(&r, &fr)| if fr { -100 } else { r }).collect::<Vec<_>>()));
    // The lines' pages, numbered on past each document's (each page its own across the pack), in batches of pages of
    // like length, at most `budget` pairs a batch.
    let mut line_pages = Vec::with_capacity(total);
    let mut page_at = 0i64;
    for d in docs {
        line_pages.extend(d.pages.iter().map(|&p| p + page_at));
        page_at += d.pages.iter().copied().max().map_or(0, |p| p + 1);
    }
    out.push(t_i32("line_page", vec![total], &line_pages));
    let mut starts: Vec<usize> = vec![0];
    starts.extend((1..total).filter(|&i| line_pages[i] != line_pages[i - 1]));
    let ends: Vec<usize> = starts[1..].iter().copied().chain(std::iter::once(total)).collect();
    let mut by: Vec<usize> = (0..starts.len()).collect();
    by.sort_by_key(|&i| ends[i] - starts[i]);
    let mut batches: Vec<Vec<usize>> = vec![Vec::new()];
    for i in by {
        let w = ends[i] - starts[i];
        let group = batches.last().expect("a batch");
        if !group.is_empty() && (group.len() + 1) * w * w > budget {
            batches.push(Vec::new());
        }
        batches.last_mut().expect("a batch").push(i);
    }
    let mut order_nodes: Vec<i64> = Vec::with_capacity(total);
    let mut batch_pairs = Vec::new();
    for (b, group) in batches.iter().enumerate() {
        let (s, e): (Vec<usize>, Vec<usize>) = group.iter().map(|&i| (starts[i], ends[i])).unzip();
        let (rows, w) = padded(&s, &e);
        let valid: Vec<bool> = rows.iter().map(|&r| r >= 0).collect();
        let valid_at: Vec<i64> = (0..rows.len()).filter(|&x| valid[x]).map(|x| x as i64).collect();
        let nodes: Vec<i64> = rows.iter().copied().filter(|&r| r >= 0).collect();
        let name = |what: &str| format!("lines.batches.{b}.{what}");
        out.push(t_i32(&name("rows"), vec![group.len(), w], &rows));
        out.push(t_i32(&name("starts"), vec![group.len()], &s.iter().map(|&x| x as i64).collect::<Vec<_>>()));
        out.push(t_bool(&name("valid"), vec![group.len(), w], &valid));
        out.push(t_i32(&name("valid_at"), vec![valid_at.len()], &valid_at));
        out.push(t_i32(&name("nodes"), vec![nodes.len()], &nodes));
        out.push(t_i64(&name("own"), vec![valid_at.len()], &valid_at.iter().map(|&x| x % w.max(1) as i64).collect::<Vec<_>>()));
        // Each real line's gold link as a place in its page's row (-100 none), and its weight.
        for (h, head) in [(3usize, "successor"), (4, "predecessor")] {
            let local: Vec<i64> = valid_at.iter().map(|&x| {
                let (r, line) = (x as usize / w, rows[x as usize] as usize);
                let g = line_gold[h][line];
                if g >= 0 { g - s[r] as i64 } else { -100 }
            }).collect();
            out.push(t_i64(&name(head), vec![local.len()], &local));
            out.push(t_f32(&name(&format!("w_{head}")), vec![nodes.len()], &nodes.iter().map(|&line| line_weight[h][line as usize]).collect::<Vec<_>>()));
        }
        batch_pairs.push(valid_at.len());
        order_nodes.extend(nodes);
    }
    let mut inverse = vec![0i64; total];
    order_nodes.iter().enumerate().for_each(|(x, &line)| inverse[line as usize] = x as i64);
    out.push(t_i32("lines.inverse", vec![total], &inverse));
    // Every two lines of a page: their count (the flat line pairs, `--link-pairs flat`, are made in the step).
    let pairs_total: usize = (0..starts.len()).map(|p| (ends[p] - starts[p]).pow(2)).sum();
    // The templates, each document's its own.
    out.push(t_i64("templates", vec![total], &cat(&|d| offset(&docs[d].templates, template0[d]))));
    let rows_total: usize = rows_of.iter().sum();
    out.push(t_f32("template_rows", vec![rows_total, ROW], &docs.iter().flat_map(|d| d.rows.iter().copied()).collect::<Vec<_>>()));
    let t_starts: Vec<usize> = template0.iter().map(|&x| x as usize).collect();
    let t_ends: Vec<usize> = t_starts.iter().zip(&rows_of).map(|(a, r)| a + r).collect();
    let (mut at, mut at_width) = padded(&t_starts, &t_ends);
    let mut at_rows = k;
    if options.buckets {
        let (rows_to, cols_to) = (bucket(at_rows, 1), bucket(at_width, 16));
        let mut grown = vec![-1i64; rows_to * cols_to];
        (0..at_rows).for_each(|r| grown[r * cols_to..r * cols_to + at_width].copy_from_slice(&at[r * at_width..(r + 1) * at_width]));
        (at, at_rows, at_width) = (grown, rows_to, cols_to);
    }
    out.push(t_i32("template_layout.0", vec![at_rows, at_width], &at.iter().map(|&x| x.max(0)).collect::<Vec<_>>()));
    out.push(t_bool("template_layout.1", vec![at_rows, at_width], &at.iter().map(|&x| x >= 0).collect::<Vec<_>>()));
    let flat: Vec<i64> = (0..at.len()).filter(|&x| at[x] >= 0).map(|x| x as i64).collect();
    out.push(t_i32("template_layout.2", vec![flat.len()], &flat));
    // The regions and their pairs.
    let region_doc: Vec<usize> = (0..k).flat_map(|d| std::iter::repeat(d).take(blocks[d])).collect();
    out.push(t_i32("region_doc", vec![regions_total], &region_doc.iter().map(|&d| d as i64).collect::<Vec<_>>()));
    let region_valid: Vec<bool> = (0..k).flat_map(|d| { let real = m[d]; (0..blocks[d]).map(move |x| x < real) }).collect();
    out.push(t_bool("region_valid", vec![regions_total], &region_valid));
    out.push(t_i64("region_role", vec![regions_total], &to_blocks(&|d| docs[d].region_role.clone(), 0)));
    let mut region_lines = cat(&|d| offset(&docs[d].region_lines, line0[d]));
    let mut line_region = cat(&|d| offset(&docs[d].line_region, region0[d]));
    let mut pair_i = cat(&|d| offset(&docs[d].pair_i, region0[d]));
    let mut pair_j = cat(&|d| offset(&docs[d].pair_j, region0[d]));
    if options.buckets {
        let (last_line, last_region) = (total as i64 - 1, regions_total as i64 - 1);
        let held = bucket(region_lines.len(), 64);
        region_lines.resize(held, last_line);
        line_region.resize(held, last_region);
        let pairs = bucket(pair_i.len(), 64);
        pair_i.resize(pairs, last_region);
        pair_j.resize(pairs, last_region);
    }
    out.push(t_i32("region_lines", vec![region_lines.len()], &region_lines));
    out.push(t_i64("line_region", vec![line_region.len()], &line_region));
    out.push(t_i32("pair_i", vec![pair_i.len()], &pair_i));
    out.push(t_i32("pair_j", vec![pair_j.len()], &pair_j));
    let mut region_boxes = Vec::with_capacity(regions_total * 4);
    for d in 0..k {
        region_boxes.extend_from_slice(&docs[d].region_boxes);
        region_boxes.resize(region_boxes.len() + (blocks[d] - m[d]) * 4, 0.0);
    }
    out.push(t_f32("region_boxes", vec![regions_total, 4], &region_boxes));
    out.push(t_i64("region_pages", vec![regions_total], &to_blocks(&|d| docs[d].region_pages.clone(), 0)));
    let mut pair_match: Vec<bool> = docs.iter().flat_map(|d| d.pair_match.iter().copied()).collect();
    pair_match.resize(pair_i.len(), false);
    out.push(t_bool("pair_match", vec![pair_match.len()], &pair_match));
    for (g, name) in ["goes_on", "note_of", "order"].iter().enumerate() {
        let gold = to_blocks(&|d| offset(match g { 0 => &docs[d].goes_on, 1 => &docs[d].note_of, _ => &docs[d].region_order }, region0[d]), -100);
        out.push(t_i64(name, vec![regions_total], &gold));
        let pair = to_blocks(&|d| offset(&docs[d].pairs_gold[g], pair0[d]), -100);
        let known: Vec<bool> = pair.iter().map(|&p| p >= 0).collect();
        out.push(t_f32(&format!("w.{name}"), vec![regions_total], &share(&known, &region_doc, k)));
        out.push(t_i64(&format!("{name}_pair"), vec![regions_total], &pair));
    }
    // Order's blocks: each sees itself and the blocks either side of its own document; each region's place in it.
    let count = regions_total / BLOCK;
    let owner: Vec<usize> = (0..count).map(|r| region_doc[r * BLOCK]).collect();
    let mut seen = vec![false; count * 3 * BLOCK];
    for r in 0..count {
        for c in 0..BLOCK {
            if r > 0 && owner[r] == owner[r - 1] { seen[r * 3 * BLOCK + c] = region_valid[(r - 1) * BLOCK + c]; }
            seen[r * 3 * BLOCK + BLOCK + c] = region_valid[r * BLOCK + c];
            if r + 1 < count && owner[r + 1] == owner[r] { seen[r * 3 * BLOCK + 2 * BLOCK + c] = region_valid[(r + 1) * BLOCK + c]; }
        }
    }
    out.push(t_bool("seen", vec![count, 3 * BLOCK], &seen));
    out.push(t_i32("order_places", vec![regions_total], &blocks.iter().flat_map(|&b| 0..b as i64).collect::<Vec<_>>()));
    // The trees: of each kind, the documents that have one, in groups of like size.
    let mut body_nodes = 0;
    let mut tree_counts = json!({});
    for (kind, name) in ["heading", "body"].iter().enumerate() {
        let have: Vec<usize> = (0..k).filter(|&d| docs[d].has.contains(*name)).collect();
        let sizes: Vec<usize> = have.iter().map(|&d| docs[d].trees[kind].nodes.len()).collect();
        let grouped = tree_groups(&sizes);
        tree_counts[*name] = json!(grouped.len());
        for (g, group) in grouped.iter().enumerate() {
            let members: Vec<usize> = group.iter().map(|&i| have[i]).collect();
            let mut rows = members.len();
            let mut cols = members.iter().map(|&d| docs[d].trees[kind].nodes.len()).max().unwrap_or(0);
            let pad_node = if options.buckets { (rows, cols) = (bucket(rows, 1), bucket(cols, 16)); regions_total as i64 - 1 } else { 0 };
            let grid = |part: &dyn Fn(usize) -> Vec<i64>, fill: i64, member_fill: i64| -> Vec<i64> {
                let mut v = vec![fill; rows * cols];
                for (r, &d) in members.iter().enumerate() {
                    let values = part(d);
                    v[r * cols..r * cols + values.len()].copy_from_slice(&values);
                    v[r * cols + values.len()..(r + 1) * cols].iter_mut().for_each(|x| *x = member_fill);
                }
                v
            };
            let tree = |d: usize| &docs[d].trees[kind];
            let name = |what: &str| format!("{name}.{g}.{what}");
            let at = |d: usize| region0[d];
            out.push(t_i32(&name("nodes"), vec![rows, cols], &grid(&|d| tree(d).nodes.iter().map(|&x| x + at(d)).collect(), pad_node, 0)));
            let valid: Vec<bool> = grid(&|d| vec![1; tree(d).nodes.len()], 0, 0).iter().map(|&x| x == 1).collect();
            if kind == 1 {
                body_nodes += valid.len();
            }
            out.push(t_bool(&name("valid"), vec![rows, cols], &valid));
            let mut ints = tree_inputs_ints();
            for (f, field) in TREE_INPUTS.iter().enumerate() {
                let shape = vec![rows, cols];
                match *field {
                    "x0" | "size" => {
                        let values: Vec<f32> = {
                            let mut v = vec![0f32; rows * cols];
                            for (r, &d) in members.iter().enumerate() {
                                let src = if *field == "x0" { &tree(d).x0 } else { &tree(d).size };
                                v[r * cols..r * cols + src.len()].copy_from_slice(src);
                            }
                            v
                        };
                        out.push(t_f32(&name(&format!("inputs.{f}")), shape, &values));
                    }
                    _ => {
                        let at_int = ints.next().expect("an integer input");
                        out.push(t_i64(&name(&format!("inputs.{f}")), shape, &grid(&|d| tree(d).ints[at_int].clone(), 0, 0)));
                    }
                }
            }
            for (part, values) in [("parent", 0usize), ("sibling", 1), ("sibling_from", 2), ("gap", 3)] {
                let of = |d: usize| match values { 0 => tree(d).parent.clone(), 1 => tree(d).sibling.clone(), 2 => tree(d).sibling_from.clone(), _ => tree(d).gap.clone() };
                out.push(t_i64(&name(part), vec![rows, cols], &grid(&of, -100, -100)));
            }
            out.push(t_i32(&name("enclosing"), vec![rows, cols], &grid(&|d| tree(d).enclosing.iter().map(|&e| if e >= 0 { e + at(d) } else { -1 }).collect(), -1, -1)));
            let mut partial: Vec<bool> = members.iter().map(|&d| docs[d].partial).collect();
            partial.resize(rows, false);
            out.push(t_bool(&name("partial"), vec![rows], &partial));
        }
    }
    let has: BTreeSet<&str> = docs.iter().flat_map(|d| d.has.iter().map(String::as_str)).collect();
    let summary = json!({"k": real, "has": has, "doc_lines": &n[..real], "trees": tree_counts, "page_batches": batch_pairs.len(),
        "size": {"lines": total, "regions": m.iter().sum::<usize>(), "pairs": pair_i.len(), "line pairs": pairs_total, "body nodes": body_nodes}});
    // Each array placed at a multiple of its own width: the widest first.
    let width_of = |t: &Tensor| match t.dtype { "I64" => 8, "F32" | "I32" => 4, "BF16" => 2, _ => 1 };
    out.sort_by_key(|t| std::cmp::Reverse(width_of(t)));
    (out, summary)
}

/// The integer tree inputs' places among a tree's `ints` (every input but x0 and size, in `TREE_INPUTS`' order).
fn tree_inputs_ints() -> std::ops::Range<usize> {
    0..TREE_INPUTS.len() - 2
}

/// The fit's packs written from the dump's set (`set.json`) into `out`, with its manifest: the packs (train's and
/// development's, each one's file, kind, documents, heads and sizes) and the epochs' plan. A pack whose file is there
/// (named by its documents' keys and the packing) is not written again; files of no pack of this manifest are taken off.
pub fn packs(dump: &Path, out: &Path, options: &Options) -> Result<(), String> {
    let started = std::time::Instant::now();
    let read = |path: &Path| -> Result<Value, String> {
        serde_json::from_slice(&std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?).map_err(|e| format!("{}: {e}", path.display()))
    };
    let set = read(&dump.join("set.json"))?;
    let entries: Vec<Entry> = set.as_array().ok_or("set.json: not a list")?.iter().filter_map(|e| {
        let s = &e["summary"];
        let lines = s["lines"].as_u64()? as usize;
        (lines > 0 && s["text"].as_bool().unwrap_or(false)).then(|| Entry {
            sha: e["sha256"].as_str().unwrap_or_default().to_owned(),
            split: e["split"].as_str().unwrap_or_default().to_owned(),
            silver: e["label_source"].as_str() == Some("a2aj-align"),
            key: e["key"].as_str().unwrap_or_default().to_owned(),
            lines,
            regions: s["regions"].as_u64().unwrap_or(0) as usize,
            page_lines: s["page_lines"].as_array().map(|a| a.iter().filter_map(Value::as_u64).map(|v| v as usize).collect()).unwrap_or_default(),
            has: s["has"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default(),
        })
    }).collect();
    let first = set.as_array().and_then(|a| a.first()).ok_or("set.json: empty")?;
    let width = first["summary"]["width"].as_u64().unwrap_or(0) as usize;
    let t0_width = T0_WIDTH;
    let heads = options.heads();
    let wanted = |has: &BTreeSet<String>| has.iter().any(|h| heads.contains(h.as_str()));
    let doc = |e: &Entry, kind: &'static str| Doc { sha: e.sha.clone(), key: e.key.clone(), kind, window: None, n: e.lines, regions: e.regions,
        page_lines: e.page_lines.clone(), has: e.has.clone() };
    let mut train: Vec<Doc> = entries.iter().filter(|e| e.split == "train" && (options.sample >= 1.0 || f64::from(crc32(e.sha.as_bytes())) < options.sample * 4_294_967_296.0))
        .map(|e| doc(e, if e.lines > options.window_lines { "giant" } else if e.silver { "silver" } else { "gold" })).collect();
    let giant_windows: Vec<Doc> = train.iter().filter(|d| d.kind == "giant").flat_map(|d| windows(d, options.window_lines)).collect();
    train.extend(giant_windows);
    train.retain(|d| wanted(&d.has));
    let dev: Vec<Doc> = entries.iter().filter(|e| e.split == "development").map(|e| doc(e, "gold")).filter(|d| wanted(&d.has)).collect();
    let kinds = ["gold", "silver", "giant", "window"].map(|k| format!("{k} {}", train.iter().filter(|d| d.kind == k).count())).join(", ");
    let sets: Vec<(&str, Vec<Doc>)> = groups(train, options.pack_docs, options.pack_lines).into_iter().map(|g| ("train", g))
        .chain(groups(dev, options.pack_docs, options.pack_lines).into_iter().map(|g| ("development", g))).collect();
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    // A pack's file named by what it is made of: its documents' keys and the packing.
    let name_of = |docs: &[Doc]| {
        use sha2::Digest;
        let mut hasher = sha2::Sha256::new();
        hasher.update(format!("{LAYOUT}:{}:{}", options.buckets, options.page_pairs));
        docs.iter().for_each(|d| hasher.update(format!("|{}:{}:{:?}", d.sha, d.key, d.window)));
        format!("pack-{}.safetensors", hasher.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect::<String>())
    };
    let names: Vec<String> = sets.iter().map(|(_, g)| name_of(g)).collect();
    let threads = std::env::var("STRUCTURE_GOLD_THREADS").ok().and_then(|v| v.parse::<usize>().ok()).filter(|&n| n > 0).unwrap_or(4).min(8);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let made: std::sync::Mutex<Vec<Option<Result<Value, String>>>> = std::sync::Mutex::new((0..sets.len()).map(|_| None).collect());
    let written = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let at = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some((_, group)) = sets.get(at) else { break };
                let path = out.join(&names[at]);
                let summary_path = path.with_extension("json");
                let result = (|| -> Result<Value, String> {
                    if path.is_file() {
                        if let Ok(kept) = read(&summary_path) {
                            return Ok(kept);
                        }
                    }
                    let mut arrays = group.iter().map(|d| read_arrays(dump, d, width, t0_width)).collect::<Result<Vec<_>, _>>()?;
                    let real = arrays.len();
                    if options.buckets {
                        // A document of nothing appended so the lines, regions (a block at least, so the padded pairs
                        // have a region of their own) and template rows come to their buckets.
                        let n0: usize = arrays.iter().map(|a| a.n).sum();
                        let m0: usize = arrays.iter().map(|a| a.m.div_ceil(BLOCK) * BLOCK).sum();
                        let regions = bucket(m0 + BLOCK, 64) - m0;
                        let lines = bucket(n0 + regions, 64) - n0;
                        let r0: usize = arrays.iter().map(|a| a.rows.len() / ROW).sum();
                        let rows = bucket(r0 + 1, 16) - r0;
                        arrays.push(padding(lines, regions, rows, width, t0_width));
                    }
                    let (tensors, mut summary) = pack(&arrays, real, options, width, t0_width, options.page_pairs);
                    tensors::write(&path, &tensors, &[]).map_err(|e| format!("{}: {e}", path.display()))?;
                    summary["shas"] = json!(group.iter().map(|d| d.sha.as_str()).collect::<Vec<_>>());
                    summary["kind"] = json!(group[0].kind);
                    std::fs::write(&summary_path, serde_json::to_vec(&summary).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", summary_path.display()))?;
                    written.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    Ok(summary)
                })();
                made.lock().unwrap()[at] = Some(result);
            });
        }
    });
    let made: Vec<Value> = made.into_inner().unwrap().into_iter().zip(&names)
        .map(|(r, name)| r.unwrap_or_else(|| Err("not packed".into())).map_err(|e| format!("{name}: {e}"))).collect::<Result<_, _>>()?;
    let mut train_packs = Vec::new();
    let mut dev_packs = Vec::new();
    for (((split, _), name), summary) in sets.iter().zip(&names).zip(made) {
        let mut entry = summary;
        entry["file"] = json!(name);
        if *split == "train" { train_packs.push(entry) } else { dev_packs.push(entry) }
    }
    // The epochs' plan: every gold and window pack, a share of the silver (a different part each epoch), and the giants
    // whole every `giant_every` epochs, the last epoch among them.
    let silver: Vec<usize> = (0..train_packs.len()).filter(|&i| train_packs[i]["kind"] == "silver").collect();
    let every = if options.silver_share > 0.0 { ((1.0 / options.silver_share).round() as usize).max(1) } else { 0 };
    let plan: Vec<Vec<usize>> = (0..options.epochs).map(|epoch| {
        let mut picked: Vec<usize> = (0..train_packs.len()).filter(|&i| matches!(train_packs[i]["kind"].as_str(), Some("gold" | "window"))).collect();
        picked.extend(silver.iter().enumerate().filter(|&(j, _)| every > 0 && (j + epoch) % every == 0).map(|(_, &i)| i));
        if (options.epochs - 1 - epoch) % options.giant_every == 0 {
            picked.extend((0..train_packs.len()).filter(|&i| train_packs[i]["kind"] == "giant"));
        }
        picked
    }).collect();
    let manifest = json!({
        "train": options.train, "heads": heads, "text": options.text, "buckets": options.buckets, "width": width, "row_width": ROW,
        "train_packs": train_packs, "dev_packs": dev_packs, "plan": plan,
    });
    let path = out.join("manifest.json");
    std::fs::write(&path, serde_json::to_vec(&manifest).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", path.display()))?;
    // The files of no pack of this manifest taken off.
    let kept: BTreeSet<String> = names.iter().flat_map(|n| [n.clone(), n.replace(".safetensors", ".json"), n.replace(".safetensors", ".codes.safetensors")]).collect();
    for entry in std::fs::read_dir(out).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("pack-") && !kept.contains(&name) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    eprintln!("train kinds: {kinds}; {} train packs, {} development, {} written, in {:.1}s -> {}", manifest["train_packs"].as_array().map_or(0, Vec::len),
        manifest["dev_packs"].as_array().map_or(0, Vec::len), written.into_inner(), started.elapsed().as_secs_f64(), path.display());
    Ok(())
}

/// t0's reading of a line: its role (one of 14) and twelve flags and its heading's level (`lines::T0`).
const T0_WIDTH: usize = 14 + 13;
