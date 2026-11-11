#![recursion_limit = "512"]
#![cfg_attr(target_arch = "wasm32", allow(dead_code, unused_imports))]
//! Links to passages of CourtListener's pages, built from its bulk data only: the exam's seeds and their targets.
//!
//!   courtlistener-fragments plan --pack FILE --clusters FILE --pages FILE --out FILE [--pins FILE] [--part tune|judge|all]
//!
//! --pack holds each opinion in pack_kept.py's form, --clusters the cluster fields, --pages one JSON line each ({"url",
//! "cluster"}, the pages an exam holds: the served HTML itself is never read here). --pins adds judges' quotations
//! ({"cluster", "quote"}). A passage comes from what Beaver reads of the opinion (analyze_native_markup, as
//! legalSources/courtlistener.ts calls it); each row carries the link of each arm: `existing`, passage_link over that
//! opinion's own text, and `page`, courtlistener_link over the page's text. A cluster goes to `tune` or `judge` by a fixed
//! hash of its id: one in four tunes.
//! Built with --no-default-features: no PDF stack is needed here.

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    tool::main();
}

#[cfg(not(target_arch = "wasm32"))]
mod tool {
    use legal_structure::{analyze_native_markup, DocumentQuery, DocumentStructure, NativeMarkupInput, NodeKind};
    use legal_structure_features::{courtlistener_link, passage_link, CourtListenerCluster, CourtListenerOpinion, CourtListenerPage, PassageLinkRequest};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::fs::File;
    use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn flag(args: &[String], name: &str) -> Option<String> {
        args.iter().position(|arg| arg == name).and_then(|at| args.get(at + 1)).cloned()
    }

