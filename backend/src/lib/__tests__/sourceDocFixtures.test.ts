import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildA2AJStructure,
  lookupA2AJStructure,
} from "../a2ajStructure";
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
import { compileA2AJSourceDoc } from "../sourceDocA2AJ";

/**
 * The cross-provider fixture matrix (master plan P1.1a stage 1): the P1.1
 * acceptance test that never existed.
 *
 * Every fixture in `fixtures/sourcedoc` is a trimmed excerpt of a REAL A2AJ
 * payload captured once from the keyless api.a2aj.ca on 2026-07-27; each file
 * records the endpoint, parameters, full-document size and the character range
 * it was cut from. Nothing here touches the network.
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

function legacy(source: Fixture) {
  return buildA2AJStructure({
    text: source.text,
    docType: source.docType,
    citation: source.citation,
    alternateCitation: source.alternateCitation,
    dataset: source.dataset,
    name: source.name,
    sectionMap: source.sectionMap ?? null,
  });
}

function compile(source: Fixture): SourceDoc {
  return compileA2AJSourceDoc({
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

/**
 * Shapes whose spine the compiler must reproduce exactly. Statute shapes that
 * the flat-text spine never matched are excluded on purpose - there is no old
 * behaviour there to be faithful to.
 */
const PARITY_FIXTURES = [
  "a2aj-case-scc-2026scc16-toc",
  "a2aj-case-scc-2001scc1-bare",
  "a2aj-case-scc-1990scr30-unnumbered",
  "a2aj-case-scc-1986scr103-dot",
  "a2aj-laws-on-occupiers-liability",
  "a2aj-regs-on-oreg267-03",
] as const;

const MATRIX: Array<{
  file: string;
  docType: "cases" | "laws";
  shape: string;
  legacySections: number;
  legacyParagraphs: number;
  compiledSections: number;
  compiledParagraphs: number;
}> = [
  {
    file: "a2aj-case-scc-2026scc16-toc",
    docType: "cases",
    shape: "case-bracket-paragraphs-with-table-of-contents",
    legacySections: 0,
    legacyParagraphs: 18,
    compiledSections: 0,
    compiledParagraphs: 18,
  },
  {
    file: "a2aj-case-scc-2001scc1-bare",
    docType: "cases",
    shape: "case-bare-numbered-paragraphs",
    legacySections: 0,
    legacyParagraphs: 25,
    compiledSections: 0,
    compiledParagraphs: 25,
  },
  {
    file: "a2aj-case-scc-1990scr30-unnumbered",
    docType: "cases",
    shape: "case-pre1995-unnumbered",
    legacySections: 0,
    legacyParagraphs: 0,
    compiledSections: 0,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-case-scc-1986scr103-dot",
    docType: "cases",
    shape: "case-pre1995-dot-numbered",
    legacySections: 0,
    legacyParagraphs: 18,
    compiledSections: 0,
    compiledParagraphs: 18,
  },
  {
    file: "a2aj-laws-fed-criminalcode-s231",
    docType: "laws",
    shape: "laws-federal-emphasis-sections",
    legacySections: 0,
    legacyParagraphs: 0,
    compiledSections: 22,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-fed-criminalcode-s22-1",
    docType: "laws",
    shape: "laws-federal-emphasis-decimal-sections",
    legacySections: 0,
    legacyParagraphs: 0,
    compiledSections: 13,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-fed-criminalcode-s83-01",
    docType: "laws",
    shape: "laws-federal-emphasis-definitions",
    legacySections: 0,
    legacyParagraphs: 0,
    compiledSections: 26,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-fed-criminalcode-sectionmap",
    docType: "laws",
    shape: "laws-federal-section-map",
    legacySections: 52,
    legacyParagraphs: 0,
    compiledSections: 53,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-laws-on-occupiers-liability",
    docType: "laws",
    shape: "laws-ontario-bare-sections",
    legacySections: 66,
    legacyParagraphs: 0,
    compiledSections: 66,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-regs-fed-crc870-a01",
    docType: "laws",
    shape: "regs-federal-alphanumeric-emphasis-sections",
    legacySections: 0,
    legacyParagraphs: 0,
    compiledSections: 4,
    compiledParagraphs: 0,
  },
  {
    file: "a2aj-regs-on-oreg267-03",
    docType: "laws",
    shape: "regs-ontario-bare-sections-with-list-trap",
    legacySections: 64,
    legacyParagraphs: 0,
    compiledSections: 64,
    compiledParagraphs: 0,
  },
];

