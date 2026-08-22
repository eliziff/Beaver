import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import {
  clearSkeletonCache,
  compileAgreementSkeleton,
  type SkeletonNode,
} from "../../src/lib/legalTextSkeleton";
import { a2ajSourceDocNative } from "../../src/lib/structureNative";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CANADIAN = path.join(
  ROOT,
  "benchmarks/legal-generalization-corpus/canadian/structure-gold",
);
const USLM = path.join(
  ROOT,
  "benchmarks/legal-generalization-corpus/gold/us-public-laws-uslm",
);
const BASELINE = path.join(import.meta.dirname, "baseline.json");
const REPORT = argument("--report")
  ? path.resolve(argument("--report")!)
  : path.join(ROOT, ".tmp/document-structure-gold-gate.json");
const RECORD = argument("--record");

type Range = { start: number; end: number };
type Metric = {
  gold: number;
  predicted: number;
  matched: number;
  falsePositive: number;
  falseNegative: number;
  exactRanges: number;
  exactOrder: boolean;
};
type Receipt = {
  kind: "canadian-statute" | "canadian-decision" | "uslm";
  inputSha256: string;
  goldSha256: string;
  predictionSha256: string;
  metric: Metric;
  details?: Record<string, number>;
  samples?: { missing: string[]; extra: string[] };
};
type Baseline = {
  schemaVersion: "beaver.document-structure-gold.v1";
  canadian: Record<string, Receipt>;
  uslm: Record<string, Receipt>;
  uslmCounts: UslmCounts;
};

type CanadianIndex = {
  statutes: Array<{ artifact_id: string; sections: number; anchored: number; chars: number }>;
  decisions: Array<{
    artifact_id: string;
    markers: number;
    spine: number;
    quoted: number;
    native_citations: number;
    chars: number;
  }>;
  counts: { statutes: number; decisions: number };
};
type StatuteGold = {
  artifact_id: string;
  citation: string;
  dataset: string;
  name: string;
  raw_text_file: string;
  raw_text_chars: number;
  raw_text_sha256: string;
  structure: {
    label_count: number;
    anchored_count: number;
    labels_map_order: string[];
    labels_doc_order: string[];
    sections: Array<{
      label: string;
      map_order: number;
      doc_order: number | null;
      anchored: boolean;
      raw_span: Range | null;
      body_chars: number;
      body_sha256: string;
      body: string;
    }>;
  };
};
type DecisionGold = {
  artifact_id: string;
  citation: string;
  dataset: string;
  name: string;
  raw_text_file: string;
  raw_text_chars: number;
  raw_text_sha256: string;
  structure: {
    marker_count: number;
    spine_count: number;
    quoted_count: number;
    labels_all_markers: string[];
    labels_spine: string[];
    paragraphs: Array<{
      label: string;
      marker_order: number;
      role: "spine" | "quoted_or_foreign";
      marker: string;
      raw_span: Range;
      body_chars: number;
      body_sha256: string;
      body: string;
    }>;
  };
  native_citations: { count: number; values: string[] };
};

type OrderedNode = Record<string, unknown>;
type UslmNode = {
  kind: string;
  identifier: string;
  chain: string[];
  range: Range;
  heading: string;
};
type UslmCounts = {
  files: number;
  structural: number;
  identified: number;
  nums: number;
  headings: number;
  chapeaux: number;
  terms: number;
  refs: number;
  refsOutsideQuotes: number;
};
type UslmRendered = {
  text: string;
  nodes: UslmNode[];
  counts: Omit<UslmCounts, "files">;
};

const STRUCTURAL = new Set([
  "section",
  "subsection",
  "paragraph",
  "subparagraph",
  "clause",
  "subclause",
  "item",
]);
const SURFACE = new Set(["num", "heading", "chapeau", "content", "continuation"]);
const QUOTED = new Set(["quotedContent", "quotedText"]);
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  processEntities: true,
});

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (stable(actual) !== stable(expected)) throw new Error(`${label} drift`);
}

