import type { A2AJLocatorKind } from "../a2ajStructure";
import { buildLegalSourcePinpointUrl } from "../legalSourceLinks";
import {
  fetchGovInfoCase,
  fetchGovUkEtCase,
  fetchTnaCase,
  lookupPublicLegalSource,
  searchGovInfoCase,
  searchGovUkEtCase,
  searchTnaCase,
  type PublicLegalDocument,
  type PublicLegalLookup,
} from "../publicLegalSources";
import { PUBLIC_LEGAL_SOURCE_TOOL_NAMES } from "./tools/publicLegalSourceTools";

export type PublicLegalProvider = "tna" | "govuk-et" | "govinfo";

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
  return value === "tna" || value === "govuk-et" || value === "govinfo"
    ? value
    : null;
}

function normalized(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function key(source: PublicLegalProvider, identifier: string) {
  return `${source}:${normalized(identifier)}`;
}

async function fetchExact(
  source: PublicLegalProvider,
  identifier: string,
): Promise<PublicLegalDocument | null> {
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

function safeDocument(document: PublicLegalDocument) {
  const maxChars = 300_000;
  return {
    ok: true,
    source: "Public legal source",
    provider: document.provider,
    identifier: document.identity,
    title: document.title,
    text: document.text.slice(0, maxChars),
    truncated: document.text.length > maxChars,
    structure: {
      status: document.structure.status,
      source: document.structure.source,
      counts: document.structure.counts,
    },
    attachments: document.attachments.map((attachment) => ({
      title: attachment.title,
      content_type: attachment.contentType,
      filename: attachment.filename,
      page_count: attachment.pageCount,
    })),
    next_required_action:
      "Quote only returned text. Mike attaches the verified source URL.",
  };
}

export async function executePublicLegalSourceTool(
  name: string,
  args: Record<string, unknown>,
  state: PublicLegalSourceState,
): Promise<Record<string, unknown> | null> {
  if (
    name !== PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch &&
    name !== PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup
  ) {
    return null;
  }
  const source = provider(args.provider);
  const identifier =
    typeof args.identifier === "string" ? args.identifier.trim() : "";
  if (!source || !identifier) {
    return {
      ok: false,
      error: "A supported provider and exact identifier are required.",
    };
  }
  try {
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
    if (name === PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch) {
      return safeDocument(document);
    }

    const kind: A2AJLocatorKind =
      args.locator_type === "page"
        ? "page"
        : args.locator_type === "section"
          ? "section"
          : "paragraph";
    const locator = typeof args.locator === "string" ? args.locator.trim() : "";
    if (!locator) {
      return { ok: false, error: "locator is required." };
    }
    const lookup = lookupPublicLegalSource(
      document,
      kind,
      locator,
      typeof args.context_blocks === "number" ? args.context_blocks : 0,
    );
    if (lookup.status === "found" && lookup.block) {
      state.lookups.push({ document, lookup });
    }
    return {
      ok: lookup.status === "found",
      source: "Public legal source",
      provider: source,
      identifier: document.identity,
      requested: { kind, locator },
      status: lookup.status,
      matches: lookup.matches,
      block: safeBlock(lookup.block),
      before: lookup.before.map(safeBlock),
      after: lookup.after.map(safeBlock),
      structure: {
        source: document.structure.source,
        counts: document.structure.counts,
      },
      next_required_action:
        "Quote only returned text. Mike attaches the verified source URL and pinpoint.",
    };
  } catch (error) {
    return {
      ok: false,
      source: "Public legal source",
      provider: source,
      identifier,
      error:
        error instanceof Error
          ? error.message
          : "Public legal source request failed.",
    };
  }
}

function words(value: string) {
  return (
    value.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []
  );
}

function containsQuote(source: string, quote: string) {
  const haystack = words(source);
  const needle = words(quote);
  if (!needle.length) return false;
  return haystack.some((_, start) =>
    needle.every((word, offset) => haystack[start + offset] === word),
  );
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
  if (
    !document ||
    !citation.quotes.length ||
    !citation.quotes.every(({ quote }) => containsQuote(document.text, quote))
  ) {
    return null;
  }
  const candidates = state.lookups.filter(
    ({ document: candidate, lookup }) =>
      candidate === document &&
      lookup.block &&
      citation.quotes.every(({ quote }) =>
        containsQuote(lookup.block!.text, quote),
      ),
  );
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
          documentText: document.text,
          pageScoped: evidence.lookup.block!.kind === "page",
        }
      : {
          url: document.url,
          blockText: document.text,
          documentText: document.text,
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
