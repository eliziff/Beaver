import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { openDocxSession } from "../docx/session";

const packageWith = (xml: string) => new JSZip()
  .file("word/document.xml", xml)
  .generateAsync({ type: "nodebuffer" });

describe("DOCX XML safety", () => {
  it("rejects DTD entities before parsing an untrusted package", async () => {
    const bytes = await packageWith(`<!DOCTYPE w:document [
      <!ENTITY repeated "expanded">
    ]><w:document><w:body><w:p><w:r><w:t>&repeated;</w:t></w:r></w:p></w:body></w:document>`);
    const session = await openDocxSession(bytes);
    await expect(session.document()).rejects.toThrow("DOCTYPE");
  });
});