function lf(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

async function text(filename: string): Promise<string> {
  return lf(await fs.readFile(filename, "utf8"));
}

async function json<T>(filename: string): Promise<T> {
  return JSON.parse(await fs.readFile(filename, "utf8")) as T;
}

function metric(gold: string[], predicted: string[], exactRanges: number): Metric {
  const remaining = new Map<string, number>();
  for (const key of gold) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  let matched = 0;
  for (const key of predicted) {
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      matched += 1;
      remaining.set(key, count - 1);
    }
  }
  return {
    gold: gold.length,
    predicted: predicted.length,
    matched,
    falsePositive: predicted.length - matched,
    falseNegative: gold.length - matched,
    exactRanges,
    exactOrder: stable(gold) === stable(predicted),
  };
}

function differenceSamples(gold: string[], predicted: string[]) {
  const subtract = (left: string[], right: string[]) => {
    const remaining = new Map<string, number>();
    for (const value of right) remaining.set(value, (remaining.get(value) ?? 0) + 1);
    return left.filter((value) => {
      const count = remaining.get(value) ?? 0;
      if (count < 1) return true;
      remaining.set(value, count - 1);
      return false;
    }).slice(0, 10);
  };
  return { missing: subtract(gold, predicted), extra: subtract(predicted, gold) };
}

function exactRanges<T extends { key: string; range: Range }>(
  gold: T[],
  predicted: T[],
): number {
  const values = new Map<string, string[]>();
  for (const item of predicted) {
    const ranges = values.get(item.key) ?? [];
    ranges.push(`${item.range.start}:${item.range.end}`);
    values.set(item.key, ranges);
  }
  let count = 0;
  for (const item of gold) {
    const ranges = values.get(item.key) ?? [];
    const expected = `${item.range.start}:${item.range.end}`;
    const at = ranges.indexOf(expected);
    if (at >= 0) {
      count += 1;
      ranges.splice(at, 1);
    }
  }
  return count;
}

function sectionLabel(node: SkeletonNode): string | null {
  return node.kind === "section" && node.label.startsWith("sec")
    ? node.label.slice(3)
    : null;
}

function chain(node: SkeletonNode): string[] | null {
  if (!node.label.startsWith("sec")) return null;
  const root = node.label.slice(3).match(/^([^()]+)/u)?.[1];
  if (!root) return null;
  return [root, ...[...node.label.matchAll(/\(([^()]+)\)/gu)].map((match) => match[1])];
}

function nodeTag(node: OrderedNode): string | null {
  return Object.keys(node).find((key) => key !== ":@") ?? null;
}

function children(node: OrderedNode, tag: string): OrderedNode[] {
  const value = node[tag];
  return Array.isArray(value) ? value as OrderedNode[] : [];
}

function attributes(node: OrderedNode): Record<string, string> {
  const value = node[":@"];
  return value && typeof value === "object" ? value as Record<string, string> : {};
}

function surface(nodes: OrderedNode[]): string {
  let result = "";
  for (const node of nodes) {
    const tag = nodeTag(node);
    if (!tag) continue;
    if (tag === "#text") result += String(node[tag] ?? "");
    else result += surface(children(node, tag));
  }
  return result.replace(/\s+/gu, " ").trim();
}

