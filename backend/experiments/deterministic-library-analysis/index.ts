import { draftingLint } from "./legalDraftingLint";
import {
  computeDeadline,
  type DeadlineJurisdiction,
  type DeadlineUnit,
} from "./legalDeadlines";
import { conflictScan } from "./legalConflictScan";
import {
  anchorCoverage,
  bilingualConcordance,
} from "./legalTextAnchors";
import { termDriftReport } from "./legalTermDrift";

export const EXPERIMENTAL_LIBRARY_ANALYSES = [
  "anchor_coverage",
  "conflict_scan",
  "deadline",
  "term_drift",
  "drafting_lint",
  "bilingual_concordance",
] as const;

export type ExperimentalLibraryAnalysis =
  typeof EXPERIMENTAL_LIBRARY_ANALYSES[number];
export type ExperimentDocument = { id: string; name: string; text: string };

const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : [];
const integer = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;

export async function runExperimentalLibraryAnalysis(
  name: ExperimentalLibraryAnalysis,
  args: Record<string, unknown>,
  documents: ExperimentDocument[] = [],
) {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const requireDocuments = (ids: string[]) => ids.map((id) => {
    const document = byId.get(id);
    if (!document) throw new Error(`Document ${id} not found`);
    return document;
  });
  const named = (ids: string[]) => requireDocuments(ids).map(
    ({ name: documentName, text }) => ({ name: documentName, text }),
  );

  switch (name) {
    case "anchor_coverage":
      return anchorCoverage(
        named(strings(args.source_document_ids)),
        named(strings(args.draft_document_ids)),
        { maxRowsPerClass: integer(args.max_rows_per_class, 1, 100, 40) },
      );
    case "conflict_scan":
      return conflictScan(named(strings(args.document_ids)));
    case "deadline":
      return computeDeadline({
        anchor: string(args.anchor_date),
        count: integer(args.count, 1, 10_000, NaN),
        unit: string(args.unit) as DeadlineUnit,
        direction: string(args.direction) === "before" ? "before" : "after",
        jurisdiction: (string(args.jurisdiction) || "CA") as DeadlineJurisdiction,
        weekend: string(args.weekend) === "sun_only" ? "sun_only" : "sat_sun",
        extraHolidays: strings(args.extra_holidays),
      });
    case "term_drift":
      return termDriftReport(named(strings(args.document_ids)), {
        maxRows: integer(args.max_rows, 1, 100, 40),
      });
    case "drafting_lint": {
      const [document] = requireDocuments([string(args.document_id)]);
      const report = draftingLint(document.text);
      const cap = integer(args.max_findings, 1, 200, 50);
      return {
        filename: document.name,
        counts: report.counts,
        modal_profile: report.modalProfile,
        findings: report.findings.slice(0, cap),
        findings_truncated: report.findings.length > cap,
      };
    }
    case "bilingual_concordance": {
      const [english, french] = requireDocuments([
        string(args.english_document_id),
        string(args.french_document_id),
      ]);
      return bilingualConcordance(
        { name: english.name, text: english.text },
        { name: french.name, text: french.text },
        { maxRowsPerClass: integer(args.max_rows_per_class, 1, 100, 40) },
      );
    }
  }
}
