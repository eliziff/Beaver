import {
  legalEvidenceCitationGroups,
  type LegalEvidenceTurnState,
  type RegisteredEvidence,
} from "./legalEvidence";
import {
  citationPresentationText,
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
    authority: citationPresentationText(presentation.authority),
    shortAuthority: citationPresentationText(presentation.shortAuthority),
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
      const lead = group.members[0];
      const { receipt } = lead;
      const quote = receipt.span_text;
      if (!quote) return [];
      // Quotes are verified source passages, never model prose. Fragments,
      // highlights, and DOCX links all derive from the same receipt span.
      const quotes = group.members.flatMap(({ receipt }) =>
        receipt.span_text ? [{ quote: receipt.span_text }] : [],
      );
      const presentation = presentLegalEvidence(lead);
      const locator = receiptLocator(lead, presentation);
      const display = {
        authority: citationPresentationText(presentation.authority),
        short_authority: citationPresentationText(presentation.shortAuthority),
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
      // A provision family (one instrument, adjacent sections) renders one
      // range pinpoint instead of a pill per clause. The link lands on the
      // first member's verified fragment; every member's span stays in
      // quotes for export fidelity.
      if (group.members.length > 1 && group.collapsedLabel) {
        // collapsedLabel is bare ("49(1)\u2013(4)"); the locator field keeps
        // the receipt-style kind prefix ("sec49(1)\u2013(4)").
        const collapsedDisplay = group.collapsedLabel;
        const collapsedRaw =
          `${receipt.locator.label.match(/^[A-Za-z]+/u)?.[0] ?? ""}${collapsedDisplay}`;
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
          locator: collapsedRaw,
          locator_separator: ", ",
          // A family shares one instrument section by construction, so the
          // pinpoint noun is always the singular "s".
          pinpoint: `s ${collapsedDisplay}`,
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