function renderUslm(xml: string): UslmRendered {
  const document = parser.parse(xml) as OrderedNode[];
  const nodes: UslmNode[] = [];
  const counts = {
    structural: 0,
    identified: 0,
    nums: 0,
    headings: 0,
    chapeaux: 0,
    terms: 0,
    refs: 0,
    refsOutsideQuotes: 0,
  };
  let output = "";

  const line = () => {
    output = output.replace(/[ \t]+$/gu, "");
    if (output && !output.endsWith("\n")) output += "\n";
  };
  const append = (value: string) => {
    if (!value) return;
    if (output && !/\s$/u.test(output)) output += " ";
    output += value;
  };

  const countAll = (items: OrderedNode[], quoted = false): void => {
    for (const item of items) {
      const tag = nodeTag(item);
      if (!tag) continue;
      const insideQuote = quoted || QUOTED.has(tag);
      if (STRUCTURAL.has(tag)) counts.structural += 1;
      if (tag === "num") counts.nums += 1;
      if (tag === "heading") counts.headings += 1;
      if (tag === "chapeau") counts.chapeaux += 1;
      if (tag === "term") counts.terms += 1;
      if (tag === "ref") {
        counts.refs += 1;
        if (!insideQuote) counts.refsOutsideQuotes += 1;
      }
      countAll(children(item, tag), insideQuote);
    }
  };

  const walk = (items: OrderedNode[], ancestors: string[], quoted = false): void => {
    for (const item of items) {
      const tag = nodeTag(item);
      if (!tag) continue;
      const insideQuote = quoted || QUOTED.has(tag);
      if (!STRUCTURAL.has(tag)) {
        walk(children(item, tag), ancestors, insideQuote);
        continue;
      }

      line();
      const start = output.length;
      const body = children(item, tag);
      const numberNode = body.find((child) => nodeTag(child) === "num");
      const value = numberNode ? attributes(numberNode).value?.trim() : undefined;
      const nextAncestors = value ? [...ancestors, value] : ancestors;
      const identifier = attributes(item).identifier?.trim() ?? "";
      const record = identifier && value && !insideQuote ? {
        kind: tag,
        identifier,
        chain: nextAncestors,
        range: { start, end: start },
        heading: "",
      } satisfies UslmNode : null;
      if (identifier && !insideQuote) counts.identified += 1;
      if (record) nodes.push(record);

      for (const child of body) {
        const childTag = nodeTag(child);
        if (!childTag) continue;
        if (SURFACE.has(childTag)) {
          const value = surface(children(child, childTag));
          append(value);
          if (record && childTag === "heading") record.heading = value;
        } else {
          walk([child], nextAncestors, insideQuote);
        }
      }
      line();
      if (record) {
        record.range.end = output.length;
      }
    }
  };

  countAll(document);
  walk(document, []);
  return { text: output, nodes, counts };
}

function receipt(
  kind: Receipt["kind"],
  input: string,
  gold: unknown,
  prediction: unknown,
  result: Metric,
  details?: Record<string, number>,
  samples?: Receipt["samples"],
): Receipt {
  return {
    kind,
    inputSha256: sha256(input),
    goldSha256: sha256(stable(gold)),
    predictionSha256: sha256(stable(prediction)),
    metric: result,
    ...(details ? { details } : {}),
    ...(samples && (samples.missing.length || samples.extra.length) ? { samples } : {}),
  };
}

