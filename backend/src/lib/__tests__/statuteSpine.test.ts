import { describe, expect, it } from "vitest";

import { deriveSourceStructureGraphs } from "../sourceStructureEngine";
import { documentScalarOffsets } from "../structureWire";

// Fixture shapes mirror the corpus families measured by
// scripts/skeleton-oracle-probe.py / skeleton-oracle-diff.ts (431 texts,
// 24 datasets): federal dotless heads, NT/PE dot-terminated heads, and
// Ontario-drafting paragraph lists nested inside dotless sections.

const line = (label: string, body: string) => `${label} ${body}`;

async function sharedStatuteSpine(text: string, allowHyphenatedSections = false) {
  const [{ graph }] = await deriveSourceStructureGraphs([{
    provider: null,
    id: "statute-spine-contract",
    text,
    providerRevision: "statute-spine-contract-v1",
    scope: { kind: "complete" },
    profile: "legislation",
    allowHyphenatedSections,
    order: "legislation",
  }]);
  const offsets = documentScalarOffsets(text);
  return graph.nodes.flatMap((node) =>
    node.kind === "section" && !node.parent_id && node.label?.startsWith("sec") &&
    node.content_start !== undefined ? [{
      label: node.label.slice(3),
      start: offsets.scalarToUtf16(node.range.start),
      contentStart: offsets.scalarToUtf16(node.content_start),
    }] : []);
}

