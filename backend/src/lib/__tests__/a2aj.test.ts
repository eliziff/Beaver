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
import {
  documentTextNative,
} from "../structureNative";

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

  it("reads a paragraph and range from the canonical decision", async () => {
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
    const source = {
      provider: "a2aj",
      id: "2099 SCC 1",
      kind: "case",
      citation: "2099 SCC 1",
      collection: "SCC",
      language: "en",
    } as const;
    const passages = await a2ajLegalSourceProvider.readPassage!({
      source,
      locator: { kind: "paragraph", value: "para 3" },
      contextBlocks: 1,
    });
    const range = await a2ajLegalSourceProvider.readPassage!({
      source,
      locator: { kind: "paragraph", value: "2", endValue: "4" },
      contextBlocks: 1,
    });

    expect(passages.map(({ locator, role }) => [locator.label, role])).toEqual([
      ["par3", "selected"],
      ["par2", "context"],
      ["par4", "context"],
    ]);
    expect(passages[0]?.text).toContain("Decision paragraph 3");
    expect(range.map(({ locator, role }) => [locator.label, role])).toEqual([
      ["par1", "context"],
      ["par2", "selected"],
      ["par3", "selected"],
      ["par4", "selected"],
      ["par5", "context"],
    ]);
    const native = a2ajLegalSourceProvider.source(document!);
    expect(native && documentTextNative(native)).toBe(text);
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
    const passages = await a2ajLegalSourceProvider.readPassage!({
      source: {
        provider: "a2aj",
        id: "RSC 1985, c C-46",
        kind: "legislation",
        citation: "RSC 1985, c C-46",
        collection: "LEGISLATION-FED",
        language: "en",
      },
      locator: { kind: "section", value: "s. 34(1)(a)" },
    });

    expect(document).toMatchObject({
      docType: "laws",
    });
    const source = a2ajLegalSourceProvider.source(document!);
    expect(source && documentTextNative(source)).toBe(mappedText);
    expect(passages).toHaveLength(1);
    expect(passages[0]?.locator.label).toBe("sec34(1)(a)");
    expect(passages[0]?.text).toContain(
      "requested nested statutory paragraph",
    );
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