async function canadianGate(): Promise<Record<string, Receipt>> {
  const index = await json<CanadianIndex>(path.join(CANADIAN, "index.json"));
  same(index.counts, { statutes: 10, decisions: 8 }, "Canadian denominator");
  same(index.statutes.length, 10, "Canadian statute index");
  same(index.decisions.length, 8, "Canadian decision index");
  const receipts: Record<string, Receipt> = {};

  for (const item of index.statutes) {
    const directory = path.join(CANADIAN, "statutes");
    const gold = await json<StatuteGold>(
      path.join(directory, `${item.artifact_id}.structure.json`),
    );
    const input = await text(path.join(directory, gold.raw_text_file));
    same(sha256(input), gold.raw_text_sha256, `${item.artifact_id} source hash`);
    same(input.length, gold.raw_text_chars, `${item.artifact_id} source length`);
    same(gold.structure.sections.length, gold.structure.label_count, `${item.artifact_id} labels`);
    same(gold.structure.labels_map_order,
      [...gold.structure.sections].sort((a, b) => a.map_order - b.map_order).map(({ label }) => label),
      `${item.artifact_id} map order`);
    const anchored = gold.structure.sections.filter((section) => section.anchored);
    same(anchored.length, gold.structure.anchored_count, `${item.artifact_id} anchored count`);
    same(gold.structure.labels_doc_order,
      [...anchored].sort((a, b) => a.doc_order! - b.doc_order!).map(({ label }) => label),
      `${item.artifact_id} document order`);
    for (const section of gold.structure.sections) {
      same(section.body.length, section.body_chars, `${item.artifact_id}/${section.label} body length`);
      same(sha256(section.body), section.body_sha256, `${item.artifact_id}/${section.label} body hash`);
      if (section.anchored && (!section.raw_span || section.doc_order === null ||
          section.raw_span.start < 0 || section.raw_span.end > input.length ||
          section.raw_span.start >= section.raw_span.end)) {
        throw new Error(`${item.artifact_id}/${section.label} has an invalid anchor`);
      }
    }
    same({ sections: gold.structure.label_count, anchored: anchored.length, chars: input.length },
      { sections: item.sections, anchored: item.anchored, chars: item.chars },
      `${item.artifact_id} index`);

    const candidate = await compileAgreementSkeleton(input, item.artifact_id, {
      reconstructLineation: false,
    });
    const prediction = candidate.nodes.flatMap((node) => {
      const label = sectionLabel(node);
      return label ? [{ label, range: { start: node.start, end: node.end },
        heading: node.heading }] : [];
    });
    const expected = anchored
      .sort((a, b) => a.doc_order! - b.doc_order!)
      .map((section) => ({ key: section.label, label: section.label, range: section.raw_span! }));
    const predicted = prediction.map((section) => ({
      key: section.label,
      label: section.label,
      range: section.range,
    }));
    const expectedKeys = expected.map(({ key }) => key);
    const predictedKeys = predicted.map(({ key }) => key);
    receipts[item.artifact_id] = receipt(
      "canadian-statute",
      input,
      expected,
      prediction,
      metric(expectedKeys, predictedKeys, exactRanges(expected, predicted)),
      undefined,
      differenceSamples(expectedKeys, predictedKeys),
    );
    clearSkeletonCache();
  }

  for (const item of index.decisions) {
    const directory = path.join(CANADIAN, "decisions");
    const gold = await json<DecisionGold>(
      path.join(directory, `${item.artifact_id}.structure.json`),
    );
    const input = await text(path.join(directory, gold.raw_text_file));
    same(sha256(input), gold.raw_text_sha256, `${item.artifact_id} source hash`);
    same(input.length, gold.raw_text_chars, `${item.artifact_id} source length`);
    const matches = [...input.matchAll(/^[ \t]*\[(\d+)\]/gmu)];
    same(matches.length, gold.structure.marker_count, `${item.artifact_id} marker count`);
    let expectedLabel = 1;
    for (const [at, match] of matches.entries()) {
      const start = match.index!;
      const end = matches[at + 1]?.index ?? input.length;
      const role = Number(match[1]) === expectedLabel ? "spine" : "quoted_or_foreign";
      if (role === "spine") expectedLabel += 1;
      const body = input.slice(start + match[0].length, end).trim();
      const before = gold.structure.paragraphs[at];
      same({ label: match[1], marker_order: at, role, marker: `[${match[1]}]`,
        raw_span: { start, end }, body_chars: body.length, body_sha256: sha256(body), body },
      before, `${item.artifact_id} marker ${at}`);
    }
    const spine = gold.structure.paragraphs.filter(({ role }) => role === "spine");
    same(spine.map(({ label }) => label), gold.structure.labels_spine,
      `${item.artifact_id} spine labels`);
    same(gold.structure.paragraphs.map(({ label }) => label),
      gold.structure.labels_all_markers, `${item.artifact_id} marker labels`);
    same({ markers: matches.length, spine: spine.length,
      quoted: matches.length - spine.length, native_citations: gold.native_citations.count,
      chars: input.length }, { markers: item.markers, spine: item.spine,
      quoted: item.quoted, native_citations: item.native_citations, chars: item.chars },
    `${item.artifact_id} index`);
    same(gold.native_citations.values.length, gold.native_citations.count,
      `${item.artifact_id} citations`);

    const document = a2ajSourceDocNative({
      citation: gold.citation,
      source_kind: "cases",
      text: input,
      id: item.artifact_id,
      dataset: gold.dataset,
      name: gold.name,
    });
    const prediction = document.blocks
      .filter(({ kind }) => kind === "paragraph")
      .map(({ label, start, end }) => ({ label: label.replace(/^par/u, ""), start, end }));
    const expected = spine.map(({ label, raw_span }) => ({
      key: `${label}@${raw_span.start}`,
      range: raw_span,
    }));
    const predicted = prediction.map(({ label, start, end }) => ({
      key: `${label}@${start}`,
      range: { start, end },
    }));
    const expectedKeys = expected.map(({ key }) => key);
    const predictedKeys = predicted.map(({ key }) => key);
    receipts[item.artifact_id] = receipt(
      "canadian-decision",
      input,
      expected,
      prediction,
      metric(expectedKeys, predictedKeys, exactRanges(expected, predicted)),
      undefined,
      differenceSamples(expectedKeys, predictedKeys),
    );
  }
  return receipts;
}

