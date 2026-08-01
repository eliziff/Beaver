/**
 * Whole-observable-output digest of the structure detectors, over every wide
 * local corpus, so two commits can be diffed document by document.
 *
 * Question-blind and model-free: it reads corpus TEXT only, never benchmark
 * gold, and calls exactly two compilers —
 *
 *   compileAgreementSkeleton  (nodes, defined terms, schedules, cross-reference
 *                              summary, ladder diagnostics, SourceDoc ranges)
 *   compileA2AJSourceDoc      (A2AJ laws/cases blocks), where the corpus is A2AJ
 *
 * plus crossReferenceGraph's counts, because the same commit that made
 * segmentations compete also added the reach gate that consumes them.
 *
 *   npx tsx scripts/skeleton-digest.ts <out.tsv> [--limit N] [--corpus NAME]
 *
 * OUTPUT. `<out.tsv>` is one `<corpus>\t<id>\t<sha256>` line per document in
 * stable order, then a `# total <n>` trailer. `<out.tsv>.detail.jsonl` carries
 * the per-document facts a diff needs to CHARACTERIZE a hash change (node
 * counts by kind, head span, label list, whether the text has internal runs of
 * two or more spaces) without re-running either arm.
 *
 * REPRODUCIBILITY ACROSS ARMS. The corpora are gitignored, so a worktree at the
 * baseline commit has none of them. Every root is therefore absolute and
 * overridable, and the two derived inputs (the A2AJ laws parquet stride sample
 * and the unpacked LegalBench-RAG corpus) are frozen files that BOTH arms read:
 *
 *   SKELETON_DIGEST_BENCH        <repo>/benchmarks
 *   SKELETON_DIGEST_LEGALBENCH   unpacked LegalBench-RAG corpus/<source>/*.txt
 *   SKELETON_DIGEST_A2AJ_LAWS    jsonl: id, citation, name, text, sectionMap
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

import { crossReferenceGraph } from "../src/lib/legalCrossReference";
import { compileAgreementSkeleton } from "../src/lib/legalTextSkeleton";
import { compileA2AJSourceDoc } from "../src/lib/sourceDocA2AJ";

const BENCH =
  process.env.SKELETON_DIGEST_BENCH ??
  path.resolve(__dirname, "..", "..", "benchmarks");
const LEGALBENCH = process.env.SKELETON_DIGEST_LEGALBENCH ?? "";
const A2AJ_LAWS = process.env.SKELETON_DIGEST_A2AJ_LAWS ?? "";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
}
const LIMIT = Number(flag("limit") ?? "0") || Infinity;
const ONLY = flag("corpus");

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * The same predicate the recovery hypothesis keys on, restated here so BOTH
 * arms report it: an internal run of two or more spaces/tabs between two
 * non-whitespace characters is the only thing `recoverSpaceRuns` can act on,
 * so a document with none is a document the change cannot reach.
 */
const SPACE_RUN_RE = /(?<=\S)[ \t][ \t]+(?=\S)/gu;

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item instanceof Map ? [...item.entries()].sort() : item,
  ) as string;
}

interface Detail {
  corpus: string;
  id: string;
  chars: number;
  spaceRuns: number;
  nodes: number;
  kinds: Record<string, number>;
  headSpan: number;
  headFirst: number;
  headLast: number;
  definedTerms: number;
  schedules: number;
  xrefInternal: number;
  xrefExternal: number;
  xrefUnresolved: number;
  ladder: Record<string, number>;
  graphDetected: number;
  graphResolved: number;
  graphUnresolved: number;
  graphExternal: number;
  graphAbstained: number;
  graphRefused: boolean;
  graphNote: string | null;
  a2ajBlocks: number | null;
  a2ajCounts: Record<string, number> | null;
  labels: string[];
}

interface Row {
  corpus: string;
  id: string;
  sha256: string;
  detail: Detail;
}

