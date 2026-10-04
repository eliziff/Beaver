import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { docxXml as packageXml } from "./support/docxFixtures";

import {
  parseDocxMarkdown,
  renderDocxMarkdown,
  renderDocxMarkdownDocument,
} from "../chat/tools/docxMarkdown";

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
      [
        "Author.[^author]", "First.[@jordan][@missing]", "Again.[@jordan]",
        "Second.[@other]", "Third.[@jordan]", "Group.[@group]",
        "After group.[@jordan]", "[^author]: Authored note.",
      ].join("\n\n"),
      {
        citations: {
          jordan: jordanCitation, other,
          group: { sources: [...jordanCitation.sources, ...other.sources] },
        },
        citationPlacement: "footnotes",
      },
    );
    const footnotesXml = await packageXml(bytes, "word/footnotes.xml");
    const notes = [...footnotesXml.matchAll(/<w:footnote\b[^>]*w:id="(\d+)"[^>]*>(.*?)<\/w:footnote>/gu)]
      .filter(([, id]) => Number(id) > 0)
      .map(([, id, xml]) => [Number(id), [...xml.matchAll(/<w:t(?: [^>]*)?>(.*?)<\/w:t>/gu)]
        .map(([, text]) => text).join("")]);
    expect(notes).toEqual([
      [1, "Authored note."],
      [2, "R v Jordan, 2016 SCC 27 at para. 5"],
      [3, "Ibid at para. 5"],
      [4, "R v Other, 2020 SCC 2 at para. 5"],
      [5, "Jordan, supra note 2 at para. 5"],
      [6, "R v Jordan, 2016 SCC 27 at para. 5; R v Other, 2020 SCC 2 at para. 5"],
      [7, "Jordan, supra note 2 at para. 5"],
    ]);
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
