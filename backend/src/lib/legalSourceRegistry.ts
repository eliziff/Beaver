import {
  a2ajLegalSourceProvider,
  type A2AJLocatorLookup,
} from "./legalSources/a2aj";
import { hansardLegalSourceProvider } from "./a2ajHansard";
import {
  courtlistenerLegalSourceProvider,
  type CourtlistenerProviderOptions,
} from "./legalSources/courtlistener";
import { journalLegalSourceProvider } from "./legalSources/journal";
import {
  createLegalSourceRegistry,
  type LegalSourcePassage,
  type LegalSourcePassageRequest,
  type LegalSourceProvider,
  type LegalSourceResolveRequest,
  type LegalSourceSearchRequest,
} from "./legalSources";
import {
  buildA2AJPinpointUrl,
  buildLegalSourcePinpointUrl,
  type QuoteSource,
} from "./legalSourceLinks";
import {
  govUkEmploymentTribunalLegalSourceProvider,
} from "./legalSources/govUkEmploymentTribunal";
import { govInfoLegalSourceProvider } from "./legalSources/govInfo";
import { tnaLegalSourceProvider } from "./legalSources/tna";

export function createLegalSourceOperations(
  options: { courtlistener?: CourtlistenerProviderOptions } = {},
) {
  return createLegalSourceRegistry<QuoteSource, unknown>(
    [
      a2ajLegalSourceProvider,
      options.courtlistener
        ? courtlistenerLegalSourceProvider.configured(options.courtlistener)
        : courtlistenerLegalSourceProvider,
      tnaLegalSourceProvider,
      govUkEmploymentTribunalLegalSourceProvider,
      govInfoLegalSourceProvider,
      journalLegalSourceProvider,
      hansardLegalSourceProvider,
    ] satisfies LegalSourceProvider<QuoteSource, unknown>[],
  );
}

export const legalSourceOperations = createLegalSourceOperations();

export const searchLegalSources = (request: LegalSourceSearchRequest) =>
  legalSourceOperations.search(request);

export const resolveLegalSource = (request: LegalSourceResolveRequest) =>
  legalSourceOperations.resolve(request);

export const readLegalSourcePassage = (request: LegalSourcePassageRequest) =>
  legalSourceOperations.readPassage(request);

type A2AJPassageNative = {
  lookup: A2AJLocatorLookup;
  block: NonNullable<A2AJLocatorLookup["block"]>;
};

function a2ajPassageNative(value: unknown): A2AJPassageNative | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<A2AJPassageNative>;
  return record.lookup && record.block &&
    typeof record.lookup.citation === "string" &&
    Boolean(record.lookup.requested) &&
    typeof record.lookup.requested?.kind === "string"
    ? { lookup: record.lookup, block: record.block }
    : null;
}

export function legalSourcePassageUrl(
  passage: LegalSourcePassage<QuoteSource, unknown>,
  quotes: readonly string[] = [],
) {
  const native = a2ajPassageNative(passage.native);
  if (passage.source.provider === "a2aj" && native) {
    return buildA2AJPinpointUrl(
      native.lookup,
      [...quotes],
      typeof passage.documentArtifact === "object"
        ? passage.documentArtifact
        : null,
      native?.block,
    );
  }
  if (!passage.source.url) return null;
  return buildLegalSourcePinpointUrl(
    {
      url: passage.source.url,
      anchor: passage.locator.anchor ?? undefined,
      blockText: passage.blockArtifact ?? passage.text,
      documentText: passage.documentArtifact,
      pageScoped: passage.locator.pageScoped,
    },
    [...quotes],
  );
}

export function legalSourceProviderFamily(
  passage: Pick<LegalSourcePassage, "source">,
) {
  return passage.source.family ?? passage.source.provider;
}

export type {
  LegalSourceKind,
  LegalSourceLocator,
  LegalSourceMatchResult,
  LegalSourcePassage,
  LegalSourcePassageRequest,
  LegalSourceReadResult,
  LegalSourceReference,
  LegalSourceResolveRequest,
  LegalSourceSearchHit,
  LegalSourceSearchRequest,
} from "./legalSources";
