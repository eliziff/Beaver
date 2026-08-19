import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import {
  capHitsPerDoc,
  chunkText,
  clauseChunkText,
  ensurePassageIndex,
  isSqliteLockError,
  passageIndexPath,
  passageQueryPhrases,
  passageQueryTokens,
  rrfFuse,
  searchPassages,
} from "./passageRetrieval";

const dir = mkdtempSync(path.join(os.tmpdir(), "passage-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("chunkText", () => {
  const text = [
    "PREAMBLE. This agreement is made between parties.",
    "1. Confidentiality. The receiving party shall not disclose information. " +
      "The obligation survives termination for five years.",
    "2. Reverse engineering. The receiving party shall not reverse engineer " +
      "any object embodying confidential information.",
  ].join("\n\n");

  it("covers the text with verbatim, monotone, bounded spans", () => {
    const long = Array.from({ length: 40 }, (_, i) => `${text} [${i}]`).join(
      "\n\n",
    );
    const spans = chunkText(long, { target: 800, overlap: 100 });
    expect(spans[0].start).toBe(0);
    expect(spans[spans.length - 1].end).toBe(long.length);
    for (const [index, span] of spans.entries()) {
      expect(span.end).toBeGreaterThan(span.start);
      expect(span.end - span.start).toBeLessThanOrEqual(800);
      if (index > 0) {
        expect(span.start).toBeGreaterThan(spans[index - 1].start);
        // No coverage gap: each chunk starts at or before the last end.
        expect(span.start).toBeLessThanOrEqual(spans[index - 1].end);
      }
    }
  });

  it("prefers paragraph boundaries", () => {
    const doubled = `${text}\n\n${text}`;
    const spans = chunkText(doubled, { target: 300, overlap: 0 });
    const boundaryEnds = spans.filter(
      (span) =>
        span.end === doubled.length ||
        doubled.slice(span.end - 2, span.end) === "\n\n" ||
        doubled[span.end - 1] === "\n",
    );
    expect(boundaryEnds.length).toBeGreaterThanOrEqual(spans.length - 1);
  });

  it("returns one span for short text", () => {
    expect(chunkText("short.", { target: 1000 })).toEqual([
      { start: 0, end: 6 },
    ]);
  });
});

