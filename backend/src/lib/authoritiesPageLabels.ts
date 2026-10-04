import { attachedAuthoritySources, type AttachedAuthoritySource } from "mike/shared/authorities-sources.mjs";
import { reject } from "./applicationError";
import { authorityCitationForms, decodeAuthoritiesDraft, type AuthoritiesDraft } from "./authoritiesDomain";
import { documentProjectionService } from "./documentProjectionService";
import { sha256 } from "./hash";

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

/** The runtime's "source-page-labels": an attached source's printed page numbers, read from its PDF
 *  (the draft, the source's binding role, and the PDF as the one file). */
export async function sourcePageLabelsOperation(input: { draft?: unknown; bindingRole?: unknown;
  files?: Array<{ bytes: Uint8Array }> }) {
  const raw = typeof input.draft === "string" ? JSON.parse(input.draft) as object : input.draft as object;
  const state = decodeAuthoritiesDraft({ ...raw, ledger: (raw as { ledger?: unknown })?.ledger ?? null })
    ?? reject(400, "Authorities draft is invalid");
  const role = String(input.bindingRole);
  const authority = Object.values(state.authorities).find((item) =>
    attachedAuthoritySources(item.source).some((source) => source.bindingRole === role));
  const source = authority && attachedAuthoritySources(authority.source).find((item) => item.bindingRole === role);
  if (!authority || !source) return reject(400, "The authority PDF is not attached");
  const file = input.files?.[0] ?? reject(400, "file is required");
  const bytes = Buffer.from(file.bytes);
  if (sha256(bytes) !== source.sourceSha256) return reject(409, "This PDF changed. Relink it before reading page labels.");
  return { data: { pageLabels: await sourcePageLabels(state, authority.id, source, bytes) } };
}
