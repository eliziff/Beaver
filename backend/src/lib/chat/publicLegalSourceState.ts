import {
  fetchJournalArticle,
  lookupJournalArticle,
  searchJournalArticles,
} from "../journalArticles";
import {
  appendLegalSourcePinpointLinks,
  buildLegalSourcePinpointUrl,
  formatLegalLocator,
} from "../legalSourceLinks";
import {
  createTextSourceDoc,
  sourceDocContainsQuote,
  type SourceDocLocatorKind,
} from "../sourceDoc";
import { summarizeLegalSourceDoc } from "../sourceDocNativeMarkup";
import {
  fetchGovInfoCase,
  fetchGovUkEtCase,
  fetchTnaCase,
  lookupPublicLegalSource,
  persistPublicLegalEvidence,
  rehydratePublicLegalEvidence,
  searchGovInfoCase,
  searchGovUkEtCase,
  searchTnaCase,
  type PublicLegalEvidenceReceipt,
  type PublicLegalDocument,
  type PublicLegalLookup,
} from "../publicLegalSources";
import {
  queueProviderPdfAttachment,
  type ProviderPdfQueueResult,
} from "../providerPdfLibraryBridge";
import { PUBLIC_LEGAL_SOURCE_TOOL_NAMES } from "./tools/publicLegalSourceTools";

export type PublicLegalProvider = "tna" | "govuk-et" | "govinfo" | "journal";

export type PublicLegalEvidence = {
  document: PublicLegalDocument;
  lookup: PublicLegalLookup;
};

export type PublicLegalSourceState = {
  documents: Map<string, PublicLegalDocument>;
  lookups: PublicLegalEvidence[];
};

export type PublicLegalCitationIdentity = {
  provider: PublicLegalProvider;
  identifier: string;
  quotes: { quote: string }[];
};

export function createPublicLegalSourceState(): PublicLegalSourceState {
  return { documents: new Map(), lookups: [] };
}

function provider(value: unknown): PublicLegalProvider | null {
  return value === "tna" ||
    value === "govuk-et" ||
    value === "govinfo" ||
    value === "journal"
    ? value
    : null;
}

