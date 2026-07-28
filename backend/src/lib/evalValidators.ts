import { loadZip } from "./zip";
import { normalizeWhitespace } from "./text";
import { sourceDocQuoteText } from "./sourceDoc";

/**
 * Deterministic validator primitives for the evaluation plan (docs/
 * beaver-evaluation-context-plan.md, Issue 4). Pure checks over outputs and
 * source packets; the task/gold schema layer binds them to tasks. Every
 * validator returns evidence, not just a boolean, so a failing run can say
 * exactly why.
 */

export type QuotationCheck = {
  found: boolean;
  /** How the quotation matched; null when not found. */
  method: "exact" | "normalized" | null;
};

/**
 * A quotation "occurs" if it appears verbatim, or after the same
 * normalization the pinpoint pipeline applies (whitespace collapse, outer
 * quote marks, editorial alterations like "[T]he"). Fabricated or altered
 * quotations fail both paths.
 */
export function quotationOccurs(
  documentText: string,
  quotation: string,
): QuotationCheck {
  const quote = quotation.trim();
  if (!quote) return { found: false, method: null };
  if (documentText.includes(quote)) return { found: true, method: "exact" };
  // Case-folded like sourceDocQuoteWords: editorial alterations ("[T]he")
  // legitimately change letter case relative to the source text.
  const normalizedDoc = normalizeWhitespace(documentText).toLowerCase();
  const normalizedQuote = sourceDocQuoteText(quote).toLowerCase();
  if (normalizedQuote && normalizedDoc.includes(normalizedQuote)) {
    return { found: true, method: "normalized" };
  }
  return { found: false, method: null };
}

/** Seeded identifiers planted in task inputs must never surface in outputs. */
export function seededIdentifierLeaks(
  outputText: string,
  seededIdentifiers: readonly string[],
): string[] {
  const haystack = outputText.toLowerCase();
  return seededIdentifiers.filter(
    (id) => id.trim() && haystack.includes(id.trim().toLowerCase()),
  );
}

/**
 * Cited sources must come from the permitted packet. IDs compare
 * case-insensitively after trimming; order and duplicates are irrelevant.
 */
export function forbiddenSources(
  citedSourceIds: readonly string[],
  permittedSourceIds: readonly string[],
): string[] {
  const permitted = new Set(
    permittedSourceIds.map((id) => id.trim().toLowerCase()),
  );
  const violations = new Map<string, string>();
  for (const raw of citedSourceIds) {
    const id = raw.trim();
    if (!id || permitted.has(id.toLowerCase())) continue;
    if (!violations.has(id.toLowerCase())) violations.set(id.toLowerCase(), id);
  }
  return [...violations.values()];
}

/**
 * Required headings must each appear as a whole heading line (markdown `#`
 * prefixes ignored), compared with collapsed whitespace, case-insensitive.
 */
export function missingHeadings(
  outputText: string,
  requiredHeadings: readonly string[],
): string[] {
  const lines = new Set(
    outputText
      .split(/\r?\n/u)
      .map((line) =>
        normalizeWhitespace(line.replace(/^#{1,6}\s+/u, "")).toLowerCase(),
      )
      .filter(Boolean),
  );
  return requiredHeadings.filter(
    (heading) => !lines.has(normalizeWhitespace(heading).toLowerCase()),
  );
}

/**
 * Required provenance identifiers (neutral citations, docket numbers, source
 * IDs) must appear somewhere in the output, compared with collapsed
 * whitespace, case-insensitive.
 */
export function missingProvenanceIds(
  outputText: string,
  requiredIds: readonly string[],
): string[] {
  const haystack = normalizeWhitespace(outputText).toLowerCase();
  return requiredIds.filter((id) => {
    const needle = normalizeWhitespace(id).toLowerCase();
    return needle.length > 0 && !haystack.includes(needle);
  });
}

/** Required deliverable filenames, compared trimmed and case-insensitive. */
export function missingFilenames(
  producedFilenames: readonly string[],
  requiredFilenames: readonly string[],
): string[] {
  const produced = new Set(
    producedFilenames.map((name) => name.trim().toLowerCase()),
  );
  return requiredFilenames.filter(
    (name) => !produced.has(name.trim().toLowerCase()),
  );
}

export type DocxStructureCheck = {
  opens: boolean;
  hasBody: boolean;
  trackedInsertions: number;
  trackedDeletions: number;
  comments: number;
};

/**
 * A deliverable DOCX must be a real package with a document body; when the
 * task demands revisions, the tracked-change counts say whether any exist.
 */
export async function checkDocxStructure(
  bytes: Buffer,
): Promise<DocxStructureCheck> {
  try {
    const zip = await loadZip(bytes);
    const entry = zip.file("word/document.xml");
    const commentsXml =
      (await zip.file("word/comments.xml")?.async("string")) ?? "";
    const comments = commentsXml.match(/<w:comment[\s>]/gu)?.length ?? 0;
    if (!entry) {
      return {
        opens: true,
        hasBody: false,
        trackedInsertions: 0,
        trackedDeletions: 0,
        comments,
      };
    }
    const xml = await entry.async("string");
    return {
      opens: true,
      hasBody: /<w:body[\s>]/u.test(xml),
      trackedInsertions: xml.match(/<w:ins[\s>]/gu)?.length ?? 0,
      trackedDeletions: xml.match(/<w:del[\s>]/gu)?.length ?? 0,
      comments,
    };
  } catch {
    return {
      opens: false,
      hasBody: false,
      trackedInsertions: 0,
      trackedDeletions: 0,
      comments: 0,
    };
  }
}
