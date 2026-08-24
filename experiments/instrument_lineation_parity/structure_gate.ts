import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { instrumentCorpusFiles, readAgreement, readPdf, ROOT,
  type PdfCorpusFile } from "./corpus";
import type { NativeDocument } from "../../backend/src/lib/structureNative";

const BASELINE = path.join(import.meta.dirname, "structure-baseline.json");
const REPORT = path.join(ROOT, ".tmp/instrument-structure-gate.json");
const DETAILS = path.join(ROOT, ".tmp/instrument-structure-mismatches");
const WRITE_BASELINE = process.argv.includes("--write-baseline");
const CANDIDATE = process.argv.includes("--candidate");
const AGREEMENTS_ONLY = process.argv.includes("--agreements-only");
const argument = (name: string) => process.argv.find((value) =>
  value.startsWith(`--${name}=`))?.slice(name.length + 3);
const LIMIT = Number(argument("limit") ?? Infinity);
const JOBS = Number(argument("jobs") ?? 4);
const MATCH = argument("match")?.toLowerCase();
const AGAINST = argument("against");

type Fingerprint = {
  schemaVersion: "legalpdf.document-fingerprint.v1";
  resultSha256: string;
  components: Record<string, string>;
  counts: { nodes: number; notes: number; authorities: number;
    definitions: number; diagnostics: number };
};
type Addon = {
  derivePdfDocument(bytes: Buffer, request: unknown): Promise<NativeDocument>;
  deriveDocumentFingerprint(request: unknown): Promise<Fingerprint>;
  deriveDocumentStructure(request: unknown): Promise<NativeDocument>;
  documentText(document: NativeDocument): string;
  documentAnchors(document: NativeDocument): unknown;
};
type Entry = Fingerprint & { id: string; inputSha256: string; inputBytes: number };
type Baseline = {
  schemaVersion: "beaver.instrument-structure-freeze.v2";
  denominators: { agreements: number; pdfs: number; pages: number; lines: number };
  inputBytes: number;
  inputSha256: string;
  resultSha256: string;
  entries: Entry[];
};
type Job = { kind: "agreement"; file: string } | { kind: "pdf"; file: PdfCorpusFile };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const safeName = (id: string) => `${id.replace(/[^a-z0-9.-]+/giu, "_").slice(0, 100)}-${sha256(id).slice(0, 10)}.json`;
function framed(hash: ReturnType<typeof createHash>, value: string) {
  hash.update(`${Buffer.byteLength(value)}:`).update(value).update("\n");
}
function loadAddon(filename = process.env.LEGAL_STRUCTURE_NATIVE?.trim() || path.join(
    ROOT, "native/legal-structure-node/target/release",
    process.platform === "win32" ? "legal_structure_node.dll"
      : process.platform === "darwin" ? "liblegal_structure_node.dylib"
      : "liblegal_structure_node.so",
  )): Addon {
  const module = { exports: {} } as NodeModule;
  process.dlopen(module, path.resolve(filename));
  return module.exports as Addon;
}