    fn part_of(cluster: u64) -> &'static str {
        let draw = cluster.wrapping_mul(2654435761) % (1 << 32);
        if draw < (1 << 30) { "tune" } else { "judge" }
    }

    /// The renditions the page draws, as compactOpinion chooses among them.
    const MARKUP: [&str; 6] = ["html_with_citations.html", "xml_harvard.xml", "html_columbia.html", "html_lawbox.html", "html_anon_2020.html", "html.html"];

    struct Opinion {
        id: String,
        kind: String,
        markup: Option<String>,
        plain: Option<String>,
        /// The record as the page model reads it.
        record: CourtListenerOpinion,
    }

    fn structure_of(opinion: &Opinion) -> Option<DocumentStructure> {
        let input: NativeMarkupInput = serde_json::from_value(json!({
            "provider": "courtlistener", "id": opinion.id, "url": null,
            "text": opinion.plain.clone().unwrap_or_default(), "markup": opinion.markup, "pageCitations": [],
        })).ok()?;
        analyze_native_markup(input).ok()
    }

    struct Random(u64);

    impl Random {
        fn below(&mut self, limit: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % limit.max(1) as u64) as usize
        }
    }

    /// A node's words in the document's text, whose ranges count UTF-16 units.
    fn slicer<'a>(text: &'a str) -> impl Fn(usize, usize) -> &'a str {
        let mut bytes = Vec::with_capacity(text.len());
        for (at, character) in text.char_indices() {
            bytes.resize(bytes.len() + character.len_utf16(), at);
        }
        bytes.push(text.len());
        move |start, end| &text[bytes[start.min(bytes.len() - 1)]..bytes[end.min(bytes.len() - 1)]]
    }

    struct Seed {
        shape: &'static str,
        opinion: usize,
        block: String,
        quotes: Vec<String>,
    }

    fn words_from(block: &str, start: usize, count: usize) -> Option<String> {
        let words = block.split_whitespace().collect::<Vec<_>>();
        (start + count <= words.len()).then(|| words[start..start + count].join(" "))
    }

    /// A printed paragraph label at a window's start, as harvest.mjs strips it ("[12]", "12.", "(a)", "a)").
    fn strip_label(quote: &str) -> String {
        static LABEL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let label = LABEL.get_or_init(|| regex::Regex::new(r"^(?:\[\s*\d{1,4}\s*\]|\d{1,4}\]|\d{1,4}(?:\.\d{1,4})*\s*(?:\(\s*[A-Za-z0-9]{1,5}\s*\)\s*)+|\(\s*[A-Za-z0-9]{1,5}\s*\)|[A-Za-z]{1,3}\)|\d{1,4}[.)]|¶\s*\d{1,4}\.?)\s*").unwrap());
        label.replace(quote, "").trim().to_owned()
    }

    /// Windows around the hard words of an American opinion, as harvest.mjs finds Canadian ones: a pinpointed reporter
    /// citation ("380 U.S. 460, 468", "at 468"), a statute's section sign, "section 5", an act's or code's name.
    fn hard_windows(text: &str) -> Vec<(usize, &'static str)> {
        static PATTERNS: std::sync::OnceLock<Vec<(regex::Regex, &'static str)>> = std::sync::OnceLock::new();
        let patterns = PATTERNS.get_or_init(|| [
            (r"\b\d{1,4} [a-z][a-z0-9.\s]{0,18}? \d{1,5}, \d{1,5}\b|\bat \d{1,5}\b", "hard-case-cite"),
            (r"§+\s?\d", "hard-statute-ref"),
            (r"\bsections?\s+\d", "hard-section-word"),
            (r"\b(act|code|regulations?|rules)\b", "hard-act-name"),
        ].into_iter().map(|(pattern, tag)| (regex::Regex::new(pattern).unwrap(), tag)).collect());
        let lower = text.to_lowercase();
        patterns.iter().filter_map(|(pattern, tag)| pattern.find(&lower).map(|found| (found.start(), *tag))).collect()
    }

    /// harvest.mjs's receipts for one decision, over the opinion's paragraphs as Beaver reads them: a short exact window,
    /// a window around a hard word (else a long one), two short cores of one paragraph; and judges' quotations of it.
    fn seeds(structures: &[Option<DocumentStructure>], pins: &[String], random: &mut Random) -> Vec<Seed> {
        let mut out = Vec::new();
        let Some(structure) = structures.first().and_then(Option::as_ref) else { return out };
        let text = structure.query_text();
        let slice = slicer(text);
        let blocks = structure.nodes.iter().filter(|node| matches!(node.kind, NodeKind::Paragraph | NodeKind::Prose))
            .map(|node| { let range = structure.query_range(node); slice(range.start, range.end).split_whitespace().collect::<Vec<_>>().join(" ") })
            .filter(|block| (45..=400).contains(&block.split_whitespace().count())).collect::<Vec<_>>();
        if !blocks.is_empty() {
            let short = &blocks[random.below(blocks.len())];
            if let Some(quote) = words_from(short, 2, 9) {
                out.push(Seed { shape: "short-exact", opinion: 0, block: short.clone(), quotes: vec![quote] });
            }
            let mut hard = false;
            for fraction in [0.5, 0.25, 0.75, 0.08, 0.92] {
                let block = &blocks[((blocks.len() as f64 * fraction) as usize).min(blocks.len() - 1)];
                for (at, tag) in hard_windows(block) {
                    let centre = block[..at].split_whitespace().count();
                    let Some(raw) = words_from(block, centre.saturating_sub(8), if tag == "hard-act-name" { 16 } else { 22 }) else { continue };
                    let quote = strip_label(&raw);
                    if quote.split_whitespace().count() < 10 {
                        continue;
                    }
                    out.push(Seed { shape: tag, opinion: 0, block: block.clone(), quotes: vec![quote] });
                    hard = true;
                    break;
                }
                if hard {
                    break;
                }
            }
            if !hard {
                let long = &blocks[random.below(blocks.len())];
                let start = (long.split_whitespace().count() as f64 * 0.15) as usize;
                if let Some(quote) = words_from(long, start, 70) {
                    let cleaned = strip_label(&quote);
                    out.push(Seed { shape: "long-range", opinion: 0, block: long.clone(), quotes: vec![if cleaned.is_empty() { quote } else { cleaned }] });
                }
            }
            let mut order = (0..blocks.len()).collect::<Vec<_>>();
            for at in (1..order.len()).rev() {
                order.swap(at, random.below(at + 1));
            }
            for index in order {
                let block = &blocks[index];
                let count = block.split_whitespace().count();
                if count < 32 {
                    continue;
                }
                let unique = |quote: &str| block.matches(quote).count() == 1;
                let Some(first) = words_from(block, 2, 9).map(|quote| strip_label(&quote)) else { continue };
                if first.split_whitespace().count() < 6 || !unique(&first) {
                    continue;
                }
                let (least, most) = (2 + 9 + 10, count - 9);
                if least > most {
                    continue;
                }
                let middle = (count / 2).max(least);
                let base = if middle > most { least } else { middle };
                let second = [base, base + 3, base.saturating_sub(5).max(least), least, most.saturating_sub(4)].into_iter()
                    .filter(|start| (least..=most).contains(start))
                    .filter_map(|start| words_from(block, start, 9).map(|quote| strip_label(&quote)))
                    .find(|quote| quote.split_whitespace().count() >= 6 && *quote != first && unique(quote));
                if let Some(second) = second {
                    out.push(Seed { shape: "multi-directive", opinion: 0, block: block.clone(), quotes: vec![first, second] });
                    break;
                }
            }
        }
        // A judge's quotation is a seed where the case's own records hold it, as quoted-seeds.mts keeps only quotations
        // the quotation check finds in their source: its pieces between elisions, in order, letters and digits alone.
        let letters = |text: &str| text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
        let records = structures.iter().flatten().map(|structure| letters(structure.query_text())).collect::<Vec<_>>();
        let elision = regex::Regex::new(r"\.\s?\.\s?\.|…|\*\s\*\s\*").unwrap();
        let held = |quote: &str| records.iter().any(|record| {
            let mut from = 0;
            elision.split(quote).map(letters).filter(|piece| !piece.is_empty()).all(|piece| match record[from..].find(&piece) {
                Some(at) => { from += at + piece.len(); true }
                None => false,
            })
        });
        for quote in pins.iter().filter(|quote| held(quote)).take(2) {
            out.push(Seed { shape: "real-quote", opinion: 0, block: quote.clone(), quotes: vec![quote.clone()] });
        }
        out
    }

    pub fn main() {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        if args.first().map(String::as_str) != Some("plan") {
            eprintln!("courtlistener-fragments plan --pack FILE --clusters FILE --pages FILE --out FILE [--pins FILE] [--part tune|judge|all]");
            return;
        }
        std::panic::set_hook(Box::new(|_| {}));
        let wanted_part = flag(&args, "--part").unwrap_or_else(|| "all".to_owned());
        // --dump CLUSTER FILE: that page's text as planned, to read beside the exam.
        let dump = args.iter().position(|arg| arg == "--dump").map(|at| (args[at + 1].parse::<u64>().unwrap(), args[at + 2].clone()));
        // Where each opinion stands in the pack: a case is read when it is reached, so the whole pack is never in memory.
        let pack = flag(&args, "--pack").expect("--pack FILE");
        let mut lines = HashMap::<u64, Vec<(u64, usize)>>::new();
        {
            let (mut reader, mut line, mut at) = (BufReader::new(File::open(&pack).unwrap()), String::new(), 0u64);
            while { line.clear(); reader.read_line(&mut line).unwrap_or(0) > 0 } {
                if line.ends_with("}\n") {
                    if let Some(cluster) = serde_json::from_str::<Value>(&line).ok()
                        .and_then(|row| serde_json::from_str::<Value>(row["files"]["fields.json"].as_str()?).ok())
                        .and_then(|fields| fields["cluster_id"].as_str()?.parse::<u64>().ok()) {
                        lines.entry(cluster).or_default().push((at, line.len()));
                    }
                }
                at += line.len() as u64;
            }
        }
        eprintln!("clusters in the pack {}", lines.len());
        let mut clusters = HashMap::<u64, Value>::new();
        for row in BufReader::new(File::open(flag(&args, "--clusters").expect("--clusters FILE")).unwrap()).lines().map_while(Result::ok)
            .filter_map(|line| serde_json::from_str::<Value>(&line).ok()) {
            if let Some(id) = row["id"].as_u64() { clusters.insert(id, row); }
        }
        let mut pins = HashMap::<u64, Vec<String>>::new();
        if let Some(file) = flag(&args, "--pins") {
            for row in BufReader::new(File::open(file).unwrap()).lines().map_while(Result::ok).filter_map(|line| serde_json::from_str::<Value>(&line).ok()) {
                if let (Some(cluster), Some(quote)) = (row["cluster"].as_str().and_then(|id| id.parse().ok()), row["quote"].as_str()) {
                    pins.entry(cluster).or_default().push(quote.to_owned());
                }
            }
        }
        let mut pages = BufReader::new(File::open(flag(&args, "--pages").expect("--pages FILE")).unwrap()).lines().map_while(Result::ok)
            .filter_map(|line| serde_json::from_str::<Value>(&line).ok()).filter_map(|row| Some((row["cluster"].as_u64()?, row["url"].as_str()?.to_owned()))).collect::<Vec<_>>();
        pages.sort_unstable();
        let mut pack = File::open(&pack).unwrap();
        let mut out = BufWriter::new(File::create(flag(&args, "--out").expect("--out FILE")).unwrap());
        let texts = flag(&args, "--texts").map(|file| std::sync::Mutex::new(BufWriter::new(File::create(file).unwrap())));
        let mut tally = std::collections::BTreeMap::<String, u64>::new();
        for (cluster, url) in pages {
            let part = part_of(cluster);
            if wanted_part != "all" && wanted_part != part { continue; }
            let Some(places) = lines.get(&cluster) else {
                *tally.entry("page with no bulk record".to_owned()).or_default() += 1;
                continue;
            };
            let mut opinions = places.iter().filter_map(|(at, length)| {
                pack.seek(SeekFrom::Start(*at)).ok()?;
                let mut bytes = vec![0; *length];
                pack.read_exact(&mut bytes).ok()?;
                let row = serde_json::from_slice::<Value>(&bytes).ok()?;
                let files = &row["files"];
                let fields = serde_json::from_str::<Value>(files["fields.json"].as_str()?).ok()?;
                let file = |name: &str| files[name].as_str().unwrap_or("").to_owned();
                let field = |name: &str| fields[name].as_str().unwrap_or("").to_owned();
                let record = CourtListenerOpinion {
                    id: row["id"].as_str()?.parse().ok()?, kind: field("type"), author_str: field("author_str"),
                    has_author: !field("author_id").is_empty(), extracted_by_ocr: field("extracted_by_ocr") == "t",
                    html_with_citations: file("html_with_citations.html"), xml_harvard: file("xml_harvard.xml"),
                    xml_scan: file("xml_scan.xml"), html: file("html.html"), html_columbia: file("html_columbia.html"),
                    html_lawbox: file("html_lawbox.html"), html_anon_2020: file("html_anon_2020.html"), plain_text: file("plain_text.txt"),
                };
                Some(Opinion {
                    id: row["id"].as_str()?.to_owned(), kind: fields["type"].as_str().unwrap_or("").to_owned(),
                    markup: MARKUP.iter().find_map(|name| files[*name].as_str().filter(|text| !text.is_empty()).map(str::to_owned)),
                    plain: files["plain_text.txt"].as_str().map(str::to_owned),
                    record,
                })
            }).collect::<Vec<_>>();
            // The order seeds are drawn in (the page prints its own, courtlistener_page.rs).
            opinions.sort_by(|left, right| left.kind.cmp(&right.kind).then(left.markup.is_none().cmp(&right.markup.is_none()))
                .then(left.id.len().cmp(&right.id.len())).then(left.id.cmp(&right.id)));
            let fields = clusters.get(&cluster);
            let field = |name: &str| fields.and_then(|row| row[name].as_str()).unwrap_or("").to_owned();
            let record = CourtListenerCluster {
                source: field("source"), case_name: field("case_name"), case_name_full: field("case_name_full"),
                case_name_short: field("case_name_short"), date_filed: field("date_filed"), judges: field("judges"),
                posture: field("posture"), nature_of_suit: field("nature_of_suit"), other_dates: field("other_dates"),
                precedential_status: field("precedential_status"), headmatter: field("headmatter"), correction: field("correction"),
                attorneys: field("attorneys"), headnotes: field("headnotes"), syllabus: field("syllabus"), summary: field("summary"),
                history: field("history"), disposition: field("disposition"),
                opinions: opinions.iter().map(|opinion| opinion.record.clone()).collect(),
            };
            let done = catch_unwind(AssertUnwindSafe(|| {
                let page = CourtListenerPage::new(&record);
                if let Some(dump) = dump.as_ref() {
                    if dump.0 == cluster { std::fs::write(&dump.1, page.text()).unwrap(); }
                }
                // --texts FILE: each page's text as planned, the words above its opinion article and the article's own
                // (courtlistener-page-text.py holds them beside Chrome's).
                if let Some(texts) = texts.as_ref() {
                    let start = page.article_start();
                    let row = json!({ "cluster": cluster, "url": url, "above": &page.text()[..start], "article": &page.text()[start..] });
                    writeln!(texts.lock().unwrap(), "{row}").unwrap();
                    if args.iter().any(|arg| arg == "--no-links") {
                        return Vec::new();
                    }
                }
                let structures = opinions.iter().map(structure_of).collect::<Vec<_>>();
                let queries = structures.iter().map(|_| DocumentQuery::new()).collect::<Vec<_>>();
                let mut random = Random(cluster.wrapping_mul(0x9E3779B97F4A7C15) | 1);
                let mut rows = Vec::new();
                let cited = pins.get(&cluster).map_or(&[][..], Vec::as_slice);
                for (index, seed) in seeds(&structures, cited, &mut random).into_iter().enumerate() {
                    let quotes = seed.quotes.clone();
                    let existing = structures[seed.opinion].as_ref().and_then(|structure| passage_link(&queries[seed.opinion], structure, &PassageLinkRequest {
                        url: url.clone(), anchor: None, block_text: seed.block.clone(), quotes: quotes.clone(),
                        prefer_independent_html_blocks: false, verified_pdf: None,
                    }));
                    let anchors = ["page", "block", "section", "note"].map(|kind| (kind, page.anchor_before(&seed.block, &seed.quotes[0], kind).map(|anchor| anchor.id.clone())));
                    let linked = courtlistener_link(&page, &url, None, &seed.block, &quotes);
                    rows.push(json!({
                        "label": format!("{cluster}_{index}_{}", seed.shape), "shape": seed.shape, "part": part, "cluster": cluster,
                        "opinions": opinions.len(), "rendition": opinions[seed.opinion].markup.as_deref().map_or("plain", |markup| if markup.contains("<pre") { "pre" } else if markup.contains("<opinion") { "harvard" } else { "html" }),
                        "url": url, "quotes": quotes, "blockText": seed.block,
                        "existing": existing.map(|link| link.target), "page": linked.as_ref().map(|link| link.target.clone()),
                        "complete": linked.and_then(|link| link.plan).map(|plan| plan.source_safe_complete),
                        "anchors": Value::Object(anchors.into_iter().filter_map(|(kind, id)| Some((kind.to_owned(), Value::String(id?)))).collect()),
                    }));
                }
                rows
            }));
            match done {
                Ok(rows) => {
                    *tally.entry("pages".to_owned()).or_default() += 1;
                    *tally.entry("links".to_owned()).or_default() += rows.len() as u64;
                    for row in rows {
                        writeln!(out, "{row}").unwrap();
                    }
                }
                Err(_) => *tally.entry("panic".to_owned()).or_default() += 1,
            }
        }
        out.flush().unwrap();
        eprintln!("{}", serde_json::to_string(&tally).unwrap());
    }
}
