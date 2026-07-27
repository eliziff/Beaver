import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { fixDocxSupraCrossReferences } from "../docxDeterministicCleanup";

const W =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

async function fixture(args?: {
  supraXml?: string;
  settingsXml?: string;
}) {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="${W}"><w:body>
  <w:p><w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:sym w:font="Symbol" w:char="F02A"/></w:r></w:p>
  <w:p><w:r><w:t>First note</w:t></w:r><w:r><w:footnoteReference w:id="3"/></w:r></w:p>
  <w:p><w:r><w:t>Second note</w:t></w:r><w:r><w:footnoteReference w:id="7"/></w:r></w:p>
</w:body></w:document>`,
  );
  zip.file(
    "word/footnotes.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:footnotes xmlns:w="${W}">
  <w:footnote w:id="3"><w:p><w:r><w:t>First.</w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="7"><w:p>${args?.supraXml ?? '<w:r><w:t>See Smith, supra note 2.</w:t></w:r>'}</w:p></w:footnote>
</w:footnotes>`,
  );
  zip.file(
    "word/settings.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="${W}">${args?.settingsXml ?? ""}</w:settings>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

async function entry(bytes: Buffer, name: string) {
  return (await JSZip.loadAsync(bytes)).file(name)!.async("string");
}

describe("deterministic DOCX supra cleanup", () => {
  it("turns an unambiguous supra number into a native NOTEREF field", async () => {
    const result = await fixDocxSupraCrossReferences(await fixture());

    expect(result).toMatchObject({
      detected: 1,
      converted: 1,
      already_linked: 0,
      review_required: 0,
      bookmarks_added: 1,
    });
    const document = await entry(result.bytes, "word/document.xml");
    expect(document).toContain(
      'w:name="MikeSupraNote2"',
    );
    expect(document).toMatch(
      /w:name="MikeSupraNote2"\/><w:r><w:footnoteReference w:id="7"\/>/u,
    );
    const footnotes = await entry(result.bytes, "word/footnotes.xml");
    expect(footnotes).toContain("NOTEREF MikeSupraNote2 \\h");
    expect(footnotes).toContain('<w:t xml:space="preserve">2</w:t>');

    const replay = await fixDocxSupraCrossReferences(result.bytes);
    expect(replay).toMatchObject({
      detected: 1,
      converted: 0,
      already_linked: 1,
      review_required: 0,
    });
  });

  it("does not guess when numbering restarts by section", async () => {
    const original = await fixture({
      settingsXml:
        '<w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr>',
    });
    const result = await fixDocxSupraCrossReferences(original);

    expect(result).toMatchObject({
      detected: 1,
      converted: 0,
      review_required: 1,
      reasons: { restarted_numbering: true },
    });
    expect(result.bytes).toEqual(original);
  });

  it("handles ordinary styling splits while changing only the number run", async () => {
    const original = await fixture({
      supraXml:
        "<w:r><w:t>See Smith, supra note </w:t></w:r><w:r><w:t>2.</w:t></w:r>",
    });
    const result = await fixDocxSupraCrossReferences(original);

    expect(result).toMatchObject({
      detected: 1,
      converted: 1,
      review_required: 0,
    });
    expect(await entry(result.bytes, "word/footnotes.xml")).toContain(
      "NOTEREF MikeSupraNote2 \\h",
    );
  });

  it("reports an out-of-range target instead of guessing", async () => {
    const original = await fixture({
      supraXml: "<w:r><w:t>See Smith, supra note 200.</w:t></w:r>",
    });
    const result = await fixDocxSupraCrossReferences(original);

    expect(result).toMatchObject({
      detected: 1,
      converted: 0,
      review_required: 1,
      reasons: { unsafe_or_split_fields: 1 },
    });
    expect(result.bytes).toEqual(original);
  });
});
