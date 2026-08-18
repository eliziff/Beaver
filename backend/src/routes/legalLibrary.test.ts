import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearA2AJCache } from "../lib/a2aj";
import { legalLibraryRouter } from "./legalLibrary";

vi.mock("../lib/remoteUrlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/remoteUrlSafety")>()),
  guardedRemoteFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init),
}));

const searchLegalSources = vi.hoisted(() => vi.fn());
const resolveLegalSource = vi.hoisted(() => vi.fn());

vi.mock("../lib/legalSourceRegistry", async (original) => ({
  ...(await original<typeof import("../lib/legalSourceRegistry")>()),
  searchLegalSources,
  resolveLegalSource,
}));

const app = express();
app.use(express.json());
app.use("/library/legal", legalLibraryRouter);

const originalAuthMode = process.env.AUTH_MODE;

afterEach(() => {
  clearA2AJCache();
  searchLegalSources.mockReset();
  resolveLegalSource.mockReset();
  vi.unstubAllGlobals();
  process.env.AUTH_MODE = originalAuthMode;
});

describe("legal Library viewer responses", () => {
  it("keeps Library filters and DTOs while searching through the registry", async () => {
    process.env.AUTH_MODE = "anonymous";
    searchLegalSources.mockResolvedValue({
      results: [{
        provider: "journal",
        id: "17",
        kind: "journal",
        title: "A Registered Article",
        citation: "42 Alta L Rev 1",
        date: "2024-01-02",
        collection: "Alberta Law Review",
        url: "https://example.test/article/17",
        snippet: "registered search result",
        authors: "Example Author",
      }],
      unavailable: [],
    });

    const response = await request(app)
      .get("/library/legal/search")
      .query({
        query: "registered",
        doc_type: "articles",
        author: "Example Author",
        journal: "Alberta",
        start_date: "2020-01-01",
        end_date: "2025-12-31",
        sort_results: "newest_first",
        size: "40",
      });

    expect(response.status).toBe(200);
    expect(searchLegalSources).toHaveBeenCalledWith(expect.objectContaining({
      text: "registered",
      kinds: ["journal"],
      providers: ["journal"],
      author: "Example Author",
      journal: "Alberta",
      dateFrom: "2020-01-01",
      dateTo: "2025-12-31",
      sort: "newest",
      limit: 25,
      perProviderLimit: 25,
    }));
    expect(response.body.results).toEqual([{
      provider: "journal",
      doc_type: "articles",
      source_id: "17",
      dataset: "Alberta Law Review",
      citation: "42 Alta L Rev 1",
      alternateCitation: null,
      name: "A Registered Article",
      date: "2024-01-02",
      url: "https://example.test/article/17",
      snippet: "registered search result",
    }]);
  });

  it("revalidates with a stable ETag without refetching the source", async () => {
    process.env.AUTH_MODE = "anonymous";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            dataset: "SCC",
            citation_en: "2099 SCC 3",
            name_en: "ETag v. Repeat Open",
            unofficial_text_en:
              "[1] First paragraph with enough legal text.\n[2] Second paragraph with enough legal text.",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await request(app)
      .get("/library/legal/document")
      .query({ citation: "2099 SCC 3", doc_type: "cases" });
    const second = await request(app)
      .get("/library/legal/document")
      .query({ citation: "2099 SCC 3", doc_type: "cases" })
      .set("If-None-Match", first.headers.etag);

    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/u);
    expect(first.headers["cache-control"]).toBe(
      "private, max-age=0, must-revalidate",
    );
    expect(second.status).toBe(304);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
