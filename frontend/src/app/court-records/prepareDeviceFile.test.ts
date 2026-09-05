import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectPdf } from "./inspectPdf";
import { prepareDeviceFile } from "./prepareDeviceFile";

vi.mock("./inspectPdf", () => ({ inspectPdf: vi.fn() }));

describe("device PDF preparation", () => {
  beforeEach(() => vi.mocked(inspectPdf).mockResolvedValue({
    pageCount: 2,
    searchable: true,
    encrypted: false,
    textlessPageCount: 0,
    textlessPages: [],
    sourceBookmarks: [],
    pageLabels: ["", "i", "1"],
    pageTexts: [],
  }));

  it("does not announce healthy inspection work", async () => {
    const progress = vi.fn();
    await expect(prepareDeviceFile(
      new File(["%PDF-1.7"], "record.pdf", { type: "application/pdf" }),
      progress,
    )).resolves.toMatchObject({ searchable: true, encrypted: false,
      pageLabels: ["", "i", "1"] });
    expect(progress).not.toHaveBeenCalled();
    expect(inspectPdf).toHaveBeenCalledWith(expect.any(File));
  });
});
