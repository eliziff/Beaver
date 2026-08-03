/**
 * Run the existing typed-anchor engine over already-normalized UTF-8 text.
 * Binary document parsing remains in the caller's sandbox.
 */
import { readFileSync } from "node:fs";
import {
  anchorCoverage,
  extractAnchors,
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
  "about", "after", "again", "against", "agreement", "before", "being",
  "between", "borrower", "company", "could", "document", "documents",
  "draft", "each", "from", "have", "including", "into", "legal", "means",
  "must", "other", "report", "section", "shall", "should", "source",
  "sources", "such", "that", "their", "there", "these", "they", "this",
  "those", "through", "under", "using", "when", "where", "which", "with",
  "within", "would",
]);

function contentTokens(text: string): Set<string> {
  return new Set(
    (text.toLocaleLowerCase().match(/[a-z][a-z0-9-]{3,}/gu) ?? []).filter(
      (token) => !STOP_WORDS.has(token),
    ),
  );
}

const DURATION_VALUE_WORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
  "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
  "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "thousand", "business", "calendar", "day", "days", "week",
  "weeks", "month", "months", "quarter", "quarters", "year", "years",
]);

const MATERIAL_CONTEXT_TERMS = new Set([
  "acquisition", "cap", "commitment", "compliance", "consent", "covenant",
  "cure", "debt", "default", "defaults", "distribution", "due", "facility",
  "fee", "grace", "interest", "leverage", "limit", "liquidity", "loan",
  "loans", "mandatory", "maturity", "maximum", "minimum", "notice",
  "payment", "payable", "prepayment", "principal", "ratio", "required",
  "termination", "threshold",
]);

function boundedContext(text: string, at: number, rawLength: number) {
  const floor = Math.max(0, at - 160);
  let start = floor;
  for (const boundary of ["\n", ".", ";"]) {
    const found = text.lastIndexOf(boundary, at - 1);
    if (found >= floor) start = Math.max(start, found + 1);
  }
  const hitEnd = at + rawLength;
  const ceiling = Math.min(text.length, hitEnd + 160);
  let end = ceiling;
  for (const boundary of ["\n", ".", ";"]) {
    const found = text.indexOf(boundary, hitEnd);
    if (found >= 0 && found < end) end = found + 1;
  }
  return text.slice(start, end).replace(/\s+/gu, " ").trim();
}

type ContextOccurrence = {
  cls: string;
  norm: string;
  display: string;
  document: string;
  at: number;
  excerpt: string;
  tokens: Set<string>;
};

function contextOccurrences(documents: AnchorDocument[]) {
  const byNorm = new Map<string, ContextOccurrence[]>();
  for (const document of documents) {
    for (const hit of extractAnchors(document.text)) {
      const excerpt = boundedContext(document.text, hit.index, hit.raw.length);
      const tokens = contentTokens(excerpt);
      const valueTokens =
        hit.cls === "duration" ? DURATION_VALUE_WORDS : contentTokens(hit.raw);
      for (const token of valueTokens) tokens.delete(token);
      const occurrence = {
        cls: hit.cls,
        norm: hit.norm,
        display: hit.raw,
        document: document.name,
        at: hit.index,
        excerpt,
        tokens,
      };
      const existing = byNorm.get(hit.norm) ?? [];
      existing.push(occurrence);
      byNorm.set(hit.norm, existing);
    }
  }
  return byNorm;
}

function repeatedAnchorContextCandidates(
  sources: AnchorDocument[],
  drafts: AnchorDocument[],
  attentionTokens: Set<string>,
) {
  const sourceByNorm = contextOccurrences(sources);
  const draftByNorm = contextOccurrences(drafts);
  const candidates = [];
  for (const [norm, sourceOccurrences] of sourceByNorm) {
    const draftOccurrences = draftByNorm.get(norm) ?? [];
    if (sourceOccurrences.length < 2 || !draftOccurrences.length) continue;
    const uncovered = sourceOccurrences
      .map((source) => {
        let bestOverlap: string[] = [];
        for (const draft of draftOccurrences) {
          const overlap = [...source.tokens].filter((token) => draft.tokens.has(token));
          if (overlap.length > bestOverlap.length) bestOverlap = overlap;
        }
        return { source, bestOverlap };
      })
      .filter(({ bestOverlap }) => bestOverlap.length < 2);
    if (!uncovered.length) continue;
    const taskRelevance = Math.max(
      ...uncovered.map(({ source }) =>
        [...source.tokens].filter((token) => attentionTokens.has(token)).length,
      ),
    );
    const materialContextScore = Math.max(
      ...uncovered.map(({ source }) =>
        [...source.tokens].filter((token) => MATERIAL_CONTEXT_TERMS.has(token)).length,
      ),
    );
    candidates.push({
      cls: sourceOccurrences[0].cls,
      norm,
      display: sourceOccurrences[0].display,
      source_occurrences: sourceOccurrences.length,
      draft_occurrences: draftOccurrences.length,
      uncovered_source_contexts: uncovered.length,
      material_context_score: materialContextScore,
      task_relevance: taskRelevance,
      contexts: uncovered.slice(0, 2).map(({ source, bestOverlap }) => ({
        document: source.document,
        locator: `chars ${source.at}-${source.at + source.display.length}`,
        excerpt: source.excerpt,
        best_draft_overlap_terms: bestOverlap,
      })),
    });
  }
  const sorted = candidates.sort(
      (left, right) =>
        right.material_context_score - left.material_context_score ||
        right.task_relevance - left.task_relevance ||
        right.uncovered_source_contexts - left.uncovered_source_contexts ||
        right.source_occurrences - left.source_occurrences ||
        left.norm.localeCompare(right.norm),
    );
  const perClass = new Map<string, number>();
  return sorted
    .filter((candidate) => {
      const count = perClass.get(candidate.cls) ?? 0;
      if (count >= 2) return false;
      perClass.set(candidate.cls, count + 1);
      return true;
    })
    .slice(0, 10);
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
        .filter((row) => row.count > 1 || row.documents.length > 1),
    )
    .sort(
      (left, right) =>
        right.relevance_score - left.relevance_score ||
        right.documents.length - left.documents.length ||
        right.count - left.count ||
        left.norm.localeCompare(right.norm),
    )
    .slice(0, 8);
  const draftOnly = Object.entries(report.classes)
    .flatMap(([cls, value]) =>
      value.draft_only.map((row) => ({ cls, ...row })),
    )
    .filter((row) => row.count > 1)
    .sort(
      (left, right) =>
        right.count - left.count || left.norm.localeCompare(right.norm),
    )
    .slice(0, 6);
  const contextCandidates = repeatedAnchorContextCandidates(
    input.sources ?? [],
    input.drafts ?? [],
    attentionTokens,
  );
  process.stdout.write(
    JSON.stringify({
      status:
        sourceCandidates.length ||
        draftOnly.length ||
        contextCandidates.length ||
        report.numeral_word_pairs.mismatches.length
          ? "review_required"
          : "clear",
      relevant_or_repeated_source_anchors_missing_from_draft: sourceCandidates,
      draft_anchors_absent_from_sources: draftOnly,
      repeated_anchor_contexts_not_evidenced_in_draft: contextCandidates,
      numeral_word_mismatches: report.numeral_word_pairs.mismatches.slice(0, 8),
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
        "Repeated source-only anchors and repeated-anchor context gaps are bounded review candidates, not drafting instructions. Draft-only anchors may be valid calculations. Check attribution as well as value, resolve only findings material to the request, then submit generate_docx again; an unchanged resubmission is allowed.",
    }),
  );
} else {
  process.stdout.write(JSON.stringify(report));
}
