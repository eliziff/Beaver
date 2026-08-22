import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crossReferenceGraphFromSourceDoc } from "../legalCrossReference";
import { buildLegalSourcePinpointUrl } from "../legalSourceLinks";
import {
  createSourceDoc,
  lookupSourceDoc,
  sliceSourceDocBlocks,
  sourceDocBlockText,
  sourceDocContainsQuote,
  tokenizeSourceText,
  type SourceDoc,
} from "../sourceDoc";
import { deriveA2AJSourceDoc } from "../sourceDocStructureHost";

/**
 * The cross-provider fixture matrix (master plan P1.1a stage 1): the P1.1
 * acceptance test that never existed.
 *
 * Every fixture in `fixtures/sourcedoc` is a trimmed excerpt of a REAL A2AJ
 * payload captured once from the keyless api.a2aj.ca on 2026-07-27; each file
 * records the endpoint, parameters, full-document size and the character range
 * it was cut from. Nothing here touches the network.
 *
 * `baseline-spine.json` is the frozen output of the engine SourceDoc replaced
 * (a2ajStructure.ts, deleted in P1.1a stage 3), machine-captured from it
 * before it was removed. Parity is asserted against that recording, so the
 * gate outlives the code it was taken from. Do not regenerate it.
 */

type Fixture = {
  provider: "a2aj";
  docType: "cases" | "laws";
  dataset: string;
  citation: string;
  alternateCitation: string | null;
  name: string | null;
  date: string | null;
  url: string | null;
  shape: string;
  capture: Record<string, unknown>;
  text: string;
  sectionMap?: Record<string, string>;
};

const FIXTURE_DIR = path.join(__dirname, "fixtures", "sourcedoc");

function fixture(file: string): Fixture {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, `${file}.json`), "utf8"),
  ) as Fixture;
}

function compile(source: Fixture): Promise<SourceDoc> {
  return deriveA2AJSourceDoc({
    citation: source.citation,
    docType: source.docType,
    text: source.text,
    url: source.url,
    dataset: source.dataset,
    name: source.name,
    alternateCitation: source.alternateCitation,
    sectionMap: source.sectionMap ?? null,
  });
}

function labels(doc: SourceDoc) {
  return doc.blocks.map((block) => block.label);
}

type BaselineSpine = {
  status: "usable" | "unavailable";
  source: string;
  counts: { paragraph: number; page: number; section: number };
  sameText: boolean;
  textSha256: string;
  blocks: Array<[string, string, number, number]>;
  lookups: Array<{
    locator: string;
    status: string;
    requestedLabel: string;
    matches: string[];
    block: string | null;
    before: string[];
    after: string[];
  }>;
};

const BASELINE = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, "baseline-spine.json"), "utf8"),
) as Record<string, BaselineSpine>;

/**
 * Shapes whose spine the compiler must reproduce exactly. Statute shapes the
 * flat-text spine never matched and the two case fixtures corrected to match
 * the faithful ALR compatibility behavior are excluded on purpose.
 */
const PARITY_FIXTURES = [
  "a2aj-case-scc-2001scc1-bare",
  "a2aj-case-scc-1990scr30-unnumbered",
  "a2aj-laws-on-occupiers-liability",
  "a2aj-regs-on-oreg267-03",
] as const;

const MATRIX: Array<{
  file: string;
  docType: "cases" | "laws";
  compiledSections: number;
  compiledParagraphs: number;
}> = [
  {
    file: "a2aj-case-scc-2026scc16-toc",
    docType: "cases",
    compiledSections: 0,
    compiledParagraphs: 35,
  },
  {
    file: "a2aj-case-scc-2001scc1-bare",
    docType: "cases",
    compiledSections: 0,
    compiledParagraphs: 25,
  },
  {
    file: "a2aj-case-scc-1990scr30-unnumbered",
    docType: "cases",
    compiledSections: 0,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-case-scc-1986scr103-dot",
    docType: "cases",
    compiledSections: 0,
    compiledParagraphs: 27,
  },
  // These four carried hand-cut excerpts that opened mid-decision (paras
  // 40-48 and the like), so they only ever exercised a spine starting far
  // above 1. They now hold the full A2AJ records, and the expected counts are
  // the corpus's own rooted ladder read straight off the text.
  {
    file: "a2aj-case-scc-2021scc31-bracket",
    docType: "cases",
    compiledSections: 0,
    compiledParagraphs: 64,
  },
  {
    file: "a2aj-case-scc-2014scc71-bracket",
    docType: "cases",
    compiledSections: 0,
    compiledParagraphs: 112,
  },
  {
    file: "a2aj-case-scc-2020scc45-bracket",
    docType: "cases",
    compiledSections: 0,
    compiledParagraphs: 238,
  },
  {
    file: "a2aj-case-scc-2014scc53-bracket",
    docType: "cases",
    compiledSections: 0,
    compiledParagraphs: 125,
  },
  {
    file: "a2aj-laws-fed-criminalcode-s231",
    docType: "laws",
    compiledSections: 22,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-fed-criminalcode-s22-1",
    docType: "laws",
    compiledSections: 13,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-fed-criminalcode-s83-01",
    docType: "laws",
    compiledSections: 26,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-fed-criminalcode-sectionmap",
    docType: "laws",
    compiledSections: 53,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-on-occupiers-liability",
    docType: "laws",
    compiledSections: 66,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-on-limitations-2002",
    docType: "laws",
    compiledSections: 35,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-on-real-property-limitations",
    docType: "laws",
    compiledSections: 6,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-bc-limitation-2012",
    docType: "laws",
    compiledSections: 57,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-regs-fed-crc870-a01",
    docType: "laws",
    compiledSections: 4,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-regs-on-oreg267-03",
    docType: "laws",
    compiledSections: 64,
    compiledParagraphs: 0,
  },
];

