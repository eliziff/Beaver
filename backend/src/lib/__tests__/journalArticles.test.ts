import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeJournalDatabases,
  fetchJournalArticle,
  lookupJournalArticle,
  searchJournalArticles,
} from "../journalArticles";
import { createCitation, parseCitations } from "../chat/citations";
import {
  appendPublicLegalPinpointLinks,
  buildPublicLegalCitationUrl,
  createPublicLegalSourceState,
} from "../chat/publicLegalSourceState";
import { runLocalAssistantTools } from "../chat/localAssistantTools";
import { PUBLIC_LEGAL_SOURCE_TOOL_NAMES } from "../chat/tools/publicLegalSourceTools";
import { buildLegalSourcePinpointUrl } from "../legalSourceLinks";

let directory = "";
let previousDatabase: string | undefined;
let previousSearchDatabase: string | undefined;

function fixtureDatabase() {
  directory = mkdtempSync(path.join(os.tmpdir(), "mike-journals-"));
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
        volume, first_page, url_en, abstract, journal_name, journal_abbrev,
        galley_url, upstream_license, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      7,
      "FIXTURE",
      "(2026) 1 Fixture LJ 100",
      "A Fixture Article",
      "Ada Example",
      "2026",
      "1",
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

beforeEach(() => {
  previousDatabase = process.env.MIKE_PUBLIC_ENDPOINT_DB;
  previousSearchDatabase = process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB;
  process.env.MIKE_PUBLIC_ENDPOINT_DB = fixtureDatabase();
  delete process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB;
});

afterEach(() => {
  closeJournalDatabases();
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
  rmSync(directory, { recursive: true, force: true });
});

describe("local journal articles", () => {
  it("searches candidates, resolves stable locators, and builds multi-text links", () => {
    const match = searchJournalArticles("Fixture Article")[0];
    expect(match.hitId).toBe("journal:7");

    const article = fetchJournalArticle(String(match.articleId))!;
    const page = lookupJournalArticle(article, "page", "101");
    const section = lookupJournalArticle(article, "section", "II");
    const footnote = lookupJournalArticle(article, "footnote", "2");
    expect(page.hitId).toBe("journal:7:page:page101");
    expect(page.anchor).toBe("page=2");
    expect(section.block?.text).toContain("II. Analysis");
    expect(footnote.block?.text).toContain("second footnote");

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
    const state = createPublicLegalSourceState();
    const [searchResult, toolResult] = await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "call-0",
          name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.search,
          input: {
            provider: "journal",
            query: "Fixture Article",
          },
        },
        {
          id: "call-1",
          name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup,
          input: {
            provider: "journal",
            identifier: "7",
            locator_type: "page",
            locator: "101",
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      state,
    );
    const modelSearchPayload = JSON.parse(searchResult.content);
    expect(modelSearchPayload.results[0]).toMatchObject({
      article_id: 7,
      hit_id: "journal:7",
    });
    expect(modelSearchPayload.results[0]).not.toHaveProperty("url");
    expect(modelSearchPayload.results[0]).not.toHaveProperty("articleId");
    expect(modelSearchPayload.results[0]).not.toHaveProperty("hitId");

    const modelPayload = JSON.parse(toolResult.content);
    expect(modelPayload.hit_id).toBe("journal:7:page:page101");
    expect(modelPayload).not.toHaveProperty("url");

    const [parsed] = parseCitations(
      `<CITATIONS>${JSON.stringify([
        {
          ref: 1,
          source: "public_legal",
          provider: "journal",
          identifier: "7",
          quotes: [
            { quote: "first quoted phrase" },
            { quote: "second quoted phrase" },
          ],
        },
      ])}</CITATIONS>`,
    );
    const citation = createCitation(parsed, {}, undefined, [], [], state) as {
      url: string;
    };
    expect(citation.url).toContain("#page=2:~:text=");
    expect(citation.url.match(/text=/gu)).toHaveLength(2);
  });

  it("appends one verified multi-text page link when citation JSON is omitted", async () => {
    const state = createPublicLegalSourceState();
    await runLocalAssistantTools(
      "local-user",
      [
        {
          id: "call-1",
          name: PUBLIC_LEGAL_SOURCE_TOOL_NAMES.lookup,
          input: {
            provider: "journal",
            identifier: "7",
            locator_type: "page",
            locator: "101",
          },
        },
      ],
      undefined,
      undefined,
      undefined,
      state,
    );
    const answer =
      'The article says "first quoted phrase" and "second quoted phrase" [1].';
    const linked = appendPublicLegalPinpointLinks(answer, state);

    expect(linked).toContain("Source: [A Fixture Article, p. 101]");
    expect(linked).toContain("#page=2:~:text=");
    expect(linked.match(/text=/gu)).toHaveLength(2);
    expect(appendPublicLegalPinpointLinks(linked, state)).toBe(linked);

    const citationUrl = buildPublicLegalCitationUrl(
      {
        provider: "journal",
        identifier: "7",
        quotes: [
          { quote: "first quoted phrase" },
          { quote: "second quoted phrase" },
        ],
      },
      state,
    )!;
    expect(
      appendPublicLegalPinpointLinks(answer, state, [citationUrl]),
    ).toBe(answer);
  });

  it("drops a cached FTS sidecar when the source database changes", () => {
    const source = process.env.MIKE_PUBLIC_ENDPOINT_DB!;
    process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB = fixtureSearchDatabase(source);
    expect(searchJournalArticles("second footnote")[0]?.articleId).toBe(7);

    const future = new Date(Date.now() + 2_000);
    utimesSync(source, future, future);
    expect(searchJournalArticles("second footnote")).toEqual([]);
  });

  it("drops a cached FTS sidecar when the configured source path changes", () => {
    const source = process.env.MIKE_PUBLIC_ENDPOINT_DB!;
    process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB = fixtureSearchDatabase(source);
    expect(searchJournalArticles("second footnote")[0]?.articleId).toBe(7);

    const replacement = path.join(directory, "replacement.db");
    const sourceStat = statSync(source);
    copyFileSync(source, replacement);
    utimesSync(replacement, sourceStat.atime, sourceStat.mtime);
    process.env.MIKE_PUBLIC_ENDPOINT_DB = replacement;

    expect(searchJournalArticles("second footnote")).toEqual([]);
  });

  it("drops parsed article state when the source snapshot changes", () => {
    const source = process.env.MIKE_PUBLIC_ENDPOINT_DB!;
    const first = fetchJournalArticle("7");
    const future = new Date(Date.now() + 2_000);
    utimesSync(source, future, future);

    expect(fetchJournalArticle("7")).not.toBe(first);
  });
});

const realDatabase =
  process.env.MIKE_PUBLIC_ENDPOINT_DB ||
  "C:\\Users\\elias\\Desktop\\Martys Qote Verifier\\ALR-Quote-Verifier\\data\\public_endpoint.db";

it.runIf(existsSync(realDatabase))(
  "reads a real public_endpoint.db article and native page map",
  () => {
    closeJournalDatabases();
    process.env.MIKE_PUBLIC_ENDPOINT_DB = realDatabase;
    const article = fetchJournalArticle("2");
    expect(article?.title).toContain("Alcohol Manufacturers");
    expect(lookupJournalArticle(article!, "page", "9").anchor).toBe("page=9");
    expect(searchJournalArticles("consumers fetal alcohol")[0]?.articleId).toBe(2);
  },
);
