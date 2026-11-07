//! Gold from Canadian judgments that A2AJ also holds: each PDF read once by the installed parser, its lines aligned word by
//! word with A2AJ's text of the same decision, the alignment kept as one record per PDF, and the gold read off the records.
//! What the page prints decides, never A2AJ's text. WORK is A2AJ_GOLD_WORK, default E:/OpenLegalData/a2aj-gold.
//! `a2aj-gold <step>`; the bound volumes' step is the `a2aj-volumes` bin, the citing judges' check of a page sheet `reporter-pins`.
mod book;
mod conventions;
mod corpus;
pub mod freeze;
pub mod gold_store;
mod label;
mod make;
mod modes;
pub mod page;
mod pairing;
mod pairs;
mod pdf;
mod printed;
mod quality;
pub mod record;
pub mod store;
mod words;

use std::path::PathBuf;

const USAGE: &str = "a2aj-gold <step>

  pairs [--by-citation [COLLECTION ...]] [--no-register]
                                            PDFs paired with their A2AJ decision -> WORK/pairs.jsonl, by the court's item number;
                                            --by-citation adds PDFs without one (of these corpus collections, or all), by the
                                            citation on their first pages and the words they share, and lists the rest with
                                            why -> WORK/unpaired.jsonl
  read [--part K/N] [--export DIR]          the product's reading of each pair's PDF -> WORK/read/<sha>.json (A2AJ_GOLD_READ/<sha>.json
                                            where that names another work folder's readings); --part K/N takes every Nth pair from
                                            the Kth, --export DIR stages that part to read on another machine
  read-list LIST OUT                        the PDFs LIST names (one `<sha256>\\t<path>` line each) read -> OUT/<sha256>.json
  align [--only S ...] [--limit N] [--threads N]
                                            align every read pair without a current record -> WORK/records/<sha>.json.gz
  text-layer                                each line of a scan's records with its exact text -> WORK/text-layers/<sha>.json
  gold [--check] [--only S ...] [--stage DIR [--all]] [--mode M] [--limit N] [--labels-only]
                                            structure gold of every record that passes the gates -> THE gold store (structure/
                                            a2aj-a), checked first against the store's own gold of the PDFs it already holds, and
                                            the store registered; --stage DIR writes the sources the store lacks there, in the
                                            store's layout, --all the sources it holds from this aligner too; --labels-only leaves
                                            out the rules that read the page
  register                                  the store recorded in the corpus registry
  diff A B OUT [--records]                  two golds folders (or, --records, two records folders) compared, document by document
                                            -> OUT/diff.jsonl and a summary, by mode and layout
  quality OUT [--golds DIR]                 each gold of the stage DIR, or of the store, measured against its page and its record
                                            -> OUT/quality.jsonl and a summary, by mode and layout
  repair [--only S ...] [--write] [--ledger FILE] [--changes FILE]
                                            the store's aligned golds put right against their pages; dry unless --write
  hand FILE [--write] [--ledger FILE]       repairs read off the page by hand (a JSON list), each checked against its line's words
  passages                                  each numbered paragraph and quotation A2AJ reads, placed on the PDF's lines, and where
                                            the report's pages begin -> WORK/passages/<sha>.json
  report                                    the records' alignment, refusals and each mode's output
  freeze [--write] [--sha PREFIX] [--rows FILE]
                                            each gold's answer key written into it (freeze.rs)
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

pub fn run(args: &[String]) -> Result<(), String> {
    let Some(command) = args.first() else { return Err(USAGE.to_owned()) };
    let rest = &args[1..];
    let work = store::work();
    let only = values(rest, "--only").unwrap_or_default();
    match command.as_str() {
        "pairs" => pairs::pairs(&work, values(rest, "--by-citation"), !rest.iter().any(|arg| arg == "--no-register")),
        "read" => modes::read(&work, &value(rest, "--part").unwrap_or_else(|| "1/1".to_owned()), value(rest, "--export").map(PathBuf::from)),
        "read-list" => modes::read_list(PathBuf::from(rest.first().ok_or(USAGE)?).as_path(), PathBuf::from(rest.get(1).ok_or(USAGE)?).as_path()),
        "register" => store::register().map(|counts| println!("registered {counts}")),
        "diff" => match rest {
            [a, b, out, ..] => quality::diff(a.as_ref(), b.as_ref(), out.as_ref(), rest.iter().any(|arg| arg == "--records")),
            _ => Err(USAGE.to_owned()),
        },
        "quality" => {
            let out = rest.first().filter(|arg| !arg.starts_with("--")).ok_or(USAGE)?;
            quality::quality(&work, out.as_ref(), value(rest, "--golds").map(PathBuf::from))
        }
        "align" => {
            let threads = value(rest, "--threads").map(|n| n.parse().map_err(|_| "--threads takes a number")).transpose()?;
            let limit = value(rest, "--limit").map(|n| n.parse().map_err(|_| "--limit takes a number")).transpose()?;
            let done = corpus::align_all(&work, &store::a2aj_db(), &only, limit, threads)?;
            println!("{} aligned, {} failed in {:.1} s on {} threads (reading {:.1} s, aligning {:.1} s over the threads, writing {:.1} s)", done["aligned"], done["failed"],
                     done["seconds"].as_f64().unwrap_or(0.0), done["threads"], done["reading_seconds"].as_f64().unwrap_or(0.0), done["aligning_seconds"].as_f64().unwrap_or(0.0), done["writing_seconds"].as_f64().unwrap_or(0.0));
            Ok(())
        }
        "freeze" => {
            legalpdf::install_structure_analysis(&legal_structure::STRUCTURE_ANALYSIS);
            freeze::freeze(rest.iter().any(|arg| arg == "--write"), value(rest, "--sha").as_deref().unwrap_or(""), value(rest, "--rows").as_deref().map(std::path::Path::new));
            Ok(())
        }
        "text-layer" => modes::text_layer(&work),
        "gold" => make::gold(&work, make::GoldArgs { check: rest.iter().any(|arg| arg == "--check"), only, stage: value(rest, "--stage").map(PathBuf::from), all: rest.iter().any(|arg| arg == "--all"),
                                                          mode: value(rest, "--mode"), limit: value(rest, "--limit").map(|n| n.parse().map_err(|_| "--limit takes a number")).transpose()?,
                                                          labels_only: rest.iter().any(|arg| arg == "--labels-only"),
                                                          threads: value(rest, "--threads").map(|n| n.parse().map_err(|_| "--threads takes a number")).transpose()? }),
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

