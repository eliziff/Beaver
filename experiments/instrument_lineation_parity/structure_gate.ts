import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  instrumentCorpusFiles,
  readAgreement,
  readPdf,
  ROOT,
} from "./corpus";

const BASELINE = path.join(import.meta.dirname, "structure-baseline.json");
const REPORT = path.join(ROOT, ".tmp/instrument-structure-gate.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");
const ORACLE_ROOT = process.argv.find((argument) =>
  argument.startsWith("--oracle-root=")
)?.slice("--oracle-root=".length);
const ORACLE_ADDON = process.argv.find((argument) =>
  argument.startsWith("--oracle-addon=")
)?.slice("--oracle-addon=".length);
const LIMIT = Number(process.argv.find((argument) =>
  argument.startsWith("--limit=")
)?.slice("--limit=".length) ?? Infinity);

type NativeDocument = object;
type StructureAddon = {
  deriveDocumentStructure(request: unknown): Promise<NativeDocument>;
  documentSnapshot(document: NativeDocument): Buffer;
  sourceDocSnapshot(document: NativeDocument): Buffer;
};

function loadAddon(): StructureAddon {
  const filename = process.env.LEGAL_STRUCTURE_NATIVE?.trim() || path.join(
    ROOT,
    "legal-pdf-parser",
    "target",
    "release",
    process.platform === "win32" ? "legal_structure_node.dll"
      : process.platform === "darwin" ? "liblegal_structure_node.dylib"
      : "liblegal_structure_node.so",
  );
  const module = { exports: {} } as NodeModule;
  process.dlopen(module, path.resolve(filename));
  return module.exports as StructureAddon;
}

const nativeAddon = loadAddon();
const nativeJson = <T>(value: Buffer) => JSON.parse(value.toString("utf8")) as T;

const COMPONENTS = [
  "nodes",
  "sourceDoc",
  "definedTerms",
  "schedules",
  "crossReferences",
  "ladder",
  "contents",
] as const;
type Component = typeof COMPONENTS[number];

type Entry = {
  id: string;
  inputSha256: string;
  resultSha256: string;
  components: Record<Component, string>;
};

type Totals = {
  documents: number;
  nodes: number;
  sourceDocBlocks: number;
  tableNodes: number;
  definedTerms: number;
  schedules: number;
  internalReferences: number;
  externalReferences: number;
  unresolvedReferences: number;
  contentsPresent: number;
  contentsRefused: number;
};

type Baseline = {
  schemaVersion: "beaver.instrument-structure-freeze.v1";
  denominators: { agreements: number; pdfs: number; pages: number; lines: number };
  inputBytes: number;
  inputSha256: string;
  resultSha256: string;
  totals: Totals;
  entries: Entry[];
};

type Difference = { path: string; expected: unknown; actual: unknown };

function timing(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    medianMs: sorted.length
      ? Number(((sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2).toFixed(3))
      : null,
    totalMs: Number(values.reduce((sum, value) => sum + value, 0).toFixed(3)),
  };
}

function display(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= 160) return value;
  return `${value.slice(0, 157)}...`;
}

function differences(
  expected: unknown,
  actual: unknown,
  at = "",
  found: Difference[] = [],
): Difference[] {
  if (found.length >= 20 || Object.is(expected, actual)) return found;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      found.push({ path: `${at}.length`, expected: expected.length, actual: actual.length });
    }
    for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
      differences(expected[index], actual[index], `${at}[${index}]`, found);
    }
    return found;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      differences(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        at ? `${at}.${key}` : key,
        found,
      );
    }
    return found;
  }
  found.push({ path: at, expected: display(expected), actual: display(actual) });
  return found;
}

