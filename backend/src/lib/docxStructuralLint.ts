import type JSZip from "jszip";
import { loadZip } from "./zip";
import { readFile } from "node:fs/promises";
import { getLocalVersionFile } from "./localDocumentStore";
import { decodeXmlText, escapeRegExp } from "./text";

// Deterministic structural lint for contract-style DOCX documents.
//
// Every check follows the abstention rule from the deterministic/durable
// audit: when the document does not exhibit the convention a check depends
// on (literal clause numbering, attached schedules, quoted definitions),
// the check reports a note and stays silent instead of guessing. Precision
// is preferred over recall throughout: one false finding costs more trust
// than ten misses.

const PARAGRAPH_PATTERN = /<w:p\b[\s\S]*?<\/w:p>/gu;
const TEXT_PATTERN = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu;
const DELETED_RUN_PATTERN = /<w:del\b[\s\S]*?<\/w:del>/gu;

const MAX_FINDINGS = 200;
const EXCERPT_LENGTH = 160;
const ATTACHMENT_LABELS = [
  "Schedule",
  "Exhibit",
  "Appendix",
  "Annex",
  "Annexure",
] as const;

type DocxLintFindingCode =
  | "cross_reference_missing"
  | "attachment_reference_missing"
  | "numbering_gap"
  | "numbering_duplicate"
  | "defined_term_duplicate"
  | "defined_term_unused";

type DocxLintFinding = {
  code: DocxLintFindingCode;
  severity: "error" | "warning";
  subject: string;
  message: string;
  paragraph_index: number;
  excerpt: string;
};

export type DocxStructuralLintReport = {
  paragraphs: number;
  checks: {
    cross_references: {
      references: number;
      resolved: number;
      skipped_external: number;
    };
    attachments: {
      references: number;
      resolved: number;
    };
    numbering: { anchors: number };
    defined_terms: { definitions: number };
  };
  findings: DocxLintFinding[];
  notes: string[];
};

function normalizeText(value: string) {
  return value
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/[   ]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function paragraphTexts(documentXml: string) {
  const texts: string[] = [];
  for (const paragraph of documentXml.matchAll(PARAGRAPH_PATTERN)) {
    const withoutDeleted = paragraph[0].replace(DELETED_RUN_PATTERN, "");
    const parts: string[] = [];
    for (const text of withoutDeleted.matchAll(TEXT_PATTERN)) {
      parts.push(decodeXmlText(text[1] ?? ""));
    }
    texts.push(normalizeText(parts.join("")));
  }
  return texts;
}

function excerptAround(text: string, subject: string) {
  const index = text.indexOf(subject);
  if (index < 0) return text.slice(0, EXCERPT_LENGTH);
  const start = Math.max(0, index - Math.floor((EXCERPT_LENGTH - subject.length) / 2));
  const slice = text.slice(start, start + EXCERPT_LENGTH);
  return `${start > 0 ? "…" : ""}${slice}${
    start + EXCERPT_LENGTH < text.length ? "…" : ""
  }`;
}

const ROMAN_PATTERN = /^[IVXLCDM]+$/u;

function romanToInt(value: string) {
  const values: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const current = values[value[index]];
    const next = values[value[index + 1]] ?? 0;
    if (!current) return null;
    total += current < next ? -current : current;
  }
  return total;
}

// A reference like "Section 85 of the Income Tax Act" points outside this
// document. Only "of this ..." (and "hereof"/bare continuations) are internal.
function isExternalReference(following: string) {
  const trimmed = following.replace(/^\s*\([a-z0-9]{1,4}\)/giu, "").trimStart();
  const external = trimmed.match(/^(?:of|to|under)\s+(\w+)/iu);
  if (!external) return false;
  return external[1].toLowerCase() !== "this";
}

type NumberAnchor = {
  number: string;
  paragraphIndex: number;
};