describe("SourceDoc cross-provider fixture matrix", () => {
  it.each(MATRIX)(
    "$file indexes $compiledSections sections and $compiledParagraphs paragraphs",
    async (entry) => {
      const source = fixture(entry.file);
      const doc = await compile(source);
      expect(doc.ranges.section.count).toBe(entry.compiledSections);
      expect(doc.ranges.paragraph.count).toBe(entry.compiledParagraphs);
      expect(doc.status).toBe(
        entry.compiledSections + entry.compiledParagraphs
          ? "usable"
          : "unavailable",
      );
      expect(doc.revision).toMatch(/^[0-9a-f]{64}$/u);
      expect(doc.provider).toBe("a2aj");
    },
  );

  it("marks every A2AJ block heuristic except a provider section spine", async () => {
    for (const entry of MATRIX) {
      const doc = await compile(fixture(entry.file));
      const origins = new Set(doc.blocks.map((block) => block.origin));
      if (entry.file === "a2aj-laws-fed-criminalcode-sectionmap") {
        // The section map is provider-supplied granularity; the nesting
        // inside each section is still read out of prose.
        expect([...origins].sort()).toEqual(["heuristic", "native"]);
        expect(
          doc.blocks
            .filter((block) => block.origin === "native")
            .map((block) => block.label),
        ).toEqual(["sec22.1", "sec83.01", "sec231"]);
      } else {
        expect([...origins]).not.toContain("native");
      }
    }
  });
});

