import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceDoc, SourceDocLookup } from "../sourceDoc";
import {
  compileNativeMarkupSourceDoc,
  lookupLegalSourceDoc,
  nativeMarkupCitedRefs,
  summarizeLegalSourceDoc,
} from "../sourceDocNativeMarkup";

/**
 * Parity gates for the native-markup compiler.
 *
 * Every fixture in `fixtures/nativemarkup` is a REAL payload captured on
 * 2026-07-27 (TNA Akoma Ntoso XML, Harvard CAP casebody HTML, GOV.UK ET
 * content, a GovInfo package summary, a journals-provider article).
 *
 * `legacy-structure.json` is the frozen output of the deleted
 * legalSourceStructure engine (master plan P1.1a stage 4), machine-captured
 * before removal. Do not regenerate it. Since the v2 structure enrichment
 * (CAP star-pagination pages + footnote asides, TNA lvl_N sections;
 * 2026-07-30) the compiler intentionally indexes MORE than the legacy
 * engine, so the legacy recording now gates the invariants that must
 * survive enrichment: rendered text stays byte-identical and every legacy
 * block survives verbatim. Lookup contexts follow the corrected current
 * index rather than replaying defects from the deleted engine.
 *
 * `native-structure-v2.json` is the frozen output of the enriched
 * compiler — the byte-exact gate for current behavior, in the exact shape
 * TNA evidence receipts persist (`payload_sha256`, schema v2).
 */

const FIXTURE_DIR = path.join(__dirname, "fixtures", "nativemarkup");

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type Recording = {
  status: "usable" | "unavailable";
  source: string;
  counts: Record<string, number>;
  textSha256: string;
  textLength: number;
  blocks: Array<
    [string, string, number, number, string | null, string | null]
  >;
  lookups: Array<{
    kind: "paragraph" | "page" | "section" | "footnote";
    locator: string;
    status: string;
    requestedLabel: string;
    matches: string[];
    block: string | null;
    anchor: string | null;
    before: string[];
    after: string[];
    payloadSha256: string;
  }>;
};

const LEGACY = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, "legacy-structure.json"), "utf8"),
) as Record<string, Recording>;

const V2 = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, "native-structure-v2.json"), "utf8"),
) as Record<string, Recording>;

function fixture<T>(file: string): T {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, `${file}.json`), "utf8"),
  ) as T;
}

/**
 * Byte-identical copy of publicLegalSources' lookupPayload: the JSON whose
 * sha256 is persisted as `payload_sha256` in TNA evidence receipts. If this
 * shape drifts from production, receipt rehydration breaks in production too.
 */
function lookupPayload(lookup: SourceDocLookup) {
  const block = (value: SourceDocLookup["block"]) =>
    value
      ? {
          kind: value.kind,
          label: value.label,
          start: value.start,
          end: value.end,
          anchor: value.anchor ?? null,
          locator_kind: value.kind,
          provider_locator: value.anchor ?? value.label,
          origin: value.origin,
          parent_label: value.parentLabel ?? null,
          text: value.text,
        }
      : null;
  return {
    requested_label: lookup.requestedLabel,
    matches: lookup.matches,
    block: block(lookup.block),
    before: lookup.before.map(block),
    after: lookup.after.map(block),
  };
}

function assertRecording(doc: SourceDoc, recording: Recording) {
  expect(sha256(doc.text)).toBe(recording.textSha256);
  expect(doc.text.length).toBe(recording.textLength);
  expect(doc.status).toBe(recording.status);
  expect(
    doc.blocks.map((block) => [
      block.kind,
      block.label,
      block.start,
      block.end,
      block.anchor ?? null,
      block.parentLabel ?? null,
    ]),
  ).toEqual(recording.blocks);
  const summary = summarizeLegalSourceDoc(doc);
  expect(summary.source).toBe(recording.source);
  expect(summary.counts).toEqual({
    footnote: 0,
    ...recording.counts,
  });
  for (const before of recording.lookups) {
    const after = lookupLegalSourceDoc(doc, before.kind, before.locator, 2);
    expect(`${before.locator}:${after.status}`).toBe(
      `${before.locator}:${before.status}`,
    );
    expect(after.requestedLabel).toBe(before.requestedLabel);
    expect(after.matches).toEqual(before.matches);
    expect(after.block?.label ?? null).toBe(before.block);
    expect(after.block?.anchor ?? null).toBe(before.anchor);
    expect(after.before.map(({ label }) => label)).toEqual(before.before);
    expect(after.after.map(({ label }) => label)).toEqual(before.after);
    expect(sha256(JSON.stringify(lookupPayload(after)))).toBe(
      before.payloadSha256,
    );
  }
}

