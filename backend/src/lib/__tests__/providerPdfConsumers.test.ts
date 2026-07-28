import { beforeEach, describe, expect, it, vi } from "vitest";

const queueProviderPdfAttachment = vi.hoisted(() => vi.fn());
const lookupProviderPdfReference = vi.hoisted(() => vi.fn());
const rehydrateProviderPdfReference = vi.hoisted(() => vi.fn());
const getCourtlistenerCases = vi.hoisted(() => vi.fn());
const getCourtlistenerOpinionStructure = vi.hoisted(() => vi.fn());

vi.mock("../providerPdfLibraryBridge", () => ({
  lookupProviderPdfReference,
  queueProviderPdfAttachment,
  rehydrateProviderPdfReference,
}));

vi.mock("../courtlistener", () => ({
  getCourtlistenerCases,
  getCourtlistenerOpinionDocumentText: () => "Opinion text",
  getCourtlistenerOpinionStructure,
  lookupCourtlistenerOpinionLocator: vi.fn(),
  searchCourtlistenerCaseLaw: vi.fn(),
  verifyCourtlistenerCitations: vi.fn(),
}));

import { runLocalAssistantTools } from "../chat/localAssistantTools";
import {
  runLocalCourtlistenerTool,
  type LocalCourtlistenerState,
} from "../chat/localCourtlistenerTools";
import { COURTLISTENER_TOOL_NAMES } from "../chat/tools/courtlistenerTools";
import { appendLocalPdfPinpointLinks } from "../chat/localPdfEvidenceState";

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
  getCourtlistenerCases.mockReset();
  getCourtlistenerOpinionStructure.mockReset();
  getCourtlistenerOpinionStructure.mockReturnValue({ blocks: [] });
  lookupProviderPdfReference.mockReset();
  rehydrateProviderPdfReference.mockReset();
});