describe("clauseChunkText", () => {
  /** Joined clause lines with their exact start offsets. */
  const assemble = (lines: string[]) => {
    const offsets: number[] = [];
    let at = 0;
    for (const line of lines) {
      offsets.push(at);
      at += line.length + 1;
    }
    return { text: lines.join("\n"), offsets };
  };
  const filler = (n: number) => "covenant obligation party ".repeat(n).trim();

  it("tiles the text with spans starting only at clause boundaries", () => {
    const { text, offsets } = assemble(
      Array.from({ length: 8 }, (_, i) => `${i + 1}. Clause. ${filler(5)}`),
    );
    const spans = clauseChunkText(text, { target: 300 });
    expect(spans.length).toBeGreaterThan(1);
    expect(spans[0].start).toBe(0);
    expect(spans[spans.length - 1].end).toBe(text.length);
    const boundaries = new Set(offsets);
    for (const [index, span] of spans.entries()) {
      expect(span.end).toBeGreaterThan(span.start);
      expect(boundaries.has(span.start)).toBe(true);
      // No overlap and no gap: clause units tile.
      if (index > 0) expect(span.start).toBe(spans[index - 1].end);
    }
  });

  it("packs whole clauses up to target", () => {
    const { text, offsets } = assemble(
      Array.from({ length: 6 }, (_, i) => `${i + 1}. Clause. ${filler(4)}`),
    );
    const spans = clauseChunkText(text, { target: 250 });
    const boundaries = new Set([...offsets, text.length]);
    for (const span of spans) expect(boundaries.has(span.end)).toBe(true);
    for (const span of spans.slice(0, -1))
      expect(span.end - span.start).toBeGreaterThanOrEqual(250);
  });

  it("subdivides a clause longer than twice the target without overlap", () => {
    const { text } = assemble([
      `1. Short. ${filler(3)}`,
      `2. Oversized. ${filler(40)}`,
      `3. Short. ${filler(3)}`,
    ]);
    const spans = clauseChunkText(text, { target: 200 });
    expect(spans[0].start).toBe(0);
    expect(spans[spans.length - 1].end).toBe(text.length);
    for (const [index, span] of spans.entries()) {
      expect(span.end - span.start).toBeLessThanOrEqual(400);
      if (index > 0) expect(span.start).toBe(spans[index - 1].end);
    }
    expect(spans.length).toBeGreaterThan(3);
  });

  it("recognizes section, article, dotted, and enumerated joints", () => {
    const { text, offsets } = assemble([
      `Section 7.2 Indemnity. ${filler(9)}`,
      `ARTICLE IV ${filler(9)}`,
      `7.2.1 Notice periods. ${filler(9)}`,
      `(a) first item. ${filler(9)}`,
      `(iv) roman item. ${filler(9)}`,
    ]);
    const spans = clauseChunkText(text, { target: 200 });
    expect(spans.map((span) => span.start)).toEqual(offsets);
  });

  it("falls back to character chunking when no skeleton is found", () => {
    const prose =
      "This agreement has no numbering at all, merely flowing prose " +
      filler(30);
    expect(clauseChunkText(prose, { target: 300 })).toEqual(
      chunkText(prose, { target: 300 }),
    );
  });

  it("is a distinct index identity from chars mode", () => {
    const sourceDb = path.join(dir, "clause-source.sqlite");
    const db = new DatabaseSync(sourceDb);
    db.exec(
      "CREATE TABLE document (id INTEGER PRIMARY KEY, doc_type TEXT, citation_en TEXT, citation_fr TEXT, name_en TEXT, name_fr TEXT, unofficial_text_en TEXT, unofficial_text_fr TEXT)",
    );
    db.prepare(
      "INSERT INTO document (doc_type, citation_en, name_en, unofficial_text_en) VALUES ('laws', 'x.txt', 'X', ?)",
    ).run(
      Array.from({ length: 6 }, (_, i) => `${i + 1}. Clause. ${filler(8)}`)
        .join("\n"),
    );
    db.close();

    expect(passageIndexPath({ sourceDb, target: 300, mode: "clause" })).not.toBe(
      passageIndexPath({ sourceDb, target: 300, mode: "chars" }),
    );
    const chars = ensurePassageIndex({ sourceDb, target: 300 });
    const clause = ensurePassageIndex({ sourceDb, target: 300, mode: "clause" });
    expect(chars.built).toBe(true);
    expect(clause.built).toBe(true);
    expect(ensurePassageIndex({ sourceDb, target: 300, mode: "clause" }).built)
      .toBe(false);
  });
});

