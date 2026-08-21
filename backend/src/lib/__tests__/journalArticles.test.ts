import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { journalLegalSourceProvider as journal } from "../legalSources/journal";
import { runLocalAssistantTools } from "./support/localAssistantTools";
import { buildLegalSourcePinpointUrl } from "../legalSourceLinks";
import { readLegalSourcePassage } from "../legalSourceRegistry";
import { resourceReference } from "../resourceReferences";

let directory = "";
let previousDatabase: string | undefined;
let previousSearchDatabase: string | undefined;
let previousFinalContractDatabase: string | undefined;

function fixtureDatabase() {
  directory = mkdtempSync(path.join(os.tmpdir(), "beaver-journals-"));
  const filename = path.join(directory, "public_endpoint.db");
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE articles (
      article_id INTEGER PRIMARY KEY,
      dataset TEXT NOT NULL,
      citation_en TEXT,
      name_en TEXT NOT NULL,
      authors TEXT,
      document_date_en TEXT,
      volume TEXT,
      issue TEXT,
      first_page TEXT,
      url_en TEXT,
      abstract TEXT,
      journal_name TEXT,
      journal_abbrev TEXT,
      galley_url TEXT,
      upstream_license TEXT,
      text TEXT
    );
    CREATE TABLE article_pages (
      article_id INTEGER NOT NULL,
      page_order INTEGER NOT NULL,
      page_label TEXT NOT NULL,
      pdf_page INTEGER NOT NULL
    );
    CREATE TABLE export_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const text = `[page 100]
I. Introduction

Opening material has enough words to form the first stable paragraph.
1\t
The first footnote explains the opening material.

[page 101]
II. Analysis

The first quoted phrase appears only here. The second quoted phrase also appears only here.
2\t
The second footnote supports the analysis.`;
  database
    .prepare(
      `INSERT INTO articles (
        article_id, dataset, citation_en, name_en, authors, document_date_en,
        volume, issue, first_page, url_en, abstract, journal_name, journal_abbrev,
        galley_url, upstream_license, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      7,
      "FIXTURE",
      "(2026) 1 Fixture LJ 100",
      "A Fixture Article",
      "Ada Example; Grace Example",
      "2026",
      "1",
      "2",
      "100",
      "https://example.test/article",
      "A deterministic fixture abstract.",
      "Fixture Law Journal",
      "Fixture LJ",
      "https://example.test/article.pdf",
      "CC-BY",
      text,
    );
  database.exec(
    "INSERT INTO article_pages VALUES (7, 1, '100', 1), (7, 2, '101', 2)",
  );
  database.exec(`
    INSERT INTO export_metadata VALUES
      ('schema_version', 'fixture.v1'),
      ('created_at', '2026-07-26T00:00:00Z')
  `);
  database.close();
  return filename;
}

function fixtureSearchDatabase(source: string) {
  const filename = path.join(directory, "public_endpoint-search.sqlite");
  const search = new DatabaseSync(filename);
  search.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE article_search USING fts5(
      metadata,
      body,
      content=''
    );
    INSERT INTO article_search(rowid, metadata, body) VALUES (
      7,
      'A Fixture Article (2026) 1 Fixture LJ 100 Ada Example',
      'The second footnote supports the analysis.'
    );
  `);
  const sourceStat = statSync(source);
  const metadata = search.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?)",
  );
  for (const [key, value] of [
    ["schema_version", "2"],
    ["source_size", String(sourceStat.size)],
    ["source_mtime_ms", String(Math.trunc(sourceStat.mtimeMs))],
    ["source_path", path.resolve(source)],
    ["source_schema_version", "fixture.v1"],
    ["source_created_at", "2026-07-26T00:00:00Z"],
  ]) {
    metadata.run(key, value);
  }
  search.close();
  return filename;
}

