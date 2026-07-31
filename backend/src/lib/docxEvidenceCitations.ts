import {
  createLocalPdfLinkEvidenceSession,
  readLocalPdfEvidenceReceipt,
  type LocalPdfLinkEvidence,
  type LocalPdfLocatorKind,
} from "./localPdfLookup";
import { getLocalVersionFile } from "./localDocumentStore";
import {
  automaticPinpointQuote,
  buildLegalSourceMultiPassageUrl,
  buildLegalSourcePinpointUrl,
  formatLegalLocator,
  sharedSourceDocs,
  type LegalSourceEvidence,
} from "./legalSourceLinks";
import { rehydrateProviderPdfReference } from "./providerPdfLibraryBridge";
import { rehydratePublicLegalEvidence } from "./publicLegalSources";

const LOCAL_HANDLE = /^mike-evidence:v1:[0-9a-f]{64}$/u;
// v1 handles still parse as handles here; the receipt reader refuses
// them with the superseded-schema error at rehydration time.
const PROVIDER_HANDLE = /^mike-provider-evidence:v[12]:[0-9a-f]{64}$/u;
const PROVIDER_PDF_REFERENCE =
  /^mike-provider-pdf:v1:(?:a2aj|courtlistener|govinfo|govuk-et|tna):[a-f0-9]{64}:[a-f0-9]{64}$/u;
const SOURCE_ID = /^[a-z][a-z0-9_-]{0,63}$/u;

type SourceInput = {
  id: string;
  citation: string;
  handles: string[];
  quotes: string[];
  sourceReference: string | null;
};

export type ResolvedDocxEvidenceCitations = {
  citations: Record<string, { text: string; url: string }>;
  bindings: {
    id: string;
    handles: string[];
    source_sha256: string;
    locators: string[];
    url: string;
  }[];
};

function sourceInputs(raw: unknown): SourceInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new Error("DOCX sources must be an array of at most 100 entries.");
  }
  const seen = new Set<string>();
  let handleCount = 0;
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Each DOCX source must be an object.");
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const citation =
      typeof record.citation === "string" ? record.citation.trim() : "";
    const handles = Array.isArray(record.handles)
      ? record.handles.map((handle) =>
          typeof handle === "string" ? handle.trim() : "",
        )
      : [];
    const quotes =
      record.quotes === undefined
        ? []
        : Array.isArray(record.quotes)
          ? record.quotes.map((quote) =>
              typeof quote === "string" ? quote.trim() : "",
            )
          : [""];
    const sourceReference =
      typeof record.source_reference === "string"
        ? record.source_reference.trim()
        : null;
    if (!SOURCE_ID.test(id) || seen.has(id)) {
      throw new Error("DOCX source ids must be unique lowercase identifiers.");
    }
    if (
      !citation ||
      citation.length > 500 ||
      /[\r\n]/u.test(citation) ||
      !handles.length ||
      handles.length > 16 ||
      handles.some(
        (handle) => !LOCAL_HANDLE.test(handle) && !PROVIDER_HANDLE.test(handle),
      ) ||
      quotes.some((quote) => !quote || quote.length > 1_000) ||
      (quotes.length > 0 && quotes.length !== handles.length) ||
      (sourceReference !== null &&
        !PROVIDER_PDF_REFERENCE.test(sourceReference))
    ) {
      throw new Error(`DOCX source "${id}" is invalid.`);
    }
    const families = new Set(
      handles.map((handle) =>
        PROVIDER_HANDLE.test(handle) ? "provider" : "local",
      ),
    );
    if (families.size !== 1) {
      throw new Error(`DOCX source "${id}" mixes evidence families.`);
    }
    if (
      sourceReference &&
      handles.some((handle) => PROVIDER_HANDLE.test(handle))
    ) {
      throw new Error(
        `DOCX source "${id}" cannot pair native evidence with a PDF reference.`,
      );
    }
    const uniqueHandles = new Map<string, string>();
    handles.forEach((handle, index) => {
      const quote = quotes[index] ?? "";
      const existing = uniqueHandles.get(handle);
      if (existing !== undefined && existing !== quote) {
        throw new Error(
          `DOCX source "${id}" gives one handle conflicting quotes.`,
        );
      }
      uniqueHandles.set(handle, quote);
    });
    handleCount += uniqueHandles.size;
    if (handleCount > 256) {
      throw new Error("DOCX sources contain more than 256 evidence handles.");
    }
    seen.add(id);
    return {
      id,
      citation,
      handles: [...uniqueHandles.keys()],
      quotes: quotes.length ? [...uniqueHandles.values()] : [],
      sourceReference,
    };
  });
}

