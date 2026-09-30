import { authorityCitationForms, requiresBilingualSources } from "./authorityPresentation";
import type { AuthoritiesDraft, AuthorityIdentity } from "./types";

import { CANLII_PDF_NAME, matchCanliiDownloads } from '../../../../shared/canlii-downloads.mjs';
export { CANLII_PDF_NAME };

/** The authorities still without a PDF, by each citation a CanLII file name could carry. */
export function folderMatches(state: AuthoritiesDraft, files: readonly File[]) {
  const occurrences = Object.values(state.occurrences);
  const candidates: Array<{ record: AuthorityIdentity; citations: string[] }> = [];
  for (const authority of Object.values(state.authorities)) {
    if (authority.excluded || authority.source.kind === "attached" ||
        requiresBilingualSources(state, authority)) continue;
    const citations = authorityCitationForms(authority, occurrences);
    if (authority.source.kind === "pending-canlii") {
      const match = CANLII_PDF_NAME.exec(authority.source.pdfUrl.split("/").at(-1) ?? "");
      if (match) citations.push(match.slice(1, 4).join(" "));
    }
    candidates.push({ record: authority, citations });
  }
  return matchCanliiDownloads(files, candidates).map(({ record, file }) => ({ authority: record, file }));
}

export const folderFileId = (file: File) => `${file.name}\0${file.size}\0${file.lastModified}`;
