/** Authorities' one core. Every host takes a draft through these: Beaver's Library workspace, the standalone runtime
 *  (loopback and Authorities.html) and the apps built from that page. A host supplies only where drafts and files are
 *  kept (a binding, and the stored document a binding is) and whether it recognizes scans in a queue of its own. */
import { reject } from "./applicationError";
import { attachAuthoritiesBookPdf, attachAuthorityPdf, authoritiesReview, authorityPdfCaption,
  applyAuthoritiesUserAction, updateAuthoritiesDraft, type AuthoritiesUserAction } from "./authoritiesActions";
import { authoritiesBookFront, authorityPassageTargets, buildAuthorities, prepareAuthorityAnnotations,
  savedAuthoritiesBook, type AuthoritiesBuildInput, type StatuteText } from "./authoritiesBuild";
import { attachedAuthoritySources, authorityCitationForms, type AuthoritiesDraft,
  type AuthoritySourceLanguage } from "./authoritiesDomain";
import { carriedLinks } from "./authoritiesLinkPropagation";
import { preparedSourcePages, sourcePageLabels, type SourcePdfReference } from "./authoritiesPageLabels";
import { validateAuthoritiesPdf } from "./authoritiesPdf";
import { authoritiesSourceText, createAuthoritiesPreparation } from "./authoritiesPreparation";
import type { PreparedAuthoritySource } from "./authoritiesSourceResolution";
import type { AuthoritiesBookSlot } from "mike/shared/authorities-sources.mjs";
import type { PreparedAuthoritiesBook } from "mike/shared/runtime/authoritiesBook.mjs";
import { documentProjectionService } from "./documentProjectionService";
import type { PdfProfileSelection } from "./documentStore";
import { sha256 } from "./hash";
import { mapBounded } from "./mapBounded";
import type { SourceReadings } from "./sourceReadings";
import type { ResolvedWorkProductInput, WorkProductInput } from "./workProduct";

export type { SourcePdfReference };
/** A PDF as the host keeps it: its binding in the draft, the stored document it is (where the host stores documents)
 *  and the name the host gave it. */
export type KeptPdf = { binding: WorkProductInput; reference?: SourcePdfReference; filename?: string };

/** The sources the draft's authorities resolve to, each fetched PDF kept by the host and attached with its page count
 *  and printed page numbers. Finding sources is no step the user takes: a PDF found, or a case handed to CanLII, would
 *  send a draft past Citations back to Sources as one the user attaches does, so the draft stays at its step. */
export async function gatherAuthoritySources(current: AuthoritiesDraft, options: {
  resolve: (draft: AuthoritiesDraft) => Promise<{ draft: AuthoritiesDraft; attachments: PreparedAuthoritySource[] }>;
  keep: (attachments: readonly PreparedAuthoritySource[]) => Promise<KeptPdf[]>;
  progress?: (message: string) => void; signal?: AbortSignal;
}) {
  const prepared = await options.resolve(current);
  for (const attachment of prepared.attachments) if (sha256(attachment.bytes) !== attachment.sourceSha256) {
    reject(500, "Prepared authority source hash is invalid");
  }
  options.signal?.throwIfAborted();
  const kept = await options.keep(prepared.attachments);
  const keptBy = new Map(prepared.attachments.map((attachment, index) => [attachment, kept[index]!]));
  const pages = await preparedSourcePages(prepared.draft, prepared.attachments, options.progress,
    (attachment) => keptBy.get(attachment)!.reference ?? { documentId: `standalone-authority:${attachment.sourceSha256}`,
      versionId: attachment.sourceSha256 });
  let draft = prepared.draft;
  for (const attachment of prepared.attachments) {
    const pdf = keptBy.get(attachment)!;
    draft = attachAuthorityPdf(draft, draft.authorities[attachment.authorityId], pdf.binding,
      pdf.filename ?? attachment.filename, attachment.sourceSha256, attachment.language,
      { ...attachment, ...pages.get(attachment) });
  }
  return { draft: draft.stage === current.stage ? draft : { ...draft, stage: current.stage },
    attachments: prepared.attachments };
}

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
  const pageLabels = await sourcePageLabels(checked, input.authorityId, { sourceSha256, origin: "manual" },
    input.bytes, pdf.reference);
  return attachAuthorityPdf(checked, checked.authorities[input.authorityId], pdf.binding,
    pdf.filename ?? input.filename, sourceSha256, input.language, { pageCount, pageLabels });
}

