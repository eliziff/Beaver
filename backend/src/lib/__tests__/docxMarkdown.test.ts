import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  parseDocxMarkdown,
  renderDocxMarkdown,
  renderDocxMarkdownDocument,
} from "../chat/tools/docxMarkdown";

async function packageXml(bytes: Buffer, name: string) {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(name);
  if (!file) throw new Error(`Missing ${name}`);
  return file.async("string");
}

const sample = `# Services {#services}

Counsel **must** act *promptly* for {{client_name}}.[^scope]

- First task
- Second task

| Item | Owner |
| --- | --- |
| Filing | {{client_name}} |

<!-- pagebreak -->

## Optional terms {-}

{{optional_terms}}

[^scope]: This scope is limited & subject to the retainer. See [@jordan].`;

const jordanCitation = {
  sources: [{
    stableId: "case:jordan",
    authority: "R v Jordan, 2016 SCC 27",
    shortAuthority: "Jordan",
    mainUrl: "https://example.test/jordan",
    pinpoints: [{
      text: "para. 5",
      url: "https://example.test/jordan#par5",
    }],
  }],
};

describe("semantic Markdown DOCX", () => {
  it("distinguishes indented blocks, literal greater-than signs, and hard breaks", async () => {
    const markdown = `Soft
wrap

Hard\\
break

> Indented
> continuation

\\> literal`;
    const parsed = parseDocxMarkdown(markdown);

    expect(parsed.blocks).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Soft" },
          { type: "text", text: " " },
          { type: "text", text: "wrap" },
        ],
      },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Hard" },
          { type: "break" },
          { type: "text", text: "break" },
        ],
      },
      {
        type: "blockquote",
        level: 1,
        children: [
          { type: "text", text: "Indented" },
          { type: "text", text: " " },
          { type: "text", text: "continuation" },
        ],
      },
      { type: "paragraph", children: [{ type: "text", text: "> literal" }] },
    ]);

    const documentXml = await packageXml(
      await renderDocxMarkdown(markdown),
      "word/document.xml",
    );
    expect(documentXml).toContain('<w:pStyle w:val="IndentedBlock"/>');
    expect(documentXml).toContain("<w:br/>");
    expect(documentXml).toContain("&gt; literal");
    expect(documentXml).not.toContain("&gt; Indented");
  });

  it("builds the standard memo header and renders grounded citations by style", async () => {
    const options = {
      title: "Narrow issue",
      citations: { case: jordanCitation },
      memoHeader: { to: "File", from: "AI Assistant" },
      generatedAt: new Date("2026-08-15T02:00:00.000Z"),
      timeZone: "America/Edmonton",
    };
    const footnoteBytes = await renderDocxMarkdown("Claim.[@case]", {
      ...options,
      citationPlacement: "footnotes",
    });
    const documentXml = await packageXml(footnoteBytes, "word/document.xml");
    const footnotesXml = await packageXml(footnoteBytes, "word/footnotes.xml");
    const footnoteRels = await packageXml(
      footnoteBytes,
      "word/_rels/footnotes.xml.rels",
    );

    expect(documentXml).toContain("To:");
    expect(documentXml).toContain("File");
    expect(documentXml).toContain("From:");
    expect(documentXml).toContain("AI Assistant");
    expect(documentXml).toContain("14 August 2026");
    expect(documentXml).toContain("Re:");
    expect(documentXml.match(/Narrow issue/gu)).toHaveLength(1);
    expect(documentXml).not.toContain('<w:pStyle w:val="Title"/>');
    expect(documentXml).toContain('<w:footnoteReference w:id="1"/>');
    expect(footnotesXml).toContain("R v Jordan, 2016 SCC 27");
    expect(footnotesXml).toContain("para. 5");
    expect(footnoteRels).toContain('Target="https://example.test/jordan"');
    expect(footnoteRels).toContain(
      'Target="https://example.test/jordan#par5"',
    );

    const inlineBytes = await renderDocxMarkdown("Claim.[@case]", {
      ...options,
      memoHeader: undefined,
      citationPlacement: "inline",
    });
    const inlineXml = await packageXml(inlineBytes, "word/document.xml");
    expect(inlineXml).toContain("R v Jordan, 2016 SCC 27");
    expect(inlineXml).toContain("para. 5");
    expect(inlineXml).not.toContain("w:footnoteReference");

    const afterBytes = await renderDocxMarkdown("Claim.[@case]", {
      ...options,
      memoHeader: undefined,
      citationPlacement: "after-paragraph",
    });
    const afterXml = await packageXml(afterBytes, "word/document.xml");
    expect(afterXml).toContain('<w:pStyle w:val="CitationBlock"/>');
    expect(afterXml).toContain("R v Jordan, 2016 SCC 27");

    await expect(renderDocxMarkdown(
      "To: File\nFrom: AI Assistant\nDate: Today\nRe: Duplicate\n\nBody.",
      options,
    )).rejects.toThrow("must not repeat the automatic");
    await expect(renderDocxMarkdown(
      "To: File From: AI Assistant Date: Today Re: Duplicate\n\nBody.",
      options,
    )).rejects.toThrow("must not repeat the automatic");
  });

  it("owns repeated-authority footnote forms instead of asking the model", async () => {
    const other = {
      sources: [{
        ...jordanCitation.sources[0],
        stableId: "case:other",
        authority: "R v Other, 2020 SCC 2",
        shortAuthority: "Other",
        mainUrl: "https://example.test/other",
      }],
    };
    const bytes = await renderDocxMarkdown(
      "First.[@jordan]\n\nSecond.[@other]\n\nThird.[@jordan]",
      {
        citations: { jordan: jordanCitation, other },
        citationPlacement: "footnotes",
      },
    );
    const footnotesXml = await packageXml(bytes, "word/footnotes.xml");
    expect(footnotesXml).toContain("R v Jordan, 2016 SCC 27");
    expect(footnotesXml).toContain("R v Other, 2020 SCC 2");
    expect(footnotesXml).toContain("Jordan, supra note 1");
  });

  it("parses the bounded structure and emits native Word features", async () => {
    const parsed = parseDocxMarkdown(sample);
    expect(parsed.blocks.map(({ type }) => type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "table",
      "page-break",
      "heading",
      "control",
    ]);
    expect(parsed.blocks[0]).toMatchObject({
      type: "heading",
      level: 1,
      numbered: true,
      bookmark: "services",
    });
    expect(parsed.blocks[5]).toMatchObject({
      type: "heading",
      numbered: false,
    });

    const first = await renderDocxMarkdown(sample, {
      title: "Services Agreement",
      landscape: true,
      citations: {
        jordan: jordanCitation,
      },
      values: {
        client_name: 'A & B <"Legal">',
        optional_terms: "First optional clause.\nSecond optional clause.",
      },
    });
    const second = await renderDocxMarkdownDocument(parsed, {
      title: "Services Agreement",
      landscape: true,
      citations: {
        jordan: jordanCitation,
      },
      values: {
        client_name: 'A & B <"Legal">',
        optional_terms: "First optional clause.\nSecond optional clause.",
      },
    });
    const xml = await packageXml(first, "word/document.xml");
    const secondXml = await packageXml(second, "word/document.xml");
    const footnotes = await packageXml(first, "word/footnotes.xml");
    const relationships = await packageXml(
      first,
      "word/_rels/footnotes.xml.rels",
    );
    const ids = [...xml.matchAll(/<w:id w:val="(\d+)"\/>/gu)].map(
      (match) => match[1],
    );
    const secondIds = [...secondXml.matchAll(/<w:id w:val="(\d+)"\/>/gu)].map(
      (match) => match[1],
    );

    expect(xml).toContain('<w:bookmarkStart w:name="services"');
    expect(xml).toContain("Services Agreement");
    expect(xml).toContain('w:orient="landscape"');
    expect(footnotes).toContain("R v Jordan, 2016 SCC 27");
    expect(relationships).toContain(
      'Target="https://example.test/jordan#par5"',
    );
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("<w:i/>");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain('<w:br w:type="page"/>');
    expect(xml).toContain('<w:tag w:val="client_name"/>');
    expect(xml).toContain('<w:tag w:val="optional_terms"/>');
    expect(xml).toContain("A &amp; B &lt;&quot;Legal&quot;&gt;");
    expect(xml).not.toContain("{{client_name}}");
    expect(new Set(ids).size).toBe(ids.length);
    expect(secondIds).toEqual(ids);
    expect(footnotes).toContain('<w:footnote w:id="1">');
    expect(footnotes).toContain("This scope is limited &amp; subject");
    expect(xml).toContain('<w:footnoteReference w:id="1"/>');
  });

  it("keeps integrity limits and citation-safety checks strict", async () => {
    expect(() => parseDocxMarkdown("   ")).toThrow("must not be empty");
    expect(() => parseDocxMarkdown("x".repeat(1_000_001))).toThrow("1 MB");
    await expect(
      renderDocxMarkdown("See [@case].", {
        citations: {
          case: {
            sources: [{
              ...jordanCitation.sources[0],
              mainUrl: "not a url",
            }],
          },
        },
      }),
    ).rejects.toThrow("invalid URL");
    await expect(
      renderDocxMarkdown("See [@case].", {
        citations: {
          case: {
            sources: [{ ...jordanCitation.sources[0], authority: "" }],
          },
        },
      }),
    ).rejects.toThrow("is invalid");
  });

  it("accepts numeric notes and leaves underscored identifiers literal", () => {
    const parsed = parseDocxMarkdown(
      "Use matter_file_name here.[^1]\n\n[^1]: Numeric note.",
    );

    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", text: "Use matter_file_name here." },
        { type: "footnote", id: "1" },
      ],
    });
  });

  it("recovers common legal-draft Markdown without leaking syntax or double numbering", () => {
    const parsed = parseDocxMarkdown(`THIS IS THE LAST WILL of \\_\\_\\_\\_.

# {-}
## Part 1 — Interpretation
### 1. Definitions and Interpretation

(a) "my Partner" means A; (b) "my Children" means B; (c) "my Trustees" means C.`);

    expect(parsed.blocks).toMatchObject([
      {
        type: "paragraph",
        children: [{ type: "text", text: "THIS IS THE LAST WILL of ____." }],
      },
      {
        type: "heading",
        numbered: false,
        children: [{ type: "text", text: "Part 1 — Interpretation" }],
      },
      {
        type: "heading",
        numbered: false,
        children: [
          { type: "text", text: "1. Definitions and Interpretation" },
        ],
      },
      {
        type: "list",
        items: [
          { ordered: true, level: 1 },
          { ordered: true, level: 1 },
          { ordered: true, level: 1 },
        ],
      },
    ]);
  });

  it("keeps native controls when a model wraps a field in emphasis", async () => {
    const parsed = parseDocxMarkdown(
      "The premises are **{{premises_address}}** and the tenant is *{{tenant_name}}*.",
    );
    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", text: "The premises are " },
        { type: "control", tag: "premises_address" },
        { type: "text", text: " and the tenant is " },
        { type: "control", tag: "tenant_name" },
        { type: "text", text: "." },
      ],
    });
    const xml = await packageXml(
      await renderDocxMarkdown(
        "The premises are **{{premises_address}}** and the tenant is *{{tenant_name}}*.",
      ),
      "word/document.xml",
    );
    expect(xml).toContain('<w:tag w:val="premises_address"/>');
    expect(xml).toContain('<w:tag w:val="tenant_name"/>');
  });

  it("recovers weak-model legal syntax without downgrading native controls", async () => {
    const markdown = `Initials: \\_\\_\\_\\_.

# {-}
## TERMS
### 1. Rent
# PART II — DISCLOSURES

Tenant: **{{ Tenant Name }}**; rent: *{{ MONTHLY RENT }}*.[^Lease_Note]

(a) first; (b) second; (c) third

| Field | Value |
| --- | --- |
| Tenant \\| occupant | **{{ Tenant Name }}** |

[^Lease_Note]: Confirm *{{ MONTHLY RENT }}*.`;
    const parsed = parseDocxMarkdown(markdown);

    expect(parsed.blocks.map(({ type }) => type)).toEqual([
      "paragraph",
      "heading",
      "heading",
      "heading",
      "paragraph",
      "list",
      "table",
    ]);
    expect(parsed.blocks.slice(1, 4)).toMatchObject([
      { type: "heading", numbered: false },
      { type: "heading", numbered: false },
      { type: "heading", numbered: false },
    ]);
    expect(parsed.blocks[0]).toMatchObject({
      children: [{ type: "text", text: "Initials: ____." }],
    });
    expect(parsed.blocks[4]).toMatchObject({
      children: [
        { type: "text", text: "Tenant: " },
        { type: "control", tag: "tenant_name" },
        { type: "text", text: "; rent: " },
        { type: "control", tag: "monthly_rent" },
        { type: "text", text: "." },
        { type: "footnote", id: "Lease_Note" },
      ],
    });
    expect(parsed.blocks[5]).toMatchObject({
      type: "list",
      items: [{ level: 1 }, { level: 1 }, { level: 1 }],
    });
    expect(parsed.footnotes[0]).toMatchObject({
      id: "Lease_Note",
      children: [
        { type: "text", text: "Confirm " },
        { type: "control", tag: "monthly_rent" },
        { type: "text", text: "." },
      ],
    });

    const bytes = await renderDocxMarkdown(markdown, {
      values: { " Tenant Name ": "" },
    });
    const documentXml = await packageXml(bytes, "word/document.xml");
    const footnotesXml = await packageXml(bytes, "word/footnotes.xml");
    expect(documentXml.match(/<w:tag w:val="tenant_name"\/>/gu)).toHaveLength(
      2,
    );
    expect(documentXml).toContain('<w:tag w:val="monthly_rent"/>');
    expect(footnotesXml).toContain('<w:tag w:val="monthly_rent"/>');
    expect(documentXml).toContain("[Monthly rent]");
    expect(documentXml).not.toContain("{{");
    expect(footnotesXml).not.toContain("{{");
  });

  it("does not repeat a model-authored title at the top of the body", async () => {
    const xml = await packageXml(
      await renderDocxMarkdown(
        "# RESIDENTIAL LEASE AGREEMENT\n\n## 1. Parties\n\nTerms.",
        { title: "Generic Residential Lease Agreement Template" },
      ),
      "word/document.xml",
    );
    expect(xml.match(/RESIDENTIAL LEASE AGREEMENT/gu)).toBeNull();
    expect(xml).toContain("Generic Residential Lease Agreement Template");
    expect(xml).toContain("1. Parties");
  });

  it("uses a restrained black legal house style and fixed page geometry", async () => {
    const bytes = await renderDocxMarkdown(
      "# Part 1 — Interpretation\n\n(a) First item\n(b) Second item\n\n| Issue | Result |\n| --- | --- |\n| Notice | Required |",
      { title: "Last Will and Testament" },
    );
    const documentXml = await packageXml(bytes, "word/document.xml");
    const stylesXml = await packageXml(bytes, "word/styles.xml");

    expect(stylesXml).toContain('w:styleId="Title"');
    expect(stylesXml).toContain('w:styleId="Heading1"');
    expect(stylesXml).toContain('<w:color w:val="000000"/>');
    expect(stylesXml).not.toContain("2E74B5");
    expect(documentXml).toContain(
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"',
    );
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>');
    expect(documentXml).toContain('<w:tblW w:type="dxa" w:w="9360"/>');
    expect(documentXml).not.toContain("<w:t>{-}</w:t>");
  });

  it("recovers unplaceable values but keeps size limits strict", async () => {
    const warnings: string[] = [];
    const xml = await packageXml(
      await renderDocxMarkdown(
        "Hello {{party}}.",
        {
          values: {
            typo: "unused",
            party: "Line one\nLine two",
            " Party ": "duplicate",
            "Bad/Key": "x",
            number: 7 as unknown as string,
          },
        },
        warnings,
      ),
      "word/document.xml",
    );
    expect(xml).toContain("Line one Line two");
    expect(warnings.join("\n")).toContain('value "typo"');
    expect(warnings.join("\n")).toContain("duplicate content-control value");
    expect(warnings.join("\n")).toContain('invalid key "Bad/Key"');
    expect(warnings.join("\n")).toContain('non-text content-control value');
    expect(warnings.join("\n")).toContain('multi-line value for inline control "party"');
    await expect(
      renderDocxMarkdown("{{terms}}", {
        values: { terms: "x".repeat(20_001) },
      }),
    ).rejects.toThrow("exceeds 20,000 characters");
  });

  it("keeps unsafe verified-citation URLs strict", async () => {
    await expect(
      renderDocxMarkdown("See [@case].", {
        citations: {
          case: {
            sources: [{
              ...jordanCitation.sources[0],
              mainUrl: "file:///secret",
            }],
          },
        },
      }),
    ).rejects.toThrow("unsafe URL");
  });
});

