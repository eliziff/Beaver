import { type DocIndex, resolveDoc } from "./types";
import type { A2AJDocument, A2AJLocatorLookup } from "../a2aj";
import {
  buildA2AJCitationPinpointUrl,
  buildCourtlistenerCitationPinpointUrl,
  buildLegalSourcePinpointUrl,
  formatLegalLocator,
  legalSourceQuoteCandidates,
  legalSourceQuoteMatchesBlock,
} from "../legalSourceLinks";
import { buildCanliiCaseUrl } from "../canliiUrls";
import {
  buildPublicLegalCitationUrl,
  getPublicLegalCitationDocument,
  type PublicLegalCitationIdentity,
  type PublicLegalSourceState,
} from "./publicLegalSourceState";
import { getCourtlistenerOpinionStructure } from "../courtlistener";
import {
  sourceDocContainsQuote,
  type SourceDoc,
  type SourceDocBlock,
  type SourceDocLocatorKind,
} from "../sourceDoc";
import {
  legalEvidenceCitationEntries,
  type LegalEvidenceReceipt,
  type LegalEvidenceTurnState,
} from "./legalEvidenceExperiment";

// ---------------------------------------------------------------------------
// Internal citation parse types
// ---------------------------------------------------------------------------

type DocumentQuote = {
  page: number | string;
  quote: string;
  // Spreadsheet sources are located by cell instead of page: `sheet` is the
  // worksheet name and `cell` is an A1 address or range (e.g. "B7" or "B7:C9").
  sheet?: string;
  cell?: string;
};

type ParsedDocumentCitation = {
  kind: "document";
  ref: number;
  doc_id: string;
  page: number | string;
  quote: string;
  sheet?: string;
  cell?: string;
  quotes: DocumentQuote[];
};

type ParsedCaseCitation = {
  kind: "case";
  ref: number;
  cluster_id: number;
  quotes: {
    opinionId: number | null;
    type: string | null;
    author: string | null;
    quote: string;
  }[];
};

type ParsedA2AJCitation = {
  kind: "a2aj";
  ref: number;
  citation: string | null;
  name: string | null;
  dataset: string | null;
  url: string | null;
  quotes: { quote: string }[];
};

type ParsedPublicLegalCitation = PublicLegalCitationIdentity & {
  kind: "public_legal";
  ref: number;
};

type ParsedCitation =
  | ParsedDocumentCitation
  | ParsedCaseCitation
  | ParsedA2AJCitation
  | ParsedPublicLegalCitation;

/** URLs of built citations, for suppressing duplicate pinpoint links. */
export function citationUrls(citations: unknown[]): string[] {
  return citations.flatMap((citation) => {
    const url = (citation as { url?: unknown } | null)?.url;
    return typeof url === "string" ? [url] : [];
  });
}

type CasesByClusterId = Map<
  number,
  {
    caseName: string | null;
    citations: string[];
    url: string | null;
    pdfUrl: string | null;
    dateFiled: string | null;
    opinions?: unknown[];
  }
>;

type LegalPinpoint = {
  locator_kind: SourceDocLocatorKind;
  locator: string;
  pinpoint: string;
};

function normalizedIdentity(value: string | null | undefined) {
  return value?.trim().replace(/\s+/gu, " ").toLowerCase() ?? "";
}

function pinpointFor(
  block: Pick<SourceDocBlock, "kind" | "label">,
): LegalPinpoint {
  return {
    locator_kind: block.kind,
    locator: block.label,
    pinpoint: formatLegalLocator(block.kind, block.label),
  };
}

function smallestBlockContainingQuotes(doc: SourceDoc, quotes: string[]) {
  const matches = doc.blocks
    .filter((block) =>
      quotes.every((quote) => sourceDocContainsQuote(doc, quote, block)),
    )
    .sort(
      (left, right) =>
        left.end - left.start - (right.end - right.start),
    );
  if (!matches.length) return null;
  const length = matches[0].end - matches[0].start;
  const smallest = new Map(
    matches
      .filter((block) => block.end - block.start === length)
      .map((block) => [`${block.kind}:${block.label}`, block]),
  );
  return smallest.size === 1 ? [...smallest.values()][0] : null;
}