describe("ensurePassageIndex under lock contention", () => {
  const sourceDb = path.join(dir, "lock-source.sqlite");
  const indexDb = path.join(dir, "lock-index.sqlite");
  const options = { sourceDb, indexDb, target: 400, overlap: 50 };

  const build = () => {
    if (!existsSync(sourceDb)) {
      const db = new DatabaseSync(sourceDb);
      db.exec(
        "CREATE TABLE document (id INTEGER PRIMARY KEY, doc_type TEXT, citation_en TEXT, citation_fr TEXT, name_en TEXT, name_fr TEXT, unofficial_text_en TEXT, unofficial_text_fr TEXT)",
      );
      db.prepare(
        "INSERT INTO document (doc_type, citation_en, name_en, unofficial_text_en) VALUES ('laws', 'lock.txt', 'Lock', ?)",
      ).run(
        "1. Definitions. Confidential Information means any disclosed data. " +
          "2. Term. This Agreement remains in force for five years.",
      );
      db.close();
    }
    return ensurePassageIndex(options);
  };

  it("classifies real busy errors as locks and real corruption as not", () => {
    const first = build();
    expect(first.passages).toBeGreaterThan(0);
    const holder = new DatabaseSync(indexDb);
    holder.exec("PRAGMA locking_mode = EXCLUSIVE");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("CREATE TABLE IF NOT EXISTS lock_probe (x INTEGER)");
    let busy: unknown;
    const reader = new DatabaseSync(indexDb, { readOnly: true });
    try {
      reader.prepare("SELECT value FROM meta WHERE key = 'params'").get();
    } catch (error) {
      busy = error;
    } finally {
      reader.close();
    }
    expect((busy as { errcode?: number }).errcode).toBe(5);
    expect(isSqliteLockError(busy)).toBe(true);
    // A schema that is merely foreign (no `meta` table) is corruption,
    // not contention — that is the case that MAY rebuild.
    let foreign: unknown;
    try {
      holder.prepare("SELECT value FROM absent_table").get();
    } catch (error) {
      foreign = error;
    }
    expect(foreign).toBeDefined();
    expect(isSqliteLockError(foreign)).toBe(false);
    holder.exec("ROLLBACK");
    holder.close();
  });

  it("rethrows a transient lock instead of dropping and reindexing", () => {
    const first = build();
    const holder = new DatabaseSync(indexDb);
    holder.exec("PRAGMA locking_mode = EXCLUSIVE");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("CREATE TABLE IF NOT EXISTS lock_probe (x INTEGER)");
    // The source db is pointed at a path that does not exist, so the two
    // behaviours are distinguishable by the error alone: rethrowing the
    // meta-read failure says "database is locked" (errcode 5), while
    // falling through to the rebuild opens the source FIRST and would say
    // "unable to open database file". Under contention both paths throw,
    // so the message is the only witness of which decision was taken.
    let thrown: unknown;
    try {
      ensurePassageIndex({ ...options, sourceDb: path.join(dir, "gone.sqlite") });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { errcode?: number }).errcode).toBe(5);
    expect(String(thrown)).toMatch(/database is locked/iu);
    holder.exec("ROLLBACK");
    holder.close();
    // The sidecar survived: same params, same rows, no rebuild.
    const after = ensurePassageIndex(options);
    expect(after.built).toBe(false);
    expect(after.passages).toBe(first.passages);
    expect(after.documents).toBe(first.documents);
  });

  it("still rebuilds a foreign sidecar", () => {
    const first = build();
    // A readable sqlite file that is not one of our indexes: the meta
    // probe fails for a reason that is NOT contention, so the rebuild is
    // the right answer and must still happen.
    rmSync(indexDb, { force: true });
    const foreign = new DatabaseSync(indexDb);
    foreign.exec("CREATE TABLE something_else (x INTEGER)");
    foreign.close();
    const rebuilt = ensurePassageIndex(options);
    expect(rebuilt.built).toBe(true);
    expect(rebuilt.passages).toBe(first.passages);
  });
});

describe("isSqliteLockError", () => {
  it("accepts extended BUSY/LOCKED codes and rejects other failures", () => {
    // Extended result codes share the primary code in their low byte.
    for (const errcode of [5, 6, 261, 517, 773])
      expect(isSqliteLockError({ errcode })).toBe(true);
    // SQLITE_CORRUPT(11), SQLITE_NOTADB(26), SQLITE_CANTOPEN(14), SQLITE_ERROR(1)
    for (const errcode of [1, 11, 14, 26])
      expect(isSqliteLockError({ errcode })).toBe(false);
    // Message fallback for an error that lost the numeric field.
    expect(isSqliteLockError(new Error("database is locked"))).toBe(true);
    expect(isSqliteLockError(new Error("database table is locked"))).toBe(true);
    expect(isSqliteLockError(new Error("file is not a database"))).toBe(false);
    expect(isSqliteLockError(null)).toBe(false);
    expect(isSqliteLockError("database is locked")).toBe(false);
  });
});

