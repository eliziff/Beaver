/**
 * Build the derived passage sidecar for a local bulk store (default: the
 * A2AJ product db). The product path refuses to build inline — a
 * 5.5 GB-scale corpus would hang a user request — so this script is the
 * one place the index is built; `searchLocalA2AJPassages` names it in its
 * typed refusal.
 *
 * Usage (from backend/):
 *   npx tsx scripts/build-passage-index.ts
 *   npx tsx scripts/build-passage-index.ts --db path/to.sqlite --doc-type cases
 *
 * Flags: --db (default: MIKE_A2AJ_BULK_DB or the A2AJ provider db),
 * --target 1600, --overlap 120, --doc-type cases|laws (a doc-type build
 * is a SEPARATE sidecar — query with the same --doc-type).
 */
import { a2ajLocalBulkPath } from "../src/lib/a2ajLocalBulk";
import {
  A2AJ_PASSAGE_OVERLAP,
  A2AJ_PASSAGE_TARGET,
} from "../src/lib/a2ajPassageSearch";
import { ensurePassageIndex } from "../src/lib/passageRetrieval";

function flag(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const docTypeFlag = flag("doc-type");
if (docTypeFlag && docTypeFlag !== "cases" && docTypeFlag !== "laws") {
  console.error("--doc-type must be cases or laws");
  process.exit(1);
}

const options = {
  sourceDb: flag("db") ?? a2ajLocalBulkPath(),
  target: Number(flag("target") ?? A2AJ_PASSAGE_TARGET),
  overlap: Number(flag("overlap") ?? A2AJ_PASSAGE_OVERLAP),
  docType: docTypeFlag as "cases" | "laws" | undefined,
};

console.log(`source   ${options.sourceDb}`);
console.log(
  `chunking target=${options.target} overlap=${options.overlap}${
    options.docType ? ` doc_type=${options.docType}` : ""
  }`,
);
const started = Date.now();
const result = ensurePassageIndex(options);
const seconds = ((Date.now() - started) / 1_000).toFixed(1);
console.log(`sidecar  ${result.indexDb}`);
console.log(
  `${result.built ? "built" : "reused"} ${result.passages.toLocaleString()} passages over ${result.documents.toLocaleString()} documents in ${seconds}s`,
);