function localKind(kind: LocalPdfLocatorKind) {
  return kind === "page" || kind === "paragraph" || kind === "footnote"
    ? kind
    : "section";
}

function backendBaseUrl() {
  const raw =
    process.env.API_PUBLIC_URL ||
    process.env.BACKEND_URL ||
    `http://localhost:${process.env.PORT ?? "3001"}`;
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("The backend public URL is unsafe.");
  }
  return url;
}

function absoluteLocalUrl(value: string) {
  const url = new URL(value, backendBaseUrl());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("A local evidence URL is unsafe.");
  }
  return url.toString();
}

function visibleCitation(citation: string, locators: string[]) {
  const unique = [...new Set(locators)];
  return unique.length ? `${citation} at ${unique.join(", ")}` : citation;
}

async function resolveProviderSource(input: SourceInput) {
  const restored = await Promise.all(
    input.handles.map((handle) => rehydratePublicLegalEvidence(handle)),
  );
  const first = restored[0];
  if (
    restored.some(
      ({ receipt }) =>
        receipt.source.identifier !== first.receipt.source.identifier ||
        receipt.source.canonical_url !== first.receipt.source.canonical_url ||
        receipt.source.source_sha256 !== first.receipt.source.source_sha256,
    )
  ) {
    throw new Error(`DOCX source "${input.id}" mixes source versions.`);
  }
  const passages = restored.map(({ document, lookup, receipt }, index) => {
    if (lookup.status !== "found" || !lookup.block) {
      throw new Error(`DOCX source "${input.id}" evidence is unavailable.`);
    }
    const evidence: LegalSourceEvidence = {
      url: document.url,
      anchor: lookup.block.anchor,
      blockText: lookup.block.text,
      documentText: document.structure,
    };
    const quote =
      input.quotes[index] ??
      (restored.length > 1 ? automaticPinpointQuote(evidence) : null);
    if (restored.length > 1 && !quote) {
      throw new Error(
        `DOCX source "${input.id}" cannot verify a multi-pinpoint link.`,
      );
    }
    return {
      key: receipt.lookup.provider_locator,
      evidence,
      quote,
      locator: formatLegalLocator(
        receipt.lookup.locator_kind,
        receipt.lookup.locator,
      ),
    };
  });
  const url =
    passages.length === 1
      ? buildLegalSourcePinpointUrl(
          passages[0].evidence,
          passages[0].quote ? [passages[0].quote] : [],
        )
      : buildLegalSourceMultiPassageUrl(
          first.document.url,
          passages.map((passage) => ({
            key: passage.key,
            blockText: passage.evidence.blockText,
            documentText: passage.evidence.documentText,
            quotes: [passage.quote!],
          })),
        );
  if (!url) {
    throw new Error(`DOCX source "${input.id}" has no verified link.`);
  }
  if (input.quotes.length && !url.includes(":~:text=")) {
    throw new Error(`DOCX source "${input.id}" quote was not verified.`);
  }
  return {
    citation: {
      text: visibleCitation(
        input.citation,
        passages.map(({ locator }) => locator),
      ),
      url,
    },
    binding: {
      id: input.id,
      handles: input.handles,
      source_sha256: first.receipt.source.source_sha256,
      locators: passages.map(({ locator }) => locator),
      url,
    },
  };
}

