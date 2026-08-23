import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { openDocxSession } from "../../backend/src/lib/docx/session";
import { lintDocxStructure } from "../../backend/src/lib/docxStructuralLint";
import { decodeXmlText, escapeRegExp } from "../../backend/src/lib/text";
import { documentScalarOffsets } from "../../backend/src/lib/structureWire";
import {
  instrumentCorpusFiles,
  readAgreement,
  readPdf,
  ROOT,
} from "../instrument_lineation_parity/corpus";

const BASELINE = path.join(import.meta.dirname, "docx-baseline.json");
const INSTRUMENT_BASELINE = path.join(
  ROOT,
  "experiments/instrument_lineation_parity/structure-baseline.json",
);
const REPORT = path.join(ROOT, ".tmp/defined-terms-parity/report.json");
const RUNNER = path.join(
  ROOT,
  "legal-pdf-parser/target/debug/defined-terms-parity.exe",
);
const DOCX_ROOTS = [
  path.join(ROOT, "benchmarks/docx_corpus"),
  path.join(ROOT, "benchmarks/docx_edit/fixtures"),
];
const PARAGRAPH_PATTERN = /<w:p\b[\s\S]*?<\/w:p>/gu;
const TEXT_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu;
const DELETED_RUN_PATTERN = /<w:del\b[\s\S]*?<\/w:del>/gu;
const TERM_RE = /"([A-Z][A-Za-z0-9&'\- ]{0,79})"/dgu;
const LIST_RE = /^"([A-Z][A-Za-z0-9&'\- ]{0,79})"\s+(?:means|shall mean|has the meaning|shall have the meaning)\b/du;
const PARENTHETICAL_RE = /\(([^()]{1,200})\)/dgu;

type ScalarRange = { start: number; end: number };
type Paragraph = {
  text: string;
  startUtf16: number;
  range: ScalarRange;
  source_paragraph_id: string;
  source_artifact_id: string;
};
type Occurrence = {
  range: ScalarRange;
  node_id?: string;
  source_paragraph_id: string;
  source_artifact_id: string;
};
type DefinitionsResult = {
  terms: Array<{ term: string; definitions: Occurrence[]; uses: Occurrence[] }>;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

async function filesBelow(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name !== "private_results") {
      found.push(...await filesBelow(target));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".docx")) {
      found.push(target);
    }
  }
  return found;
}

