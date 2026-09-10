import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pdfPagePython, renderPdfPage } from "../pdfPageImage";

const available = () => {
  try {
    execFileSync(pdfPagePython(), ["-c", "import pypdfium2"], { stdio: "ignore" });
    return true;
  } catch { return false; }
};

describe.skipIf(!available())("PDF page rendering", () => {
  it("renders a real page small enough to send and refuses one past the end", async () => {
    const bytes = await readFile(path.resolve(process.cwd(), "../e2e/fixtures/test.pdf"));
    const rendered = await renderPdfPage(bytes, 1, "test.pdf");

    expect(rendered).toMatchObject({ page: 1, pageCount: expect.any(Number) });
    expect(rendered.width).toBeGreaterThan(400);
    expect(rendered.image.mimeType).toBe("image/jpeg");
    expect(Buffer.from(rendered.image.data, "base64").byteLength).toBeLessThan(1_500_000);
    await expect(renderPdfPage(bytes, 99, "test.pdf")).rejects.toThrow(/outside/u);
  }, 60_000);
});