function skeletonProducts(skeleton: any) {
  return {
    nodes: skeleton.nodes.map(({ heading: _, ...node }: any) => node),
    sourceDoc: { provider: skeleton.doc.provider, id: skeleton.doc.id,
      url: skeleton.doc.url, revision: skeleton.doc.revision,
      docType: skeleton.doc.docType, status: skeleton.doc.status,
      textSha256: sha256(skeleton.doc.text), blocks: skeleton.doc.blocks,
      index: [...skeleton.doc.index.entries()], ranges: skeleton.doc.ranges },
    definedTerms: skeleton.definedTerms,
    schedules: skeleton.schedules,
    crossReferences: skeleton.crossReferences,
    ladder: skeleton.ladder,
    contents: { outline: skeleton.outline, refusal: skeleton.outlineRefusal },
  };
}

function skeletonAnalysis(
  text: string,
  skeleton: any,
  crossReferenceGraphFromSkeleton: (text: string, skeleton: any) => any,
) {
  const { nodes: _, ...crossReferences } = crossReferenceGraphFromSkeleton(text, skeleton);
  return { products: { ...skeletonProducts(skeleton), crossReferences }, crossReferences };
}

function legacyProducts(text: string, analyzed: any) {
  const structure = analyzed.structure;
  const sourceDoc = analyzed.source_doc;
  if (!sourceDoc) throw new Error("Rust omitted SourceDoc");
  const sourceNodes = structure.nodes.filter((node: any) =>
    node.kind === "section" && node.label
  );
  const byId = new Map(sourceNodes.map((node: any) => [node.id, node]));
  const depth = (node: any): number => {
    let value = 0;
    for (let parent = node.parent_id; parent && byId.has(parent);) {
      value += 1;
      parent = (byId.get(parent) as any).parent_id;
    }
    return value;
  };
  const schedules: string[] = [];
  const nodes = sourceNodes.map((node: any) => {
    const label = node.label as string;
    const kind = label.startsWith("art") ? "article"
      : label.startsWith("part") ? "part"
      : label.startsWith("div") ? "division"
      : /^(?:sched|exh|annex|app)/u.test(label) ? "schedule"
      : label.includes("(") ? "subsection" : "section";
    const contentStart = node.content_start;
    const start = node.range.start;
    const rawHead = text.slice(start, contentStart).trim();
    const head = rawHead.replace(/[\u2013\u2014\-.:]+\s*$/u, "").trim();
    const scheduleHead = kind === "schedule"
      ? rawHead.match(/^(SCHEDULE|Schedule|EXHIBIT|Exhibit|ANNEX|Annex|APPENDIX|Appendix)\s+([A-Z0-9][\w.\-]*)/u)
      : null;
    const scheduleName = scheduleHead ? `${scheduleHead[1]} ${scheduleHead[2]}` : head;
    const parent = node.parent_id ? byId.get(node.parent_id) as any : undefined;
    const display = kind === "section" || kind === "subsection"
      ? label.replace(/^sec/u, "Section ")
      : (kind === "schedule" ? scheduleName : head)
        .replace(/^\S+/u, (word: string) => word.toUpperCase());
    if (kind === "schedule") schedules.push(scheduleName);
    return { kind, label, display,
      depth: depth(node), start, end: node.range.end,
      ...(parent?.label ? { parentLabel: parent.label } : {}) };
  });
  const count = (code: string) => structure.diagnostics
    .filter((row: any) => row.code === code).length;
  const labels = new Map(sourceNodes
    .filter((node: any) => !/^(?:art|part)/u.test(node.label))
    .map((node: any) => [node.id, node.label]));
  const definedTerms = (structure.definitions ?? []).map((term: any) => ({
    term: term.term,
    sectionLabel: labels.get(term.definitions[0]?.node_id) ?? null,
    definitions: term.definitions.length,
  })).sort((a: any, b: any) => a.term.localeCompare(b.term));
  const references = structure.cross_references;
  return {
    nodes,
    sourceDoc: { provider: sourceDoc.provider, id: sourceDoc.id, url: sourceDoc.url,
      revision: sourceDoc.revision, docType: sourceDoc.docType, status: sourceDoc.status,
      textSha256: sha256(sourceDoc.text ?? ""), blocks: sourceDoc.blocks,
      index: Object.entries(sourceDoc.index), ranges: sourceDoc.ranges },
    definedTerms, schedules,
    crossReferences: references,
    ladder: { increments: count("instrument_ladder_increment"),
      levelOpens: count("instrument_ladder_level_open"),
      midcounterOpens: count("instrument_ladder_midcounter_open"),
      forwardJumps: count("instrument_ladder_forward_jump"),
      restarts: count("instrument_ladder_restart"),
      violations: count("instrument_ladder_violation") },
    contents: { outline: structure.contents?.outline ?? null,
      refusal: structure.contents?.refusal ?? null },
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function addFramed(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value)));
  hash.update(":");
  hash.update(value);
  hash.update("\n");
}

