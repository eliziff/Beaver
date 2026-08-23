// Rust owns DOCX detection. This file only turns its facts into Beaver's
// user-facing lint receipt.

const MAX_FINDINGS = 200;
const EXCERPT_LENGTH = 160;

type Finding = {
  code:
    | "cross_reference_missing"
    | "attachment_reference_missing"
    | "numbering_gap"
    | "numbering_duplicate"
    | "defined_term_duplicate"
    | "defined_term_unused";
  severity: "error" | "warning";
  subject: string;
  message: string;
  paragraph_index: number;
  excerpt: string;
};

type DocxStructuralLintReport = {
  paragraphs: number;
  checks: {
    cross_references: {
      references: number;
      resolved: number;
      skipped_external: number;
    };
    attachments: { references: number; resolved: number };
    numbering: { anchors: number };
    defined_terms: { definitions: number };
  };
  findings: Finding[];
  notes: string[];
};

function excerptAround(text: string, subject: string) {
  const index = text.indexOf(subject);
  if (index < 0) return text.slice(0, EXCERPT_LENGTH);
  const start = Math.max(0, index - Math.floor((EXCERPT_LENGTH - subject.length) / 2));
  const slice = text.slice(start, start + EXCERPT_LENGTH);
  return `${start > 0 ? "…" : ""}${slice}${
    start + EXCERPT_LENGTH < text.length ? "…" : ""
  }`;
}

