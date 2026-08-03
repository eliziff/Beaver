import { performance } from "node:perf_hooks";
import {
  a2ajLocalBulkPath,
  fetchLocalA2AJDocumentById,
} from "../../backend/src/lib/a2ajLocalBulk";
import { withReadonlySqlite } from "../../backend/src/lib/legalDataPath";
import { getA2AJDocumentSourceDoc } from "../../backend/src/lib/a2aj";

const ids = withReadonlySqlite(a2ajLocalBulkPath(), (database) =>
  database.prepare("SELECT id, dataset FROM document WHERE doc_type='cases' AND unofficial_text_en IS NOT NULL ORDER BY LENGTH(unofficial_text_en) DESC LIMIT 10").all(),
) ?? [];

for (const row of ids) {
  const id = Number(row.id);
  const started = performance.now();
  const document = fetchLocalA2AJDocumentById({ id, docType: "cases", language: "en", maxChars: Number.MAX_SAFE_INTEGER });
  const fetchMs = performance.now() - started;
  const source = getA2AJDocumentSourceDoc(document!);
  const totalMs = performance.now() - started;
  const paragraphs = source.blocks.filter((b) => b.kind === "paragraph").length;
  console.log(`id ${id} ${row.dataset}: ${(document!.text.length / 1e6).toFixed(2)}MB fetch ${fetchMs.toFixed(0)}ms total ${totalMs.toFixed(0)}ms paragraphs ${paragraphs}`);
}