// Paragraph-start literal clause numbers: "12.", "12.1", "12.3.4)". Guarded
// against dates and amounts: bare integers must stay small and the number
// must be followed by a terminator or a capitalized/quoted word.
function collectNumberAnchors(texts: string[]) {
  const anchors: NumberAnchor[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    const match = text.match(
      /^(?:(?:Section|Clause|Article|SECTION|CLAUSE|ARTICLE)\s+)?(\d{1,3}(?:\.\d{1,3})*)([.)]?)(\s|$)/u,
    );
    if (!match) continue;
    const number = match[1];
    const isDotted = number.includes(".");
    if (!isDotted && Number(number) > 500) continue;
    const rest = text.slice(match[0].length).trimStart();
    const terminated = match[2] !== "";
    const headingLike = rest === "" || /^["'(A-Z]/u.test(rest);
    if (!terminated && !headingLike) continue;
    anchors.push({ number, paragraphIndex: index });
  }
  return anchors;
}

function collectRomanArticleAnchors(texts: string[]) {
  const anchors: NumberAnchor[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const match = texts[index].match(/^(?:Article|ARTICLE)\s+([IVXLCDM]+)\b/u);
    if (match) anchors.push({ number: match[1], paragraphIndex: index });
  }
  return anchors;
}

type CrossReferenceResult = {
  references: number;
  resolved: number;
  skippedExternal: number;
  findings: DocxLintFinding[];
  notes: string[];
};

function checkCrossReferences(
  texts: string[],
  numberAnchors: NumberAnchor[],
  romanAnchors: NumberAnchor[],
): CrossReferenceResult {
  const anchorSet = new Set(numberAnchors.map((anchor) => anchor.number));
  const romanSet = new Set(romanAnchors.map((anchor) => anchor.number));
  const findings: DocxLintFinding[] = [];
  const notes: string[] = [];
  let references = 0;
  let resolved = 0;
  let skippedExternal = 0;
  let abstained = 0;

  const anchoredChildDepths = new Set<string>();
  for (const anchor of anchorSet) {
    const parts = anchor.split(".");
    if (parts.length > 1) {
      anchoredChildDepths.add(`${parts.slice(0, -1).join(".")}:${parts.length}`);
    }
  }
  const topLevelAnchors = [...anchorSet]
    .filter((anchor) => !anchor.includes("."))
    .map(Number);

  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    const pattern =
      /\b(Section|Sections|Clause|Clauses|Article|Articles|Paragraph|Paragraphs)\s+(\d{1,3}(?:\.\d{1,3})*|[IVXLCDM]+)\b/gu;
    for (const match of text.matchAll(pattern)) {
      const label = match[1];
      const value = match[2];
      const following = text.slice((match.index ?? 0) + match[0].length);
      const isRoman = ROMAN_PATTERN.test(value) && !/^\d/u.test(value);
      references += 1;
      if (isExternalReference(following)) {
        skippedExternal += 1;
        continue;
      }
      if (isRoman) {
        if (!romanSet.size) {
          abstained += 1;
          continue;
        }
        if (romanSet.has(value)) {
          resolved += 1;
        } else if (romanToInt(value) !== null) {
          findings.push({
            code: "cross_reference_missing",
            severity: "error",
            subject: `${label} ${value}`,
            message: `${label} ${value} is referenced but no Article ${value} heading exists in this document.`,
            paragraph_index: index,
            excerpt: excerptAround(text, `${label} ${value}`),
          });
        }
        continue;
      }
      if (anchorSet.has(value)) {
        resolved += 1;
        continue;
      }
      // Resolved via anchored descendants: a reference to "12" is satisfied
      // by anchors "12.1", "12.2" even when "12" itself is not a paragraph.
      const hasDescendant = [...anchorSet].some((anchor) =>
        anchor.startsWith(`${value}.`),
      );
      if (hasDescendant) {
        resolved += 1;
        continue;
      }
      const parts = value.split(".");
      if (parts.length > 1) {
        // Flag "14.2" only when siblings at the same depth under the same
        // parent are anchored (renumbering artifact); otherwise the document
        // may simply not number to this depth — abstain.
        const parent = parts.slice(0, -1).join(".");
        if (anchoredChildDepths.has(`${parent}:${parts.length}`)) {
          findings.push({
            code: "cross_reference_missing",
            severity: "error",
            subject: `${label} ${value}`,
            message: `${label} ${value} is referenced but does not exist; sibling provisions under ${parent} are numbered without it.`,
            paragraph_index: index,
            excerpt: excerptAround(text, `${label} ${value}`),
          });
        } else {
          abstained += 1;
        }
        continue;
      }
      // Top-level reference: flag only against a substantial anchor universe.
      if (topLevelAnchors.length >= 3) {
        findings.push({
          code: "cross_reference_missing",
          severity: "error",
          subject: `${label} ${value}`,
          message: `${label} ${value} is referenced but no provision ${value} exists in this document.`,
          paragraph_index: index,
          excerpt: excerptAround(text, `${label} ${value}`),
        });
      } else {
        abstained += 1;
      }
    }
  }

  if (!anchorSet.size && !romanSet.size && references > skippedExternal) {
    notes.push(
      "Internal cross-references were found but the document has no literal clause numbering to check them against (Word field numbering is not resolved by this lint); cross-reference checks abstained.",
    );
  } else if (abstained > 0) {
    notes.push(
      `${abstained} cross-reference(s) could not be checked against the document's numbering scheme and were not flagged.`,
    );
  }
  return {
    references,
    resolved,
    skippedExternal,
    findings,
    notes,
  };
}

