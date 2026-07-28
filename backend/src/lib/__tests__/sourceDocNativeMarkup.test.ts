import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceDoc, SourceDocLookup } from "../sourceDoc";
import {
  compileNativeMarkupSourceDoc,
  lookupLegalSourceDoc,
  summarizeLegalSourceDoc,
} from "../sourceDocNativeMarkup";

/**
 * Parity gate for the legalSourceStructure engine the native-markup compiler
 * replaced (master plan P1.1a stage 4).
 *
 * Every fixture in `fixtures/nativemarkup` is a REAL payload captured on
 * 2026-07-27 (TNA Akoma Ntoso XML, Harvard CAP casebody HTML, GOV.UK ET
 * content, a GovInfo package summary, a journals-provider article).
 * `legacy-structure.json` is the frozen output of the deleted engine,
 * machine-captured from it before removal: rendered text hash, every block
 * boundary, and a lookup battery whose payload hashes use the exact shape
 * TNA evidence receipts persist (`payload_sha256`). Do not regenerate it.
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

describe("parity with the legalSourceStructure engine replaced", () => {
  it("renders a real TNA judgment byte-identically", () => {
    const source = fixture<{ citation: string; markup: string }>(
      "tna-eat-2025-1",
    );
    assertRecording(
      compileNativeMarkupSourceDoc({
        provider: "tna",
        id: source.citation,
        text: "",
        markup: source.markup,
        citation: source.citation,
      }),
      LEGACY["tna-eat-2025-1"],
    );
  });

  it("renders real Harvard CAP casebody HTML byte-identically", () => {
    const source = fixture<{ citation: string; markup: string }>(
      "courtlistener-cap-372us335",
    );
    assertRecording(
      compileNativeMarkupSourceDoc({
        provider: "courtlistener",
        id: source.citation,
        text: "",
        markup: source.markup,
        citation: source.citation,
      }),
      LEGACY["courtlistener-cap-372us335"],
    );
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
    });

    expect(doc.ranges.paragraph.count).toBe(0);
    expect(doc.ranges.page.count).toBe(2);
    expect(
      lookupLegalSourceDoc(doc, "page", "410").block?.text,
    ).toContain("Distinctive reporter page passage");
  });

  it("reconstructs numbered paragraphs when markup has no native locators", () => {
    const markup = Array.from(
      { length: 5 },
      (_, index) =>
        `<p>[${index + 1}] Paragraph ${index + 1} contains enough substantive judicial words for reliable structural reconstruction.</p>`,
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
