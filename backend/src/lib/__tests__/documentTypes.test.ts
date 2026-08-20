import { describe, expect, it } from "vitest";
import { validateDocumentFile } from "../documentTypes";

describe("document upload signatures", () => {
  it.each([
    ["brief.pdf", Buffer.from("%PDF-1.7\n")],
    ["brief.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ["brief.doc", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
    ["brief.doc", Buffer.from("{\\rtf1")],
  ])("accepts matching %s content", (filename, bytes) => {
    expect(validateDocumentFile(filename, bytes).ok).toBe(true);
  });

  it.each(["pdf", "docx", "xlsx", "pptx", "doc", "xls", "ppt"])(
    "rejects content disguised as %s",
    (extension) => expect(validateDocumentFile(
      `malware.${extension}`, Buffer.from("MZ executable"),
    )).toEqual({ ok: false, error: "Document content does not match its file type." }),
  );

  it("rejects empty files", () => {
    expect(validateDocumentFile("empty.txt", Buffer.alloc(0))).toEqual({
      ok: false, error: "Document is empty.",
    });
  });
});
