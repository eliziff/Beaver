import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchLocalA2AJDocumentsByIds } from "../../../backend/src/lib/a2ajLocalBulk";
import {
  compileCaseDecisionSubmission,
  decisionCitationInventory,
  type CaseDecisionSubmission,
} from "../../../backend/experiments/a2aj-decision-roster/caseDecisionMvp";
import { modelSourceLines } from "../../../backend/experiments/a2aj-decision-roster/caseTargetMvpReduced";

type GoldRow = {
  document_id: number;
  citation: string;
  annotation: CaseDecisionSubmission;
};

function flag(name: string, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function idsArg() {
  return flag("--document-ids").split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
}

function sourceLineRange(lines: ReturnType<typeof modelSourceLines>, start: number, end: number) {
  const hits = lines.filter((line) => line.end > start && line.start < end);
  return hits.length ? [hits[0].line, hits.at(-1)!.line] : [null, null];
}

function citationInventory(document: ReturnType<typeof fetchLocalA2AJDocumentsByIds> extends Map<number, infer T> ? T : never) {
  return decisionCitationInventory(document.text, document.citation ?? "", document.text.length);
}

async function readGold(filename: string) {
  const text = await readFile(filename, "utf8");
  return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as GoldRow);
}

async function packets() {
  const ids = idsArg();
  const out = path.resolve(flag("--out"));
  if (!ids.length || !flag("--out")) throw new Error("packets requires --document-ids and --out");
  const documents = fetchLocalA2AJDocumentsByIds({ ids, maxChars: Number.MAX_SAFE_INTEGER });
  await mkdir(path.join(out, "packets"), { recursive: true });
  const index: Array<Record<string, unknown>> = [];
  for (const [position, id] of ids.entries()) {
    const document = documents.get(id);
    if (!document) throw new Error(`missing A2AJ decision ${id}`);
    const sourceText = document.text;
    const sourceLines = modelSourceLines(sourceText);
    const inventory = citationInventory(document);
    const packet = {
      document_id: id,
      source: {
        dataset: document.dataset,
        citation: document.citation,
        name: document.name,
        date: document.date,
      },
      source_sha256: sha256(sourceText),
      inventory_sha256: sha256(JSON.stringify(inventory)),
      authorities: inventory.authorities,
      occurrences: inventory.occurrences.map((item) => ({
        ...item,
        source_lines: sourceLineRange(sourceLines, item.start, item.end),
      })),
      source_lines: sourceLines.map((line) => ({
        line: line.line,
        text: sourceText.slice(line.start, line.end),
      })),
    };
    const packetFile = `packets/${id}.json`;
    await writeFile(path.join(out, packetFile), `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    index.push({ document_id: id, citation: document.citation, packet_file: packetFile, source_sha256: packet.source_sha256, inventory_sha256: packet.inventory_sha256 });
    process.stdout.write(`\rpackets ${position + 1}/${ids.length}`);
  }
  await writeFile(path.join(out, "index.json"), `${JSON.stringify({ format: "a2aj-case-decision-gold-packets-v1", cases: index }, null, 2)}\n`, "utf8");
  process.stdout.write(`\n${out}\n`);
}

async function validate() {
  const goldFile = path.resolve(flag("--gold"));
  if (!flag("--gold")) throw new Error("validate requires --gold");
  const rows = await readGold(goldFile);
  const ids = rows.map(({ document_id }) => document_id);
  if (new Set(ids).size !== ids.length) throw new Error("gold contains duplicate document IDs");
  const documents = fetchLocalA2AJDocumentsByIds({ ids, maxChars: Number.MAX_SAFE_INTEGER });
  for (const [index, row] of rows.entries()) {
    const document = documents.get(row.document_id);
    if (!document) throw new Error(`missing A2AJ decision ${row.document_id}`);
    const sourceText = document.text;
    const sourceLines = modelSourceLines(sourceText);
    const finalOpinionLine = Math.max(...row.annotation.structure.opinions.map(({ boundary }) => boundary.end_line));
    const inventory = decisionCitationInventory(sourceText, row.citation, sourceLines[finalOpinionLine - 1]?.end ?? sourceText.length);
    const errors: string[] = [];
    const result = compileCaseDecisionSubmission({ submission: row.annotation, sourceText, sourceLines, inventory });
    errors.push(...result.errors);
    if (errors.length) throw new Error(`${row.document_id}: ${[...new Set(errors)].join("; ")}`);
    process.stdout.write(`\rvalidated ${index + 1}/${rows.length}`);
  }
  process.stdout.write(`\nPASS ${rows.length} whole-decision gold records\n`);
}

async function show() {
  const packetFile = path.resolve(flag("--packet"));
  if (!flag("--packet")) throw new Error("show requires --packet");
  const packet = JSON.parse(await readFile(packetFile, "utf8")) as any;
  const byLine = new Map<number, string[]>();
  for (const occurrence of packet.occurrences ?? []) {
    const line = Number(occurrence.source_lines?.[0]);
    if (!line) continue;
    const marker = `${occurrence.id}/${occurrence.authority_id}=${JSON.stringify(occurrence.quote)}`;
    byLine.set(line, [...(byLine.get(line) ?? []), marker]);
  }
  console.log(JSON.stringify({ document_id: packet.document_id, source: packet.source, authorities: packet.authorities }, null, 2));
  for (const line of packet.source_lines ?? []) {
    console.log(`${String(line.line).padStart(5, "0")}${byLine.has(line.line) ? ` [${byLine.get(line.line)!.join(", ")}]` : ""} | ${line.text}`);
  }
}

async function flatten() {
  const goldFile = path.resolve(flag("--gold"));
  const outFile = path.resolve(flag("--out"));
  if (!flag("--gold") || !flag("--out")) throw new Error("flatten requires --gold and --out");
  const rows = await readGold(goldFile);
  const documents = fetchLocalA2AJDocumentsByIds({ ids: rows.map(({ document_id }) => document_id), maxChars: Number.MAX_SAFE_INTEGER });
  const output: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const document = documents.get(row.document_id);
    if (!document) throw new Error(`missing A2AJ decision ${row.document_id}`);
    const references = new Map(row.annotation.analysis.references.map((reference) => [reference.reference_id, reference]));
    const used = new Set<string>();
    for (const treatment of row.annotation.analysis.treatments) {
      const ids = treatment.reference_ids;
      ids.forEach((id) => used.add(id));
      const cited = ids.map((id) => references.get(id)).filter(Boolean);
      const issue = row.annotation.analysis.issues[treatment.issue_number - 1];
      const opinionIndex = treatment.containing_opinion_number - 1;
      output.push({
        containing_document_id: row.document_id,
        containing_citation: row.citation,
        opinion_index: opinionIndex < 0 ? null : opinionIndex + 1,
        opinion_authorship: opinionIndex < 0 ? null : row.annotation.structure.opinions[opinionIndex].authorship,
        issue: issue?.question ?? null,
        cited_references: cited.map((reference) => reference!.exact_reference),
        reference_ids: ids,
        detected_occurrence_ids: cited.map((reference) => reference!.detected_occurrence_id),
        text_source: cited.map((reference) => reference!.text_source),
        proposition_attributed_to: cited.map((reference) => reference!.proposition_attributed_to),
        treatment: treatment.operation,
        proposition: treatment.proposition,
        explanation: treatment.explanation,
        quoted_passage_ids: treatment.quoted_passage_ids,
        evidence_lines: treatment.evidence,
      });
    }
    for (const reference of row.annotation.analysis.references.filter(({ reference_id }) => !used.has(reference_id))) {
      output.push({
        containing_document_id: row.document_id,
        containing_citation: row.citation,
        opinion_index: null,
        opinion_authorship: null,
        issue: null,
        answer: null,
        cited_references: [reference.exact_reference],
        reference_ids: [reference.reference_id],
        detected_occurrence_ids: [reference.detected_occurrence_id],
        text_source: reference.text_source,
        proposition_attributed_to: reference.proposition_attributed_to,
        treatment: null,
        proposition: null,
        evidence_lines: null,
      });
    }
  }
  await writeFile(outFile, `${output.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  console.log(`${output.length} citation-treatment rows -> ${outFile}`);
}

async function main() {
  const command = process.argv[2];
  if (command === "packets") await packets();
  else if (command === "validate") await validate();
  else if (command === "show") await show();
  else if (command === "flatten") await flatten();
  else throw new Error("commands: packets | validate | show | flatten");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
