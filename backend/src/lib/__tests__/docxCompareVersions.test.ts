import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import { describe, expect, it } from "vitest";

import { compareDocxVersions } from "../docxCompareVersions";
import { extractDocxBodyText } from "../docxTrackedChanges";

async function docxFrom(paragraphs: string[]): Promise<Buffer> {
  return Packer.toBuffer(
    new Document({
      sections: [
        {
          children: paragraphs.map(
            (text) => new Paragraph({ children: [new TextRun(text)] }),
          ),
        },
      ],
    }),
  );
}

function cell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun(text)] })],
  });
}

async function docxWithTable(price: string): Promise<Buffer> {
  return Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({
              children: [new TextRun("Fee schedule follows.")],
            }),
            new Table({
              rows: [
                new TableRow({ children: [cell("Item"), cell("Price")] }),
                new TableRow({ children: [cell("Base fee"), cell(price)] }),
              ],
            }),
            new Paragraph({
              children: [new TextRun("Prices are exclusive of tax.")],
            }),
          ],
        },
      ],
    }),
  );
}

async function documentXml(bytes: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  return zip.file("word/document.xml")!.async("string");
}

const countOf = (xml: string, re: RegExp) => (xml.match(re) ?? []).length;

describe("compareDocxVersions", () => {
  it("marks a purely inserted paragraph as w:ins (runs + paragraph mark)", async () => {
    const oldBytes = await docxFrom([
      "The vendor shall deliver the goods.",
      "Payment is due within thirty days.",
    ]);
    const newBytes = await docxFrom([
      "The vendor shall deliver the goods.",
      "Risk passes to the purchaser on delivery.",
      "Payment is due within thirty days.",
    ]);

    const result = await compareDocxVersions(oldBytes, newBytes, {
      author: "Reviewer",
    });

    expect(result.abstentions).toEqual([]);
    expect(
      result.changes.map((c) => ({
        kind: c.kind,
        ins: c.insertedText,
        del: c.deletedText,
      })),
    ).toEqual([
      {
        kind: "insert",
        ins: "Risk passes to the purchaser on delivery.",
        del: "",
      },
    ]);

    const xml = await documentXml(result.bytes);
    // One w:ins around the paragraph's runs, one in w:pPr/w:rPr for the
    // paragraph mark itself.
    expect(countOf(xml, /<w:ins\b/gu)).toBe(2);
    expect(countOf(xml, /<w:del\b/gu)).toBe(0);
    expect(xml).toContain('w:author="Reviewer"');
    await expect(extractDocxBodyText(result.bytes)).resolves.toContain(
      "Risk passes to the purchaser on delivery.",
    );
  });

  it("marks a purely deleted paragraph as w:del between its neighbours", async () => {
    const kept1 = "The vendor shall deliver the goods.";
    const removed = "The vendor may substitute equivalent goods.";
    const kept2 = "Payment is due within thirty days.";
    const oldBytes = await docxFrom([kept1, removed, kept2]);
    const newBytes = await docxFrom([kept1, kept2]);

    const result = await compareDocxVersions(oldBytes, newBytes);

    expect(result.abstentions).toEqual([]);
    expect(
      result.changes.map((c) => ({ kind: c.kind, del: c.deletedText })),
    ).toEqual([{ kind: "delete", del: removed }]);

    const xml = await documentXml(result.bytes);
    // One w:del around the cloned runs, one for the paragraph mark.
    expect(countOf(xml, /<w:del\b/gu)).toBe(2);
    expect(countOf(xml, /<w:ins\b/gu)).toBe(0);
    expect(countOf(xml, /<w:delText\b/gu)).toBe(1);
    expect(xml).toContain(`>${removed}</w:delText>`);
    // The deleted paragraph is spliced between its old neighbours.
    expect(xml.indexOf(removed)).toBeGreaterThan(xml.indexOf(kept1));
    expect(xml.indexOf(removed)).toBeLessThan(xml.indexOf(kept2));
    // Accepted view: the deletion disappears.
    const accepted = await extractDocxBodyText(result.bytes);
    expect(accepted).toContain(kept1);
    expect(accepted).toContain(kept2);
    expect(accepted).not.toContain(removed);
  });

  it("tracks a mid-paragraph word replacement as one del + one ins", async () => {
    const oldBytes = await docxFrom([
      "The Purchaser shall pay the costs of the escrow agent.",
    ]);
    const newBytes = await docxFrom([
      "The Supplier shall pay the costs of the escrow agent.",
    ]);

    const result = await compareDocxVersions(oldBytes, newBytes);

    expect(result.abstentions).toEqual([]);
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0];
    expect(change.kind).toBe("replace");
    expect(change.deletedText).toBe("Purchaser");
    expect(change.insertedText).toBe("Supplier");
    expect(change.contextBefore).toBe("The ");
    expect(change.contextAfter).toMatch(/^ shall pay/u);

    const xml = await documentXml(result.bytes);
    expect(countOf(xml, /<w:del\b/gu)).toBe(1);
    expect(countOf(xml, /<w:ins\b/gu)).toBe(1);
    expect(xml).toContain("Purchaser</w:delText>");
    await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
      "The Supplier shall pay the costs of the escrow agent.",
    );
  });

  it("keeps punctuation-only additions off the neighbouring word", async () => {
    // quote_edits tokenization: "," is its own token, so appending a
    // clause does not delete-and-reinsert "costs".
    const oldBytes = await docxFrom(["The award covers costs"]);
    const newBytes = await docxFrom([
      "The award covers costs, interest and disbursements.",
    ]);

    const result = await compareDocxVersions(oldBytes, newBytes);

    expect(result.abstentions).toEqual([]);
    expect(
      result.changes.map((c) => ({
        kind: c.kind,
        del: c.deletedText,
        ins: c.insertedText,
      })),
    ).toEqual([
      { kind: "insert", del: "", ins: ", interest and disbursements." },
    ]);

    const xml = await documentXml(result.bytes);
    expect(countOf(xml, /<w:del\b/gu)).toBe(0);
    expect(countOf(xml, /<w:ins\b/gu)).toBe(1);
  });

  it("returns the new document untouched when nothing changed", async () => {
    const paragraphs = [
      "This agreement is governed by Ontario law.",
      "Each party bears its own costs.",
    ];
    const oldBytes = await docxFrom(paragraphs);
    const newBytes = await docxFrom(paragraphs);

    const result = await compareDocxVersions(oldBytes, newBytes);

    expect(result.changes).toEqual([]);
    expect(result.abstentions).toEqual([]);
    expect(result.bytes.equals(newBytes)).toBe(true);
  });

  it("abstains on a table change and leaves the new table unmarked", async () => {
    const oldBytes = await docxWithTable("$100.00");
    const newBytes = await docxWithTable("$250.00");

    const result = await compareDocxVersions(oldBytes, newBytes);

    expect(result.changes).toEqual([]);
    expect(result.abstentions).toHaveLength(1);
    expect(result.abstentions[0].reason).toMatch(/^table_changed:/u);
    expect(result.abstentions[0].excerpt).toContain("$250.00");

    const xml = await documentXml(result.bytes);
    expect(countOf(xml, /<w:ins\b/gu)).toBe(0);
    expect(countOf(xml, /<w:del\b/gu)).toBe(0);
    // The new version's table content is intact and unmarked.
    expect(xml).toContain("$250.00");
    expect(xml).not.toContain("$100.00");
  });
});
