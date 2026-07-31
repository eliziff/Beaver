import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import {
  chunkText,
  ensurePassageIndex,
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
