#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const options = Object.fromEntries(process.argv.slice(2).flatMap((value, index, all) =>
  value.startsWith("--") ? [[value.slice(2), all[index + 1]]] : [],
));
if (!options.results) throw new Error("usage: node analyze_deterministic_audit.mjs --results audit.results.jsonl [--out analysis.json]");

const reported = /\b(?:adds?|added|cites?|concludes?|concluded|continues?|continued|deals?|dealt|delivers?|delivered|describes?|described|discusses?|discussed|elucidates?|elucidated|explains?|explained|holds?|held|notes?|noted|observes?|observed|orders?|ordered|points?\s+out|pointed\s+out|remarks?|remarked|said|says|states?|stated|summarizes?|summarized|touches?\s+upon|touched\s+upon|writes?|wrote)\b/iu;
const generic = /^(?:adjudicator|arbitrator|board member|chair|chairperson|court|judge|justice|member|panel|prothonotary|registrar|tribunal|vice[- ]chair)$/iu;
const examples = { reported_opinion_evidence: [], generic_panel_member: [], author_not_panel: [] };
const counts = { reported_opinion_evidence: 0, generic_panel_member: 0, author_not_panel: 0 };
const documents = { reported_opinion_evidence: new Set(), generic_panel_member: new Set(), author_not_panel: new Set() };
let ready = 0;

function surname(name) {
  return String(name).normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.filter((word) => !/^(?:a|acj|b|c|cj|f|j|ja|jc|jj|jca|n|o|q|s|t|judge|justice)$/u.test(word)).at(-1) ?? "";
}

function add(kind, source, detail) {
  counts[kind] += 1;
  if (Number.isSafeInteger(Number(source.document_id))) documents[kind].add(Number(source.document_id));
  if (examples[kind].length < 50) examples[kind].push({
    document: source.document_id,
    dataset: source.dataset,
    citation: source.citation,
    ...detail,
  });
}

const lines = createInterface({ input: createReadStream(options.results, "utf8"), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const event = JSON.parse(line);
  const receipt = event.receipt ?? {};
  const deterministic = receipt.deterministic ?? {};
  if (deterministic.status !== "ready") continue;
  ready += 1;
  const panel = Array.isArray(deterministic.panel) ? deterministic.panel.map(String) : [];
  const panelSurnames = new Set(panel.map(surname).filter(Boolean));
  for (const name of panel) {
    if (generic.test(name.trim())) add("generic_panel_member", receipt.source ?? {}, { name, panel });
  }
  for (const opinion of Array.isArray(deterministic.opinions) ? deterministic.opinions : []) {
    const evidence = Array.isArray(opinion.evidence) ? opinion.evidence.map(String).join(" | ") : "";
    const instantCourtHeading = /^(?:the\s+)?(?:judg(?:e)?ment|decision)\s+of\s+(?:the\s+)?(?:court|majority\b)/iu.test(evidence) ||
      /^(?:the\s+)?(?:judg(?:e)?ment|decision)\s+of\s+.{1,240}?\s+(?:was\s+)?delivered\s+(?:orally\s+)?by\s*:?[—–-]*\s*\|\s*.{1,100}\b(?:C\.?J\.?|J\.?)$/iu.test(evidence);
    if (reported.test(evidence) && !instantCourtHeading) add("reported_opinion_evidence", receipt.source ?? {}, { authors: opinion.authors ?? [], evidence, panel });
    for (const author of Array.isArray(opinion.authors) ? opinion.authors : []) {
      if (panelSurnames.size && !panelSurnames.has(surname(author))) add("author_not_panel", receipt.source ?? {}, { author, evidence, panel });
    }
  }
}

const result = {
  format: "a2aj-deterministic-audit-anomalies-v1",
  ready,
  counts,
  document_ids: [...new Set(Object.values(documents).flatMap((ids) => [...ids]))],
  documents_by_kind: Object.fromEntries(Object.entries(documents).map(([name, ids]) => [name, [...ids]])),
  examples,
};
const output = `${JSON.stringify(result, null, 2)}\n`;
if (options.out) await writeFile(options.out, output, "utf8");
else process.stdout.write(output);
