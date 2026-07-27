import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  loadActiveVersion: vi.fn(),
}));

vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  downloadFile: mocks.downloadFile,
}));

vi.mock("../documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../documentVersions")>()),
  loadActiveVersion: mocks.loadActiveVersion,
}));

import { runToolCalls } from "../chat/tools/toolDispatcher";

describe("drafting read state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.downloadFile.mockResolvedValue(Buffer.from("not a docx"));
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: "documents/source.docx",
      pdf_storage_path: null,
      version_number: 1,
      filename: "source.docx",
      source: "upload",
      file_type: "docx",
      size_bytes: 10,
      page_count: null,
    });
  });

  it("does not cache a failed drafting read as a successful duplicate", async () => {
    const turnReadState = new Map();
    const output = await runToolCalls(
      [
        {
          id: "read-1",
          function: {
            name: "read_document",
            arguments: JSON.stringify({
              doc_id: "doc-0",
              mode: "drafting",
            }),
          },
        },
        {
          id: "read-2",
          function: {
            name: "read_document",
            arguments: JSON.stringify({
              doc_id: "doc-0",
              mode: "drafting",
            }),
          },
        },
      ],
      new Map([
        [
          "doc-0",
          {
            storage_path: "documents/source.docx",
            file_type: "docx",
            filename: "source.docx",
          },
        ],
      ]),
      "user-1",
      {} as Parameters<typeof runToolCalls>[3],
      () => {},
      undefined,
      undefined,
      {
        "doc-0": {
          document_id: "document-1",
          filename: "source.docx",
          version_id: "version-1",
          version_number: 1,
        },
      },
      undefined,
      turnReadState,
    );

    expect(mocks.downloadFile).toHaveBeenCalledTimes(2);
    expect(turnReadState.size).toBe(0);
    expect(output.docsRead).toEqual([]);
    expect(
      output.toolResults.map((item) =>
        JSON.parse((item as { content: string }).content),
      ),
    ).toEqual([
      expect.objectContaining({ ok: false }),
      expect.objectContaining({ ok: false }),
    ]);
  });
});