function courtlistenerOpinionId(value: Record<string, unknown>) {
  const raw = value.opinionId ?? value.opinion_id ?? value.id;
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.floor(raw)
    : null;
}

function a2ajCitationPinpoint(
  citation: ParsedA2AJCitation,
  lookups: A2AJLocatorLookup[],
) {
  const quotes = citation.quotes.map(({ quote }) => quote);
  if (!quotes.length) return null;
  const matches = new Map<string, Pick<SourceDocBlock, "kind" | "label">>();
  const identityMatches = (source: A2AJLocatorLookup) =>
    (!citation.citation ||
      [source.citation, source.alternateCitation]
        .map(normalizedIdentity)
        .includes(normalizedIdentity(citation.citation))) &&
    (!citation.dataset ||
      normalizedIdentity(source.dataset) ===
        normalizedIdentity(citation.dataset));
  const add = (
    source: Pick<A2AJLocatorLookup | A2AJDocument, "citation" | "dataset">,
    block: Pick<SourceDocBlock, "kind" | "label">,
  ) =>
    matches.set(
      [
        normalizedIdentity(source.dataset),
        normalizedIdentity(source.citation),
        block.kind,
        normalizedIdentity(block.label),
      ].join("|"),
      block,
    );

  for (const lookup of lookups) {
    if (lookup.status !== "found" || !identityMatches(lookup)) continue;
    for (const block of [lookup.block, ...lookup.before, ...lookup.after]) {
      if (
        block &&
        quotes.every((quote) => legalSourceQuoteMatchesBlock(block.text, quote))
      ) {
        add(lookup, block);
      }
    }
  }
  return matches.size === 1 ? pinpointFor([...matches.values()][0]) : null;
}

function courtlistenerCitationSupport(
  citation: ParsedCaseCitation,
  caseRecord?: CasesByClusterId extends Map<number, infer Value> ? Value : never,
) {
  if (!caseRecord || !citation.quotes.length) return { valid: false, pin: null };
  const opinions = (caseRecord.opinions ?? []).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const value = raw as Record<string, unknown>;
    const document = getCourtlistenerOpinionStructure(value);
    return document
      ? [{ opinionId: courtlistenerOpinionId(value), document }]
      : [];
  });
  const resolved = citation.quotes.map(({ opinionId, quote }) =>
    opinions.filter(
      (candidate) =>
        (opinionId === null || candidate.opinionId === opinionId) &&
        legalSourceQuoteMatchesBlock(candidate.document, quote),
    ),
  );
  if (resolved.some((matches) => matches.length !== 1)) {
    return { valid: false, pin: null };
  }
  const selected = resolved.map((matches) => matches[0]);
  if (new Set(selected.map(({ opinionId }) => opinionId)).size !== 1) {
    return { valid: true, pin: null };
  }
  const block = smallestBlockContainingQuotes(
    selected[0].document,
    citation.quotes.map(({ quote }) => quote),
  );
  return { valid: true, pin: block ? pinpointFor(block) : null };
}

function publicLegalCitationPinpoint(
  citation: ParsedPublicLegalCitation,
  state?: PublicLegalSourceState,
) {
  if (!state || !citation.quotes.length) return null;
  const document = getPublicLegalCitationDocument(citation, state);
  if (!document) return null;
  const quotes = citation.quotes.map(({ quote }) => quote);
  const matches = new Map<string, Pick<SourceDocBlock, "kind" | "label">>();
  for (const evidence of state.lookups) {
    if (evidence.document !== document) continue;
    for (const block of [
      evidence.lookup.block,
      ...evidence.lookup.before,
      ...evidence.lookup.after,
    ]) {
      if (
        block &&
        quotes.every((quote) => legalSourceQuoteMatchesBlock(block.text, quote))
      ) {
        matches.set(`${block.kind}:${block.label}`, block);
      }
    }
  }
  return matches.size === 1 ? pinpointFor([...matches.values()][0]) : null;
}

