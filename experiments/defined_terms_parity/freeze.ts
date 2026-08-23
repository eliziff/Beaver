import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  collectDefinedTerms,
  lintDocxStructure,
} from "../../backend/src/lib/docxStructuralLint";
import { openDocxSession } from "../../backend/src/lib/docx/session";
import { decodeXmlText } from "../../backend/src/lib/text";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUTPUT = path.join(import.meta.dirname, "docx-baseline.json");
const DOCX_ROOTS = [
  path.join(ROOT, "benchmarks/docx_corpus"),
  path.join(ROOT, "benchmarks/docx_edit/fixtures"),
];
const PARAGRAPH_PATTERN = /<w:p\b[\s\S]*?<\/w:p>/gu;
const TEXT_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu;
const DELETED_RUN_PATTERN = /<w:del\b[\s\S]*?<\/w:del>/gu;

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

function paragraphTexts(documentXml: string): string[] {
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

async function definedTermOutput(bytes: Buffer) {
  const session = await openDocxSession(bytes);
  const documentXml = await session.readText("word/document.xml");
  if (documentXml == null) throw new Error("Structural lint requires a valid DOCX");
  const paragraphs = paragraphTexts(documentXml);
  const collected = [...collectDefinedTerms(paragraphs)];
  const report = await lintDocxStructure(bytes);
  return {
    paragraphs: paragraphs.length,
    collected,
    check: report.checks.defined_terms,
    findings: report.findings.filter(({ code }) => code.startsWith("defined_term_")),
    notes: report.notes.filter((note) =>
      note === "No quoted defined terms were detected; defined-term checks abstained." ||
      note.startsWith("Findings truncated to ")
    ),
  };
}

async function main(): Promise<void> {
  const started = performance.now();
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

  const entries = [];
  let succeeded = 0;
  let definitions = 0;
  let findings = 0;
  let abstained = 0;
  let checked = 0;
  for (const [inputSha256, entry] of [...byHash].sort(([left], [right]) =>
    left.localeCompare(right, "en")
  )) {
    try {
      const output = await definedTermOutput(entry.bytes);
      entries.push({
        inputSha256,
        bytes: entry.bytes.length,
        roots: [...entry.roots],
        outcome: "ok",
        outputSha256: hashJson(output),
      });
      succeeded += 1;
      definitions += output.collected.length;
      findings += output.findings.length;
      abstained += Number(output.collected.length === 0);
    } catch (error) {
      entries.push({
        inputSha256,
        bytes: entry.bytes.length,
        roots: [...entry.roots],
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    checked += 1;
    process.stderr.write(`[${checked}/${byHash.size}] frozen\r`);
  }
  process.stderr.write("\n");

  const payload = {
    schemaVersion: "beaver.defined-terms-docx-freeze.v1",
    roots: ["benchmarks/docx_corpus", "benchmarks/docx_edit/fixtures"],
    membershipSha256: hashJson(entries.map(({ inputSha256, bytes, roots }) => ({
      inputSha256,
      bytes,
      roots,
    }))),
    totals: {
      documents: entries.length,
      succeeded,
      errors: entries.length - succeeded,
      definitions,
      findings,
      abstained,
    },
    entries,
  };
  await fs.writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(
    `frozen ${entries.length} documents in ${((performance.now() - started) / 1_000).toFixed(2)}s\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
