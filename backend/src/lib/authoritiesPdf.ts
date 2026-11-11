import { ApplicationError } from "./applicationError";
import { sha256 } from "./hash";
import { preparePdf } from "./sourceDocument";
import { pdfFailureKind } from "./structureNative";

/** Reject unusable input before it can become a draft's source or attachment: the engine opens it as it reads an
 *  authority's PDF (kept for that reading), refusing one encrypted or corrupt; returns its length. */
export async function validateAuthoritiesPdf(bytes: Buffer) {
  const sourceSha256 = sha256(bytes);
  const { pageCount } = await preparePdf({ documentId: `standalone-authority:${sourceSha256}`, versionId: sourceSha256,
    sourceSha256, bytes, ocrProvider: null }).catch((error: unknown) => {
    const kind = pdfFailureKind(error);
    if (kind === "encrypted") throw new ApplicationError(400, "PDF is encrypted. Save an unencrypted copy, then upload it again.");
    if (kind === "corrupt" || kind === "parser") throw new ApplicationError(400, "PDF is invalid or corrupt. Choose a readable PDF.");
    throw error;
  });
  if (!pageCount || pageCount > 2_000)
    throw new ApplicationError(400, "Choose a PDF with between 1 and 2,000 pages.");
  return pageCount;
}
