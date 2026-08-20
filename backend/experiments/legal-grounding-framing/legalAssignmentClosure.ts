import { normalizeWhitespace } from "../../src/lib/text";

export type AssignmentClosureSource = {
  document: string;
  documentId?: string;
  versionId?: string | null;
  sourceSha256?: string | null;
  projection?: string;
  text: string;
  at: number;
};

export type AssignmentClosureFinding = {
  document: string;
  documentId?: string;
  versionId?: string | null;
  sourceSha256?: string | null;
  projection?: string;
  at: number;
  omitted: string[];
  excerpt: string;
};

const TRIGGERS = [
  ["operation of law", /\boperation of law\b/iu],
  ["merger", /\bmerg(?:e|er|ed|ing)\b/iu],
  ["consolidation", /\bconsolidat(?:e|ed|es|ing|ion)\b/iu],
  ["asset sale", /\b(?:asset sale|sale (?:or transfer )?of (?:all or )?substantially all (?:of )?(?:its |the )?assets)\b/iu],
  ["change of control", /\bchange of control\b/iu],
] as const;

const ASSIGNMENT = /\bassign(?:ed|ing|ment|ments)?\b/iu;
const RESTRICTION = /\b(?:consent|prohibit|shall not|may not|void|invalid)\b/iu;

function engaged(source: string, draft: string) {
  const words = normalizeWhitespace(source).toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const assignment = words.findIndex((word) => word.startsWith("assign"));
  if (assignment < 0) return false;
  for (const length of [8, 6]) {
    const start = Math.max(0, assignment - Math.floor(length / 2));
    const phrase = words.slice(start, start + length).join(" ");
    if (phrase && draft.includes(phrase)) return true;
  }
  return false;
}

/** Keep only bounded source lines that can ever produce this organ's receipt. */
export function assignmentClosureCandidates(
  source: AssignmentClosureSource,
): AssignmentClosureSource[] {
  if (!ASSIGNMENT.test(source.text)) return [];
  return [...source.text.matchAll(/[^\r\n]+/gu)].flatMap((match) => {
    const raw = match[0];
    const excerpt = raw.trim();
    if (
      excerpt.length > 1_500 ||
      !ASSIGNMENT.test(excerpt) ||
      !RESTRICTION.test(excerpt) ||
      TRIGGERS.filter(([, pattern]) => pattern.test(excerpt)).length < 2
    ) {
      return [];
    }
    return [
      {
        ...source,
        text: excerpt,
        at: source.at + (match.index ?? 0) + raw.indexOf(excerpt),
      },
    ];
  });
}

/**
 * Exact anti-assignment trigger closure. It reports source-stated triggers
 * only after the draft repeats the source provision's assignment wording;
 * it never decides whether a transaction activates the restriction.
 */
export function assignmentTriggerClosure(
  sources: readonly AssignmentClosureSource[],
  draft: string,
): AssignmentClosureFinding[] {
  const normalizedDraft = normalizeWhitespace(draft).toLocaleLowerCase("en-US");
  const findings: AssignmentClosureFinding[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const candidate of assignmentClosureCandidates(source)) {
      const excerpt = candidate.text;
      if (!engaged(excerpt, normalizedDraft)) continue;
      const present = TRIGGERS.filter(([, pattern]) => pattern.test(excerpt));
      const omitted = present
        .filter(([, pattern]) => !pattern.test(normalizedDraft))
        .map(([label]) => label);
      if (!omitted.length) continue;
      const key = `${candidate.documentId ?? candidate.document}:${candidate.versionId ?? ""}:${candidate.at}:${omitted.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        document: candidate.document,
        documentId: candidate.documentId,
        versionId: candidate.versionId,
        sourceSha256: candidate.sourceSha256,
        projection: candidate.projection,
        at: candidate.at,
        omitted,
        excerpt,
      });
      if (findings.length === 2) return findings;
    }
  }
  return findings;
}
