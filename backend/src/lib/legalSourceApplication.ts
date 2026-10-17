import { courtlistenerLegalSourceProvider } from "./legalSources/courtlistener";
import { resourceReference } from "mike/shared/runtime/resourceReferences.mjs";
import { jsonRecord as row, nonemptyString as text, positiveInteger as integer } from "./value";
import type { RemoteLegalSourceDocument } from "./legalSources/remoteProvider";
import {
  a2ajLegalSourceProvider,
  type A2AJViewerPayload,
} from "./legalSources/a2aj";
import { journalLegalSourceProvider } from "./legalSources/journal";
import { createLegalSourceRegistry } from "./legalSources";
import { hansardLegalSourceProvider } from "./a2ajHansard";
import { govUkEmploymentTribunalLegalSourceProvider } from "./legalSources/govUkEmploymentTribunal";
import { govInfoLegalSourceProvider } from "./legalSources/govInfo";
import { tnaLegalSourceProvider } from "./legalSources/tna";
import type { LegalSourceReference } from "./legalSources";
import {
  queueProviderPdfAttachment,
  queueProviderPdfRenditions,
  type ProviderPdfAttachment,
} from "./providerPdfLibraryBridge";
import { structureNative, type NativeDocument } from "./structureNative";
import { ApplicationError, reject } from "./applicationError";
import type { LegalSourceSearchRequest, LegalSourcePassageRequest } from "./legalSources";

const librarySourceTypes = {
  cases: { kind: "case", provider: "a2aj" },
  laws: { kind: "legislation", provider: "a2aj" },
  articles: { kind: "journal", provider: "journal" },
  hansard: { kind: "hansard", provider: "hansard" },
} as const;

async function providerCall<T>(message: string, operation: () => T): Promise<Awaited<T>> {
  try {
    return await operation() as Awaited<T>;
  } catch {
    throw new ApplicationError(502, message);
  }
}

function a2ajPdfRenditionRequest(
  payload: A2AJViewerPayload,
  native: NativeDocument,
): ProviderPdfAttachment | null {
  if (
    structureNative().documentHasOrigin(native, "native") ||
    !payload.metadata.pdfUrl ||
    !payload.metadata.url
  ) {
    return null;
  }
  return {
    provider: "a2aj",
    identity: `${payload.reference.dataset || ""}:${payload.reference.citation}`,
    source: { provider: "a2aj", id: payload.reference.citation,
      kind: payload.reference.kind, collection: payload.reference.dataset,
      language: payload.reference.language, citation: payload.reference.citation,
      alternateCitation: payload.metadata.alternateCitation, date: payload.metadata.date,
      title: payload.metadata.title, url: payload.metadata.url },
    url: payload.metadata.pdfUrl,
    canonicalUrl: payload.metadata.url,
    title: payload.metadata.title,
  };
}

type ViewerPointer = {
  citation: string; provider?: "a2aj" | "journal";
  docType: "cases" | "laws" | "articles" | "auto"; language: "en" | "fr";
  dataset?: string | null; sourceId?: string | null;
};

async function courtlistenerPdfRendition(value: object, reference: LegalSourceReference, userId?: string) {
  const source = value as Record<string, unknown>;
  const clusterId = integer(source.clusterId) ?? integer(source.id);
  const opinions = Array.isArray(source.opinions)
    ? source.opinions.filter((item): item is object => Boolean(row(item))) : [];
  const pdfUrl = text(source.pdfUrl) ?? text(source.pdf_url);
  const needsRendition = opinions.some((opinion) =>
    !courtlistenerLegalSourceProvider.hasNativeOpinionStructure(opinion));
  if (!clusterId || !userId || !pdfUrl || !needsRendition) return null;
  try {
    const queued = await queueProviderPdfAttachment({
      source: reference,
      provider: "courtlistener",
      identity: String(clusterId),
      url: pdfUrl,
      canonicalUrl: text(source.url),
      title: text(source.caseName) ?? text(source.case_name) ??
        (Array.isArray(source.citations) ? text(source.citations[0]) : null) ??
        `CourtListener ${clusterId}`,
    }, userId);
    return queued && {
      ...queued,
      resource: resourceReference.source("pdf", queued.reference_id),
    };
  } catch {
    return null;
  }
}

