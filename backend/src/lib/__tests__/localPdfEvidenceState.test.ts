import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLocalVersionFile: vi.fn(),
  readLocalPdfEvidenceReceipt: vi.fn(),
  rehydrateLocalPdfLinkEvidence: vi.fn(),
}));

vi.mock("../localDocumentStore", () => ({
  getLocalVersionFile: mocks.getLocalVersionFile,
}));

vi.mock("../localPdfLookup", () => ({
  readLocalPdfEvidenceReceipt: mocks.readLocalPdfEvidenceReceipt,
  rehydrateLocalPdfLinkEvidence: mocks.rehydrateLocalPdfLinkEvidence,
}));

import { appendLocalPdfPinpointLinks } from "../chat/localPdfEvidenceState";

const handle = `mike-evidence:v1:${"a".repeat(64)}`;
const secondHandle = `mike-evidence:v1:${"b".repeat(64)}`;
const evidence = {
  url: "/single-documents/document-1/display?version_id=version-1#page=7",
  blockText:
    "The governing rule applies in these circumstances. The remedy is limited to damages.",
  documentText:
    "Introduction. The governing rule applies in these circumstances. The remedy is limited to damages. Conclusion.",
  pageScoped: true as const,
};

beforeEach(() => {
  mocks.getLocalVersionFile.mockReset();
  mocks.readLocalPdfEvidenceReceipt.mockReset();
  mocks.rehydrateLocalPdfLinkEvidence.mockReset();
  mocks.readLocalPdfEvidenceReceipt.mockResolvedValue({
    source: { document_id: "document-1", version_id: "version-1" },
  });
  mocks.getLocalVersionFile.mockResolvedValue({
    fileType: "pdf",
    path: "C:\\data\\fixture.pdf",
    version: { filename: "fixture.pdf" },
  });
  mocks.rehydrateLocalPdfLinkEvidence.mockResolvedValue({
    handle,
    documentId: "document-1",
    versionId: "version-1",
    pages: [{ pageNumber: 7, label: "[page 7]", evidence }],
  });
});

describe("local PDF chat link finalization", () => {
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
      "/single-documents/document-1/display?version_id=version-1#page=7:~:text=",
    );
    expect(linked.match(/text=/gu)).toHaveLength(2);
    expect(linked).toContain("&text=");
  });

  it("leaves the answer alone when text mismatches or evidence drifts", async () => {
    const answer = 'The court said "A different proposition entirely."';
    await expect(
      appendLocalPdfPinpointLinks(answer, "local-user", new Set([handle])),
    ).resolves.toBe(answer);

    mocks.rehydrateLocalPdfLinkEvidence.mockRejectedValueOnce(
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
    expect(mocks.rehydrateLocalPdfLinkEvidence).not.toHaveBeenCalled();
  });
});