function fixtureFinalContractDatabase(options?: {
  annotations?: boolean;
  sourceDir?: string;
}) {
  const registry = path.join(directory, "registry");
  const packageDirectory = path.join(
    directory,
    "data",
    "final-contracts",
    "7",
  );
  mkdirSync(registry, { recursive: true });
  mkdirSync(packageDirectory, { recursive: true });
  const region = (
    id: string,
    type: string,
    order: number,
    text: string,
    lineOrder: number,
  ) => ({
    id,
    type,
    order,
    text,
    lines: [{ codex_text_order: lineOrder, text }],
  });
  const pageOneRegions = [
    region("title-1", "paragraph_title", 1, "I. Native Introduction", 1),
    region(
      "text-1",
      "text",
      2,
      "Canonical opening paragraph with a reference.",
      2,
    ),
    region("note-1", "footnote", 3, "1\t\nNative paired footnote.", 3),
  ];
  const pageTwoRegions = [
    region("title-2", "paragraph_title", 1, "II. Native Analysis", 1),
    region("text-2", "text", 2, "Canonical analysis paragraph.", 2),
  ];
  const pages = [
    {
      article_id: "7",
      pdf_page: 1,
      text: pageOneRegions.map(({ text }) => text).join("\n"),
      regions: pageOneRegions,
      annotations:
        options?.annotations === false
          ? []
          : [
              {
                taxonomy_name: "fn_ref",
                pair_status: "paired",
                pair_id: "pair-1",
                start_line_order: 2,
                selected_text: "1",
                note_id: "1",
              },
              {
                taxonomy_name: "fn_label",
                pair_status: "paired",
                pair_id: "pair-1",
                start_line_order: 3,
                selected_text: "1",
                note_id: "1",
              },
            ],
    },
    {
      article_id: "7",
      pdf_page: 2,
      text: pageTwoRegions.map(({ text }) => text).join("\n"),
      regions: pageTwoRegions,
      annotations: [],
    },
  ];
  writeFileSync(
    path.join(packageDirectory, "pages.jsonl"),
    `${pages.map((page) => JSON.stringify(page)).join("\n")}\n`,
  );

  const filename = path.join(registry, "journals.db");
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE article_final_contracts (
      article_id INTEGER PRIMARY KEY,
      source_dir TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    )
  `);
  database
    .prepare("INSERT INTO article_final_contracts VALUES (?, ?, ?, ?)")
    .run(
      7,
      options?.sourceDir ?? "data\\final-contracts\\7",
      "{}",
      "2026-07-30T00:00:00Z",
    );
  database.close();
  return {
    filename,
    text: pages.map(({ text }) => text).join("\n"),
  };
}

beforeEach(() => {
  previousDatabase = process.env.MIKE_PUBLIC_ENDPOINT_DB;
  previousSearchDatabase = process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB;
  previousFinalContractDatabase =
    process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB;
  process.env.MIKE_PUBLIC_ENDPOINT_DB = fixtureDatabase();
  delete process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB;
  delete process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB;
});

afterEach(() => {
  journal.closeDatabases();
  if (previousDatabase === undefined) {
    delete process.env.MIKE_PUBLIC_ENDPOINT_DB;
  } else {
    process.env.MIKE_PUBLIC_ENDPOINT_DB = previousDatabase;
  }
  if (previousSearchDatabase === undefined) {
    delete process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB;
  } else {
    process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB = previousSearchDatabase;
  }
  if (previousFinalContractDatabase === undefined) {
    delete process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB;
  } else {
    process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB =
      previousFinalContractDatabase;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("local journal articles", () => {
  it("prefers registered final-contract text and native structure", async () => {
    const canonical = fixtureFinalContractDatabase();
    process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB = canonical.filename;
    journal.closeDatabases();

    const article = (await journal.document("7"))!;
    expect(article.text).toBe(canonical.text);
    expect(article.text).not.toContain("[page 100]");
    expect(journal.lookup(article, "page", "101")).toMatchObject({
      status: "found",
      anchor: "page=2",
      block: { origin: "native" },
    });
    expect(journal.lookup(article, "section", "II")).toMatchObject({
      status: "found",
      block: {
        origin: "native",
        text: expect.stringContaining("Canonical analysis paragraph."),
      },
    });
    expect(journal.lookup(article, "footnote", "1")).toMatchObject({
      status: "found",
      anchor: "page=1",
      block: {
        origin: "native",
        text: "1\t\nNative paired footnote.",
      },
    });
    expect(
      article.structure.blocks
        .filter(({ kind }) => kind === "paragraph")
        .map(({ origin, start, end }) => ({
          origin,
          text: article.text.slice(start, end),
        })),
    ).toEqual([
      { origin: "native", text: "Canonical opening paragraph with a reference." },
      { origin: "native", text: "Canonical analysis paragraph." },
    ]);
  });

  it("does not rediscover a locator kind absent from the final contract", async () => {
    const canonical = fixtureFinalContractDatabase({ annotations: false });
    process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB = canonical.filename;
    journal.closeDatabases();

    const article = (await journal.document("7"))!;
    expect(journal.lookup(article, "footnote", "1").status).toBe("unavailable");
    expect(journal.lookup(article, "page", "100").block?.origin).toBe(
      "native",
    );
    expect(journal.lookup(article, "section", "I").block?.origin).toBe(
      "native",
    );
  });

  it("ignores an unsafe final-contract registration", async () => {
    const canonical = fixtureFinalContractDatabase({
      sourceDir: "..\\..\\outside",
    });
    process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB = canonical.filename;
    journal.closeDatabases();

    const article = (await journal.document("7"))!;
    expect(article.text).not.toContain("[page 100]");
    expect(journal.lookup(article, "page", "100").block?.origin).toBe(
      "native",
    );
    expect(journal.lookup(article, "section", "I").status).toBe("unavailable");
    expect(article.structure.blocks.every(({ kind }) => kind === "page")).toBe(true);
  });

  it("searches candidates, resolves page locators, and builds multi-text links", async () => {
    const match = journal.find("Fixture Article")[0];
    expect(match.hitId).toBe("journal:7");
    expect(match.citation).toBe(
      "Ada Example & Grace Example, “A Fixture Article” (2026) 1:2 Fixture LJ 100",
    );

    const article = (await journal.document(String(match.articleId)))!;
    const page = journal.lookup(article, "page", "101");
    expect(page.hitId).toBe("journal:7:page:page101");
    expect(page.anchor).toBe("page=2");

    const url = buildLegalSourcePinpointUrl(
      {
        url: article.url,
        anchor: page.anchor ?? undefined,
        blockText: page.block!.text,
        documentText: article.text,
        pageScoped: true,
      },
      ["first quoted phrase", "second quoted phrase"],
    );
    expect(url).toContain("#page=2:~:text=");
    expect(url?.match(/text=/gu)).toHaveLength(2);
  });

  it("keeps journal URLs private from the model and attaches them to citations", async () => {
    const [searchResult] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "call-0",
          name: "search_sources",
          input: {
            query: "7",
            source_types: ["journal"],
            syntax: "boolean",
          },
        },
      ],
    );
    const modelSearchPayload = JSON.parse(searchResult.content);
    expect(modelSearchPayload.results[0]).toMatchObject({
      provider: "journal",
      identifier: "7",
    });
    expect(modelSearchPayload.results[0]).not.toHaveProperty("url");
    expect(modelSearchPayload.results[0]).not.toHaveProperty("articleId");
    expect(modelSearchPayload.results[0]).not.toHaveProperty("hitId");
    // No separate non-citeable hit_id — the model must not mistake it for
    // a turn-local evidence_id (the actionable handle is article_id).
    expect(modelSearchPayload.results[0]).not.toHaveProperty("hit_id");

    const [toolResult] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "call-1",
          name: "Read",
          input: {
            file_path: modelSearchPayload.results[0].resource,
            locator_kind: "page",
            locator: "101",
          },
        },
      ],
    );

    const modelPayload = JSON.parse(toolResult.content);
    expect(modelPayload.evidence_ids).toHaveLength(1);
    expect(modelPayload.evidence_ids[0]).toMatch(/^e_/u);
    expect(modelPayload.passages[0]).toMatchObject({
      role: "selected",
      evidence_id: modelPayload.evidence_ids[0],
    });
    expect(modelPayload).not.toHaveProperty("hit_id");
    expect(modelPayload).not.toHaveProperty("url");

  });

  it("formats four-plus authors and an empty issue without a fallback citation", async () => {
    journal.closeDatabases();
    const database = new DatabaseSync(process.env.MIKE_PUBLIC_ENDPOINT_DB!);
    database.prepare(`INSERT INTO articles (
      article_id, dataset, citation_en, name_en, authors, document_date_en,
      volume, issue, first_page, url_en, journal_abbrev, galley_url, text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      8, "FIXTURE", "stored citation", "No Issue Article",
      "Ada Example; Grace Example; Lin Example; Sam Example", "2025-03-01",
      "9", "", "44", "https://example.test/no-issue",
      "Fixture LJ", "https://example.test/no-issue.pdf",
      "A complete paragraph long enough for deterministic source structure.",
    );
    database.close();
    expect((await journal.document("8"))?.citation).toBe(
      "Ada Example et al, “No Issue Article” (2025) 9 Fixture LJ 44",
    );
  });

  it("filters journal search by indexed publication metadata", () => {
    expect(
      journal.find("Fixture Article", 10, {
        author: "Ada",
        journal: "Fixture LJ",
        startDate: "2025-01-01",
        endDate: "2026-12-31",
      })[0]?.articleId,
    ).toBe(7);
    expect(
      journal.find("Fixture Article", 10, { author: "Lin" }),
    ).toEqual([]);
    expect(
      journal.find("Fixture Article", 10, { journal: "Other" }),
    ).toEqual([]);
    expect(
      journal.find("Fixture Article", 10, {
        startDate: "2027-01-01",
      }),
    ).toEqual([]);
  });

  it("drops a cached FTS sidecar when the source database changes", () => {
    const source = process.env.MIKE_PUBLIC_ENDPOINT_DB!;
    process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB = fixtureSearchDatabase(source);
    expect(journal.find("second footnote")[0]?.articleId).toBe(7);

    const future = new Date(Date.now() + 2_000);
    utimesSync(source, future, future);
    expect(journal.find("second footnote")).toEqual([]);
  });

  it("drops a cached FTS sidecar when the configured source path changes", () => {
    const source = process.env.MIKE_PUBLIC_ENDPOINT_DB!;
    process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB = fixtureSearchDatabase(source);
    expect(journal.find("second footnote")[0]?.articleId).toBe(7);

    const replacement = path.join(directory, "replacement.db");
    const sourceStat = statSync(source);
    copyFileSync(source, replacement);
    utimesSync(replacement, sourceStat.atime, sourceStat.mtime);
    process.env.MIKE_PUBLIC_ENDPOINT_DB = replacement;

    expect(journal.find("second footnote")).toEqual([]);
  });

  it("drops parsed article state when the source snapshot changes", async () => {
    const source = process.env.MIKE_PUBLIC_ENDPOINT_DB!;
    const first = await journal.document("7");
    const future = new Date(Date.now() + 2_000);
    utimesSync(source, future, future);

    expect(await journal.document("7")).not.toBe(first);
  });

  it("removes plaintext page markers and exposes only pages when pages.jsonl is absent", async () => {
    const fixtureDir = path.join(__dirname, "fixtures", "nativemarkup");
    const captured = JSON.parse(
      readFileSync(path.join(fixtureDir, "journal-alr-13.json"), "utf8"),
    ) as {
      row: Record<string, unknown>;
      pageRows: Array<{ page_label: string; pdf_page: number }>;
    };
    const filename = path.join(directory, "captured.db");
    const database = new DatabaseSync(filename);
    database.exec(`
      CREATE TABLE articles (
        article_id INTEGER PRIMARY KEY, dataset TEXT NOT NULL, citation_en TEXT,
        name_en TEXT NOT NULL, authors TEXT, document_date_en TEXT, volume TEXT,
        issue TEXT,
        first_page TEXT, url_en TEXT, abstract TEXT, journal_name TEXT,
        journal_abbrev TEXT, galley_url TEXT, upstream_license TEXT, text TEXT
      );
      CREATE TABLE article_pages (
        article_id INTEGER NOT NULL, page_order INTEGER NOT NULL,
        page_label TEXT NOT NULL, pdf_page INTEGER NOT NULL
      );
      CREATE TABLE export_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const row = captured.row;
    database
      .prepare(
        `INSERT INTO articles (
          article_id, dataset, citation_en, name_en, authors, document_date_en,
          volume, issue, first_page, url_en, abstract, journal_name, journal_abbrev,
          galley_url, upstream_license, text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ...([
          "article_id",
          "dataset",
          "citation_en",
          "name_en",
          "authors",
          "document_date_en",
          "volume",
          "issue",
          "first_page",
          "url_en",
          "abstract",
          "journal_name",
          "journal_abbrev",
          "galley_url",
          "upstream_license",
          "text",
        ].map((column) => (row[column] ?? null) as string | number | null)),
      );
    const insertPage = database.prepare(
      "INSERT INTO article_pages VALUES (13, ?, ?, ?)",
    );
    captured.pageRows.forEach((page, index) => {
      insertPage.run(index + 1, page.page_label, page.pdf_page);
    });
    database.close();
    journal.closeDatabases();
    process.env.MIKE_PUBLIC_ENDPOINT_DB = filename;

    const article = (await journal.document("13"))!;
    expect(article.text).not.toMatch(/^\[page [^\]]+\]\r?$/m);
    expect(article.structure.blocks.every(({ kind }) => kind === "page")).toBe(true);
    expect(article.structure.blocks.every(({ origin }) => origin === "native")).toBe(true);
    expect(journal.lookup(article, "page", captured.pageRows[0].page_label)).toMatchObject({
      status: "found",
      block: { origin: "native" },
    });
  });
});

const realDatabase =
  process.env.MIKE_PUBLIC_ENDPOINT_DB ||
  "";

it.runIf(existsSync(realDatabase))(
  "reads a real public_endpoint.db article and native page map",
  async () => {
    journal.closeDatabases();
    process.env.MIKE_PUBLIC_ENDPOINT_DB = realDatabase;
    const article = await journal.document("2");
    expect(article?.title).toContain("Alcohol Manufacturers");
    expect(journal.lookup(article!, "page", "9").anchor).toBe("page=9");
    expect(journal.find("consumers fetal alcohol")[0]?.articleId).toBe(2);
  },
);