describe("passageQueryTokens", () => {
  it("keeps question terms past position 12 and drops stopwords", () => {
    const tokens = passageQueryTokens(
      "Consider the Mutual Non-Disclosure Agreement between Bosch and the " +
        "other party; is the receiving party allowed to reverse engineer " +
        "objects embodying confidential information?",
    );
    expect(tokens).toContain("reverse");
    expect(tokens).toContain("engineer");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("is");
  });
});

describe("passageQueryPhrases", () => {
  it("pairs only words adjacent in the original query", () => {
    const phrases = passageQueryPhrases(
      "Is the receiving party allowed to reverse engineer the object?",
    );
    expect(phrases).toContain("receiving party");
    expect(phrases).toContain("reverse engineer");
    // "allowed" and "reverse" are separated by "to" in the query;
    // pairing the stopword-filtered stream would fabricate this phrase.
    expect(phrases).not.toContain("allowed reverse");
  });

  it("excludes stopword-touching pairs and dedupes", () => {
    const phrases = passageQueryPhrases(
      "change of control and change of control provisions",
    );
    expect(phrases).not.toContain("change of");
    expect(phrases).not.toContain("of control");
    expect(phrases.filter((p) => p === "control provisions")).toHaveLength(1);
  });
});

describe("capHitsPerDoc", () => {
  const pool = [
    { citation: "maud/agreement.txt", rank: 0 },
    { citation: "maud/agreement.txt", rank: 1 },
    { citation: "cuad/services.txt", rank: 2 },
    { citation: "maud/agreement.txt", rank: 3 },
    { citation: "cuad/services.txt", rank: 4 },
    { citation: "contractnli/nda.txt", rank: 5 },
  ];

  it("keeps rank order and drops only over-cap passages", () => {
    expect(capHitsPerDoc(pool, 2, 10).map((hit) => hit.rank)).toEqual([
      0, 1, 2, 4, 5,
    ]);
    expect(capHitsPerDoc(pool, 1, 10).map((hit) => hit.rank)).toEqual([0, 2, 5]);
  });

  it("truncates to k after capping, never before", () => {
    // Rank 3 is the third maud passage: at cap 2 it is skipped, so a k of 3
    // reaches into the other documents instead of stopping at rank 2.
    expect(capHitsPerDoc(pool, 2, 3).map((hit) => hit.rank)).toEqual([0, 1, 2]);
    expect(capHitsPerDoc(pool, 1, 2).map((hit) => hit.rank)).toEqual([0, 2]);
  });

  it("is inert when the cap cannot bind", () => {
    expect(capHitsPerDoc(pool, 24, 48)).toEqual(pool);
    expect(capHitsPerDoc(pool, 24, 4)).toEqual(pool.slice(0, 4));
    expect(capHitsPerDoc(pool, 0, 10)).toEqual(capHitsPerDoc(pool, 1, 10));
  });

});

describe("rrfFuse", () => {
  it("ranks items on both lists above single-list items", () => {
    const fused = rrfFuse([
      [
        { id: "a", item: "a" },
        { id: "b", item: "b" },
      ],
      [
        { id: "b", item: "b" },
        { id: "c", item: "c" },
      ],
    ]);
    expect(fused[0].id).toBe("b");
  });
});

