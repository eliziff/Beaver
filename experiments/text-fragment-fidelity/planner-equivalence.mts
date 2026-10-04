#!/usr/bin/env node
// Records every text-fragment plan and link Beaver builds over a fixed corpus of real A2AJ
// passages, so two builds of the native planner can be proved byte-identical in what they build.
//
// Usage (repo root, once per build under test; rerun to resume after any interruption):
//   LEGAL_STRUCTURE_NATIVE=<addon> npx tsx --tsconfig backend/tsconfig.dev.json \
//     experiments/text-fragment-fidelity/planner-equivalence.mts [--long] [--shard i/n]
// Each run lives in results/equivalence/<addon sha256>[-long]/: manifest.json names the addon,
// the corpus and the bounds; documents/<n>.jsonl holds one document's rows, written atomically,
// so a run skips what it already has; all.jsonl and summary.json appear once every document is
// done. Compare two runs with compare-equivalence.mjs.
//
// The corpus is chosen from the local A2AJ bulk database alone: evenly spaced documents in every
// case and legislation dataset; in each, paragraphs at fixed fractions of the judgment, a
// three-paragraph run, and pattern hits (sections for legislation). Every passage is planned
// with its whole text and with sentence quotes, under every pdf / annotation / html-block flag,
// through the document engine and the standalone planner, plus Beaver's production links.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import "../../backend/src/lib/loadEnv";
import { readLegalSourceResource } from "../../backend/src/lib/researchReader";
import { researchSourceResource } from "../../backend/src/lib/researchFile";
import { legalEvidenceDocumentLink, createLegalEvidenceCitationsFromEntries } from "../../backend/src/lib/chat/citations";
import { structureNative } from "../../backend/src/lib/structureNative";
import type { RegisteredEvidence } from "../../backend/src/lib/chat/legalEvidence";
import type { LegalSourceReference } from "../../shared/contracts/legalSourceReference.mts";

const flags = process.argv.slice(2);
const shardFlag = flags[flags.indexOf("--shard") + 1];
const LONG = flags.includes("--long"), MAX_BLOCK = 4_000;
const [shard, shards] = flags.includes("--shard") ? shardFlag.split("/").map(Number) : [0, 1];
const addonFile = process.env.LEGAL_STRUCTURE_NATIVE?.trim();
if (!addonFile) throw new Error("Set LEGAL_STRUCTURE_NATIVE to the native addon under test.");
const addonSha256 = createHash("sha256").update(fs.readFileSync(addonFile)).digest("hex");
const run = path.join(import.meta.dirname, "results/equivalence", `${addonSha256}${LONG ? "-long" : ""}`);
fs.mkdirSync(path.join(run, "documents"), { recursive: true });
let rows: string[] = [];
const write = (key: string, kind: string, value: unknown) => rows.push(JSON.stringify({ key, kind, value }));

// Evenly spaced documents per dataset: up to 16 judgments per case dataset, 4 per legislation set.
const database = new DatabaseSync(path.join(process.env.LOCALAPPDATA ?? os.homedir(),
  "OpenLegalData/providers/a2aj/a2aj.sqlite"), { readOnly: true });
const datasets = database.prepare("select doc_type, dataset, count(*) as n from document where citation_en is not null " +
  "and length(unofficial_text_en) > 2000 group by doc_type, dataset order by doc_type, dataset").all() as
  Array<{ doc_type: string; dataset: string; n: number }>;
const documents: Array<{ citation: string; kind: "case" | "legislation"; dataset: string }> = [];
for (const { doc_type, dataset, n } of datasets) {
  const wanted = Math.min(n, doc_type === "cases" ? 16 : 4), stride = Math.max(1, Math.floor(n / wanted));
  const rows = database.prepare("select citation_en from document where doc_type = ? and dataset = ? and citation_en is not null " +
    "and length(unofficial_text_en) > 2000 order by id limit ? ").all(doc_type, dataset, stride * wanted) as Array<{ citation_en: string }>;
  for (let index = 0; index < rows.length && documents.length >= 0; index += stride)
    documents.push({ citation: rows[index].citation_en, kind: doc_type === "laws" ? "legislation" : "case", dataset });
}

const corpusSha256 = createHash("sha256").update(JSON.stringify(documents)).digest("hex");
const manifest = { addon: addonFile, addonSha256, corpusSha256, documents: documents.length, maxBlock: MAX_BLOCK,
  long: LONG, node: process.version, harness: createHash("sha256").update(fs.readFileSync(import.meta.filename)).digest("hex") };
