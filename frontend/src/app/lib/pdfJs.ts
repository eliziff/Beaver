let pending: Promise<typeof import("pdfjs-dist")> | null = null;

export function getPdfJs() {
  return pending ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    return lib;
  }).catch((error: unknown) => { pending = null; throw error; });
}
