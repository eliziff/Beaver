import {
  type DocxPathologyReport,
} from "../../docx/pathology";

/**
 * Pathology notes for document reads (unification plan, Phase 3 integration
 * steps 3i-1/3i-2). The sniffer runs once per document version at the same
 * choke point as text extraction and its report rides along as additive
 * metadata — the extracted text itself stays byte-identical. Documents whose
 * edits the plain-text projection cannot show additionally point at the
 * opt-in redline view.
 */

/**
 * The sniffer's report comes from the canonical DOCX projection session.
 * Returns null for anything that is not a docx and for an unparseable
 * entry — a read never fails, and never loses its text, because the
 * report did.
 */
/** Keeps the block compact on documents that trip many counters at once. */
const MAX_NOTE_LINES = 8;

/**
 * Appended to default-read notes when the document carries editorial
 * content the plain-text projection cannot show (3i-2). Exact wording is
 * part of the read contract; tests assert it verbatim.
 */
export const REDLINE_ADVISORY_NOTE =
  "Struck or inserted text is invisible in this plain-text view; request the redline view to see it.";

/** The redline view's marker vocabulary (projected by docx/redline.ts). */
export const REDLINE_VIEW_LEGEND =
  "{++inserted++}, {--deleted--}, {>>author: comment<<}; [ink] marks strike/colour formatting standing in for tracked-change markup.";

/**
 * The report's caution lines, wording untouched, capped for transport.
 * Only the overflow line and the redline advisory are authored here; the
 * advisory sits outside the cap so it is never the line that gets dropped.
 */
export function docxCautionNotes(report: DocxPathologyReport | null): string[] {
  // Treat the report as data at the tool boundary.
  const raw = Array.isArray(report?.notes_of_caution)
    ? report.notes_of_caution
    : [];
  const lines = raw.filter(
    (line): line is string =>
      typeof line === "string" && line.trim().length > 0,
  );
  const capped =
    lines.length <= MAX_NOTE_LINES
      ? [...lines]
      : [
          ...lines.slice(0, MAX_NOTE_LINES),
          `${lines.length - MAX_NOTE_LINES} additional notes omitted.`,
        ];
  const tracked = report?.tracked_changes;
  if (
    (tracked?.insertions ?? 0) > 0 ||
    (tracked?.deletions ?? 0) > 0 ||
    report?.manual_redline?.likely === true
  ) {
    capped.push(REDLINE_ADVISORY_NOTE);
  }
  return capped;
}

/** One labeled block for string-shaped read results (the Supabase path). */
export function docxNotesBlock(filename: string, notes: string[]): string {
  return [
    `[Document notes for "${filename}"]:`,
    ...notes.map((line) => `- ${line}`),
  ].join("\n");
}