export function createCitation(
  citation: ParsedCitation,
  docIndex: DocIndex,
  casesByClusterId?: CasesByClusterId,
  a2ajLookups: A2AJLocatorLookup[] = [],
  a2ajDocuments: A2AJDocument[] = [],
  publicLegalState?: PublicLegalSourceState,
) {
  if (citation.kind === "public_legal") {
    const document = getPublicLegalCitationDocument(citation, publicLegalState);
    const pin = publicLegalCitationPinpoint(citation, publicLegalState);
    return {
      type: "citation_data",
      kind: "public_legal",
      ref: citation.ref,
      provider: citation.provider,
      identifier: document?.identity ?? citation.identifier,
      title: document?.title ?? null,
      citation: document?.citation ?? null,
      url: buildPublicLegalCitationUrl(citation, publicLegalState),
      external_url: document?.url ?? null,
      quotes: citation.quotes,
      ...(pin ?? {}),
    };
  }
  if (citation.kind === "a2aj") {
    const pin = a2ajCitationPinpoint(citation, a2ajLookups);
    return {
      type: "citation_data",
      kind: "a2aj",
      ref: citation.ref,
      citation: citation.citation,
      name: citation.name,
      dataset: citation.dataset,
      url: buildA2AJCitationPinpointUrl(citation, a2ajLookups, a2ajDocuments),
      external_url: citation.url,
      quotes: citation.quotes,
      ...(pin ?? {}),
    };
  }
  if (citation.kind === "case") {
    const caseRecord = casesByClusterId?.get(citation.cluster_id);
    const support = courtlistenerCitationSupport(citation, caseRecord);
    return {
      type: "citation_data",
      kind: "case",
      ref: citation.ref,
      cluster_id: citation.cluster_id,
      case_name: caseRecord?.caseName ?? null,
      citation: caseRecord?.citations[0] ?? null,
      url: buildCourtlistenerCitationPinpointUrl(citation, caseRecord),
      external_url: caseRecord?.url ?? null,
      verified: support.valid,
      pdfUrl: caseRecord?.pdfUrl ?? null,
      dateFiled: caseRecord?.dateFiled ?? null,
      quotes: citation.quotes,
      ...(support.pin ?? {}),
    };
  }

  const docInfo = resolveDoc(citation.doc_id, docIndex);
  return {
    type: "citation_data",
    kind: "document",
    ref: citation.ref,
    doc_id: citation.doc_id,
    document_id: docInfo?.document_id,
    version_id: docInfo?.version_id ?? null,
    version_number: docInfo?.version_number ?? null,
    filename: docInfo?.filename ?? citation.doc_id,
    page: citation.page,
    quote: citation.quote,
    sheet: citation.sheet,
    cell: citation.cell,
    quotes: citation.quotes,
  };
}

/** Structured citation records fail closed when their named source did not verify. */
export function isResolvedCitation(value: unknown): boolean {
  const citation = value as {
    kind?: unknown;
    document_id?: unknown;
    url?: unknown;
    verified?: unknown;
  } | null;
  if (!citation) return false;
  if (!citation.kind || citation.kind === "document") {
    return (
      typeof citation.document_id === "string" &&
      citation.document_id.length > 0
    );
  }
  return (
    citation.verified !== false &&
    typeof citation.url === "string" &&
    citation.url.length > 0
  );
}