/** A PDF for the book itself: its cover, index, brief or a supplement. */
export async function attachBookFile(current: AuthoritiesDraft, input: {
  slot: AuthoritiesBookSlot; supplementId?: string; filename: string; bytes: Buffer; keep: () => Promise<KeptPdf>;
}) {
  await validateAuthoritiesPdf(input.bytes);
  const pdf = await input.keep();
  return attachAuthoritiesBookPdf(current, { slot: input.slot, supplementId: input.supplementId }, pdf.binding,
    pdf.filename ?? input.filename, sha256(input.bytes));
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

/** The book's cover and first index page, drawn with `actions` applied to the draft. */
export async function authoritiesBookFrontPdf(current: AuthoritiesDraft, actions: readonly AuthoritiesUserAction[],
  title: string, excerptPages: Record<string, number> = {}) {
  const state = actions.reduce((state, action) => applyAuthoritiesUserAction(state, action), current);
  return authoritiesBookFront(state, title.slice(0, 300), excerptPages);
}

/** A source's highlights for review, prepared before automatic marks are saved: its passages located as a build locates
 *  them. Manual editing never depends on a successful automatic match. A host that recognizes scans in its own queue
 *  (`recognize: false`) has the source read with the recognition it has kept, never recognized here. */
export async function authorityAnnotations(state: AuthoritiesDraft, input: {
  authorityId: string; bindingRole: string; bytes: Buffer; reference?: SourcePdfReference;
  pdfProfile?: PdfProfileSelection; recognize: boolean; readings?: SourceReadings; signal?: AbortSignal;
}) {
  const authority = state.authorities[input.authorityId];
  const source = authority && attachedAuthoritySources(authority.source).find((item) =>
    item.bindingRole === input.bindingRole);
  if (!authority || !source) return reject(400, "The authority PDF is not attached");
  if (sha256(input.bytes) !== source.sourceSha256) return reject(409, "This PDF changed. Relink it before editing highlights.");
  const pdf = await import("pdf-lib");
  const document = await pdf.PDFDocument.load(input.bytes, { updateMetadata: false, parseSpeed: Infinity });
  if (!document.getPageCount() || document.getPageCount() > 2_000) return reject(400, "Unsupported PDF page count");
  const reading = input.recognize ? state
    : { ...state, settings: { ...state.settings, scannedPdfPolicy: "page-margin" as const } };
  const text = state.settings.passageMarking !== "none" && authorityPassageTargets(state, authority.id).length
    ? await authoritiesSourceText(reading, input.readings)(source.bindingRole, { bytes: input.bytes,
      sourceSha256: source.sourceSha256, ...input.reference, pdfProfile: input.pdfProfile, signal: input.signal }) : {};
  input.signal?.throwIfAborted();
  return prepareAuthorityAnnotations(pdf, document, state, authority, source, text, true);
}

/** A source a build reads, as its host holds it. */
export type AuthoritiesBuildFile = { role: string; filename: string; bytes: Buffer; sourceSha256: string;
  reference?: SourcePdfReference; pdfProfile?: PdfProfileSelection; resolved?: ResolvedWorkProductInput };

/** The draft's outputs, built from the sources the host read. Sources are read in parallel within the projection
 *  working set, so a PDF's text, passages and labels reuse its open document. `prepareBook` hands back the prepared
 *  book for the host to assemble (in a page's worker) in place of assembling it here. */
export async function buildAuthoritiesDraft(state: AuthoritiesDraft, options: {
  title: string; workProduct: { id: string; revision: number }; files: readonly AuthoritiesBuildFile[];
  /** Roles the build names without reading them. */
  unread?: Record<string, ResolvedWorkProductInput>;
  statuteText: StatuteText; finalPdfSource?: AuthoritiesBuildInput["finalPdfSource"];
  readings?: SourceReadings; prepareBook?: boolean; builder?: typeof buildAuthorities;
  signal: AbortSignal; progress?: (message: string) => void;
}) {
  const { signal, progress, files } = options;
  let preparation: ReturnType<typeof createAuthoritiesPreparation>;
  // Saved highlights for a PDF that was since replaced are the user's to review, not a server fault.
  try { preparation = createAuthoritiesPreparation(state, options.readings); }
  catch (error) { return reject(409, error instanceof Error ? error.message : "Authorities could not be built"); }
  const authorityOf = new Map(preparation.authoritySources.map(({ source, authority }) => [source.bindingRole,
    { source, authority }]));
  let read = 0;
  progress?.(`Reading sources · 0 of ${files.length}`);
  const sources: NonNullable<AuthoritiesBuildInput["sources"]> = Object.fromEntries(Object.entries(options.unread ?? {})
    .map(([role, resolved]) => [role, { resolved }]));
  await mapBounded(files, async (file) => {
    signal.throwIfAborted();
    // Recognizing a scan's pages is the long part of reading one: it reports page by page.
    const recognizing = (done: number, total: number) =>
      progress?.(`Recognizing text in ${file.filename} · ${done} of ${total} page${total === 1 ? "" : "s"}`);
    const text = await preparation.prepareText(file.role, { bytes: file.bytes, sourceSha256: file.sourceSha256,
      ...file.reference, pdfProfile: file.pdfProfile, signal, progress: recognizing })
      .catch((error) => {
        if (signal.aborted) throw error;
        // A PDF whose text cannot be read still goes in the book, whole and unmarked: it was attached to be there.
        console.warn("[authorities] source text unread", { filename: file.filename,
          error: error instanceof Error ? error.message : String(error) });
        return { pageTextByPage: [] as string[], pageBindings: undefined };
      }).finally(() => progress?.(`Reading sources · ${++read} of ${files.length}`));
    // An authority's PDF in the book is placed by its printed pages, read from it where its text was not read.
    const attached = authorityOf.get(file.role);
    const pageBindings = text.pageBindings ?? (attached && preparation.bookRoles.has(file.role)
      ? await documentProjectionService.pdfPagination({
        documentId: file.reference?.documentId ?? `standalone-authority:${file.sourceSha256}`,
        versionId: file.reference?.versionId ?? file.sourceSha256, sourceSha256: file.sourceSha256, fileType: "pdf",
        readBytes: () => file.bytes, pdfProfile: file.pdfProfile, reporterOriginal: attached.source.origin === "original",
      }, authorityCitationForms(state, attached.authority.id)).catch((error) => {
        if (signal.aborted) throw error;
        return undefined;
      }) : undefined);
    sources[file.role] = { ...(preparation.byteRoles.has(file.role) ? { bytes: file.bytes } : {}),
      ...text, pageBindings, pageLabels: pageBindings?.map((page) => page.label),
      ...(file.resolved ? { resolved: file.resolved } : {}) };
  });
  let book: PreparedAuthoritiesBook | undefined;
  const built = await (options.builder ?? buildAuthorities)({ draft: state, title: options.title,
    workProduct: options.workProduct, sources, signal, progress, statuteText: options.statuteText,
    ...(options.finalPdfSource ? { finalPdfSource: options.finalPdfSource } : {}),
  }, options.prepareBook && !state.settings.finalPdf
    ? async (prepared) => { book = await savedAuthoritiesBook(prepared); return []; } : undefined)
    .catch((error) => {
      if (signal.aborted) throw error;
      return reject(409, error instanceof Error ? error.message : "Authorities could not be built");
    });
  return { built, book };
}