async function main() {
  if (WRITE_BASELINE && CANDIDATE) throw new Error("choose --candidate or --write-baseline");
  if (WRITE_BASELINE && AGAINST) throw new Error("--against cannot replace the baseline");
  if (!Number.isInteger(JOBS) || JOBS < 1) throw new Error("--jobs must be a positive integer");
  if (LIMIT !== Infinity && (!Number.isInteger(LIMIT) || LIMIT < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  const addon = loadAddon();
  const referenceAddon = AGAINST ? loadAddon(path.resolve(AGAINST)) : null;
  const corpus = await instrumentCorpusFiles(!AGREEMENTS_ONLY);
  const allJobs: Job[] = [
    ...corpus.agreements.map((file) => ({ kind: "agreement" as const, file })),
    ...corpus.pdfs.map((file) => ({ kind: "pdf" as const, file })),
  ];
  const jobs = allJobs.filter((job) => !MATCH ||
    (typeof job.file === "string" ? job.file : job.file.file).toLowerCase().includes(MATCH))
    .slice(0, LIMIT);
  if (WRITE_BASELINE && (MATCH || Number.isFinite(LIMIT))) {
    throw new Error("refusing to replace the durable baseline from a partial corpus");
  }
  if (!jobs.length) throw new Error("no corpus documents matched the selection");
  const expected = WRITE_BASELINE || CANDIDATE || AGAINST ? null
    : JSON.parse(await fs.readFile(BASELINE, "utf8")) as Baseline;
  if (expected && expected.schemaVersion !== "beaver.instrument-structure-freeze.v2") {
    throw new Error("baseline schema changed; review the fingerprint, then run --write-baseline");
  }
  const expectedById = new Map(expected?.entries.map((entry) => [entry.id, entry]));
  const entries = new Array<Entry>(jobs.length);
  const mismatches: Array<{ id: string; fields: string[] }> = [];
  let cursor = 0;
  let checked = 0;
  let pages = 0;
  let lines = 0;
  const started = performance.now();
  const inputHash = createHash("sha256");
  const resultHash = createHash("sha256");
  const pending = new Map<number, { entry: Entry; text: string }>();
  let nextHash = 0;
  let reportWrite = Promise.resolve();

  const writeReport = (complete: boolean) => {
    reportWrite = reportWrite.then(async () => {
      await fs.mkdir(path.dirname(REPORT), { recursive: true });
      await fs.writeFile(REPORT, `${JSON.stringify({
        schemaVersion: "beaver.instrument-structure-gate-report.v2",
        complete, mode: WRITE_BASELINE ? "write-baseline" : AGAINST ? "differential"
          : CANDIDATE ? "candidate" : "verify",
        checked, selected: jobs.length, jobs: JOBS, mismatches,
        elapsedSeconds: Number(((performance.now() - started) / 1_000).toFixed(3)),
      }, null, 2)}\n`);
    });
    return reportWrite;
  };
  const diagnose = async (id: string, text: string, actual: Entry, prior?: Entry) => {
    const document = await addon.deriveDocumentStructure({
      kind: "instrument", id, text, reconstruct_lineation: true,
    });
    await fs.mkdir(DETAILS, { recursive: true });
    await fs.writeFile(path.join(DETAILS, safeName(id)), `${JSON.stringify({
      id,
      changedComponents: Object.keys(actual.components)
        .filter((name) => prior?.components[name] !== actual.components[name]),
      expected: prior,
      actual,
      production: {
        textSha256: sha256(addon.documentText(document)),
        anchors: addon.documentAnchors(document),
      },
    }, null, 2)}\n`);
  };
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      let source: { id: string; text: string };
      if (job.kind === "agreement") source = await readAgreement(job.file);
      else {
        const pdf = await readPdf(job.file, addon);
        pages += pdf.pages;
        lines += pdf.lines;
        source = pdf;
      }
      const request = {
        kind: "instrument", id: source.id, text: source.text, reconstruct_lineation: true,
      };
      const fingerprint = await addon.deriveDocumentFingerprint(request);
      const reference = referenceAddon && await referenceAddon.deriveDocumentFingerprint(request);
      if (fingerprint.schemaVersion !== "legalpdf.document-fingerprint.v1") {
        throw new Error(`${source.id}: unexpected fingerprint schema ${fingerprint.schemaVersion}`);
      }
      const entry: Entry = { id: source.id, inputSha256: sha256(source.text),
        inputBytes: Buffer.byteLength(source.text), ...fingerprint };
      if (reference && reference.resultSha256 !== entry.resultSha256) {
        mismatches.push({ id: source.id, fields: Object.keys(entry.components)
          .filter((name) => reference.components[name] !== entry.components[name]) });
      }
      entries[index] = entry;
      pending.set(index, { entry, text: source.text });
      while (pending.has(nextHash)) {
        const value = pending.get(nextHash)!;
        pending.delete(nextHash++);
        framed(inputHash, value.entry.id); framed(inputHash, value.text);
        framed(resultHash, value.entry.id); framed(resultHash, value.entry.resultSha256);
      }
      const prior = expectedById.get(source.id);
      if (expected && (!prior || prior.inputSha256 !== entry.inputSha256 ||
          prior.resultSha256 !== entry.resultSha256)) {
        const fields = !prior ? ["missing-baseline-entry"] : [
          ...(prior.inputSha256 === entry.inputSha256 ? [] : ["input"]),
          ...Array.from(new Set([...Object.keys(prior.components), ...Object.keys(entry.components)]))
            .filter((name) => prior.components[name] !== entry.components[name]),
        ];
        if (prior && prior.resultSha256 !== entry.resultSha256 && fields.length === 0) {
          fields.push("result");
        }
        mismatches.push({ id: source.id, fields });
        if (mismatches.length <= 20) await diagnose(source.id, source.text, entry, prior);
      }
      checked += 1;
      const progress = checked;
      if (progress % 100 === 0) {
        await writeReport(false);
        process.stderr.write(`[${progress}/${jobs.length}] mismatches=${mismatches.length} ` +
          `elapsed=${((performance.now() - started) / 1_000).toFixed(1)}s\n`);
      }
    }
  };
  await writeReport(false);
  await Promise.all(Array.from({ length: Math.min(JOBS, jobs.length) }, worker));

  const inputBytes = entries.reduce((sum, entry) => sum + entry.inputBytes, 0);
  const baseline: Baseline = {
    schemaVersion: "beaver.instrument-structure-freeze.v2",
    denominators: { agreements: jobs.filter((job) => job.kind === "agreement").length,
      pdfs: jobs.filter((job) => job.kind === "pdf").length, pages, lines },
    inputBytes, inputSha256: inputHash.digest("hex"), resultSha256: resultHash.digest("hex"), entries,
  };
  if (WRITE_BASELINE) {
    const temporary = `${BASELINE}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(baseline)}\n`);
    await fs.rename(temporary, BASELINE);
  }
  else if (expected && !MATCH && !Number.isFinite(LIMIT)) {
    if (expected?.entries.length !== entries.length) mismatches.push({ id: "<corpus>", fields: ["entry-count"] });
    if (expected?.inputSha256 !== baseline.inputSha256 || expected?.resultSha256 !== baseline.resultSha256 ||
        JSON.stringify(expected?.denominators) !== JSON.stringify(baseline.denominators)) {
      mismatches.push({ id: "<aggregate>", fields: ["receipt"] });
    }
  }
  await writeReport(true);
  process.stderr.write(`[${checked}/${jobs.length}] mismatches=${mismatches.length} ` +
    `elapsed=${((performance.now() - started) / 1_000).toFixed(1)}s\n`);
  if (mismatches.length) process.exitCode = 1;
}

void main().catch(async (error) => {
  console.error(error);
  await fs.mkdir(path.dirname(REPORT), { recursive: true });
  const prior = await fs.readFile(REPORT, "utf8").then(JSON.parse).catch(() => ({}));
  await fs.writeFile(REPORT, `${JSON.stringify({ ...prior, complete: false,
    error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
});
