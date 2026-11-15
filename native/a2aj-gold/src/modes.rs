//! What else the records give: the reading, the OCR text layers, the passages, the report, and proof sheets.
use super::label::nodes;
use super::make::{a2aj, a2aj_text, read_pairs, Listings};
use super::pdf;
use super::record::CODE;
use super::store;
use super::words::{edit_distance, words_of};

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

const PLACED: f64 = 0.9; // a paragraph or quotation is placed when this share of its words is
static CALL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(\w)\[(\d{1,3})\]").unwrap());

fn record_paths(work: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = fs::read_dir(work.join("records")).into_iter().flatten().flatten().map(|entry| entry.path())
        .filter(|path| path.to_string_lossy().ends_with(".json.gz")).collect();
    paths.sort();
    paths
}

fn round4(share: f64) -> f64 {
    format!("{share:.4}").parse().unwrap()
}

/// A PDF read as the product reads it (`legalpdf::gold_structure_inputs`: the extraction, Indra recognition, which
/// LEGALPDF_INDRA_MODEL_PACK and LEGALPDF_ONNXRUNTIME must name, the PP-DocLayout layout model where LEGALPDF_PPDOC_MODEL_PACK does)
/// into the one extraction cache the grader reads (`store::readings`: the engine keeps it, recognition beside it, so no
/// page is read twice). False where the reading was there already.
fn read_one(sha: &str, pdf: &Path, out: &Path, images: bool) -> Result<bool, String> {
    let kept = store::reading(sha).is_file();
    if !kept {
        legalpdf::gold_structure_inputs(pdf, sha, &store::readings_root()).map_err(|e| e.to_string())?;
    }
    // (A digital PDF's images, which the gold's page rules read, are found in its bytes, once.)
    if images && !store::images_path(sha).is_file() {
        store::keep_images(sha, &fs::read(pdf).map_err(|e| format!("{}: {e}", pdf.display()))?);
    }
    Ok(!kept)
}

/// The PDFs of LIST (one `<sha256>\t<path>` line each) read on `threads` cores into OUT; a PDF read already is skipped, so a
/// stopped run resumes. The smallest go first, so a long run has read the most PDFs it can at any hour it is stopped.
fn read_all(pdfs: &[(String, PathBuf, bool)], out: &Path, threads: usize) -> Result<(), String> {
    fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let mut order: Vec<(u64, &(String, PathBuf, bool))> = pdfs.iter().map(|entry| (fs::metadata(&entry.1).map_or(0, |m| m.len()), entry)).collect();
    order.sort_by_key(|(size, _)| *size);
    let (next, read_count, failed) = (AtomicUsize::new(0), AtomicUsize::new(0), AtomicUsize::new(0));
    let started = std::time::Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            scope.spawn(|| loop {
                let n = next.fetch_add(1, Ordering::Relaxed);
                let Some((_, (sha, pdf, images))) = order.get(n) else { break };
                let begun = std::time::Instant::now();
                match catch_unwind(AssertUnwindSafe(|| read_one(sha, pdf, out, *images))).unwrap_or_else(|_| Err("the reader panicked".to_owned())) {
                    Ok(true) => {
                        let done = read_count.fetch_add(1, Ordering::Relaxed) + 1;
                        eprintln!("{}/{} {sha} {:.1}s ({done} read in {:.0}s)", n + 1, order.len(), begun.elapsed().as_secs_f64(), started.elapsed().as_secs_f64());
                    }
                    Ok(false) => {}
                    Err(error) => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        eprintln!("{}/{} {sha} FAILED {error}", n + 1, order.len());
                    }
                }
            });
        }
    });
    eprintln!("{} read, {} failed, of {} in {:.0}s -> {}", read_count.into_inner(), failed.into_inner(), pdfs.len(), started.elapsed().as_secs_f64(), out.display());
    Ok(())
}

fn threads_or_cores(threads: Option<usize>) -> usize {
    threads.unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
}

/// The PDFs LIST names read into OUT (another machine's part of a `read --export`).
pub fn read_list(list: &Path, out: &Path, threads: Option<usize>) -> Result<(), String> {
    let list = fs::read_to_string(list).map_err(|e| format!("{}: {e}", list.display()))?;
    let pdfs: Vec<(String, PathBuf, bool)> = list.lines().filter_map(|line| line.split_once('\t')).map(|(sha, path)| (sha.to_owned(), PathBuf::from(path), false)).collect();
    read_all(&pdfs, out, threads_or_cores(threads))
}

