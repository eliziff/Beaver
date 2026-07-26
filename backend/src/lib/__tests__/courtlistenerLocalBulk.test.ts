import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
      path.join(os.tmpdir(), "mike-courtlistener-"),
    );
    const databasePath = path.join(temporaryDirectory, "courtlistener.sqlite");
    const citations = path.join(temporaryDirectory, "citations.csv");
    const compressedCitations = `${citations}.bz2`;
    const clusters = path.join(temporaryDirectory, "opinion-clusters.csv");
    const opinions = path.join(temporaryDirectory, "opinions.csv");
    await Promise.all([
      writeFile(
        citations,
        "id,volume,reporter,page,type,cluster_id\n1,123,F.3d,456,1,42\n",
      ),
      writeFile(
        clusters,
        "id,case_name,case_name_short,case_name_full,slug,date_filed,filepath_pdf_harvard\n" +
          "42,Alpha v. Beta,Alpha,Alpha Corporation v. Beta Ltd,alpha-v-beta,2024-01-02,pdf/example.pdf\n",
      ),
      writeFile(
        opinions,
        "id,cluster_id,type,author_str,page_count,plain_text,html,html_with_citations\n" +
          "7,42,010combined,Justice Example,3,Exact opinion text.,<p>Exact opinion text.</p>,<p>Exact opinion text.</p>\n",
      ),
    ]);
    const compress = spawnSync(
      "python",
      [
        "-c",
        "import bz2,sys; open(sys.argv[2],'wb').write(bz2.compress(open(sys.argv[1],'rb').read()))",
        citations,
        compressedCitations,
      ],
      { encoding: "utf8" },
    );
    expect(compress.status, compress.stderr).toBe(0);
    const imported = spawnSync(
      "python",
      [
        path.resolve("scripts/import_courtlistener_bulk.py"),
        "--citations",
        compressedCitations,
        "--clusters",
        clusters,
        "--opinions",
        opinions,
        "--output",
        databasePath,
        "--opinion-fts",
      ],
      { encoding: "utf8" },
    );
    expect(imported.status, imported.stderr).toBe(0);
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
      opinions: [{ id: 7, plainText: "Exact opinion text." }],
    });
    expect(
      bulk.searchLocalCourtlistenerCases({ query: "Alpha Corporation" }),
    ).toMatchObject([{ id: 42 }]);
    expect(
      bulk.searchLocalCourtlistenerCases({ query: "Exact opinion" }),
    ).toMatchObject([{ id: 42 }]);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
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
    const { searchCourtlistenerCaseLaw } = await import("../courtlistener");
    const filtered = await searchCourtlistenerCaseLaw({
      query: "Alpha",
      court: "ca9",
      filedAfter: "2025-01-01",
      apiToken: "test-token",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("court=ca9");
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "filed_after=2025-01-01",
    );
    expect(filtered).toMatchObject({
      results: [{ clusterId: 99, court: "ca9", dateFiled: "2025-01-02" }],
    });
  });
});
