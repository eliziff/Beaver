/**
 * PROBE ONLY. Is a detected section inventory the document's STRUCTURE, or
 * its table of contents? A real spine's heads run from the front of the
 * instrument to its end; a table of contents repeats every label inside a
 * compressed prefix. Reports where the last section head sits as a fraction
 * of the document, and the median heading-to-heading distance.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compileAgreementSkeleton } from "../src/lib/legalTextSkeleton";
import { crossReferenceGraph } from "../src/lib/legalCrossReference";

const ROOT = join(process.cwd(), "../benchmarks/legalbench_rag/data/mini/corpus");
const SOURCES = ["contractnli", "cuad", "maud", "privacy_qa"] as const;

for (const source of SOURCES) {
  for (const file of readdirSync(join(ROOT, source)).sort()) {
    if (!file.endsWith(".txt")) continue;
    const text = readFileSync(join(ROOT, source, file), "utf8");
    const skeleton = compileAgreementSkeleton(text, file);
    const gated = crossReferenceGraph(text, file, { skeleton });
    const heads = skeleton.nodes
      .filter((n) => n.kind === "section")
      .map((n) => n.start)
      .sort((a, b) => a - b);
    if (!heads.length) continue;
    const gaps = heads.slice(1).map((s, i) => s - heads[i]).sort((a, b) => a - b);
    const medianGap = gaps.length ? gaps[gaps.length >> 1] : 0;
    // where the resolver's targets land
    const targets = gated.edges
      .filter((e) => e.status === "resolved" && e.targetStart !== null)
      .map((e) => e.targetStart!);
    const lastHead = heads[heads.length - 1] / text.length;
    const targetSpan = targets.length
      ? Math.max(...targets) / text.length
      : 0;
    const span = (heads[heads.length - 1] - heads[0]) / text.length;
    console.log(
      `${span.toFixed(4)}\t${source}\t${file.slice(0, 38)}\t` +
        `heads=${heads.length}\tlast=${lastHead.toFixed(2)}\tmedGap=${medianGap}\t` +
        `res=${gated.counts.resolved}\ttgtMax=${targetSpan.toFixed(2)}` +
        (gated.documentAbstained ? "\tREFUSED" : ""),
    );
  }
}
