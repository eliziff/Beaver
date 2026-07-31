import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import {
  chunkText,
  clauseChunkText,
  ensurePassageIndex,
  passageIndexPath,
  passageQueryPhrases,
  passageQueryTokens,
  rrfFuse,
  searchPassages,
} from "../passageRetrieval";

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
});
