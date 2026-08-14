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
          name: "read_document",
          input: {
            doc_id: "doc-0",
            mode: "drafting",
          },
        },
        {
          id: "read-2",
          name: "read_document",
          input: {
            doc_id: "doc-0",
            mode: "drafting",
          },
        },
      ],
      {
        docStore: new Map([
          [
            "doc-0",
            {
              storage_path: "documents/source.docx",
              file_type: "docx",
              filename: "source.docx",
            },
          ],
        ]),
        userId: "user-1",
        db: {} as Parameters<typeof runToolCalls>[1]["db"],
        emit: () => {},
        docIndex: {
          "doc-0": {
            document_id: "document-1",
            filename: "source.docx",
            version_id: "version-1",
            version_number: 1,
          },
        },
        readState: turnReadState,
      },
    );

    expect(mocks.downloadFile).toHaveBeenCalledTimes(2);
    expect(turnReadState.size).toBe(0);
    expect(output.docsRead).toEqual([]);
    expect(
      output.toolResults.map((item) => JSON.parse(item.content)),
    ).toEqual([
      expect.objectContaining({ ok: false }),
      expect.objectContaining({ ok: false }),
    ]);
  });
});