describe("weak-model recovery", () => {
  it("ignores a repeated {-} heading attribute", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown("# Recitals {-} {-}", warnings);
    expect(parsed.blocks[0]).toMatchObject({
      type: "heading",
      numbered: false,
      children: [{ type: "text", text: "Recitals" }],
    });
    expect(warnings.join("\n")).toContain("repeated {-}");
  });

  it("keeps the first bookmark when a heading defines two", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown("# Term {#first} {#second}", warnings);
    expect(parsed.blocks[0]).toMatchObject({
      type: "heading",
      bookmark: "first",
      children: [{ type: "text", text: "Term" }],
    });
    expect(warnings.join("\n")).toContain('kept "first"');
  });

  it("drops an invalid bookmark id", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown("# Term {#9bad}", warnings);
    expect(parsed.blocks[0]).toMatchObject({
      type: "heading",
      children: [{ type: "text", text: "Term" }],
    });
    expect(
      (parsed.blocks[0] as { bookmark?: string }).bookmark,
    ).toBeUndefined();
    expect(warnings.join("\n")).toContain('invalid bookmark "9bad"');
  });

  it("drops a duplicate bookmark and keeps both headings", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown(
      "# One {#same}\n\n## Two {#same}",
      warnings,
    );
    expect(parsed.blocks[0]).toMatchObject({ bookmark: "same" });
    expect(
      (parsed.blocks[1] as { bookmark?: string }).bookmark,
    ).toBeUndefined();
    expect(warnings.join("\n")).toContain('duplicate bookmark "same"');
  });

  it("keeps a leftover brace attribute as literal heading text", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown("# Term {-extra}", warnings);
    expect(parsed.blocks[0]).toMatchObject({
      type: "heading",
      children: [{ type: "text", text: "Term {-extra}" }],
    });
    expect(warnings.join("\n")).toContain("unrecognized heading attribute");
  });

  it("skips a heading with no text", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown("# {#only}\n\nBody.", warnings);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]).toMatchObject({ type: "paragraph" });
    expect(warnings.join("\n")).toContain("no text");
  });

  it("treats an invalid footnote definition line as body text", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown(
      "Note.[^n]\n\n[^bad id]: Not a definition\n\n[^n]: Real.",
      warnings,
    );
    expect(parsed.blocks[1]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "[^bad id]: Not a definition" }],
    });
    expect(parsed.footnotes).toMatchObject([{ id: "n" }]);
    expect(warnings.join("\n")).toContain("invalid footnote definition");
  });

  it("keeps the first of duplicate footnote definitions", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown(
      "Text[^a]\n\n[^a]: One\n[^a]: Two",
      warnings,
    );
    expect(parsed.footnotes).toMatchObject([
      { id: "a", children: [{ type: "text", text: "One" }] },
    ]);
    expect(warnings.join("\n")).toContain("first definition wins");
  });

  it("drops an empty footnote and its reference", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown("Text[^e]\n\n[^e]:", warnings);
    expect(parsed.footnotes).toEqual([]);
    expect(parsed.blocks[0]).toMatchObject({
      children: [{ type: "text", text: "Text" }],
    });
    expect(warnings.join("\n")).toContain('empty footnote "e"');
  });

  it("strips a footnote marker that has no definition", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown("Hello[^missing].", warnings);
    expect(parsed.blocks[0]).toMatchObject({
      children: [
        { type: "text", text: "Hello" },
        { type: "text", text: "." },
      ],
    });
    expect(warnings.join("\n")).toContain('"[^missing]"');
  });

  it("drops a footnote definition that is never referenced", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown("Body.\n\n[^orphan]: Unused.", warnings);
    expect(parsed.footnotes).toEqual([]);
    expect(warnings.join("\n")).toContain('"orphan"');
  });

  it("strips a footnote reference nested inside a footnote", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown(
      "Text[^a]\n\n[^a]: Inner[^a] note.",
      warnings,
    );
    expect(parsed.footnotes[0]).toMatchObject({
      id: "a",
      children: [
        { type: "text", text: "Inner" },
        { type: "text", text: " note." },
      ],
    });
    expect(warnings.join("\n")).toContain("inside a footnote");
  });

  it("keeps malformed inline markers as literal text", async () => {
    const warnings: string[] = [];
    const markdown = "Open {{Bad/Field}} and [@Bad Id] and }} stray.";
    const parsed = parseDocxMarkdown(markdown, warnings);
    expect(parsed.blocks[0].type).toBe("paragraph");
    const xml = await packageXml(
      await renderDocxMarkdown(markdown),
      "word/document.xml",
    );
    expect(xml).toContain("{{Bad/Field}}");
    expect(xml).toContain("[@Bad Id]");
    expect(warnings.join("\n")).toContain("content-control marker");
    expect(warnings.join("\n")).toContain("citation marker");
  });

  it("keeps a malformed block-level control marker as a literal paragraph", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown("{{Not A Tag!}}", warnings);
    expect(parsed.blocks[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "{{Not A Tag!}}" }],
    });
    expect(warnings.join("\n")).toContain("literal text");
  });

  it("adjusts table rows whose cell count does not match the header", () => {
    const warnings: string[] = [];
    const parsed = parseDocxMarkdown(
      "| A | B |\n| --- | --- |\n| one |\n| x | y | z |",
      warnings,
    );
    const table = parsed.blocks[0];
    if (table.type !== "table") throw new Error("Expected a table block.");
    expect(table.rows[0][1]).toEqual([]);
    expect(
      table.rows[1][1]
        .map((child) => "text" in child ? child.text : "")
        .join(""),
    ).toBe("y z");
    expect(warnings.join("\n")).toContain("Adjusted a table row");
  });

  it("strips a citation marker with no verified source", async () => {
    const warnings: string[] = [];
    const xml = await packageXml(
      await renderDocxMarkdown("See [@case] here.", {}, warnings),
      "word/document.xml",
    );
    expect(xml).not.toContain("[@case]");
    expect(xml).toContain("See ");
    expect(warnings.join("\n")).toContain("no verified source");
  });

  it("omits a verified citation that has no marker", async () => {
    const warnings: string[] = [];
    const xml = await packageXml(
      await renderDocxMarkdown(
        "Plain paragraph.",
        {
          citations: {
            case: { text: "Case", url: "https://example.test/case" },
          },
        },
        warnings,
      ),
      "word/document.xml",
    );
    expect(xml).not.toContain("Case");
    expect(warnings.join("\n")).toContain("no [@case] marker");
  });

  it("renders a valid DOCX from a deliberately messy draft", async () => {
    const warnings: string[] = [];
    const markdown = `# Agreement {#dup}

Intro clause with a stray [7] number.[^9]

## Terms {#dup}

# {#empty_heading}

| Col A | Col B |
| --- | --- |
| one |

{{Bad Tag!}}

Also a dangling [@nope] marker.`;
    const bytes = await renderDocxMarkdown(markdown, {}, warnings);
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file("[Content_Types].xml")).toBeTruthy();
    const xml = await packageXml(bytes, "word/document.xml");
    expect(xml).toContain("stray [7] number.");
    expect(xml).not.toContain("[^9]");
    expect(xml).not.toContain("[@nope]");
    expect(xml).toContain("{{Bad Tag!}}");
    expect(xml.match(/<w:bookmarkStart w:name="dup"/gu)).toHaveLength(1);
    expect(warnings.length).toBeGreaterThanOrEqual(4);
  });
});
