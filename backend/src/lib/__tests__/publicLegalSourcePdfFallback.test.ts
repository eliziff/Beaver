import { beforeEach, describe, expect, it, vi } from "vitest";

const queueProviderPdfAttachment = vi.hoisted(() => vi.fn());

vi.mock("../providerPdfLibraryBridge", () => ({
  queueProviderPdfAttachment,
}));

import {
  createPublicLegalSourceState,
  executePublicLegalSourceTool,
} from "../chat/publicLegalSourceState";
import { PUBLIC_LEGAL_SOURCE_TOOL_NAMES } from "../chat/tools/publicLegalSourceTools";
import type { PublicLegalDocument } from "../publicLegalSources";
import { createSourceDoc } from "../sourceDoc";

const fallback = {
  provider: "govinfo",
  identity: "USCOURTS-cod-1_22-cv-00930",
  reference_id: "reference-1",
  download_status: "queued",
  parse_status: null,
};

beforeEach(() => {
  queueProviderPdfAttachment.mockReset();
  queueProviderPdfAttachment.mockResolvedValue(fallback);
});

function cachedState(document: PublicLegalDocument) {
  const state = createPublicLegalSourceState();
  state.documents.set(
    `${document.provider}:${document.identity.toLowerCase()}`,
    document,
  );
  return state;
}

describe("public legal source PDF fallback", () => {
  it("queues every distinct GovInfo PDF without delaying exact text", async () => {
    const document: PublicLegalDocument = {
      provider: "govinfo",
      identity: "USCOURTS-cod-1_22-cv-00930",
      title: "United States v. Example",
      url: "https://www.govinfo.gov/app/details/USCOURTS-cod-1_22-cv-00930",
      text: "United States v. Example\n1:22-cv-00930",
      structure: createSourceDoc({
        provider: "govinfo",
        id: "USCOURTS-cod-1_22-cv-00930",
        text: "United States v. Example\n1:22-cv-00930",
        blocks: [],
      }),
      attachments: [
        {
          title: "Decision",
          url: "https://api.govinfo.gov/packages/USCOURTS-cod-1_22-cv-00930/pdf",
          contentType: "application/pdf",
          filename: "decision.pdf",
          pageCount: 12,
        },
        {
          title: "Appendix",
          url: "https://www.govinfo.gov/content/pkg/USCOURTS-cod-1_22-cv-00930/pdf/appendix.pdf",
          contentType: null,
          filename: null,
          pageCount: 3,
        },
      ],
    };
    queueProviderPdfAttachment.mockImplementation(async ({ url }) => ({
      ...fallback,
      reference_id: url.endsWith("appendix.pdf")
        ? "reference-2"
        : "reference-1",
    }));
    const state = cachedState(document);
    const args = { provider: "govinfo", identifier: document.identity };

    const first = await executePublicLegalSourceTool(
      PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch,
      args,
      state,
      "local-user",
    );
    const second = await executePublicLegalSourceTool(
      PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch,
      args,
      state,
      "local-user",
    );

    expect(queueProviderPdfAttachment).toHaveBeenCalledTimes(4);
    expect(queueProviderPdfAttachment).toHaveBeenCalledWith({
      provider: "govinfo",
      identity: document.identity,
      structureSource: "flat_text",
      url: document.attachments[0].url,
      canonicalUrl: document.url,
      filename: "decision.pdf",
      title: "Decision",
    });
    expect(queueProviderPdfAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        url: document.attachments[1].url,
        title: "Appendix",
      }),
    );
    expect(first?.payload.pdf_fallbacks).toMatchObject([
      {
        reference_id: "reference-1",
        attachment_title: "Decision",
        attachment_filename: "decision.pdf",
      },
      {
        reference_id: "reference-2",
        attachment_title: "Appendix",
        attachment_filename: null,
      },
    ]);
    expect(second?.payload.pdf_fallbacks).toHaveLength(2);
  });

  it("does not import a PDF when TNA already supplied native structure", async () => {
    const document: PublicLegalDocument = {
      provider: "tna",
      identity: "[2026] UKSC 1",
      title: "Example v Secretary of State",
      url: "https://caselaw.nationalarchives.gov.uk/uksc/2026/1",
      text: "Native judgment text.",
      structure: createSourceDoc({
        provider: "tna",
        id: "[2026] UKSC 1",
        text: "Native judgment text.",
        blocks: [
          {
            kind: "paragraph",
            label: "par1",
            anchor: "para_1",
            start: 0,
            end: 21,
            origin: "native",
          },
        ],
      }),
      attachments: [
        {
          title: "Judgment PDF",
          url: "https://caselaw.nationalarchives.gov.uk/uksc/2026/1.pdf",
          contentType: "application/pdf",
          filename: "judgment.pdf",
          pageCount: null,
        },
      ],
    };
    const state = cachedState(document);
    const result = await executePublicLegalSourceTool(
      PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch,
      { provider: "tna", identifier: document.identity },
      state,
      "local-user",
    );

    expect(queueProviderPdfAttachment).not.toHaveBeenCalled();
    expect(result?.payload.pdf_fallbacks).toEqual([]);
  });

  it("registers a citeable passage receipt when a journal article is fetched", async () => {
    const document: PublicLegalDocument = {
      provider: "journal",
      identity: "8964",
      title: "Jordan at Five",
      url: "https://journal.example/8964.pdf",
      text: "The Court recognized that the presumptive ceiling governs delay.",
      citation: "(2020) 65:1 McGill LJ 1",
      date: "2020",
      structure: createSourceDoc({
        provider: "journal",
        id: "8964",
        text: "The Court recognized that the presumptive ceiling governs delay.",
        blocks: [],
      }),
      attachments: [],
    };
    const state = cachedState(document);
    const result = await executePublicLegalSourceTool(
      PUBLIC_LEGAL_SOURCE_TOOL_NAMES.fetch,
      { provider: "journal", identifier: document.identity },
      state,
      "local-user",
    );

    // The pulled article is a citeable unit: the visible payload carries
    // the evidence_id, and a passage-scope receipt (span = the article text
    // the model just read) flows out for the dispatcher to register.
    expect(result?.evidences).toHaveLength(1);
    const receipt = result!.evidences![0];
    expect(result?.payload.evidence_id).toBe(receipt.evidence_id);
    expect(result?.payload.citation).toBe("(2020) 65:1 McGill LJ 1");
    expect(receipt).toMatchObject({
      provider: "journal",
      source_class: "commentary",
      scope: "passage",
      resolver_version: "public-journal-v1",
      citation: "(2020) 65:1 McGill LJ 1",
      name: "Jordan at Five",
      version: "2020",
      span_text: document.text,
    });
    // A verbatim quote of the article clears the deterministic tier against
    // this span — proof the receipt is genuinely citeable.
    const { createLegalEvidenceTurnState, registerLegalEvidence, submitLegalEvidenceAnswer } =
      await import("../chat/legalEvidence");
    const turnState = createLegalEvidenceTurnState();
    registerLegalEvidence(turnState, receipt);
    expect(submitLegalEvidenceAnswer({ claims: [{
      text: "The Court recognized that the presumptive ceiling governs delay.",
      evidence_ids: [receipt.evidence_id],
    }] }, turnState).ok).toBe(true);
  });
});
