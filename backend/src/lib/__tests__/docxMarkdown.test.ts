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
    expect(() => parseDocxMarkdown("Hello {{Bad Field}}.")).toThrow(
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