describe("SourceDoc cross-provider fixture matrix", () => {
  it("covers every committed fixture and every fixture is a real capture", () => {
    const files = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/u, ""))
      .sort();
    expect(files).toEqual(MATRIX.map((entry) => entry.file).sort());
    for (const entry of MATRIX) {
      const source = fixture(entry.file);
      expect(source.provider).toBe("a2aj");
      expect(source.shape).toBe(entry.shape);
      expect(source.capture).toMatchObject({ capturedAt: "2026-07-27" });
      expect(source.citation).toBeTruthy();
    }
  });

  it.each(MATRIX)(
    "$file indexes $compiledSections sections and $compiledParagraphs paragraphs",
    (entry) => {
      const source = fixture(entry.file);
      const old = legacy(source);
      const doc = compile(source);
      expect(old.counts.section).toBe(entry.legacySections);
      expect(old.counts.paragraph).toBe(entry.legacyParagraphs);
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

  it.each(PARITY_FIXTURES)(
    "%s keeps the existing spine byte-identical",
    (file) => {
      const source = fixture(file);
      const old = legacy(source);
      const doc = compile(source);
      expect(doc.text).toBe(old.text);
      expect(doc.blocks.map((block) => ({
        kind: block.kind,
        label: block.label,
        start: block.start,
        end: block.end,
        text: sourceDocBlockText(doc, block),
      }))).toEqual(
        old.blocks.map((block) => ({
          kind: block.kind,
          label: block.label,
          start: block.start,
          end: block.end,
          text: old.text.slice(block.start, block.end).trim(),
        })),
      );
      const kind = source.docType === "laws" ? "section" : "paragraph";
      for (const block of old.blocks) {
        const locator = block.label.replace(/^(?:sec|par|page=?)/iu, "");
        const before = lookupA2AJStructure(old, kind, locator, 2);
        const after = lookupSourceDoc(doc, kind, locator, 2);
        expect(after.status).toBe(before.status);
        expect(after.requestedLabel).toBe(before.requestedLabel);
        expect(after.matches).toEqual(before.matches);
        expect(after.block?.text ?? null).toBe(before.block?.text ?? null);
        expect(after.before.map((item) => item.label)).toEqual(
          before.before.map((item) => item.label),
        );
        expect(after.after.map((item) => item.label)).toEqual(
          before.after.map((item) => item.label),
        );
      }
    },
  );

  it("marks every A2AJ block heuristic except a provider section spine", () => {
    for (const entry of MATRIX) {
      const doc = compile(fixture(entry.file));
      const origins = new Set(doc.blocks.map((block) => block.origin));
      if (entry.file === "a2aj-laws-fed-criminalcode-sectionmap") {
        // The section map is provider-supplied granularity; the nesting
        // inside each section is still read out of prose.
        expect([...origins].sort()).toEqual(["heuristic", "native"]);
        expect(
          doc.blocks
            .filter((block) => block.origin === "native")
            .map((block) => block.label),
        ).toEqual(["sec231", "sec22.1", "sec83.01"]);
      } else {
        expect([...origins]).not.toContain("native");
      }
    }
  });
});

