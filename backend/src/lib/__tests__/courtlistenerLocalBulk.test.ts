import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../remoteUrlSafety", () => ({
  guardedRemoteFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, init),
}));

let temporaryDirectory: string | null = null;

afterEach(async () => {
  delete process.env.MIKE_COURTLISTENER_BULK_DB;
  vi.unstubAllGlobals();
  vi.resetModules();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("local CourtListener bulk data", () => {
  it("looks up citations, opinions, and case names from one local database", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-courtlistener-"),
    );
    const databasePath = path.join(temporaryDirectory, "courtlistener.sqlite");
    const canonicalOpinionText =
      `[1] ${"Canonical native opinion text supplies the source rendition. ".repeat(30)}`.trim();
    const canonicalOpinionMarkup = [
      `<div class="num" id="p1"><span class="num">1</span><p>${canonicalOpinionText}</p></div>`,
      '<page-number label="457" citation-index="1"></page-number>',
      "<p>Reporter-qualified pinpoint passage.</p>",
      ...Array.from(
        { length: 4 },
        (_, index) =>
          `<p>[${index + 2}] ${"Rendered numbering is not provider paragraph structure. ".repeat(8)}</p>`,
      ),
    ].join("");
    // Invented rows exercise the consumer schema; offline dump importers own CSV/bz2 handling.
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE cluster (
          id INTEGER PRIMARY KEY, case_name TEXT, case_name_short TEXT,
          case_name_full TEXT, slug TEXT, date_filed TEXT,
          filepath_json_harvard TEXT, filepath_pdf_harvard TEXT
        );
        CREATE TABLE citation (
          id INTEGER PRIMARY KEY, volume TEXT, reporter TEXT,
          reporter_key TEXT, page TEXT, cluster_id INTEGER
        );
        CREATE TABLE opinion (
          id INTEGER PRIMARY KEY, cluster_id INTEGER, type TEXT,
          author_str TEXT, page_count INTEGER, plain_text TEXT,
          html TEXT, html_with_citations TEXT
        );
        CREATE VIRTUAL TABLE cluster_search USING fts5(
          case_name, case_name_short, case_name_full,
          content='cluster', content_rowid='id'
        );
        CREATE VIRTUAL TABLE opinion_search USING fts5(
          cluster_id UNINDEXED, plain_text, content='opinion', content_rowid='id'
        );
      `);
      database.prepare("INSERT INTO cluster VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        42, "Alpha v. Beta", "Alpha", "Alpha Corporation v. Beta Ltd", "alpha-v-beta",
        "2024-01-02", "law.free.cap.f3d.123/456.1.json", "pdf/example.pdf",
      );
      database.prepare("INSERT INTO citation VALUES (?, ?, ?, ?, ?, ?)")
        .run(1, "123", "F.3d", "f3d", "456", 42);
      database.prepare("INSERT INTO opinion VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        7, 42, "010combined", "Justice Example", 3, "Stale plain rendition.",
        canonicalOpinionMarkup, canonicalOpinionMarkup,
      );
      database.exec(`
        INSERT INTO cluster_search(cluster_search) VALUES ('rebuild');
        INSERT INTO opinion_search(opinion_search) VALUES ('rebuild');
      `);
    } finally {
      database.close();
    }
    process.env.MIKE_COURTLISTENER_BULK_DB = databasePath;

    const bulk = await import("../courtlistenerLocalBulk");
    expect(
      bulk.lookupLocalCourtlistenerCitation({
        volume: "123",
        reporter: "F. 3d",
        page: "456",
      }),
    ).toMatchObject([{ id: 42, caseName: "Alpha v. Beta" }]);
    expect(bulk.getLocalCourtlistenerCase(42)).toMatchObject({
      citations: ["123 F.3d 456"],
      opinions: [{ id: 7, plainText: "Stale plain rendition." }],
    });
    expect(
      bulk.searchLocalCourtlistenerCases({ query: "Alpha Corporation" }),
    ).toMatchObject([{ id: 42 }]);
    expect(
      bulk.searchLocalCourtlistenerCases({ query: "Stale plain" }),
    ).toMatchObject([{ id: 42 }]);

    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("archive.org")
        ? new Response(
            JSON.stringify({
              citations: [{ type: "official", cite: "123 F.3d 456" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        : new Response(
            JSON.stringify({
              results: [
                {
                  cluster_id: 99,
                  case_name: "Filtered API result",
                  court_id: "ca9",
                  date_filed: "2025-01-02",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { courtlistenerLegalSourceProvider } = await import(
      "../legalSources/courtlistener"
    );
    const fetchedCase = await courtlistenerLegalSourceProvider.caseOpinions({
      clusterId: 42,
      maxChars: 1000,
    });
    const opinion = (
      fetchedCase as { opinions: Array<{ text: string | null }> }
    ).opinions[0]!;
    expect(opinion.text).toContain("Canonical native opinion text");
    expect(opinion.text).not.toContain("Stale plain rendition");
    expect(opinion.text!.length).toBeLessThan(canonicalOpinionText.length);
    const page = await courtlistenerLegalSourceProvider.readPassage!({
      source: { provider: "courtlistener", id: "42", kind: "case" },
      locator: { kind: "page", value: "123 F.3d 457" },
    });
    expect(page[0]?.text).toContain("Reporter-qualified pinpoint passage");
    const filtered = await courtlistenerLegalSourceProvider.configured({
      apiToken: "test-token",
    }).search!({
      text: "Alpha",
      kinds: ["case"],
      court: "ca9",
      dateFrom: "2025-01-01",
    });

    const searchRequest = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("court=ca9"),
    )!;
    expect(String(searchRequest[0])).toContain("court=ca9");
    expect(String(searchRequest[0])).toContain(
      "filed_after=2025-01-01",
    );
    expect(filtered).toMatchObject([
      { id: "99", collection: "ca9", date: "2025-01-02" },
    ]);
  });

});