/**
 * The deleted engine's recording gates unchanged text and legacy blocks.
 * Lookup hashes belong to the current v2 recording because corrected
 * indexing can change their context.
 */
function assertLegacyInvariants(doc: SourceDoc, recording: Recording) {
  expect(sha256(doc.text)).toBe(recording.textSha256);
  expect(doc.text.length).toBe(recording.textLength);
  const current = new Set(
    doc.blocks.map((block) =>
      JSON.stringify([
        block.kind,
        block.label,
        block.start,
        block.end,
        block.anchor ?? null,
        block.parentLabel ?? null,
      ]),
    ),
  );
  const footnotes = doc.blocks.filter(({ kind }) => kind === "footnote");
  for (const block of recording.blocks.filter(
    ([kind, , start, end]) =>
      kind !== "paragraph" ||
      !footnotes.some(
        (footnote) => start >= footnote.start && start < footnote.end,
      ),
  )) {
    expect(current.has(JSON.stringify(block))).toBe(true);
  }
}

describe("parity with the frozen structure recordings", () => {
  it("renders a real TNA judgment byte-identically (v2 + legacy invariants)", () => {
    const source = fixture<{ citation: string; markup: string }>(
      "tna-eat-2025-1",
    );
    const doc = compileNativeMarkupSourceDoc({
      provider: "tna",
      id: source.citation,
      text: "",
      markup: source.markup,
      citation: source.citation,
    });
    assertRecording(doc, V2["tna-eat-2025-1"]);
    assertLegacyInvariants(doc, LEGACY["tna-eat-2025-1"]);
  });

  it("renders real Harvard CAP casebody HTML byte-identically (v2 + legacy invariants)", () => {
    const source = fixture<{ citation: string; markup: string }>(
      "courtlistener-cap-372us335",
    );
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: source.citation,
      text: "",
      markup: source.markup,
      citation: source.citation,
    });
    assertRecording(doc, V2["courtlistener-cap-372us335"]);
    assertLegacyInvariants(doc, LEGACY["courtlistener-cap-372us335"]);
  });

  it("keeps plain-text providers on the shared prose spine", () => {
    const et = fixture<{ caseNumber: string; text: string }>(
      "govuk-et-kogut-2200123-2023",
    );
    assertRecording(
      compileNativeMarkupSourceDoc({
        provider: "govuk-et",
        id: et.caseNumber,
        text: et.text,
      }),
      LEGACY["govuk-et-kogut-2200123-2023"],
    );
    const govinfo = fixture<{ packageId: string; text: string }>(
      "govinfo-nywd-1-22-cv-00930",
    );
    assertRecording(
      compileNativeMarkupSourceDoc({
        provider: "govinfo",
        id: govinfo.packageId,
        text: govinfo.text,
      }),
      LEGACY["govinfo-nywd-1-22-cv-00930"],
    );
  });
});

