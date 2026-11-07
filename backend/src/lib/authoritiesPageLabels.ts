import type { AttachedAuthoritySource } from "mike/shared/authorities-sources.mjs";
import { authorityCitationForms, type AuthoritiesDraft } from "./authoritiesDomain";
import { documentProjectionService } from "./documentProjectionService";
import { validateAuthoritiesPdf } from "./authoritiesPdf";
import { mapBounded } from "./mapBounded";
import type { PreparedAuthoritySource } from "./authoritiesSourceResolution";

/** The stored document a PDF is, where a host stores it; a standalone PDF is known by its hash alone. */
export type SourcePdfReference = { documentId: string; versionId: string };

/** Each page's printed number ("12", "iv") or null, as the engine reads the PDF (a report's run from the first page its
 *  citations give, where the PDF prints that page). Read once, when the PDF is attached, and kept with the source in
 *  the draft. */
export async function sourcePageLabels(draft: AuthoritiesDraft, authorityId: string,
  source: Pick<AttachedAuthoritySource, "sourceSha256">, bytes: Buffer, reference?: SourcePdfReference) {
  const information = await documentProjectionService.pdfInformation({
    documentId: reference?.documentId ?? `standalone-authority:${source.sourceSha256}`,
    versionId: reference?.versionId ?? source.sourceSha256,
    sourceSha256: source.sourceSha256, fileType: "pdf", readBytes: () => bytes,
  }, authorityCitationForms(draft, authorityId));
  return information.pageMap.map((page) => page.label);
}

/** What every host keeps with a fetched source as it attaches it: its printed page numbers, and its length, by which a
 *  preview of the book counts its pages. Reading the numbers reads the whole PDF, so a few are read at once, and the
 *  step says which it is reading. */
export async function preparedSourcePages<T extends PreparedAuthoritySource>(draft: AuthoritiesDraft,
  attachments: readonly T[], progress?: (message: string) => void,
  reference?: (attachment: T) => SourcePdfReference) {
  const labels = new Map<T, Array<string | null>>();
  let read = 0;
  await mapBounded(attachments, async (attachment) => {
    progress?.(`Reading the page numbers of ${attachment.filename.replace(/\.pdf$/iu, "")} · ${read + 1} of ${attachments.length}`);
    labels.set(attachment, await sourcePageLabels(draft, attachment.authorityId, attachment, attachment.bytes,
      reference?.(attachment)));
    read += 1;
  }, 3);
  const pages = new Map<T, { pageLabels?: Array<string | null>; pageCount: number }>();
  for (const attachment of attachments) {
    const pageLabels = labels.get(attachment);
    pages.set(attachment, { pageLabels, pageCount: attachment.pageCount ?? pageLabels?.length ??
      await validateAuthoritiesPdf(attachment.bytes) });
  }
  return pages;
}
