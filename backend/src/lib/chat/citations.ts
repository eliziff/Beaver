import { parseAssistantCitations, type AssistantCitation } from "./assistantWire";
import {
  legalEvidenceCitationGroupsFromEntries,
  legalEvidenceCitationPlan,
  legalEvidenceSourceReference,
  type LegalEvidenceTurnState,
  type RegisteredEvidence,
} from "./legalEvidence";
import { presentLegalEvidence } from "./citationPresentation";

const documentLinks = new WeakMap<RegisteredEvidence, ReturnType<typeof projectDocumentLink>>();

/**
 * One link per registered entry. Planning the passage fragment replays the
 * browser's text search over the whole judgment, which measured 9 s for one
 * Bhasin passage; a Write resolves every citation's entries and a ledger builds
 * on them again, so the link is derived once and read from the entry after that.
 */
export function legalEvidenceDocumentLink(entry: RegisteredEvidence) {
  let link = documentLinks.get(entry);
  if (!link) { link = projectDocumentLink(entry); documentLinks.set(entry, link); }
  return link;
}

function projectDocumentLink(entry: RegisteredEvidence) {
  const { receipt } = entry;
  const started = Date.now();
  const presentation = presentLegalEvidence(entry);
  const elapsed = Date.now() - started;
  // Planning a passage link runs on this thread; a slow one is worth a line.
  if (elapsed > 1000) console.warn("[link] planned in", elapsed, "ms", { citation: receipt.citation, locator: receipt.locator.label, span: receipt.span_text?.length ?? 0 });
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
function citationsFromGroups(
  groups: ReturnType<typeof legalEvidenceCitationGroupsFromEntries>,
) {
  return parseAssistantCitations(groups.flatMap<Record<string, unknown>>(
    (group) => {
      // Present from a member carrying the group's locator system, so the
      // chip's pinpoint and its passage link agree.
      const entry = group.members.find(
        ({ receipt }) => receipt.locator.kind === group.locatorKind) ?? group.members[0];
      const { receipt } = entry;
      if (!receipt.span_text) return [];
      // Quotes are verified source passages, never model prose. Fragments,
      // highlights, and DOCX links all derive from the same receipt span.
      const quotes = group.members.flatMap(({ receipt }) =>
        receipt.span_text ? [{ quote: receipt.span_text, ...(receipt.locator.sheet && { sheet: receipt.locator.sheet }),
          ...(receipt.locator.cells && { cell: receipt.locator.cells }),
          ...(receipt.provider === "library" && receipt.locator.kind === "page" && { page: receipt.locator.label.replace(/^page\s*/iu, "") }) }] : []);
      const presentation = presentLegalEvidence(
        entry,
        quotes.map(({ quote }) => quote),
        group.locatorLabels,
        group.locatorKind,
      );
      const locator = !presentation.locator ? {} : {
        locator_kind: group.locatorKind, locator: presentation.locator.label,
        pinpoint: presentation.locator.text };
      const display = {
        authority: presentation.authority,
        short_authority: presentation.shortAuthority,
        ...(group.shortForm && { short_form: true }),
        ...(presentation.locator && {
          locator_separator: presentation.locator.separator,
        }),
      };
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
          ...(receipt.locator.sheet && { sheet: receipt.locator.sheet }),
          ...(receipt.locator.cells && { cells: receipt.locator.cells }),
        }];
      }
      if (["journal", "courtlistener", "tna", "govuk-et", "govinfo", "hansard"].includes(
        receipt.provider,
      )) {
        return [{
          kind: "public_legal" as const,
          ref: group.ref,
          provider: receipt.provider,
          identifier: legalEvidenceSourceReference(receipt)?.id ??
            (receipt.provider === "journal" ? receipt.stable_source_id.replace(/^journal:/u, "")
              : receipt.stable_source_id),
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
  ));
}

export function createLegalEvidenceCitationsFromEntries(
  entries: readonly RegisteredEvidence[],
): AssistantCitation[] {
  return citationsFromGroups(legalEvidenceCitationGroupsFromEntries(entries));
}

/**
 * Project the existing strict evidence-id submission into the same citation
 * events used by document and legal-source provider JSON.
 */
export function createLegalEvidenceCitations(
  state: LegalEvidenceTurnState,
): AssistantCitation[] {
  return citationsFromGroups(legalEvidenceCitationPlan(state).groups);
}

type SearchCitationCandidate = {
  provider: unknown;
  kind: unknown;
  id: unknown;
  title: unknown;
  citation: unknown;
  collection: unknown;
  url?: unknown;
};

export function createLegalSourceSearchCitations(
  value: unknown,
): AssistantCitation[] {
  const candidates = Array.isArray(value)
    ? value.filter((candidate): candidate is SearchCitationCandidate =>
        Boolean(candidate) && typeof candidate === "object")
    : [];
  return parseAssistantCitations(candidates.flatMap<Record<string, unknown>>((candidate, index) => {
    const provider = typeof candidate.provider === "string" ? candidate.provider : "";
    const identifier = typeof candidate.id === "string" ? candidate.id : "";
    if (!identifier) return [];
    const title = typeof candidate.title === "string" ? candidate.title : null;
    const citation = typeof candidate.citation === "string" ? candidate.citation : null;
    const collection = typeof candidate.collection === "string" ? candidate.collection : null;
    const url = typeof candidate.url === "string" ? candidate.url : null;
    const sourceClass = candidate.kind === "case" ? "case"
      : candidate.kind === "legislation" ? "legislation"
        : "commentary";
    const common = {
      ref: index + 1,
      source_class: sourceClass,
      quotes: [],
      ...(url && { url, external_url: url }),
    };
    if (provider === "a2aj") return [{
      kind: "a2aj" as const,
      name: title,
      citation,
      dataset: collection,
      ...common,
    }];
    if (!["courtlistener", "tna", "govuk-et", "govinfo", "hansard", "journal"]
      .includes(provider)) return [];
    return [{
      kind: "public_legal" as const,
      provider,
      identifier,
      title,
      citation,
      ...(provider === "journal" && citation && { authority: citation }),
      ...common,
    }];
  }));
}