type AttachmentResult = {
  references: number;
  resolved: number;
  findings: DocxLintFinding[];
  notes: string[];
};

function checkAttachmentReferences(texts: string[]): AttachmentResult {
  const findings: DocxLintFinding[] = [];
  const notes: string[] = [];
  const anchors = new Map<string, Set<string>>();
  const references = new Map<
    string,
    { id: string; paragraphIndex: number; subject: string; text: string }[]
  >();
  let referenceCount = 0;
  let resolved = 0;

  const idPattern = "(\\d{1,3}|[A-Z]{1,3})";
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    for (const label of ATTACHMENT_LABELS) {
      const anchorMatch = text.match(
        new RegExp(`^${label}\\s+${idPattern}\\b`, "iu"),
      );
      if (anchorMatch) {
        const upper = text.slice(0, anchorMatch[0].length);
        const headingLike =
          text.length <= 80 ||
          upper === upper.toUpperCase() ||
          /^[\s]*[-–—:.]/u.test(text.slice(anchorMatch[0].length));
        if (headingLike) {
          const set = anchors.get(label) ?? new Set<string>();
          set.add(anchorMatch[1].toUpperCase());
          anchors.set(label, set);
          continue;
        }
      }
      const pattern = new RegExp(`\\b${label}s?\\s+${idPattern}\\b`, "gu");
      for (const match of text.matchAll(pattern)) {
        if ((match.index ?? 0) === 0) continue;
        const following = text.slice((match.index ?? 0) + match[0].length);
        if (isExternalReference(following)) continue;
        referenceCount += 1;
        const list = references.get(label) ?? [];
        list.push({
          id: match[1].toUpperCase(),
          paragraphIndex: index,
          subject: match[0],
          text,
        });
        references.set(label, list);
      }
    }
  }

  for (const [label, list] of references) {
    const anchorSet = anchors.get(label);
    if (!anchorSet || !anchorSet.size) {
      notes.push(
        `${list.length} ${label} reference(s) found but no ${label} is included in this document (attachments may be separate files); not checked.`,
      );
      continue;
    }
    for (const reference of list) {
      if (anchorSet.has(reference.id)) {
        resolved += 1;
      } else {
        findings.push({
          code: "attachment_reference_missing",
          severity: "error",
          subject: reference.subject,
          message: `${reference.subject} is referenced but only ${label} ${[...anchorSet].sort().join(", ")} ${anchorSet.size === 1 ? "is" : "are"} included in this document.`,
          paragraph_index: reference.paragraphIndex,
          excerpt: excerptAround(reference.text, reference.subject),
        });
      }
    }
  }

  return { references: referenceCount, resolved, findings, notes };
}

