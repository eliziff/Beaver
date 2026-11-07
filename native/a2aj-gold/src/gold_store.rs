//! The structure gold store as its readers read it: each judgment's gold (its run "a"), a gold's lines, and the JSON lines
//! files the runs keep. Shared by the gold steps, the answer key (freeze.rs) and pinpoint-corpus.
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// A judgment's gold in the store: its run "a" (`<batch>-a`); its other runs are agreement and model trials.
pub struct GoldSource {
    pub sha: String,
    pub gold: PathBuf,
    pub layout: String,
    pub pdf: String,
}

pub fn gold_sources() -> Vec<GoldSource> {
    let root = crate::store::repo().join("benchmarks/local-data/gold");
    let mut folders: Vec<PathBuf> = fs::read_dir(&root).unwrap_or_else(|e| panic!("{}: {e}", root.display()))
        .flatten().map(|entry| entry.path()).filter(|path| path.join("source.json").is_file()).collect();
    folders.sort();
    folders.iter().filter_map(|folder| {
        let source = fs::read(folder.join("source.json")).ok()?;
        let meta = serde_json::from_slice::<Value>(&source).ok()?;
        if meta["genre_group"] != "judgment" {
            return None;
        }
        let gold = fs::read_dir(folder.join("structure")).into_iter().flatten().flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with("-a"))
            .map(|entry| entry.path().join("gold.json.gz")).find(|path| path.is_file())?;
        Some(GoldSource { sha: folder.file_name()?.to_string_lossy().into_owned(), gold, layout: meta["language_layout"].as_str().unwrap_or("?").to_owned(),
            pdf: meta["pdf"].as_str().unwrap_or_default().to_owned() })
    }).collect()
}

pub struct GoldLine {
    pub id: String,
    pub page: u64,
    pub bbox: [f64; 4],
    pub text: Vec<char>,
}

pub fn gold_lines(gold: &Value) -> Vec<GoldLine> {
    gold["lines"].as_array().map(Vec::as_slice).unwrap_or_default().iter().map(|line| {
        let at = |n: usize| line["bbox"][n].as_f64().unwrap_or(0.0);
        GoldLine {
            id: line["id"].as_str().unwrap_or_default().to_owned(),
            page: line["page"].as_u64().unwrap_or(0),
            bbox: [at(0), at(1), at(2), at(3)],
            text: line["text"].as_str().unwrap_or_default().chars().collect(),
        }
    }).collect()
}

pub fn items(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// The place in its count of the item a line opens: "1)" 1, "(b)" 2, "C." 3.
pub fn list_item(line: &str) -> Option<usize> {
    let mut tokens = line.split_whitespace();
    let token = tokens.next()?;
    // (Not a citation's opening: "c. N.1.", "c. F-9".)
    if tokens.next().is_some_and(|word| word.contains(|c: char| c.is_ascii_digit())) {
        return None;
    }
    let inner = token.strip_suffix(['.', ')'])?.trim_start_matches('(');
    match inner.parse::<usize>() {
        Ok(number) => Some(number),
        Err(_) => (inner.len() == 1).then(|| inner.chars().next()).flatten().filter(char::is_ascii_alphabetic).map(|letter| letter.to_ascii_lowercase() as usize - 'a' as usize + 1),
    }
}

pub fn rows_of(path: &Path) -> Vec<Value> {
    File::open(path).map(|file| BufReader::new(file).lines().map_while(Result::ok).filter_map(|line| serde_json::from_str(&line).ok()).collect()).unwrap_or_default()
}
