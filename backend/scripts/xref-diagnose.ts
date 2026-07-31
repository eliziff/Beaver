/**
 * Why is a document's section inventory thin? Question-blind diagnostic:
 * reports which detector claimed each section, whether a statute spine won,
 * and what the top unresolved locators are.
 *
 *   npx tsx scripts/xref-diagnose.ts <source> [substring]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compileAgreementSkeleton } from "../src/lib/legalTextSkeleton";
import { crossReferenceGraph } from "../src/lib/legalCrossReference";
import { computeStatuteSpine } from "../src/lib/statuteSpine";

const ROOT = join(process.cwd(), "../benchmarks/legalbench_rag/data/mini/corpus");
const [source, needle = ""] = process.argv.slice(2);
const dir = join(ROOT, source);

for (const file of readdirSync(dir).sort()) {
  if (!file.endsWith(".txt") || !file.includes(needle)) continue;
  const text = readFileSync(join(dir, file), "utf8");
  const skeleton = compileAgreementSkeleton(text, file);
  const graph = crossReferenceGraph(text, file, { skeleton, integrityThreshold: 0 });
  const spine = computeStatuteSpine(text);
  const lines = text.split("\n");
  const spaceRuns = (text.match(/(?<=\S)[ \t]{2,}(?=\S)/gu) ?? []).length;

  console.log(`\n=== ${file}`);
  console.log(
    `chars=${text.length} lines=${lines.length} meanLine=${Math.round(text.length / lines.length)} ` +
      `innerSpaceRuns=${spaceRuns} spineMarks=${spine.length} ` +
      `spineLabels=${spine.slice(0, 12).map((m) => m.label).join(",")}`,
  );
  const kinds: Record<string, number> = {};
  for (const node of skeleton.nodes) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
  console.log(`nodes=${JSON.stringify(kinds)} integrity=${graph.counts.integrity.toFixed(3)}`);
  console.log(
    `sections: ${skeleton.nodes
      .filter((n) => n.kind === "section")
      .map((n) => n.label)
      .slice(0, 40)
      .join(" ")}`,
  );
  const missed = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.status !== "unresolved" && edge.reason !== "depth_not_numbered") continue;
    const key = `${edge.status}/${edge.reason}:${edge.normalizedLocator}`;
    missed.set(key, (missed.get(key) ?? 0) + 1);
  }
  console.log(
    `top misses: ${[...missed]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
      .map(([k, n]) => `${k}x${n}`)
      .join("  ")}`,
  );
}
