import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  clearSkeletonCache,
  compileAgreementSkeleton,
} from "../../backend/src/lib/legalTextSkeleton";
import {
  instrumentCorpusFiles,
  readAgreement,
  readPdf,
  ROOT,
} from "./corpus";

const BASELINE = path.join(import.meta.dirname, "structure-baseline.json");
const REPORT = path.join(ROOT, ".tmp/instrument-structure-gate.json");
const WRITE_BASELINE = process.argv.includes("--write-baseline");

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
  const expected = WRITE_BASELINE
    ? null
    : JSON.parse(await fs.readFile(BASELINE, "utf8")) as Baseline;
  const started = performance.now();
  const inputHash = createHash("sha256");
  const resultHash = createHash("sha256");
  const entries: Entry[] = [];
  const totals = emptyTotals();
  const mismatches: Array<{
    id: string;
    fields: string[];
    expected?: string;
    actual?: string;
  }> = [];
  let inputBytes = 0;
  let pages = 0;
  let lines = 0;

  const writeReport = async (complete: boolean) => {
    await fs.mkdir(path.dirname(REPORT), { recursive: true });
    await fs.writeFile(REPORT, `${JSON.stringify({
      schemaVersion: "beaver.instrument-structure-gate-report.v1",
      complete,
      mode: WRITE_BASELINE ? "write-baseline" : "verify",
      checked: entries.length,
      denominators: { agreements: agreements.length, pdfs: pdfs.length, pages, lines },
      inputBytes,
      totals,
      mismatches: mismatches.length,
      mismatchSamples: mismatches.slice(0, 40),
      elapsedSeconds: (performance.now() - started) / 1_000,
      ...(WRITE_BASELINE ? { entries } : {}),
    }, null, 2)}\n`);
  };

  const check = async (id: string, text: string) => {
    clearSkeletonCache();
    const skeleton = await compileAgreementSkeleton(text, id);
    if (skeleton.doc.text !== text) {
      throw new Error(`${id}: SourceDoc text differs from its instrument input`);
    }
    const products = {
      nodes: skeleton.nodes,
      sourceDoc: {
        provider: skeleton.doc.provider,
        id: skeleton.doc.id,
        url: skeleton.doc.url,
        revision: skeleton.doc.revision,
        docType: skeleton.doc.docType,
        status: skeleton.doc.status,
        textSha256: sha256(skeleton.doc.text),
        blocks: skeleton.doc.blocks,
        index: [...skeleton.doc.index.entries()],
        ranges: skeleton.doc.ranges,
      },
      definedTerms: skeleton.definedTerms,
      schedules: skeleton.schedules,
      crossReferences: skeleton.crossReferences,
      ladder: skeleton.ladder,
      contents: {
        outline: skeleton.outline,
        refusal: skeleton.outlineRefusal,
      },
    };
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
    totals.nodes += skeleton.nodes.length;
    totals.sourceDocBlocks += skeleton.doc.blocks.length;
    totals.tableNodes += skeleton.nodes.filter(
      (node) => node.kind === "table" || node.kind === "row" || node.kind === "cell",
    ).length;
    totals.definedTerms += skeleton.definedTerms.length;
    totals.schedules += skeleton.schedules.length;
    totals.internalReferences += skeleton.crossReferences.internal;
    totals.externalReferences += skeleton.crossReferences.external;
    totals.unresolvedReferences += skeleton.crossReferences.unresolved.length;
    totals.contentsPresent += Number(skeleton.outline !== null);
    totals.contentsRefused += Number(skeleton.outlineRefusal !== null);

    const prior = expected?.entries[entries.length - 1];
    if (prior) {
      const fields: string[] = COMPONENTS.filter(
        (name) => prior.components[name] !== components[name],
      );
      if (prior.id !== id) fields.unshift("id");
      if (prior.inputSha256 !== entry.inputSha256) fields.unshift("input");
      if (fields.length || prior.resultSha256 !== entry.resultSha256) {
        mismatches.push({
          id,
          fields,
          expected: prior.resultSha256,
          actual: entry.resultSha256,
        });
      }
    } else if (expected) {
      mismatches.push({ id, fields: ["missing-baseline-entry"] });
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
    const document = await readAgreement(file);
    await check(document.id, document.text);
  }
  for (const file of pdfs) {
    const document = await readPdf(file);
    pages += document.pages;
    lines += document.lines;
    await check(document.id, document.text);
  }
  if (pages !== 24_707 || lines !== 1_221_262) {
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
  } else {
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
