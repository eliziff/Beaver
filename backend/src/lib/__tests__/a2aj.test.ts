import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { guardedRemoteFetch } = vi.hoisted(() => ({
  guardedRemoteFetch: vi.fn((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init)),
}));
vi.mock("../remoteUrlSafety", () => ({ guardedRemoteFetch }));

import {
  A2AJUnavailable, a2ajLegalSourceProvider,
} from "../legalSources/a2aj";
import { structureNative } from "../structureNative";

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
  it.each(["case", "legislation"] as const)("falls back for %s when the installed lookup store has no FTS", async (kind) => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "a2aj-search-"));
    const filename = path.join(folder, "a2aj.sqlite");
    const database = new DatabaseSync(filename);
    database.exec("CREATE TABLE document(id INTEGER PRIMARY KEY)");
    database.close();
    vi.stubEnv("MIKE_A2AJ_BULK_DB", filename);
    guardedRemoteFetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [{
      dataset: "LEGISLATION-FED", citation_en: "RSC 1985, c P-21", name_en: "Privacy Act",
    }] }), { status: 200 }));
    try {
      expect(await a2ajLegalSourceProvider.search!({ text: '"privacy"', kinds: [kind] }))
        .toMatchObject([{ kind, title: "Privacy Act" }]);
      expect(guardedRemoteFetch).toHaveBeenCalledTimes(1);
      const url = new URL(String(guardedRemoteFetch.mock.calls[0][0]));
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("doc_type")).toBe(kind === "case" ? "cases" : "laws");
      expect(url.searchParams.get("query")).toBe('"privacy"');
    } finally {
      // The engine keeps a store open while that copy of it is current, so Windows may not let the folder go yet.
      try { rmSync(folder, { recursive: true }); } catch { /* left for the system's temp cleanup */ }
    }
  });

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
    expect(structureNative().documentText(document!.native)).toBe(mappedText);
    expect(document!.searchText()).toBe(
      "Stale flattened text that the provider section map supersedes.",
    );
    expect(passages).toHaveLength(1);
    expect(passages[0]?.locator).toMatchObject({ requested: { kind: "section" }, label: "34(1)(a)" });
    expect(passages[0]?.text).toContain(
      "requested nested statutory paragraph",
    );
  });

  it.each([
    { name: "a one-paragraph decision with a reported citation", citation: "2031 ONCA 700", label: "1", text: "REASONS FOR JUDGMENT\n" +
      "[1] The court considered the submissions and finds that the notice was adequate. " +
      "The prior decision explains why written notice was sufficient in these circumstances:\n" +
      "Harbour v. Board, [2030] 1 C.T.C. 140. The appeal is dismissed with costs." },
    { name: "a paragraph joined to a heading in an excerpt", citation: "2031 ONCA 701", label: "63", text:
      "[62] The court considered the evidence and the parties' submissions before deciding the notice issue.\n" +
      "Should the Proposed Panelists attend the hearing, permitting their cross-examination by the Applicant? " +
      "[63] The court finds that the notice was adequate and dismisses this ground of appeal for the following reasons.\n" +
      "[64] The remaining grounds are considered separately and do not alter the disposition of this appeal." },
  ])("reads $name through the provider", async ({ citation, label, text }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{
      dataset: "ONCA", citation_en: citation, name_en: "Harbour v Board", unofficial_text_en: text,
    }] }), { status: 200 })));
    const document = await a2ajLegalSourceProvider.document({ citation, docType: "cases", dataset: "ONCA" });
    expect(document).not.toBeNull();
    expect(structureNative().documentText(document!.native)).toBe(text);
    const passages = await a2ajLegalSourceProvider.readPassage!({
      source: { provider: "a2aj", id: citation, kind: "case", citation, collection: "ONCA", language: "en" },
      locator: { kind: "paragraph", value: label },
    });
    expect(passages).toHaveLength(1);
    expect(passages[0]?.locator.label).toBe(label);
    expect(passages[0]?.text).toContain("the notice was adequate");
  });

  const answer = (status = 200, headers: Record<string, string> = {}) => new Response(
    JSON.stringify(status === 200 ? { results: [] } : { error: "limited" }),
    { status, headers: { "content-type": "application/json", ...headers } });
  const sent = (from = 0) => guardedRemoteFetch.mock.calls.slice(from).map(([url]) => new URL(String(url)));
  const restore = () => { guardedRemoteFetch.mockReset(); guardedRemoteFetch.mockImplementation((input, init) => fetch(input, init)); };

});