/// The product's reading of every pair without one, in this machine's part of them, on `threads` cores; `export` stages
/// another machine's part instead: its PDFs, the list, this program and its models, and read.cmd to run there, whose read/
/// folder is then copied into the readings.
pub fn read(work: &Path, part: &str, export: Option<PathBuf>, threads: Option<usize>) -> Result<(), String> {
    let (k, n) = part.split_once('/').and_then(|(k, n)| Some((k.parse::<usize>().ok()?, n.parse::<usize>().ok()?))).ok_or("--part K/N")?;
    let pairs = read_pairs(work, &[])?;
    let sha = |pair: &Value| pair["sha256"].as_str().unwrap_or("").to_owned();
    let todo: Vec<&Value> = pairs.iter().enumerate().filter(|(i, pair)| i % n == k - 1 && !store::reading(&sha(pair)).is_file()).map(|(_, pair)| pair).collect();
    if let Some(stage) = export {
        let reader = std::env::current_exe().map_err(|e| e.to_string())?;
        let runtime = store::repo().join("legal-pdf-parser/runtime");
        fs::create_dir_all(stage.join("pdfs")).map_err(|e| e.to_string())?;
        for pair in &todo {
            fs::copy(store::pdf_of(pair), stage.join("pdfs").join(format!("{}.pdf", sha(pair)))).map_err(|e| e.to_string())?;
        }
        let list: String = todo.iter().map(|pair| format!("{0}\tpdfs\\{0}.pdf\n", sha(pair))).collect();
        fs::write(stage.join("read.list"), list).map_err(|e| e.to_string())?;
        fs::copy(&reader, stage.join("a2aj-gold.exe")).map_err(|e| e.to_string())?;
        for model in ["indra", "onnx"] {
            copy_tree(&runtime.join(model), &stage.join("runtime").join(model))?;
        }
        fs::write(stage.join("read.cmd"), "cd /d %~dp0\r\nset LEGALPDF_INDRA_MODEL_PACK=%~dp0runtime\\indra\r\nset LEGALPDF_ONNXRUNTIME=%~dp0runtime\\onnx\\onnxruntime.dll\r\nstart /belownormal /wait a2aj-gold.exe read-list read.list read\r\n").map_err(|e| e.to_string())?;
        // Started through WMI, the reading outlives the session that starts it (an ssh login).
        fs::write(stage.join("start.ps1"), "$command = \"cmd.exe /c `\"`\"$PSScriptRoot\\read.cmd`\" > `\"$PSScriptRoot\\read.log`\" 2>&1`\"\"\n$started = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $PSScriptRoot }\n\"started process $($started.ProcessId) (return $($started.ReturnValue))\"\n").map_err(|e| e.to_string())?;
        println!("{} PDFs staged in {}: copy it there and run start.ps1 (powershell -File), then copy its read\\ into {}", todo.len(), stage.display(), store::readings().display());
        return Ok(());
    }
    let pdfs: Vec<(String, PathBuf, bool)> = todo.iter().map(|pair| (sha(pair), store::pdf_of(pair), pair["mode"] == "digitalborn")).collect();
    read_all(&pdfs, &store::readings(), threads_or_cores(threads))
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The lines our recognizer read, each with its exact text: OCR training data (the line's crop, the words it prints).
/// A line's exact text is A2AJ's words for it (a note's call set against its word as the page sets it), which A2AJ may itself
/// have from a recognizer: it is `trusted` where the alignment paired every word the scan reads with one of A2AJ's, and every
/// word A2AJ sets that the scan does not is a word A2AJ's text sets three times or more across the records (or figures).
/// Each source carries its partition (the store's, where the store holds it, else the aligner's); test's are left out.
pub fn text_layer(work: &Path) -> Result<(), String> {
    let root = store::store_root();
    let stored = |sha: &str| -> Option<String> {
        let source: Value = serde_json::from_str(&fs::read_to_string(root.join(sha).join("source.json")).ok()?).ok()?;
        source["partition"].as_str().map(str::to_owned)
    };
    let paths = record_paths(work);
    // A2AJ's vocabulary, as the records align its text to the pages.
    let mut counts: HashMap<String, u32> = HashMap::new();
    for path in &paths {
        let record = store::read_json(path)?;
        for line in record["lines"].as_array().into_iter().flatten() {
            for (word, _, _) in words_of(line["exact"].as_str().unwrap_or(""), 0) {
                *counts.entry(word).or_default() += 1;
            }
        }
    }
    let known = |word: &str| counts.get(word).copied().unwrap_or(0) >= 3 || word.chars().all(|c| c.is_ascii_digit());
    let mut written = 0;
    for path in &paths {
        let record = store::read_json(path)?;
        let sha = record["pair"]["sha256"].as_str().unwrap_or("");
        if !record["verdict"]["refused"].is_null() {
            continue;
        }
        let partition = stored(sha).unwrap_or_else(|| super::make::partition(&record["pair"]).to_owned());
        if partition == "test" {
            continue;
        }
        let lines: Vec<Value> = record["lines"].as_array().into_iter().flatten().filter(|line| line["source"] == "ocr").map(|line| {
            let printed = line["text"].as_str().unwrap_or("");
            let given = line["exact"].as_str().filter(|text| !text.is_empty());
            // (A2AJ brackets a note's call the page sets against its word: "Jones[10]" for "Jones10".)
            let exact = given.map_or_else(|| printed.to_owned(), |given| if CALL.is_match(printed) { given.to_owned() } else { CALL.replace_all(given, "$1$2").into_owned() });
            let words = words_of(printed, 0);
            let read: BTreeSet<&str> = words.iter().map(|word| word.0.as_str()).collect();
            // Every word the recognizer read stands for one of A2AJ's in the alignment's pairs, and every word A2AJ sets that the
            // scan does not is one its text sets often (a recognizer's lost word, not another text's).
            let pairs: Vec<(u64, u64)> = line["words"].as_array().into_iter().flatten().map(|pair| (pair[0].as_u64().unwrap_or(0), pair[1].as_u64().unwrap_or(0))).collect();
            let paired = words.iter().all(|word| pairs.iter().any(|&(a, b)| a < word.2 as u64 && (word.1 as u64) < b));
            let trusted = given.is_some() && line["status"] != "unmatched" && paired
                && words_of(&exact, 0).iter().filter(|word| !read.contains(word.0.as_str())).all(|word| known(&word.0));
            json!({"id": line["id"], "page": line["page"], "bbox": line["bbox"], "ocr": line["text"], "exact": exact, "trusted": trusted,
                   "status": line["status"], "lang": line["lang"], "span": line["span"]})
        }).collect();
        if lines.is_empty() {
            continue;
        }
        let spaced = |text: &Value| text.as_str().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
        let (mut errors, mut total) = (0usize, 0usize);
        let mut stats = Map::new();
        for line in &lines {
            let status = line["status"].as_str().unwrap_or("");
            let count = stats.entry(status.to_owned()).or_insert(json!(0));
            *count = json!(count.as_u64().unwrap() + 1);
            if status != "unmatched" {
                let (ocr, exact): (Vec<char>, Vec<char>) = (spaced(&line["ocr"]).chars().collect(), spaced(&line["exact"]).chars().collect());
                errors += edit_distance(&ocr, &exact);
                total += exact.len();
            }
        }
        stats.insert("ocr_char_agreement".into(), json!(round4(1.0 - errors as f64 / total.max(1) as f64)));
        stats.insert("trusted_lines".into(), json!(lines.iter().filter(|line| line["trusted"] == true).count()));
        let value = json!({"source_sha256": sha, "partition": partition, "pdf_path": record["pair"]["path"], "a2aj": record["pair"], "reading": record["reading"], "pages": record["pages"],
                           "languages": record["verdict"]["by_language"], "lines": lines, "stats": stats});
        store::write_atomic(&work.join("text-layers").join(format!("{sha}.json")), value.to_string().as_bytes())?;
        written += 1;
    }
    println!("{written} text layers -> {}", work.join("text-layers").display());
    Ok(())
}

/// The PDF's lines that print [start, end) of a language's text: [line id, page, first, last offset] each, and the share of
/// its words they place.
fn placed(record: &Value, language: &str, text: &str, start: usize, end: usize) -> (Vec<Value>, f64) {
    let text_words = words_of(text, start).into_iter().filter(|word| word.1 < end).count();
    let (mut on, mut order, mut at): (HashMap<&str, (u64, u64, &Value)>, Vec<&str>, BTreeSet<u64>) = (HashMap::new(), Vec::new(), BTreeSet::new());
    for line in record["lines"].as_array().into_iter().flatten() {
        if line["lang"] != language {
            continue;
        }
        let id = line["id"].as_str().unwrap_or("");
        for word in line["words"].as_array().into_iter().flatten() {
            let (begin, finish, a) = (word[0].as_u64().unwrap_or(0), word[1].as_u64().unwrap_or(0), word[2].as_u64().unwrap_or(0));
            if start as u64 <= a && a < end as u64 {
                at.insert(a);
                match on.get_mut(id) {
                    Some(held) => { held.0 = held.0.min(begin); held.1 = held.1.max(finish); }
                    None => { on.insert(id, (begin, finish, &line["page"])); order.push(id); }
                }
            }
        }
    }
    let lines = order.iter().map(|id| { let held = &on[id]; json!([id, held.2, held.0, held.1]) }).collect();
    (lines, round4(at.len() as f64 / text_words.max(1) as f64))
}

/// Each numbered paragraph and quotation of A2AJ's reading, in every language the PDF prints, with the PDF lines that print it,
/// and where the report's pages begin.
pub fn passages(work: &Path) -> Result<(), String> {
    let db = a2aj()?;
    let pairs = read_pairs(work, &[])?;
    let keys: BTreeSet<String> = pairs.iter().flat_map(|p| p["languages"].as_array().into_iter().flatten()
        .map(|l| format!("{}:{}", p["a2aj"].to_string().trim_matches('"'), l.as_str().unwrap_or("")))).collect();
    let found = Listings::of(&keys)?;
    let mut written: BTreeMap<String, u64> = BTreeMap::new();
    for path in record_paths(work) {
        let record = store::read_json(&path)?;
        if !record["verdict"]["refused"].is_null() {
            continue;
        }
        let pair = &record["pair"];
        let (sha, main, id) = (pair["sha256"].as_str().unwrap_or(""), record["verdict"]["main"].as_str().unwrap_or(""), pair["a2aj"].to_string().trim_matches('"').to_owned());
        let (mut paragraphs, mut quotations) = (Vec::new(), Vec::new());
        let breaks = record["page_breaks"].as_object().cloned().unwrap_or_default();
        for language in breaks.keys() {
            let Some(listing) = found.read(&format!("{id}:{language}"))? else {
                *written.entry(format!("no census listing ({language})")).or_default() += 1;
                continue;
            };
            let text = a2aj_text(&db, rusqlite::types::Value::Integer(pair["a2aj"].as_i64().unwrap_or(0)), language)?.unwrap_or_default();
            let chars: Vec<char> = text.chars().collect();
            for node in nodes(&listing)?.0 {
                let numbered = node.kind == "paragraph" && node.label.starts_with("par");
                if !numbered && node.kind != "quote" {
                    continue;
                }
                let (lines, share) = placed(&record, language, &text, node.start, node.end);
                let said: String = chars[node.start.min(chars.len())..node.end.min(chars.len())].iter().collect();
                let unit = json!({"lang": language, "number": numbered.then(|| node.label.chars().skip(3).collect::<String>()), "span": [node.start, node.end],
                                  "text": said.trim(), "placed": share, "exact": share >= PLACED, "lines": lines});
                if numbered { paragraphs.push(unit) } else { quotations.push(unit) }
            }
        }
        let languages: BTreeSet<&String> = breaks.keys().collect();
        let value = json!({"source_sha256": sha, "pdf_path": pair["path"], "citation": pair["citation"], "language": main, "languages": languages,
                           "paragraphs": paragraphs, "quotations": quotations, "page_breaks": breaks.get(main).cloned().unwrap_or(json!([]))});
        store::write_atomic(&work.join("passages").join(format!("{sha}.json")), value.to_string().as_bytes())?;
        *written.entry("written".to_owned()).or_default() += 1;
    }
    println!("passages: {written:?} -> {}", work.join("passages").display());
    Ok(())
}

pub fn report(work: &Path) -> Result<(), String> {
    let (mut count, mut aligned, mut other_code) = (0u64, 0u64, 0u64);
    let (mut refused, mut status, mut kinds, mut unmatched, mut missing): (BTreeMap<String, u64>, BTreeMap<String, u64>, BTreeMap<String, u64>, BTreeMap<String, u64>, BTreeMap<String, u64>) = Default::default();
    let mut covered: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let digits = regex::Regex::new(r"[\d.]+%").unwrap();
    let add = |from: &Value, into: &mut BTreeMap<String, u64>| for (key, n) in from.as_object().into_iter().flatten() { *into.entry(key.clone()).or_default() += n.as_u64().unwrap_or(0); };
    // Each record read on its own core, down to what the report counts of it: its verdict, its code and its words' kinds.
    // (Read once for each record's bytes: what it counts is kept beside the records, by the bytes' digest.)
    let summaries = store::on_cores_with(&record_paths(work), || Ok(()), |path, _| {
        let file = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let key = store::hex(&<sha2::Sha256 as sha2::Digest>::digest(&file));
        let made_path = work.join("report-made").join(path.file_name().unwrap_or_default()).with_extension("").with_extension("json");
        if let Ok(made) = store::read_json(&made_path) {
            if made["key"] == key.as_str() {
                let kinds: BTreeMap<String, u64> = made["kinds"].as_object().into_iter().flatten().map(|(k, n)| (k.clone(), n.as_u64().unwrap_or(0))).collect();
                return Ok((made["verdict"].clone(), made["code"] == CODE.as_str(), kinds));
            }
        }
        let record: Value = serde_json::from_slice(&store::gunzip(&file)?).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut kinds: BTreeMap<String, u64> = BTreeMap::new();
        for line in record["lines"].as_array().into_iter().flatten() {
            for word in line["words"].as_array().into_iter().flatten() {
                *kinds.entry(word[4].as_str().unwrap_or("").to_owned()).or_default() += 1;
            }
        }
        store::write_atomic(&made_path, &serde_json::to_vec(&json!({"key": key, "verdict": record["verdict"], "code": record["code"], "kinds": kinds})).map_err(|e| e.to_string())?)?;
        Ok((record["verdict"].clone(), record["code"] == CODE.as_str(), kinds))
    })?;
    for (verdict, same_code, words) in &summaries {
        for (kind, n) in words {
            *kinds.entry(kind.clone()).or_default() += n;
        }
        count += 1;
        other_code += (!same_code) as u64;
        match verdict["refused"].as_str() {
            Some(reason) => *refused.entry(digits.replace_all(reason, "N%").into_owned()).or_default() += 1,
            None => aligned += 1,
        }
        add(&verdict["status"], &mut status);
        add(&verdict["unmatched"], &mut unmatched);
        for whys in verdict["unplaced"].as_object().into_iter().flatten() {
            add(whys.1, &mut missing);
        }
        let not_printed = verdict["not_printed"].as_array().cloned().unwrap_or_default();
        for (language, share) in verdict["coverage"].as_object().into_iter().flatten() {
            if !not_printed.iter().any(|lang| lang == language.as_str()) {
                covered.entry(language.clone()).or_default().push(share.as_f64().unwrap_or(0.0));
            }
        }
    }
    println!("{count} records ({other_code} made by other code than this): {aligned} aligned, refused {refused:?}");
    println!("  readings in {}", store::readings().display());
    for (language, shares) in &mut covered {
        shares.sort_by(f64::total_cmp);
        println!("  coverage of {language} where printed: {} records, median {}, lowest {:?}", shares.len(), shares[shares.len() / 2], &shares[..shares.len().min(5)]);
    }
    println!("  lines {status:?}; unmatched {unmatched:?}");
    println!("  words {kinds:?}; unplaced {missing:?}");
    let (mut exact, mut paragraphs) = (0u64, 0u64);
    for folder in ["text-layers", "passages"] {
        let files: Vec<PathBuf> = fs::read_dir(work.join(folder)).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "json")).collect();
        println!("  {folder}: {}", files.len());
        if folder == "passages" {
            for file in files {
                let value = store::read_json(&file)?;
                for paragraph in value["paragraphs"].as_array().into_iter().flatten() {
                    paragraphs += 1;
                    exact += (paragraph["exact"] == true) as u64;
                }
            }
        }
    }
    if paragraphs > 0 {
        println!("  paragraphs placed exactly {exact} of {paragraphs}");
    }
    Ok(())
}

