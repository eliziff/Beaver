import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as bulkModule from "../../../backend/src/lib/a2ajLocalBulk";
import * as semanticModule from "../../../backend/experiments/a2aj-decision-roster/caseSemanticMvp";

const quoteKeys = new Set(["disposition_quote", "writer_evidence_quote", "position_evidence_quote", "start_quote", "end_quote", "panel_evidence_quote", "result_evidence_quote", "evidence_quote", "answer_evidence_quotes"]);
async function main() {
const bulk = (bulkModule as any).default ?? bulkModule;
const semantic = (semanticModule as any).default ?? semanticModule;
const goldFile = process.argv[2] ? resolve(process.argv[2]) : new URL("../manual-case-target-gold-v13-traps.json", import.meta.url);
const rows = JSON.parse(await readFile(goldFile, "utf8")) as Array<Record<string, any>>;
let failures = 0;
for (const row of rows) {
  const source = bulk.fetchLocalA2AJDocumentById({ id: Number(row.document_id), language: "en", maxChars: Number.MAX_SAFE_INTEGER })?.text;
  if (!source) throw new Error(`missing source ${row.document_id}`);
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (quoteKeys.has(key)) for (const quote of (Array.isArray(child) ? child : [child])) {
        if (typeof quote !== "string") continue;
        const resolved = semantic.resolveUniqueGroundedQuote(source, 0, quote);
        if (typeof resolved === "string") {
          console.error(`${row.document_id} ${path}.${key}: ${resolved}: ${JSON.stringify(quote)}`);
          failures++;
        }
      }
      walk(child, `${path}.${key}`);
    }
  };
  walk(row.annotation, "annotation");
  const expected = (row.annotation.target_mentions as Array<Record<string, any>>).map((item) => item.occurrence_id).filter(Boolean);
  const counts = new Map<string, number>();
  for (const id of expected) counts.set(id, (counts.get(id) ?? 0) + 1);
  if (new Set(expected).size !== expected.length) throw new Error(`duplicate occurrence in gold ${row.document_id}`);
  console.log(`${row.document_id}: ${expected.length} occurrence(s), ${source.length} source chars`);
}
if (failures) process.exitCode = 1;
else console.log("PASS manual v13 trap gold grounding");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
