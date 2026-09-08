import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { a2ajLegalSourceProvider } from "../lib/legalSources/a2aj";
import type { LegalSourceStore } from "../lib/legalSourceStore";
import { createLegalSourceApplication } from "../lib/legalSourceApplication";
import { createLegalLibraryRouter } from "./legalLibrary";

vi.mock("../lib/remoteUrlSafety", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/remoteUrlSafety")>()),
  guardedRemoteFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init),
}));

const searchLegalSources = vi.hoisted(() => vi.fn());
const resolveLegalSource = vi.hoisted(() => vi.fn());

vi.mock("../lib/legalSources", async (original) => {
  const actual = await original<typeof import("../lib/legalSources")>();
  return { ...actual, createLegalSourceRegistry: (...args: Parameters<typeof actual.createLegalSourceRegistry>) => ({
    ...actual.createLegalSourceRegistry(...args), search: searchLegalSources, resolve: resolveLegalSource,
  }) };
});

const app = express();
app.use(express.json());
app.use("/sources", createLegalLibraryRouter(createLegalSourceApplication({
  list: vi.fn(async () => []), get: vi.fn(async () => null),
  save: vi.fn(), delete: vi.fn(async () => false),
} as unknown as LegalSourceStore)));

const originalAuthMode = process.env.AUTH_MODE;

afterEach(() => {
  a2ajLegalSourceProvider.clearCache();
  searchLegalSources.mockReset();
  resolveLegalSource.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env.AUTH_MODE = originalAuthMode;
});

describe("legal Library viewer responses", () => {
  it("keeps optional coverage failures from breaking Sources", async () => {
    process.env.AUTH_MODE = "local";
    vi.spyOn(a2ajLegalSourceProvider, "coverage").mockRejectedValue(new Error("offline"));
    const response = await request(app).get("/sources/coverage");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ coverage: [] });
  });

  it("preserves Library filters and neutral hits while searching through the registry", async () => {
    process.env.AUTH_MODE = "local";
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
      .get("/sources/search")
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
    expect(response.body.results).toEqual((await searchLegalSources.mock.results[0].value).results);
  });

  it("reports an unavailable registered search lane instead of an empty success", async () => {
    process.env.AUTH_MODE = "local";
    searchLegalSources.mockResolvedValue({ results: [], unavailable: [{ provider: "journal", message: "unavailable" }] });
    const response = await request(app).get("/sources/search").query({ query: "registered", doc_type: "articles" });
    expect(response.status).toBe(502);
    expect(response.body.detail).toBe("Legal source search unavailable");
  });

  it("does not expose provider failures", async () => {
    process.env.AUTH_MODE = "local";
    searchLegalSources.mockRejectedValue(new Error("upstream token=secret"));

    const response = await request(app)
      .get("/sources/search")
      .query({ query: "registered", doc_type: "articles" });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ detail: "Legal source search unavailable" });
    expect(response.text).not.toContain("secret");
  });

  it("returns an explicit uninstalled state without treating it as a failed search", async () => {
    process.env.AUTH_MODE = "local";
    searchLegalSources.mockResolvedValue({ results: [], unavailable: [{ provider: "hansard", message: "not_installed" }] });
    const response = await request(app).get("/sources/search").query({ query: "privacy", doc_type: "hansard" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ results: [], status: "not_installed" });
  });

  it("revalidates with a stable ETag without refetching the source", async () => {
    process.env.AUTH_MODE = "local";
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
      .get("/sources/document")
      .query({ citation: "2099 SCC 3", doc_type: "cases" });
    const second = await request(app)
      .get("/sources/document")
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
