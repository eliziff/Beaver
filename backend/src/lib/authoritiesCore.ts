/** Authorities' one core. Every host takes a draft through these: Beaver's Library workspace, the standalone runtime
 *  (loopback and Authorities.html) and the apps built from that page. A host supplies only where drafts and files are
 *  kept (a binding, and the stored document a binding is) and whether it recognizes scans in a queue of its own. The
 *  book of authorities is built by authoritiesBookCore.ts, and its sources fetched or typeset by authoritiesBookSources.ts,
 *  which an app that builds no book never loads. */
import { reject } from "./applicationError";
import { attachAuthorityPdf, authoritiesReview, authorityPdfCaption, updateAuthoritiesDraft } from "./authoritiesActions";
import type { AuthoritySourceLanguage, AuthoritiesDraft } from "./authoritiesDomain";
import { carriedLinks } from "./authoritiesLinkPropagation";
import { sourcePageLabels, type SourcePdfReference } from "./authoritiesPageLabels";
import { validateAuthoritiesPdf } from "./authoritiesPdf";
import { sha256 } from "./hash";
import type { WorkProductInput } from "./workProduct";

export type { SourcePdfReference };
/** A PDF as the host keeps it: its binding in the draft, the stored document it is (where the host stores documents)
 *  and the name the host gave it. */
export type KeptPdf = { binding: WorkProductInput; reference?: SourcePdfReference; filename?: string };

/** A PDF the user gives an authority: checked as a PDF, its caption read for a different case (auto-fetch never
 *  replaces a PDF), kept by the host, then attached with its page count and printed page numbers. */
export async function attachAuthorityFile(current: AuthoritiesDraft, input: {
  authorityId: string; language: AuthoritySourceLanguage; autoFetched?: boolean; filename: string; bytes: Buffer;
  keep: () => Promise<KeptPdf>;
}) {
  const pageCount = await validateAuthoritiesPdf(input.bytes);
  if (!Object.hasOwn(current.authorities, input.authorityId)) reject(400, "This authority no longer exists.");
  const checked = await authorityPdfCaption(current, input.authorityId, input.bytes, input.autoFetched);
  const pdf = await input.keep(), sourceSha256 = sha256(input.bytes);
  const pageLabels = await sourcePageLabels(checked, input.authorityId, { sourceSha256 },
    input.bytes, pdf.reference);
  return attachAuthorityPdf(checked, checked.authorities[input.authorityId], pdf.binding,
    pdf.filename ?? input.filename, sourceSha256, input.language, { pageCount, pageLabels });
}

/** The draft its brief read afresh gives, keeping what was decided on it: the links given to citations are carried to
 *  the citations they still describe. */
export async function refreshedAuthoritiesDraft(current: AuthoritiesDraft, fresh: AuthoritiesDraft, signal?: AbortSignal) {
  return carriedLinks(current, updateAuthoritiesDraft(current, { type: "refresh", review: authoritiesReview(fresh) }), signal);
}

/** A draft whose Word brief a decided discrepancy corrected, read again from the corrected brief. */
export function correctedAuthoritiesDraft(decided: AuthoritiesDraft, fresh: AuthoritiesDraft,
  stage: AuthoritiesDraft["stage"]) {
  const state = updateAuthoritiesDraft(decided, { type: "refresh", review: authoritiesReview(fresh) });
  state.stage = stage === "citations" ? "citations" : "sources";
  return state;
}

