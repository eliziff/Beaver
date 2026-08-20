import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  lookupSourceDoc,
  createSourceDoc,
  type SourceDoc,
  type SourceDocBlock,
  type SourceDocLocatorKind,
} from "../../src/lib/sourceDoc";
import { compileA2AJSourceDoc } from "../../src/lib/sourceDocA2AJ";
import { compileNativeMarkupSourceDoc } from "../../src/lib/sourceDocNativeMarkup";
import { journalLegalSourceProvider as journal } from "../../src/lib/legalSources/journal";
import rawCoverage from "./coverage.json";

const FIXTURES = path.join(__dirname, "../../src/lib/__tests__/fixtures");
const KINDS: SourceDocLocatorKind[] = ["paragraph", "page", "section", "footnote"];
const REQUIRED_ROWS = [
  "a2aj/flat-case", "a2aj/flat-law", "a2aj/hybrid-section-map",
  "a2aj/native-section-map", "courtlistener/native-cap",
  "courtlistener/hybrid-opinion", "courtlistener/flat-opinion",
  "tna/native-akn", "tna/hybrid-akn", "govinfo/flat-text",
  "govuk-et/flat-text", "journal/hybrid-legacy",
  "journal/native-final-contract", "journal/hybrid-final-contract-recovery",
  "local-pdf/native-source-doc", "local-pdf/hybrid-source-doc",
  "local-pdf/flat-source-doc",
] as const;
const REQUIRED_CORPORA = [
  "checked-in/a2aj-sourcedoc", "checked-in/native-markup",
  "local/a2aj-bulk", "local/courtlistener-bulk",
  "local/courtlistener-structure-audit-v2", "local/journals",
  "local/legal-pdf-corpus",
] as const;
const APPLICABLE_MODES = {
  a2aj: ["flat", "hybrid", "native"],
  courtlistener: ["flat", "hybrid", "native"],
  tna: ["native"],
  govinfo: ["flat"],
  "govuk-et": ["flat"],
  journal: ["hybrid", "native"],
  "local-pdf": ["flat", "hybrid", "native"],
} as const satisfies Record<
  NonNullable<SourceDoc["provider"]>,
  readonly ("native" | "hybrid" | "flat")[]
>;
const SERIALIZER_CONTRACT = JSON.stringify({
  schema: "source-structure-parity.v1",
  document: ["provider", "id", "status", "mode", "revision", "text"],
  block: ["kind", "label", "start", "end", "origin", "anchor", "aliases", "parent_label"],
  ranges: KINDS,
  lookups: "every ordered block label, alias, and anchor; context=2; full materialized blocks",
});
const LEGALPDF_BASELINE_BINARY =
  "85be89d29d6cfde928eaac66a7834d26568bbca25b467fbccf6945b1bd3075b4";

type Row = {
  id: string;
  provider: string;
  mode: "native" | "hybrid" | "flat";
  capture: string | null;
  provenance: "real-captured" | null;
  status: "frozen" | "missing" | "not_applicable";
  capture_sha256?: string;
  baseline_sha256?: string;
  baseline_bytes?: number;
  blocker?: string;
};
type Coverage = {
  schema_version: string;
  baseline_commit: string;
  serializer_contract_sha256: string;
  corpora: Array<{ id: string; documents: number; detail: string }>;
  anti_cheat: string[];
  applicability_proofs: Array<{
    id: string;
    status: "not_applicable";
    corpus: string;
    query_sha256: string;
    observed: Record<string, number>;
    reason: string;
  }>;
  rows: Row[];
};
const coverage = rawCoverage as Coverage;

function fixture<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, relative), "utf8")) as T;
}