describe("shared legislation spine", () => {
  it("finds the dotless federal spine and pulls dotted descendants in", async () => {
    const text = [
      line("1", "This Act may be cited as the Example Act."),
      line("2", "The following definitions apply in this Act."),
      line("3", "This Act is binding on Her Majesty."),
      line("5", "The purpose of this Act is to benefit all persons."),
      line("5.1", "(1) The area of communication referred to in paragraph 5(c)"),
      line("5.2", "Nothing in this Act should be construed as requiring."),
      line("6", "This Act is to be carried out in recognition of principles."),
      line("7", "(1) This Act applies to the following entities:"),
    ].join("\n");
    const spine = await sharedStatuteSpine(text);
    expect(spine.map((mark) => mark.label)).toEqual([
      "1", "2", "3", "5", "5.1", "5.2", "6", "7",
    ]);
  });

  it("falls back to dot-terminated sections where bare marks do not exist", async () => {
    const text = [
      "1. In this Act, “Registrar General” means the registrar.",
      "2. (1) A person who has adopted a child may apply.",
      "3. (1) On receipt of the information provided the court decides.",
      "4. A certificate filed in the Supreme Court is proof.",
    ].join("\n");
    const spine = await sharedStatuteSpine(text);
    expect(spine.map((mark) => mark.label)).toEqual(["1", "2", "3", "4"]);
  });

  it("pulls dotted descendants into a dot-terminated section spine", async () => {
    const text = [
      "64. First provision.",
      "64.1. Inserted provision.",
      "65. Second provision.",
      "65.1. Another inserted provision.",
      "66. Final provision.",
    ].join("\n");

    expect((await sharedStatuteSpine(text)).map(({ label }) => label)).toEqual([
      "64",
      "64.1",
      "65",
      "65.1",
      "66",
    ]);
  });

  it("refuses repeated trailing-dot descendants", async () => {
    const text = [
      "64. First provision.",
      "64.1. First appearance.",
      "64.1. Repeated appearance.",
      "65. Second provision.",
      "99.1. Unrelated dotted line.",
      "66. Final provision.",
    ].join("\n");

    expect((await sharedStatuteSpine(text)).map(({ label }) => label)).toEqual([
      "64",
      "65",
      "66",
    ]);
  });

  it("falls back to New Brunswick Markdown section headings", async () => {
    const text = [
      "### 61.01 Enforcement of orders.",
      "### 61.02 Examination in aid of enforcement.",
      "### 61.03 Seizure and sale under an order.",
    ].join("\n");
    const spine = await sharedStatuteSpine(text);

    expect(spine.map((mark) => mark.label)).toEqual([
      "61.01",
      "61.02",
      "61.03",
    ]);
    expect(spine[1].start).toBe(text.indexOf("### 61.02"));
    expect(text.slice(spine[1].contentStart)).toMatch(/^Examination/u);
  });

  it("orders legislative decimals without dropping later provisions", async () => {
    const text = [
      "17.26 First provision.",
      "17.261 First inserted provision.",
      "17.262 Second inserted provision.",
      "17.27 Later provision.",
      "17.28 Final provision.",
    ].join("\n");

    expect((await sharedStatuteSpine(text)).map((mark) => mark.label)).toEqual([
      "17.26",
      "17.261",
      "17.262",
      "17.27",
      "17.28",
    ]);
  });

  it("indexes an indented provision at its first digit", async () => {
    const text = [
      "  1 First provision.",
      "  2 Second provision.",
      "  3 Third provision.",
    ].join("\n");
    const spine = await sharedStatuteSpine(text);

    expect(spine.map(({ start }) => start)).toEqual([
      text.indexOf("1"),
      text.indexOf("2"),
      text.indexOf("3"),
    ]);
  });

  it("keeps measured uppercase section suffixes", async () => {
    const text = [
      "5A (1) First suffixed provision.",
      "6 Next ordinary provision.",
      "17W Final suffixed provision.",
    ].join("\n");

    expect((await sharedStatuteSpine(text)).map((mark) => mark.label)).toEqual([
      "5A",
      "6",
      "17W",
    ]);
  });

  it.each([
    "### Interpretation of Sections 85AA to",
    "### Interprétation des articles 85AA à",
    "### Interpretation of Sections 85AA –",
  ])("does not parse a wrapped range end after %s", async (heading) => {
    const text = [
      heading,
      "85F",
      "85AA First provision in the range.",
      "85AB Second provision in the range.",
      "86 Provision after the range.",
    ].join("\n");

    const spine = await sharedStatuteSpine(text);
    expect(spine.map(({ label }) => label)).toEqual(["85AA", "85AB", "86"]);
    expect(spine[0].start).toBe(text.indexOf("85AA First"));
  });

  it("keeps a line-alone section after an ordinary Markdown heading", async () => {
    const text = [
      "### Interpretation",
      "85F",
      "Provision text continues on the next line.",
      "85G Next provision.",
      "86 Final provision.",
    ].join("\n");

    expect((await sharedStatuteSpine(text)).map(({ label }) => label)).toEqual([
      "85F",
      "85G",
      "86",
    ]);
  });

  it("keeps an earlier dot-terminated spine despite a later bare list", async () => {
    const text = [
      "1. First provision of the regulation.",
      "2. Second provision of the regulation.",
      "3. Third provision of the regulation.",
      "4. Fourth provision of the regulation.",
      "5. Fifth provision of the regulation.",
      "6. Sixth provision of the regulation.",
      "Schedule",
      "10 Table row.",
      "20 Another table row.",
      "30 Final table row.",
      "Explanatory schedule text follows the table.",
      "Further explanatory schedule text follows the table.",
    ].join("\n");

    expect((await sharedStatuteSpine(text)).map((mark) => mark.label)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
  });

  it("does not require an arbitrary size advantage for the earlier dot-terminated spine", async () => {
    const text = [
      "1. First provision.",
      "2. Second provision.",
      "3. Third provision.",
      "4. Fourth provision.",
      "5. Fifth provision.",
      "Schedule",
      "10 Table row.",
      "20 Another table row.",
      "30 Final table row.",
      "Explanatory schedule text follows.".repeat(20),
    ].join("\n");

    expect((await sharedStatuteSpine(text)).map(({ label }) => label)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("keeps an earlier Markdown spine separate from later bare rows", async () => {
    const text = [
      "### 61.01 Enforcement of orders.",
      "### 61.02 Examination in aid of enforcement.",
      "### 61.03 Seizure and sale under an order.",
      "Schedule",
      "10 Table row.",
      "20 Another table row.",
      "30 Final table row.",
      "Explanatory schedule text follows.".repeat(20),
    ].join("\n");

    expect((await sharedStatuteSpine(text)).map(({ label }) => label)).toEqual([
      "61.01",
      "61.02",
      "61.03",
    ]);
  });

  it.each([
    ["hyphen", ["1-1", "1-2", "1-10"]],
    ["mixed", ["1.1-1", "1.1-2", "1.1-3"]],
  ] as const)("gates %s rule labels", async (_style, labels) => {
    const text = labels
      .map((label) => `${label} Rule text for this provision.`)
      .join("\n");

    expect(await sharedStatuteSpine(text)).toEqual([]);
    expect((await sharedStatuteSpine(text, true)).map((mark) => mark.label)).toEqual(
      labels,
    );
  });

  it("prefers a bare spine over a longer nested paragraph list", async () => {
    // Ontario drafting: "1." paragraphs inside dotless sections. The
    // dotterm chain is longer (5 > 3) but is not the spine.
    const text = [
      line("1", "A person is exempted if the person satisfies the following:"),
      "1. The person is registered with a regulatory authority.",
      "2. A regulatory authority has not refused the person.",
      "3. A finding of misconduct has not been made.",
      "4. The person is not the subject of any proceeding.",
      "5. The person has submitted an application.",
      line("2", "A person who is exempted must notify the College."),
      line("3", "Omitted (provides for coming into force)."),
    ].join("\n");
    const spine = await sharedStatuteSpine(text);
    expect(spine.map((mark) => mark.label)).toEqual(["1", "2", "3"]);
  });

  it("expands integer roots before scoring a denser dotted hypothesis", async () => {
    const text = [
      "1 First root.",
      "1.1 First child.",
      "1.2 Second child.",
      "1.3 Third child.",
      "2 Second root.",
      "2.1 First child.",
      "2.2 Second child.",
      "2.3 Third child.",
      "3 Third root.",
      "3.1 First child.",
      "3.2 Second child.",
      "3.3 Third child.",
    ].join("\n");

    expect((await sharedStatuteSpine(text)).map(({ label }) => label)).toEqual([
      "1",
      "1.1",
      "1.2",
      "1.3",
      "2",
      "2.1",
      "2.2",
      "2.3",
      "3",
      "3.1",
      "3.2",
      "3.3",
    ]);
  });

  it("refuses equal-strength dotted dialect disagreement", async () => {
    const text = [
      "17.26 First provision.",
      "17.261 First inserted provision.",
      "17.27 Later provision.",
      "17.262 Ambiguous reordered provision.",
    ].join("\n");

    expect(await sharedStatuteSpine(text)).toEqual([]);
  });

  it("returns no spine for prose with scattered numbers", async () => {
    const text = [
      "This agreement is made as of January 1, 2004 between the parties.",
      "2004 was the year of the closing (as defined below).",
      "The purchase price is 3 million dollars payable at closing.",
    ].join("\n");
    expect(await sharedStatuteSpine(text)).toEqual([]);
  });

  it.each([
    [
      "one section",
      "1 This Act may be cited as the Short Act.\nFurther operative text.",
      ["1"],
    ],
    [
      "two sections",
      "1 This Act may be cited as the Short Act.\n2 This Act comes into force on assent.",
      ["1", "2"],
    ],
    [
      "label-alone sections",
      "1\nShort title\nThis Act may be cited as the Short Act.\n2\n(1) This Act comes into force on assent.",
      ["1", "2"],
    ],
  ] as const)("recovers a guarded short-root %s", async (_name, text, expected) => {
    expect((await sharedStatuteSpine(text)).map(({ label }) => label)).toEqual(
      expected,
    );
  });

  it("refuses duplicate short roots", async () => {
    const text = [
      "1 First candidate provision.",
      "1 Repeated quoted provision.",
      "2 Second candidate provision.",
    ].join("\n");

    expect(await sharedStatuteSpine(text)).toEqual([]);
  });

  it("refuses a line-broken quantity as a short section", async () => {
    const text = [
      "1",
      "Short title",
      "The instrument text follows.",
      "2",
      "de 45,72 litres",
    ].join("\n");

    expect(await sharedStatuteSpine(text)).toEqual([]);
  });

  it("rejects a spine that begins in the final third of the text", async () => {
    const filler = "Recitals and schedules occupy this document.\n".repeat(80);
    const tail = [
      line("1", "First provision of the late fragment."),
      line("2", "Second provision of the late fragment."),
      line("3", "Third provision of the late fragment."),
    ].join("\n");
    expect(await sharedStatuteSpine(filler + tail)).toEqual([]);
  });

  // Measured on LegalBench-RAG-mini: 10 of 69 agreements drew a spine whose
  // marks were mostly or entirely centred page numbers, and the spurious spine
  // then suppressed the real "Section N." headings (ALAMOGORDO agency
  // agreement: 39 empty "sections", the (a)..(n) ladder scattered across four
  // of them). The label-alone extension may EXTEND a spine, never CONSTITUTE
  // one; the A2AJ laws sample (960 documents, 39,371 provider section labels)
  // is unchanged label-for-label by this rule.
  it("refuses a spine made only of label-alone page numbers", async () => {
    const page = (number: number) =>
      [
        `Section ${number}. Heading of the operative provision.`,
        "",
        "Operative text of the provision continues here at length.",
        "",
        `                    ${number + 1}`,
        "",
      ].join("\n");
    const text = [1, 2, 3, 4, 5, 6].map(page).join("");
    expect(await sharedStatuteSpine(text)).toEqual([]);
  });

  it("still lets label-alone marks extend a substantive spine", async () => {
    const text = [
      line("1", "This Act may be cited as the Example Act."),
      line("2", "The following definitions apply in this Act."),
      "3",
      "Application",
      "This Act applies to every person in the territory.",
      line("4", "The Minister may make regulations."),
    ].join("\n");
    expect((await sharedStatuteSpine(text)).map(({ label }) => label)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("keeps monotone discipline: a restarted list opens a new scope", async () => {
    const text = [
      line("1", "First provision about definitions."),
      line("2", "Second provision about application."),
      line("3", "Third provision about interpretation."),
      line("4", "Fourth provision about administration."),
      line("1", "A quoted enacted provision restarting numbering."),
      line("2", "Another quoted provision."),
    ].join("\n");
    const spine = await sharedStatuteSpine(text);
    expect(spine.map((mark) => mark.label)).toEqual(["1", "2", "3", "4"]);
  });
});
