import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { guardedRemoteFetch } = vi.hoisted(() => ({
  guardedRemoteFetch: vi.fn((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init)),
}));
vi.mock("../remoteUrlSafety", () => ({ guardedRemoteFetch }));

import {
  a2ajLegalSourceProvider,
} from "../legalSources/a2aj";

beforeEach(() => {
  guardedRemoteFetch.mockClear();
  // These tests exercise the HTTP contract. Keep a developer's installed
  // local corpus from silently bypassing the mocked provider response.
  vi.stubEnv(
    "MIKE_A2AJ_BULK_DB",
    path.join(os.tmpdir(), `beaver-a2aj-http-test-${crypto.randomUUID()}.sqlite`),
  );
});

afterEach(() => {
  a2ajLegalSourceProvider.clearCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("A2AJ client", () => {
  it("maps live coverage dimensions without a reduced jurisdiction list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              dataset: "ONCA",
              description_en: "Ontario Court of Appeal",
              number_of_documents: 42,
            },
            {
              dataset: "CHRT",
              description_en: "Canadian Human Rights Tribunal",
              number_of_documents: 8,
            },
          ],
        }),
      }),
    );

    await expect(a2ajLegalSourceProvider.coverage("cases")).resolves.toMatchObject([
      {
        dataset: "CHRT",
        jurisdictionCode: "FED",
        sourceKind: "tribunal",
      },
      {
        dataset: "ONCA",
        jurisdictionCode: "ON",
        sourceKind: "court",
      },
    ]);
  });

  it("maps a complete provider document", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            dataset: "SCC",
            citation_en: "2020 SCC 5",
            name_en: "Nevsun Resources Ltd. v. Araya",
            document_date_en: "2020-02-28",
            url_en: "https://decisions.scc-csc.ca/item/18169",
            unofficial_text_en: "abcdef",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const document = await a2ajLegalSourceProvider.document({ citation: "2020 SCC 5" });

    expect(document).toMatchObject({
      dataset: "SCC",
      citation: "2020 SCC 5",
      name: "Nevsun Resources Ltd. v. Araya",
      url: "https://decisions.scc-csc.ca/item/18169",
      text: "abcdef",
    });
    expect(guardedRemoteFetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api\.a2aj\.ca\/fetch\?citation=2020\+SCC\+5/u),
      expect.any(Object),
      expect.objectContaining({
        allowedHosts: ["api.a2aj.ca"],
        allowIpLiterals: false,
        defaultPortOnly: true,
        timeoutMs: 15_000,
        response: expect.objectContaining({ maxBytes: 64 * 1024 * 1024 }),
      }),
    );
  });

  it("maps search metadata without exposing the raw API payload", async () => {
    vi.stubEnv(
      "MIKE_A2AJ_BULK_DB",
      path.join(os.tmpdir(), `beaver-a2aj-missing-${process.pid}.sqlite`),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              dataset: "ONCA",
              citation_en: "2024 ONCA 1",
              name_en: "Example v. Example",
              url_en: "https://example.test/case",
              snippet: "A matching passage",
            },
          ],
        }),
      }),
    );

    await expect(a2ajLegalSourceProvider.search!({
      text: "privacy",
      kinds: ["case"],
      limit: 1,
    })).resolves.toEqual([
      {
        provider: "a2aj",
        id: "2024 ONCA 1",
        kind: "case",
        collection: "ONCA",
        citation: "2024 ONCA 1",
        alternateCitation: null,
        title: "Example v. Example",
        date: null,
        url: "https://example.test/case",
        snippet: "A matching passage",
      },
    ]);
  });

  it("indexes the full decision once and looks up one paragraph", async () => {
    const text = Array.from(
      { length: 6 },
      (_, index) =>
        `[${index + 1}] Decision paragraph ${index + 1} contains enough *substantive* judicial language to establish a reliable sequence.`,
    ).join("\n");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            dataset: "SCC",
            citation_en: "2099 SCC 1",
            unofficial_text_en: text,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const document = await a2ajLegalSourceProvider.document({ citation: "2099 SCC 1" });
    const lookup = await a2ajLegalSourceProvider.lookup({
      citation: "2099 SCC 1",
      kind: "paragraph",
      locator: "para 3",
      contextBlocks: 1,
    });
    const range = await a2ajLegalSourceProvider.lookup({
      citation: "2099 SCC 1",
      kind: "paragraph",
      locator: "2",
      endLocator: "4",
      contextBlocks: 1,
    });

    expect(document?.analysis?.source_doc.ranges.paragraph.count).toBe(6);
    expect(lookup).toMatchObject({
      status: "found",
      sourceMethod: "structure_index",
      block: { label: "par3" },
      before: [{ label: "par2" }],
      after: [{ label: "par4" }],
    });
    expect(lookup?.block?.text).toContain("Decision paragraph 3");
    expect(range).toMatchObject({
      status: "found",
      requested: { locator: "2-4", label: "par2-par4" },
      matches: ["par2", "par3", "par4"],
      block: { label: "par2-par4" },
      before: [{ label: "par1" }],
      after: [{ label: "par5" }],
    });
    expect(range?.block?.text).toContain("Decision paragraph 2");
    expect(range?.block?.text).toContain("Decision paragraph 4");
  });

  it("uses A2AJ's raw section map for nested provision lookup", async () => {
    const mappedText = [
      "34(1) Parent defence provision.",
      "(a) The requested nested statutory paragraph applies.",
      "(b) A sibling paragraph applies.",
    ].join("\n");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            dataset: "LEGISLATION-FED",
            citation_en: "RSC 1985, c C-46",
            name_en: "Criminal Code",
            unofficial_text_en: "Stale flattened text that the provider section map supersedes.",
            unofficial_sections_en: JSON.stringify({
              "34": mappedText,
            }),
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const document = await a2ajLegalSourceProvider.document({
      citation: "RSC 1985, c C-46",
      docType: "laws",
    });
    const lookup = await a2ajLegalSourceProvider.lookup({
      citation: "RSC 1985, c C-46",
      docType: "laws",
      kind: "section",
      locator: "s. 34(1)(a)",
    });

    expect(document).toMatchObject({
      docType: "laws",
      text: mappedText,
      sectionMap: sections,
    });
    const source = a2ajLegalSourceProvider.source(document!);
    expect(source.text).toBe(mappedText);
    expect(source.blocks.find(({ label }) => label === "sec34")).toMatchObject({
      label: "sec34",
      start: 0,
      end: mappedText.length,
      origin: "native",
    });
    expect(lookup).toMatchObject({
      status: "found",
      sourceMethod: "provider_section",
      block: { label: "sec34(1)(a)" },
    });
    expect(lookup?.block?.text).toContain(
      "requested nested statutory paragraph",
    );
  });

  it("looks up provider-native named, suffixed and combined map keys exactly", async () => {
    const sections = {
      Preamble: "Whereas the Legislature recognizes these principles.",
      "1": "First provision.",
      "2A": "Suffixed provision.",
      "202DI": "Later suffixed provision.",
      "4 and 4.1": "Combined provider provision.",
      "Schedule 1": "First schedule.",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            dataset: "LEGISLATION-TEST",
            citation_en: "RSC 2099, c P-1",
            name_en: "Provider Map Act",
            unofficial_text_en: "Stale flat rendition.",
            unofficial_sections_en: JSON.stringify(sections),
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const [locator, text] of Object.entries(sections).filter(
      ([locator]) => locator !== "1",
    )) {
      const lookup = await a2ajLegalSourceProvider.lookup({
        citation: "RSC 2099, c P-1",
        docType: "laws",
        kind: "section",
        locator,
      });
      expect(lookup).toMatchObject({
        status: "found",
        requested: { label: `sec${locator}` },
        matches: [`sec${locator}`],
        block: {
          label: `sec${locator}`,
          origin: "native",
          text,
        },
        sourceMethod: "provider_section",
      });
    }
  });

  it("refuses blank section renditions and normalized-key collisions", async () => {
    const record = {
      dataset: "LEGISLATION-TEST",
      citation_en: "RSC 2099, c C-2",
      name_en: "Provider Collision Act",
      unofficial_text_en: [
        "1 First reconstructed provision.",
        "2 Second reconstructed provision.",
        "3 Third reconstructed provision.",
      ].join("\n"),
      unofficial_sections_en: JSON.stringify({
        Preamble: "First provider preamble.",
        preamble: "Conflicting provider preamble.",
        "9": "[blank]",
      }),
    };
    const fetchMock = vi.fn(
      async (input: Parameters<typeof fetch>[0]) => ({
        ok: true,
        status: 200,
        json: async () => ({
          results: new URL(String(input)).searchParams.has("section")
            ? []
            : [record],
        }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      a2ajLegalSourceProvider.lookup({
        citation: "RSC 2099, c C-2",
        docType: "laws",
        kind: "section",
        locator: "Preamble",
      }),
    ).resolves.toMatchObject({
      status: "ambiguous",
      matches: ["secPreamble", "secpreamble"],
      sourceMethod: "provider_section",
    });
    await expect(
      a2ajLegalSourceProvider.lookup({
        citation: "RSC 2099, c C-2",
        docType: "laws",
        kind: "section",
        locator: "9",
      }),
    ).resolves.toMatchObject({
      status: "not_found",
      matches: [],
      sourceMethod: "structure_index",
    });
  });

  it("returns a stable viewer payload", async () => {
    const text = Array.from(
      { length: 6 },
      (_, index) =>
        `[${index + 1}] Decision paragraph ${index + 1} contains enough *substantive* judicial language to establish a reliable sequence.`,
    ).join("\n");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            dataset: "SCC",
            citation_en: "2099 SCC 2",
            name_en: "Cache v. Repeat Open",
            source_url_en:
              "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/2099/index.do",
            unofficial_text_en: text,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await a2ajLegalSourceProvider.viewer({
      citation: "2099 SCC 2",
      dataset: "SCC",
    });
    const second = await a2ajLegalSourceProvider.viewer({
      citation: "2099 SCC 2",
      dataset: "SCC",
    });
    expect(first).not.toBeNull();
    expect(second?.etag).toBe(first?.etag);
    expect(first?.payload).toMatchObject({
      schemaVersion: "mike.legal-source.v1",
      reference: {
        docType: "cases",
        citation: "2099 SCC 2",
        dataset: "SCC",
      },
      structureSource: "flat_text",
      metadata: {
        url: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/2099/index.do",
        pdfUrl:
          "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/2099/1/document.do",
      },
    });
    expect(
      first?.payload.presentation.segments
        .flatMap((segment) => segment.blocks)
        .flatMap((block) => block.inline)
        .some((token) => token.kind === "em" && token.text === "substantive"),
    ).toBe(true);
    expect(
      first?.payload.presentation.segments
        .flatMap((segment) => segment.blocks)
        .some((block) => block.text.includes("*")),
    ).toBe(false);
    expect(first?.payload.anchors.filter(({ kind }) => kind === "paragraph"))
      .toHaveLength(6);
  });
});