/// A seeded shuffle's numbers.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n.max(1) as u64) as usize
    }

    fn shuffle<T>(&mut self, items: &mut [T]) {
        for k in (1..items.len()).rev() {
            let other = self.below(k + 1);
            items.swap(k, other);
        }
    }
}

const WORD_KINDS: [&str; 6] = ["exact", "fuzzy", "forced", "split", "merged", "moved"];

struct Rendered {
    png: String,
    caption: String,
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The page region holding `rects` (in the reading's units, scaled to the PDF's page), `mark` boxed in red, as a PNG in OUT.
fn crop(bytes: &[u8], record: &Value, page: i64, rects: &[[f64; 4]], mark: Option<[f64; 4]>, out: &Path, name: &str) -> Option<String> {
    const DPI: f32 = 160.0;
    let (width, height, pixels) = pdf::render_page(bytes, page as usize - 1, DPI)?;
    let size = &record["pages"][page.to_string()];
    let k = DPI as f64 / 72.0;
    let (sx, sy) = (width as f64 / k / size[0].as_f64()?, height as f64 / k / size[1].as_f64()?);
    let low = |at: usize, by: f64, pad: f64| rects.iter().map(|r| r[at]).fold(f64::MAX, f64::min) * by - pad;
    let high = |at: usize, by: f64, pad: f64| rects.iter().map(|r| r[at]).fold(f64::MIN, f64::max) * by + pad;
    let (x0, y0, x1, y1) = (low(0, sx, 6.0), low(1, sy, 4.0), high(2, sx, 6.0), high(3, sy, 4.0));
    let (px0, py0) = (((x0 * k) as u32).min(width as u32 - 1), ((y0 * k) as u32).min(height as u32 - 1));
    let (pw, ph) = ((((x1 - x0) * k) as u32).clamp(1, width as u32 - px0), (((y1 - y0) * k) as u32).clamp(1, height as u32 - py0));
    let whole = image::RgbaImage::from_raw(width as u32, height as u32, pixels)?;
    let mut image = image::imageops::crop_imm(&whole, px0, py0, pw, ph).to_image();
    if let Some(mark) = mark {
        let at = |v: f64, by: f64, from: f64| ((v * by - from) * k) as i64;
        let (a, b, c, d) = (at(mark[0], sx, x0) - 2, at(mark[1], sy, y0) - 2, at(mark[2], sx, x0) + 2, at(mark[3], sy, y0) + 2);
        let red = image::Rgba([255, 0, 0, 255]);
        for x in a..=c {
            for y in [b, b + 1, d - 1, d] {
                if x >= 0 && y >= 0 && (x as u32) < pw && (y as u32) < ph { image.put_pixel(x as u32, y as u32, red); }
            }
        }
        for y in b..=d {
            for x in [a, a + 1, c - 1, c] {
                if x >= 0 && y >= 0 && (x as u32) < pw && (y as u32) < ph { image.put_pixel(x as u32, y as u32, red); }
            }
        }
    }
    image.save(out.join(name)).ok()?;
    Some(name.to_owned())
}

fn bbox(line: &Value) -> [f64; 4] {
    [0, 1, 2, 3].map(|n| line["bbox"][n].as_f64().unwrap_or(0.0))
}

fn draw<T: Clone>(pools: &mut [(usize, Vec<T>)], count: usize, rng: &mut Rng) -> Vec<(usize, T)> {
    for (_, pool) in pools.iter_mut() {
        rng.shuffle(pool);
    }
    let (mut picks, mut at) = (Vec::new(), 0);
    while picks.len() < count && pools.iter().any(|(_, pool)| !pool.is_empty()) {
        let (record, pool) = &mut pools[at % pools.len()];
        at += 1;
        if let Some(pick) = pool.pop() {
            picks.push((*record, pick));
        }
    }
    picks
}

fn sheet(out: &Path, name: &str, rows: &[Rendered]) -> Result<(), String> {
    let body: String = rows.iter().enumerate().map(|(n, row)| format!("<figure><figcaption>{} {}</figcaption><img src=\"{}\"></figure>\n", n + 1, html_escape(&row.caption), row.png)).collect();
    fs::write(out.join(name), format!("<!doctype html><meta charset=utf-8><style>body{{font:14px sans-serif;max-width:1060px}}figure{{margin:0 0 18px}}img{{max-width:1000px;display:block}}figcaption{{color:#00c;white-space:pre-wrap}}</style>\n{body}")).map_err(|e| e.to_string())
}

/// Proof sheets, drawn round-robin over the documents (seeded), each cropped from its page image, to be read against the
/// picture: lines and numbered paragraphs with A2AJ's text beside them (OUT/lines.txt, OUT/sheet.html), and words of each kind
/// of pairing, the word boxed in its line and A2AJ's word above it (OUT/words-<kind>.html, OUT/words.txt). OUT is scratch.
pub fn proof(work: &Path, out: &Path, lines: usize, paragraphs: usize, words: usize, seed: u64) -> Result<(), String> {
    fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
    // Each pick is another document's: the first few of the seeded order are all that is drawn from, so a set's records stay on disk.
    let mut paths = record_paths(work);
    rng.shuffle(&mut paths);
    let wanted = lines + paragraphs + words * WORD_KINDS.len();
    let mut records: Vec<Value> = Vec::with_capacity(wanted);
    for path in paths {
        if records.len() == wanted {
            break;
        }
        let record = store::read_json(&path)?;
        if record["verdict"]["refused"].is_null() {
            records.push(record);
        }
    }
    let db = a2aj()?;
    let mut texts: HashMap<(usize, String), Vec<char>> = HashMap::new();
    let mut opened: HashMap<usize, Vec<u8>> = HashMap::new();
    let bytes_of = |r: usize, opened: &mut HashMap<usize, Vec<u8>>, records: &[Value]| -> Vec<u8> {
        opened.entry(r).or_insert_with(|| fs::read(records[r]["pair"]["path"].as_str().unwrap_or("")).unwrap_or_default()).clone()
    };
    let mut line_pools: Vec<(usize, Vec<Value>)> = records.iter().enumerate().map(|(r, record)| (r, record["lines"].as_array().into_iter().flatten()
        .filter(|l| l["status"] != "unmatched" && l["exact"].as_str().unwrap_or("").split_whitespace().count() >= 2).cloned().collect())).collect();
    let mut passage_pools: Vec<(usize, Vec<Value>)> = Vec::new();
    for (r, record) in records.iter().enumerate() {
        let path = work.join("passages").join(format!("{}.json", record["pair"]["sha256"].as_str().unwrap_or("")));
        if path.is_file() {
            let value = store::read_json(&path)?;
            passage_pools.push((r, value["paragraphs"].as_array().into_iter().flatten().filter(|p| p["lines"].as_array().is_some_and(|l| !l.is_empty())).cloned().collect()));
        }
    }
    let (mut rows, mut notes): (Vec<Rendered>, Vec<String>) = (Vec::new(), Vec::new());
    for (r, line) in draw(&mut line_pools, lines, &mut rng) {
        let bytes = bytes_of(r, &mut opened, &records);
        let record = &records[r];
        let name = format!("line-{}.png", rows.len() + 1);
        if let Some(png) = crop(&bytes, record, line["page"].as_i64().unwrap_or(1), &[bbox(&line)], None, out, &name) {
            let note = format!("[line {}/{}] {} {}\n     pdf:  {}\n     a2aj: {}", line["status"].as_str().unwrap_or(""), line["lang"].as_str().unwrap_or(""), record["pair"]["citation"].as_str().unwrap_or(""),
                               line["id"].as_str().unwrap_or(""), line["text"].as_str().unwrap_or(""), line["exact"].as_str().unwrap_or(""));
            rows.push(Rendered { png, caption: note.clone() });
            notes.push(note);
        }
    }
    for (r, paragraph) in draw(&mut passage_pools, paragraphs, &mut rng) {
        let bytes = bytes_of(r, &mut opened, &records);
        let record = &records[r];
        let boxes: HashMap<&str, [f64; 4]> = record["lines"].as_array().into_iter().flatten().map(|l| (l["id"].as_str().unwrap_or(""), bbox(l))).collect();
        let held = paragraph["lines"].as_array().cloned().unwrap_or_default();
        let first = held[0][1].as_i64().unwrap_or(1);
        let rects: Vec<[f64; 4]> = held.iter().filter(|l| l[1].as_i64() == Some(first)).filter_map(|l| boxes.get(l[0].as_str().unwrap_or("")).copied()).collect();
        let pages: BTreeSet<i64> = held.iter().filter_map(|l| l[1].as_i64()).collect();
        let name = format!("paragraph-{}.png", rows.len() + 1);
        if let Some(png) = crop(&bytes, record, first, &rects, None, out, &name) {
            let said: String = paragraph["text"].as_str().unwrap_or("").chars().take(600).collect();
            let note = format!("[paragraph {}, placed {:.0}%, page {first} of {pages:?}] {}\n     a2aj: {said}", paragraph["number"].as_str().unwrap_or(""), paragraph["placed"].as_f64().unwrap_or(0.0) * 100.0, record["pair"]["citation"].as_str().unwrap_or(""));
            rows.push(Rendered { png, caption: note.clone() });
            notes.push(note);
        }
    }
    sheet(out, "sheet.html", &rows)?;
    let listing: String = notes.iter().enumerate().map(|(n, note)| format!("{:2} {note}", n + 1)).collect::<Vec<_>>().join("\n");
    fs::write(out.join("lines.txt"), listing).map_err(|e| e.to_string())?;
    println!("{} proofs: {} and sheet.html", notes.len(), out.join("lines.txt").display());
    if words == 0 {
        return Ok(());
    }
    let mut listing = Vec::new();
    for kind in WORD_KINDS {
        let mut pools: Vec<(usize, Vec<(Value, [f64; 4], (usize, usize))>)> = Vec::new();
        for (r, record) in records.iter().enumerate() {
            let mut found = Vec::new();
            for line in record["lines"].as_array().into_iter().flatten() {
                let Some(language) = line["lang"].as_str() else { continue };
                let key = (r, language.to_owned());
                if !texts.contains_key(&key) {
                    let text = a2aj_text(&db, rusqlite::types::Value::Integer(record["pair"]["a2aj"].as_i64().unwrap_or(0)), language)?.unwrap_or_default();
                    texts.insert(key.clone(), text.chars().collect());
                }
                let text = &texts[&key];
                let boxes: Vec<(u64, u64, [f64; 4])> = line["boxes"].as_array().into_iter().flatten().map(|b| (b[0].as_u64().unwrap_or(0), b[1].as_u64().unwrap_or(0), [2, 3, 4, 5].map(|n| b[n].as_f64().unwrap_or(0.0)))).collect();
                let mut by_pdf: BTreeMap<(u64, u64), Vec<(usize, usize, String)>> = BTreeMap::new();
                for word in line["words"].as_array().into_iter().flatten() {
                    by_pdf.entry((word[0].as_u64().unwrap_or(0), word[1].as_u64().unwrap_or(0))).or_default().push((word[2].as_u64().unwrap_or(0) as usize, word[3].as_u64().unwrap_or(0) as usize, word[4].as_str().unwrap_or("").to_owned()));
                }
                for ((s, e), spans) in by_pdf {
                    let Some(place) = boxes.iter().find(|b| b.0 == s && b.1 == e).or_else(|| boxes.iter().find(|b| b.0 <= s && s < b.1)).map(|b| b.2) else { continue };
                    let (a, b, own) = spans[0].clone();
                    let inside = a > 0 && text[a - 1].is_alphanumeric() || b < text.len() && text[b].is_alphanumeric();
                    let of = if line["status"] == "moved" { "moved" } else if spans.len() > 1 { "merged" } else if inside { "split" } else { own.as_str() };
                    if of == kind {
                        found.push((line.clone(), place, (a, spans[spans.len() - 1].1)));
                    }
                }
            }
            pools.push((r, found));
        }
        let mut rows = Vec::new();
        for (r, (line, place, (a, b))) in draw(&mut pools, words, &mut rng) {
            let bytes = bytes_of(r, &mut opened, &records);
            let record = &records[r];
            let language = line["lang"].as_str().unwrap_or("").to_owned();
            let text: String = texts[&(r, language)][a..b].iter().collect();
            let name = format!("word-{kind}-{}.png", rows.len() + 1);
            if let Some(png) = crop(&bytes, record, line["page"].as_i64().unwrap_or(1), &[bbox(&line)], Some(place), out, &name) {
                listing.push(format!("{kind}\t{}\t{}\t{text}\t{}", record["pair"]["citation"].as_str().unwrap_or(""), line["id"].as_str().unwrap_or(""), line["text"].as_str().unwrap_or("")));
                rows.push(Rendered { png, caption: text });
            }
        }
        sheet(out, &format!("words-{kind}.html"), &rows)?;
    }
    let mut file = fs::File::create(out.join("words.txt")).map_err(|e| e.to_string())?;
    file.write_all(listing.join("\n").as_bytes()).map_err(|e| e.to_string())?;
    println!("{} word proofs: {} and words-<kind>.html", listing.len(), out.join("words.txt").display());
    Ok(())
}
