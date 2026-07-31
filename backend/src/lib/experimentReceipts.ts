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