function checkNumberingSequence(
  texts: string[],
  anchors: NumberAnchor[],
): DocxLintFinding[] {
  const findings: DocxLintFinding[] = [];
  const groups = new Map<string, NumberAnchor[]>();
  for (const anchor of anchors) {
    const parts = anchor.number.split(".");
    const parent = parts.slice(0, -1).join(".");
    const list = groups.get(parent) ?? [];
    list.push(anchor);
    groups.set(parent, list);
  }

  for (const [parent, list] of groups) {
    if (list.length < 2) continue;
    let previous: { value: number; anchor: NumberAnchor } | null = null;
    for (const anchor of list) {
      const parts = anchor.number.split(".");
      const value = Number(parts[parts.length - 1]);
      if (previous) {
        const gap = value - previous.value;
        if (value === previous.value && parent !== "") {
          // Top-level duplicates are skipped: lists legitimately restart.
          findings.push({
            code: "numbering_duplicate",
            severity: "warning",
            subject: anchor.number,
            message: `Provision number ${anchor.number} appears more than once.`,
            paragraph_index: anchor.paragraphIndex,
            excerpt: excerptAround(
              texts[anchor.paragraphIndex],
              anchor.number,
            ),
          });
        } else if (gap >= 2 && gap <= 4) {
          // Small gaps are renumbering artifacts; large jumps or resets
          // usually mean a different scheme — abstain on those.
          findings.push({
            code: "numbering_gap",
            severity: "warning",
            subject: anchor.number,
            message: `Numbering jumps from ${previous.anchor.number} to ${anchor.number}; ${
              gap === 2
                ? `${parent ? `${parent}.` : ""}${previous.value + 1} is missing`
                : `${gap - 1} provisions are missing in between`
            }.`,
            paragraph_index: anchor.paragraphIndex,
            excerpt: excerptAround(
              texts[anchor.paragraphIndex],
              anchor.number,
            ),
          });
        }
      }
      previous = { value, anchor };
    }
  }
  return findings;
}

type DefinedTermsResult = {
  definitions: number;
  findings: DocxLintFinding[];
  notes: string[];
};

function collectDefinedTerms(texts: string[]) {
  const terms = new Map<string, number[]>();
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index];
    const seenHere = new Set<string>();
    // Style 1: parenthetical definitions — (the "Term"), (each a "Unit",
    // collectively the "Units").
    for (const parenthetical of text.matchAll(/\(([^()]{1,200})\)/gu)) {
      for (const quoted of parenthetical[1].matchAll(
        /"([A-Z][A-Za-z0-9&'\- ]{0,79})"/gu,
      )) {
        seenHere.add(quoted[1]);
      }
    }
    // Style 2: definition-list entries — "Term" means / shall mean / has the
    // meaning ...
    const listEntry = text.match(
      /^"([A-Z][A-Za-z0-9&'\- ]{0,79})"\s+(?:means|shall mean|has the meaning|shall have the meaning)\b/u,
    );
    if (listEntry) seenHere.add(listEntry[1]);
    for (const term of seenHere) {
      const list = terms.get(term) ?? [];
      list.push(index);
      terms.set(term, list);
    }
  }
  return terms;
}

