import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  a2ajLocalBulkPath,
  fetchLocalA2AJDocumentsByIds,
} from "../../../backend/src/lib/a2ajLocalBulk";
import { citationLookupKey } from "../../../backend/src/lib/citationKey";
import { withReadonlySqlite } from "../../../backend/src/lib/legalDataPath";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main() {
  const file = path.resolve(process.argv[2] ?? path.join(ROOT, "case-target-challenge-15.json"));
  const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
  const pairs = manifest.pairs as Array<Record<string, any>>;
  assert(manifest.format === "a2aj-case-target-challenge-v1", "wrong manifest format");
  assert(Array.isArray(pairs) && pairs.length === 15 && manifest.requested_pairs === 15, "challenge must contain exactly 15 pairs");
  assert(new Set(pairs.map(({ document_id }) => document_id)).size === 15, "citing decisions must be unique");

  const wanted = {
    multi_opinion_or_partial_join: 5,
    attribution_trap: 5,
    ordinary_control: 5,
  };
  for (const [category, count] of Object.entries(wanted)) {
    assert(pairs.filter(({ challenge_category }) => challenge_category === category).length === count, `${category} must have ${count} pairs`);
  }
  assert(new Set(pairs.map(({ source }) => source.dataset)).size >= 12, "challenge is not broad enough across A2AJ datasets");

  const documents = fetchLocalA2AJDocumentsByIds({
    ids: pairs.map(({ document_id }) => Number(document_id)),
    maxChars: Number.MAX_SAFE_INTEGER,
  });
  const targetKeys = withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const exists = database.prepare("SELECT 1 FROM citation_lookup WHERE citation_key=? AND document_id=?");
    return new Map(pairs.map(({ target }) => [target.document_id, Boolean(exists.get(citationLookupKey(target.citation), target.document_id))]));
  });
  assert(targetKeys, `A2AJ database not found: ${a2ajLocalBulkPath()}`);

  for (const pair of pairs) {
    const label = pair.challenge_id;
    const document = documents.get(Number(pair.document_id));
    assert(document, `${label}: source missing from A2AJ`);
    assert(document.dataset === pair.source.dataset && document.citation === pair.source.citation, `${label}: source identity changed`);
    assert(document.name === pair.source.name && (document.date?.slice(0, 10) ?? null) === pair.source.date, `${label}: source metadata changed`);
    assert(document.language === pair.source.language && document.url === pair.source.url, `${label}: source locator changed`);
    assert(document.text.length === pair.selection_receipt.source_chars, `${label}: source length changed`);
    assert(sha256(document.text) === pair.selection_receipt.source_text_sha256, `${label}: source bytes changed`);
    assert(targetKeys.get(pair.target.document_id), `${label}: target citation no longer resolves to target document`);

    const occurrences = pair.selection_receipt.target_occurrences as Array<Record<string, any>>;
    assert(occurrences.length > 0, `${label}: no target occurrence evidence`);
    occurrences.forEach((occurrence, index) => {
      assert(occurrence.id === `tm${index + 1}`, `${label}: target occurrence IDs are unstable`);
      assert(document.text.slice(occurrence.start, occurrence.end_exclusive) === occurrence.quote, `${label}: target occurrence ${occurrence.id} moved`);
      const context = occurrence.context;
      assert(document.text.slice(context.start, context.end_exclusive) === context.quote, `${label}: target context ${occurrence.id} moved`);
      assert(sha256(context.quote) === context.sha256, `${label}: target context ${occurrence.id} hash changed`);
    });
    const evidence = pair.selection_receipt.category_evidence as Array<Record<string, any>>;
    for (const item of evidence) {
      assert(document.text.slice(item.start, item.end_exclusive) === item.quote, `${label}: category evidence moved`);
      assert(sha256(item.quote) === item.sha256, `${label}: category evidence hash changed`);
    }
    const kinds = evidence.map(({ kind }) => kind);
    if (pair.challenge_category === "multi_opinion_or_partial_join") {
      assert(kinds.filter((kind) => kind === "opinion_boundary").length >= 2, `${label}: multi-opinion evidence is weak`);
      assert(occurrences.length >= 2, `${label}: multi-opinion target needs repeated occurrences`);
    } else if (pair.challenge_category === "attribution_trap") {
      assert(kinds.includes("party_or_reported_voice") && kinds.includes("current_decision_voice"), `${label}: attribution contrast is incomplete`);
    } else {
      assert(kinds.includes("current_decision_treatment"), `${label}: ordinary control lacks direct treatment evidence`);
    }
  }

  const freezeKeys = pairs.map(({ challenge_id, document_id, target }) => [challenge_id, document_id, target.document_id, target.citation]);
  assert(sha256(JSON.stringify(freezeKeys)) === manifest.selection.frozen_pair_keys_sha256, "frozen pair key hash changed");
  console.log(JSON.stringify({
    ok: true,
    file,
    pairs: pairs.length,
    datasets: [...new Set(pairs.map(({ source }) => source.dataset))].sort(),
    category_counts: wanted,
    target_occurrences: pairs.reduce((sum, pair) => sum + pair.selection_receipt.target_occurrences.length, 0),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
