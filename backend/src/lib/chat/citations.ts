import { type DocIndex, resolveDoc } from "./types";
import type { A2AJDocument, A2AJLocatorLookup } from "../a2aj";
import {
  buildA2AJCitationPinpointUrl,
  buildCourtlistenerCitationPinpointUrl,
  formatLegalLocator,
  legalSourceQuoteMatchesBlock,
} from "../legalSourceLinks";
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

function normalizeCitation(raw: unknown): ParsedCitation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const markerRef =
    typeof c.marker === "string"
      ? Number(c.marker.match(/^\[(\d+)\]$/)?.[1])
      : NaN;
  const ref =
    typeof c.ref === "number"
      ? c.ref
      : Number.isFinite(markerRef)
        ? markerRef
        : null;
  if (typeof ref !== "number") return null;
  const quote = typeof c.quote === "string" ? c.quote : c.text;

  if (c.source === "public_legal" || c.kind === "public_legal") {
    const provider =
      c.provider === "tna" ||
      c.provider === "govuk-et" ||
      c.provider === "govinfo" ||
      c.provider === "journal"
        ? c.provider
        : null;
    const identifier =
      typeof c.identifier === "string" && c.identifier.trim()
        ? c.identifier.trim()
        : null;
    const quotes = Array.isArray(c.quotes)
      ? c.quotes
          .slice(0, 3)
          .map((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
              return null;
            const value = (raw as Record<string, unknown>).quote;
            return typeof value === "string" && value.trim()
              ? { quote: value }
              : null;
          })
          .filter((value): value is { quote: string } => !!value)
      : [];
    if (!quotes.length && typeof quote === "string" && quote.trim()) {
      quotes.push({ quote });
    }
    if (!provider || !identifier || !quotes.length) return null;
    return {
      kind: "public_legal",
      ref,
      provider,
      identifier,
      quotes,
    };
  }

  if (c.source === "a2aj" || c.kind === "a2aj") {
    const citation =
      typeof c.citation === "string" && c.citation.trim()
        ? c.citation.trim()
        : null;
    const quotes = Array.isArray(c.quotes)
      ? c.quotes
          .slice(0, 3)
          .map((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
              return null;
            const value = (raw as Record<string, unknown>).quote;
            return typeof value === "string" && value.trim()
              ? { quote: value }
              : null;
          })
          .filter((value): value is { quote: string } => !!value)
      : [];
    if (!quotes.length && typeof quote === "string" && quote.trim()) {
      quotes.push({ quote });
    }
    if (!quotes.length) return null;
    return {
      kind: "a2aj",
      ref,
      citation,
      name: typeof c.name === "string" ? c.name : null,
      dataset: typeof c.dataset === "string" ? c.dataset : null,
      url: typeof c.url === "string" ? c.url : null,
      quotes,
    };
  }

  const rawClusterId =
    typeof c.cluster_id === "number"
      ? c.cluster_id
      : typeof c.clusterId === "number"
        ? c.clusterId
        : typeof c.cluster_id === "string"
          ? Number.parseInt(c.cluster_id, 10)
          : typeof c.clusterId === "string"
            ? Number.parseInt(c.clusterId, 10)
            : NaN;
  if (Number.isFinite(rawClusterId) && rawClusterId > 0) {
    const quotes = normalizeCaseCitationQuotes(c);
    if (!quotes.length) {
      if (typeof quote !== "string" || !quote) return null;
      quotes.push({ opinionId: null, type: null, author: null, quote });
    }
    return { kind: "case", ref, cluster_id: Math.floor(rawClusterId), quotes };
  }

  if (typeof c.doc_id !== "string") return null;
  const quotes = normalizeDocumentCitationQuotes(c);
  if (!quotes.length) {
    if (typeof quote !== "string" || !quote) return null;
    quotes.push({
      page: normalizeCitationPage(c.page),
      quote,
      ...normalizeCellLocator(c),
    });
  }
  return {
    kind: "document",
    ref,
    doc_id: c.doc_id,
    page: quotes[0].page,
    quote: quotes[0].quote,
    sheet: quotes[0].sheet,
    cell: quotes[0].cell,
    quotes,
  };
}

/** Pull an optional spreadsheet `{sheet, cell}` locator off a raw object. */
function normalizeCellLocator(c: Record<string, unknown>): {
  sheet?: string;
  cell?: string;
} {
  const out: { sheet?: string; cell?: string } = {};
  if (typeof c.sheet === "string" && c.sheet.trim()) out.sheet = c.sheet.trim();
  if (typeof c.cell === "string" && c.cell.trim()) out.cell = c.cell.trim();
  return out;
}

function normalizeCitationPage(value: unknown): number | string {
  if (typeof value === "number") {
    return value;
  } else if (typeof value === "string" && /^\d+\s*-\s*\d+$/.test(value)) {
    return value;
  } else {
    const n = parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n)) return 1;
    return n;
  }
}

function normalizeDocumentCitationQuotes(
  c: Record<string, unknown>,
): DocumentQuote[] {
  if (!Array.isArray(c.quotes)) return [];
  return c.quotes
    .slice(0, 3)
    .map((raw): DocumentQuote | null => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const text = typeof row.quote === "string" ? row.quote : row.text;
      if (typeof text !== "string" || !text.trim()) return null;
      // Fall back to the top-level sheet/cell so a citation can set them once.
      return {
        page: normalizeCitationPage(row.page ?? c.page),
        quote: text,
        ...normalizeCellLocator({
          sheet: row.sheet ?? c.sheet,
          cell: row.cell ?? c.cell,
        }),
      };
    })
    .filter((quote): quote is DocumentQuote => !!quote);
}

