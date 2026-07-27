import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createLocalPdfArtifactSession: vi.fn(),
  createLocalPdfLinkEvidenceSession: vi.fn(),
  getLocalVersionFile: vi.fn(),
  readLocalPdfEvidenceReceipt: vi.fn(),
  rehydrate: vi.fn(),
}));

vi.mock("../localDocumentStore", () => ({
  getLocalVersionFile: mocks.getLocalVersionFile,
}));

vi.mock("../localPdfLookup", () => ({
  createLocalPdfArtifactSession:
    mocks.createLocalPdfArtifactSession,
  createLocalPdfLinkEvidenceSession:
    mocks.createLocalPdfLinkEvidenceSession,
  readLocalPdfEvidenceReceipt: mocks.readLocalPdfEvidenceReceipt,
}));

import {
  appendLocalPdfPinpointLinks,
  localPdfArtifactSessionForTurn,
  providerPdfReferencesForTurn,
  registerProviderPdfEvidenceForTurn,
} from "../chat/localPdfEvidenceState";

const handle = `mike-evidence:v1:${"a".repeat(64)}`;
const secondHandle = `mike-evidence:v1:${"b".repeat(64)}`;
const evidence = {
  url:
    `/single-documents/document-1/evidence-view?version_id=version-1` +
    `&evidence=${encodeURIComponent(handle)}#page=7`,
  blockText:
    "The governing rule applies in these circumstances. The remedy is limited to damages.",
  documentText:
    "Introduction. The governing rule applies in these circumstances. The remedy is limited to damages. Conclusion.",
  pageScoped: true as const,
};

beforeEach(() => {
  mocks.getLocalVersionFile.mockReset();
  mocks.readLocalPdfEvidenceReceipt.mockReset();
  mocks.createLocalPdfArtifactSession.mockReset();
  mocks.createLocalPdfLinkEvidenceSession.mockReset();
  mocks.rehydrate.mockReset();
  mocks.readLocalPdfEvidenceReceipt.mockResolvedValue({
    source: { document_id: "document-1", version_id: "version-1" },
    evidence: {
      artifact_ids: ["paragraph-7"],
      context_artifact_ids: [],
    },
  });
  mocks.getLocalVersionFile.mockResolvedValue({
    fileType: "pdf",
    path: "C:\\data\\fixture.pdf",
    version: { filename: "fixture.pdf" },
  });
  mocks.createLocalPdfArtifactSession.mockReturnValue({
    source: "C:\\data\\fixture.pdf",
  });
  mocks.rehydrate.mockResolvedValue({
    handle,
    documentId: "document-1",
    versionId: "version-1",
    href: evidence.url,
    label: "[page 7]",
    blockText: evidence.blockText,
    documentText: evidence.documentText,
    pageScoped: true,
    pageNumbers: [7],
    sources: [
      {
        key: "paragraph:paragraph-7",
        label: "[page 7]",
        href: evidence.url,
        blockText: evidence.blockText,
        documentText: evidence.documentText,
        pageScoped: true,
        pageNumbers: [7],
      },
    ],
    pages: [{ pageNumber: 7, label: "[page 7]", evidence }],
  });
  mocks.createLocalPdfLinkEvidenceSession.mockReturnValue({
    rehydrate: mocks.rehydrate,
  });
});