async function uslmGate(
  progress: (
    checked: number,
    total: number,
    receipts: Record<string, Receipt>,
  ) => Promise<void>,
): Promise<{ receipts: Record<string, Receipt>; counts: UslmCounts }> {
  const manifest = (await text(path.join(USLM, "files_manifest.tsv")))
    .replace(/^\uFEFF/u, "").trimEnd().split("\n");
  same(manifest.shift(), "sha256\tbytes\tpath", "USLM manifest header");
  same(manifest.length, 79, "USLM denominator");
  const receipts: Record<string, Receipt> = {};
  const counts: UslmCounts = {
    files: manifest.length,
    structural: 0,
    identified: 0,
    nums: 0,
    headings: 0,
    chapeaux: 0,
    terms: 0,
    refs: 0,
    refsOutsideQuotes: 0,
  };

  for (const [at, row] of manifest.entries()) {
    const [expectedHash, expectedBytes, relative] = row.split("\t");
    if (!expectedHash || !expectedBytes || !relative) throw new Error(`Invalid USLM manifest row ${at + 2}`);
    const xml = await text(path.join(USLM, relative));
    same(sha256(xml), expectedHash, `${relative} source hash`);
    same(Buffer.byteLength(xml), Number(expectedBytes), `${relative} source bytes`);
    const rendered = renderUslm(xml);
    for (const key of Object.keys(rendered.counts) as Array<keyof typeof rendered.counts>) {
      counts[key] += rendered.counts[key];
    }
    const candidate = await compileAgreementSkeleton(
      rendered.text,
      path.basename(relative, ".xml"),
      { reconstructLineation: false },
    );
    const prediction = candidate.nodes.flatMap((node) => {
      const value = chain(node);
      return value ? [{ chain: value, range: { start: node.start, end: node.end },
        heading: node.heading, depth: node.depth }] : [];
    });
    const expected = rendered.nodes.map((node) => ({
      key: stable(node.chain),
      range: node.range,
    }));
    const predicted = prediction.map((node) => ({
      key: stable(node.chain),
      range: node.range,
    }));
    const matchedDepths = prediction.filter((node) =>
      rendered.nodes.some((gold) => stable(gold.chain) === stable(node.chain) &&
        gold.chain.length - 1 === node.depth)).length;
    const matchedHeadings = prediction.filter((node) => node.heading &&
      rendered.nodes.some((gold) => stable(gold.chain) === stable(node.chain) &&
        gold.heading === node.heading)).length;
    const expectedKeys = expected.map(({ key }) => key);
    const predictedKeys = predicted.map(({ key }) => key);
    receipts[path.basename(relative, ".xml")] = receipt(
      "uslm",
      rendered.text,
      rendered.nodes,
      prediction,
      metric(expectedKeys, predictedKeys, exactRanges(expected, predicted)),
      { matchedDepths, matchedHeadings },
      differenceSamples(expectedKeys, predictedKeys),
    );
    clearSkeletonCache();
    await progress(at + 1, manifest.length, receipts);
  }
  const published: UslmCounts = {
    files: 79,
    structural: 15_269,
    identified: 8_870,
    nums: 15_521,
    headings: 7_162,
    chapeaux: 2_440,
    terms: 555,
    refs: 5_105,
    refsOutsideQuotes: 4_875,
  };
  if (stable(counts) !== stable(published)) {
    throw new Error(`USLM published counters drift: ${stable(counts)}`);
  }
  return { receipts, counts };
}

