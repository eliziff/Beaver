import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type SkeletonModule = {
  compileAgreementSkeleton: (
    text: string,
    id?: string,
    options?: { reconstructLineation?: boolean },
  ) => unknown | Promise<unknown>;
  clearSkeletonCache?: () => void;
};

type Result = {
  path: string;
  bytes: number;
  baselineSha256: string;
  candidateSha256: string;
  equal: boolean;
  differingFields: string[];
  baselineNodes: number;
  candidateNodes: number;
  baselineOnlyLabels: string[];
  candidateOnlyLabels: string[];
  baselineOnlyNodes: unknown[];
  candidateOnlyNodes: unknown[];
  baselineSections: unknown[];
  candidateSections: unknown[];
  changedLabels: string[];
  nodeDifferences: Array<{ label: string; baseline: unknown; candidate: unknown }>;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const HEAD_WORD = "(?:(?:ARTICLE|Article|PART|Part|DIVISION|Division)|" +
  "(?:Section|SECTION)|(?:SCHEDULE|Schedule|EXHIBIT|Exhibit|ANNEX|Annex|APPENDIX|Appendix))";
const DECIMAL_LABEL = String.raw`\d{1,3}\.\d{1,3}(?:\.\d{1,3})*`;
const SENTENCE_JOIN_RE = new RegExp(
  String.raw`(?<=[.;:][)\]"'\u201d\u2019\u00bb]?)[ \t]` +
    String.raw`(?=${HEAD_WORD}\s+[IVXLCDM\d]|${DECIMAL_LABEL}\s+\S|\(\w{1,3}\)\s)`,
  "gu",
);

function segmentations(text: string): string[] {
  const spaceRuns = (value: string) => value.replace(
    /(?<=\S)[ \t]([ \t]+)(?=\S)/gu,
    (_match, rest: string) => `\n${rest}`,
  );
  const joined = text.replace(SENTENCE_JOIN_RE, "\n");
  return [text, spaceRuns(text), joined, spaceRuns(joined)];
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(target));
    else if (entry.isFile() && entry.name.endsWith(".txt")) result.push(target);
  }
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

function observable(value: any): unknown {
  const { doc } = value;
  return {
    nodes: value.nodes,
    doc: {
      provider: doc.provider,
      id: doc.id,
      url: doc.url,
      revision: doc.revision,
      docType: doc.docType,
      status: doc.status,
      text: doc.text,
      blocks: doc.blocks,
      ranges: doc.ranges,
    },
    definedTerms: value.definedTerms,
    schedules: value.schedules,
    crossReferences: value.crossReferences,
    ladder: value.ladder,
    outline: value.outline,
    outlineRefusal: value.outlineRefusal,
  };
}

async function main(): Promise<void> {
  const [baselinePath, candidatePath, corpusRoot, reportPath, mode] = process.argv.slice(2);
  if (!baselinePath || !candidatePath || !corpusRoot || !reportPath) {
    throw new Error(
      "usage: skeleton_corpus_differential.ts BASELINE_MODULE CANDIDATE_MODULE CORPUS_ROOT REPORT",
    );
  }
  const [baseline, candidate] = await Promise.all([
    import(pathToFileURL(path.resolve(baselinePath)).href) as Promise<SkeletonModule>,
    import(pathToFileURL(path.resolve(candidatePath)).href) as Promise<SkeletonModule>,
  ]);
  const files = await filesBelow(path.resolve(corpusRoot));
  if (files.length !== 69) throw new Error(`expected 69 corpus documents, found ${files.length}`);
  const started = performance.now();
  const results: Result[] = [];
  const hypothesis = mode?.match(/^--hypothesis=(\d)$/u)?.[1];
  const options = mode === "--no-recovery" || hypothesis
    ? { reconstructLineation: false }
    : undefined;
  for (const [index, file] of files.entries()) {
    const original = await fs.readFile(file, "utf8");
    const text = hypothesis ? segmentations(original)[Number(hypothesis)] : original;
    const id = path.relative(corpusRoot, file).replaceAll("\\", "/");
    const baselineValue: any = observable(
      await baseline.compileAgreementSkeleton(text, id, options),
    );
    const candidateValue: any = observable(
      await candidate.compileAgreementSkeleton(text, id, options),
    );
    const baselineJson = JSON.stringify(baselineValue);
    const candidateJson = JSON.stringify(candidateValue);
    const differingFields = Object.keys(baselineValue).filter(
      (field) => JSON.stringify(baselineValue[field]) !== JSON.stringify(candidateValue[field]),
    );
    const baselineNodes = new Map(
      baselineValue.nodes.map((node: any) => [node.label, JSON.stringify(node)]),
    );
    const candidateNodes = new Map(
      candidateValue.nodes.map((node: any) => [node.label, JSON.stringify(node)]),
    );
    const baselineNodeValues = new Map(
      baselineValue.nodes.map((node: any) => [node.label, node]),
    );
    const candidateNodeValues = new Map(
      candidateValue.nodes.map((node: any) => [node.label, node]),
    );
    const changedLabels = [...baselineNodes]
      .filter(([label, node]) => candidateNodes.get(label) !== node)
      .map(([label]) => label) as string[];
    results.push({
      path: id,
      bytes: Buffer.byteLength(text),
      baselineSha256: sha256(baselineJson),
      candidateSha256: sha256(candidateJson),
      equal: baselineJson === candidateJson,
      differingFields,
      baselineNodes: baselineNodes.size,
      candidateNodes: candidateNodes.size,
      baselineOnlyLabels: [...baselineNodes.keys()]
        .filter((label) => !candidateNodes.has(label)).slice(0, 20) as string[],
      candidateOnlyLabels: [...candidateNodes.keys()]
        .filter((label) => !baselineNodes.has(label)).slice(0, 20) as string[],
      baselineOnlyNodes: [...baselineNodeValues]
        .filter(([label]) => !candidateNodes.has(label))
        .slice(0, 20)
        .map(([, node]) => node),
      candidateOnlyNodes: [...candidateNodeValues]
        .filter(([label]) => !baselineNodes.has(label))
        .slice(0, 20)
        .map(([, node]) => node),
      baselineSections: baselineJson === candidateJson
        ? []
        : baselineValue.nodes.filter((node: any) => node.kind === "section"),
      candidateSections: baselineJson === candidateJson
        ? []
        : candidateValue.nodes.filter((node: any) => node.kind === "section"),
      changedLabels: changedLabels.slice(0, 20),
      nodeDifferences: changedLabels.slice(0, 3).map((label) => ({
        label,
        baseline: baselineNodeValues.get(label),
        candidate: candidateNodeValues.get(label),
      })),
    });
    baseline.clearSkeletonCache?.();
    candidate.clearSkeletonCache?.();
    const report = {
      schemaVersion: "beaver.skeleton-corpus-differential.v1",
      complete: index + 1 === files.length,
      documents: files.length,
      checked: index + 1,
      mismatches: results.filter(({ equal }) => !equal).length,
      elapsedSeconds: (performance.now() - started) / 1_000,
      results,
    };
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if ((index + 1) % 10 === 0 || index + 1 === files.length) {
      process.stderr.write(
        `[${index + 1}/${files.length}] mismatches=${report.mismatches} elapsed=${report.elapsedSeconds.toFixed(2)}s\n`,
      );
    }
  }
  process.exit(results.some(({ equal }) => !equal) ? 1 : 0);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
