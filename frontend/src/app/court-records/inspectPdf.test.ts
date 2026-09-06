import { getPdfJs } from "@/app/lib/pdfJs";
import { describe, expect, it, vi } from "vitest";
import { inspectPdf } from "@/app/lib/inspectPdf";

vi.mock("@/app/lib/pdfJs", () => ({ getPdfJs: vi.fn() }));

describe("court PDF inspection", () => {
  it("reads the PDF page labels used by the viewer", async () => {
    const getPageLabels = vi.fn().mockResolvedValue(["", "i", "1"]);
    const document = {
      numPages: 3,
      getPage: vi.fn().mockResolvedValue({
        getTextContent: vi.fn().mockResolvedValue({
          items: [{ str: "Transcript", hasEOL: false }],
        }),
        cleanup: vi.fn(),
      }),
      getPermissions: vi.fn().mockResolvedValue(null),
      getOutline: vi.fn().mockResolvedValue([]),
      getPageLabels,
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getPdfJs).mockResolvedValue({
      getDocument: () => ({ promise: Promise.resolve(document) }),
    } as unknown as Awaited<ReturnType<typeof getPdfJs>>);

    await expect(inspectPdf(new File(["%PDF"], "transcript.pdf")))
      .resolves.toMatchObject({ pageLabels: ["", "i", "1"] });
    expect(getPageLabels).toHaveBeenCalledOnce();
  });
});