describe("index + search round trip", () => {
  const sourceDb = path.join(dir, "source.sqlite");
  const contract =
    "MUTUAL NON-DISCLOSURE AGREEMENT\n\n" +
    "1. Definitions. Confidential Information means any data disclosed.\n\n" +
    "2. Obligations. The Receiving Party shall hold information in confidence.\n\n" +
    "3. Reverse Engineering. The Receiving Party shall not reverse engineer, " +
    "disassemble or decompile any prototypes, software or other objects which " +
    "embody the Disclosing Party's Confidential Information.\n\n" +
    "4. Term. This Agreement remains in force for five years.";
  const other =
    "SERVICES AGREEMENT\n\nThe provider shall deliver maintenance services. " +
    "Payment is due within thirty days of invoice.";

  it("builds once, reuses, and returns exact verbatim offsets", () => {
    const db = new DatabaseSync(sourceDb);
    db.exec(
      "CREATE TABLE document (id INTEGER PRIMARY KEY, doc_type TEXT, citation_en TEXT, citation_fr TEXT, name_en TEXT, name_fr TEXT, unofficial_text_en TEXT, unofficial_text_fr TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO document (doc_type, citation_en, name_en, unofficial_text_en) VALUES ('laws', ?, ?, ?)",
    );
    insert.run("contractnli/bosch-nda.txt", "Bosch NDA", contract);
    insert.run("cuad/services.txt", "Acme Services Agreement", other);
    db.close();

    const first = ensurePassageIndex({ sourceDb, target: 400, overlap: 50 });
    expect(first.built).toBe(true);
    expect(first.documents).toBe(2);
    const second = ensurePassageIndex({ sourceDb, target: 400, overlap: 50 });
    expect(second.built).toBe(false);

    const hits = searchPassages({
      sourceDb,
      target: 400,
      overlap: 50,
      query:
        "Consider the Bosch NDA; may the receiving party reverse engineer objects?",
      k: 4,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].citation).toBe("contractnli/bosch-nda.txt");
    expect(hits[0].text).toBe(contract.slice(hits[0].start, hits[0].end));
    expect(
      hits.some((hit) => hit.text.includes("reverse engineer")),
    ).toBe(true);
  });

  it("phrase terms are additive: phrase-bearing passage ranks first", () => {
    const hits = searchPassages({
      sourceDb,
      target: 400,
      overlap: 50,
      query: "may the receiving party reverse engineer objects",
      k: 4,
      phrases: true,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain("reverse engineer");
    expect(hits[0].text).toBe(
      contract.slice(hits[0].start, hits[0].end),
    );
  });

  it("name weighting pulls the named document above lexical noise", () => {
    const hits = searchPassages({
      sourceDb,
      target: 400,
      overlap: 50,
      query: "Acme services payment terms",
      k: 2,
      nameWeight: 8,
    });
    expect(hits[0]?.citation).toBe("cuad/services.txt");
  });

  it("capHitsPerDoc reproduces the cap searchPassages applies internally", () => {
    const query = "confidential information receiving party agreement";
    const search = (perDocCap: number) =>
      searchPassages({ sourceDb, target: 400, overlap: 50, query, k: 4, perDocCap });
    expect(search(1).map((hit) => [hit.citation, hit.start])).toEqual(
      capHitsPerDoc(search(4), 1, 4).map((hit) => [hit.citation, hit.start]),
    );
  });

  it("contextJsonl headers key a distinct sidecar and add searchable words", () => {
    const plainPath = passageIndexPath({ sourceDb, target: 400, overlap: 50 });
    const plain = new DatabaseSync(plainPath, { readOnly: true });
    const span = plain
      .prepare(
        "SELECT doc_id, language, start, end FROM passage WHERE doc_id = 2 ORDER BY id LIMIT 1",
      )
      .get() as { doc_id: number; language: string; start: number; end: number };
    plain.close();
    const contextJsonl = path.join(dir, "headers.jsonl");
    writeFileSync(
      contextJsonl,
      `${JSON.stringify({
        ...span,
        header:
          "Chunk of the Acme maintenance contract covering invoicing cadence.",
      })}\n`,
      "utf8",
    );
    const enrichedPath = passageIndexPath({
      sourceDb,
      target: 400,
      overlap: 50,
      contextJsonl,
    });
    expect(enrichedPath).not.toBe(plainPath);
    // "invoicing cadence" appears in no passage text — only the header.
    const hits = searchPassages({
      sourceDb,
      target: 400,
      overlap: 50,
      query: "invoicing cadence",
      k: 2,
      contextWeight: 2,
      contextJsonl,
    });
    expect(hits[0]?.citation).toBe("cuad/services.txt");
    expect(hits[0]?.start).toBe(span.start);
    // Returned text is still the verbatim source slice, header-free.
    expect(hits[0]?.text).toBe(other.slice(span.start, span.end));
  });
});
