import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchA2AJDocument: vi.fn(),
  getA2AJDocumentSourceDoc: vi.fn(),
  lookupA2AJLocator: vi.fn(),
  getCourtlistenerCases: vi.fn(),
  getCourtlistenerOpinionStructure: vi.fn(),
  lookupCourtlistenerOpinionLocator: vi.fn(),
  verifyCourtlistenerCitations: vi.fn(),
  fetchJournalArticle: vi.fn(),
  lookupJournalArticle: vi.fn(),
  searchJournalArticles: vi.fn(),
  fetchGovInfoCase: vi.fn(),
  fetchGovUkEtCase: vi.fn(),
  fetchTnaCase: vi.fn(),
  lookupPublicLegalSource: vi.fn(),
  searchGovInfoCase: vi.fn(),
  searchGovUkEtCase: vi.fn(),
  searchTnaCase: vi.fn(),
}));

vi.mock("../a2aj", () => ({
  fetchA2AJDocument: mocks.fetchA2AJDocument,
  getA2AJDocumentSourceDoc: mocks.getA2AJDocumentSourceDoc,
  lookupA2AJLocator: mocks.lookupA2AJLocator,
}));
vi.mock("../courtlistener", () => ({
  getCourtlistenerCases: mocks.getCourtlistenerCases,
  getCourtlistenerOpinionStructure: mocks.getCourtlistenerOpinionStructure,
  lookupCourtlistenerOpinionLocator: mocks.lookupCourtlistenerOpinionLocator,
  verifyCourtlistenerCitations: mocks.verifyCourtlistenerCitations,
}));
vi.mock("../journalArticles", () => ({
  fetchJournalArticle: mocks.fetchJournalArticle,
  lookupJournalArticle: mocks.lookupJournalArticle,
  searchJournalArticles: mocks.searchJournalArticles,
}));
vi.mock("../publicLegalSources", () => ({
  fetchGovInfoCase: mocks.fetchGovInfoCase,
  fetchGovUkEtCase: mocks.fetchGovUkEtCase,
  fetchTnaCase: mocks.fetchTnaCase,
  lookupPublicLegalSource: mocks.lookupPublicLegalSource,
  searchGovInfoCase: mocks.searchGovInfoCase,
  searchGovUkEtCase: mocks.searchGovUkEtCase,
  searchTnaCase: mocks.searchTnaCase,
}));

import {
  resolveDocxCitationLinks,
  type DocxCitationIntent,
  type DocxCitationLinkPlan,
} from "../docxCitationLinking";
import { createSourceDoc } from "../sourceDoc";

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

function structure(
  provider: "a2aj" | "courtlistener" | "tna" | "journal",
  id: string,
  url: string,
) {
  const text = "The canonical provider rendition contains the cited rule.";
  return createSourceDoc({
    provider,
    id,
    url,
    docType: "cases",
    text,
    blocks: [
      {
        kind: "paragraph",
        label: "par1",
        start: 0,
        end: text.length,
        origin: "native",
      },
    ],
  });
}

describe("DOCX citation SourceDoc wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const a2ajUrl = "https://www.canlii.org/en/ca/scc/doc/2024/2024scc10/";
    const courtlistenerUrl =
      "https://www.courtlistener.com/opinion/42/example/";
    const tnaUrl = "https://caselaw.nationalarchives.gov.uk/uksc/2025/12";
    const journalUrl = "https://example.test/journal/1";
    const a2ajStructure = structure("a2aj", "2024 SCC 10", a2ajUrl);
    const courtlistenerStructure = structure(
      "courtlistener",
      "7",
      courtlistenerUrl,
    );
    const tnaStructure = structure("tna", "[2025] UKSC 12", tnaUrl);
    const journalStructure = structure("journal", "1", journalUrl);

    mocks.fetchA2AJDocument.mockResolvedValue({
      citation: "2024 SCC 10",
      url: a2ajUrl,
      text: "Bounded transport excerpt.",
    });
    mocks.getA2AJDocumentSourceDoc.mockReturnValue(a2ajStructure);
    mocks.verifyCourtlistenerCitations.mockResolvedValue({
      citationLinks: [{ clusterId: 42 }],
    });
    mocks.getCourtlistenerCases.mockResolvedValue({
      cases: [
        {
          url: courtlistenerUrl,
          opinions: [
            { opinionId: 7, url: courtlistenerUrl, text: "Bounded excerpt." },
          ],
        },
      ],
    });
    mocks.getCourtlistenerOpinionStructure.mockReturnValue(
      courtlistenerStructure,
    );
    mocks.searchTnaCase.mockResolvedValue({ id: "[2025] UKSC 12" });
    mocks.fetchTnaCase.mockResolvedValue({
      provider: "tna",
      identity: "[2025] UKSC 12",
      title: "Example v State",
      url: tnaUrl,
      text: "Bounded transport excerpt.",
      structure: tnaStructure,
      attachments: [],
    });
    mocks.fetchJournalArticle.mockReturnValue({
      provider: "journal",
      identity: "42 Alta L Rev 1",
      title: "Article",
      url: journalUrl,
      text: "Bounded transport excerpt.",
      structure: journalStructure,
    });
  });

  it("verifies all provider links against their canonical rendition", async () => {
    const plan: DocxCitationLinkPlan = {
      schema_version: "legalpdf.docx_link_plan.v1",
      source_sha256: "abc",
      footnotes: [
        {
          parts: [
            intent("a2aj", "case", "2024 SCC 10"),
            intent("courtlistener", "case", "467 U.S. 837"),
            intent("public", "case", "[2025] UKSC 12"),
            intent("journal", "journal", "42 Alta L Rev 1"),
          ],
        },
      ],
    };

    const resolved = await resolveDocxCitationLinks(plan);

    expect(resolved.unresolved).toEqual([]);
    expect(resolved.providers).toEqual({
      a2aj: 1,
      courtlistener: 1,
      public: 1,
      journal: 1,
    });
    expect(Object.values(resolved.links)).toHaveLength(4);
    expect(
      Object.values(resolved.links).every((url) => url.includes(":~:text=")),
    ).toBe(true);
  });
});
