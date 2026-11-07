//! Gold from Canadian judgments that A2AJ also holds: each PDF read once by the installed parser, its lines aligned word by
//! word with A2AJ's text of the same decision, the alignment kept as one record per PDF, and the gold read off the records.
//! What the page prints decides, never A2AJ's text. WORK is A2AJ_GOLD_WORK, default E:/OpenLegalData/a2aj-gold.
mod book;
mod conventions;
mod corpus;
mod label;
mod make;
mod modes;
mod page;
mod pairing;
mod pairs;
mod pdf;
mod printed;
mod record;
mod store;
mod words;

use std::path::PathBuf;

#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

const USAGE: &str = "a2aj-align <command>

  pairs [--by-citation [COLLECTION ...]]    PDFs paired with their A2AJ decision -> WORK/pairs.jsonl, by the court's item number;
                                            --by-citation adds PDFs without one (of these corpus collections, or all), by the
                                            citation on their first pages and the words they share, and lists the rest with
                                            why -> WORK/unpaired.jsonl
  read [--part K/N] [--export DIR]          the product's reading of each pair's PDF -> WORK/read/<sha>.json; --part K/N takes every
                                            Nth pair from the Kth, --export DIR stages that part to read on another machine
  align [--only S ...] [--limit N] [--threads N]
                                            align every read pair without a current record -> WORK/records/<sha>.json.gz
  text-layer                                each line of a scan's records with its exact text -> WORK/text-layers/<sha>.json
  gold [--check] [--only S ...] [--stage DIR] [--mode M] [--limit N]
                                            structure gold of every record that passes the gates -> THE gold store (structure/
                                            a2aj-a), checked first against the store's own gold of the PDFs it already holds;
                                            --stage DIR writes the sources the store lacks there, in the store's layout
  repair [--only S ...] [--write] [--ledger FILE] [--changes FILE]
                                            the store's aligned golds put right against their pages; dry unless --write
  hand FILE [--write] [--ledger FILE]       repairs read off the page by hand (a JSON list), each checked against its line's words
  passages                                  each numbered paragraph and quotation A2AJ reads, placed on the PDF's lines, and where
                                            the report's pages begin -> WORK/passages/<sha>.json
  report                                    the records' alignment, refusals and each mode's output
  proof OUT [--lines N] [--paragraphs N] [--words N] [--seed N]
                                            proof sheets: lines, paragraphs and words cropped from their pages, A2AJ's text beside";

/// The values after an option, to the next option.
fn values(args: &[String], name: &str) -> Option<Vec<String>> {
    let at = args.iter().position(|arg| arg == name)?;
    Some(args[at + 1..].iter().take_while(|arg| !arg.starts_with("--")).cloned().collect())
}

fn value(args: &[String], name: &str) -> Option<String> {
    values(args, name)?.into_iter().next()
}

fn number(args: &[String], name: &str, default: usize) -> Result<usize, String> {
    value(args, name).map_or(Ok(default), |given| given.parse().map_err(|_| format!("{name} takes a number")))
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else { return Err(USAGE.to_owned()) };
    let rest = &args[1..];
    let work = store::work();
    let only = values(rest, "--only").unwrap_or_default();
    match command.as_str() {
        "pairs" => pairs::pairs(&work, values(rest, "--by-citation")),
        "read" => modes::read(&work, &value(rest, "--part").unwrap_or_else(|| "1/1".to_owned()), value(rest, "--export").map(PathBuf::from)),
        "align" => {
            let threads = value(rest, "--threads").map(|n| n.parse().map_err(|_| "--threads takes a number")).transpose()?;
            let limit = value(rest, "--limit").map(|n| n.parse().map_err(|_| "--limit takes a number")).transpose()?;
            let done = corpus::align_all(&work, &store::a2aj_db(), &only, limit, threads)?;
            println!("{} aligned, {} failed in {:.1} s on {} threads (reading {:.1} s, aligning {:.1} s over the threads, writing {:.1} s)", done["aligned"], done["failed"],
                     done["seconds"].as_f64().unwrap_or(0.0), done["threads"], done["reading_seconds"].as_f64().unwrap_or(0.0), done["aligning_seconds"].as_f64().unwrap_or(0.0), done["writing_seconds"].as_f64().unwrap_or(0.0));
            Ok(())
        }
        "text-layer" => modes::text_layer(&work),
        "gold" => make::gold(&work, make::GoldArgs { check: rest.iter().any(|arg| arg == "--check"), only, stage: value(rest, "--stage").map(PathBuf::from), mode: value(rest, "--mode"),
                                                          limit: value(rest, "--limit").map(|n| n.parse().map_err(|_| "--limit takes a number")).transpose()? }),
        "repair" => make::repair(&work, make::RepairArgs { only, write: rest.iter().any(|arg| arg == "--write"),
                                                           ledger: value(rest, "--ledger").map_or_else(|| PathBuf::from("E:/OpenLegalData/a2aj-gold-next/repairs.jsonl"), PathBuf::from),
                                                           changes: value(rest, "--changes").map(PathBuf::from) }),
        "hand" => make::hand(PathBuf::from(rest.first().ok_or(USAGE)?).as_path(), value(rest, "--ledger").map_or_else(|| PathBuf::from("E:/OpenLegalData/a2aj-gold-next/repairs.jsonl"), PathBuf::from).as_path(), rest.iter().any(|arg| arg == "--write")),
        "passages" => modes::passages(&work),
        "report" => modes::report(&work),
        "proof" => {
            let out = rest.first().filter(|arg| !arg.starts_with("--")).ok_or(USAGE)?;
            modes::proof(&work, PathBuf::from(out).as_path(), number(rest, "--lines", 24)?, number(rest, "--paragraphs", 12)?, number(rest, "--words", 0)?, number(rest, "--seed", 1)? as u64)
        }
        _ => Err(USAGE.to_owned()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
