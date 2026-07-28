/**
 * Hot-path benchmark for the provider structure pipeline (master plan P1.1a
 * stage 4), the sibling of bench-pinpoint.ts.
 *
 * Measures, on the real captured fixtures in fixtures/nativemarkup:
 *
 *   B1 compile   - markup/text -> structure artifact (TNA XML, CAP HTML)
 *   B2 lookup    - the frozen locator battery over one compiled artifact
 *   B3 journal   - article fetch+compile and its locator battery
 *
 *   npx tsx scripts/bench-structure.ts --label before   (base-commit worktree)
 *   npx tsx scripts/bench-structure.ts --label after
 *
 * The engine is feature-detected so the same script measures the tree that
 * still has legalSourceStructure and the tree where SourceDoc replaced it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const FIXTURES = path.join(
  __dirname,
  "..",
  "src",
  "lib",
  "__tests__",
  "fixtures",
  "nativemarkup",
);
const OUTPUT_DIR = path.join(__dirname, "..", "..", "benchmarks", "sourcedoc");

function argument(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const LABEL = argument("label", "current");
const RUNS = Math.max(5, Number(argument("runs", "7")));

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"),
  ) as T;
}

type Recording = {
  lookups: Array<{ kind: string; locator: string }>;
};
const RECORDINGS = JSON.parse(
  readFileSync(path.join(FIXTURES, "legacy-structure.json"), "utf8"),
) as Record<string, Recording>;

type Engine = {
  name: string;
  compile: (args: {
    provider: string;
    id: string;
    text: string;
    markup?: string | null;
    citation?: string | null;
  }) => unknown;
  lookup: (
    doc: unknown,
    kind: string,
    locator: string,
    context: number,
  ) => unknown;
};

async function detectEngine(): Promise<Engine> {
  try {
    const current = (await import(
      "../src/lib/sourceDocNativeMarkup"
    )) as typeof import("../src/lib/sourceDocNativeMarkup");
    return {
      name: "sourceDocNativeMarkup",
      compile: (args) =>
        current.compileNativeMarkupSourceDoc({
          provider: args.provider as never,
          id: args.id,
          text: args.text,
          markup: args.markup,
          citation: args.citation,
        }),
      lookup: (doc, kind, locator, context) =>
        current.lookupLegalSourceDoc(
          doc as never,
          kind as never,
          locator,
          context,
        ),
    };
  } catch {
    const legacy = (await import(
      "../src/lib/" + "legalSourceStructure"
    )) as {
      buildLegalSourceStructure: (args: object) => unknown;
      lookupLegalSourceStructure: (
        structure: never,
        kind: never,
        locator: string,
        context: number,
      ) => unknown;
    };
    return {
      name: "legalSourceStructure",
      compile: (args) =>
        legacy.buildLegalSourceStructure({
          provider: args.provider,
          text: args.text,
          markup: args.markup,
          docType: "cases",
          citation: args.citation,
        }),
      lookup: (doc, kind, locator, context) =>
        legacy.lookupLegalSourceStructure(
          doc as never,
          kind as never,
          locator,
          context,
        ),
    };
  }
}

function median(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

type Case = {
  name: string;
  unit: string;
  units: number;
  bytes: number;
  run: () => void;
};

type Measurement = {
  name: string;
  unit: string;
  units: number;
  bytes: number;
  medianMs: number;
  perUnitMs: number;
  runsMs: number[];
};

function measure(testCase: Case): Measurement {
  testCase.run(); // warm the compiled artifacts and JIT
  const runs: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    testCase.run();
    runs.push(performance.now() - started);
  }
  const value = median(runs);
  return {
    name: testCase.name,
    unit: testCase.unit,
    units: testCase.units,
    bytes: testCase.bytes,
    medianMs: value,
    perUnitMs: value / testCase.units,
    runsMs: runs.map((item) => Number(item.toFixed(2))),
  };
}

async function journalCases(): Promise<Case[]> {
  const journal = (await import(
    "../src/lib/journalArticles"
  )) as typeof import("../src/lib/journalArticles");
  const captured = fixture<{
    row: Record<string, unknown>;
    pageRows: Array<{ page_label: string; pdf_page: number }>;
  }>("journal-alr-13");
  const directory = path.join(
    os.tmpdir(),
    `bench-structure-${process.pid}-${Date.now()}`,
  );
  mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "public_endpoint.db");
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE articles (
      article_id INTEGER PRIMARY KEY, dataset TEXT NOT NULL, citation_en TEXT,
      name_en TEXT NOT NULL, authors TEXT, document_date_en TEXT, volume TEXT,
      first_page TEXT, url_en TEXT, abstract TEXT, journal_name TEXT,
      journal_abbrev TEXT, galley_url TEXT, upstream_license TEXT, text TEXT
    );
    CREATE TABLE article_pages (
      article_id INTEGER NOT NULL, page_order INTEGER NOT NULL,
      page_label TEXT NOT NULL, pdf_page INTEGER NOT NULL
    );
    CREATE TABLE export_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  database
    .prepare(
      `INSERT INTO articles (
        article_id, dataset, citation_en, name_en, authors, document_date_en,
        volume, first_page, url_en, abstract, journal_name, journal_abbrev,
        galley_url, upstream_license, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ...[
        "article_id",
        "dataset",
        "citation_en",
        "name_en",
        "authors",
        "document_date_en",
        "volume",
        "first_page",
        "url_en",
        "abstract",
        "journal_name",
        "journal_abbrev",
        "galley_url",
        "upstream_license",
        "text",
      ].map((column) => (captured.row[column] ?? null) as string | null),
    );
  const insertPage = database.prepare(
    "INSERT INTO article_pages VALUES (13, ?, ?, ?)",
  );
  captured.pageRows.forEach((page, index) => {
    insertPage.run(index + 1, page.page_label, page.pdf_page);
  });
  database.close();
  process.env.MIKE_PUBLIC_ENDPOINT_DB = filename;
  delete process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB;

  const bytes = String(captured.row.text ?? "").length;
  const battery = RECORDINGS["journal-alr-13"].lookups;
  const article = journal.fetchJournalArticle("13")!;
  return [
    {
      name: "B3 journal fetch+compile/alr-13",
      unit: "fetch",
      units: 1,
      bytes,
      run: () => {
        journal.closeJournalDatabases();
        journal.fetchJournalArticle("13");
      },
    },
    {
      name: "B3 journal lookup battery/alr-13",
      unit: "lookup",
      units: battery.length,
      bytes,
      run: () => {
        for (const { kind, locator } of battery) {
          journal.lookupJournalArticle(article, kind as never, locator, 2);
        }
      },
    },
  ];
}

async function cases(): Promise<Case[]> {
  const engine = await detectEngine();
  console.log(`engine: ${engine.name}`);
  const list: Case[] = [];

  for (const [file, provider, citation] of [
    ["tna-eat-2025-1", "tna", "[2025] EAT 1"],
    ["courtlistener-cap-372us335", "courtlistener", "372 U.S. 335"],
  ] as const) {
    const source = fixture<{ markup: string }>(file);
    const battery = RECORDINGS[file].lookups;
    list.push({
      name: `B1 compile/${file}`,
      unit: "compile",
      units: 1,
      bytes: source.markup.length,
      run: () => {
        engine.compile({
          provider,
          id: citation,
          text: "",
          markup: source.markup,
          citation,
        });
      },
    });
    const compiled = engine.compile({
      provider,
      id: citation,
      text: "",
      markup: source.markup,
      citation,
    });
    list.push({
      name: `B2 lookup battery/${file}`,
      unit: "lookup",
      units: battery.length,
      bytes: source.markup.length,
      run: () => {
        for (const { kind, locator } of battery) {
          engine.lookup(compiled, kind, locator, 2);
        }
      },
    });
  }

  list.push(...(await journalCases()));
  return list;
}

function previous(label: string): Measurement[] | null {
  try {
    return JSON.parse(
      readFileSync(
        path.join(OUTPUT_DIR, `bench-structure-${label}.json`),
        "utf8",
      ),
    ).measurements as Measurement[];
  } catch {
    return null;
  }
}

(async () => {
  const measurements = (await cases()).map(measure);
  const baseline =
    LABEL === "before" ? null : (previous("before") ?? previous("current"));

  const width = Math.max(...measurements.map(({ name }) => name.length));
  console.log(
    `${"case".padEnd(width)}  ${"ms/unit".padStart(9)}  ${"total ms".padStart(9)}  ${"vs before".padStart(10)}`,
  );
  for (const item of measurements) {
    const before = baseline?.find((entry) => entry.name === item.name);
    const speedup = before
      ? `${(before.perUnitMs / item.perUnitMs).toFixed(1)}x`
      : "-";
    console.log(
      `${item.name.padEnd(width)}  ${item.perUnitMs.toFixed(3).padStart(9)}  ${item.medianMs.toFixed(1).padStart(9)}  ${speedup.padStart(10)}`,
    );
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const output = path.join(OUTPUT_DIR, `bench-structure-${LABEL}.json`);
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        label: LABEL,
        runs: RUNS,
        node: process.version,
        capturedAt: new Date().toISOString(),
        measurements,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\nwrote ${output}`);
})();
