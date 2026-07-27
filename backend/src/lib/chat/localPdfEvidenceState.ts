import { getLocalVersionFile } from "../localDocumentStore";
import {
  readLocalPdfEvidenceReceipt,
  rehydrateLocalPdfLinkEvidence,
} from "../localPdfLookup";
import {
  appendLegalSourcePinpointLinks,
  hasLegalSourceQuoteCandidates,
  type AutomaticLegalSourceLink,
} from "../legalSourceLinks";

const MAX_HANDLES_PER_ANSWER = 20;

export async function appendLocalPdfPinpointLinks(
  answer: string,
  userId: string,
  handles: ReadonlySet<string>,
  allowedDocumentIds?: ReadonlySet<string>,
  existingUrls: string[] = [],
) {
  if (!handles.size || !hasLegalSourceQuoteCandidates(answer)) return answer;

  const resolved = new Map<string, AutomaticLegalSourceLink>();
  for (const handle of [...handles].slice(0, MAX_HANDLES_PER_ANSWER)) {
    try {
      const receipt = await readLocalPdfEvidenceReceipt(handle);
      if (
        allowedDocumentIds &&
        !allowedDocumentIds.has(receipt.source.document_id)
      ) {
        continue;
      }
      const file = await getLocalVersionFile(
        userId,
        receipt.source.document_id,
        receipt.source.version_id,
      );
      if (!file || file.fileType.toLowerCase() !== "pdf") continue;

      const linked = await rehydrateLocalPdfLinkEvidence(file.path, handle);
      for (const { pageNumber, evidence } of linked.pages) {
        const key = `${linked.documentId}|${linked.versionId}|page:${pageNumber}`;
        if (!resolved.has(key)) {
          resolved.set(key, {
            key,
            label: `${file.version.filename}, p. ${pageNumber}`,
            evidence,
          });
        }
      }
    } catch {
      // Evidence links are additive; stale or unavailable evidence is omitted.
    }
  }
  return appendLegalSourcePinpointLinks(
    answer,
    [...resolved.values()],
    existingUrls,
  );
}
