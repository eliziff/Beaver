import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSourceDoc } from "../sourceDoc";

const mocks = vi.hoisted(() => ({
  createLocalPdfLinkEvidenceSession: vi.fn(),
  getLocalVersionFile: vi.fn(),
  readLocalPdfEvidenceReceipt: vi.fn(),
  rehydrateProviderPdfReference: vi.fn(),
  rehydratePublicLegalEvidence: vi.fn(),
}));

vi.mock("../localPdfLookup", () => ({
  createLocalPdfLinkEvidenceSession: mocks.createLocalPdfLinkEvidenceSession,
  readLocalPdfEvidenceReceipt: mocks.readLocalPdfEvidenceReceipt,
}));
vi.mock("../localDocumentStore", () => ({
  getLocalVersionFile: mocks.getLocalVersionFile,
}));
vi.mock("../publicLegalSources", () => ({
  rehydratePublicLegalEvidence: mocks.rehydratePublicLegalEvidence,
}));
vi.mock("../providerPdfLibraryBridge", () => ({
  rehydrateProviderPdfReference: mocks.rehydrateProviderPdfReference,
}));

import { resolveDocxEvidenceCitations } from "../docxEvidenceCitations";

const providerHandles = [
  `mike-provider-evidence:v1:${"a".repeat(64)}`,
  `mike-provider-evidence:v1:${"b".repeat(64)}`,
];
const localHandle = `mike-evidence:v1:${"c".repeat(64)}`;

function providerEvidence(handle: string, index: number) {
  const contexts = ["Alpha context", "Beta context"];
  const paragraphs = [
    "Alpha context explains why the same rule applies uniquely here. End alpha.",
    "Beta context explains why the same rule applies uniquely here. End beta.",
  ];
  const documentText = paragraphs.join("\n");
  const starts = [0, paragraphs[0].length + 1];
  const structure = createSourceDoc({
    provider: "tna",
    id: "[2024] UKSC 1",
    text: documentText,
    blocks: paragraphs.map((text, position) => ({
      kind: "paragraph",
      label: `par${position + 1}`,
      anchor: `para_${position + 1}`,
      origin: "native",
      start: starts[position],
      end: starts[position] + text.length,
    })),
  });
  return {
    document: {
      provider: "tna",
      identity: "[2024] UKSC 1",
      title: "Example v State",
      url: "https://caselaw.nationalarchives.gov.uk/uksc/2024/1",
      text: "A bounded transport excerpt that omits the cited passages.",
      structure,
    },
    lookup: {
      status: "found",
      block: {
        kind: "paragraph",
        label: `para ${index + 1}`,
        anchor: `para_${index + 1}`,
        text: paragraphs[index],
      },
    },
    receipt: {
      handle,
      source: {
        identifier: "[2024] UKSC 1",
        canonical_url: "https://caselaw.nationalarchives.gov.uk/uksc/2024/1",
        source_sha256: "d".repeat(64),
      },
      lookup: {
        locator_kind: "paragraph",
        locator: `para ${index + 1}`,
        provider_locator: `para_${index + 1}`,
      },
    },
  };
}

describe("DOCX evidence citations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rehydratePublicLegalEvidence.mockImplementation(
      async (handle: string) =>
        providerEvidence(handle, providerHandles.indexOf(handle)),
    );
  });

  it("builds one citation and one verified multi-text link", async () => {
    const resolved = await resolveDocxEvidenceCitations("local-user", [
      {
        id: "jordan",
        citation: "Example v State, [2024] UKSC 1",
        handles: providerHandles,
        quotes: [
          "the same rule applies uniquely here",
          "the same rule applies uniquely here",
        ],
      },
    ]);

    expect(resolved.citations.jordan.text).toBe(
      "Example v State, [2024] UKSC 1 at para. 1, para. 2",
    );
    expect(resolved.citations.jordan.url.match(/text=/gu)).toHaveLength(2);
    expect(resolved.bindings[0]).toMatchObject({
      handles: providerHandles,
      source_sha256: "d".repeat(64),
    });
  });

  it("rejects mixed evidence families and unowned local evidence", async () => {
    await expect(
      resolveDocxEvidenceCitations("local-user", [
        {
          id: "mixed",
          citation: "Mixed source",
          handles: [providerHandles[0], localHandle],
        },
      ]),
    ).rejects.toThrow("mixes evidence families");

    mocks.readLocalPdfEvidenceReceipt.mockResolvedValue({
      source: {
        document_id: "document-1",
        version_id: "version-1",
        source_sha256: "e".repeat(64),
      },
      lookup: { locatorKind: "page", locator: "7" },
      evidence: { artifact_ids: ["page-7"] },
    });
    await expect(
      resolveDocxEvidenceCitations(
        "local-user",
        [
          {
            id: "local",
            citation: "Owned PDF",
            handles: [localHandle],
          },
        ],
        new Set(["different-document"]),
      ),
    ).rejects.toThrow("outside this document set");
    expect(mocks.getLocalVersionFile).not.toHaveBeenCalled();
  });
});
