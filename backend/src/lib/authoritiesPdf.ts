import { ApplicationError } from "./applicationError";

/** Reject unusable input before it can become a draft's source or attachment. */
export async function validateAuthoritiesPdf(bytes: Buffer) {
  const { PDFDocument } = await import("pdf-lib");
  let pageCount;
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    pageCount = document.getPageCount();
  } catch (error) {
    throw new ApplicationError(400, error instanceof Error && /encrypted/iu.test(error.message)
      ? "PDF is encrypted. Save an unencrypted copy, then upload it again."
      : "PDF is invalid or corrupt. Choose a readable PDF.");
  }
  if (!pageCount || pageCount > 2_000)
    throw new ApplicationError(400, "Choose a PDF with between 1 and 2,000 pages.");
}
