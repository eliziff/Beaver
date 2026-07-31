/**
 * PROBE. When the compiler can only see a document's contents page, the
 * shipped answer is to refuse — because a contents line is not a provision
 * and following an edge to one lands a reader on a page number.
 *
 * But a contents page is the drafter's OWN outline, and an outline is
 * exactly what the registered navigation arm wants to hand a model. This
 * measures what is being thrown away: how many labelled headings the
 * contents reading carries against the reading actually kept.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compileAgreementSkeleton } from "../src/lib/legalTextSkeleton";

const ROOT =
  process.env.XREF_CORPUS ??
  join(process.cwd(), "../benchmarks/legalbench_rag/data/mini/corpus");

function recoverSpaceRuns(text: string): string {
  return text.replace(
    /(?<=\S)[ \t]([ \t]+)(?=\S)/gu,
    (_m, rest: string) => `\n${rest}`,
  );
}

const described = (text: string, id: string) => {
  const nodes = compileAgreementSkeleton(text, id).nodes.filter(
    (n) => n.kind === "section" || n.kind === "article",
  );
  return {
    heads: nodes.length,
    titled: nodes.filter((n) => n.heading.trim().length > 3).length,
  };
};

for (const source of readdirSync(ROOT).sort()) {
  for (const file of readdirSync(join(ROOT, source)).sort()) {
    if (!file.endsWith(".txt")) continue;
    const text = readFileSync(join(ROOT, source, file), "utf8");
    const kept = described(text, file);
    const contents = described(recoverSpaceRuns(text), file);
    if (contents.titled <= kept.titled) continue;
    console.log(
      `${source.padEnd(11)} ${file.slice(0, 44).padEnd(46)} ` +
        `kept ${String(kept.heads).padStart(4)} heads / ${String(kept.titled).padStart(4)} titled  ->  ` +
        `contents reading ${String(contents.heads).padStart(4)} / ${String(contents.titled).padStart(4)}`,
    );
  }
}