describe("federal statute corpus: zero sections before, indexed after", () => {
  const source = fixture("a2aj-laws-fed-criminalcode-s231");

  it("the current engine finds nothing in the emphasis shape", () => {
    const old = legacy(source);
    expect(old.status).toBe("unavailable");
    expect(old.blocks).toEqual([]);
    for (const locator of ["231", "231(2)", "231(4)(a)", "231(6.1)"]) {
      expect(lookupA2AJStructure(old, "section", locator).status).toBe(
        "unavailable",
      );
    }
  });

  it("the compiler resolves the section, its subsections and its paragraphs", () => {
    const doc = compile(source);
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

  it("separates the decimal subsections (6.01) and (6.1)", () => {
    const doc = compile(source);
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

  it("indexes decimal sections and Roman subparagraphs", () => {
    const doc = compile(fixture("a2aj-laws-fed-criminalcode-s22-1"));
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

  it("keeps uppercase clause letters out of the Roman run", () => {
    const doc = compile(fixture("a2aj-laws-fed-criminalcode-s83-01"));
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

  it("indexes alphanumeric federal regulation sections", () => {
    const doc = compile(fixture("a2aj-regs-fed-crc870-a01"));
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

describe("provider section map and Markdown emphasis agree", () => {
  it("produces the same labels from both inputs", () => {
    const mapped = compile(fixture("a2aj-laws-fed-criminalcode-sectionmap"));
    for (const [file, section] of [
      ["a2aj-laws-fed-criminalcode-s231", "sec231"],
      ["a2aj-laws-fed-criminalcode-s22-1", "sec22.1"],
      ["a2aj-laws-fed-criminalcode-s83-01", "sec83.01"],
    ] as const) {
      const emphasis = compile(fixture(file));
      const fromMap = labels(mapped).filter(
        (label) => label === section || label.startsWith(`${section}(`),
      );
      const fromMarkdown = labels(emphasis).filter(
        (label) => label === section || label.startsWith(`${section}(`),
      );
      expect(fromMarkdown).toEqual(fromMap);
    }
  });

  it("fixes the labels the section-map engine mislabels today", () => {
    const source = fixture("a2aj-laws-fed-criminalcode-sectionmap");
    const old = legacy(source);
    const doc = compile(source);
    const oldLabels = old.blocks.map((block) => block.label);
    // Today (6.1) is dropped because Number("01") === Number("1"), so its
    // paragraphs are re-parented onto (6.01) ...
    expect(oldLabels).toContain("sec231(6.01)(a)");
    expect(oldLabels).not.toContain("sec231(6.1)");
    // ... and (C)/(D)/(E) are read as Roman numerals, losing (ii).
    expect(oldLabels).toContain("sec83.01(1)(b)(D)(E)");
    expect(labels(doc)).toContain("sec231(6.1)(a)");
    expect(labels(doc)).not.toContain("sec231(6.01)(a)");
    expect(labels(doc)).toContain("sec83.01(1)(b)(ii)(E)");
    expect(labels(doc)).not.toContain("sec83.01(1)(b)(D)(E)");
  });
});

describe("case spine defects the compiler inherits unchanged", () => {
  // These are wrong, verified live against the full documents, and are held
  // here so that fixing them is a deliberate, gated change rather than an
  // accident. Stage 2 changes how the spine is queried, not what it finds.
  it("halves the paragraph index when the decision carries a table of contents", () => {
    const doc = compile(fixture("a2aj-case-scc-2026scc16-toc"));
    expect(labels(doc)).toEqual([
      "par1",
      "par2",
      "par4",
      "par6",
      "par8",
      "par10",
      "par12",
      "par14",
      "par16",
      "par18",
      "par20",
      "par22",
      "par24",
      "par26",
      "par28",
      "par30",
      "par32",
      "par34",
    ]);
    // Every odd paragraph from 3 up is reported missing rather than silently
    // absent - the locator range makes the defect legible to a caller.
    expect(doc.ranges.paragraph.missing.slice(0, 4)).toEqual([
      "par3",
      "par5",
      "par7",
      "par9",
    ]);
  });

  it("anchors par1 of a dot-numbered pre-1995 decision on quoted legislation", () => {
    const doc = compile(fixture("a2aj-case-scc-1986scr103-dot"));
    expect(lookupSourceDoc(doc, "paragraph", "1").block?.text).toContain(
      "The Canadian Charter of Rights and Freedoms guarantees the rights",
    );
    expect(lookupSourceDoc(doc, "paragraph", "2").status).toBe("not_found");
  });

  it("abstains on a pre-1995 decision with no paragraph numbers", () => {
    const doc = compile(fixture("a2aj-case-scc-1990scr30-unnumbered"));
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
  it("advertises first, last and the gaps in between", () => {
    const doc = compile(fixture("a2aj-laws-on-occupiers-liability"));
    expect(doc.ranges.section).toMatchObject({
      kind: "section",
      count: 66,
      first: "sec1",
      last: "sec11",
      missing: [],
      missingTruncated: false,
    });
    expect(doc.ranges.paragraph.count).toBe(0);
    const regulation = compile(fixture("a2aj-regs-on-oreg267-03"));
    expect(regulation.ranges.section.first).toBe("sec2");
    expect(regulation.ranges.section.last).toBe("sec14");
  });

  it("caps the reported gap list instead of listing thousands", () => {
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

  it("tokenizes exactly like the pinpoint link builder", () => {
    const doc = compile(source);
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

  it("verifies a quote against the whole document and one block", () => {
    const doc = compile(source);
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

  it("slices a block range and fails closed on an unknown endpoint", () => {
    const doc = compile(source);
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

  it("compiles a 2.3 MB statute once, in linear time", () => {
    const small = compileA2AJSourceDoc({
      citation: "synthetic",
      docType: "laws",
      text: largeStatute(80),
    });
    const text = largeStatute(640);
    expect(text.length).toBeGreaterThan(2_300_000);
    const started = performance.now();
    const large = compileA2AJSourceDoc({
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