describe("federal statute corpus", () => {
  const source = fixture("a2aj-laws-fed-criminalcode-s231");

  it("the compiler resolves the section, its subsections and its paragraphs", async () => {
    const doc = await compile(source);
    expect(labels(doc)).toEqual([
      "sec231",
      "sec231(1)",
      "sec231(2)",
      "sec231(3)",
      "sec231(4)",
      "sec231(4)(a)",
      "sec231(4)(b)",
      "sec231(4)(c)",
      "sec231(5)",
      "sec231(5)(a)",
      "sec231(5)(b)",
      "sec231(5)(c)",
      "sec231(5)(d)",
      "sec231(5)(e)",
      "sec231(5)(f)",
      "sec231(6)",
      "sec231(6.01)",
      "sec231(6.1)",
      "sec231(6.1)(a)",
      "sec231(6.1)(b)",
      "sec231(6.2)",
      "sec231(7)",
    ]);
    expect(lookupSourceDoc(doc, "section", "s. 231").block?.text).toContain(
      "Murder is first degree murder or second degree murder",
    );
    expect(lookupSourceDoc(doc, "section", "231(2)").block?.text).toContain(
      "(2) Murder is first degree murder when it is planned and deliberate.",
    );
    expect(
      lookupSourceDoc(doc, "section", "231(4)(a)").block?.text,
    ).toContain("a police officer, police constable, constable, sheriff");
    expect(lookupSourceDoc(doc, "section", "231(9)").status).toBe("not_found");
  });

  it("separates the decimal subsections (6.01) and (6.1)", async () => {
    const doc = await compile(source);
    expect(
      lookupSourceDoc(doc, "section", "231(6.01)").block?.text,
    ).toContain("also constitutes a terrorist activity");
    expect(lookupSourceDoc(doc, "section", "231(6.1)").block?.text).toContain(
      "murder is first degree murder when",
    );
    expect(
      lookupSourceDoc(doc, "section", "231(6.1)(a)").block?.text,
    ).toContain("in association with a criminal organization");
    // The two are ordered as decimal fractions, not as Number("01") ===
    // Number("1"), and (6.1) keeps its own paragraphs.
    expect(
      lookupSourceDoc(doc, "section", "231(6.1)(b)").block?.text,
    ).toContain("while committing or attempting to commit an indictable");
  });

  it("indexes decimal sections and Roman subparagraphs", async () => {
    const doc = await compile(fixture("a2aj-laws-fed-criminalcode-s22-1"));
    expect(labels(doc)).toContain("sec22.1");
    expect(labels(doc)).toContain("sec22.2");
    expect(
      lookupSourceDoc(doc, "section", "22.1(a)(ii)").block?.text,
    ).toContain("two or more of its representatives engage in conduct");
    // s. 22 must not swallow s. 22.1.
    expect(lookupSourceDoc(doc, "section", "22").block?.text).not.toContain(
      "senior officer who is responsible",
    );
  });

  it("keeps uppercase clause letters out of the Roman run", async () => {
    const doc = await compile(fixture("a2aj-laws-fed-criminalcode-s83-01"));
    expect(
      labels(doc).filter((label) => label.startsWith("sec83.01(1)(b)(ii)")),
    ).toEqual([
      "sec83.01(1)(b)(ii)",
      "sec83.01(1)(b)(ii)(A)",
      "sec83.01(1)(b)(ii)(B)",
      "sec83.01(1)(b)(ii)(C)",
      "sec83.01(1)(b)(ii)(D)",
      "sec83.01(1)(b)(ii)(E)",
    ]);
    expect(
      lookupSourceDoc(doc, "section", "83.01(1)(a)(x)").block?.text,
    ).toContain("subsection 7(3.73)");
  });

  it("indexes alphanumeric federal regulation sections", async () => {
    const doc = await compile(fixture("a2aj-regs-fed-crc870-a01"));
    expect(labels(doc)).toEqual([
      "secA.01.001",
      "secA.01.002",
      "secA.01.003",
      "secA.01.010",
    ]);
    expect(
      lookupSourceDoc(doc, "section", "A.01.001").block?.text,
    ).toContain("cited as the Food and Drug Regulations");
    expect(doc.ranges.section.first).toBe("secA.01.001");
    expect(doc.ranges.section.last).toBe("secA.01.010");
    expect(doc.ranges.section.missing).toEqual([]);
  });
});

describe("parity with the engine SourceDoc replaced", () => {
  it.each(PARITY_FIXTURES)("%s keeps the old spine byte-identical", async (file) => {
    const source = fixture(file);
    const old = BASELINE[file];
    const doc = await compile(source);
    expect(createHash("sha256").update(doc.text).digest("hex")).toBe(
      old.textSha256,
    );
    expect(
      doc.blocks.map((block) => [
        block.kind,
        block.label,
        block.start,
        block.end,
      ]),
    ).toEqual(old.blocks);
    const kind = source.docType === "laws" ? "section" : "paragraph";
    for (const before of old.lookups) {
      const after = lookupSourceDoc(doc, kind, before.locator, 2);
      expect(after.status).toBe(before.status);
      expect(after.requestedLabel).toBe(before.requestedLabel);
      expect(after.matches).toEqual(before.matches);
      expect(after.block?.label ?? null).toBe(before.block);
      expect(after.before.map((item) => item.label)).toEqual(before.before);
      expect(after.after.map((item) => item.label)).toEqual(before.after);
    }
  });

  it("indexes the federal statute corpus the old engine could not read", async () => {
    for (const file of [
      "a2aj-laws-fed-criminalcode-s231",
      "a2aj-laws-fed-criminalcode-s22-1",
      "a2aj-laws-fed-criminalcode-s83-01",
      "a2aj-regs-fed-crc870-a01",
    ]) {
      expect(BASELINE[file].status).toBe("unavailable");
      expect(BASELINE[file].blocks).toEqual([]);
      expect((await compile(fixture(file))).status).toBe("usable");
    }
  });

  it("fixes the labels the old section-map engine mislabelled", async () => {
    const oldLabels = BASELINE[
      "a2aj-laws-fed-criminalcode-sectionmap"
    ].blocks.map(([, label]) => label);
    // Once (6.1) was dropped because Number("01") === Number("1"), so its
    // paragraphs were re-parented onto (6.01) ...
    expect(oldLabels).toContain("sec231(6.01)(a)");
    expect(oldLabels).not.toContain("sec231(6.1)");
    // ... and (C)/(D)/(E) were read as Roman numerals, losing (ii).
    expect(oldLabels).toContain("sec83.01(1)(b)(D)(E)");
  });
});