export function lintDocxStructure(
  structure: {
    text: string;
    definitions?: Array<{
      term: string;
      definitions: Array<{ source_paragraph_id: string }>;
      uses: unknown[];
    }>;
    docx: {
      numbering: {
        number_anchors: Array<{ paragraph_index: number }>;
        roman_article_anchors: Array<{ paragraph_index: number }>;
        duplicates: Array<{ paragraph_index: number; number: string }>;
        gaps: Array<{
          paragraph_index: number;
          previous_number: string;
          number: string;
          missing: string[];
        }>;
      };
      cross_references: Array<{
        paragraph_index: number;
        subject: string;
        value: string;
        status:
          | "Resolved"
          | "SkippedExternal"
          | "MissingRomanArticle"
          | "MissingTopLevel"
          | "Abstained"
          | { MissingSibling: { parent: string } };
      }>;
      attachments: Array<{
        paragraph_index: number;
        label: string;
        subject: string;
        status:
          | "Resolved"
          | "AbstainedNoAnchor"
          | { Missing: { included: string[] } };
      }>;
    } | null;
  },
): DocxStructuralLintReport {
  if (!structure.docx) throw new Error("DOCX structure facts are missing");
  const paragraphs = structure.text.split("\n");
  const definitions = structure.definitions ?? [];
  const { attachments, cross_references: references, numbering } = structure.docx;
  const findings: Finding[] = [];
  const notes: string[] = [];
  const excerpt = (paragraph: number, subject: string) =>
    excerptAround(paragraphs[paragraph] ?? "", subject);

  for (const reference of references) {
    const common = {
      code: "cross_reference_missing" as const,
      severity: "error" as const,
      subject: reference.subject,
      paragraph_index: reference.paragraph_index,
      excerpt: excerpt(reference.paragraph_index, reference.subject),
    };
    if (reference.status === "MissingRomanArticle") {
      findings.push({
        ...common,
        message: `${reference.subject} is referenced but no Article ${reference.value} heading exists in this document.`,
      });
    } else if (reference.status === "MissingTopLevel") {
      findings.push({
        ...common,
        message: `${reference.subject} is referenced but no provision ${reference.value} exists in this document.`,
      });
    } else if (typeof reference.status === "object") {
      const parent = reference.status.MissingSibling.parent;
      findings.push({
        ...common,
        message: `${reference.subject} is referenced but does not exist; sibling provisions under ${parent} are numbered without it.`,
      });
    }
  }

  const skippedExternal = references.filter(
    ({ status }) => status === "SkippedExternal",
  ).length;
  const abstained = references.filter(({ status }) => status === "Abstained").length;
  if (
    !numbering.number_anchors.length &&
    !numbering.roman_article_anchors.length &&
    references.length > skippedExternal
  ) {
    notes.push(
      "Internal cross-references were found but the document has no literal clause numbering to check them against (Word field numbering is not resolved by this lint); cross-reference checks abstained.",
    );
  } else if (abstained) {
    notes.push(
      `${abstained} cross-reference(s) could not be checked against the document's numbering scheme and were not flagged.`,
    );
  }

  const attachmentLabels = new Map<string, number>();
  for (const attachment of attachments) {
    if (attachment.status === "AbstainedNoAnchor") {
      attachmentLabels.set(
        attachment.label,
        (attachmentLabels.get(attachment.label) ?? 0) + 1,
      );
    } else if (typeof attachment.status === "object") {
      const { included } = attachment.status.Missing;
      findings.push({
        code: "attachment_reference_missing",
        severity: "error",
        subject: attachment.subject,
        message: `${attachment.subject} is referenced but only ${attachment.label} ${included.join(", ")} ${included.length === 1 ? "is" : "are"} included in this document.`,
        paragraph_index: attachment.paragraph_index,
        excerpt: excerpt(attachment.paragraph_index, attachment.subject),
      });
    }
  }
  for (const [label, count] of attachmentLabels) {
    notes.push(
      `${count} ${label} reference(s) found but no ${label} is included in this document (attachments may be separate files); not checked.`,
    );
  }

  const numberingFindings: Finding[] = [];
  for (const duplicate of numbering.duplicates) {
    numberingFindings.push({
      code: "numbering_duplicate",
      severity: "warning",
      subject: duplicate.number,
      message: `Provision number ${duplicate.number} appears more than once.`,
      paragraph_index: duplicate.paragraph_index,
      excerpt: excerpt(duplicate.paragraph_index, duplicate.number),
    });
  }
  for (const gap of numbering.gaps) {
    numberingFindings.push({
      code: "numbering_gap",
      severity: "warning",
      subject: gap.number,
      message: `Numbering jumps from ${gap.previous_number} to ${gap.number}; ${
        gap.missing.length === 1
          ? `${gap.missing[0]} is missing`
          : `${gap.missing.length} provisions are missing in between`
      }.`,
      paragraph_index: gap.paragraph_index,
      excerpt: excerpt(gap.paragraph_index, gap.number),
    });
  }
  findings.push(...numberingFindings.sort(
    (left, right) => left.paragraph_index - right.paragraph_index,
  ));

  if (!definitions.length) {
    notes.push("No quoted defined terms were detected; defined-term checks abstained.");
  }
  for (const term of definitions) {
    const definedIn = term.definitions.map(({ source_paragraph_id }) =>
      Number(source_paragraph_id)
    );
    if (definedIn.length > 1) {
      const paragraph = definedIn.at(-1)!;
      findings.push({
        code: "defined_term_duplicate",
        severity: "warning",
        subject: term.term,
        message: `"${term.term}" is defined ${definedIn.length} times (paragraphs ${definedIn.join(", ")}).`,
        paragraph_index: paragraph,
        excerpt: excerpt(paragraph, term.term),
      });
    }
    if (!term.uses.length) {
      const paragraph = definedIn[0];
      findings.push({
        code: "defined_term_unused",
        severity: "warning",
        subject: term.term,
        message: `"${term.term}" is defined but never used elsewhere in this document.`,
        paragraph_index: paragraph,
        excerpt: excerpt(paragraph, term.term),
      });
    }
  }

  if (findings.length > MAX_FINDINGS) {
    notes.push(`Findings truncated to ${MAX_FINDINGS} of ${findings.length}.`);
  }
  return {
    paragraphs: paragraphs.length,
    checks: {
      cross_references: {
        references: references.length,
        resolved: references.filter(({ status }) => status === "Resolved").length,
        skipped_external: skippedExternal,
      },
      attachments: {
        references: attachments.length,
        resolved: attachments.filter(({ status }) => status === "Resolved").length,
      },
      numbering: {
        anchors:
          numbering.number_anchors.length + numbering.roman_article_anchors.length,
      },
      defined_terms: { definitions: definitions.length },
    },
    findings: findings.slice(0, MAX_FINDINGS),
    notes,
  };
}