function digest(corpus: string, id: string, text: string, a2aj?: {
  docType: "cases" | "laws";
  citation: string;
  name?: string | null;
  alternateCitation?: string | null;
  dataset?: string | null;
  sectionMap?: Record<string, string> | null;
}): Row {
  const skeleton = compileAgreementSkeleton(text, id);
  const graph = crossReferenceGraph(text, id, { skeleton });

  const nodes = skeleton.nodes.map((node) => [
    node.kind,
    node.label,
    node.display,
    node.heading,
    node.depth,
    node.start,
    node.end,
    node.parentLabel ?? null,
  ]);
  const observable: Record<string, unknown> = {
    nodes,
    definedTerms: skeleton.definedTerms.map((entry) => [
      entry.term,
      entry.sectionLabel,
      entry.definitions,
    ]),
    schedules: skeleton.schedules,
    crossReferences: skeleton.crossReferences,
    ladder: skeleton.ladder,
    doc: {
      status: skeleton.doc.status,
      blocks: skeleton.doc.blocks.map((block) => [
        block.kind,
        block.label,
        block.start,
        block.end,
        block.origin,
        (block.aliases ?? []).slice().sort(),
        block.parentLabel ?? null,
      ]),
      index: [...skeleton.doc.index.entries()].sort(),
      ranges: skeleton.doc.ranges,
    },
    graph: {
      abstained: graph.documentAbstained,
      note: graph.note,
      counts: graph.counts,
      edges: graph.edges.map((edge) => [
        edge.status,
        edge.sourceStart,
        edge.sourceEnd,
        edge.sourceLabel,
        edge.normalizedLocator,
        edge.targetLabel,
        edge.targetStart,
        edge.selfLoop,
        edge.reason ?? null,
      ]),
    },
  };

  let a2ajBlocks: number | null = null;
  let a2ajCounts: Record<string, number> | null = null;
  if (a2aj) {
    const doc = compileA2AJSourceDoc({
      citation: a2aj.citation,
      docType: a2aj.docType,
      text,
      id,
      dataset: a2aj.dataset ?? null,
      name: a2aj.name ?? null,
      alternateCitation: a2aj.alternateCitation ?? null,
      sectionMap: a2aj.sectionMap ?? null,
    });
    observable.a2aj = {
      status: doc.status,
      blocks: doc.blocks.map((block) => [
        block.kind,
        block.label,
        block.start,
        block.end,
        block.origin,
      ]),
      ranges: doc.ranges,
    };
    a2ajBlocks = doc.blocks.length;
    a2ajCounts = {
      paragraph: doc.ranges.paragraph.count,
      page: doc.ranges.page.count,
      section: doc.ranges.section.count,
    };
  }

  const kinds: Record<string, number> = {};
  for (const node of skeleton.nodes) kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
  const heads = skeleton.nodes.filter((node) => node.kind === "section");
  const headFirst = heads.length ? Math.min(...heads.map((n) => n.start)) : -1;
  const headLast = heads.length ? Math.max(...heads.map((n) => n.start)) : -1;

  return {
    corpus,
    id,
    sha256: createHash("sha256").update(canonical(observable), "utf8").digest("hex"),
    detail: {
      corpus,
      id,
      chars: text.length,
      spaceRuns: (text.match(SPACE_RUN_RE) ?? []).length,
      nodes: skeleton.nodes.length,
      kinds,
      headSpan:
        text.length && headLast >= 0
          ? Number(((headLast - headFirst) / text.length).toFixed(6))
          : 0,
      headFirst,
      headLast,
      definedTerms: skeleton.definedTerms.length,
      schedules: skeleton.schedules.length,
      xrefInternal: skeleton.crossReferences.internal,
      xrefExternal: skeleton.crossReferences.external,
      xrefUnresolved: skeleton.crossReferences.unresolved.length,
      ladder: { ...skeleton.ladder },
      graphDetected: graph.counts.detected,
      graphResolved: graph.counts.resolved,
      graphUnresolved: graph.counts.unresolved,
      graphExternal: graph.counts.external,
      graphAbstained: graph.counts.abstained,
      graphRefused: graph.documentAbstained,
      graphNote: graph.note ? graph.note.slice(0, 40) : null,
      a2ajBlocks,
      a2ajCounts,
      labels: skeleton.nodes.map((node) => `${node.kind}:${node.label}@${node.start}`),
    },
  };
}

