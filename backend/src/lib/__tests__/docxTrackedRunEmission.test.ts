import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { elChildren, elName, getTextContent } from "../docx/core";
import { openDocxSession } from "../docx/session";
import { applyTrackedEdits, extractDocxBodyText, resolveTrackedChange } from "../docxTrackedChanges";

const original = "abcdef😀gh";
const content = `<w:pPr><w:keepNext/></w:pPr>
  <w:r><w:rPr><w:b/></w:rPr><w:t/><w:t>ab</w:t><w:t>cd</w:t></w:r>
  <w:r><w:t/></w:r>
  <w:r><w:rPr><w:i/></w:rPr><w:t>ef😀</w:t><w:t>gh</w:t><w:t/></w:r>`;
const packageWith = (body = content) => new JSZip()
  .file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${body}</w:p></w:body></w:document>`)
  .file("word/footer1.xml", "untouched footer bytes")
  .generateAsync({ type: "nodebuffer" });
const editAt = (start: number, end: number, replace: string) => ({
  find: original.slice(start, end), replace, exact_start: start, exact_end: end,
  context_before: original.slice(0, start), context_after: original.slice(end),
});

// Exercise the package API, including native Word revisions, not the private
// emitter's call structure. Empty text nodes must not hide adjacent styled text.
describe("tracked DOCX run emission", () => {
  it.each([
    [0, 1, "Z"], [1, 5, "XY"], [2, 4, ""], [4, 6, "X"], [6, 8, "🦫"],
    [0, 0, "Z"], [4, 4, "Z"], [10, 10, "Z"], [0, 10, "Z"], [6, 8, ""],
  ] as const)("round-trips [%i, %i) -> %s across run/text-node boundaries", async (start, end, replace) => {
    const edited = await applyTrackedEdits(await packageWith(), [editAt(start, end, replace)]);
    const expected = original.slice(0, start) + replace + original.slice(end);
    expect(edited.errors).toEqual([]);
    expect(edited.changes).toHaveLength(1);
    await expect(extractDocxBodyText(edited.bytes)).resolves.toBe(expected);
    const ids = edited.changes.flatMap(({ delId, insId }) => [delId, insId].filter((id): id is string => !!id));
    for (const mode of ["accept", "reject"] as const) {
      const resolved = await resolveTrackedChange(edited.bytes, ids, mode);
      expect(resolved.found).toBe(true);
      await expect(extractDocxBodyText(resolved.bytes)).resolves.toBe(mode === "accept" ? expected : original);
    }
    const zip = await JSZip.loadAsync(edited.bytes);
    await expect(zip.file("word/footer1.xml")!.async("string")).resolves.toBe("untouched footer bytes");
  });

  it("retains formatting on both unchanged text and deleted slices", async () => {
    const edited = await applyTrackedEdits(await packageWith(), [editAt(1, 5, "XY")]);
    const document = await (await openDocxSession(edited.bytes)).document();
    const [paragraph] = document.paragraphs;
    expect(elName(paragraph.children[0])).toBe("w:pPr");
    expect(elChildren(paragraph.children[0]).map(elName)).toEqual(["w:keepNext"]);
    const runs = paragraph.children.flatMap((child) => {
      const kind = elName(child);
      return (kind === "w:r" ? [child] : kind === "w:ins" || kind === "w:del" ? elChildren(child) : [])
        .map((run) => ({
          kind, text: elChildren(run).filter((node) => ["w:t", "w:delText"].includes(elName(node) ?? "")).map(getTextContent).join(""),
          tags: elChildren(run).map(elName).filter((name) => name !== "w:rPr"),
          style: elChildren(elChildren(run).find((node) => elName(node) === "w:rPr")).map(elName),
        }));
    });
    expect(runs).toEqual([
      { kind: "w:r", text: "a", tags: ["w:t"], style: ["w:b"] },
      { kind: "w:ins", text: "XY", tags: ["w:t"], style: ["w:b"] },
      { kind: "w:del", text: "b", tags: ["w:delText"], style: ["w:b"] },
      { kind: "w:del", text: "cd", tags: ["w:delText"], style: ["w:b"] },
      { kind: "w:del", text: "e", tags: ["w:delText"], style: ["w:i"] },
      { kind: "w:r", text: "f😀", tags: ["w:t"], style: ["w:i"] },
      { kind: "w:r", text: "gh", tags: ["w:t"], style: ["w:i"] },
    ]);
  });

  it.each([[0, "w:b"], [4, "w:i"], [10, "w:i"]] as const)(
    "inherits the right style for an insertion at offset %i", async (position, style) => {
      const edited = await applyTrackedEdits(await packageWith(), [editAt(position, position, "Z")]);
      const document = await (await openDocxSession(edited.bytes)).document();
      const insertion = document.paragraphs[0].children.find((node) => elName(node) === "w:ins");
      const properties = elChildren(elChildren(insertion)[0]).find((node) => elName(node) === "w:rPr");
      expect(elChildren(properties).map(elName)).toEqual([style]);
    },
  );

  it("orders disjoint edits while retaining earlier revisions outside the edited runs", async () => {
    const existing = '<w:del w:id="90"><w:r><w:delText>earlier deletion</w:delText></w:r></w:del>';
    const bytes = await packageWith(existing + content);
    const edited = await applyTrackedEdits(bytes, [editAt(8, 10, "YZ"), editAt(0, 2, "WX")]);
    expect(edited.errors).toEqual([]);
    await expect(extractDocxBodyText(edited.bytes)).resolves.toBe("WXcdef😀YZ");
    const revisions = await (await openDocxSession(edited.bytes)).revisions();
    expect(revisions.changes).toContainEqual({ kind: "del", w_id: "90" });
    const ids = edited.changes.flatMap(({ delId, insId }) => [delId, insId].filter((id): id is string => !!id));
    const rejected = await resolveTrackedChange(edited.bytes, ids, "reject");
    await expect(extractDocxBodyText(rejected.bytes)).resolves.toBe(original);
  });
});