describe("native markup compilation", () => {
  it("preserves TNA paragraph and nested section eIds", () => {
    const xml = `
      <akomaNtoso>
        <judgment>
          <section eId="section_2">
            <num>2.</num>
            <subsection eId="section_2__subsection_1">
              <num>(1)</num>
              <paragraph eId="para_24">
                <num>24.</num>
                <content>The native paragraph has distinctive exact words.</content>
              </paragraph>
            </subsection>
          </section>
        </judgment>
      </akomaNtoso>`;
    const doc = compileNativeMarkupSourceDoc({
      provider: "tna",
      id: "[2024] TEST 1",
      text: "",
      markup: xml,
    });
    const paragraph = lookupLegalSourceDoc(doc, "paragraph", "24");
    const subsection = lookupLegalSourceDoc(doc, "section", "2(1)");

    expect(paragraph.status).toBe("found");
    expect(paragraph.block?.anchor).toBe("para_24");
    expect(paragraph.block?.origin).toBe("native");
    expect(paragraph.block?.text).toContain("distinctive exact words");
    expect(subsection.status).toBe("found");
    expect(subsection.block?.anchor).toBe("section_2__subsection_1");
    expect(subsection.block?.parentLabel).toBe("sec2");
    expect(summarizeLegalSourceDoc(doc).source).toBe("native");
  });

  it("uses native CourtListener pages but not arbitrary HTML p IDs", () => {
    const markup = `
      <article>
        <p id="Auq">Opening unnumbered opinion text.</p>
        <page-number label="410" citation-index="1"></page-number>
        <p id="Bxr">Distinctive reporter page passage.</p>
        <page-number label="411" citation-index="1"></page-number>
        <p id="Cys">Following reporter page passage.</p>
      </article>`;
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "cluster-1",
      text: "",
      markup,
      pageCitations: ["410 U.S. 113"],
    });

    expect(doc.ranges.paragraph.count).toBe(0);
    expect(doc.blocks.filter(({ kind }) => kind === "page")).toHaveLength(2);
    expect(
      lookupLegalSourceDoc(doc, "page", "410").block?.text,
    ).toContain("Distinctive reporter page passage");
    expect(lookupLegalSourceDoc(doc, "page", "410 U.S. 410").status).toBe(
      "found",
    );
  });

  it("compiles CAP star pagination inline without breaking text flow", () => {
    const markup =
      '<article class="opinion"><p>The sentence continues across ' +
      '<a id="p880" href="#p880" data-label="880" data-citation-index="1" class="page-label">*880</a> ' +
      "the reporter page boundary without interruption.</p></article>";
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "cap-1",
      text: "",
      markup,
      pageCitations: ["12 Example Reporter 875"],
    });
    expect(doc.text).toContain(
      "continues across *880 the reporter page boundary",
    );
    const page = lookupLegalSourceDoc(doc, "page", "880");
    expect(page.status).toBe("found");
    expect(page.block?.anchor).toBe("p880");
    expect(page.block?.origin).toBe("native");
    expect(page.block?.text).toContain("*880 the reporter page");
    expect(
      lookupLegalSourceDoc(doc, "page", "12 Example Reporter 880").status,
    ).toBe("found");
    expect(lookupLegalSourceDoc(doc, "page", "p880").status).toBe("found");
  });

  it("uses star-pagination text rather than its sequence number", () => {
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "tax-court",
      text: "",
      markup:
        '<p>First.</p><span class="star-pagination" number="P2" pagescheme="T.C. Memo">*153</span>' +
        '<p>Second.</p><span class="star-pagination">*Page 154</span><p>Third.</p>',
    });

    expect(lookupLegalSourceDoc(doc, "page", "153").block?.text).toContain(
      "Second.",
    );
    expect(
      lookupLegalSourceDoc(doc, "page", "T.C. Memo, at *153").status,
    ).toBe("found");
    expect(lookupLegalSourceDoc(doc, "page", "154").block?.text).toContain(
      "Third.",
    );
    expect(lookupLegalSourceDoc(doc, "page", "P2").block).toBeNull();
  });

  it("keeps CAP reporter streams distinct and ignores pgmap scan coordinates", () => {
    const markup =
      '<article pgmap="372"><page-number label="Supp. 833" citation-index="1"></page-number>' +
      '<p>Official reporter passage.</p><page-number label="536" citation-index="2"></page-number>' +
      '<p>Parallel reporter passage.</p><span class="star-pagination" citation-index="2">*537</span>' +
      '<p>Next parallel reporter passage.</p><footnote label="1">Quoted text ' +
      '<page-number label="Supp. 833" citation-index="1"></page-number>from the prior page.</footnote>' +
      '<footnote label="*">Reporter note <page-number label="536" citation-index="2"></page-number>' +
      "from the prior parallel page.</footnote></article>";
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "cap-parallel-pages",
      text: "",
      markup,
      pageCitations: ["276 Cal. App. 2d 831", "80 Cal. Rptr. 534"],
    });

    expect(
      lookupLegalSourceDoc(doc, "page", "276 Cal. App. 2d Supp. 833").status,
    ).toBe("found");
    expect(
      lookupLegalSourceDoc(doc, "page", "80 Cal. Rptr. 536").status,
    ).toBe("found");
    expect(
      lookupLegalSourceDoc(doc, "page", "80 Cal. Rptr. 537").status,
    ).toBe("found");
    expect(doc.blocks.filter(({ kind }) => kind === "page")).toHaveLength(3);
    expect(lookupLegalSourceDoc(doc, "page", "372").status).toBe("not_found");
  });

  it("compiles CAP footnote asides to native footnote blocks", () => {
    const markup =
      '<article class="opinion"><p>Body text with a mark' +
      '<a class="footnotemark" href="#footnote_1_2" id="ref_footnote_1_2">2</a>.</p>' +
      '<aside data-label="2" class="footnote" id="footnote_1_2">' +
      "<p>The distinctive footnote body text.</p></aside></article>";
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "cap-2",
      text: "",
      markup,
    });
    const footnote = lookupLegalSourceDoc(doc, "footnote", "footnote 2");
    expect(footnote.status).toBe("found");
    expect(footnote.block?.label).toBe("fn2");
    expect(footnote.block?.anchor).toBe("footnote_1_2");
    expect(footnote.block?.text).toContain("distinctive footnote body");
    expect(
      lookupLegalSourceDoc(doc, "footnote", "footnote_1_2").status,
    ).toBe("found");
  });

  it("uses CourtListener footnote containers and their supplied markers", () => {
    const markup =
      '<div id="fn_fnote1"><p>Classless ID footnote.</p></div>' +
      '<div class="fn-footnote"><p><sup>2</sup> Supplied marker footnote.</p></div>' +
      '<footnote_body><sup id="fn3">[3]</sup> Footnote-body text.</footnote_body>' +
      '<footnote label="*">Symbol note <page-number label="99"></page-number>without a main page.</footnote>';
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "courtlistener-footnote-forms",
      text: "",
      markup,
    });

    expect(lookupLegalSourceDoc(doc, "footnote", "1").block?.text).toContain(
      "Classless ID footnote",
    );
    expect(lookupLegalSourceDoc(doc, "footnote", "2").block?.text).toContain(
      "Supplied marker footnote",
    );
    expect(lookupLegalSourceDoc(doc, "footnote", "3").block?.text).toContain(
      "Footnote-body text",
    );
    expect(
      lookupLegalSourceDoc(doc, "footnote", "footnote *").block?.text,
    ).toContain("Symbol note");
    expect(lookupLegalSourceDoc(doc, "page", "99").status).toBe("unavailable");
  });

  it("compiles TNA lvl_N levels to native section blocks", () => {
    const markup = `
      <judgment>
        <level eId="lvl_1"><heading>Introduction</heading>
          <paragraph eId="para_1"><content>Opening body.</content></paragraph>
        </level>
        <level eId="lvl_2"><heading>The relevant background</heading>
          <paragraph eId="para_2"><content>Background body.</content></paragraph>
        </level>
      </judgment>`;
    const doc = compileNativeMarkupSourceDoc({
      provider: "tna",
      id: "[2025] TEST 2",
      text: "",
      markup,
    });
    const section = lookupLegalSourceDoc(doc, "section", "2");
    expect(section.status).toBe("found");
    expect(section.block?.anchor).toBe("lvl_2");
    expect(section.block?.text).toContain("The relevant background");
  });

  it("collects TNA <ref> cited authorities as data", () => {
    const markup =
      '<judgment><p>As held in <ref uk:canonical="[2016] UKSC 11" uk:type="case" ' +
      'href="https://caselaw.nationalarchives.gov.uk/id/uksc/2016/11">' +
      "Patel v Mirza [2016] UKSC 11</ref> and applied under " +
      '<ref uk:canonical="1996 c. 18" uk:type="legislation">Employment Rights Act 1996</ref>, ' +
      'repeated as <ref uk:canonical="[2016] UKSC 11" uk:type="case">Patel</ref>.</p></judgment>';
    expect(nativeMarkupCitedRefs(markup)).toEqual([
      {
        citation: "Patel v Mirza [2016] UKSC 11",
        canonical: "[2016] UKSC 11",
        type: "case",
      },
      {
        citation: "Employment Rights Act 1996",
        canonical: "1996 c. 18",
        type: "legislation",
      },
    ]);
    expect(nativeMarkupCitedRefs("<p>no refs here</p>")).toEqual([]);
  });

  it("reconstructs CourtListener pilcrow paragraphs without native locators", () => {
    const markup = Array.from(
      { length: 5 },
      (_, index) =>
        `<p>¶ ${index + 1} Paragraph ${index + 1} contains enough substantive judicial words for reliable structural reconstruction and repeats the court's reasoning in a complete source passage.</p>`,
    ).join("");
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "cluster-2",
      text: "",
      markup,
    });
    const lookup = lookupLegalSourceDoc(doc, "paragraph", "paragraph 4");

    expect(lookup.status).toBe("found");
    expect(lookup.block?.origin).toBe("heuristic");
    expect(lookup.block?.text).toContain("Paragraph 4");
    expect(doc.ranges.section.count).toBe(0);
    expect(summarizeLegalSourceDoc(doc).source).toBe("flat_text");
  });

  it("uses CourtListener numbered divs as native paragraphs", () => {
    const markup = [1, 2, 3]
      .map(
        (number) =>
          `<div class="num" id="p${number}"><span class="num">${number}</span><p>Provider paragraph ${number}.</p></div>`,
      )
      .join("");
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "courtlistener-native-paragraphs",
      text: "",
      markup,
    });

    expect(lookupLegalSourceDoc(doc, "paragraph", "2").block).toMatchObject({
      label: "par2",
      anchor: "p2",
      origin: "native",
    });
  });

  it("recovers CourtListener's exact marker variants but fences HTML footnotes", () => {
    const prose =
      "contains enough substantive judicial reasoning words for reliable structural reconstruction and audit.";
    const markup = [
      "<article>",
      `<p>1 Paragraph one ${prose}</p>`,
      `<p>2 Paragraph two ${prose}</p>`,
      `<p>3.Third paragraph ${prose}</p>`,
      "<p>4. . . .</p>",
      `<p>5 Paragraph five ${prose}</p>`,
      `<p>6 Paragraph six ${prose}</p>`,
      "</article>",
      '<div class="footnotes"><h4>Footnotes</h4>',
      ...Array.from(
        { length: 6 },
        (_, index) => `<p>${index + 1}. Footnote ${index + 1} ${prose}</p>`,
      ),
      "</div>",
    ].join("");
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "cluster-footnote-fence",
      text: "",
      markup,
    });
    const paragraphs = doc.blocks.filter(({ kind }) => kind === "paragraph");

    expect(paragraphs.map(({ label }) => label)).toEqual([
      "par1",
      "par2",
      "par3",
      "par4",
      "par5",
      "par6",
    ]);
    expect(lookupLegalSourceDoc(doc, "paragraph", "6").block?.text).not.toContain(
      "Footnotes",
    );
    expect(
      lookupLegalSourceDoc(doc, "paragraph", "1").block?.text,
    ).toContain("Paragraph one");
  });

  it("does not bridge an absent CourtListener paragraph label", () => {
    const prose =
      "contains enough substantive judicial reasoning words for reliable structural reconstruction and audit.";
    const markup = [
      "<article>",
      ...[1, 2, 4, 5, 6, 7, 8].map(
        (number) => `<p>${number} Paragraph ${number} ${prose}</p>`,
      ),
      "</article>",
    ].join("");
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "cluster-missing-marker",
      text: "",
      markup,
    });

    expect(
      doc.blocks
        .filter(({ kind }) => kind === "paragraph")
        .map(({ label }) => label),
    ).toEqual(["par4", "par5", "par6", "par7", "par8"]);
    expect(lookupLegalSourceDoc(doc, "paragraph", "3").status).toBe(
      "not_found",
    );
  });

  it("does not promote a numeric CourtListener table to paragraphs", () => {
    const markup = [
      "<article>",
      ...Array.from(
        { length: 6 },
        (_, index) =>
          `<p>${1913 + index} $ ${134350 + index} $ ${8479 + index} $ ${6000 + index}</p>`,
      ),
      "</article>",
    ].join("");
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "cluster-numeric-table",
      text: "",
      markup,
    });

    expect(doc.ranges.paragraph.count).toBe(0);
  });

  it("preserves native paragraphs and reconstructs missing labels", () => {
    const markup = [
      "<article>",
      '<paragraph id="para_1"><num>[1]</num><content>Paragraph 1 contains enough substantive judicial words for reliable structural reconstruction.</content></paragraph>',
      ...Array.from(
        { length: 4 },
        (_, index) =>
          `<p>[${index + 2}] Paragraph ${index + 2} contains enough substantive judicial words for reliable structural reconstruction.</p>`,
      ),
      "</article>",
    ].join("");
    const doc = compileNativeMarkupSourceDoc({
      provider: "courtlistener",
      id: "cluster-partial",
      text: "",
      markup,
    });

    expect(
      doc.blocks
        .filter(({ kind }) => kind === "paragraph")
        .map(({ label, origin, anchor }) => [label, origin, anchor ?? null]),
    ).toEqual([
      ["par1", "native", "para_1"],
      ["par2", "heuristic", null],
      ["par3", "heuristic", null],
      ["par4", "heuristic", null],
      ["par5", "heuristic", null],
    ]);
    expect(lookupLegalSourceDoc(doc, "paragraph", "1").block).toMatchObject({
      label: "par1",
      origin: "native",
      anchor: "para_1",
    });
    expect(lookupLegalSourceDoc(doc, "paragraph", "4").block).toMatchObject({
      label: "par4",
      origin: "heuristic",
    });
    expect(summarizeLegalSourceDoc(doc).source).toBe("hybrid");
  });

  it("does not invent PDF pages from page-count metadata", () => {
    const doc = compileNativeMarkupSourceDoc({
      provider: "govinfo",
      id: "USCOURTS-test",
      text: "A decision with no embedded page markers.",
    });
    expect(doc.ranges.page.count).toBe(0);
    expect(doc.status).toBe("unavailable");
  });
});
