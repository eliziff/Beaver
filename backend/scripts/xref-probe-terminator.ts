/**
 * PROBE ONLY. The single-space extraction dialect, retried with the guard
 * the first attempt lacked.
 *
 * The unsound version offered a line start before any head-shaped token. A
 * definitions index then minted a head out of every "'Balance Sheet Date'
 * has the meaning set forth in Section 6.16(a)". What separates that from a
 * real lost line break is what sits BEFORE it: a heading follows the end of
 * the previous line, so in a single-space join the character before the lost
 * newline is a sentence terminator. "set forth in Section 6.16" is preceded
 * by "in".
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compileAgreementSkeleton } from "../src/lib/legalTextSkeleton";
import { crossReferenceGraph } from "../src/lib/legalCrossReference";

const ROOT = join(process.cwd(), "../benchmarks/legalbench_rag/data/mini/corpus");
const SOURCES = ["contractnli", "cuad", "maud", "privacy_qa"] as const;

const HEAD_WORD =
  String.raw`(?:ARTICLE|Article|PART|Part|DIVISION|Division|SECTION|Section|SCHEDULE|Schedule|EXHIBIT|Exhibit|ANNEX|Annex|APPENDIX|Appendix)`;
const TERMINATOR = String.raw`(?<=[.;:][)"'”’]?)`;
const AHEAD =
  String.raw`(?=${HEAD_WORD}\s+[IVXLCDM\d]|\d{1,3}\.\d{1,3}(?:\.\d{1,3})*\s+\S|\(\w{1,3}\)\s)`;
const TERM_RE = new RegExp(`${TERMINATOR}[ \\t]${AHEAD}`, "gu");

const split = (text: string) => text.replace(TERM_RE, "\n");

const stat = (text: string, id: string) => {
  const skeleton = compileAgreementSkeleton(text, id);
  const g = crossReferenceGraph(text, id, { skeleton, integrityThreshold: 0 });
  const gated = crossReferenceGraph(text, id, { skeleton });
  const heads = skeleton.nodes.filter((n) => n.kind === "section");
  return {
    sec: heads.length,
    integ: g.counts.integrity,
    resolved: g.counts.resolved,
    refused: gated.documentAbstained,
  };
};

let base = 0;
let after = 0;
for (const source of SOURCES) {
  for (const file of readdirSync(join(ROOT, source)).sort()) {
    if (!file.endsWith(".txt")) continue;
    const text = readFileSync(join(ROOT, source, file), "utf8");
    const a = stat(text, file);
    const b = stat(split(text), file);
    if (a.refused) base += 1;
    const take = b.resolved > a.resolved;
    const chosen = take ? b : a;
    if (chosen.refused) after += 1;
    if (a.refused || chosen.refused || take) {
      console.log(
        `${source.padEnd(11)} ${file.slice(0, 38).padEnd(40)} ` +
          `base sec=${String(a.sec).padStart(4)} int=${a.integ.toFixed(2)} r=${String(a.resolved).padStart(4)}${a.refused ? " REF" : "    "} | ` +
          `term sec=${String(b.sec).padStart(4)} int=${b.integ.toFixed(2)} r=${String(b.resolved).padStart(4)}${b.refused ? " REF" : "    "} | ${take ? "TAKE" : "keep"}`,
      );
    }
  }
}
console.log(`\nrefused ${base}/69 -> ${after}/69`);
