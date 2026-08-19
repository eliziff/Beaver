import { beforeEach, describe, expect, it, vi } from "vitest";

const queueProviderPdfAttachment = vi.hoisted(() => vi.fn());
const lookupProviderPdfReference = vi.hoisted(() => vi.fn());
const rehydrateProviderPdfReference = vi.hoisted(() => vi.fn());
const hasNativeOpinionStructure = vi.hoisted(() => vi.fn());

vi.mock("../providerPdfLibraryBridge", () => ({
  lookupProviderPdfReference,
  queueProviderPdfAttachment,
  rehydrateProviderPdfReference,
}));

vi.mock("../legalSources/courtlistener", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../legalSources/courtlistener")
  >();
  return {
    ...original,
    courtlistenerLegalSourceProvider: {
      ...original.courtlistenerLegalSourceProvider,
      hasNativeOpinionStructure,
    },
  };
});
vi.mock("../remoteUrlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remoteUrlSafety")>()),
  guardedRemoteFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init),
}));

import { runLocalAssistantTools } from "./support/localAssistantTools";
import { courtlistenerPdfRendition } from "../chat/courtlistenerToolRunner";
import { resourceReference } from "../resourceReferences";

const fallback = {
  provider: "courtlistener",
  identity: "42",
  reference_id: "reference-1",
  download_status: "queued",
  parse_status: null,
};

beforeEach(() => {
  queueProviderPdfAttachment.mockReset();
  queueProviderPdfAttachment.mockResolvedValue(fallback);
  hasNativeOpinionStructure.mockReset();
  hasNativeOpinionStructure.mockReturnValue(false);
  lookupProviderPdfReference.mockReset();
  rehydrateProviderPdfReference.mockReset();
});