const manifestFile = path.join(run, "manifest.json");
if (fs.existsSync(manifestFile)) {
  const previous = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (previous.corpusSha256 !== corpusSha256 || previous.harness !== manifest.harness)
    throw new Error(`${run} holds a different corpus or harness; remove it to start over.`);
} else fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 1)}\n`);

const flagSets = [false, true].flatMap((pdf) => [false, true].flatMap((annotate) =>
  [false, true].map((split) => [pdf, annotate, split] as const)));
const sentences = (text: string) => text.split(/(?<=[.;:])\s+(?=\S)/u).map((value) => value.trim())
  .filter((value) => value.split(/\s+/u).length >= 4);

async function cite(index: number, document: (typeof documents)[number]) {
  // The database row names the source exactly, as a search result would.
  const source: LegalSourceReference = { provider: "a2aj", id: document.citation, citation: document.citation,
    kind: document.kind, collection: document.dataset, language: "en" };
  const resource = researchSourceResource(source);
  const knownSources = new Map<string, LegalSourceReference>([[resource, source]]);
  const read = async (args: Record<string, unknown>) => {
    const input = { file_path: resource, ...args };
    const outcome = await readLegalSourceResource({ id: randomUUID(), name: "Read", input }, input,
      { userId: "", knownSources });
    return (outcome?.evidence ?? []).map((receipt): RegisteredEvidence =>
      ({ receipt, ...outcome!.evidenceSources?.get(receipt.evidence_id) }));
  };
  const opening = await readLegalSourceResource({ id: randomUUID(), name: "Read", input: { file_path: resource } },
    { file_path: resource }, { userId: "", knownSources });
  const extent = (() => { try { const block = opening?.result.content[0];
    return (JSON.parse(block?.type === "text" ? block.text : "{}").sources?.[0]?.extent ?? null) as
      { locator_kind?: string; count?: number; last?: string } | null; } catch { return null; } })();
  const reads: Array<[string, RegisteredEvidence[]]> = [];
  if (document.kind === "case" && extent?.locator_kind === "paragraph" && extent.count) {
    const last = Number(String(extent.last ?? "").replace(/\D+/gu, "")) || extent.count;
    for (const fraction of [0.08, 0.35, 0.62, 0.9]) {
      const paragraph = String(Math.max(1, Math.round(last * fraction)));
      reads.push([`para:${paragraph}`, await read({ locator_kind: "paragraph", locator: paragraph })]);
    }
    const run = Math.max(1, Math.round(last * 0.5));
    reads.push([`run:${run}`, await read({ locator_kind: "paragraph", locator: String(run), end_locator: String(run + 2) })]);
  } else {
    reads.push(["opening", (opening?.evidence ?? []).slice(0, 3).map((receipt) =>
      ({ receipt, ...opening!.evidenceSources?.get(receipt.evidence_id) }))]);
  }
  reads.push(["pattern", await read({ pattern: document.kind === "case" ? "reasonable" : "shall", max_results: 3 })]);

  for (const [label, entries] of reads) {
    const key = `${index}|${document.citation}|${label}`;
    if (!LONG && label.startsWith("run:") && entries.length > 1 && entries.every((entry) => (entry.receipt.span_text ?? "").length <= MAX_BLOCK))
      write(key, "group", createLegalEvidenceCitationsFromEntries(entries.map((entry) => ({ ...entry })))
        .map((citation) => ("url" in citation ? citation.url : null)));
    for (const entry of entries) {
      const passage = `${key}|${entry.receipt.locator.label}`, block = entry.receipt.span_text ?? "";
      // Blocks past the bound are listed for the separate long-block run (--long), since the planner
      // before its range fix takes hours on them.
      if ((block.length > MAX_BLOCK) !== LONG) { write(passage, "deferred", block.length); continue; }
      write(passage, "link", legalEvidenceDocumentLink({ ...entry }));
      const native = entry.document?.searchNative ?? entry.source;
      if (!block || !native) continue;
      const parts = sentences(block);
      const quoteSets: Array<[string, string[]]> = [["whole", [block]]];
      if (parts.length >= 1) quoteSets.push(["middle", [parts[Math.floor(parts.length / 2)]]]);
      if (parts.length >= 2) quoteSets.push(["ends", [parts[0], parts.at(-1)!]]);
      for (const [quoteLabel, quotes] of quoteSets) {
        for (const [pdf, annotate, split] of quoteLabel === "whole" ? flagSets : flagSets.filter(([pdf, annotate]) => !pdf && !annotate)) {
          write(`${passage}|${quoteLabel}|${+pdf}${+annotate}${+split}`, "plan",
            structureNative().textFragmentPlan(block, quotes, pdf, annotate, split, native));
        }
      }
      for (const split of [false, true])
        write(`${passage}|whole|standalone${+split}`, "standalone",
          structureNative().textFragmentPlanStandalone(block, [block], false, false, split));
    }
  }
}

const documentFile = (index: number) => path.join(run, "documents", `${String(index).padStart(4, "0")}.jsonl`);
const started = performance.now();
for (const [index, document] of documents.entries()) {
  if (index % shards !== shard || fs.existsSync(documentFile(index))) continue;
  rows = [];
  try { await cite(index, document); }
  catch (error) { write(`${index}`, "error", { ...document, error: error instanceof Error ? error.message : String(error) }); }
  const temporary = `${documentFile(index)}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, rows.map((row) => `${row}\n`).join(""));
  fs.renameSync(temporary, documentFile(index));
  console.error(`${index + 1}/${documents.length} ${document.citation} ${Math.round((performance.now() - started) / 1000)}s`);
}
// Every document present (from this or any earlier run): the run's output and its summary.
if (documents.every((_, index) => fs.existsSync(documentFile(index)))) {
  const all = documents.map((_, index) => fs.readFileSync(documentFile(index), "utf8")).join("");
  fs.writeFileSync(path.join(run, "all.jsonl"), all);
  const kinds = Object.fromEntries(Object.entries(Object.groupBy(all.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line).kind as string), (kind) => kind)).map(([kind, list]) => [kind, list!.length]));
  fs.writeFileSync(path.join(run, "summary.json"), `${JSON.stringify({ ...manifest,
    allSha256: createHash("sha256").update(all).digest("hex"), kinds }, null, 1)}\n`);
  console.error(`complete: ${path.join(run, "summary.json")}`);
}
