/**
 * Receipt integrity for the grounding / retrieval experiment harnesses.
 *
 * Receipts are append-only evidence: an experiment log pins their sha256,
 * and every verdict in docs/legal-grounding-experiments-2026-07-30.md
 * resolves through one. A harness that truncates its default output path
 * on every non-resume run can therefore destroy a cited artifact with no
 * warning — which is how `stage18-retrieval-arms.jsonl` was lost on
 * 2026-07-30 (a re-run took the default path because `--output` was wired
 * into only one sweep mode, and the pinned sha stopped resolving).
 *
 * Shared home rather than three copies: all three harnesses
 * (legalbench-retrieval-ablate, legalbench-rag-grounding,
 * legal-grounding-experiment) write JSONL receipts under the same
 * discipline, and the guard is only worth anything if it is uniform.
 *
 * Also home to the resume keys, for the same reason. A resume key is a
 * cell's IDENTITY: every dimension that changes what a cell means belongs
 * in it, or `--resume` reads a row written under other conditions as
 * "already done" and the file silently mixes two experiments.
 */
import { existsSync } from "node:fs";

/**
 * Resolve a harness's receipt destination and refuse to clobber it.
 *
 * `--output <path>` always wins, in every sweep mode; otherwise
 * `defaultPath`. An existing file throws unless `--force` is passed or
 * `resume` is set (resume APPENDS to the file and skips the cells it
 * already holds, so it is the one non-destructive way to reopen one).
 */
export function receiptPath(
  defaultPath: string,
  options: { argv?: string[]; resume?: boolean } = {},
): string {
  const argv = options.argv ?? process.argv;
  const at = argv.indexOf("--output");
  if (at >= 0 && (at + 1 >= argv.length || argv[at + 1].startsWith("--")))
    throw new Error("--output needs a path");
  const output = at >= 0 ? argv[at + 1] : defaultPath;
  if (options.resume) return output;
  if (existsSync(output) && !argv.includes("--force"))
    throw new Error(
      `refusing to overwrite an existing receipt: ${output}\n` +
        "pass --output <newfile> for a fresh run, --resume 1 to continue " +
        "this one, or --force if you really mean to replace it",
    );
  return output;
}

/**
 * The per-document cap a legalbench-rag-grounding row ran at, for rows
 * written before `--per-doc-cap` existed. It is fully determined by the
 * retriever label, so pre-fix receipts stay resumable instead of being
 * re-run wholesale:
 *   product           no cap concept
 *   passage:pool(...) injected pool, `slice(0, k)`, no cap at all
 *   passage:t.../+rerank  perDocCap 24 (set only when reranking)
 *   passage:t...      searchPassages' default of 2
 */
export function legacyPerDocCap(retriever: string): string {
  if (!retriever.startsWith("passage")) return "n/a";
  if (retriever.startsWith("passage:pool(")) return "uncapped";
  return retriever.includes("+rerank(") ? "24" : "2";
}

export type LegalbenchRagCell = {
  /** Corpus coordinate space; absent on pre-fix raw-CRLF rows. */
  coords?: string;
  model: string;
  effort: string;
  /** Prompt-module arm; absent only on rows written before the flag. */
  arm?: string;
  k: number;
  retriever?: string;
  per_doc_cap?: number | null;
  test_id: string;
};

/**
 * Resume identity of a legalbench-rag-grounding cell.
 *
 * `arm` was written to the row but LEFT OUT of the key, so --coverage,
 * --spec, --plain and --exclude-gold all changed the prompt (and, for
 * --exclude-gold, the evidence) while changing nothing the key could see:
 * a resume would have declared those cells done. `per_doc_cap` joins it
 * for the same reason (P0.1). Missing fields fall back to what the row's
 * own labels prove it ran under, so old receipts stay resumable:
 * `coords` absent = the raw-CRLF instrument, which is a DIFFERENT cell
 * from an LF one and must never satisfy it.
 */
export function legalbenchRagCellKey(row: LegalbenchRagCell): string {
  const retriever = row.retriever ?? "product";
  return [
    row.coords ?? "crlf",
    row.model,
    row.effort,
    row.arm ?? "required_slot",
    row.k,
    retriever,
    row.per_doc_cap === undefined
      ? legacyPerDocCap(retriever)
      : String(row.per_doc_cap ?? "n/a"),
    row.test_id,
  ].join("|");
}

export type LegalGroundingCell = {
  model: string;
  effort: string;
  arm: string;
  checker_model?: string | null;
  case_id: string;
  rank_policy?: string | null;
};

/**
 * Resume identity of a legal-grounding-experiment cell. This harness had
 * `arm` in its key but not `effort`, which already forced a Stage 13 lane
 * onto a separate output file; every row records `effort`, so adding it
 * keeps same-effort resumes matching and correctly separates the ladder.
 */
export function legalGroundingCellKey(row: LegalGroundingCell): string {
  return [
    row.model,
    row.effort,
    row.arm,
    row.checker_model ?? "same",
    row.case_id,
    row.rank_policy ?? "-",
  ].join("|");
}
