import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const citations = path.join(temporaryDirectory, "citations.csv");
    const compressedCitations = `${citations}.bz2`;
    const clusters = path.join(temporaryDirectory, "opinion-clusters.csv");
    const opinions = path.join(temporaryDirectory, "opinions.csv");
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
    await Promise.all([
      writeFile(
        citations,
        "id,volume,reporter,page,type,cluster_id\n1,123,F.3d,456,1,42\n",
      ),
      writeFile(
        clusters,
        "id,case_name,case_name_short,case_name_full,slug,date_filed,filepath_json_harvard,filepath_pdf_harvard\n" +
          "42,Alpha v. Beta,Alpha,Alpha Corporation v. Beta Ltd,alpha-v-beta,2024-01-02,law.free.cap.f3d.123/456.1.json,pdf/example.pdf\n",
      ),
      writeFile(
        opinions,
        "id,cluster_id,type,author_str,page_count,plain_text,html,html_with_citations\n" +
          `7,42,010combined,Justice Example,3,Stale plain rendition.,${canonicalOpinionMarkup},${canonicalOpinionMarkup}\n`,
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
    const {
      getCourtlistenerCaseOpinions,
      getCourtlistenerOpinionDocumentText,
      getCourtlistenerOpinionStructure,
      lookupCourtlistenerOpinionLocator,
      searchCourtlistenerCaseLaw,
    } = await import("../courtlistener");
    const fetchedCase = await getCourtlistenerCaseOpinions({
      clusterId: 42,
      maxChars: 1000,
    });
    const opinion = (
      fetchedCase as { opinions: Array<{ text: string | null }> }
    ).opinions[0]!;
    expect(opinion.text).toContain("Canonical native opinion text");
    expect(opinion.text).not.toContain("Stale plain rendition");
    expect(opinion.text!.length).toBeLessThan(canonicalOpinionText.length);
    expect(getCourtlistenerOpinionDocumentText(opinion)).toContain(
      canonicalOpinionText,
    );
    const opinionStructure = getCourtlistenerOpinionStructure(opinion);
    expect(opinionStructure?.text).toContain(canonicalOpinionText);
    expect(
      opinionStructure?.blocks
        .filter(({ kind }) => kind === "paragraph")
        .map(({ label, origin, anchor }) => [label, origin, anchor]),
    ).toEqual([
      ["par1", "native", "p1"],
      ["par2", "heuristic", undefined],
      ["par3", "heuristic", undefined],
      ["par4", "heuristic", undefined],
      ["par5", "heuristic", undefined],
    ]);
    expect(
      lookupCourtlistenerOpinionLocator(opinion, "page", "123 F.3d 457")
        ?.status,
    ).toBe("found");
    const filtered = await searchCourtlistenerCaseLaw({
      query: "Alpha",
      court: "ca9",
      filedAfter: "2025-01-01",
      apiToken: "test-token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const searchRequest = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("court=ca9"),
    )!;
    expect(String(searchRequest[0])).toContain("court=ca9");
    expect(String(searchRequest[0])).toContain(
      "filed_after=2025-01-01",
    );
    expect(filtered).toMatchObject({
      results: [{ clusterId: 99, court: "ca9", dateFiled: "2025-01-02" }],
    });
  });

  it("slices a truncated multi-stream opinions dump at the last complete record", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "beaver-courtlistener-slice-"),
    );
    const databasePath = path.join(temporaryDirectory, "courtlistener.sqlite");
    const citations = path.join(temporaryDirectory, "citations.csv");
    const clusters = path.join(temporaryDirectory, "opinion-clusters.csv");
    const streamOne = path.join(temporaryDirectory, "stream-one.csv");
    const streamTwo = path.join(temporaryDirectory, "stream-two.csv");
    const compressedOpinions = path.join(temporaryDirectory, "opinions.csv.bz2");
    const slicedOpinions = path.join(temporaryDirectory, "opinions-head.csv");
    await Promise.all([
      writeFile(
        citations,
        'id,volume,reporter,page,type,cluster_id\n"1","410","U.S.","113","1","42"\n',
      ),
      writeFile(
        clusters,
        "id,case_name,case_name_short,case_name_full,slug,date_filed\n" +
          '"42","Roe v. Wade","Roe","Roe v. Wade","roe-v-wade","1973-01-22"\n' +
          '"43","Gamma v. Delta","Gamma","Gamma v. Delta","gamma-v-delta","1980-06-01"\n' +
          '"44","Epsilon v. Zeta","Epsilon","Epsilon v. Zeta","epsilon-v-zeta","1990-03-04"\n',
      ),
      // Bulk dialect: every field quoted, embedded quotes backslash-escaped,
      // literal newlines allowed inside quoted fields.
      writeFile(
        streamOne,
        "id,cluster_id,type,plain_text\n" +
          '"8","42","010combined","First line.\nSecond \\"quoted\\" line."\n',
      ),
      // Second bz2 stream ends mid-record, as an HTTP range cut would.
      writeFile(
        streamTwo,
        '"9","43","020lead","Short text."\n"10","44","030conc","Truncated tex',
      ),
    ]);
    const compress = spawnSync(
      "python",
      [
        "-c",
        "import bz2,sys; open(sys.argv[3],'wb').write(" +
          "bz2.compress(open(sys.argv[1],'rb').read())+" +
          "bz2.compress(open(sys.argv[2],'rb').read()))",
        streamOne,
        streamTwo,
        compressedOpinions,
      ],
      { encoding: "utf8" },
    );
    expect(compress.status, compress.stderr).toBe(0);
    const sliced = spawnSync(
      "python",
      [
        "-c",
        "import pathlib,sys; sys.path.insert(0, sys.argv[1]); " +
          "from fetch_courtlistener_bulk import download_opinions_head; " +
          "download_opinions_head(pathlib.Path(sys.argv[2]).resolve().as_uri()," +
          " pathlib.Path(sys.argv[3]), 1 << 30)",
        path.resolve("scripts"),
        compressedOpinions,
        slicedOpinions,
      ],
      { encoding: "utf8" },
    );
    expect(sliced.status, sliced.stderr).toBe(0);
    expect(sliced.stdout).toContain("2 opinion rows");
    const imported = spawnSync(
      "python",
      [
        path.resolve("scripts/import_courtlistener_bulk.py"),
        "--citations",
        citations,
        "--clusters",
        clusters,
        "--opinions",
        slicedOpinions,
        "--output",
        databasePath,
        "--opinion-fts",
      ],
      { encoding: "utf8" },
    );
    expect(imported.status, imported.stderr).toBe(0);
    process.env.MIKE_COURTLISTENER_BULK_DB = databasePath;
    const bulk = await import("../courtlistenerLocalBulk");
    expect(bulk.getLocalCourtlistenerCase(42)).toMatchObject({
      citations: ["410 U.S. 113"],
      opinions: [
        { id: 8, plainText: 'First line.\nSecond "quoted" line.' },
      ],
    });
    expect(bulk.getLocalCourtlistenerCase(43)).toMatchObject({
      opinions: [{ id: 9, plainText: "Short text." }],
    });
    // The truncated third record must not survive the slice.
    expect(bulk.getLocalCourtlistenerCase(44)).toMatchObject({ opinions: [] });
  });
});
