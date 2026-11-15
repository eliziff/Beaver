import type { AttachedAuthoritySource } from "mike/shared/authorities-sources.mjs";
import { authorityCitationForms, type AuthoritiesDraft } from "./authoritiesDomain";
import { openDocument, PLAIN_PDF } from "./sourceDocument";
import { instrumentReading } from "./authorityPdfText";
import { structureNative } from "./structureNative";

/** The stored document a PDF is, where a host stores it; a standalone PDF is known by its hash alone. */
export type SourcePdfReference = { documentId: string; versionId: string };

/** Each page's printed number ("12", "iv") or null, as the engine reads the PDF (a report's run from the first page its
 *  citations give, where the PDF prints that page). Read once, when the PDF is attached, and kept with the source in
 *  the draft. */
export async function sourcePageLabels(draft: AuthoritiesDraft, authorityId: string,
  source: Pick<AttachedAuthoritySource, "sourceSha256">, bytes: Buffer, reference?: SourcePdfReference) {
  const document = await openDocument({
    documentId: reference?.documentId ?? `standalone-authority:${source.sourceSha256}`,
    versionId: reference?.versionId ?? source.sourceSha256,
    sourceSha256: source.sourceSha256, fileType: "pdf", readBytes: () => bytes,
  }, { ...PLAIN_PDF, instrument: instrumentReading(draft.authorities[authorityId]) });
  return structureNative().pdfPageMap(document, authorityCitationForms(draft, authorityId)).map((page) => page.label);
}
