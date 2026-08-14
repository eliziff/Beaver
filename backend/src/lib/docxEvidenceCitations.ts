import { legalEvidenceDocumentLink } from "./chat/citations";
import {
  registerDocumentLegalEvidence,
  type LegalEvidenceTurnState,
} from "./chat/legalEvidence";
import type { DocxCitation } from "./chat/tools/docxMarkdown";

const CITATION_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const EVIDENCE_ID = /^e_[A-Za-z0-9_-]{8,64}$/u;

type CitationInput = {
  id: string;
  evidenceIds: string[];
};

export type ResolvedDocxEvidenceCitations = {
  citations: Record<string, DocxCitation>;
  bindings: {
    id: string;
    evidenceIds: string[];
    sourceSha256s: string[];
    locators: string[];
    mainUrls: string[];
    pinpointUrls: string[];
  }[];
};

function citationInputs(raw: unknown): CitationInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new Error("DOCX citations must be an array of at most 100 entries.");
  }
  const seen = new Set<string>();
  let evidenceCount = 0;
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Each DOCX citation must be an object.");
    }
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["id", "evidence_ids"].includes(key))) {
      throw new Error("DOCX citation objects contain unsupported fields.");
    }
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const evidenceIds = Array.isArray(row.evidence_ids)
      ? row.evidence_ids.map((item) => typeof item === "string" ? item.trim() : "")
      : [];
    if (!CITATION_ID.test(id) || seen.has(id)) {
      throw new Error("DOCX citation ids must be unique lowercase identifiers.");
    }
    if (
      !evidenceIds.length ||
      evidenceIds.length > 16 ||
      evidenceIds.some((evidenceId) => !EVIDENCE_ID.test(evidenceId)) ||
      new Set(evidenceIds).size !== evidenceIds.length
    ) {
      throw new Error(`DOCX citation "${id}" has invalid evidence_ids.`);
    }
    evidenceCount += evidenceIds.length;
    if (evidenceCount > 256) {
      throw new Error("DOCX citations contain more than 256 evidence ids.");
    }
    seen.add(id);
    return { id, evidenceIds };
  });
}

function safeUrls(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function resolveDocxEvidenceCitations(
  state: LegalEvidenceTurnState | undefined,
  rawCitations: unknown,
): ResolvedDocxEvidenceCitations {
  const inputs = citationInputs(rawCitations);
  if (inputs.length && !state) {
    throw new Error("DOCX citations require this turn's legal evidence registry.");
  }
  const resolved = inputs.map((input) => {
    const entries = input.evidenceIds.map((evidenceId) => {
      const entry = state?.evidence.get(evidenceId);
      if (!entry) {
        throw new Error(
          `DOCX citation "${input.id}" has unknown evidence_id: ${evidenceId}.`,
        );
      }
      if (entry.receipt.scope !== "passage" || !entry.receipt.span_text) {
        throw new Error(
          `DOCX citation "${input.id}" requires exact passage evidence: ${evidenceId}.`,
        );
      }
      return entry;
    });
    const projected = entries.map(legalEvidenceDocumentLink);
    const grouped = new Map<string, DocxCitation["sources"][number]>();
    for (const source of projected) {
      const existing = grouped.get(source.stableId);
      if (!existing) {
        grouped.set(source.stableId, {
          stableId: source.stableId,
          authority: source.authority,
          shortAuthority: source.shortAuthority,
          mainUrl: source.mainUrl,
          pinpoints: source.pinpoint ? [source.pinpoint] : [],
        });
      } else if (
        source.pinpoint &&
        !existing.pinpoints.some(
          (pinpoint) =>
            pinpoint.text === source.pinpoint?.text &&
            pinpoint.url === source.pinpoint?.url,
        )
      ) {
        existing.pinpoints.push(source.pinpoint);
      }
    }
    const citation: DocxCitation = { sources: [...grouped.values()] };
    return {
      id: input.id,
      citation,
      binding: {
        id: input.id,
        evidenceIds: input.evidenceIds,
        sourceSha256s: [...new Set(projected.map(({ sourceSha256 }) => sourceSha256))],
        locators: projected.flatMap(({ pinpoint }) => pinpoint ? [pinpoint.text] : []),
        mainUrls: safeUrls(projected.map(({ mainUrl }) => mainUrl)),
        pinpointUrls: safeUrls(projected.map(({ pinpoint }) => pinpoint?.url)),
      },
    };
  });
  if (state) {
    registerDocumentLegalEvidence(
      state,
      resolved.flatMap(({ binding }) => binding.evidenceIds),
    );
  }
  return {
    citations: Object.fromEntries(resolved.map(({ id, citation }) => [id, citation])),
    bindings: resolved.map(({ binding }) => binding),
  };
}