type A2AJInput = Parameters<typeof compileA2AJSourceDoc>[0];
const a2ajCase = fixture<A2AJInput>("sourcedoc/a2aj-case-scc-2026scc16-toc.json");
const a2ajLaw = fixture<A2AJInput>("sourcedoc/a2aj-laws-fed-criminalcode-s231.json");
const a2ajMap = fixture<A2AJInput>("sourcedoc/a2aj-laws-fed-criminalcode-sectionmap.json");
const a2ajNative = fixture<A2AJInput>("sourcedoc/a2aj-laws-ab-abc-benefits-s8.json");
const tna = fixture<{ citation: string; markup: string }>("nativemarkup/tna-eat-2025-1.json");
const cap = fixture<{ citation: string; markup: string }>("nativemarkup/courtlistener-cap-372us335.json");
const govuk = fixture<{ caseNumber: string; text: string }>("nativemarkup/govuk-et-kogut-2200123-2023.json");
const govinfo = fixture<{ packageId: string; text: string }>("nativemarkup/govinfo-nywd-1-22-cv-00930.json");
const capturedJournal = fixture<{
  row: Record<string, unknown>;
  pageRows: Array<{ page_label: string; pdf_page: number }>;
}>("nativemarkup/journal-alr-13.json");
type CourtListenerCapture = {
  id: string;
  text?: string;
  markup?: string;
};
type JournalFinalCapture = {
  row: Record<string, unknown>;
  pageRows: Array<{ page_label: string; pdf_page: number }>;
  pages_gzip_base64: string;
  provenance: { source_dir: string; registered_at_utc: string; pages_sha256: string };
};
type LocalPdfCapture = {
  provenance: {
    frozen_binary_sha256: string;
    source_relative_path: string;
  };
  response: {
    result: {
      source_doc: Parameters<typeof createSourceDoc>[0];
    };
    source: { sha256: string };
  };
};
const courtHybrid = fixture<CourtListenerCapture>("nativemarkup/courtlistener-hybrid-2072234.json");
const courtFlat = fixture<CourtListenerCapture>("nativemarkup/courtlistener-flat-5134833.json");
const journalNative = fixture<JournalFinalCapture>("nativemarkup/journal-final-native-12027.json");
const journalRecovery = fixture<JournalFinalCapture>("nativemarkup/journal-final-recovery-9284.json");
const localNative = fixture<LocalPdfCapture>("legalpdf/local-pdf-native.json");
const localHybrid = fixture<LocalPdfCapture>("legalpdf/local-pdf-hybrid.json");
const localFlat = fixture<LocalPdfCapture>("legalpdf/local-pdf-flat.json");

let temporary = "";
let priorDatabase: string | undefined;
let priorFinalDatabase: string | undefined;

