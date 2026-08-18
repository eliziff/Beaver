import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Tripwire, not a fake ranker: these tests must never reach a model, so
// completeText fails loudly and the call count is the assertion.
const { completeText } = vi.hoisted(() => ({
  completeText: vi.fn(async () => {
    throw new Error("reranker model call must not happen in tests");
  }),
}));
vi.mock("../llm", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  completeText,
}));

import {
  A2AJ_PASSAGE_OVERLAP,
  A2AJ_PASSAGE_TARGET,
  MissingPassageIndexError,
  searchLocalA2AJPassages,
} from "../a2ajPassageSearch";
import { searchLegalSources } from "../legalSourceRegistry";
import { citationLookupKey } from "../citationKey";
import {
  chunkText,
  clauseChunkText,
  ensurePassageIndex,
} from "../passageRetrieval";

const dir = mkdtempSync(path.join(os.tmpdir(), "a2aj-passage-wiring-"));
const clauseDb = path.join(dir, "clause.sqlite");
const charsDb = path.join(dir, "chars.sqlite");
const unindexedDb = path.join(dir, "unindexed.sqlite");
const citatorDb = path.join(dir, "noteup.sqlite");
const noCitatorDb = path.join(dir, "no-such-citator.sqlite");

const clause = (n: number, topic: string) =>
  `${n}. ${topic}. ` +
  "The party shall comply with the requirements of this section. ".repeat(12);
const statute = [
  "INTERPRETATION ACT",
  clause(1, "Definitions"),
  clause(2, "Application"),
  "3. Reverse engineering. No person shall reverse engineer any prototype " +
    "embodying confidential information. " +
    "The prohibition survives termination of the agreement. ".repeat(10),
  clause(4, "Coming into force"),
].join("\n\n");
const other =
  "SERVICES ACT\n\n" +
  "The provider shall deliver maintenance services on request. ".repeat(40);

function seed(file: string) {
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE document (id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, dataset TEXT NOT NULL, citation_en TEXT, citation_fr TEXT, citation2_en TEXT, citation2_fr TEXT, name_en TEXT, name_fr TEXT, document_date_en TEXT, document_date_fr TEXT, url_en TEXT, url_fr TEXT, unofficial_text_en TEXT, unofficial_text_fr TEXT)",
  );
  db.exec(
    "CREATE TABLE citation_lookup (citation_key TEXT NOT NULL, document_id INTEGER NOT NULL, PRIMARY KEY (citation_key, document_id)) WITHOUT ROWID",
  );
  const insert = db.prepare(
    "INSERT INTO document (id, doc_type, dataset, citation_en, name_en, document_date_en, url_en, unofficial_text_en) VALUES (?, 'cases', ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    1,
    "SCC",
    "2024 SCC 11",
    "Interpretation Act",
    "2024-03-01",
    "https://example.test/en/statute",
    statute,
  );
  insert.run(
    2,
    "ONCA",
    "2023 ONCA 12",
    "Services Act",
    "2023-06-01",
    "https://example.test/en/services",
    other,
  );
  const lookup = db.prepare(
    "INSERT INTO citation_lookup (citation_key, document_id) VALUES (?, ?)",
  );
  lookup.run(citationLookupKey("2024 SCC 11"), 1);
  lookup.run(citationLookupKey("2023 ONCA 12"), 2);
  db.close();
}

/** Citator resolution evidence: the English and French keys of one
 * decision map to the same corpus row, which is what licenses the alias
 * expansion in the passage lane's citation short-circuit. */
function seedCitator(file: string) {
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE resolution (cited_key TEXT NOT NULL, path TEXT NOT NULL, file_row_number INTEGER NOT NULL)",
  );
  const insert = db.prepare(
    "INSERT INTO resolution (cited_key, path, file_row_number) VALUES (?, 'cases.csv', 7)",
  );
  insert.run(citationLookupKey("2024 SCC 11"));
  insert.run(citationLookupKey("2024 CSC 11"));
  db.close();
}

const chunking = {
  target: A2AJ_PASSAGE_TARGET,
  overlap: A2AJ_PASSAGE_OVERLAP,
};

beforeAll(() => {
  for (const file of [clauseDb, charsDb, unindexedDb]) seed(file);
  seedCitator(citatorDb);
  ensurePassageIndex({ sourceDb: clauseDb, ...chunking, mode: "clause" });
  ensurePassageIndex({ sourceDb: charsDb, ...chunking });
  // The chat tool always scopes by doc_type, and doc_type is part of the
  // sidecar identity, so the lane needs its own build.
  ensurePassageIndex({ sourceDb: charsDb, ...chunking, docType: "cases" });
});

