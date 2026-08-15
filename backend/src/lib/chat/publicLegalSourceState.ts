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
import {
  createPublicJournalDocumentEvidence,
  createPublicJournalPassageEvidence,
  type LegalEvidenceReceipt,
} from "./legalEvidence";
import { PUBLIC_LEGAL_SOURCE_TOOL_NAMES } from "./tools/publicLegalSourceTools";
import { resourceReference } from "../resourceReferences";

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
          citation: article.citation,
          date: article.date,
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
                resource: resourceReference.source("pdf", queued.reference_id),
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
    // TNA marks every recognized citation up as <ref uk:canonical>; the
    // provider's own list beats re-mining the text (structural-richness
    // survey 2026-07-29, finding 3). Absent for providers without it.
    ...(document.citedAuthorities?.length
      ? {
          cited_authorities: document.citedAuthorities
            .slice(0, 60)
            .map((ref) => ({
              citation: ref.citation,
              canonical: ref.canonical,
              type: ref.type,
            })),
        }
      : {}),
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
): Promise<{
  payload: Record<string, unknown>;
  evidences?: LegalEvidenceReceipt[];
} | null> {
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
        payload: {
          ok: false,
          error: "Candidate search currently supports provider journal.",
        },
      };
    }
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query)
      return { payload: { ok: false, error: "query is required." } };
    try {
      return {
        payload: {
          ok: true,
          source: "Public legal source",
          provider: source,
          results: searchJournalArticles(
            query,
            typeof args.size === "number" ? args.size : 10,
          ).map(({ url: _url, articleId, hitId: _hitId, ...match }) => ({
            ...match,
            article_id: articleId,
          })),
        },
      };
    } catch (error) {
      return {
        payload: {
          ok: false,
          source: "Public legal source",
          provider: source,
          error: error instanceof Error ? error.message : "Search failed.",
        },
      };
    }
  }
  const identifier =
    typeof args.identifier === "string" ? args.identifier.trim() : "";
  if (!source || !identifier) {
    return {
      payload: {
        ok: false,
        error: "A supported provider and exact identifier are required.",
      },
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
          payload: {
            ok: false,
            source: "Public legal source",
            provider: source,
            identifier,
            error:
              "Provider evidence does not belong to the requested source identifier.",
          },
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
      return {
        payload: safeLookup(
          restored.document,
          restored.lookup,
          restored.receipt.lookup.locator_kind,
          restored.receipt.lookup.locator,
          [],
          restored.receipt,
        ),
      };
    }
    const document = await documentFor(state, source, identifier);
    if (!document) {
      return {
        payload: {
          ok: false,
          source: "Public legal source",
          provider: source,
          identifier,
          error: "No unique exact provider match was found.",
        },
      };
    }
    const pdfFallbacks = await pdfFallbacksFor(document, userId);
    if (name === PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch) {
      const payload = safeDocument(document, pdfFallbacks);
      if (source === "journal" && document.citation) {
        // The pulled article becomes a registered, citeable passage receipt
        // (parity with a2aj_fetch for citing cases). The model sees the
        // evidence_id in the visible payload; the receipt's span is the
        // article text it just read, so verbatim quotes verify against it.
        const receipt = createPublicJournalDocumentEvidence({
          citation: document.citation,
          name: document.title,
          date: document.date ?? null,
          url: document.url || null,
          text: payload.text,
          articleId: document.identity,
        });
        return {
          payload: {
            ...payload,
            evidence_id: receipt.evidence_id,
            citation: document.citation,
            date: document.date,
          },
          evidences: [receipt],
        };
      }
      return { payload };
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
      return { payload: { ok: false, error: "locator is required." } };
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
      // Journal lookups surface the looked-up passage as a registered,
      // citeable evidence_id (the span is the block the model just read) —
      // never a non-citeable "hit_id" that submit_grounded_answer cannot
      // resolve.
      const base = safeLookup(document, lookup, kind, locator, pdfFallbacks, null);
      if (
        lookup.status === "found" &&
        lookup.block &&
        source === "journal" &&
        document.citation
      ) {
        const receipt = createPublicJournalPassageEvidence({
          citation: document.citation,
          name: document.title,
          date: document.date ?? null,
          url: document.url || null,
          text: lookup.block.text,
          articleId: document.identity,
          locatorKind: kind,
          locatorLabel: lookup.block.label,
        });
        return {
          payload: { ...base, evidence_id: receipt.evidence_id },
          evidences: [receipt],
        };
      }
      return { payload: base };
    }
    const evidence =
      lookup.status === "found"
        ? await persistPublicLegalEvidence(
            document,
            lookup,
            typeof args.context_blocks === "number" ? args.context_blocks : 0,
          )
        : null;
    return {
      payload: safeLookup(document, lookup, kind, locator, pdfFallbacks, evidence),
    };
  } catch (error) {
    return {
      payload: {
        ok: false,
        source: "Public legal source",
        provider: source,
        identifier,
        error:
          evidenceHandle
            ? // The superseded-schema refusal is typed, path-free, and tells
            // the model the right recovery (re-run the lookup); every other
            // evidence failure stays behind the generic message so local
            // paths never leak.
            error instanceof Error &&
            error.message.includes("superseded v1 structure schema")
            ? error.message
            : "Provider evidence is unavailable or failed integrity verification."
          : error instanceof Error
          ? error.message
          : "Public legal source request failed.",
      },
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
  if (
    !citation.quotes.every(({ quote }) =>
      sourceDocContainsQuote(document.structure, quote),
    )
  ) {
    return null;
  }
  const candidates = state.lookups.filter(({ document: candidate, lookup }) => {
    if (candidate !== document || !lookup.block) return false;
    return citation.quotes.every(({ quote }) =>
      sourceDocContainsQuote(document.structure, quote, lookup.block!),
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
          documentText: document.structure,
          pageScoped: evidence.lookup.block!.kind === "page",
        }
      : {
          url: document.url,
          blockText: document.structure,
          documentText: document.structure,
        },
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
                  documentText: document.structure,
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