async function resolveLocalSource(
  userId: string,
  input: SourceInput,
  allowedDocumentIds?: ReadonlySet<string>,
) {
  const receipts = await Promise.all(
    input.handles.map((handle) => readLocalPdfEvidenceReceipt(handle)),
  );
  const first = receipts[0];
  if (
    receipts.some(
      ({ source }) =>
        source.document_id !== first.source.document_id ||
        source.version_id !== first.source.version_id ||
        source.source_sha256 !== first.source.source_sha256,
    ) ||
    (allowedDocumentIds && !allowedDocumentIds.has(first.source.document_id))
  ) {
    throw new Error(`DOCX source "${input.id}" is outside this document set.`);
  }
  const file = await getLocalVersionFile(
    userId,
    first.source.document_id,
    first.source.version_id,
  );
  if (!file || file.fileType.toLowerCase() !== "pdf") {
    throw new Error(`DOCX source "${input.id}" is unavailable.`);
  }
  const session = createLocalPdfLinkEvidenceSession(file.path);
  const links = await Promise.all(
    input.handles.map((handle) => session.rehydrate(handle)),
  );
  if (
    links.some(
      (link) =>
        link.documentId !== first.source.document_id ||
        link.versionId !== first.source.version_id,
    )
  ) {
    throw new Error(`DOCX source "${input.id}" changed during resolution.`);
  }
  if (
    links.length > 1 &&
    links.some(
      (link) =>
        link.pageNumbers.length !== 1 ||
        link.pageNumbers[0] !== links[0].pageNumbers[0],
    )
  ) {
    throw new Error(
      `DOCX source "${input.id}" spans PDF pages; split it into separate citations.`,
    );
  }
  const compiled = sharedSourceDocs();
  const passages = links.map((link: LocalPdfLinkEvidence, index) => {
    const evidence: LegalSourceEvidence = {
      url: absoluteLocalUrl(link.href),
      blockText: link.blockText,
      documentText: compiled(link.documentText),
      pageScoped: link.pageScoped,
    };
    const quote =
      input.quotes[index] ??
      (links.length > 1 ? automaticPinpointQuote(evidence) : null);
    if (links.length > 1 && !quote) {
      throw new Error(
        `DOCX source "${input.id}" cannot verify a multi-pinpoint link.`,
      );
    }
    const receipt = receipts[index];
    return {
      key: input.handles[index],
      evidence,
      quote,
      locator: formatLegalLocator(
        localKind(receipt.lookup.locatorKind),
        receipt.lookup.locator,
      ),
    };
  });
  const url =
    passages.length === 1
      ? buildLegalSourcePinpointUrl(
          passages[0].evidence,
          passages[0].quote ? [passages[0].quote] : [],
        )
      : buildLegalSourceMultiPassageUrl(
          passages[0].evidence.url,
          passages.map((passage) => ({
            key: passage.key,
            blockText: passage.evidence.blockText,
            documentText: passage.evidence.documentText,
            pageScoped: true,
            quotes: [passage.quote!],
          })),
        );
  if (!url) {
    throw new Error(`DOCX source "${input.id}" has no verified link.`);
  }
  if (input.quotes.length && !url.includes(":~:text=")) {
    throw new Error(`DOCX source "${input.id}" quote was not verified.`);
  }
  return {
    citation: {
      text: visibleCitation(
        input.citation,
        passages.map(({ locator }) => locator),
      ),
      url,
    },
    binding: {
      id: input.id,
      handles: input.handles,
      source_sha256: first.source.source_sha256,
      locators: passages.map(({ locator }) => locator),
      url,
    },
  };
}

