import { execFile } from "node:child_process";
import path from "node:path";
import { toLlmImage } from "./llm/images";
import type { LlmImage } from "./llm/types";
import { isolatedProcessEnv } from "./subprocessEnv";

export type PdfPageImage = { image: LlmImage; page: number; pageCount: number;
  width: number; height: number };

/** The PDF engine's interpreter, which already carries pypdfium2. */
export const pdfPagePython = () => process.env.BEAVER_PYTHON?.trim() ||
  process.env.LEGALPDF_KRAKEN_PYTHON?.trim() ||
  (process.platform === "win32" ? "python" : "python3");

/** Rasterizes one page so a vision model can read what extraction could not. */
export function renderPdfPage(bytes: Buffer, page: number, filename: string,
  signal?: AbortSignal): Promise<PdfPageImage> {
  return new Promise((resolve, reject) => {
    const child = execFile(pdfPagePython(), ["-B", "-X", "utf8",
      path.resolve(__dirname, "../../scripts/render_pdf_page.py"), String(page)], {
      env: isolatedProcessEnv(), windowsHide: true, timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024, signal,
    }, (error, stdout) => {
      if (error) { reject(new Error("Page rendering failed. Check that Python with pypdfium2 is available.", { cause: error })); return; }
      try {
        const rendered = JSON.parse(stdout) as Record<string, unknown>;
        if (rendered.ok !== true) {
          reject(new Error(rendered.error === "page_out_of_range"
            ? `Page ${page} is outside this document's ${rendered.page_count} pages`
            : "The page could not be rendered"));
          return;
        }
        resolve({
          image: toLlmImage(`${filename} page ${page}.jpg`,
            Buffer.from(String(rendered.jpeg_base64), "base64"), "jpg"),
          page, pageCount: Number(rendered.page_count),
          width: Number(rendered.width), height: Number(rendered.height),
        });
      } catch (failure) { reject(failure); }
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(bytes);
  });
}
