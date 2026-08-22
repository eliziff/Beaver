import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchLocalA2AJDocumentsByIds } from "../../../backend/src/lib/a2ajLocalBulk";
import { deriveA2AJSourceDoc } from "../../../backend/src/lib/sourceDocStructureHost";
import {
  compileCaseDecisionSubmission,
  decisionCitationInventory,
  type CaseDecisionSubmission,
} from "../../../backend/experiments/a2aj-decision-roster/caseDecisionMvp";
import { modelSourceLines } from "../../../backend/experiments/a2aj-decision-roster/caseTargetMvpReduced";

type GoldRow = {
  document_id: number;
  citation: string;
  source_sha256: string;
  inventory_sha256: string;
  annotator: string;
  gold_schema_version: string;
  semantic_audit: { status: string; passes: Array<{ kind: string; completed_on: string }> };
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

async function citationInventory(document: ReturnType<typeof fetchLocalA2AJDocumentsByIds> extends Map<number, infer T> ? T : never) {
  const source = await deriveA2AJSourceDoc({
    citation: document.citation ?? "",
    docType: "cases",
    text: document.text,
    url: document.url,
    alternateCitation: document.alternateCitation,
    dataset: document.dataset,
    name: document.name,
  });
  const bodyEnd = source.blocks.filter(({ kind }) => kind === "paragraph").at(-1)?.end ?? document.text.length;
  return decisionCitationInventory(document.text, document.citation ?? "", bodyEnd);
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
    const inventory = await citationInventory(document);
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
  const rows = JSON.parse(await readFile(goldFile, "utf8")) as GoldRow[];
  const allowDraft = process.argv.includes("--allow-draft");
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
    if (row.source_sha256 !== sha256(sourceText)) errors.push("source hash mismatch");
    if (row.inventory_sha256 !== sha256(JSON.stringify(inventory))) errors.push("citation inventory hash mismatch");
    if (!allowDraft && (row.semantic_audit.status !== "audited" || row.semantic_audit.passes.length < 2)) {
      errors.push("two adversarial audit passes are required");
    }
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
  const rows = JSON.parse(await readFile(goldFile, "utf8")) as GoldRow[];
  const documents = fetchLocalA2AJDocumentsByIds({ ids: rows.map(({ document_id }) => document_id), maxChars: Number.MAX_SAFE_INTEGER });
  const output: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const document = documents.get(row.document_id);
    if (!document) throw new Error(`missing A2AJ decision ${row.document_id}`);
    const inventory = await citationInventory(document);
    const authorityByOccurrence = new Map(inventory.authorities.flatMap((authority) =>
      authority.occurrence_ids.map((id) => [id, authority] as const)
    ));
    const assessmentByOccurrence = new Map(row.annotation.analysis.authorities.flatMap((authority) =>
      authority.occurrences.map((item) => [item.occurrence_id, item] as const)
    ));
    const treatments = row.annotation.analysis.authorities.flatMap((authority) => authority.treatments.map((treatment) => {
      const issue = row.annotation.analysis.issues[treatment.issue_number - 1];
      return { authority, issue, treatment };
    }));
    const used = new Set<string>();
    for (const item of treatments) {
      const ids = item.treatment.occurrence_ids;
      ids.forEach((id) => used.add(id));
      const authority = authorityByOccurrence.get(ids[0]);
      const opinionIndex = item.treatment.containing_opinion_number - 1;
      output.push({
        containing_document_id: row.document_id,
        containing_citation: row.citation,
        opinion_index: opinionIndex < 0 ? null : opinionIndex + 1,
        opinion_authorship: opinionIndex < 0 ? null : row.annotation.structure.opinions[opinionIndex].authorship,
        issue: item.issue?.question ?? null,
        cited_authority: authority?.display_citations ?? [],
        citation_occurrence_ids: ids,
        text_source: ids.map((id) => assessmentByOccurrence.get(id)?.text_source ?? null),
        proposition_attributed_to: ids.map((id) => assessmentByOccurrence.get(id)?.proposition_attributed_to ?? null),
        treatment: item.treatment.operation,
        proposition: item.treatment.proposition,
        evidence_lines: item.treatment.evidence,
      });
    }
    for (const occurrence of inventory.occurrences.filter(({ id }) => !used.has(id))) {
      const authority = authorityByOccurrence.get(occurrence.id);
      const assessment = assessmentByOccurrence.get(occurrence.id);
      output.push({
        containing_document_id: row.document_id,
        containing_citation: row.citation,
        opinion_index: null,
        opinion_authorship: null,
        issue: null,
        answer: null,
        cited_authority: authority?.display_citations ?? [],
        citation_occurrence_ids: [occurrence.id],
        text_source: assessment?.text_source ?? null,
        proposition_attributed_to: assessment?.proposition_attributed_to ?? null,
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