function receiptLocator(receipt: LegalEvidenceReceipt) {
  const { kind, label } = receipt.locator;
  return kind === "document" ? {} : pinpointFor({ kind, label });
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

function receiptAnchor(receipt: LegalEvidenceReceipt) {
  if (receipt.locator.kind === "paragraph") {
    const number = receipt.locator.label.match(/^par(\d+)/iu)?.[1];
    return number ? `par${Number(number)}` : undefined;
  }
  if (receipt.locator.kind === "section") {
    return receipt.locator.label.match(/^sec[\w.-]+/iu)?.[0];
  }
  if (receipt.locator.kind === "page") {
    const number = receipt.locator.label.match(/(?:page=?|^)(\d+)/iu)?.[1];
    return number ? `page=${Number(number)}` : undefined;
  }
  return undefined;
}

function durableA2AJUrl(receipt: LegalEvidenceReceipt, quotes: string[]) {
  const sourceUrl =
    (receipt.source_class === "case"
      ? buildCanliiCaseUrl({
          dataset: receipt.dataset,
          citations: [receipt.citation],
          language: receipt.language,
        })
      : null) ?? receipt.external_url;
  if (!sourceUrl || !receipt.span_text) return sourceUrl;
  return buildLegalSourcePinpointUrl(
    {
      url: sourceUrl,
      anchor: receiptAnchor(receipt),
      blockText: receipt.span_text,
    },
    quotes,
  );
}

/**
 * Project the existing strict evidence-id submission into the same citation
 * events used by document, CourtListener, A2AJ, and public-source JSON.
 */
export function createLegalEvidenceCitations(
  state: LegalEvidenceTurnState,
): Record<string, unknown>[] {
  return legalEvidenceCitationEntries(state).flatMap<Record<string, unknown>>(
    ({ ref, receipt, lookup, document }) => {
      const quote = receipt.span_text;
      if (!quote) return [];
      const quotes = tailoredReceiptQuotes(
        state,
        receipt.evidence_id,
        quote,
      );
      if (receipt.provider === "library") {
        return [{
          type: "citation_data" as const,
          kind: "document" as const,
          ref,
          doc_id: receipt.stable_source_id,
          document_id: receipt.stable_source_id,
          version_id: receipt.version,
          filename: receipt.name ?? receipt.citation,
          quotes: quotes.map((quote) => ({ quote })),
        }];
      }
      if (receipt.provider === "a2aj") {
        const built = createCitation(
          {
            kind: "a2aj",
            ref,
            citation: receipt.citation,
            name: receipt.name,
            dataset: receipt.dataset,
            url: receipt.external_url,
            quotes: quotes.map((quote) => ({ quote })),
          },
          {},
          undefined,
          lookup ? [lookup] : [],
          document ? [document] : [],
        );
        return [{
          ...built,
          url:
            ("url" in built ? built.url : null) ??
            durableA2AJUrl(receipt, quotes),
          source_class: receipt.source_class,
          ...receiptLocator(receipt),
        }];
      }
      if (receipt.provider === "journal") {
        const identifier = receipt.stable_source_id.startsWith("journal:")
          ? receipt.stable_source_id.slice("journal:".length)
          : receipt.stable_source_id;
        return [{
          type: "citation_data" as const,
          kind: "public_legal" as const,
          ref,
          provider: "journal" as const,
          identifier,
          title: receipt.name,
          citation: receipt.citation,
          url: receipt.external_url,
          external_url: receipt.external_url,
          source_class: receipt.source_class,
          quotes: quotes.map((quote) => ({ quote })),
          ...receiptLocator(receipt),
        }];
      }
      if (receipt.provider !== "citator") return [];
      return [{
        type: "citation_data" as const,
        kind: "a2aj" as const,
        ref,
        citation: receipt.citation,
        name: receipt.name,
        dataset: receipt.dataset,
        url: receipt.external_url,
        external_url: receipt.external_url,
        source_class: receipt.source_class,
        quotes: quotes.map((quote) => ({ quote })),
        ...receiptLocator(receipt),
      }];
    },
  );
}
