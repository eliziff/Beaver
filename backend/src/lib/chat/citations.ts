import {
  legalEvidenceCitationGroups,
  type LegalEvidenceTurnState,
  type RegisteredEvidence,
} from "./legalEvidence";
import {
  presentLegalEvidence,
  type CitationPresentation,
} from "./citationPresentation";

function receiptLocator(
  entry: RegisteredEvidence,
  presentation: CitationPresentation,
) {
  const { kind, label } = entry.receipt.locator;
  return !presentation.locator ? {} : {
    locator_kind: kind,
    locator: label,
    pinpoint: presentation.locator.text,
  };
}

export function legalEvidenceDocumentLink(entry: RegisteredEvidence) {
  const { receipt } = entry;
  const presentation = presentLegalEvidence(entry);
  return {
    stableId: receipt.stable_source_id,
    sourceSha256: receipt.source_sha256,
    authority: presentation.authority,
    shortAuthority: presentation.shortAuthority,
    mainUrl: presentation.sourceUrl,
    pinpoint: presentation.locator ? {
      text: presentation.locator.text,
      url: presentation.passageUrl,
      separator: presentation.locator.separator,
    } : null,
  };
}

/**
 * Project the existing strict evidence-id submission into the same citation
 * events used by document and legal-source provider JSON.
 */
export function createLegalEvidenceCitations(
  state: LegalEvidenceTurnState,
): Record<string, unknown>[] {
  return legalEvidenceCitationGroups(state).flatMap<Record<string, unknown>>(
    (group) => {
      const entry = group.members[0];
      const { receipt } = entry;
      const quote = receipt.span_text;
      if (!quote) return [];
      // Quotes are verified source passages, never model prose. Fragments,
      // highlights, and DOCX links all derive from the same receipt span.
      const quotes = group.members.flatMap(({ receipt }) =>
        receipt.span_text ? [{ quote: receipt.span_text }] : []);
      const presentation = presentLegalEvidence(entry);
      const locator = receiptLocator(entry, presentation);
      const display = {
        authority: presentation.authority,
        short_authority: presentation.shortAuthority,
        ...(presentation.locator && {
          locator_separator: presentation.locator.separator,
        }),
      };
      if (receipt.tabular) {
        return [{
          kind: "tabular" as const,
          ref: group.ref,
          ...receipt.tabular,
          quotes,
          ...display,
        }];
      }
      if (receipt.provider === "library") {
        return [{
          kind: "document" as const,
          ref: group.ref,
          document_id: receipt.stable_source_id,
          version_id: receipt.version,
          filename: receipt.name ?? receipt.citation,
          quotes,
          ...display,
          ...locator,
        }];
      }
      if (receipt.provider === "journal") {
        const identifier = receipt.stable_source_id.startsWith("journal:")
          ? receipt.stable_source_id.slice("journal:".length)
          : receipt.stable_source_id;
        return [{
          kind: "public_legal" as const,
          ref: group.ref,
          provider: "journal" as const,
          identifier,
          title: receipt.name,
          citation: receipt.citation,
          url: presentation.passageUrl,
          external_url: presentation.sourceUrl,
          source_class: receipt.source_class,
          quotes,
          ...display,
          ...locator,
        }];
      }
      if (["courtlistener", "tna", "govuk-et", "govinfo", "hansard"].includes(
        receipt.provider,
      )) {
        return [{
          kind: "public_legal" as const,
          ref: group.ref,
          provider: receipt.provider,
          identifier: receipt.stable_source_id,
          title: receipt.name,
          citation: receipt.citation,
          url: presentation.passageUrl,
          external_url: presentation.sourceUrl,
          source_class: receipt.source_class,
          quotes,
          ...display,
          ...locator,
        }];
      }
      if (receipt.provider !== "a2aj" && receipt.provider !== "citator") return [];
      if (group.members.length > 1 && group.collapsedLabel) {
        const prefix = receipt.locator.label.match(/^[A-Za-z]+/u)?.[0] ?? "";
        return [{
          kind: "a2aj" as const,
          ref: group.ref,
          citation: receipt.citation,
          name: receipt.name,
          dataset: receipt.dataset,
          url: presentation.passageUrl,
          external_url: presentation.sourceUrl,
          source_class: receipt.source_class,
          quotes,
          ...display,
          locator_kind: receipt.locator.kind,
          locator: `${prefix}${group.collapsedLabel}`,
          locator_separator: ", ",
          pinpoint: `s ${group.collapsedLabel}`,
        }];
      }
      return [{
        kind: "a2aj" as const,
        ref: group.ref,
        citation: receipt.citation,
        name: receipt.name,
        dataset: receipt.dataset,
        url: presentation.passageUrl,
        external_url: presentation.sourceUrl,
        source_class: receipt.source_class,
        quotes,
        ...display,
        ...locator,
      }];
    },
  );
}