describe("local PDF chat link finalization", () => {
  it("reuses one artifact session for a source throughout a turn", () => {
    const handles = new Set<string>();
    const first = localPdfArtifactSessionForTurn(
      handles,
      "C:\\data\\fixture.pdf",
    );
    const second = localPdfArtifactSessionForTurn(
      handles,
      "C:\\data\\fixture.pdf",
    );

    expect(second).toBe(first);
    expect(mocks.createLocalPdfArtifactSession).toHaveBeenCalledTimes(1);
  });

  it("builds one verified multi-text link for disjoint quotes on a page", async () => {
    const answer =
      'The court said "The governing rule applies in these circumstances" and "The remedy is limited to damages."';
    const linked = await appendLocalPdfPinpointLinks(
      answer,
      "local-user",
      new Set([handle]),
    );

    expect(linked).toContain("[fixture.pdf, p. 7]");
    expect(linked).toContain(
      `/single-documents/document-1/evidence-view?version_id=version-1&evidence=${encodeURIComponent(handle)}#page=7:~:text=`,
    );
    expect(linked.match(/text=/gu)).toHaveLength(2);
    expect(linked).toContain("&text=");
  });

  it("retains mirror references and fails closed when provenance is ambiguous", async () => {
    const handles = new Set([handle]);
    const firstReference =
      `mike-provider-pdf:v1:govinfo:${"1".repeat(64)}:${"2".repeat(64)}`;
    const secondReference =
      `mike-provider-pdf:v1:courtlistener:${"3".repeat(64)}:${"2".repeat(64)}`;
    const linkEvidence = {
      handle,
      documentId: "provider-pdf-mirror",
      versionId: "2".repeat(32),
      href: "/unused",
      label: "[page 7]",
      blockText: evidence.blockText,
      documentText: evidence.documentText,
      pageScoped: true,
      pageNumbers: [7],
      sources: [
        {
          key: "paragraph:paragraph-7",
          label: "[page 7]",
          href: "/unused",
          blockText: evidence.blockText,
          documentText: evidence.documentText,
          pageScoped: true,
          pageNumbers: [7],
        },
      ],
      pages: [],
    };
    registerProviderPdfEvidenceForTurn(
      handles,
      handle,
      firstReference,
      "https://www.govinfo.gov/content/pkg/example/pdf/example.pdf",
      "GovInfo mirror",
      linkEvidence,
    );
    registerProviderPdfEvidenceForTurn(
      handles,
      handle,
      secondReference,
      "https://storage.courtlistener.com/example.pdf",
      "CourtListener mirror",
      linkEvidence,
    );
    const answer =
      'The court said "The governing rule applies in these circumstances."';

    expect(providerPdfReferencesForTurn(handles, handle)).toEqual([
      firstReference,
      secondReference,
    ]);
    await expect(
      appendLocalPdfPinpointLinks(answer, "local-user", handles),
    ).resolves.toBe(answer);
    expect(mocks.readLocalPdfEvidenceReceipt).not.toHaveBeenCalled();
  });

  it("leaves the answer alone when text mismatches or evidence drifts", async () => {
    const answer = 'The court said "A different proposition entirely."';
    await expect(
      appendLocalPdfPinpointLinks(answer, "local-user", new Set([handle])),
    ).resolves.toBe(answer);

    mocks.rehydrate.mockRejectedValueOnce(
      new Error("artifact drift"),
    );
    await expect(
      appendLocalPdfPinpointLinks(
        'The court said "The governing rule applies in these circumstances."',
        "local-user",
        new Set([handle]),
      ),
    ).resolves.toBe(
      'The court said "The governing rule applies in these circumstances."',
    );
  });

  it("skips disk work without quotes and deduplicates repeated page evidence", async () => {
    await expect(
      appendLocalPdfPinpointLinks(
        "The court applied the governing rule.",
        "local-user",
        new Set([handle]),
      ),
    ).resolves.toBe("The court applied the governing rule.");
    expect(mocks.readLocalPdfEvidenceReceipt).not.toHaveBeenCalled();

    const answer =
      'The court said "The governing rule applies in these circumstances."';
    const linked = await appendLocalPdfPinpointLinks(
      answer,
      "local-user",
      new Set([handle, secondHandle]),
    );
    expect(linked.match(/\[fixture\.pdf, p\. 7\]/gu)).toHaveLength(1);
    expect(mocks.createLocalPdfLinkEvidenceSession).toHaveBeenCalledTimes(1);
    expect(mocks.createLocalPdfLinkEvidenceSession).toHaveBeenCalledWith(
      "C:\\data\\fixture.pdf",
      expect.objectContaining({ source: "C:\\data\\fixture.pdf" }),
    );
  });

  it("deduplicates the selected unit while retaining context-unit links", async () => {
    const selected =
      "The governing rule applies in these circumstances.";
    const before = "The court first described the governing framework.";
    const after = "The court then limited the available remedy.";
    const documentText = `${before} ${selected} ${after}`;
    const source = (
      key: string,
      page: number,
      blockText: string,
      sourceHandle: string,
    ) => ({
      key,
      label: `[page ${page}]`,
      href:
        `/single-documents/document-1/evidence-view?version_id=version-1` +
        `&evidence=${encodeURIComponent(sourceHandle)}#page=${page}`,
      blockText,
      documentText,
      pageScoped: true,
      pageNumbers: [page],
    });
    const selectedSource = source(
      "paragraph:paragraph-7",
      7,
      selected,
      handle,
    );
    mocks.rehydrate
      .mockResolvedValueOnce({
        handle,
        documentId: "document-1",
        versionId: "version-1",
        sources: [selectedSource],
      })
      .mockResolvedValueOnce({
        handle: secondHandle,
        documentId: "document-1",
        versionId: "version-1",
        sources: [
          source("paragraph:paragraph-6", 6, before, secondHandle),
          source(
            "paragraph:paragraph-7",
            7,
            selected,
            secondHandle,
          ),
          source("paragraph:paragraph-8", 8, after, secondHandle),
        ],
      });

    const linked = await appendLocalPdfPinpointLinks(
      `"${before}" "${selected}" "${after}"`,
      "local-user",
      new Set([handle, secondHandle]),
    );
    expect(linked.match(/\[fixture\.pdf, p\. 7\]/gu)).toHaveLength(1);
    expect(linked).toContain("[fixture.pdf, p. 6]");
    expect(linked).toContain("[fixture.pdf, p. 8]");
    expect(linked).toContain(
      `evidence=${encodeURIComponent(handle)}#page=7:~:text=`,
    );
    expect(linked).not.toContain(
      `evidence=${encodeURIComponent(secondHandle)}#page=7:~:text=`,
    );
  });

  it("rechecks matter scope before reading a durable handle", async () => {
    const answer =
      'The court said "The governing rule applies in these circumstances."';
    await expect(
      appendLocalPdfPinpointLinks(
        answer,
        "local-user",
        new Set([handle]),
        new Set(["other-document"]),
      ),
    ).resolves.toBe(answer);
    expect(mocks.getLocalVersionFile).not.toHaveBeenCalled();
    expect(mocks.rehydrate).not.toHaveBeenCalled();
  });
});