afterEach(() => {
  completeText.mockClear();
  delete process.env.MIKE_PASSAGE_SEARCH;
  delete process.env.MIKE_RETRIEVAL_RERANK_MODEL;
  // Never let a test fall through to a real citator graph on this box.
  process.env.MIKE_CITATOR_DB = noCitatorDb;
});

// Set before the first test too, not only between tests.
process.env.MIKE_CITATOR_DB = noCitatorDb;

afterAll(() => {
  delete process.env.MIKE_A2AJ_BULK_DB;
  delete process.env.MIKE_CITATOR_DB;
  rmSync(dir, { recursive: true, force: true });
});

describe("clause-mode sidecar round trip", () => {
  it("returns verbatim clause-aligned spans", async () => {
    process.env.MIKE_A2AJ_BULK_DB = clauseDb;
    const hits = await searchLocalA2AJPassages({
      query: "reverse engineer a prototype",
      mode: "clause",
      size: 4,
    });
    expect(hits.length).toBeGreaterThan(0);
    const clauseSpans = clauseChunkText(statute, chunking);
    const charSpans = chunkText(statute, chunking);
    // Premise: the two chunkers disagree here, so span identity is proof
    // that `mode` reached the sidecar and the query read the same one.
    expect(clauseSpans).not.toEqual(charSpans);
    for (const hit of hits.filter((hit) => hit.docId === 1)) {
      expect(hit.passage.text).toBe(
        statute.slice(hit.passage.start, hit.passage.end),
      );
      expect(clauseSpans).toContainEqual({
        start: hit.passage.start,
        end: hit.passage.end,
      });
    }
    expect(
      hits.some((hit) => hit.passage.text.includes("reverse engineer")),
    ).toBe(true);
  });

  it("names --mode in the refusal when the mode's sidecar is missing", async () => {
    process.env.MIKE_A2AJ_BULK_DB = charsDb;
    const error = await searchLocalA2AJPassages({
      query: "reverse engineer a prototype",
      mode: "clause",
    }).catch((reason: unknown) => reason as MissingPassageIndexError);
    expect(error).toBeInstanceOf(MissingPassageIndexError);
    expect(error.command).toContain("--mode clause");
  });
});

describe("rerank wiring", () => {
  it("short-circuits without a model call when the pool already fits", async () => {
    process.env.MIKE_A2AJ_BULK_DB = charsDb;
    const hits = await searchLocalA2AJPassages({
      query: "maintenance services on request",
      size: 50,
      rerank: { model: "tripwire" },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(completeText).not.toHaveBeenCalled();
  });

  it("attempts no rerank when neither the argument nor the env is set", async () => {
    process.env.MIKE_A2AJ_BULK_DB = charsDb;
    const hits = await searchLocalA2AJPassages({
      query: "maintenance services on request",
      size: 2,
    });
    // Unreranked pools are exactly `size`; the rerank path widens to >= 48.
    expect(hits).toHaveLength(2);
    expect(completeText).not.toHaveBeenCalled();
  });
});

describe("citation short-circuit alias expansion", () => {
  // Lexically doc 2 owns "maintenance services"; only the citation
  // short-circuit can put doc 1 first.
  const query = "maintenance services under 2024 CSC 11";

  it("pins the decision cited under its French twin", async () => {
    process.env.MIKE_A2AJ_BULK_DB = charsDb;
    process.env.MIKE_CITATOR_DB = citatorDb;
    const hits = await searchLocalA2AJPassages({ query, size: 4 });
    expect(hits[0].citation).toBe("2024 SCC 11");
    expect(hits[0].passage.text).toBe(
      statute.slice(hits[0].passage.start, hits[0].passage.end),
    );
  });

  it("keeps literal-key resolution when no citator graph is installed", async () => {
    process.env.MIKE_A2AJ_BULK_DB = charsDb;
    const literal = await searchLocalA2AJPassages({
      query: "maintenance services under 2024 SCC 11",
      size: 4,
    });
    expect(literal[0].citation).toBe("2024 SCC 11");
    // Without resolution evidence the twin is a different key, so the
    // alias-only query falls back to the lexical winner.
    const twin = await searchLocalA2AJPassages({ query, size: 4 });
    expect(twin[0].citation).toBe("2023 ONCA 12");
  });
});

describe("A2AJ legal-source adapter passage lane", () => {
  it("serves passages when the sidecar exists", async () => {
    process.env.MIKE_A2AJ_BULK_DB = charsDb;
    process.env.MIKE_PASSAGE_SEARCH = "1";
    const execution = await searchLegalSources({
      text: "reverse engineer a prototype",
      kinds: ["case"],
      providers: ["a2aj"],
      limit: 4,
    });
    const results = execution.results;
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0].passageStart).toBe("number");
    expect(results[0].snippet).toBe(
      statute.slice(
        results[0].passageStart as number,
        results[0].passageEnd as number,
      ),
    );
  });

});
