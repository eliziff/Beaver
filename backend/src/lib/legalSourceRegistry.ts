import {
  a2ajLegalSourceProvider,
} from "./legalSources/a2aj";
import { hansardLegalSourceProvider } from "./a2ajHansard";
import {
  courtlistenerLegalSourceProvider,
  type CourtlistenerProviderOptions,
} from "./legalSources/courtlistener";
import { journalLegalSourceProvider } from "./legalSources/journal";
import {
  createLegalSourceRegistry,
  type LegalSourcePassageRequest,
  type LegalSourceProvider,
  type LegalSourceResolveRequest,
  type LegalSourceSearchRequest,
} from "./legalSources";
import type { QuoteSource } from "./legalSourceLinks";
import {
  govUkEmploymentTribunalLegalSourceProvider,
} from "./legalSources/govUkEmploymentTribunal";
import { govInfoLegalSourceProvider } from "./legalSources/govInfo";
import { tnaLegalSourceProvider } from "./legalSources/tna";

function createLegalSourceOperations(
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

const legalSourceOperations = createLegalSourceOperations();

export const searchLegalSources = (request: LegalSourceSearchRequest) =>
  legalSourceOperations.search(request);

export const resolveLegalSource = (request: LegalSourceResolveRequest) =>
  legalSourceOperations.resolve(request);

export const readLegalSourcePassage = (request: LegalSourcePassageRequest) =>
  legalSourceOperations.readPassage(request);

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
