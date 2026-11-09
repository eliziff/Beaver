/** The book of authorities built from a draft: its parts attached, its front drawn, its sources' highlights prepared and
 *  the book built. Only a host that builds the book loads this (authoritiesCore.ts holds what every host shares). */
import { reject } from "./applicationError";
import { attachAuthoritiesBookPdf, applyAuthoritiesUserAction, type AuthoritiesUserAction } from "./authoritiesActions";
import { authoritiesBookFront, authorityPassageTargets, buildAuthorities, prepareAuthorityAnnotations,
  savedAuthoritiesBook, type AuthoritiesBuildInput, type StatuteText } from "./authoritiesBuild";
import type { KeptPdf, SourcePdfReference } from "./authoritiesCore";
import { attachedAuthoritySources, authorityCitationForms, type AuthoritiesDraft } from "./authoritiesDomain";
import { validateAuthoritiesPdf } from "./authoritiesPdf";
import { authoritiesSourceText, createAuthoritiesPreparation } from "./authoritiesPreparation";
import type { AuthoritiesBookSlot } from "mike/shared/authorities-sources.mjs";
import type { PreparedAuthoritiesBook } from "mike/shared/runtime/authoritiesBook.mjs";
import { openDocument, PLAIN_PDF } from "./sourceDocument";
import { structureNative } from "./structureNative";
import type { PdfProfileSelection } from "./documentStore";
import { sha256 } from "./hash";
import { mapBounded } from "./mapBounded";
import type { SourceReadings } from "./sourceReadings";
import type { ResolvedWorkProductInput } from "./workProduct";

/** A PDF for the book itself: its cover, index, brief or a supplement. */
export async function attachBookFile(current: AuthoritiesDraft, input: {
  slot: AuthoritiesBookSlot; supplementId?: string; filename: string; bytes: Buffer; keep: () => Promise<KeptPdf>;
}) {
  await validateAuthoritiesPdf(input.bytes);
  const pdf = await input.keep();
  return attachAuthoritiesBookPdf(current, { slot: input.slot, supplementId: input.supplementId }, pdf.binding,
    pdf.filename ?? input.filename, sha256(input.bytes));
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

/** The draft's outputs, built from the sources the host read. Sources are read in parallel within the native document
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
        return { pageTextByPage: [] as string[] };
      }).finally(() => progress?.(`Reading sources · ${++read} of ${files.length}`));
    // An authority's PDF in the book is placed at its cited printed pages, read from it where its text was not read.
    const attached = authorityOf.get(file.role);
    const pageTargets = attached && !("passageGeometry" in text) && preparation.bookRoles.has(file.role)
      ? authorityPassageTargets(state, attached.authority.id).filter((target) => target.locatorKind === "page") : [];
    const passageGeometry = pageTargets.length ? await openDocument({
      documentId: file.reference?.documentId ?? `standalone-authority:${file.sourceSha256}`,
      versionId: file.reference?.versionId ?? file.sourceSha256, sourceSha256: file.sourceSha256, fileType: "pdf",
      readBytes: () => file.bytes, pdfProfile: file.pdfProfile,
    }, PLAIN_PDF).then((document) => structureNative().pdfPassageGeometry(document, pageTargets,
      authorityCitationForms(state, attached!.authority.id))).catch((error) => {
      if (signal.aborted) throw error;
      return undefined;
    }) : undefined;
    sources[file.role] = { ...(preparation.byteRoles.has(file.role) ? { bytes: file.bytes } : {}),
      ...text, ...(passageGeometry && { passageGeometry }),
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