describe("provider PDF consumers", () => {
  it("returns queued/ready exact states and registers provider evidence links", async () => {
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
        freshness_status: "current",
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
    const handles = new Set<string>();

    const [queued] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "provider-queued",
          name: "provider_pdf_lookup",
          input: {
            reference_id: requestReference,
            locator_kind: "page",
            locator: "3",
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      handles,
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
          name: "provider_pdf_lookup",
          input: {
            reference_id: requestReference,
            locator_kind: "page",
            locator: "3",
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      handles,
    );
    const payload = JSON.parse(resolved.content);
    expect(payload).toMatchObject({
      ok: true,
      reference_id: sourceReference,
      request_reference: requestReference,
      handle,
      freshness_status: "current",
    });
    expect(payload.link.href).toContain(
      "https://www.govinfo.gov/content/pkg/example/pdf/example.pdf#page=3",
    );
    expect(payload.link.href).not.toContain(":~:text=");
    expect(payload.link.href.length).toBeLessThan(200);
    expect(payload.link.href).not.toContain("single-documents");
    expect(handles).toContain(handle);

    const linked = await appendLocalPdfPinpointLinks(
      'The court held that "The exact governing rule applies here."',
      "local-user",
      handles,
    );
    expect(linked).toContain("www.govinfo.gov");
    expect(linked).toContain(":~:text=");
    expect(linked).toMatch(/(?:-,|,-)/u);

    const [rehydrated] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "provider-rehydrate",
          name: "provider_pdf_lookup",
          input: { reference_id: sourceReference, handle },
        },
      ],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      handles,
    );
    expect(JSON.parse(rehydrated.content).reference_id).toBe(sourceReference);
    expect(rehydrateProviderPdfReference).toHaveBeenCalledWith(
      sourceReference,
      handle,
    );
  });

  it("imports a CourtListener cluster PDF only when opinion structure is flat", async () => {
    const opinion = { id: 8, text: "Opinion text" };
    getCourtlistenerCases.mockResolvedValue({
      cases: [
        {
          clusterId: 42,
          caseName: "Example v. State",
          citations: ["1 F.4th 2"],
          url: "https://www.courtlistener.com/opinion/42/example/",
          pdfUrl: "https://storage.courtlistener.com/pdf/42.pdf",
          dateFiled: "2026-01-01",
          opinions: [opinion],
        },
      ],
    });
    const state: LocalCourtlistenerState = {
      casesByClusterId: new Map(),
    };
    const call = {
      id: "call-1",
      name: COURTLISTENER_TOOL_NAMES.getCases,
      input: { clusterIds: [42] },
    };

    const flatResult = await runLocalCourtlistenerTool(
      call,
      state,
      "local-user",
    );

    expect(queueProviderPdfAttachment).toHaveBeenCalledWith({
      provider: "courtlistener",
      identity: "42",
      structureSource: "flat_text",
      url: "https://storage.courtlistener.com/pdf/42.pdf",
      canonicalUrl: "https://www.courtlistener.com/opinion/42/example/",
      title: "Example v. State",
    });
    expect(JSON.parse(flatResult!.content).cases[0].pdf_fallback).toEqual(
      fallback,
    );

    queueProviderPdfAttachment.mockClear();
    getCourtlistenerOpinionStructure.mockReturnValue({
      blocks: [{ origin: "native" }],
    });
    await runLocalCourtlistenerTool(call, state, "local-user");
    expect(queueProviderPdfAttachment).not.toHaveBeenCalled();

    getCourtlistenerOpinionStructure.mockImplementation((candidate) => ({
      blocks:
        (candidate as { id?: number }).id === 8 ? [{ origin: "native" }] : [],
    }));
    getCourtlistenerCases.mockResolvedValue({
      cases: [
        {
          clusterId: 42,
          caseName: "Example v. State",
          citations: ["1 F.4th 2"],
          url: "https://www.courtlistener.com/opinion/42/example/",
          pdfUrl: "https://storage.courtlistener.com/pdf/42.pdf",
          opinions: [opinion, { id: 10, text: "Flat sibling opinion" }],
        },
      ],
    });
    await runLocalCourtlistenerTool(call, state, "local-user");
    expect(queueProviderPdfAttachment).toHaveBeenCalledOnce();

    queueProviderPdfAttachment.mockClear();
    getCourtlistenerOpinionStructure.mockReturnValue({ blocks: [] });
    getCourtlistenerCases.mockResolvedValue({
      cases: [
        {
          clusterId: 42,
          caseName: "Example v. State",
          citations: [],
          url: "https://www.courtlistener.com/opinion/42/example/",
          pdfUrl: "https://storage.courtlistener.com/pdf/42.pdf",
          opinions: [opinion],
        },
        {
          clusterId: 43,
          caseName: "Second v. State",
          citations: [],
          url: "https://www.courtlistener.com/opinion/43/second/",
          pdfUrl: "https://storage.courtlistener.com/pdf/43.pdf",
          opinions: [{ id: 9, text: "Second opinion" }],
        },
      ],
    });
    await runLocalCourtlistenerTool(
      {
        ...call,
        input: { clusterIds: [42, 43] },
      },
      state,
      "local-user",
    );
    expect(queueProviderPdfAttachment).not.toHaveBeenCalled();

    const explored = await runLocalCourtlistenerTool(
      {
        id: "call-find",
        name: COURTLISTENER_TOOL_NAMES.findInCase,
        input: { clusterId: 42, query: "Opinion" },
      },
      state,
      "local-user",
    );
    expect(queueProviderPdfAttachment).toHaveBeenCalledOnce();
    expect(JSON.parse(explored!.content).pdf_fallback).toEqual(fallback);
  });

  it("uses a same-host Decisia PDF candidate for flat A2AJ text", async () => {
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
    queueProviderPdfAttachment.mockResolvedValue({
      ...fallback,
      provider: "a2aj",
      identity: "SCC:2099 SCC 1",
    });

    const [response] = await runLocalAssistantTools("local-user", [
      {
        id: "call-a2aj",
        name: "a2aj_fetch",
        input: { citation: "2099 SCC 1" },
      },
    ]);

    expect(queueProviderPdfAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "a2aj",
        identity: "SCC:2099 SCC 1",
        structureSource: "flat_text",
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/99999/1/document.do",
        canonicalUrl:
          "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99999/index.do",
      }),
    );
    expect(JSON.parse(response.content).pdf_fallback).toMatchObject({
      provider: "a2aj",
      reference_id: "reference-1",
    });

    queueProviderPdfAttachment.mockClear();
    const [lookupResponse] = await runLocalAssistantTools("local-user", [
      {
        id: "lookup-a2aj",
        name: "a2aj_lookup",
        input: {
          citation: "2099 SCC 1",
          locator_type: "paragraph",
          locator: "1",
        },
      },
    ]);
    expect(queueProviderPdfAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "a2aj",
        identity: "SCC:2099 SCC 1",
        structureSource: "flat_text",
      }),
    );
    expect(JSON.parse(lookupResponse.content).pdf_fallback).toMatchObject({
      provider: "a2aj",
      reference_id: "reference-1",
    });
  });
});