function normalizeCaseCitationQuotes(c: Record<string, unknown>) {
  if (!Array.isArray(c.quotes)) return [];
  return c.quotes
    .slice(0, 3)
    .map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const text = typeof row.quote === "string" ? row.quote : row.text;
      if (typeof text !== "string" || !text.trim()) return null;
      const opinionId =
        typeof row.opinion_id === "number" && Number.isFinite(row.opinion_id)
          ? Math.floor(row.opinion_id)
          : typeof row.opinionId === "number" && Number.isFinite(row.opinionId)
            ? Math.floor(row.opinionId)
            : null;
      return {
        opinionId,
        type: typeof row.type === "string" ? row.type : null,
        author: typeof row.author === "string" ? row.author : null,
        quote: text,
      };
    })
    .filter(
      (
        quote,
      ): quote is {
        opinionId: number | null;
        type: string | null;
        author: string | null;
        quote: string;
      } => !!quote,
    );
}

// ---------------------------------------------------------------------------
// Citation block constants and parsers
// ---------------------------------------------------------------------------

export const CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;
export const CITATIONS_OPEN_TAG = "<CITATIONS>";
export const CITATIONS_CLOSE_TAG = "</CITATIONS>";

type CitationParseDiagnostics = {
  hasBlock: boolean;
  rawLength: number;
  error: string | null;
};

export function parseCitationsWithDiagnostics(text: string): {
  citations: ParsedCitation[];
  diagnostics: CitationParseDiagnostics;
} {
  // Models sometimes drop the final "]" or the closing </CITATIONS> tag.
  // Accept a block that opens correctly even when the close tag is missing,
  // and recover complete citation objects one by one when the array as a
  // whole does not parse. Each recovered object still passes the strict
  // per-citation normalization, so a truncated tail never invents a citation.
  const match = text.match(CITATIONS_BLOCK_RE);
  const openIndex = text.indexOf(CITATIONS_OPEN_TAG);
  const raw = match
    ? (match[1] ?? "")
    : openIndex >= 0
      ? text.slice(openIndex + CITATIONS_OPEN_TAG.length)
      : null;
  if (raw === null) {
    return {
      citations: [],
      diagnostics: { hasBlock: false, rawLength: 0, error: null },
    };
  }
  let strictError: string;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        citations: parsed
          .map(normalizeCitation)
          .filter((c): c is ParsedCitation => c !== null),
        diagnostics: { hasBlock: true, rawLength: raw.length, error: null },
      };
    }
    strictError = "CITATIONS block JSON was not an array.";
  } catch (error) {
    strictError = error instanceof Error ? error.message : String(error);
  }
  const recovered = parsePartialCitationObjects(raw);
  return {
    citations: recovered,
    diagnostics: {
      hasBlock: true,
      rawLength: raw.length,
      error: recovered.length
        ? `strict parse failed (${strictError}); recovered ${recovered.length} citation(s) object-by-object`
        : strictError,
    },
  };
}

export function parseCitations(text: string): ParsedCitation[] {
  return parseCitationsWithDiagnostics(text).citations;
}

/**
 * Extract every complete top-level JSON object from an array that may be
 * truncated (missing "]" or trailing content). Scanning starts after the
 * first "[" and stops at the array's closing "]" if one exists; incomplete
 * or malformed objects are dropped, never guessed at.
 */
export function extractJsonObjects(text: string): unknown[] {
  const arrayStart = text.indexOf("[");
  if (arrayStart < 0) return [];

  const objects: unknown[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objectStart = -1;

  for (let i = arrayStart + 1; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try {
          objects.push(JSON.parse(text.slice(objectStart, i + 1)));
        } catch {
          /* ignore incomplete/malformed object */
        }
        objectStart = -1;
      }
    } else if (char === "]" && depth === 0) {
      break;
    }
  }
  return objects;
}

export function parsePartialCitationObjects(text: string): ParsedCitation[] {
  const beforeClose = text.split(CITATIONS_CLOSE_TAG)[0] ?? text;
  return extractJsonObjects(beforeClose)
    .map(normalizeCitation)
    .filter((citation): citation is ParsedCitation => citation !== null);
}

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

/**
 * Project the existing strict evidence-id submission into the same citation
 * events used by document, CourtListener, A2AJ, and public-source JSON.
 */
export function createLegalEvidenceCitations(state: LegalEvidenceTurnState) {
  return legalEvidenceCitationEntries(state).flatMap(
    ({ ref, receipt, lookup, document }) => {
      const quote = receipt.span_text;
      if (!quote) return [];
      if (receipt.provider === "a2aj") {
        const built = createCitation(
          {
            kind: "a2aj",
            ref,
            citation: receipt.citation,
            name: receipt.name,
            dataset: receipt.dataset,
            url: receipt.external_url,
            quotes: [{ quote }],
          },
          {},
          undefined,
          lookup ? [lookup] : [],
          document ? [document] : [],
        );
        return [{
          ...built,
          url: ("url" in built ? built.url : null) ?? receipt.external_url,
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
          quotes: [{ quote }],
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
        quotes: [{ quote }],
        ...receiptLocator(receipt),
      }];
    },
  );
}
