import { describe, expect, it } from "vitest";
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

function courtlistenerPassageUrl(
  id: string,
  url: string,
  text: string,
  anchor: string,
  quotes: string[],
) {
  const structure = nativeParagraph("courtlistener", id, url, text, anchor);
  return legalSourcePassageUrl({
    source: {
      provider: "courtlistener",
      id,
      kind: "case",
      title: "Example v State",
      citation: "42 F.4th 1",
      url,
    },
    locator: {
      requested: { kind: "paragraph", value: "24" },
      label: "par24",
      anchor,
    },
    role: "selected",
    text,
    textSha256: "passage",
    documentSha256: structure.revision,
    revision: structure.revision,
    blockArtifact: text,
    documentArtifact: structure,
  }, quotes);
}

describe("canonical SourceDoc consumers", () => {
  it("builds CourtListener fragments from the canonical native passage", () => {
    const result = courtlistenerPassageUrl(
      "7",
      "https://www.courtlistener.com/opinion/42/example/",
      "The court adopted the distinctive first proposition and then applied the separate second proposition.",
      "p-24",
      ["distinctive first proposition", "separate second proposition"],
    )!;

    expect(result).toContain("#p-24:~:text=");
    expect(result.match(/text=/gu)).toHaveLength(2);
  });

  it("keeps separate CourtListener opinions in separate SourceDocs", () => {
    const url = "https://www.courtlistener.com/opinion/42/example/";
    const majority = courtlistenerPassageUrl(
      "7", url,
      "The majority adopted the distinctive majority proposition.",
      "majority", ["distinctive majority proposition"],
    )!;
    const dissent = courtlistenerPassageUrl(
      "8", url,
      "The dissent stated the separate dissenting proposition.",
      "dissent", ["separate dissenting proposition"],
    )!;

    expect(majority).toContain("#majority:~:text=");
    expect(dissent).toContain("#dissent:~:text=");
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
