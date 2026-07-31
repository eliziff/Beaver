/**
 * Cross-reference resolver census over the LegalBench-RAG mini corpus.
 *
 * Question-blind: reads only the corpus documents, never the benchmark gold.
 * Emits one JSON line per document (counts, skeleton inventory, refusal
 * reason) plus a summary object, so a run at two commits can be diffed.
 *
 *   npx tsx scripts/xref-census.ts <out.jsonl>
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileAgreementSkeleton } from "../src/lib/legalTextSkeleton";
import {
  crossReferenceGraph,
  DEFAULT_INTEGRITY_GATE,
} from "../src/lib/legalCrossReference";

const SPLIT = process.env.XREF_SPLIT ?? "mini";
const ROOT =
  process.env.XREF_CORPUS ??
  join(process.cwd(), `../benchmarks/legalbench_rag/data/${SPLIT}/corpus`);
const SOURCES = readdirSync(ROOT).sort();

interface Row {
  source: string;
  doc: string;
  chars: number;
  nodes: number;
  addressable: number;
  sections: number;
  subsections: number;
  containers: number;
  detected: number;
  resolved: number;
  unresolved: number;
  external: number;
  abstained: number;
  selfLoops: number;
  integrity: number;
  refused: boolean;
  refusal: "none" | "thin_skeleton" | "integrity_gate";
  ungatedResolved: number;
  ungatedUnresolved: number;
  reasons: Record<string, number>;
}

const rows: Row[] = [];

for (const source of SOURCES) {
  const dir = join(ROOT, source);
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".txt")) continue;
    const text = readFileSync(join(dir, file), "utf8");
    const skeleton = compileAgreementSkeleton(text, file);
    const gated = crossReferenceGraph(text, file, { skeleton });
    const ungated = crossReferenceGraph(text, file, {
      skeleton,
      integrityThreshold: 0,
    });
    const reasons: Record<string, number> = {};
    for (const edge of ungated.edges) {
      if (!edge.reason) continue;
      reasons[edge.reason] = (reasons[edge.reason] ?? 0) + 1;
    }
    const kinds = (kind: string) =>
      skeleton.nodes.filter((node) => node.kind === kind).length;
    const addressable = skeleton.nodes.filter((node) =>
      ["section", "subsection", "article", "part", "division", "schedule"].includes(
        node.kind,
      ),
    ).length;
    rows.push({
      source,
      doc: file,
      chars: text.length,
      nodes: skeleton.nodes.length,
      addressable,
      sections: kinds("section"),
      subsections: kinds("subsection"),
      containers: kinds("article") + kinds("part") + kinds("division"),
      detected: gated.counts.detected,
      resolved: gated.counts.resolved,
      unresolved: gated.counts.unresolved,
      external: gated.counts.external,
      abstained: gated.counts.abstained,
      selfLoops: gated.counts.selfLoops,
      integrity: Number(ungated.counts.integrity.toFixed(4)),
      refused: gated.documentAbstained,
      refusal: !gated.documentAbstained
        ? "none"
        : addressable < 3
          ? "thin_skeleton"
          : "integrity_gate",
      ungatedResolved: ungated.counts.resolved,
      ungatedUnresolved: ungated.counts.unresolved,
      reasons,
    });
  }
}

const sum = (rs: Row[], key: keyof Row) =>
  rs.reduce((total, row) => total + (row[key] as number), 0);

const perSource = SOURCES.map((source) => {
  const rs = rows.filter((row) => row.source === source);
  const accepted = sum(rs, "resolved") + sum(rs, "unresolved");
  return {
    source,
    docs: rs.length,
    refused: rs.filter((row) => row.refused).length,
    thinSkeleton: rs.filter((row) => row.refusal === "thin_skeleton").length,
    integrityGate: rs.filter((row) => row.refusal === "integrity_gate").length,
    detected: sum(rs, "detected"),
    resolved: sum(rs, "resolved"),
    unresolved: sum(rs, "unresolved"),
    external: sum(rs, "external"),
    abstained: sum(rs, "abstained"),
    missRate: accepted ? Number((sum(rs, "unresolved") / accepted).toFixed(4)) : 0,
  };
});

const accepted = sum(rows, "resolved") + sum(rows, "unresolved");
const summary = {
  gate: DEFAULT_INTEGRITY_GATE,
  docs: rows.length,
  refused: rows.filter((row) => row.refused).length,
  thinSkeleton: rows.filter((row) => row.refusal === "thin_skeleton").length,
  integrityGate: rows.filter((row) => row.refusal === "integrity_gate").length,
  detected: sum(rows, "detected"),
  resolved: sum(rows, "resolved"),
  unresolved: sum(rows, "unresolved"),
  external: sum(rows, "external"),
  abstained: sum(rows, "abstained"),
  missRate: accepted ? Number((sum(rows, "unresolved") / accepted).toFixed(4)) : 0,
  ungatedResolved: sum(rows, "ungatedResolved"),
  ungatedUnresolved: sum(rows, "ungatedUnresolved"),
  perSource,
};

const out = process.argv[2];
if (out) {
  writeFileSync(
    out,
    [...rows, { summary }].map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}
console.log(JSON.stringify(summary, null, 2));
console.log("\nrefused documents:");
for (const row of rows.filter((r) => r.refused)) {
  console.log(
    `  ${row.source.padEnd(12)} ${row.doc.slice(0, 58).padEnd(60)} ` +
      `sec=${String(row.sections).padStart(4)} sub=${String(row.subsections).padStart(4)} ` +
      `cont=${String(row.containers).padStart(3)} integ=${row.integrity.toFixed(2)} ` +
      `det=${String(row.detected).padStart(5)} ${row.refusal}`,
  );
}