function emptyTotals(): Totals {
  return {
    documents: 0,
    nodes: 0,
    sourceDocBlocks: 0,
    tableNodes: 0,
    definedTerms: 0,
    schedules: 0,
    internalReferences: 0,
    externalReferences: 0,
    unresolvedReferences: 0,
    contentsPresent: 0,
    contentsRefused: 0,
  };
}

async function main(): Promise<void> {
  const { agreements, pdfs } = await instrumentCorpusFiles();
  if ((ORACLE_ROOT === undefined) !== (ORACLE_ADDON === undefined)) {
    throw new Error("--oracle-root and --oracle-addon must be supplied together");
  }
  let oracle: {
    clearSkeletonCache(): void;
    compileAgreementSkeleton(text: string, id: string): Promise<any>;
    crossReferenceGraphFromSkeleton(text: string, skeleton: any): any;
  } | null = null;
  const priorAnalysis = async (id: string, text: string) => {
    if (!ORACLE_ROOT || !ORACLE_ADDON) return null;
    if (!oracle) {
      const previousNative = process.env.LEGAL_STRUCTURE_NATIVE;
      process.env.LEGAL_STRUCTURE_NATIVE = path.resolve(ORACLE_ADDON);
      try {
        const root = path.resolve(ORACLE_ROOT, "backend/src/lib");
        oracle = {
          ...await import(pathToFileURL(path.join(root, "legalTextSkeleton.ts")).href),
          ...await import(pathToFileURL(path.join(root, "legalCrossReference.ts")).href),
        };
        oracle.clearSkeletonCache();
        const skeleton = await oracle.compileAgreementSkeleton(text, id);
        return skeletonAnalysis(text, skeleton, oracle.crossReferenceGraphFromSkeleton);
      } finally {
        if (previousNative === undefined) delete process.env.LEGAL_STRUCTURE_NATIVE;
        else process.env.LEGAL_STRUCTURE_NATIVE = previousNative;
      }
    }
    oracle.clearSkeletonCache();
    const skeleton = await oracle.compileAgreementSkeleton(text, id);
    return skeletonAnalysis(text, skeleton, oracle.crossReferenceGraphFromSkeleton);
  };
  const expected = WRITE_BASELINE
    ? null
    : JSON.parse(await fs.readFile(BASELINE, "utf8")) as Baseline;
  const started = performance.now();
  const timings = { rustDerive: [] as number[], rustProjection: [] as number[],
    rustTotal: [] as number[], typescript: [] as number[] };
  const inputHash = createHash("sha256");
  const resultHash = createHash("sha256");
  const entries: Entry[] = [];
  const totals = emptyTotals();
  const mismatches: Array<{
    id: string;
    fields: string[];
    expected?: string;
    actual?: string;
    differences?: Partial<Record<Component, Difference[]>>;
  }> = [];
  let inputBytes = 0;
  let pages = 0;
  let lines = 0;

  const writeReport = async (complete: boolean) => {
    await fs.mkdir(path.dirname(REPORT), { recursive: true });
    await fs.writeFile(REPORT, `${JSON.stringify({
      schemaVersion: "beaver.instrument-structure-gate-report.v1",
      complete,
      mode: ORACLE_ROOT ? "oracle" : WRITE_BASELINE ? "write-baseline" : "verify",
      checked: entries.length,
      denominators: { agreements: agreements.length, pdfs: pdfs.length, pages, lines },
      inputBytes,
      totals,
      mismatches: mismatches.length,
      mismatchSamples: ORACLE_ROOT ? mismatches : mismatches.slice(0, 40),
      timings: {
        rustDerive: timing(timings.rustDerive),
        rustProjection: timing(timings.rustProjection),
        rustTotal: timing(timings.rustTotal),
        ...(timings.typescript.length ? { typescript: timing(timings.typescript) } : {}),
      },
      elapsedSeconds: (performance.now() - started) / 1_000,
      ...(WRITE_BASELINE ? { entries } : {}),
    }, null, 2)}\n`);
  };

  const nativeAnalysis = async (id: string, text: string, record = true) => {
    const started = performance.now();
    const native = await nativeAddon.deriveDocumentStructure({ kind: "instrument", id, text,
      reconstruct_lineation: true });
    const derived = performance.now();
    const structure = nativeJson<any>(nativeAddon.documentSnapshot(native)).structure;
    const sourceDoc = nativeJson<any>(nativeAddon.sourceDocSnapshot(native));
    const products = legacyProducts(text, { structure, source_doc: sourceDoc });
    const finished = performance.now();
    if (record) {
      timings.rustDerive.push(derived - started);
      timings.rustProjection.push(finished - derived);
      timings.rustTotal.push(finished - started);
    }
    if ((sourceDoc.text ?? "") !== text) {
      throw new Error(`${id}: SourceDoc text differs from its instrument input`);
    }
    return { products, structure };
  };
  let warmed = false;
  const check = async (id: string, text: string) => {
    if (ORACLE_ROOT && !warmed) {
      await nativeAnalysis(id, text, false);
      await priorAnalysis(id, text);
      warmed = true;
    }
    let analyzed: Awaited<ReturnType<typeof nativeAnalysis>>;
    let previous: Awaited<ReturnType<typeof priorAnalysis>> = null;
    const runPrevious = async () => {
      const started = performance.now();
      previous = await priorAnalysis(id, text);
      timings.typescript.push(performance.now() - started);
    };
    if (ORACLE_ROOT && entries.length % 2 === 1) {
      await runPrevious();
      analyzed = await nativeAnalysis(id, text);
    } else {
      analyzed = await nativeAnalysis(id, text);
      if (ORACLE_ROOT) await runPrevious();
    }
    const { products } = analyzed;
    const components = Object.fromEntries(
      COMPONENTS.map((name) => [name, hashJson(products[name])]),
    ) as Record<Component, string>;
    const entry: Entry = {
      id,
      inputSha256: sha256(text),
      resultSha256: hashJson(products),
      components,
    };
    entries.push(entry);
    addFramed(inputHash, id);
    addFramed(inputHash, text);
    addFramed(resultHash, id);
    addFramed(resultHash, entry.resultSha256);
    inputBytes += Buffer.byteLength(text);
    totals.documents += 1;
    totals.nodes += products.nodes.length;
    totals.sourceDocBlocks += products.sourceDoc.blocks.length;
    totals.tableNodes += products.nodes.filter(
      (node) => node.kind === "table" || node.kind === "row" || node.kind === "cell",
    ).length;
    totals.definedTerms += products.definedTerms.length;
    totals.schedules += products.schedules.length;
    totals.internalReferences += products.crossReferences.counts.detected -
      products.crossReferences.counts.external;
    totals.externalReferences += products.crossReferences.counts.external;
    totals.unresolvedReferences += products.crossReferences.counts.unresolved;
    totals.contentsPresent += Number(products.contents.outline !== null);
    totals.contentsRefused += Number(products.contents.refusal !== null);

    const prior = expected?.entries[entries.length - 1];
    if (prior) {
      const fields: string[] = COMPONENTS.filter(
        (name) => prior.components[name] !== components[name],
      );
      if (prior.id !== id) fields.unshift("id");
      if (prior.inputSha256 !== entry.inputSha256) fields.unshift("input");
      if (fields.length || prior.resultSha256 !== entry.resultSha256) {
        let exactDifferences: Partial<Record<Component, Difference[]>> | undefined;
        if (ORACLE_ROOT && ORACLE_ADDON) {
          if (!previous) throw new Error("Structure oracle did not produce a result");
          exactDifferences = Object.fromEntries(fields
            .filter((field): field is Component => COMPONENTS.includes(field as Component))
            .map((field) => [field, differences(previous.products[field], products[field])])) as
            Partial<Record<Component, Difference[]>>;
        }
        mismatches.push({
          id,
          fields,
          expected: prior.resultSha256,
          actual: entry.resultSha256,
          ...(exactDifferences ? { differences: exactDifferences } : {}),
        });
      }
    } else if (expected) {
      mismatches.push({ id, fields: ["missing-baseline-entry"] });
    }
    if (previous) {
      const fields = COMPONENTS.filter(
        (name) => hashJson(previous!.products[name]) !== components[name],
      );
      if (fields.length) {
        mismatches.push({
          id,
          fields,
          expected: hashJson(previous.products),
          actual: entry.resultSha256,
          differences: Object.fromEntries(fields.map((field) => [
            field, differences(previous!.products[field], products[field]),
          ])) as Partial<Record<Component, Difference[]>>,
        });
      }
    }

    if (entries.length % 10 === 0) {
      await writeReport(false);
      process.stderr.write(
        `[${entries.length}/${agreements.length + pdfs.length}] ` +
        `mismatches=${mismatches.length} elapsed=${((performance.now() - started) / 1_000).toFixed(1)}s\n`,
      );
    }
  };

  for (const file of agreements) {
    if (entries.length >= LIMIT) break;
    const document = await readAgreement(file);
    await check(document.id, document.text);
  }
  for (const file of pdfs) {
    if (entries.length >= LIMIT) break;
    const document = await readPdf(file);
    pages += document.pages;
    lines += document.lines;
    await check(document.id, document.text);
  }
  if (!Number.isFinite(LIMIT) && (pages !== 24_707 || lines !== 1_221_262)) {
    throw new Error(`PDF surface drift: pages=${pages}, lines=${lines}`);
  }

  const baseline: Baseline = {
    schemaVersion: "beaver.instrument-structure-freeze.v1",
    denominators: { agreements: agreements.length, pdfs: pdfs.length, pages, lines },
    inputBytes,
    inputSha256: inputHash.digest("hex"),
    resultSha256: resultHash.digest("hex"),
    totals,
    entries,
  };
  if (WRITE_BASELINE) {
    await fs.writeFile(BASELINE, `${JSON.stringify(baseline)}\n`);
  } else if (!Number.isFinite(LIMIT)) {
    if (expected?.entries.length !== entries.length) {
      mismatches.push({
        id: "<corpus>",
        fields: ["entry-count"],
        expected: String(expected?.entries.length),
        actual: String(entries.length),
      });
    }
    if (JSON.stringify(expected?.denominators) !== JSON.stringify(baseline.denominators) ||
        expected?.inputBytes !== baseline.inputBytes ||
        expected?.inputSha256 !== baseline.inputSha256 ||
        expected?.resultSha256 !== baseline.resultSha256 ||
        JSON.stringify(expected?.totals) !== JSON.stringify(baseline.totals)) {
      mismatches.push({ id: "<aggregate>", fields: ["receipt"] });
    }
  }
  await writeReport(true);
  process.stderr.write(
    `[${entries.length}/${agreements.length + pdfs.length}] ` +
    `mismatches=${mismatches.length} elapsed=${((performance.now() - started) / 1_000).toFixed(1)}s\n`,
  );
  if (mismatches.length) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
