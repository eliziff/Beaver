import {
  legalSourceQuoteCandidates,
  legalSourceQuoteMatchesBlock,
} from "../legalSourceLinks";
import {
  legalEvidenceCitationEntries,
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

function tailoredReceiptQuotes(
  state: LegalEvidenceTurnState,
  evidenceId: string,
  fallback: string,
) {
  const quotes = new Map<string, string>();
  for (const claim of state.answer ?? []) {
    if (!claim.evidence_ids.includes(evidenceId)) continue;
    const entries = claim.evidence_ids.flatMap((id) => {
      const receipt = state.evidence.get(id)?.receipt;
      return receipt?.span_text ? [{ id, text: receipt.span_text }] : [];
    });
    for (const quote of legalSourceQuoteCandidates(claim.text)) {
      const matches = entries.filter(({ text }) =>
        legalSourceQuoteMatchesBlock(text, quote),
      );
      if (matches.length !== 1 || matches[0].id !== evidenceId) continue;
      const key = quote.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
      if (key && !quotes.has(key)) quotes.set(key, quote);
    }
  }
  return quotes.size ? [...quotes.values()] : [fallback];
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
  return legalEvidenceCitationEntries(state).flatMap<Record<string, unknown>>(
    (entry) => {
      const { ref, receipt } = entry;
      const quote = receipt.span_text;
      if (!quote) return [];
      const quoteTexts = tailoredReceiptQuotes(
        state,
        receipt.evidence_id,
        quote,
      );
      const quotes = quoteTexts.map((quote) => ({ quote }));
      const presentation = presentLegalEvidence(entry, quoteTexts);
      const locator = receiptLocator(entry, presentation);
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
          ref,
          ...receipt.tabular,
          quotes,
          ...display,
        }];
      }
      if (receipt.provider === "library") {
        return [{
          kind: "document" as const,
          ref,
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
          ref,
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
      const publicProvider = receipt.provider === "benchmark"
        ? (["tna", "govuk-et", "govinfo"] as const).find((provider) =>
            receipt.stable_source_id.startsWith(`${provider}:`))
        : undefined;
      if (publicProvider) {
        return [{
          kind: "public_legal" as const,
          ref,
          provider: publicProvider,
          identifier: receipt.stable_source_id.slice(publicProvider.length + 1),
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
      return [{
        kind: "a2aj" as const,
        ref,
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
