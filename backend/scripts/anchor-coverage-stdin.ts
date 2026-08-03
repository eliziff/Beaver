/**
 * Run the existing typed-anchor engine over already-normalized UTF-8 text.
 * Binary document parsing remains in the caller's sandbox.
 */
import { readFileSync } from "node:fs";
import {
  anchorCoverage,
  type AnchorDocument,
} from "../src/lib/legalTextAnchors";

type Input = {
  sources: AnchorDocument[];
  drafts?: AnchorDocument[];
  max_rows_per_class?: number;
  compiler_review?: boolean;
  attention_text?: string;
};

const STOP_WORDS = new Set([
  "about", "after", "again", "against", "before", "being", "between",
  "could", "document", "documents", "draft", "from", "have", "into",
  "legal", "must", "other", "report", "shall", "should", "source",
  "sources", "that", "their", "there", "these", "they", "this", "those",
  "through", "under", "using", "when", "where", "which", "with", "would",
]);

function contentTokens(text: string): Set<string> {
  return new Set(
    (text.toLocaleLowerCase().match(/[a-z][a-z0-9-]{3,}/gu) ?? []).filter(
      (token) => !STOP_WORDS.has(token),
    ),
  );
}

const input = JSON.parse(readFileSync(0, "utf8")) as Input;
const maxRows = Math.max(
  1,
  Math.min(40, Math.trunc(Number(input.max_rows_per_class) || 12)),
);
const report = anchorCoverage(
  input.sources ?? [],
  input.drafts?.length ? input.drafts : [{ name: "empty-draft", text: "" }],
  { maxRowsPerClass: maxRows },
);

if (input.compiler_review) {
  const attentionTokens = contentTokens(
    `${input.attention_text ?? ""}\n${input.drafts?.map((draft) => draft.text).join("\n") ?? ""}`,
  );
  const sourceCandidates = Object.entries(report.classes)
    .flatMap(([cls, value]) =>
      value.source_only
        .map((row) => {
          const rowTokens = contentTokens(
            `${row.display}\n${row.excerpt}\n${row.documents.join("\n")}`,
          );
          const relevanceScore = [...rowTokens].filter((token) =>
            attentionTokens.has(token),
          ).length;
          return { cls, relevance_score: relevanceScore, ...row };
        })
        .filter(
          (row) =>
            row.count > 1 || row.documents.length > 1 || row.relevance_score > 1,
        ),
    )
    .sort(
      (left, right) =>
        right.relevance_score - left.relevance_score ||
        right.documents.length - left.documents.length ||
        right.count - left.count ||
        left.norm.localeCompare(right.norm),
    )
    .slice(0, 16);
  const draftOnly = Object.entries(report.classes)
    .flatMap(([cls, value]) =>
      value.draft_only.map((row) => ({ cls, ...row })),
    )
    .sort(
      (left, right) =>
        right.count - left.count || left.norm.localeCompare(right.norm),
    )
    .slice(0, 12);
  process.stdout.write(
    JSON.stringify({
      status:
        sourceCandidates.length ||
        draftOnly.length ||
        report.numeral_word_pairs.mismatches.length
          ? "review_required"
          : "clear",
      relevant_or_repeated_source_anchors_missing_from_draft: sourceCandidates,
      draft_anchors_absent_from_sources: draftOnly,
      numeral_word_mismatches: report.numeral_word_pairs.mismatches.slice(0, 12),
      counts: Object.fromEntries(
        Object.entries(report.classes).map(([name, value]) => [
          name,
          {
            source_distinct: value.source_distinct,
            draft_distinct: value.draft_distinct,
            matched: value.matched,
            source_only: value.source_only.length,
            draft_only: value.draft_only.length,
            source_only_truncated: value.source_only_truncated,
            draft_only_truncated: value.draft_only_truncated,
          },
        ]),
      ),
      caution:
        "Task/draft-relevant or repeated source-only anchors are bounded omission candidates, not drafting instructions. Draft-only anchors may be valid calculations. Resolve only findings material to the request, then submit generate_docx again; an unchanged resubmission is allowed.",
    }),
  );
} else {
  process.stdout.write(JSON.stringify(report));
}