// ---------------------------------------------------------------------------
// Corpora
// ---------------------------------------------------------------------------

/**
 * The tsv lines are kept (a few dozen bytes each, so 23,531 statutes is
 * nothing) and sorted at the end; the per-document detail — which carries the
 * full label list, and so scales with the size of the instrument — is streamed
 * to disk as it is produced. The whole-laws-corpus sweep does not fit in a
 * heap otherwise.
 */
const rows: Array<Omit<Row, "detail">> = [];
let seen = 0;
let detailStream: import("node:fs").WriteStream | null = null;

function emit(corpus: string, id: string, text: string, a2aj?: Parameters<typeof digest>[3]) {
  if (seen >= LIMIT) return;
  seen += 1;
  const row = digest(corpus, id, text, a2aj);
  rows.push({ corpus: row.corpus, id: row.id, sha256: row.sha256 });
  detailStream!.write(`${JSON.stringify(row.detail)}\n`);
  if (seen % 200 === 0) process.stderr.write(`  ${seen} documents\n`);
}

function wanted(corpus: string) {
  return !ONLY || ONLY === corpus;
}

function textFiles(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(extension))
    .sort();
}

async function readJsonl(file: string, each: (row: Record<string, unknown>) => void) {
  const stream = createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    if (!line.trim()) continue;
    each(JSON.parse(line) as Record<string, unknown>);
  }
}