function normalized(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function key(source: PublicLegalProvider, identifier: string) {
  return `${source}:${normalized(identifier)}`;
}

function pdfProvider(
  value: PublicLegalProvider,
): value is Exclude<PublicLegalProvider, "journal"> {
  return value !== "journal";
}

async function fetchExact(
  source: PublicLegalProvider,
  identifier: string,
): Promise<PublicLegalDocument | null> {
  if (source === "journal") {
    const article = fetchJournalArticle(identifier);
    return article
      ? {
          provider: "journal",
          identity: article.identity,
          title: article.title,
          url: article.url,
          text: article.text,
          structure: article.structure,
          attachments: [],
        }
      : null;
  }
  if (source === "tna") {
    const match = await searchTnaCase(identifier);
    return match ? fetchTnaCase(match) : null;
  }
  if (source === "govuk-et") {
    const match = await searchGovUkEtCase(identifier);
    return match ? fetchGovUkEtCase(match) : null;
  }
  const match = await searchGovInfoCase(identifier);
  return match ? fetchGovInfoCase(match) : null;
}

async function documentFor(
  state: PublicLegalSourceState,
  source: PublicLegalProvider,
  identifier: string,
) {
  const cacheKey = key(source, identifier);
  const cached = state.documents.get(cacheKey);
  if (cached) return cached;
  const document = await fetchExact(source, identifier);
  if (document) {
    state.documents.set(cacheKey, document);
    state.documents.set(key(source, document.identity), document);
  }
  return document;
}

function safeBlock(
  block: PublicLegalLookup["block"] | PublicLegalLookup["before"][number],
) {
  return block ? { ...block, anchor: undefined } : block;
}

function pdfAttachments(document: PublicLegalDocument) {
  const unique = new Map<string, PublicLegalDocument["attachments"][number]>();
  for (const attachment of document.attachments) {
    try {
      const url = new URL(attachment.url);
      url.hash = "";
      const pathname = url.pathname.toLowerCase();
      const isPdf =
        attachment.contentType?.toLowerCase().split(";", 1)[0] ===
          "application/pdf" ||
        attachment.filename?.toLowerCase().endsWith(".pdf") ||
        pathname.endsWith(".pdf") ||
        pathname.endsWith("/pdf");
      if (isPdf && !unique.has(url.toString())) {
        unique.set(url.toString(), attachment);
      }
    } catch {
      // Invalid optional attachments are ignored.
    }
  }
  return [...unique.values()];
}

async function pdfFallbacksFor(document: PublicLegalDocument, userId?: string) {
  const provider = document.provider;
  if (
    !userId ||
    !pdfProvider(provider) ||
    summarizeLegalSourceDoc(document.structure).source !== "flat_text"
  ) {
    return [];
  }
  return (
    await Promise.all(
      pdfAttachments(document).map(async (attachment) => {
        try {
          const queued = await queueProviderPdfAttachment({
            provider,
            identity: document.identity,
            structureSource: "flat_text",
            url: attachment.url,
            canonicalUrl: document.url,
            filename: attachment.filename,
            title: attachment.title || document.title,
          });
          return queued
            ? {
                ...queued,
                attachment_title: attachment.title || document.title,
                attachment_filename: attachment.filename,
              }
            : null;
        } catch {
          return null;
        }
      }),
    )
  ).filter((item): item is NonNullable<typeof item> => item !== null);
}

function safeDocument(
  document: PublicLegalDocument,
  pdfFallbacks: ProviderPdfQueueResult[],
) {
  const maxChars = 300_000;
  return {
    ok: true,
    source: "Public legal source",
    provider: document.provider,
    identifier: document.identity,
    title: document.title,
    text: document.text.slice(0, maxChars),
    truncated: document.text.length > maxChars,
    structure: summarizeLegalSourceDoc(document.structure),
    attachments: document.attachments.map((attachment) => ({
      title: attachment.title,
      content_type: attachment.contentType,
      filename: attachment.filename,
      page_count: attachment.pageCount,
    })),
    pdf_fallbacks: pdfFallbacks,
    // Quote-only and URL handling are prompt rules; only the queue state is new.
    ...(pdfFallbacks.length > 0
      ? {
          next_required_action:
            "The provider PDF is queued for shared-cache parsing; it is not readable yet.",
        }
      : {}),
  };
}

function safeLookup(
  document: PublicLegalDocument,
  lookup: PublicLegalLookup,
  kind: SourceDocLocatorKind,
  locator: string,
  pdfFallbacks: ProviderPdfQueueResult[],
  receipt: PublicLegalEvidenceReceipt | null,
) {
  const summary = summarizeLegalSourceDoc(document.structure);
  return {
    ok: lookup.status === "found",
    source: "Public legal source",
    provider: document.provider,
    identifier: document.identity,
    requested: { kind, locator },
    hit_id: `${document.provider}:${document.identity}:${kind}:${lookup.block?.label ?? lookup.requestedLabel}`,
    status: lookup.status,
    matches: lookup.matches,
    block: safeBlock(lookup.block),
    before: lookup.before.map(safeBlock),
    after: lookup.after.map(safeBlock),
    structure: { source: summary.source, counts: summary.counts },
    ...(receipt
      ? {
          evidence: {
            handle: receipt.handle,
            source_sha256: receipt.source.source_sha256,
            locator_kind: receipt.lookup.locator_kind,
            text_sha256: receipt.evidence.block_text_sha256,
          },
        }
      : {}),
    pdf_fallbacks: pdfFallbacks,
  };
}

export async function executePublicLegalSourceTool(
  name: string,
  args: Record<string, unknown>,
  state: PublicLegalSourceState,
  userId?: string,
): Promise<Record<string, unknown> | null> {
  if (
    name !== PUBLIC_LEGAL_SOURCE_TOOL_NAMES.search &&
    name !== PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch &&
    name !== PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup
  ) {
    return null;
  }
  const source = provider(args.provider);
  if (name === PUBLIC_LEGAL_SOURCE_TOOL_NAMES.search) {
    if (source !== "journal") {
      return {
        ok: false,
        error: "Candidate search currently supports provider journal.",
      };
    }
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { ok: false, error: "query is required." };
    try {
      return {
        ok: true,
        source: "Public legal source",
        provider: source,
        results: searchJournalArticles(
          query,
          typeof args.size === "number" ? args.size : 10,
        ).map(({ url: _url, articleId, hitId, ...match }) => ({
          ...match,
          article_id: articleId,
          hit_id: hitId,
        })),
      };
    } catch (error) {
      return {
        ok: false,
        source: "Public legal source",
        provider: source,
        error: error instanceof Error ? error.message : "Search failed.",
      };
    }
  }
  const identifier =
    typeof args.identifier === "string" ? args.identifier.trim() : "";
  if (!source || !identifier) {
    return {
      ok: false,
      error: "A supported provider and exact identifier are required.",
    };
  }
  const evidenceHandle =
    typeof args.evidence_handle === "string"
      ? args.evidence_handle.trim()
      : "";
  try {
    if (name === PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup && evidenceHandle) {
      const restored = await rehydratePublicLegalEvidence(evidenceHandle);
      if (
        restored.document.provider !== source ||
        key(source, restored.document.identity) !== key(source, identifier)
      ) {
        return {
          ok: false,
          source: "Public legal source",
          provider: source,
          identifier,
          error:
            "Provider evidence does not belong to the requested source identifier.",
        };
      }
      state.documents.set(key(source, identifier), restored.document);
      state.documents.set(
        key(source, restored.document.identity),
        restored.document,
      );
      state.lookups.push({
        document: restored.document,
        lookup: restored.lookup,
      });
      return safeLookup(
        restored.document,
        restored.lookup,
        restored.receipt.lookup.locator_kind,
        restored.receipt.lookup.locator,
        [],
        restored.receipt,
      );
    }
    const document = await documentFor(state, source, identifier);
    if (!document) {
      return {
        ok: false,
        source: "Public legal source",
        provider: source,
        identifier,
        error: "No unique exact provider match was found.",
      };
    }
    const pdfFallbacks = await pdfFallbacksFor(document, userId);
    if (name === PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch) {
      return safeDocument(document, pdfFallbacks);
    }

    const kind: SourceDocLocatorKind =
      args.locator_type === "footnote"
        ? "footnote"
        : args.locator_type === "page"
          ? "page"
          : args.locator_type === "section"
            ? "section"
            : "paragraph";
    const locator = typeof args.locator === "string" ? args.locator.trim() : "";
    if (!locator) {
      return { ok: false, error: "locator is required." };
    }
    const lookup =
      source === "journal"
        ? lookupJournalArticle(
            fetchJournalArticle(document.identity)!,
            kind,
            locator,
            typeof args.context_blocks === "number" ? args.context_blocks : 0,
          )
        : lookupPublicLegalSource(
            document,
            kind,
            locator,
            typeof args.context_blocks === "number" ? args.context_blocks : 0,
          );
    if (lookup.status === "found" && lookup.block) {
      state.lookups.push({ document, lookup });
    }
    if ("hitId" in lookup) {
      return {
        ...safeLookup(document, lookup, kind, locator, pdfFallbacks, null),
        hit_id: lookup.hitId,
      };
    }
    const evidence =
      lookup.status === "found"
        ? await persistPublicLegalEvidence(
            document,
            lookup,
            typeof args.context_blocks === "number" ? args.context_blocks : 0,
          )
        : null;
    return safeLookup(document, lookup, kind, locator, pdfFallbacks, evidence);
  } catch (error) {
    return {
      ok: false,
      source: "Public legal source",
      provider: source,
      identifier,
      error:
        evidenceHandle
          ? "Provider evidence is unavailable or failed integrity verification."
          : error instanceof Error
          ? error.message
          : "Public legal source request failed.",
    };
  }
}

function citedDocument(
  state: PublicLegalSourceState,
  citation: PublicLegalCitationIdentity,
) {
  return state.documents.get(key(citation.provider, citation.identifier));
}

export function buildPublicLegalCitationUrl(
  citation: PublicLegalCitationIdentity,
  state?: PublicLegalSourceState,
) {
  if (!state) return null;
  const document = citedDocument(state, citation);
  if (!document || !citation.quotes.length) return null;
  const compiled = createTextSourceDoc(document.text);
  if (
    !citation.quotes.every(({ quote }) =>
      sourceDocContainsQuote(compiled, quote),
    )
  ) {
    return null;
  }
  const candidates = state.lookups.filter(({ document: candidate, lookup }) => {
    if (candidate !== document || !lookup.block) return false;
    const block = createTextSourceDoc(lookup.block.text);
    return citation.quotes.every(({ quote }) =>
      sourceDocContainsQuote(block, quote),
    );
  });
  const unique = new Map(
    candidates.map((evidence) => [
      [
        evidence.lookup.block?.kind,
        evidence.lookup.block?.label,
        evidence.lookup.anchor,
      ].join("|"),
      evidence,
    ]),
  );
  const evidence = unique.size === 1 ? [...unique.values()][0] : undefined;
  return buildLegalSourcePinpointUrl(
    evidence
      ? {
          url: document.url,
          anchor: evidence.lookup.anchor ?? undefined,
          blockText: evidence.lookup.block!.text,
          documentText: compiled,
          pageScoped: evidence.lookup.block!.kind === "page",
        }
      : { url: document.url, blockText: compiled, documentText: compiled },
    citation.quotes.map(({ quote }) => quote),
  );
}

export function getPublicLegalCitationDocument(
  citation: PublicLegalCitationIdentity,
  state?: PublicLegalSourceState,
) {
  return state ? (citedDocument(state, citation) ?? null) : null;
}

export function appendPublicLegalPinpointLinks(
  answer: string,
  state: PublicLegalSourceState,
  existingUrls: string[] = [],
) {
  return appendLegalSourcePinpointLinks(
    answer,
    state.lookups.flatMap(({ document, lookup }) =>
      [lookup.block, ...lookup.before, ...lookup.after].flatMap((block) =>
        block
          ? [
              {
                key: [
                  document.provider,
                  document.identity,
                  block.kind,
                  block.label,
                  block.anchor ?? "",
                ].join("|"),
                label: `${document.title || document.identity}, ${formatLegalLocator(block.kind, block.label)}`,
                evidence: {
                  url: document.url,
                  anchor:
                    block.anchor ??
                    (block === lookup.block
                      ? (lookup.anchor ?? undefined)
                      : undefined),
                  blockText: block.text,
                  documentText: document.text,
                  pageScoped: block.kind === "page",
                },
              },
            ]
          : [],
      ),
    ),
    existingUrls,
  );
}
