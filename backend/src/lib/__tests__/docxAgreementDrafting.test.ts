import { describe, expect, it } from "vitest";
import { docxXml as packageXml } from "./support/docxFixtures";

import { applyTrackedEdits, extractDocxBodyText } from "../docxTrackedChanges";
import {
  renderMarkdownDocx,
  safeGeneratedFilename,
} from "../chat/tools/documentOps";

it("does not duplicate a supplied generated-file extension", () => {
  expect(safeGeneratedFilename("covenant-memo.docx", "docx")).toBe(
    "covenant-memo.docx",
  );
});

const agreementMarkdown = `# Parties and termination

This Agreement is between {{party_a}} and {{party_b}}.

{{termination_clause}}`;
const agreementFields = {
  party_a: "Acme & <North>",
  party_b: "[Second party]",
  termination_clause: "Either party may terminate on 30 days' notice.",
};

describe("agreement DOCX drafting", () => {
  it("renders deterministic tagged Word content controls without leaking markers", async () => {
    const first = await renderMarkdownDocx(
      "Service Agreement",
      agreementMarkdown,
      agreementFields,
    );
    const second = await renderMarkdownDocx(
      "Service Agreement",
      agreementMarkdown,
      agreementFields,
    );
    if ("error" in first) throw new Error(first.error);
    if ("error" in second) throw new Error(second.error);

    const xml = await packageXml(first.bytes);
    const secondXml = await packageXml(second.bytes);
    const ids = [...xml.matchAll(/<w:id w:val="(\d+)"\/>/gu)].map(
      (match) => match[1],
    );
    const secondIds = [...secondXml.matchAll(/<w:id w:val="(\d+)"\/>/gu)].map(
      (match) => match[1],
    );

    expect(xml.match(/<w:sdt>/gu)).toHaveLength(3);
    expect(xml).toContain('<w:tag w:val="party_a"/>');
    expect(xml).toContain('<w:alias w:val="Termination clause"/>');
    expect(xml).toContain("Acme &amp; &lt;North&gt;");
    expect(xml).not.toContain("{{party_a}}");
    expect(new Set(ids).size).toBe(3);
    expect(secondIds).toEqual(ids);
    await expect(extractDocxBodyText(first.bytes)).resolves.toContain(
      "Either party may terminate on 30 days' notice.",
    );

    const edit = await applyTrackedEdits(first.bytes, [
      {
        find: "Acme & <North>",
        replace: "Changed party",
        context_before: "This Agreement is between ",
        context_after: " and ",
      },
    ]);
    expect(edit.changes).toEqual([]);
    expect(edit.errors[0]?.reason).toContain("Word content control");
  });

  it("normalizes weak-model field ids before rendering native controls", async () => {
    const rendered = await renderMarkdownDocx(
      "Lease",
      "Tenant: **{{ Tenant Name }}**.",
      { " Tenant Name ": "Alex" },
    );
    if ("error" in rendered) throw new Error(rendered.error);

    const xml = await packageXml(rendered.bytes);
    expect(xml).toContain('<w:tag w:val="tenant_name"/>');
    expect(xml).toContain("Alex");
  });

  it("binds repeated fields to one custom XML value", async () => {
    const rendered = await renderMarkdownDocx(
      "Lease",
      "The premises are {{property_address}}. Notices concern {{property_address}}.",
      { property_address: "101 Main Street" },
    );
    if ("error" in rendered) throw new Error(rendered.error);

    const xml = await packageXml(rendered.bytes);
    const bindings = [...xml.matchAll(/<w:dataBinding\b([^>]*)\/>/gu)];
    expect(bindings).toHaveLength(2);
    expect(bindings.map((match) => match[1].match(/w:xpath="([^"]+)"/u)?.[1]))
      .toEqual([
        "/b:fields/b:field[@name=&apos;property_address&apos;]",
        "/b:fields/b:field[@name=&apos;property_address&apos;]",
      ]);
    const storeIds = bindings.map(
      (match) => match[1].match(/w:storeItemID="([^"]+)"/u)?.[1],
    );
    expect(new Set(storeIds).size).toBe(1);
    expect(await packageXml(rendered.bytes, "customXml/item1.xml")).toContain(
      '<b:field name="property_address">101 Main Street</b:field>',
    );
    expect(await packageXml(rendered.bytes, "customXml/itemProps1.xml")).toContain(
      `ds:itemID="${storeIds[0]}"`,
    );
    expect(
      await packageXml(rendered.bytes, "word/_rels/document.xml.rels"),
    ).toContain('Target="../customXml/item1.xml"');
    expect(
      await packageXml(rendered.bytes, "customXml/_rels/item1.xml.rels"),
    ).toContain('Target="itemProps1.xml"');
    expect(await packageXml(rendered.bytes, "[Content_Types].xml")).toContain(
      'PartName="/customXml/itemProps1.xml"',
    );
  });

  it("reports every bad field in one recoverable error", async () => {
    const error = await renderMarkdownDocx("Lease", "{{a}}", {
      a: "ok", "": "x", " A ": "dup", b: 7,
    }).then(() => "", (reason: Error) => reason.message);
    expect(error).toContain("identifier beginning with a letter");
    expect(error).toContain('"a" is duplicated');
    expect(error).toContain('"b" value');
  });

  it("rejects array field bindings and excessive field data", async () => {
    for (const fields of [[], { a: "x".repeat(20_001) },
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`field_${i}`, "value"])),
      Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`field_${i}`, "x".repeat(20_000)]))]) {
      await expect(renderMarkdownDocx("Lease", "{{a}}", fields)).rejects.toThrow("DOCX fields");
    }
  });
});