beforeAll(() => {
  priorDatabase = process.env.MIKE_PUBLIC_ENDPOINT_DB;
  priorFinalDatabase = process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB;
  temporary = mkdtempSync(path.join(os.tmpdir(), "source-structure-parity-"));
  const filename = path.join(temporary, "journals.db");
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE articles (
      article_id INTEGER PRIMARY KEY, dataset TEXT NOT NULL, citation_en TEXT,
      name_en TEXT NOT NULL, authors TEXT, document_date_en TEXT, volume TEXT,
      issue TEXT, first_page TEXT, url_en TEXT, abstract TEXT,
      journal_name TEXT, journal_abbrev TEXT, galley_url TEXT,
      upstream_license TEXT, text TEXT
    );
    CREATE TABLE article_pages (
      article_id INTEGER NOT NULL, page_order INTEGER NOT NULL,
      page_label TEXT NOT NULL, pdf_page INTEGER NOT NULL
    );
    CREATE TABLE export_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const columns = [
    "article_id", "dataset", "citation_en", "name_en", "authors",
    "document_date_en", "volume", "issue", "first_page", "url_en",
    "abstract", "journal_name", "journal_abbrev", "galley_url",
    "upstream_license", "text",
  ];
  const insertArticle = database.prepare(
    `INSERT INTO articles (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  const insertPage = database.prepare("INSERT INTO article_pages VALUES (?, ?, ?, ?)");
  for (const capture of [capturedJournal, journalNative, journalRecovery]) {
    insertArticle.run(...columns.map((column) => capture.row[column] as never));
    capture.pageRows.forEach((page, index) => insertPage.run(
      capture.row.article_id as number, index + 1, page.page_label, page.pdf_page,
    ));
  }
  database.close();
  const finalDatabase = path.join(temporary, "final-contracts.db");
  const contracts = new DatabaseSync(finalDatabase);
  contracts.exec(`CREATE TABLE article_final_contracts (
    article_id INTEGER PRIMARY KEY, source_dir TEXT NOT NULL,
    payload_json TEXT NOT NULL, updated_at_utc TEXT NOT NULL
  )`);
  const register = contracts.prepare("INSERT INTO article_final_contracts VALUES (?, ?, '{}', ?)");
  for (const capture of [journalNative, journalRecovery]) {
    const pages = path.resolve(
      temporary,
      capture.provenance.source_dir.replace(/[\\/]+/gu, path.sep),
      "pages.jsonl",
    );
    mkdirSync(path.dirname(pages), { recursive: true });
    const rawPages = gunzipSync(Buffer.from(capture.pages_gzip_base64, "base64"));
    expect(createHash("sha256").update(rawPages).digest("hex")).toBe(
      capture.provenance.pages_sha256,
    );
    writeFileSync(pages, rawPages);
    register.run(
      capture.row.article_id as number,
      capture.provenance.source_dir,
      capture.provenance.registered_at_utc,
    );
  }
  contracts.close();
  process.env.MIKE_PUBLIC_ENDPOINT_DB = filename;
  process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB = finalDatabase;
  journal.closeDatabases();
});

afterAll(() => {
  journal.closeDatabases();
  if (priorDatabase === undefined) delete process.env.MIKE_PUBLIC_ENDPOINT_DB;
  else process.env.MIKE_PUBLIC_ENDPOINT_DB = priorDatabase;
  if (priorFinalDatabase === undefined) delete process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB;
  else process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB = priorFinalDatabase;
  rmSync(temporary, { recursive: true, force: true });
});

function mode(doc: SourceDoc): Row["mode"] {
  const origins = new Set(doc.blocks.map(({ origin }) => origin));
  return origins.has("native")
    ? origins.has("heuristic") ? "hybrid" : "native"
    : "flat";
}

function block(value: SourceDocBlock & { text?: string }) {
  return {
    kind: value.kind,
    label: value.label,
    start: value.start,
    end: value.end,
    origin: value.origin,
    anchor: value.anchor ?? null,
    aliases: value.aliases ?? [],
    parent_label: value.parentLabel ?? null,
    ...(value.text === undefined ? {} : { text: value.text }),
  };
}

function canonicalBytes(doc: SourceDoc) {
  const requests = new Map<string, { kind: SourceDocLocatorKind; value: string }>();
  for (const item of doc.blocks) {
    for (const value of [item.label, ...(item.aliases ?? []), item.anchor]) {
      if (value) requests.set(`${item.kind}\0${value}`, { kind: item.kind, value });
    }
  }
  const lookups = [...requests.values()]
    .sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value),
    )
    .map(({ kind, value }) => {
      const found = lookupSourceDoc(doc, kind, value, 2);
      return {
        kind,
        value,
        status: found.status,
        requested_label: found.requestedLabel,
        matches: found.matches,
        block: found.block ? block(found.block) : null,
        before: found.before.map(block),
        after: found.after.map(block),
      };
    });
  return Buffer.from(JSON.stringify({
    schema_version: "source-structure-parity.v1",
    provider: doc.provider,
    id: doc.id,
    status: doc.status,
    mode: mode(doc),
    revision: doc.revision,
    text: doc.text,
    blocks: doc.blocks.map(block),
    ranges: Object.fromEntries(KINDS.map((kind) => [kind, doc.ranges[kind]])),
    lookups,
  }));
}

function capturedRows() {
  return new Map<string, SourceDoc>([
    ["a2aj/flat-case", compileA2AJSourceDoc(a2ajCase)],
    ["a2aj/flat-law", compileA2AJSourceDoc(a2ajLaw)],
    ["a2aj/hybrid-section-map", compileA2AJSourceDoc(a2ajMap)],
    ["a2aj/native-section-map", compileA2AJSourceDoc(a2ajNative)],
    ["courtlistener/native-cap", compileNativeMarkupSourceDoc({
      provider: "courtlistener", id: cap.citation, text: "", ...cap,
    })],
    ["courtlistener/hybrid-opinion", compileNativeMarkupSourceDoc({
      provider: "courtlistener", id: courtHybrid.id,
      text: courtHybrid.text ?? courtHybrid.markup ?? "", markup: courtHybrid.markup,
    })],
    ["courtlistener/flat-opinion", compileNativeMarkupSourceDoc({
      provider: "courtlistener", id: courtFlat.id,
      text: courtFlat.text ?? courtFlat.markup ?? "", markup: courtFlat.markup,
    })],
    ["tna/native-akn", compileNativeMarkupSourceDoc({
      provider: "tna", id: tna.citation, text: "", ...tna,
    })],
    ["govinfo/flat-text", compileNativeMarkupSourceDoc({
      provider: "govinfo", id: govinfo.packageId, text: govinfo.text,
    })],
    ["govuk-et/flat-text", compileNativeMarkupSourceDoc({
      provider: "govuk-et", id: govuk.caseNumber, text: govuk.text,
    })],
    ["journal/hybrid-legacy", journal.document("13")!.structure],
    ["journal/native-final-contract", journal.document("12027")!.structure],
    ["journal/hybrid-final-contract-recovery", journal.document("9284")!.structure],
    ["local-pdf/native-source-doc", createSourceDoc(localNative.response.result.source_doc)],
    ["local-pdf/hybrid-source-doc", createSourceDoc(localHybrid.response.result.source_doc)],
    ["local-pdf/flat-source-doc", createSourceDoc(localFlat.response.result.source_doc)],
  ]);
}

test("coverage ledger cannot hide modes, synthetic rows, or missing captures", () => {
  expect(coverage.baseline_commit).toBe("5d29906341d17239e5e36a5442ca665f5f2a12f0");
  expect(coverage.rows.map(({ id }) => id).sort()).toEqual([...REQUIRED_ROWS].sort());
  expect(new Set(coverage.rows.map(({ id }) => id)).size).toBe(coverage.rows.length);
  expect(Object.fromEntries(Object.keys(APPLICABLE_MODES).sort().map((provider) => [
    provider,
    [...new Set(coverage.rows
      .filter((row) => row.provider === provider && row.status !== "not_applicable")
      .map(({ mode }) => mode))].sort(),
  ]))).toEqual(Object.fromEntries(Object.entries(APPLICABLE_MODES)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, modes]) => [provider, [...modes].sort()])));
  expect(coverage.corpora.map(({ id }) => id).sort()).toEqual([...REQUIRED_CORPORA].sort());
  expect(coverage.anti_cheat).toHaveLength(6);
  expect(coverage.applicability_proofs).toHaveLength(2);
  for (const proof of coverage.applicability_proofs) {
    expect(createHash("sha256").update(JSON.stringify(proof.observed)).digest("hex"), proof.id)
      .toBe(proof.query_sha256);
  }
  expect(coverage.applicability_proofs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: "journal/flat-text",
      status: "not_applicable",
      corpus: "local/journals",
      observed: {
        shippable_articles: 18595,
        shippable_articles_with_page_claims: 18595,
        shippable_articles_without_page_claims: 0,
      },
    }),
    expect.objectContaining({
      id: "tna/hybrid-akn",
      status: "not_applicable",
      corpus: "checked-in/native-markup",
    }),
  ]));
  const tnaFiles = readdirSync(path.join(FIXTURES, "nativemarkup"))
    .filter((name) => /^tna-.*\.json$/u.test(name));
  const tnaModes = tnaFiles.map((name) => {
    const source = fixture<{ citation: string; markup: string }>(`nativemarkup/${name}`);
    return mode(compileNativeMarkupSourceDoc({
      provider: "tna", id: source.citation, text: "", ...source,
    }));
  });
  const localProviders = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "OpenLegalProducts", "LegalData", "providers", "tna")
    : null;
  expect(coverage.applicability_proofs.find(({ id }) => id === "tna/hybrid-akn")?.observed)
    .toEqual({
      checked_in_tna_captures: tnaFiles.length,
      checked_in_tna_native_captures: tnaModes.filter((value) => value === "native").length,
      checked_in_tna_hybrid_captures: tnaModes.filter((value) => value === "hybrid").length,
      installed_provider_tna_stores: localProviders && existsSync(localProviders) ? 1 : 0,
    });
  expect(coverage.corpora.every(({ documents }) => documents > 0)).toBe(true);
  for (const row of coverage.rows) {
    if (row.status === "frozen") {
      expect(row.provenance, row.id).toBe("real-captured");
      expect(row.capture, row.id).toMatch(/\.json$/u);
    } else if (row.status === "missing") {
      expect(row.capture, row.id).toBeNull();
      expect(row.blocker?.trim(), row.id).toBeTruthy();
    } else {
      expect(row.capture, row.id).toBeNull();
      expect(row.provenance, row.id).toBeNull();
      expect(row.blocker, row.id).toMatch(/not parity-passed/iu);
      expect(coverage.applicability_proofs.some(({ id }) => id === row.id), row.id)
        .toBe(true);
    }
  }
  for (const capture of [localNative, localHybrid, localFlat]) {
    expect(capture.provenance.frozen_binary_sha256).toBe(LEGALPDF_BASELINE_BINARY);
    expect(capture.response.source.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(capture.provenance.source_relative_path)
      .toContain(capture.response.source.sha256.slice(0, 12));
  }
});

test("real captured rows match frozen canonical public bytes", () => {
  const started = performance.now();
  const documents = capturedRows();
  const observed: string[] = [];
  for (const row of coverage.rows.filter(({ status }) => status === "frozen")) {
    const doc = documents.get(row.id);
    expect(doc, row.id).toBeDefined();
    expect(doc!.provider, row.id).toBe(row.provider);
    expect(mode(doc!), row.id).toBe(row.mode);
    const capture = readFileSync(path.join(FIXTURES, row.capture!));
    const captureHash = createHash("sha256").update(capture).digest("hex");
    const bytes = canonicalBytes(doc!);
    const baselineHash = createHash("sha256").update(bytes).digest("hex");
    observed.push(`${row.id}\t${captureHash}\t${baselineHash}\t${bytes.length}`);
    if (process.env.SOURCE_STRUCTURE_PRINT_BASELINES !== "1") {
      expect(captureHash, `${row.id}:capture`).toBe(row.capture_sha256);
      expect(baselineHash, `${row.id}:baseline`).toBe(row.baseline_sha256);
      expect(bytes.length, `${row.id}:bytes`).toBe(row.baseline_bytes);
    }
  }
  const serializerHash = createHash("sha256").update(SERIALIZER_CONTRACT).digest("hex");
  if (process.env.SOURCE_STRUCTURE_PRINT_BASELINES === "1") {
    console.log(`serializer\t${serializerHash}`);
    console.log(observed.join("\n"));
  } else {
    expect(serializerHash).toBe(coverage.serializer_contract_sha256);
  }
  expect(performance.now() - started).toBeLessThan(250);
});

test.runIf(process.env.SOURCE_STRUCTURE_ACCEPTANCE === "1")(
  "acceptance requires a frozen real capture for every applicable row",
  () => expect(coverage.rows.filter(({ status }) => status === "missing")).toEqual([]),
);
