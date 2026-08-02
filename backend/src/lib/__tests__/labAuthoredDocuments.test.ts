import { describe, expect, it } from "vitest";

import { latestAuthoredDocuments } from "../../../scripts/lab-authored-documents";

describe("latestAuthoredDocuments", () => {
  it("harvests the latest edited version instead of the creation version", () => {
    expect(
      latestAuthoredDocuments([
        {
          type: "doc_created",
          document_id: "doc-1",
          filename: "memo.docx",
          download_url: "/memo?version=1",
        },
        {
          type: "doc_edited",
          document_id: "doc-1",
          filename: "memo.docx",
          download_url: "/memo?version=2",
        },
      ]),
    ).toEqual([
      { filename: "memo.docx", downloadUrl: "/memo?version=2" },
    ]);
  });

  it("includes an edit-only deliverable and ignores incomplete events", () => {
    expect(
      latestAuthoredDocuments([
        { type: "doc_created", filename: "missing.docx" },
        {
          type: "doc_edited",
          document_id: "doc-2",
          filename: "agreement.docx",
          download_url: "/agreement?version=4",
        },
      ]),
    ).toEqual([
      {
        filename: "agreement.docx",
        downloadUrl: "/agreement?version=4",
      },
    ]);
  });
});