describe("provider section map and Markdown emphasis agree", () => {
  it("produces the same labels from both inputs", async () => {
    const mapped = await compile(fixture("a2aj-laws-fed-criminalcode-sectionmap"));
    for (const [file, section] of [
      ["a2aj-laws-fed-criminalcode-s231", "sec231"],
      ["a2aj-laws-fed-criminalcode-s22-1", "sec22.1"],
      ["a2aj-laws-fed-criminalcode-s83-01", "sec83.01"],
    ] as const) {
      const emphasis = await compile(fixture(file));
      const fromMap = labels(mapped).filter(
        (label) => label === section || label.startsWith(`${section}(`),
      );
      const fromMarkdown = labels(emphasis).filter(
        (label) => label === section || label.startsWith(`${section}(`),
      );
      expect(fromMarkdown).toEqual(fromMap);
    }
  });

  it("keeps decimal and Roman children on their correct parents", async () => {
    const doc = await compile(fixture("a2aj-laws-fed-criminalcode-sectionmap"));
    expect(labels(doc)).toContain("sec231(6.1)(a)");
    expect(labels(doc)).not.toContain("sec231(6.01)(a)");
    expect(labels(doc)).toContain("sec83.01(1)(b)(ii)(E)");
    expect(labels(doc)).not.toContain("sec83.01(1)(b)(D)(E)");
  });
});

describe("case spine corrections", () => {
  it("keeps the complete ladder when a table of contents repeats its numbers", async () => {
    const doc = await compile(fixture("a2aj-case-scc-2026scc16-toc"));
    expect(labels(doc)).toEqual(
      Array.from({ length: 35 }, (_, index) => `par${index + 1}`),
    );
    expect(doc.ranges.paragraph.missing).toEqual([]);
  });

  it("anchors a dot-numbered decision on its reasons, not quoted legislation", async () => {
    const doc = await compile(fixture("a2aj-case-scc-1986scr103-dot"));
    expect(lookupSourceDoc(doc, "paragraph", "1").block?.text).toContain(
      "This appeal concerns the constitutionality",
    );
    expect(lookupSourceDoc(doc, "paragraph", "2").block?.text).toContain(
      "Before reviewing the factual context",
    );
    expect(lookupSourceDoc(doc, "paragraph", "3").block?.text).toContain(
      "The respondent, David Edwin Oakes",
    );
    expect(lookupSourceDoc(doc, "paragraph", "4").block?.text).toContain(
      "Following this finding, Mr. Oakes brought a motion",
    );
  });

  it("abstains on a pre-1995 decision with no paragraph numbers", async () => {
    const doc = await compile(fixture("a2aj-case-scc-1990scr30-unnumbered"));
    expect(doc.blocks).toEqual([]);
    expect(doc.status).toBe("unavailable");
    expect(lookupSourceDoc(doc, "paragraph", "12").status).toBe("unavailable");
    expect(doc.ranges.paragraph).toMatchObject({
      count: 0,
      first: null,
      last: null,
      missing: [],
    });
  });
});

describe("locator ranges replace bare counts", () => {
  it("advertises first, last and the gaps in between", async () => {
    const doc = await compile(fixture("a2aj-laws-on-occupiers-liability"));
    expect(doc.ranges.section).toMatchObject({
      kind: "section",
      count: 66,
      first: "sec1",
      last: "sec11",
      missing: [],
      missingTruncated: false,
    });
    expect(doc.ranges.paragraph.count).toBe(0);
    const regulation = await compile(fixture("a2aj-regs-on-oreg267-03"));
    expect(regulation.ranges.section.first).toBe("sec2");
    expect(regulation.ranges.section.last).toBe("sec14");
  });

  it("caps the reported gap list instead of listing thousands", async () => {
    const blocks = [0, 500].map((value) => ({
      kind: "paragraph" as const,
      label: `par${value + 1}`,
      start: value,
      end: value + 1,
      origin: "heuristic" as const,
    }));
    const doc = createSourceDoc({
      provider: "a2aj",
      id: "synthetic",
      text: "x".repeat(600),
      blocks,
    });
    expect(doc.ranges.paragraph.missing).toHaveLength(64);
    expect(doc.ranges.paragraph.missingTruncated).toBe(true);
    expect(doc.ranges.paragraph.first).toBe("par1");
    expect(doc.ranges.paragraph.last).toBe("par501");
  });
});

