import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LegalSourcePassage,
  LegalSourceReference,
} from "../legalSources";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  read: vi.fn(),
  url: vi.fn(),
}));

vi.mock("../legalSourceRegistry", () => ({
  resolveLegalSource: mocks.resolve,
  readLegalSourcePassage: mocks.read,
  legalSourcePassageUrl: mocks.url,
  legalSourceProviderFamily: ({ source }: LegalSourcePassage) =>
    source.family ?? source.provider,
}));

import {
  resolveDocxCitationLinks,
  type DocxCitationIntent,
  type DocxCitationLinkPlan,
} from "../docxCitationLinking";

function intent(
  partId: string,
  kind: string,
  citation: string,
): DocxCitationIntent {
  return {
    part_id: partId,
    verbatim: citation,
    kind,
    bare_citation: citation,
    citation_with_style: citation,
    short_form: "",
    support_quote: "canonical provider rendition",
    locator_kind: "none",
    locator: "",
  };
}

const references: Record<string, LegalSourceReference> = {
  "2024 SCC 10": {
    provider: "a2aj",
    id: "2024 SCC 10",
    kind: "case",
    url: "https://www.canlii.org/en/ca/scc/doc/2024/2024scc10/",
  },
  "467 U.S. 837": {
    provider: "courtlistener",
    id: "42",
    kind: "case",
    url: "https://www.courtlistener.com/opinion/42/example/",
  },
  "[2025] UKSC 12": {
    provider: "tna",
    family: "public",
    id: "[2025] UKSC 12",
    kind: "case",
    url: "https://caselaw.nationalarchives.gov.uk/uksc/2025/12",
  },
  "42 Alta L Rev 1": {
    provider: "journal",
    id: "1",
    kind: "journal",
    url: "https://example.test/journal/1",
  },
};

describe("DOCX citation legal-source wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockImplementation(async ({ text }: { text: string }) => {
      const source = references[text];
      return source
        ? { status: "found", value: source }
        : { status: "not_found", providers: [] };
    });
    mocks.read.mockImplementation(
      async ({ source }: { source: LegalSourceReference }) => ({
        status: "found",
        values: [{
          source,
          locator: { requested: null, label: "document" },
          role: "document",
          text: "The canonical provider rendition contains the cited rule.",
          textSha256: "passage",
          documentSha256: "document",
          revision: "document",
        } satisfies LegalSourcePassage],
      }),
    );
    mocks.url.mockImplementation(
      (passage: LegalSourcePassage) =>
        `${passage.source.url}#:~:text=canonical%20provider%20rendition`,
    );
  });

  it("uses the shared registry for every supported provider family", async () => {
    const plan: DocxCitationLinkPlan = {
      schema_version: "legalpdf.docx_link_plan.v1",
      source_sha256: "abc",
      footnotes: [{
        parts: [
          intent("a2aj", "case", "2024 SCC 10"),
          intent("courtlistener", "case", "467 U.S. 837"),
          intent("public", "case", "[2025] UKSC 12"),
          intent("journal", "journal", "42 Alta L Rev 1"),
        ],
      }],
    };

    const resolved = await resolveDocxCitationLinks(plan);

    expect(resolved.unresolved).toEqual([]);
    expect(resolved.providers).toEqual({
      a2aj: 1,
      courtlistener: 1,
      public: 1,
      journal: 1,
    });
    expect(mocks.resolve).toHaveBeenCalledTimes(4);
    expect(mocks.read).toHaveBeenCalledTimes(4);
    expect(Object.values(resolved.links).every((url) => url.includes(":~:text=")))
      .toBe(true);
  });

  it("leaves a citation unresolved when Read returns more than one selected passage", async () => {
    mocks.read.mockImplementationOnce(
      async ({ source }: { source: LegalSourceReference }) => ({
        status: "found",
        values: ["first", "second"].map((text) => ({
          source,
          locator: { requested: null, label: "document" },
          role: "document" as const,
          text,
          textSha256: text,
          documentSha256: "document",
          revision: "document",
        })),
      }),
    );
    const citation = intent("ambiguous", "case", "2024 SCC 10");

    const resolved = await resolveDocxCitationLinks({
      schema_version: "legalpdf.docx_link_plan.v1",
      source_sha256: "abc",
      footnotes: [{ parts: [citation] }],
    });

    expect(resolved.links).toEqual({});
    expect(resolved.unresolved).toEqual([{
      part_id: "ambiguous",
      reason: "No unique verified provider match",
    }]);
    expect(mocks.url).not.toHaveBeenCalled();
  });
});