function docxParagraphTexts(documentXml: string): string[] {
  const texts: string[] = [];
  for (const paragraph of documentXml.matchAll(PARAGRAPH_PATTERN)) {
    const withoutDeleted = paragraph[0].replace(DELETED_RUN_PATTERN, "");
    const parts: string[] = [];
    for (const text of withoutDeleted.matchAll(TEXT_PATTERN)) {
      parts.push(decodeXmlText(text[1] ?? ""));
    }
    texts.push(parts.join("")
      .replace(/[“”]/gu, '"')
      .replace(/[‘’]/gu, "'")
      .replace(/[   ]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim());
  }
  return texts;
}

function paragraphsFor(text: string, texts: string[], artifact: string): Paragraph[] {
  const offsets = documentScalarOffsets(text);
  let startUtf16 = 0;
  return texts.map((value, index) => {
    const endUtf16 = startUtf16 + value.length;
    const paragraph = {
      text: value,
      startUtf16,
      range: {
        start: offsets.utf16ToScalar(startUtf16),
        end: offsets.utf16ToScalar(endUtf16),
      },
      source_paragraph_id: String(index),
      source_artifact_id: artifact,
    };
    startUtf16 = endUtf16 + 1;
    return paragraph;
  });
}

function instrumentParagraphs(text: string, artifact: string): Paragraph[] {
  const texts = text.split("\n").map((raw) => raw.replace(/\r$/u, ""));
  const offsets = documentScalarOffsets(text);
  let startUtf16 = 0;
  return texts.map((value, index) => {
    const paragraph = {
      text: value,
      startUtf16,
      range: {
        start: offsets.utf16ToScalar(startUtf16),
        end: offsets.utf16ToScalar(startUtf16 + value.length),
      },
      source_paragraph_id: String(index),
      source_artifact_id: artifact,
    };
    startUtf16 += value.length + Number(text[startUtf16 + value.length] === "\r") + 1;
    return paragraph;
  });
}

function occurrence(
  paragraph: Paragraph,
  localStart: number,
  localEnd: number,
  offsets: ReturnType<typeof documentScalarOffsets>,
): Occurrence {
  return {
    range: {
      start: offsets.utf16ToScalar(paragraph.startUtf16 + localStart),
      end: offsets.utf16ToScalar(paragraph.startUtf16 + localEnd),
    },
    source_paragraph_id: paragraph.source_paragraph_id,
    source_artifact_id: paragraph.source_artifact_id,
  };
}

function oracleDefinitions(
  text: string,
  paragraphs: Paragraph[],
): DefinitionsResult {
  const offsets = documentScalarOffsets(text);
  const terms = new Map<string, Array<{ paragraph: number; occurrence: Occurrence }>>();
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex];
    const seen = new Map<string, Occurrence>();
    for (const parenthetical of paragraph.text.matchAll(PARENTHETICAL_RE)) {
      const innerStart = (parenthetical.index ?? 0) + 1;
      for (const quoted of (parenthetical[1] ?? "").matchAll(TERM_RE)) {
        const term = quoted[1];
        if (!term || seen.has(term)) continue;
        const start = innerStart + (quoted.index ?? 0) + 1;
        seen.set(term, occurrence(paragraph, start, start + term.length, offsets));
      }
    }
    const list = paragraph.text.match(LIST_RE);
    if (list?.[1] && !seen.has(list[1])) {
      seen.set(list[1], occurrence(paragraph, 1, 1 + list[1].length, offsets));
    }
    for (const [term, definition] of seen) {
      const definitions = terms.get(term) ?? [];
      definitions.push({ paragraph: paragraphIndex, occurrence: definition });
      terms.set(term, definitions);
    }
  }

  return {
    terms: [...terms].map(([term, definitions]) => {
      const definedIn = new Set(definitions.map(({ paragraph }) => paragraph));
      const variants = new Set([term, term.endsWith("s") ? term.slice(0, -1) : `${term}s`]);
      const uses: Occurrence[] = [];
      for (let index = 0; index < paragraphs.length; index += 1) {
        if (definedIn.has(index)) continue;
        const paragraph = paragraphs[index];
        const ranges: Array<[number, number]> = [];
        for (const variant of variants) {
          const regex = new RegExp(
            `(?<![A-Za-z0-9])${escapeRegExp(variant)}(?![a-z0-9])`,
            "dgu",
          );
          for (const match of paragraph.text.matchAll(regex)) {
            ranges.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
          }
        }
        ranges.sort(([left], [right]) => left - right);
        for (const [start, end] of ranges) {
          uses.push(occurrence(paragraph, start, end, offsets));
        }
      }
      return {
        term,
        definitions: definitions.map(({ occurrence: value }) => value),
        uses,
      };
    }),
  };
}

function excerptAround(text: string, subject: string): string {
  const index = text.indexOf(subject);
  if (index < 0) return text.slice(0, 160);
  const start = Math.max(0, index - Math.floor((160 - subject.length) / 2));
  const slice = text.slice(start, start + 160);
  return `${start > 0 ? "…" : ""}${slice}${start + 160 < text.length ? "…" : ""}`;
}

function lintProjection(paragraphs: string[], result: DefinitionsResult) {
  const findings: unknown[] = [];
  const notes: string[] = [];
  if (!result.terms.length) {
    notes.push("No quoted defined terms were detected; defined-term checks abstained.");
  }
  for (const term of result.terms) {
    const definedIn = term.definitions.map(({ source_paragraph_id }) =>
      Number(source_paragraph_id)
    );
    if (definedIn.length > 1) {
      const paragraph = definedIn[definedIn.length - 1];
      findings.push({
        code: "defined_term_duplicate",
        severity: "warning",
        subject: term.term,
        message: `"${term.term}" is defined ${definedIn.length} times (paragraphs ${definedIn.join(", ")}).`,
        paragraph_index: paragraph,
        excerpt: excerptAround(paragraphs[paragraph], term.term),
      });
    }
    if (!term.uses.length) {
      const paragraph = definedIn[0];
      findings.push({
        code: "defined_term_unused",
        severity: "warning",
        subject: term.term,
        message: `"${term.term}" is defined but never used elsewhere in this document.`,
        paragraph_index: paragraph,
        excerpt: excerptAround(paragraphs[paragraph], term.term),
      });
    }
  }
  return {
    paragraphs: paragraphs.length,
    collected: result.terms.map((term) => [
      term.term,
      term.definitions.map(({ source_paragraph_id }) => Number(source_paragraph_id)),
    ]),
    check: { definitions: result.terms.length },
    findings,
    notes,
  };
}

