import { authorityCitationForms, requiresBilingualSources } from "./authorityPresentation";
import type { AuthoritiesDraft, AuthorityIdentity } from "./types";

/** CanLII names its PDFs by neutral citation (2019abqb666.pdf); browsers add " (1)" to repeats. */
export const CANLII_PDF_NAME = /^(\d{4})([a-z]{2,10})(\d{1,5})(?: ?\(\d+\))?\.pdf$/iu;

const citationKey = (citation: string) => citation.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

/** The authorities still without a PDF, by each citation a CanLII file name could carry. */
function wanted(state: AuthoritiesDraft) {
  const occurrences = Object.values(state.occurrences), byKey = new Map<string, AuthorityIdentity>();
  for (const authority of Object.values(state.authorities)) {
    // A bilingual authority needs a file per language; its files are chosen by hand.
    if (authority.excluded || authority.source.kind === "attached" ||
        requiresBilingualSources(state, authority)) continue;
    for (const citation of authorityCitationForms(authority, occurrences))
      if (citation) byKey.set(citationKey(citation), authority);
  }
  return byKey;
}

/** The newest CanLII-named PDF for each authority that still needs one. */
export function folderMatches(state: AuthoritiesDraft, files: readonly File[]) {
  const byKey = wanted(state), best = new Map<string, { authority: AuthorityIdentity; file: File }>();
  for (const file of files) {
    const match = CANLII_PDF_NAME.exec(file.name);
    const authority = match && byKey.get(citationKey(match.slice(1, 4).join("")));
    if (!authority) continue;
    const current = best.get(authority.id);
    if (!current || file.lastModified > current.file.lastModified) best.set(authority.id, { authority, file });
  }
  return [...best.values()];
}

export const folderFileId = (file: File) => `${file.name}\0${file.size}\0${file.lastModified}`;