const providers = createLegalSourceRegistry<unknown>([
  a2ajLegalSourceProvider, courtlistenerLegalSourceProvider, tnaLegalSourceProvider,
  govUkEmploymentTribunalLegalSourceProvider, govInfoLegalSourceProvider,
  journalLegalSourceProvider, hansardLegalSourceProvider,
]);


export const legalSourceOperations = {
  ...providers,
  async readWithRenditions(request: LegalSourcePassageRequest, userId?: string) {
    const read = await providers.readPassage(request);
    if (read.status !== "found") return read;
    if (!userId) return { ...read, pdfRenditions: [] };
    const remoteSources = new Map<string, { document: RemoteLegalSourceDocument; source: LegalSourceReference }>();
    const courtCases = new Map<string, { value: Record<string, unknown>; source: LegalSourceReference }>();
    for (const passage of read.values) {
      const native = row(passage.native);
      if (native && ["tna", "govuk-et", "govinfo"].includes(passage.source.provider)) {
        const document = native as RemoteLegalSourceDocument;
        remoteSources.set(`${document.provider}:${document.identity}`, { document, source: passage.source });
      }
      const courtCase = row(native?.case);
      if (courtCase && passage.source.provider === "courtlistener")
        courtCases.set(passage.source.id, { value: courtCase, source: passage.source });
    }
    const pdfRenditions = (await Promise.all([
      ...[...remoteSources.values()].map(({ document, source }) => queueProviderPdfRenditions(document, source, userId)),
      ...[...courtCases.values()].map(({ value, source }) => courtlistenerPdfRendition(value, source, userId)),
    ])).flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
    return { ...read, pdfRenditions };
  },
};

export function createLegalSourceApplication() {
  async function viewer(userId: string, pointer: ViewerPointer) {
    const request = pointer.provider === "journal" || pointer.docType === "articles"
      ? journalLegalSourceProvider.viewer(pointer.sourceId ?? pointer.citation)
      : a2ajLegalSourceProvider.viewer({
          citation: pointer.citation,
          docType: pointer.docType,
          language: pointer.language,
          dataset: pointer.dataset ?? undefined,
        });
    const resolved = await providerCall("Legal source provider unavailable", () => request);
    if (!resolved) return reject(404, "Legal source not found");
    const pdfRenditionRequest = resolved.payload.provider === "a2aj"
      ? a2ajPdfRenditionRequest(resolved.payload, resolved.native) : null;
    if (pdfRenditionRequest) {
      void queueProviderPdfAttachment(pdfRenditionRequest, userId).catch(() => undefined);
    }
    return { payload: resolved.payload, etag: resolved.etag };
  }
  return {
    ...legalSourceOperations,
    async coverage() {
      const results = await Promise.allSettled([
        a2ajLegalSourceProvider.coverage("cases"), a2ajLegalSourceProvider.coverage("laws"),
      ]);
      return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    },
    async searchLibrary({ docType, size, ...query }: Omit<LegalSourceSearchRequest,
      "kinds" | "providers" | "limit" | "perProviderLimit"> & {
        docType: keyof typeof librarySourceTypes; size: number;
      }) {
      const type = librarySourceTypes[docType];
      const limit = Number.isFinite(size)
        ? Math.min(Math.max(size, 1), docType === "hansard" ? 20 : 25)
        : docType === "hansard" ? 10 : 12;
      const { results, unavailable } = await providerCall("Legal source search unavailable", () =>
        legalSourceOperations.search({ ...query, kinds: [type.kind], providers: [type.provider],
          limit, perProviderLimit: limit }));
      if (unavailable.some(({ message }) => message !== "not_installed"))
        return reject(502, "Legal source search unavailable");
      return { results, status: unavailable.length ? "not_installed" as const : "available" as const };
    },
    viewer,
  };
}
export type LegalSourceApplication = ReturnType<typeof createLegalSourceApplication>;