class Runner {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: AsyncIterator<string>;

  constructor() {
    this.child = spawn(RUNNER, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.pipe(process.stderr);
    this.output = readline.createInterface({ input: this.child.stdout })[Symbol.asyncIterator]();
  }

  async analyze(input: unknown): Promise<DefinitionsResult> {
    if (!this.child.stdin.write(`${JSON.stringify(input)}\n`)) {
      await new Promise<void>((resolve) => this.child.stdin.once("drain", resolve));
    }
    const next = await this.output.next();
    if (next.done) throw new Error("defined-term Rust runner exited early");
    const output = JSON.parse(next.value) as {
      id: string;
      result?: DefinitionsResult;
      error?: string;
    };
    if (output.error || !output.result) throw new Error(output.error ?? "missing Rust result");
    return output.result;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`runner exited ${code}`)));
    });
  }
}

async function main(): Promise<void> {
  const started = performance.now();
  const docxBaseline = JSON.parse(await fs.readFile(BASELINE, "utf8"));
  const instrumentBaseline = JSON.parse(await fs.readFile(INSTRUMENT_BASELINE, "utf8"));
  const runner = new Runner();
  const groups = new Map<string, {
    count: number;
    examples: Array<{ id: string; expected?: unknown; actual?: unknown }>;
  }>();
  const mismatch = (cause: string, value: { id: string; expected?: unknown; actual?: unknown }) => {
    const group = groups.get(cause) ?? { count: 0, examples: [] };
    group.count += 1;
    if (group.examples.length < 20) group.examples.push(value);
    groups.set(cause, group);
  };
  const totals = {
    docxDocuments: 0,
    docxSuccessful: 0,
    docxExact: 0,
    docxErrors: 0,
    instrumentDocuments: 0,
    instrumentExact: 0,
    instrumentTerms: 0,
    definitions: 0,
    uses: 0,
    duplicates: 0,
  };
  const writeReport = async (complete: boolean) => {
    await fs.mkdir(path.dirname(REPORT), { recursive: true });
    await fs.writeFile(REPORT, `${JSON.stringify({
      schemaVersion: "beaver.defined-terms-parity-report.v1",
      complete,
      totals,
      mismatches: [...groups].map(([cause, { count, examples }]) => ({
        cause,
        count,
        examples,
      })),
      elapsedSeconds: (performance.now() - started) / 1_000,
    }, null, 2)}\n`);
  };

  const byHash = new Map<string, { bytes: Buffer; roots: Set<number> }>();
  for (let root = 0; root < DOCX_ROOTS.length; root += 1) {
    for (const file of await filesBelow(DOCX_ROOTS[root])) {
      const bytes = await fs.readFile(file);
      const hash = sha256(bytes);
      const entry = byHash.get(hash) ?? { bytes, roots: new Set<number>() };
      entry.roots.add(root);
      byHash.set(hash, entry);
    }
  }
  const membership = [...byHash]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([inputSha256, { bytes, roots }]) => ({
      inputSha256,
      bytes: bytes.length,
      roots: [...roots],
    }));
  if (hashJson(membership) !== docxBaseline.membershipSha256) {
    throw new Error("registered DOCX membership differs from the frozen baseline");
  }
  const frozenDocx = new Map(docxBaseline.entries.map((entry: { inputSha256: string }) => [
    entry.inputSha256,
    entry,
  ]));
  for (const [id, entry] of [...byHash].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    totals.docxDocuments += 1;
    const frozen = frozenDocx.get(id) as { outcome: string; outputSha256?: string; error?: string };
    try {
      const session = await openDocxSession(entry.bytes);
      const xml = await session.readText("word/document.xml");
      if (xml == null) throw new Error("Structural lint requires a valid DOCX");
      const texts = docxParagraphTexts(xml);
      const text = texts.join("\n");
      const paragraphs = paragraphsFor(text, texts, id);
      const expected = oracleDefinitions(text, paragraphs);
      const actual = await runner.analyze({
        id,
        text,
        paragraphs: paragraphs.map(({ range, source_paragraph_id, source_artifact_id }) => ({
          range,
          source_paragraph_id,
          source_artifact_id,
        })),
      });
      const report = await lintDocxStructure(entry.bytes);
      const legacy = {
        paragraphs: texts.length,
        collected: expected.terms.map((term) => [
          term.term,
          term.definitions.map(({ source_paragraph_id }) => Number(source_paragraph_id)),
        ]),
        check: report.checks.defined_terms,
        findings: report.findings.filter(({ code }) => code.startsWith("defined_term_")),
        notes: report.notes.filter((note) =>
          note === "No quoted defined terms were detected; defined-term checks abstained." ||
          note.startsWith("Findings truncated to ")
        ),
      };
      if (hashJson(legacy) !== frozen.outputSha256) {
        mismatch("docx-legacy-drift", { id, expected: frozen.outputSha256, actual: hashJson(legacy) });
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatch("docx-facts", { id, expected, actual });
      } else if (hashJson(lintProjection(texts, actual)) !== frozen.outputSha256) {
        mismatch("docx-report-projection", {
          id,
          expected: frozen.outputSha256,
          actual: hashJson(lintProjection(texts, actual)),
        });
      } else {
        totals.docxExact += 1;
      }
      totals.docxSuccessful += 1;
      totals.definitions += actual.terms.reduce((sum, term) => sum + term.definitions.length, 0);
      totals.uses += actual.terms.reduce((sum, term) => sum + term.uses.length, 0);
      totals.duplicates += actual.terms.filter((term) => term.definitions.length > 1).length;
    } catch (error) {
      totals.docxErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (frozen.outcome !== "error" || frozen.error !== message) {
        mismatch("docx-error", { id, expected: frozen, actual: message });
      }
    }
  }

  const baselineById = new Map(instrumentBaseline.entries.map((entry: { id: string }) => [entry.id, entry]));
  const { agreements, pdfs } = await instrumentCorpusFiles();
  const checkInstrument = async (id: string, text: string) => {
    const paragraphs = instrumentParagraphs(text, id);
    const expected = oracleDefinitions(text, paragraphs);
    const actual = await runner.analyze({
      id,
      text,
      paragraphs: paragraphs.map(({ range, source_paragraph_id, source_artifact_id }) => ({
        range,
        source_paragraph_id,
        source_artifact_id,
      })),
    });
    const frozen = baselineById.get(id) as {
      inputSha256: string;
    } | undefined;
    if (!frozen || frozen.inputSha256 !== sha256(text)) {
      mismatch("instrument-input", { id, expected: frozen?.inputSha256, actual: sha256(text) });
    } else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatch("instrument-facts", { id, expected, actual });
    } else {
      totals.instrumentExact += 1;
    }
    totals.instrumentDocuments += 1;
    totals.instrumentTerms += actual.terms.length;
    totals.definitions += actual.terms.reduce((sum, term) => sum + term.definitions.length, 0);
    totals.uses += actual.terms.reduce((sum, term) => sum + term.uses.length, 0);
    totals.duplicates += actual.terms.filter((term) => term.definitions.length > 1).length;
    if (totals.instrumentDocuments % 10 === 0) {
      await writeReport(false);
      process.stderr.write(
        `[${totals.instrumentDocuments}/${agreements.length + pdfs.length}] ` +
        `mismatch-groups=${groups.size} elapsed=${((performance.now() - started) / 1_000).toFixed(1)}s\n`,
      );
    }
  };
  for (const file of agreements) {
    const document = await readAgreement(file);
    await checkInstrument(document.id, document.text);
  }
  for (const file of pdfs) {
    const document = await readPdf(file);
    await checkInstrument(document.id, document.text);
  }
  if (totals.instrumentTerms !== instrumentBaseline.totals.definedTerms) {
    mismatch("instrument-term-total", {
      id: "872-document-corpus",
      expected: instrumentBaseline.totals.definedTerms,
      actual: totals.instrumentTerms,
    });
  }
  await runner.close();
  await writeReport(true);
  if (groups.size) throw new Error(`defined-term parity failed with ${groups.size} mismatch groups`);
  process.stdout.write(`${JSON.stringify(totals)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