async function resolveProviderPdfSource(input: SourceInput) {
  const reference = input.sourceReference!;
  const [receipts, restored] = await Promise.all([
    Promise.all(
      input.handles.map((handle) => readLocalPdfEvidenceReceipt(handle)),
    ),
    Promise.all(
      input.handles.map((handle) =>
        rehydrateProviderPdfReference(reference, handle),
      ),
    ),
  ]);
  if (
    restored.some(
      (result) =>
        result.availability !== "ready" ||
        !result.linkEvidence ||
        result.state.source_reference !== reference ||
        !result.state.source_sha256,
    )
  ) {
    throw new Error(`DOCX source "${input.id}" is unavailable.`);
  }
  const ready = restored as Extract<
    Awaited<ReturnType<typeof rehydrateProviderPdfReference>>,
    { availability: "ready" }
  >[];
  if (
    ready.some(
      ({ state }) =>
        state.source_reference !== ready[0].state.source_reference ||
        state.source_sha256 !== ready[0].state.source_sha256,
    )
  ) {
    throw new Error(`DOCX source "${input.id}" mixes source versions.`);
  }
  const links = ready.map(({ linkEvidence }) => linkEvidence!);
  if (
    links.length > 1 &&
    links.some(
      (link) =>
        link.pageNumbers.length !== 1 ||
        link.pageNumbers[0] !== links[0].pageNumbers[0],
    )
  ) {
    throw new Error(
      `DOCX source "${input.id}" spans PDF pages; split it into separate citations.`,
    );
  }
  const sourceUrl = new URL(ready[0].params.url);
  if (
    !["http:", "https:"].includes(sourceUrl.protocol) ||
    sourceUrl.username ||
    sourceUrl.password
  ) {
    throw new Error(`DOCX source "${input.id}" has an unsafe provider URL.`);
  }
  if (links[0].pageNumbers[0]) {
    sourceUrl.hash = `page=${links[0].pageNumbers[0]}`;
  }
  const compiled = sharedSourceDocs();
  const passages = links.map((link, index) => {
    const evidence: LegalSourceEvidence = {
      url: sourceUrl.toString(),
      blockText: link.blockText,
      documentText: compiled(link.documentText),
      pageScoped: link.pageScoped,
    };
    const quote =
      input.quotes[index] ??
      (links.length > 1 ? automaticPinpointQuote(evidence) : null);
    if (links.length > 1 && !quote) {
      throw new Error(
        `DOCX source "${input.id}" cannot verify a multi-pinpoint link.`,
      );
    }
    return {
      key: input.handles[index],
      evidence,
      quote,
      locator: formatLegalLocator(
        localKind(receipts[index].lookup.locatorKind),
        receipts[index].lookup.locator,
      ),
    };
  });
  const url =
    passages.length === 1
      ? buildLegalSourcePinpointUrl(
          passages[0].evidence,
          passages[0].quote ? [passages[0].quote] : [],
        )
      : buildLegalSourceMultiPassageUrl(
          sourceUrl.toString(),
          passages.map((passage) => ({
            key: passage.key,
            blockText: passage.evidence.blockText,
            documentText: passage.evidence.documentText,
            pageScoped: true,
            quotes: [passage.quote!],
          })),
        );
  if (!url || (input.quotes.length && !url.includes(":~:text="))) {
    throw new Error(`DOCX source "${input.id}" has no verified link.`);
  }
  return {
    citation: {
      text: visibleCitation(
        input.citation,
        passages.map(({ locator }) => locator),
      ),
      url,
    },
    binding: {
      id: input.id,
      handles: input.handles,
      source_sha256: ready[0].state.source_sha256!,
      locators: passages.map(({ locator }) => locator),
      url,
    },
  };
}

export async function resolveDocxEvidenceCitations(
  userId: string,
  rawSources: unknown,
  allowedDocumentIds?: ReadonlySet<string>,
): Promise<ResolvedDocxEvidenceCitations> {
  const inputs = sourceInputs(rawSources);
  const resolved = await Promise.all(
    inputs.map((input) =>
      PROVIDER_HANDLE.test(input.handles[0])
        ? resolveProviderSource(input)
        : input.sourceReference
          ? resolveProviderPdfSource(input)
          : resolveLocalSource(userId, input, allowedDocumentIds),
    ),
  );
  return {
    citations: Object.fromEntries(
      resolved.map(({ binding, citation }) => [binding.id, citation]),
    ),
    bindings: resolved.map(({ binding }) => binding),
  };
}