async function main() {
  const out = process.argv[2];
  if (!out || out.startsWith("--")) throw new Error("usage: skeleton-digest.ts <out.tsv>");
  detailStream = createWriteStream(`${out}.detail.jsonl`, "utf8");

  // 1. LegalBench-RAG, the full 714-document contract corpus (the mini and
  //    holdout splits are subsets of it, so they are not walked separately).
  if (wanted("legalbench_rag") && LEGALBENCH && existsSync(LEGALBENCH)) {
    process.stderr.write("legalbench_rag\n");
    for (const source of readdirSync(LEGALBENCH).sort()) {
      const dir = path.join(LEGALBENCH, source);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of textFiles(dir, ".txt")) {
        emit("legalbench_rag", `${source}/${file}`, readFileSync(path.join(dir, file), "utf8"));
      }
    }
  } else if (wanted("legalbench_rag")) {
    process.stderr.write("legalbench_rag: MISSING\n");
  }

  // 2. A2AJ laws: frozen parquet stride sample (every 12th row of every dataset).
  if (wanted("a2aj_laws") && A2AJ_LAWS && existsSync(A2AJ_LAWS)) {
    process.stderr.write("a2aj_laws\n");
    await readJsonl(A2AJ_LAWS, (row) => {
      emit("a2aj_laws", String(row.id), String(row.text ?? ""), {
        docType: "laws",
        citation: String(row.citation ?? row.id),
        alternateCitation: (row.alternateCitation as string | null) ?? null,
        name: (row.name as string | null) ?? null,
        dataset: (row.dataset as string | null) ?? null,
        sectionMap: (row.sectionMap as Record<string, string> | null) ?? null,
      });
    });
  } else if (wanted("a2aj_laws")) {
    process.stderr.write("a2aj_laws: MISSING\n");
  }

  // 3. A2AJ cases: the structure-stress snapshots, already materialized from
  //    the same bulk corpus (full BCCA sweep, SCC cited-case pull, and the
  //    stratified per-court EN/FR strata).
  const snap = path.join(BENCH, "structure_stress", "probes", "snap");
  const caseFiles = [
    ["a2aj_cases_bcca", "full_bcca_texts.jsonl"],
    ["a2aj_cases_scc", "c_SCC_en.jsonl"],
    ...textFiles(snap, ".jsonl")
      .filter((name) => /^s_[A-Z]+_(en|fr)\.jsonl$/u.test(name))
      .map((name) => ["a2aj_cases_strata", name] as [string, string]),
  ] as Array<[string, string]>;
  for (const [corpus, file] of caseFiles) {
    if (!wanted(corpus)) continue;
    const full = path.join(snap, file);
    if (!existsSync(full)) {
      process.stderr.write(`${corpus}/${file}: MISSING\n`);
      continue;
    }
    process.stderr.write(`${corpus}/${file}\n`);
    await readJsonl(full, (row) => {
      const text = String(row.text ?? "");
      if (!text) return;
      emit(corpus, `${file}#${String(row.id)}`, text, {
        docType: "cases",
        citation: String(row.citation ?? row.id ?? ""),
        dataset: (row.court as string | null) ?? null,
      });
    });
  }

  // 4. Legal-generalization corpus: extracted judgment/statute/complaint text
  //    plus the 16 EN+FR amending acts.
  for (const [corpus, dir] of [
    ["legal_generalization", path.join(BENCH, "legal-generalization-corpus", "text")],
    ["amending_acts", path.join(BENCH, "legal-generalization-corpus", "amending-acts")],
  ] as Array<[string, string]>) {
    if (!wanted(corpus)) continue;
    if (!existsSync(dir)) {
      process.stderr.write(`${corpus}: MISSING\n`);
      continue;
    }
    process.stderr.write(`${corpus}\n`);
    for (const file of textFiles(dir, ".txt")) {
      emit(corpus, file, readFileSync(path.join(dir, file), "utf8"));
    }
  }

  // 5. The private DOCX corpus, read through the shipping body-text extractor.
  //    Its unzip dependency is a runtime install, not a source file, so a tree
  //    whose node_modules is absent reports the corpus unreachable rather than
  //    dropping it silently.
  const docxDir = path.join(BENCH, "docx_corpus", "private_sources");
  if (wanted("docx_corpus") && existsSync(docxDir)) {
    process.stderr.write("docx_corpus\n");
    try {
      const { extractDocxBodyText } = await import("../src/lib/docxTrackedChanges");
      for (const file of textFiles(docxDir, ".docx")) {
        if (!/^docx-[0-9a-f]{16}\.docx$/u.test(file)) continue; // manifest copies only
        const text = await extractDocxBodyText(readFileSync(path.join(docxDir, file)));
        emit("docx_corpus", file, text);
      }
    } catch (error) {
      process.stderr.write(`docx_corpus: UNREACHABLE (${(error as Error).message})\n`);
    }
  } else if (wanted("docx_corpus")) {
    process.stderr.write("docx_corpus: MISSING\n");
  }

  rows.sort((left, right) =>
    left.corpus === right.corpus
      ? left.id.localeCompare(right.id)
      : left.corpus.localeCompare(right.corpus),
  );

  await new Promise<void>((resolve) => detailStream!.end(resolve));
  writeFileSync(
    out,
    rows.map((row) => `${row.corpus}\t${row.id}\t${row.sha256}`).join("\n") +
      `\n# total ${rows.length}\n`,
    "utf8",
  );

  const perCorpus = new Map<string, number>();
  for (const row of rows) perCorpus.set(row.corpus, (perCorpus.get(row.corpus) ?? 0) + 1);
  for (const [corpus, count] of [...perCorpus].sort()) {
    process.stderr.write(`${corpus}\t${count}\n`);
  }
  process.stderr.write(`TOTAL\t${rows.length}\n`);
}

void main();
