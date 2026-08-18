import { beforeEach, describe, expect, it, vi } from "vitest";

const getCourtlistenerOpinionStructure = vi.hoisted(() => vi.fn());

vi.mock("../courtlistener", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../courtlistener")>()),
  getCourtlistenerOpinionStructure,
}));

import { buildCourtlistenerCitationPinpointUrl } from "../legalSourceLinks";
import { legalSourcePassageUrl } from "../legalSourceRegistry";
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
    const lookup = {
        status: "found",
        requestedLabel: "par24",
        matches: ["par24"],
        block,
        before: [],
        after: [],
        provider: "tna",
        url,
        anchor: "para_24",
      } as const;
    const citationUrl = legalSourcePassageUrl({
      source: {
        provider: "tna",
        id: "[2024] UKSC 1",
        kind: "case",
        title: "Example v State",
        citation: "[2024] UKSC 1",
        url,
      },
      locator: {
        requested: { kind: "paragraph", value: "24" },
        label: "par24",
        anchor: "para_24",
      },
      role: "selected",
      text,
      textSha256: "passage",
      documentSha256: structure.revision,
      revision: structure.revision,
      blockArtifact: text,
      documentArtifact: structure,
      native: { document, lookup },
    }, ["canonical phrase appears only"]);

    expect(citationUrl).toContain("#para_24:~:text=");
  });
});
