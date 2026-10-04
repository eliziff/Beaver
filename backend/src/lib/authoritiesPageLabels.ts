import type { AttachedAuthoritySource } from "mike/shared/authorities-sources.mjs";
import { authorityCitationForms, type AuthoritiesDraft } from "./authoritiesDomain";
import { documentProjectionService } from "./documentProjectionService";

/** Each page's printed number ("12", "iv") or null, as the engine reads the PDF: for a reporter's
 *  original, from the first page its citations give. Read once, when the PDF is attached, and kept
 *  with the source in the draft. */
export async function sourcePageLabels(draft: AuthoritiesDraft, authorityId: string,
  source: Pick<AttachedAuthoritySource, "sourceSha256" | "origin">, bytes: Buffer) {
  const information = await documentProjectionService.pdfInformation({
    documentId: `standalone-authority:${source.sourceSha256}`, versionId: source.sourceSha256,
    sourceSha256: source.sourceSha256, fileType: "pdf", readBytes: () => bytes,
    reporterOriginal: source.origin === "original",
  }, authorityCitationForms(draft, authorityId));
  return information.pageMap.map((page) => page.label);
}
