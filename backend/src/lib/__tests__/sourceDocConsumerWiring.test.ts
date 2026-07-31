import { beforeEach, describe, expect, it, vi } from "vitest";

const getCourtlistenerOpinionStructure = vi.hoisted(() => vi.fn());

vi.mock("../courtlistener", () => ({
  getCourtlistenerOpinionStructure,
}));

import {
  appendPublicLegalPinpointLinks,
  buildPublicLegalCitationUrl,
  createPublicLegalSourceState,
} from "../chat/publicLegalSourceState";
import { buildCourtlistenerCitationPinpointUrl } from "../legalSourceLinks";
import { createSourceDoc } from "../sourceDoc";

function nativeParagraph(
  provider: "courtlistener" | "tna",
  id: string,
  url: string,
  text: string,
  anchor: string,
) {
  return createSourceDoc({
    provider,
    id,
    url,
    docType: "cases",
    text,
    blocks: [
      {
        kind: "paragraph",
        label: "par24",
        start: 0,
        end: text.length,
        origin: "native",
        anchor,
      },
    ],
  });
}

describe("canonical SourceDoc consumers", () => {
  beforeEach(() => {
    getCourtlistenerOpinionStructure.mockReset();
  });

  it("builds CourtListener fragments from the native rendition, not compact transport text", () => {
    const url = "https://www.courtlistener.com/opinion/42/example/";
    const structure = nativeParagraph(
      "courtlistener",
      "7",
      url,
      "The court adopted the distinctive first proposition and then applied the separate second proposition.",
      "p-24",
    );
    getCourtlistenerOpinionStructure.mockReturnValue(structure);

    const result = buildCourtlistenerCitationPinpointUrl(
      {
        quotes: [
          { opinionId: 7, quote: "distinctive first proposition" },
          { opinionId: 7, quote: "separate second proposition" },
        ],
      },
      {
        url,
        opinions: [
          {
            opinionId: 7,
            url,
            text: "A bounded transport excerpt without either quotation.",
          },
        ],
      },
    )!;

    expect(result).toContain("#p-24:~:text=");
    expect(result.match(/text=/gu)).toHaveLength(2);
  });

  it("keeps quotes from separate CourtListener opinions in their own SourceDocs", () => {
    const url = "https://www.courtlistener.com/opinion/42/example/";
    const first = nativeParagraph(
      "courtlistener",
      "7",
      url,
      "The majority adopted the distinctive majority proposition.",
      "majority",
    );
    const second = nativeParagraph(
      "courtlistener",
      "8",
      url,
      "The dissent stated the separate dissenting proposition.",
      "dissent",
    );
    getCourtlistenerOpinionStructure.mockImplementation(
      (opinion: { opinionId: number }) =>
        opinion.opinionId === 7 ? first : second,
    );

    const result = buildCourtlistenerCitationPinpointUrl(
      {
        quotes: [
          { opinionId: 7, quote: "distinctive majority proposition" },
          { opinionId: 8, quote: "separate dissenting proposition" },
        ],
      },
      {
        url,
        opinions: [
          { opinionId: 7, text: "Bounded majority excerpt." },
          { opinionId: 8, text: "Bounded dissent excerpt." },
        ],
      },
    )!;

    expect(result.match(/text=/gu)).toHaveLength(2);
  });

  it("matches public citations inside the recorded block of the native rendition", () => {
    const state = createPublicLegalSourceState();
    const url = "https://caselaw.nationalarchives.gov.uk/uksc/2024/1";
    const text =
      "The canonical phrase appears only in the native provider rendition.";
    const structure = nativeParagraph("tna", "[2024] UKSC 1", url, text, "para_24");
    const document = {
      provider: "tna" as const,
      identity: "[2024] UKSC 1",
      title: "Example v State",
      url,
      text: "A bounded transport excerpt without the quotation.",
      structure,
      attachments: [],
    };
    const block = { ...structure.blocks[0], text };
    state.documents.set("tna:[2024] uksc 1", document);
    state.lookups.push({
      document,
      lookup: {
        status: "found",
        requestedLabel: "par24",
        matches: ["par24"],
        block,
        before: [],
        after: [],
        provider: "tna",
        citation: "[2024] UKSC 1",
        name: "Example v State",
        date: null,
        url,
        snippet: null,
        journalName: null,
        authors: null,
        anchor: "para_24",
      },
    });

    const citationUrl = buildPublicLegalCitationUrl(
      {
        provider: "tna",
        identifier: "[2024] UKSC 1",
        quotes: [{ quote: "canonical phrase appears only" }],
      },
      state,
    )!;
    const appended = appendPublicLegalPinpointLinks(
      'The court said "canonical phrase appears only" [1].',
      state,
    );

    expect(citationUrl).toContain("#para_24:~:text=");
    expect(appended).toContain("#para_24:~:text=");
  });
});