describe("provider PDF consumers", () => {
  it("returns queued/ready exact states with direct provider evidence", async () => {
    const requestReference = `mike-provider-pdf:v1:govinfo:${"1".repeat(64)}`;
    const sourceReference = `${requestReference}:${"2".repeat(64)}`;
    const handle = `mike-evidence:v1:${"3".repeat(64)}`;
    const ready = {
      availability: "ready",
      state: {
        provider: "govinfo",
        identity: "USCOURTS-example",
        request_reference: requestReference,
        reference_id: sourceReference,
        source_reference: sourceReference,
        download_status: "downloaded",
        source_sha256: "2".repeat(64),
        parse_status: "ready",
        fetched_at: "2026-07-27T00:00:00.000Z",
        checked_at: "2026-07-27T00:00:00.000Z",
      },
      params: {
        provider: "govinfo",
        identity: "USCOURTS-example",
        structureSource: "flat_text",
        url: "https://www.govinfo.gov/content/pkg/example/pdf/example.pdf",
        title: "Example decision",
      },
      lookup: {
        status: "found",
        matches: [],
        source: { version_id: "2".repeat(32) },
        evidence: {
          handle,
          page_numbers: [3],
          page_text_sha256: "4".repeat(64),
        },
        link: { page_numbers: [3] },
        units: [
          {
            id: "page-3",
            kind: "page",
            locator: "[page 3]",
            text:
              "Unique first context. The exact governing rule applies here. " +
              "Unique first conclusion.",
            page_numbers: [3],
            confidence: 0.99,
            confidence_basis: "native",
            provenance: "parser",
          },
        ],
        before: [],
        after: [],
      },
      linkEvidence: {
        handle,
        documentId: "provider-pdf-example",
        versionId: "2".repeat(32),
        href: "/single-documents/provider/evidence#page=3",
        label: "[page 3]",
        blockText:
          "Unique first context. The exact governing rule applies here. " +
          "Unique first conclusion.",
        documentText:
          "Unique first context. The exact governing rule applies here. " +
          "Unique first conclusion.\n" +
          "Different context. The exact governing rule applies here. " +
          "Different conclusion.",
        pageScoped: true,
        pageNumbers: [3],
        sources: [
          {
            key: "page:page-3",
            label: "[page 3]",
            href: "/single-documents/provider/evidence#page=3",
            blockText:
              "Unique first context. The exact governing rule applies here. " +
              "Unique first conclusion.",
            documentText:
              "Unique first context. The exact governing rule applies here. " +
              "Unique first conclusion.\n" +
              "Different context. The exact governing rule applies here. " +
              "Different conclusion.",
            pageScoped: true,
            pageNumbers: [3],
          },
        ],
        pages: [],
      },
    };
    lookupProviderPdfReference
      .mockResolvedValueOnce({
        availability: "queued",
        state: {
          reference_id: requestReference,
          download_status: "queued",
          parse_status: null,
        },
      })
      .mockResolvedValueOnce(ready);
    rehydrateProviderPdfReference.mockResolvedValue(ready);
    const [queued] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "provider-queued",
          name: "Read",
          input: {
            file_path: resourceReference.source("pdf", requestReference),
            locator_kind: "page",
            locator: "3",
          },
        },
      ],
    );
    expect(JSON.parse(queued.content)).toMatchObject({
      ok: false,
      status: "queued",
      reference_id: requestReference,
    });

    const [resolved] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "provider-ready",
          name: "Read",
          input: {
            file_path: resourceReference.source("pdf", requestReference),
            locator_kind: "page",
            locator: "3",
          },
        },
      ],
    );
    const payload = JSON.parse(resolved.content);
    expect(payload).toMatchObject({
      ok: true,
      reference_id: sourceReference,
      request_reference: requestReference,
      handle,
    });
    expect(resolved.evidence).toEqual([
      expect.objectContaining({
        provider: "benchmark",
        jurisdiction: "US",
        source_class: "legislation",
        dataset: "govinfo",
        span_text: expect.stringContaining("exact governing rule"),
        external_url:
          "https://www.govinfo.gov/content/pkg/example/pdf/example.pdf#page=3",
        locator: { kind: "page", label: "page=3" },
      }),
    ]);
    expect(payload.evidence_ids).toEqual([
      (resolved.evidence?.[0] as { evidence_id: string }).evidence_id,
    ]);

    const [rehydrated] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "provider-rehydrate",
          name: "Read",
          input: {
            file_path: resourceReference.source("pdf", sourceReference),
            handle,
          },
        },
      ],
    );
    expect(JSON.parse(rehydrated.content).reference_id).toBe(sourceReference);
    expect(rehydrateProviderPdfReference).toHaveBeenCalledWith(
      sourceReference,
      handle,
    );
  });

  it("imports a CourtListener cluster PDF only when opinion structure is flat", async () => {
    const opinion = { id: 8, text: "Opinion text" };
    const cached = {
      clusterId: 42,
      caseName: "Example v. State",
      citations: ["1 F.4th 2"],
      url: "https://www.courtlistener.com/opinion/42/example/",
      pdfUrl: "https://storage.courtlistener.com/pdf/42.pdf",
      dateFiled: "2026-01-01",
      opinions: [opinion],
    };

    const flatResult = await courtlistenerPdfRendition(cached, "local-user");

    expect(queueProviderPdfAttachment).toHaveBeenCalledWith({
      provider: "courtlistener",
      identity: "42",
      structureSource: "flat_text",
      url: "https://storage.courtlistener.com/pdf/42.pdf",
      canonicalUrl: "https://www.courtlistener.com/opinion/42/example/",
      title: "Example v. State",
    });
    expect(flatResult).toEqual({
      ...fallback,
      resource: resourceReference.source("pdf", "reference-1"),
    });

    queueProviderPdfAttachment.mockClear();
    hasNativeOpinionStructure.mockReturnValue(true);
    await courtlistenerPdfRendition(cached, "local-user");
    expect(queueProviderPdfAttachment).not.toHaveBeenCalled();

    hasNativeOpinionStructure.mockImplementation(
      (candidate) => (candidate as { id?: number }).id === 8,
    );
    const mixed = {
      ...cached,
      opinions: [opinion, { id: 10, text: "Flat sibling opinion" }],
    };
    await courtlistenerPdfRendition(mixed, "local-user");
    expect(queueProviderPdfAttachment).toHaveBeenCalledOnce();
  });

  it("keeps A2AJ links server-side without queuing PDF work", async () => {
    const text = Array.from(
      { length: 6 },
      (_, index) =>
        `[${index + 1}] Decision paragraph ${index + 1} contains enough substantive judicial language to establish a reliable sequence.`,
    ).join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              dataset: "SCC",
              citation_en: "2099 SCC 1",
              source_url_en:
                "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do",
              unofficial_text_en: text,
            },
          ],
        }),
      }),
    );
    const source = `source://a2aj/${encodeURIComponent(JSON.stringify([
      "2099 SCC 1",
      "cases",
      "SCC",
    ]))}`;
    const [response] = await runLocalAssistantTools("local-user", [
      {
        id: "call-a2aj",
        name: "Read",
        input: { file_path: source },
      },
    ]);

    const fetchPayload = JSON.parse(response.content);
    expect(queueProviderPdfAttachment).not.toHaveBeenCalled();
    expect(fetchPayload.url).toBeUndefined();
    expect(fetchPayload.pdf_rendition).toBeUndefined();

    const [lookupResponse] = await runLocalAssistantTools("local-user", [
      {
        id: "lookup-a2aj",
        name: "Read",
        input: {
          file_path: source,
          locator_kind: "paragraph",
          locator: "1",
        },
      },
    ]);
    const lookupPayload = JSON.parse(lookupResponse.content);
    expect(queueProviderPdfAttachment).not.toHaveBeenCalled();
    expect(lookupPayload.url).toBeUndefined();
    expect(lookupPayload.pdf_rendition).toBeUndefined();

    const [found] = await runLocalAssistantTools("local-user", [{
      id: "find-a2aj",
      name: "Read",
      input: { file_path: source, pattern: "substantive judicial language" },
    }]);
    expect(JSON.parse(found.content)).toMatchObject({
      ok: true,
      query: "substantive judicial language",
      total_matches: 6,
    });
    expect(found.evidenceRefs?.[0]).toMatchObject({ kind: "candidate" });
  });
});