function checkDefinedTerms(texts: string[]): DefinedTermsResult {
  const terms = collectDefinedTerms(texts);
  const findings: DocxLintFinding[] = [];
  const notes: string[] = [];
  if (!terms.size) {
    notes.push(
      "No quoted defined terms were detected; defined-term checks abstained.",
    );
    return { definitions: 0, findings, notes };
  }

  for (const [term, definedIn] of terms) {
    if (definedIn.length > 1) {
      findings.push({
        code: "defined_term_duplicate",
        severity: "warning",
        subject: term,
        message: `"${term}" is defined ${definedIn.length} times (paragraphs ${definedIn.join(", ")}).`,
        paragraph_index: definedIn[definedIn.length - 1],
        excerpt: excerptAround(texts[definedIn[definedIn.length - 1]], term),
      });
    }

    // Usage: the exact term (or trivial singular/plural variant) as a whole
    // word anywhere outside its defining paragraph(s).
    const variants = new Set([term]);
    if (term.endsWith("s")) variants.add(term.slice(0, -1));
    else variants.add(`${term}s`);
    const definedSet = new Set(definedIn);
    let used = false;
    for (let index = 0; index < texts.length && !used; index += 1) {
      if (definedSet.has(index)) continue;
      for (const variant of variants) {
        if (
          new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(variant)}(?![a-z0-9])`, "u").test(
            texts[index],
          )
        ) {
          used = true;
          break;
        }
      }
    }
    if (!used) {
      findings.push({
        code: "defined_term_unused",
        severity: "warning",
        subject: term,
        message: `"${term}" is defined but never used elsewhere in this document.`,
        paragraph_index: definedIn[0],
        excerpt: excerptAround(texts[definedIn[0]], term),
      });
    }
  }
  return { definitions: terms.size, findings, notes };
}

export async function lintDocxStructure(
  bytes: Buffer,
): Promise<DocxStructuralLintReport> {
  const zip = await loadZip(bytes);
  const documentEntry =
    zip.file("word/document.xml") ?? zip.file(/^word\/document\.xml$/iu)[0];
  if (!documentEntry) {
    throw new Error("Structural lint requires a valid DOCX");
  }
  const documentXml = await documentEntry.async("string");
  const texts = paragraphTexts(documentXml);

  const numberAnchors = collectNumberAnchors(texts);
  const romanAnchors = collectRomanArticleAnchors(texts);
  const crossReferences = checkCrossReferences(
    texts,
    numberAnchors,
    romanAnchors,
  );
  const attachments = checkAttachmentReferences(texts);
  const numbering = checkNumberingSequence(texts, numberAnchors);
  const definedTerms = checkDefinedTerms(texts);

  const notes = [
    ...crossReferences.notes,
    ...attachments.notes,
    ...definedTerms.notes,
  ];
  let findings = [
    ...crossReferences.findings,
    ...attachments.findings,
    ...numbering,
    ...definedTerms.findings,
  ];
  if (findings.length > MAX_FINDINGS) {
    notes.push(
      `Findings truncated to ${MAX_FINDINGS} of ${findings.length}.`,
    );
    findings = findings.slice(0, MAX_FINDINGS);
  }

  return {
    paragraphs: texts.length,
    checks: {
      cross_references: {
        references: crossReferences.references,
        resolved: crossReferences.resolved,
        skipped_external: crossReferences.skippedExternal,
      },
      attachments: {
        references: attachments.references,
        resolved: attachments.resolved,
      },
      numbering: { anchors: numberAnchors.length + romanAnchors.length },
      defined_terms: { definitions: definedTerms.definitions },
    },
    findings,
    notes,
  };
}

export async function lintLocalDocxStructure(
  userId: string,
  documentId: string,
  versionId?: string,
) {
  const file = await getLocalVersionFile(userId, documentId, versionId);
  if (!file) throw new Error("Document not found");
  if (file.fileType.toLowerCase() !== "docx") {
    throw new Error("Structural lint currently requires a DOCX document");
  }
  const report = await lintDocxStructure(await readFile(file.path));
  return {
    ok: true as const,
    document_id: documentId,
    version_id: file.version.id,
    filename: file.version.filename,
    ...report,
  };
}