describe("queries over the compiled document", () => {
  const source = fixture("a2aj-laws-on-occupiers-liability");

  it("tokenizes exactly like the pinpoint link builder", async () => {
    const doc = await compile(source);
    const expected = [...doc.text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map(
      (match) => ({
        word: match[0].toLowerCase(),
        start: match.index,
        end: match.index + match[0].length,
      }),
    );
    expect(doc.tokens).toEqual(expected);
    expect(doc.tokens).toBe(doc.tokens);
    expect(tokenizeSourceText("Don’t stop, s. 4(1)")).toEqual([
      { word: "don’t", start: 0, end: 5 },
      { word: "stop", start: 6, end: 10 },
      { word: "s", start: 12, end: 13 },
      { word: "4", start: 15, end: 16 },
      { word: "1", start: 17, end: 18 },
    ]);
  });

  it("verifies a quote against the whole document and one block", async () => {
    const doc = await compile(source);
    const quote =
      "owes a duty to take such care as in all the circumstances of the case is reasonable";
    const block = doc.blocks.find((item) => item.label === "sec3(1)")!;
    const other = doc.blocks.find((item) => item.label === "sec2")!;
    expect(sourceDocContainsQuote(doc, quote)).toBe(true);
    expect(sourceDocContainsQuote(doc, quote, block)).toBe(true);
    expect(sourceDocContainsQuote(doc, quote, other)).toBe(false);
    expect(sourceDocContainsQuote(doc, "a duty that this Act never states")).toBe(
      false,
    );
    // The same quote gate the pinpoint link builder applies accepts it too.
    const url = buildLegalSourcePinpointUrl(
      { url: "https://www.ontario.ca/laws/statute/90o02", blockText: sourceDocBlockText(doc, block) },
      [quote],
    );
    expect(url).toContain("#:~:text=");
  });

  it("slices a block range and fails closed on an unknown endpoint", async () => {
    const doc = await compile(source);
    expect(
      sliceSourceDocBlocks(doc, "section", "3", "4").map((block) => block.label),
    ).toEqual([
      "sec3",
      "sec3(1)",
      "sec3(2)",
      "sec3(3)",
      "sec4",
    ]);
    expect(sliceSourceDocBlocks(doc, "section", "2").map((b) => b.label)).toEqual([
      "sec2",
    ]);
    expect(sliceSourceDocBlocks(doc, "section", "3", "99")).toEqual([]);
    expect(sliceSourceDocBlocks(doc, "paragraph", "1")).toEqual([]);
  });

  it("resolves references to canonical provider blocks without copying nodes", async () => {
    const doc = await compile(source);
    const graph = crossReferenceGraphFromSourceDoc(doc, { integrityThreshold: 0 });
    const target = doc.blocks.find(({ label }) => label === "sec9")!;
    expect("nodes" in graph).toBe(false);
    expect(graph.edges.find(({ raw, sourceLabel }) =>
      raw.toLowerCase() === "section 9" && sourceLabel === "sec2"))
      .toMatchObject({
        status: "resolved",
        targetLabel: target.label,
        targetStart: target.start,
        targetEnd: target.end,
      });
  });
});

describe("potato constraint", () => {
  /** ~2.3 MB of real federal statute Markdown, renumbered so labels stay unique. */
  function largeStatute(repetitions: number) {
    const excerpt = fixture("a2aj-laws-fed-criminalcode-s231").text;
    const parts: string[] = [];
    for (let index = 0; index < repetitions; index += 1) {
      parts.push(excerpt.replace("**231**", `**${1000 + index * 10}**`));
    }
    return parts.join("\n\n");
  }

  it("compiles a 2.3 MB statute once, in linear time", async () => {
    const small = await deriveA2AJSourceDoc({
      citation: "synthetic",
      docType: "laws",
      text: largeStatute(80),
    });
    const text = largeStatute(640);
    expect(text.length).toBeGreaterThan(2_300_000);
    const started = performance.now();
    const large = await deriveA2AJSourceDoc({
      citation: "synthetic",
      docType: "laws",
      text,
    });
    const elapsed = performance.now() - started;
    // Block count scales exactly with the input: no quadratic rescan and no
    // dropped provisions at size.
    expect(large.blocks.length).toBe(small.blocks.length * 8);
    expect(large.ranges.section.count).toBe(640 * 22);
    // Measured ~33 ms on the real 2.26 MB Criminal Code; this ceiling only
    // catches an order-of-magnitude regression on a slow runner.
    expect(elapsed).toBeLessThan(1_500);
    // Tokenization is deferred, so compiling never pays for it.
    expect(Object.getOwnPropertyDescriptor(large, "tokens")?.get).toBeTypeOf(
      "function",
    );
  });
});
