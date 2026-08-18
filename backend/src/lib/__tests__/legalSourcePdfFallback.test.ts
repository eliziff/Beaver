import { beforeEach, describe, expect, it, vi } from "vitest";

const queueProviderPdfAttachment = vi.hoisted(() => vi.fn());

vi.mock("../providerPdfLibraryBridge", () => ({ queueProviderPdfAttachment }));

import { legalSourcePdfFallbacks } from "../chat/legalSourcePdfFallback";
import type { RemoteLegalSourceDocument } from "../legalSources/remoteProvider";
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

describe("legal-source PDF fallback", () => {
  it("queues every distinct flat-text GovInfo PDF", async () => {
    const document: RemoteLegalSourceDocument = {
      provider: "govinfo",
      identity: fallback.identity,
      title: "United States v. Example",
      url: `https://www.govinfo.gov/app/details/${fallback.identity}`,
      structure: createSourceDoc({
        provider: "govinfo",
        id: fallback.identity,
        text: "United States v. Example\n1:22-cv-00930",
        blocks: [],
      }),
      attachments: [
        {
          title: "Decision",
          url: `https://api.govinfo.gov/packages/${fallback.identity}/pdf`,
          contentType: "application/pdf",
          filename: "decision.pdf",
          pageCount: 12,
        },
        {
          title: "Appendix",
          url: `https://www.govinfo.gov/content/pkg/${fallback.identity}/pdf/appendix.pdf`,
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

    const queued = await legalSourcePdfFallbacks(document, "local-user");

    expect(queueProviderPdfAttachment).toHaveBeenCalledTimes(2);
    expect(queueProviderPdfAttachment).toHaveBeenCalledWith({
      provider: "govinfo",
      identity: document.identity,
      structureSource: "flat_text",
      url: document.attachments[0].url,
      canonicalUrl: document.url,
      filename: "decision.pdf",
      title: "Decision",
    });
    expect(queued).toMatchObject([
      { reference_id: "reference-1", attachment_title: "Decision" },
      { reference_id: "reference-2", attachment_title: "Appendix" },
    ]);
  });

  it("does not import a PDF when TNA supplied native structure", async () => {
    const text = "Native judgment text.";
    const document: RemoteLegalSourceDocument = {
      provider: "tna",
      identity: "[2026] UKSC 1",
      title: "Example v Secretary of State",
      url: "https://caselaw.nationalarchives.gov.uk/uksc/2026/1",
      structure: createSourceDoc({
        provider: "tna",
        id: "[2026] UKSC 1",
        text,
        blocks: [{
          kind: "paragraph",
          label: "par1",
          anchor: "para_1",
          start: 0,
          end: text.length,
          origin: "native",
        }],
      }),
      attachments: [{
        title: "Judgment PDF",
        url: "https://caselaw.nationalarchives.gov.uk/uksc/2026/1.pdf",
        contentType: "application/pdf",
        filename: "judgment.pdf",
        pageCount: null,
      }],
    };

    expect(await legalSourcePdfFallbacks(document, "local-user")).toEqual([]);
    expect(queueProviderPdfAttachment).not.toHaveBeenCalled();
  });
});
