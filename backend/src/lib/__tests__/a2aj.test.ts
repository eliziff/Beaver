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
  // Same for the installed note-up graph: its resolution table would
  // otherwise union the reporter's aliases and skip the /search leg.
  vi.stubEnv(
    "MIKE_CITATOR_DB",
    path.join(os.tmpdir(), `beaver-citator-http-test-${crypto.randomUUID()}.sqlite`),
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
      expect(await a2ajLegalSourceProvider.search!({ text: '"privacy"', syntax: "fts5", kinds: [kind] }))
        .toMatchObject([{ kind, title: "Privacy Act" }]);
      expect(guardedRemoteFetch).toHaveBeenCalledTimes(1);
      const url = new URL(String(guardedRemoteFetch.mock.calls[0][0]));
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("doc_type")).toBe(kind === "case" ? "cases" : "laws");
      expect(url.searchParams.get("query")).toBe('"privacy"');
    } finally { rmSync(folder, { recursive: true }); }
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
        language: "en",
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
    expect(structureNative().documentText(document!.native)).toBe(text);
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
    expect(document!.searchText).toBe(
      "Stale flattened text that the provider section map supersedes.",
    );
    expect(structureNative().documentText(document!.searchNative)).toBe(document!.searchText);
    expect(passages).toHaveLength(1);
    expect(passages[0]?.locator.label).toBe("sec34(1)(a)");
    expect(passages[0]?.text).toContain(
      "requested nested statutory paragraph",
    );
  });

  it("resolves an exact parallel citation through one canonical fetch", async () => {
    const requested = "[2015] 1 SCR 331";
    const signal = new AbortController().signal;
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.signal).toBe(signal);
      const url = new URL(String(input));
      const citation = url.searchParams.get("citation");
      if (url.pathname === "/fetch" && citation === "2015 SCC 5") {
        return new Response(JSON.stringify({ results: [{
          dataset: "SCC", citation_en: "2015 SCC 5", citation_fr: "2015 CSC 5",
          citation2_en: "[2015] 1 SCR 331", citation2_fr: "[2015] 1 RCS 331",
          name_en: "Carter v Canada (Attorney General)",
          unofficial_text_en: "[1] These are the reasons for judgment.",
        }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/search") {
        return new Response(JSON.stringify({ results: [
          { dataset: "SCC", citation_en: "2015 SCC 50", citation2_en: `${requested}0` },
          { dataset: "SCC", citation_en: "2015 SCC 5", citation2_en: "[2015] 1 SCR 331",
            citation_fr: "2015 CSC 5" },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ results: [] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }));

    await expect(a2ajLegalSourceProvider.document({ citation: requested, signal }))
      .resolves.toMatchObject({ citation: "2015 SCC 5",
        alternateCitation: "[2015] 1 SCR 331", dataset: "SCC" });
    const urls = guardedRemoteFetch.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map(({ pathname }) => pathname)).toEqual(["/fetch", "/search", "/fetch"]);
    expect(urls.at(-1)?.searchParams.get("citation")).toBe("2015 SCC 5");
  });

  it("uses the supplied source URL to disambiguate duplicate citation records", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Response(JSON.stringify({
      results: [
        { dataset: "SCC", citation_en: "2099 SCC 9",
          source_url_en: "https://example.test/first", unofficial_text_en: "Wrong record." },
        { dataset: "SCC", citation_en: "2099 SCC 9",
          source_url_en: "https://example.test/second", unofficial_text_en: "Correct record." },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(a2ajLegalSourceProvider.document({ citation: "2099 SCC 9", dataset: "SCC" }))
      .resolves.toBeNull();

    await expect(a2ajLegalSourceProvider.document({
      citation: "2099 SCC 9",
      dataset: "SCC",
      sourceUrl: "https://example.test/second",
    })).resolves.toMatchObject({
      url: "https://example.test/second",
      searchText: "Correct record.",
    });
  });

  it("keeps full search coordinates when the scoped law endpoint supplies a missing locator", async () => {
    const sourceUrl = "https://example.test/statute";
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      const scoped = url.searchParams.get("section") === "99";
      return new Response(JSON.stringify({ results: [{
        dataset: "LEGISLATION-XY",
        citation_en: "Example Act",
        source_url_en: sourceUrl,
        unofficial_text_en: scoped
          ? "The scoped endpoint supplies the requested provision."
          : "The complete flattened statute remains the URL-planning source.",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const document = await a2ajLegalSourceProvider.document({
      citation: "Example Act",
      docType: "laws",
      dataset: "LEGISLATION-XY",
      sourceUrl,
      section: "99",
    });

    expect(document?.searchText).toBe(
      "The complete flattened statute remains the URL-planning source.",
    );
    expect(structureNative().documentText(document!.native)).toContain(
      "scoped endpoint supplies the requested provision",
    );
  });

  it("returns a stable viewer payload", async () => {
    const text = Array.from(
      { length: 6 },
      (_, index) =>
        `[${index + 1}] Decision paragraph ${index + 1} contains enough *substantive* judicial language to establish a reliable sequence.`,
    ).join("\n");
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (!String(input).startsWith("https://api.a2aj.ca/")) return new Response(
        '<li class="documents"><a href="/fc-cf/decisions/en/530291/1/document.do">PDF</a></li>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
      return new Response(JSON.stringify({
        results: [
          {
            dataset: "SCC",
            citation_en: "2099 SCC 2",
            name_en: "Cache v. Repeat Open",
            source_url_en:
              "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/530291/index.do",
            unofficial_text_en: text,
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
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
        provider: "a2aj",
        id: "2099 SCC 2",
        kind: "case",
        docType: "cases",
        citation: "2099 SCC 2",
        dataset: "SCC",
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      metadata: {
        url: "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/530291/index.do",
        pdfUrl:
          "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/530291/1/document.do",
      },
    });
    expect(first?.payload.slices.flatMap(({ anchors, primary }) =>
      [...anchors, ...(primary ? [primary] : [])],
    ).filter(({ kind }) => kind === "paragraph"))
      .toHaveLength(6);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retrieved = await a2ajLegalSourceProvider.readPassage({
      source: { provider: "a2aj", kind: "case", id: "2099 SCC 2", citation: "2099 SCC 2",
        collection: "SCC", language: "en", url: first!.payload.metadata.url },
      locator: { kind: "paragraph", value: "1" }, contextBlocks: 0,
    });
    expect(retrieved[0].text).toContain("Decision paragraph 1");
    expect(structureNative().documentRevision(retrieved[0].documentArtifact))
      .toBe(first!.payload.reference.sourceSha256);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(a2ajLegalSourceProvider.document({
      citation: "2099 SCC 2",
      dataset: "SCC",
    })).resolves.toMatchObject({
      verifiedPdf: {
        url: "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/530291/1/document.do",
        pdfOnly: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the HTML representation when Decisia index retrieval fails", async () => {
    const index =
      "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/40084/index.do";
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (!String(input).startsWith("https://api.a2aj.ca/")) {
        throw new Error("publisher unavailable");
      }
      return new Response(JSON.stringify({ results: [{
        dataset: "FC", citation_en: "2099 FC 3", source_url_en: index,
        unofficial_text_en: "A complete source document remains available.",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await expect(a2ajLegalSourceProvider.document({ citation: "2099 FC 3" }))
      .resolves.toMatchObject({ url: index, verifiedPdf: null });
  });

  it("names a lookup A2AJ did not answer, and waits out its retry window without asking again", async () => {
    // A fixed past clock: the window this test opens has long closed for the real clock.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2020, 0, 1) });
    try {
      const failure = async () => a2ajLegalSourceProvider.coverage("laws").then(() => null, (error) => error);
      guardedRemoteFetch.mockResolvedValueOnce(new Response("upstream down", { status: 502 }));
      expect(await failure()).toMatchObject({ reason: "error", retryAt: null });
      guardedRemoteFetch.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
      expect(await failure()).toMatchObject({ reason: "timeout" });
      // Nothing answers the lookup or the opaque request that asks whether anything answers.
      guardedRemoteFetch.mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockRejectedValueOnce(new TypeError("fetch failed"));
      expect(await failure()).toMatchObject({ reason: "unreachable" });
      expect(guardedRemoteFetch).toHaveBeenCalledTimes(4);

      guardedRemoteFetch.mockResolvedValueOnce(new Response("slow down", { status: 429,
        headers: { "retry-after": "120" } }));
      const limited = await failure();
      expect(limited).toBeInstanceOf(A2AJUnavailable);
      expect(limited).toMatchObject({ reason: "rate-limited", retryAt: Date.now() + 120_000 });
      expect(guardedRemoteFetch).toHaveBeenCalledTimes(5);
      // Within the window nothing is sent; after it, A2AJ is asked again.
      vi.setSystemTime(Date.now() + 119_000);
      expect(await failure()).toMatchObject({ reason: "rate-limited" });
      expect(guardedRemoteFetch).toHaveBeenCalledTimes(5);
      vi.setSystemTime(Date.now() + 2_000);
      guardedRemoteFetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200,
        headers: { "content-type": "application/json" } }));
      await expect(a2ajLegalSourceProvider.coverage("laws")).resolves.toEqual([]);
      expect(guardedRemoteFetch).toHaveBeenCalledTimes(6);
    } finally { vi.useRealTimers(); }
  });

  it("tells A2AJ's limit a page cannot read from A2AJ being unreachable, and our own defect from both", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2020, 0, 1) });
    try {
      const failure = async () => a2ajLegalSourceProvider.document({ citation: "2099 SCC 97" })
        .then(() => null, (error) => error);
      // Our own request path failing is not A2AJ's doing: its own error and message, nothing more sent.
      const defect = new Error("A2AJ request is outside the allowed hosts.");
      guardedRemoteFetch.mockRejectedValueOnce(defect);
      expect(await failure()).toBe(defect);
      expect(guardedRemoteFetch).toHaveBeenCalledTimes(1);

      // In a page, A2AJ's 429 carries no CORS header: the lookup fails as a network error, but
      // the opaque request gets an answer. That is its limit, held as one, not an outage.
      guardedRemoteFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ type: "opaque", status: 0, ok: false, body: null, headers: new Headers() } as Response);
      expect(await failure()).toMatchObject({ reason: "rate-limited", retryAt: Date.now() + 60_000 });
      expect(guardedRemoteFetch).toHaveBeenCalledTimes(3);
      expect(guardedRemoteFetch.mock.calls[2][1]).toMatchObject({ method: "HEAD", mode: "no-cors" });
      vi.setSystemTime(Date.now() + 59_000);
      expect(await failure()).toMatchObject({ reason: "rate-limited" });
      expect(guardedRemoteFetch).toHaveBeenCalledTimes(3);

      // Where the answer can be read (Node), its status says what it was.
      vi.setSystemTime(Date.now() + 2_000);
      guardedRemoteFetch.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "30" } }));
      expect(await failure()).toMatchObject({ reason: "rate-limited", retryAt: Date.now() + 30_000 });
      expect(guardedRemoteFetch).toHaveBeenCalledTimes(5);
    } finally { vi.useRealTimers(); }
  });

  it("sends one request to A2AJ at a time, however many lookups ask at once", async () => {
    const answers: Array<() => void> = [];
    guardedRemoteFetch.mockImplementation(() => new Promise((resolve) => answers.push(() =>
      resolve(new Response(JSON.stringify({ results: [] }), { status: 200,
        headers: { "content-type": "application/json" } })))));
    try {
      let settled = false;
      const lookups = Promise.all(["2099 SCC 91", "2099 SCC 92", "2099 SCC 93"].map((citation) =>
        a2ajLegalSourceProvider.document({ citation, discoverPdf: false }))).finally(() => { settled = true; });
      while (!settled) {
        await vi.waitFor(() => expect(settled || answers.length > 0).toBe(true));
        if (settled) break;
        // Whatever else is waiting, nothing more is sent until this request is answered.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(answers).toHaveLength(1);
        answers.shift()!();
      }
      await expect(lookups).resolves.toEqual([null, null, null]);
      expect(guardedRemoteFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally { guardedRemoteFetch.mockReset(); guardedRemoteFetch.mockImplementation((input, init) => fetch(input, init)); }
  });

  const answer = (status = 200, headers: Record<string, string> = {}) => new Response(
    JSON.stringify(status === 200 ? { results: [] } : { error: "limited" }),
    { status, headers: { "content-type": "application/json", ...headers } });
  const sent = (from = 0) => guardedRemoteFetch.mock.calls.slice(from).map(([url]) => new URL(String(url)));
  const restore = () => { guardedRemoteFetch.mockReset(); guardedRemoteFetch.mockImplementation((input, init) => fetch(input, init)); };

  it("searches a citation as its words, never as A2AJ's query syntax", async () => {
    guardedRemoteFetch.mockImplementation(async () => answer());
    try {
      await a2ajLegalSourceProvider.document({ citation: "Doe v Roe, [2031] ZZ No 12", discoverPdf: false });
      const queries = sent().filter(({ pathname }) => pathname === "/search").map((url) => url.searchParams.get("query")!);
      // A2AJ refuses "[2031] ZZ" as a range it cannot parse; every bracket goes as a character.
      expect(queries).toContain("Doe v Roe, \\[2031\\] ZZ No 12");
      for (const query of queries) expect(query).not.toMatch(/(?<!\\)[[\]()]/u);
    } finally { restore(); }
  });

  it("asks A2AJ again only for what it left unanswered, never for what it answered", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2020, 0, 1) });
    try {
      // The lookup by citation is answered; the search after it meets A2AJ's limit.
      guardedRemoteFetch.mockImplementation(async (url) => new URL(String(url)).pathname === "/search"
        ? answer(429, { "retry-after": "30" }) : answer());
      await expect(a2ajLegalSourceProvider.document({ citation: "2099 SCC 81", discoverPdf: false }))
        .rejects.toMatchObject({ reason: "rate-limited" });
      const first = sent();
      expect(first.some(({ pathname }) => pathname === "/fetch")).toBe(true);
      // Retrying once the limit passes sends the search alone.
      vi.setSystemTime(Date.now() + 31_000);
      guardedRemoteFetch.mockImplementation(async () => answer());
      await expect(a2ajLegalSourceProvider.document({ citation: "2099 SCC 81", discoverPdf: false })).resolves.toBeNull();
      const retried = sent(first.length);
      expect(retried.length).toBeGreaterThan(0);
      expect(retried.every(({ pathname }) => pathname === "/search")).toBe(true);
      // Looking it up again, as importing the same brief again does, asks nothing.
      await a2ajLegalSourceProvider.document({ citation: "2099 SCC 81", discoverPdf: false });
      expect(sent(first.length + retried.length)).toEqual([]);
    } finally { vi.useRealTimers(); restore(); }
  });
});