async function main(): Promise<void> {
  const started = performance.now();
  const mismatches: Array<{ id: string; field: string; expected: unknown; actual: unknown }> = [];
  const canadian = await canadianGate();
  const writeReport = async (complete: boolean, checkedUslm: number, uslm?: Record<string, Receipt>) => {
    const value = {
      schemaVersion: "beaver.document-structure-gold-report.v1",
      complete,
      checked: { canadian: Object.keys(canadian).length, uslm: checkedUslm },
      mismatches: mismatches.length,
      mismatchSamples: mismatches.slice(0, 20),
      elapsedSeconds: (performance.now() - started) / 1_000,
      canadian,
      uslm: uslm ?? {},
    };
    await fs.mkdir(path.dirname(REPORT), { recursive: true });
    await fs.writeFile(REPORT, `${JSON.stringify(value, null, 2)}\n`);
  };
  const uslm = await uslmGate(async (checked, total, receipts) => {
    if (checked % 10 === 0 || checked === total) {
      await writeReport(false, checked, receipts);
      process.stderr.write(`[USLM ${checked}/${total}] elapsed=${((performance.now() - started) / 1_000).toFixed(1)}s\n`);
    }
  });
  const actual: Baseline = {
    schemaVersion: "beaver.document-structure-gold.v1",
    canadian,
    uslm: uslm.receipts,
    uslmCounts: uslm.counts,
  };

  if (RECORD) {
    const target = path.resolve(RECORD);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(actual, null, 2)}\n`);
  } else {
    const expected = await json<Baseline>(BASELINE);
    for (const group of ["canadian", "uslm"] as const) {
      const old = expected[group];
      const fresh = actual[group];
      same(Object.keys(fresh), Object.keys(old), `${group} receipt inventory`);
      for (const id of Object.keys(old)) {
        const fields = new Set<keyof Receipt>([
          ...Object.keys(old[id]) as Array<keyof Receipt>,
          ...Object.keys(fresh[id]) as Array<keyof Receipt>,
        ]);
        for (const field of fields) {
          if (stable(fresh[id][field]) !== stable(old[id][field])) {
            mismatches.push({ id: `${group}/${id}`, field,
              expected: old[id][field], actual: fresh[id][field] });
          }
        }
      }
    }
    same(actual.uslmCounts, expected.uslmCounts, "USLM aggregate counters");
  }
  await writeReport(true, Object.keys(uslm.receipts).length, uslm.receipts);
  process.stderr.write(
    `[done] canadian=${Object.keys(canadian).length} uslm=${Object.keys(uslm.receipts).length} ` +
    `mismatches=${mismatches.length} elapsed=${((performance.now() - started) / 1_000).toFixed(1)}s\n`,
  );
  if (mismatches.length) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
