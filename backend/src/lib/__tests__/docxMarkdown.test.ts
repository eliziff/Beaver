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

describe("semantic Markdown DOCX", () => {
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
        jordan: {
          text: "R v Jordan, 2016 SCC 27 at para 5",
          url: "https://example.test/jordan#par5",
        },
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
        jordan: {
          text: "R v Jordan, 2016 SCC 27 at para 5",
          url: "https://example.test/jordan#par5",
        },
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
    expect(footnotes).toContain("R v Jordan, 2016 SCC 27 at para 5");
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

  it("fails closed on duplicate, invalid, and unresolved structure", () => {
    expect(() => parseDocxMarkdown("# One {#same}\n\n## Two {#same}")).toThrow(
      'Duplicate bookmark "same"',
    );
    expect(() => parseDocxMarkdown("Text[^a]\n\n[^a]: One\n[^a]: Two")).toThrow(
      'Duplicate footnote definition "a"',
    );
    expect(() => parseDocxMarkdown("Hello {{Bad/Field}}.")).toThrow(
      "Invalid content-control marker",
    );
    expect(() => parseDocxMarkdown("Hello[^missing].")).toThrow(
      'Footnote reference "missing" has no definition',
    );
    expect(() => parseDocxMarkdown("Hello [@Bad Id].")).toThrow(
      "Invalid citation marker",
    );
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

  it("rejects values which cannot be placed safely", async () => {
    await expect(
      renderDocxMarkdown("Hello {{party}}.", {
        values: { typo: "unused" },
      }),
    ).rejects.toThrow('value "typo" has no marker');
    await expect(
      renderDocxMarkdown("Hello {{party}}.", {
        values: { party: "Line one\nLine two" },
      }),
    ).rejects.toThrow("cannot span lines");
    await expect(
      renderDocxMarkdown("{{terms}}", {
        values: { terms: "x".repeat(20_001) },
      }),
    ).rejects.toThrow("exceeds 20,000 characters");
  });

  it("requires a safe verified source for every citation marker", async () => {
    await expect(renderDocxMarkdown("See [@case].")).rejects.toThrow(
      'Citation marker "case" has no verified source',
    );
    await expect(
      renderDocxMarkdown("See [@case].", {
        citations: {
          case: { text: "Case", url: "file:///secret" },
        },
      }),
    ).rejects.toThrow("unsafe URL");
  });
});
