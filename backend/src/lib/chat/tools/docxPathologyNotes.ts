import { cachedParse } from "../../parseCache";
import {
  scanDocxPathology,
  type DocxPathologyReport,
} from "../../docx/pathology";

/**
 * Pathology notes for document reads (unification plan, Phase 3 integration
 * step 3i-1). The sniffer runs once per document version at the same choke
 * point as text extraction and its report rides along as additive metadata —
 * the extracted text itself stays byte-identical.
 */

/**
 * The sniffer's report, cached beside the text parse under its own parser
 * identity (parseCache stores strings, so the report crosses as JSON).
 * Returns null for anything that is not a docx and for an unparseable
 * entry — a read never fails, and never loses its text, because the
 * report did.
 */
export async function docxPathologyReportFor(params: {
  fileType: string;
  scope: string;
  bytes: Buffer;
}): Promise<DocxPathologyReport | null> {
  if (params.fileType !== "docx") return null;
  try {
    const raw = await cachedParse({
      scope: params.scope,
      parser: "docx-pathology",
      version: 1,
      bytes: params.bytes,
      parse: async () => JSON.stringify(await scanDocxPathology(params.bytes)),
    });
    return JSON.parse(raw) as DocxPathologyReport;
  } catch {
    return null;
  }
}

/** Keeps the block compact on documents that trip many counters at once. */
const MAX_NOTE_LINES = 8;

/**
 * The report's caution lines, wording untouched, capped for transport.
 * Only the overflow line is authored here.
 */
export function docxCautionNotes(report: DocxPathologyReport | null): string[] {
  const lines = (report?.notes_of_caution ?? []).filter(
    (line): line is string =>
      typeof line === "string" && line.trim().length > 0,
  );
  if (lines.length <= MAX_NOTE_LINES) return lines;
  return [
    ...lines.slice(0, MAX_NOTE_LINES),
    `${lines.length - MAX_NOTE_LINES} additional notes omitted.`,
  ];
}

/** One labeled block for string-shaped read results (the Supabase path). */
export function docxNotesBlock(filename: string, notes: string[]): string {
  return [
    `[Document notes for "${filename}"]:`,
    ...notes.map((line) => `- ${line}`),
  ].join("\n");
}
