import { decodePdfProfileSelection } from "./documentStore";
import { authorityCitationForms } from "./authoritiesDomain";
import { documentProjectionService } from "./documentProjectionService";
import { docxToPdf, wordToPdfAvailable } from "./convert";
import { AUTHORITIES_BOOK_SLOTS } from "mike/shared/authorities-sources.mjs";
import { reject } from "./applicationError";
import { authoritiesBookFront, authorityPassageTargets, buildAuthorities, prepareAuthorityAnnotations,
  statuteExcerptSummary, type AuthoritiesBuildInput } from "./authoritiesBuild";
import { sourceReadings } from "./sourceReadings";
import { mapAuthorityBookBytes, type PreparedAuthoritiesBook } from "mike/shared/runtime/authoritiesBook.mjs";
import { attachedAuthoritySources, createAuthoritiesDraft, decodeAuthoritiesDraft,
  reduceAuthoritiesDraft, type AuthoritiesDraft } from "./authoritiesDomain";
import { importStandaloneAuthoritiesFile } from "./authoritiesImport";
import { reviewAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";
import { applyAuthoritiesInitialSettings, applyAuthoritiesUserAction, attachAuthorityPdf,
  autoFetchedPdf, attachAuthoritiesBookPdf, authoritiesReview, folderPdfAuthority, readPinpoints } from "./authoritiesActions";
import { validateAuthoritiesPdf } from "./authoritiesPdf";
import { authorityReferenceText, authorityStatuteText, resolveAuthoritiesSources, retryableAuthoritySource,
  type PreparedAuthoritySource } from "./authoritiesSourceResolution";
import { authoritiesSourceText, createAuthoritiesPreparation, prepareAuthoritiesCorrection } from
  "./authoritiesPreparation";
import { sha256 } from "./hash";
import { checkQuotes, decodeQuoteLinks } from "./quoteCheck";
import { decodeAuthoritiesDiscrepancyAction, decodeAuthoritiesInitialSettings,
  decodeAuthoritiesUserAction, decodePdfOpening, text } from "./authoritiesActionContract";

const MAX_BUILD_INPUT_BYTES = 512 * 1024 * 1024;

export function assertAuthoritiesBuildUploadSize(
  files: ReadonlyArray<{ size: number }>,
) {
  if (files.reduce((total, file) => total + file.size, 0) > MAX_BUILD_INPUT_BYTES)
    reject(413, "Authorities build files are too large together. Maximum total is 512 MB.");
}

function draft(value: unknown) {
  return decodeAuthoritiesDraft({ ...(value as object),
    ledger: (value as { ledger?: unknown })?.ledger ?? null }) ??
    reject(400, "Authorities draft is invalid");
}

function json(value: unknown, label: string) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch { return reject(400, `${label} must be JSON`); }
}

function initialSettings(value: unknown) {
  return value === undefined ? undefined : decodeAuthoritiesInitialSettings(
    typeof value === "string" ? json(value, "settings") : value,
  );
}

function attachPreparedSources(state: AuthoritiesDraft, attachments: PreparedAuthoritySource[]) {
  let draft = state;
  for (const attachment of attachments) {
    if (sha256(attachment.bytes) !== attachment.sourceSha256) {
      reject(500, "Prepared authority source hash is invalid");
    }
    draft = attachAuthorityPdf(draft, draft.authorities[attachment.authorityId],
      { kind: "local-file", handleId: `stored:${attachment.sourceSha256}`,
        lastSeen: { name: attachment.filename, size: attachment.bytes.length,
          modified: 0, sha256: attachment.sourceSha256 } },
      attachment.filename, attachment.sourceSha256, attachment.language, attachment);
  }
  return draft;
}


import type { AuthoritiesOperationInput, AuthoritiesRuntimeFile, AuthoritiesRuntimeResult } from "mike/shared/runtime/authoritiesRuntime.mjs";
const sourceBytes = (file: AuthoritiesRuntimeFile) => Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
const value = (data: unknown): AuthoritiesRuntimeResult => ({ data });
const draftResult = (data: AuthoritiesDraft, attachments: PreparedAuthoritySource[]): AuthoritiesRuntimeResult => ({ data, attachments });
const fileResult = (data: unknown, files: Array<{ role: string; mimeType: string; bytes: Uint8Array; filename?: string }>): AuthoritiesRuntimeResult => ({ data, files });
function requiredSource(input: AuthoritiesOperationInput): AuthoritiesRuntimeFile { return input.files?.[0] ?? reject(400, "file is required"); }
async function standaloneSource(input: AuthoritiesOperationInput): Promise<Parameters<typeof importStandaloneAuthoritiesFile>[0]> {
  const file = requiredSource(input), filename = file.filename, extension = filename.split(".").at(-1)?.toLowerCase();
  const fileType = extension === "pdf" || extension === "docx" ? extension : reject(400, "Add a PDF or Word document");
  const modified = Number(input.modified ?? file.modified);
  if (!Number.isSafeInteger(modified) || modified < 0) reject(400, "modified is invalid");
  return { filename, fileType, bytes: sourceBytes(file), modified };
}
type OperationContext = { signal: AbortSignal; progress?: (message: string) => void; quoteProgress?: (value: unknown) => void };
export function createAuthoritiesOperations(resolveSources: typeof resolveAuthoritiesSources = resolveAuthoritiesSources,
  reviewDiscrepancies: typeof reviewAuthoritiesDiscrepancies = reviewAuthoritiesDiscrepancies) {
  const readings = sourceReadings();
  return {
    capabilities: async () => value({ wordToPdf: wordToPdfAvailable() }),
    "quote-check": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
return { data: await checkQuotes(draft(input.draft), decodeQuoteLinks(input.links), context.signal, (completed, total, quote) => context.quoteProgress?.({ completed, total, quote })) };
    },
    "source-text": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const progress = context.progress;
    const state = draft(json(input?.draft, "draft"));
    const role = String(input?.role), bytes = sourceBytes(requiredSource(input));
    const source = Object.values(state.authorities).flatMap(authority =>
      attachedAuthoritySources(authority.source)).find(source => source.bindingRole === role);
    if (!source || sha256(bytes) !== source.sourceSha256)
      return reject(409, "The PDF no longer matches this authority source");
    const pages = input?.pages === undefined ? undefined : json(input.pages, "pages");
    if (pages !== undefined && (!Array.isArray(pages) || !pages.length || pages.length > 1_000 ||
        pages.some(page => !Number.isSafeInteger(page) || page < 1))) reject(400, "Invalid PDF pages");
    const reference = { documentId: `standalone-authority:${source.sourceSha256}`,
      versionId: source.sourceSha256, sourceSha256: source.sourceSha256 };
    if (input?.prepareOnly === "true") {
      // One recognition pass, followed page by page as "recognized/total".
      const prepared = await documentProjectionService.preparePdf({ ...reference, bytes,
        ocrProvider: "kraken-lite", pages, signal: context.signal, ...(progress ? { progress: (value) => {
          if (value.phase === "recognizing") progress(`${value.recognized}/${value.total}`);
        } } : {}) });
      const text = await documentProjectionService.pdfTextLayer(() => bytes, reference,
        {pdfProfile:prepared,signal:context.signal});
      return value({pages:text});
    }
    // Reading a text layer never starts recognition: it restores the source-bound preparation.
    const profile = input?.pdfProfile === undefined ? undefined
      : decodePdfProfileSelection(json(input.pdfProfile, "pdfProfile"));
    if (input?.pdfProfile !== undefined && !profile) return reject(400, "Invalid PDF profile");
    const text = profile ? await documentProjectionService.pdfTextLayer(() => bytes, reference,
      { pdfProfile: profile, signal: context.signal, pages }) : [];
    return value({ pages: text });
    },
    "source-read": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const progress = context.progress;
    const state = draft(json(input?.draft, "draft"));
    const role = String(input?.role), bytes = sourceBytes(requiredSource(input));
    const source = Object.values(state.authorities).flatMap(authority =>
      attachedAuthoritySources(authority.source)).find(source => source.bindingRole === role);
    if (!source || sha256(bytes) !== source.sourceSha256)
      return reject(409, "The PDF no longer matches this authority source");
    await createAuthoritiesPreparation(state, readings).prepareText(role, { bytes, sourceSha256: source.sourceSha256,
      signal: context.signal, ...(progress ? { progress: (done: number, total: number) => progress(`${done}/${total}`) } : {}) });
    return value({});
    },
    "excerpt": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const state = draft(json(input?.draft, "draft"));
    const role = String(input?.role), bytes = sourceBytes(requiredSource(input));
    const authority = Object.values(state.authorities).find(item =>
      attachedAuthoritySources(item.source).some(source => source.bindingRole === role));
    const source = authority && attachedAuthoritySources(authority.source).find(item => item.bindingRole === role);
    if (!authority || !source || sha256(bytes) !== source.sourceSha256)
      return reject(409, "The PDF no longer matches this authority source");
    return value(statuteExcerptSummary(state, authority, source, await authoritiesSourceText(state, readings)(role,
      { bytes, sourceSha256: source.sourceSha256, signal: context.signal })));
    },
    "pinpoints": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const text = String(input?.text ?? ""), start = Number(input?.start), end = Number(input?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || end <= start)
      return reject(400, "Select the pinpoint in this citation's paragraph or footnote");
    return value(readPinpoints(text, start, end).map(({ kind, start, end }) => ({ kind, start, end })));
    },
    "page-labels": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const state = draft(json(input?.draft, "draft"));
    const role = String(input?.bindingRole);
    const authority = Object.values(state.authorities).find(item =>
      attachedAuthoritySources(item.source).some(source => source.bindingRole === role));
    const source = authority && attachedAuthoritySources(authority.source).find(item => item.bindingRole === role);
    if (!authority || !source) return reject(400, "The authority PDF is not attached");
    const bytes = sourceBytes(requiredSource(input));
    if (sha256(bytes) !== source.sourceSha256) return reject(409, "This PDF changed. Relink it before reading page labels.");
    const information = await documentProjectionService.pdfInformation({
      documentId: `standalone-authority:${source.sourceSha256}`, versionId: source.sourceSha256,
      sourceSha256: source.sourceSha256, fileType: "pdf", readBytes: () => bytes,
      reporterOriginal: source.origin === "original",
    }, authorityCitationForms(state, authority.id));
    return value({ ...information, pages: [], pageLabels: information.pageMap.map(page => page.label) });
    },
    "annotations": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const state = draft(json(input?.draft, "draft"));
    const authority = state.authorities[String(input?.authorityId)];
    const source = authority && attachedAuthoritySources(authority.source).find(item =>
      item.bindingRole === input?.bindingRole);
    if (!authority || !source) return reject(400, "The authority PDF is not attached");
    const file = requiredSource(input);
    const bytes = sourceBytes(file);
    if (sha256(bytes) !== source.sourceSha256) return reject(409, "This PDF changed. Relink it before editing highlights.");
    const pdf = await import("pdf-lib");
    const document = await pdf.PDFDocument.load(bytes, { updateMetadata: false });
    if (!document.getPageCount() || document.getPageCount() > 2_000) return reject(400, "Unsupported PDF page count");
    // Manual editing never depends on a successful automatic match. The source is read as a
    // build reads it, so a source read ahead or built is not read again.
    const text = state.settings.passageMarking !== "none" && authorityPassageTargets(state, authority.id).length
      ? await authoritiesSourceText(state, readings)(source.bindingRole,
        { bytes, sourceSha256: source.sourceSha256, signal: context.signal }) : {};
    return value(prepareAuthorityAnnotations(pdf, document, state, authority, source, text, true));
    },
    "create": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    return draftResult( applyAuthoritiesInitialSettings(
      createAuthoritiesDraft({ kind: "manual" }), initialSettings(input?.settings),
    ), []);
    },
    "import": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const settings = initialSettings(input?.settings);
    const imported = await importStandaloneAuthoritiesFile({
      ...await standaloneSource(input), sourceMode: settings?.sourceMode,
    });
    return draftResult( applyAuthoritiesInitialSettings(imported, settings), []);
    },
    "refresh": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const source = await standaloneSource(input);
    const current = draft(json(input?.draft, "draft"));
    const imported = current.import.kind === "document" ? current.import
      : reject(400, "Only an imported document can be refreshed");
    if (input?.replace !== "true" && imported.fileType !== source.fileType)
      reject(400, "The refreshed source type must match the imported document");
    const fresh = await importStandaloneAuthoritiesFile({
      ...source, sourceMode: current.settings.sourceMode,
    });
    const currentInput = current.bindings[imported.bindingRole], freshInput = fresh.bindings.source;
    const currentSource = currentInput?.kind === "local-file" ? currentInput
      : reject(400, "The imported source binding is invalid");
    const freshSource = freshInput?.kind === "local-file" ? freshInput
      : reject(400, "The imported source binding is invalid");
    fresh.bindings.source = { ...freshSource, handleId: currentSource.handleId };
    return draftResult( reduceAuthoritiesDraft(current, { type: "refresh", review: authoritiesReview(fresh) }), []);
    },
    "action": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const current = draft(input?.draft);
    const action = decodeAuthoritiesUserAction(input?.action);
    return draftResult( applyAuthoritiesUserAction(current, action), []);
    },
    "book-front": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const actions = Array.isArray(input?.actions) && input.actions.length <= 3 ? input.actions as unknown[]
      : reject(400, "actions are invalid");
    const state = actions.map(decodeAuthoritiesUserAction).reduce((state, action) => applyAuthoritiesUserAction(state, action),
      draft(input?.draft));
    return fileResult(null, [{ role: "output", mimeType: "application/pdf", bytes: await authoritiesBookFront(state, String(input?.title ?? "").slice(0, 300)) }]);
    },
    "sources": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const progress = context.progress;
    const current = draft(input?.draft);
    const onlyAuthorityId = input?.authorityId === undefined
      ? undefined : text(input.authorityId, 200);
    if (onlyAuthorityId && !retryableAuthoritySource(current, onlyAuthorityId))
      reject(409, "This authority has nothing to retry.");
    const prepared = await resolveSources(current, undefined, context.signal, onlyAuthorityId, progress);
    return draftResult( attachPreparedSources(prepared.draft, prepared.attachments),
      prepared.attachments);
    },
    "discrepancies": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    return value(await reviewDiscrepancies(draft(input?.draft), context.signal));
    },
    "discrepancies/actions": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const current = draft(typeof input?.draft === "string"
      ? json(input.draft, "draft") : input?.draft);
    const action = decodeAuthoritiesDiscrepancyAction(typeof input?.request === "string"
      ? json(input.request, "request") : input?.request);
    const prepared = await prepareAuthoritiesCorrection(current, action, async (imported) => {
      const source = await standaloneSource(input), binding = current.bindings[imported.bindingRole];
      if (source.fileType !== "docx" || binding?.kind !== "local-file" ||
          binding.lastSeen.sha256 !== sha256(source.bytes)) {
        reject(409, "The imported Word document changed. Refresh first.");
      }
      return { ...source, filename: imported.filename };
    }, reviewDiscrepancies, context.signal);
    if (prepared.kind === "ignored") return draftResult( prepared.draft, []);
    const { bytes, draft: decided } = prepared;
    const filename = prepared.source.filename.replace(/(?: corrected)?\.docx$/iu, " corrected.docx");
    const fresh = await importStandaloneAuthoritiesFile({ filename, fileType: "docx", bytes,
      modified: 0, sourceMode: current.settings.sourceMode });
    const state = reduceAuthoritiesDraft(decided, { type: "refresh", review: authoritiesReview(fresh) });
    state.stage = current.stage === "citations" ? "citations" : "sources";
    return fileResult( { draft: state }, [{ role: "source", filename: "source.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes }]);
    },
    "pdf": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const current = draft(json(input?.draft, "draft"));
    const { filename, fileType, bytes, modified } = await standaloneSource(input);
    if (!filename.trim() || filename.length > 500 || /[\u0000-\u001f\u007f]/u.test(filename) ||
        fileType !== "pdf" || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") reject(400, "Add a valid PDF");
    const pageCount = await validateAuthoritiesPdf(bytes);
    const sourceSha256 = sha256(bytes), binding = { kind: "local-file" as const, handleId: "standalone",
      lastSeen: { name: filename, size: bytes.length, modified, sha256: sourceSha256 } };
    if (input?.authority_id !== undefined) {
      const id = input.authority_id, authority = typeof id === "string" && Object.hasOwn(current.authorities, id)
        ? current.authorities[id] : reject(400, "This authority no longer exists.");
      const language = (["en", "fr", "bilingual"] as const).find(value => value === input.language)
        ?? reject(400, "Choose the PDF language.");
      const checked = input.auto_fetched === "true" ? await autoFetchedPdf(current, authority.id, bytes) : current;
      return value(attachAuthorityPdf(checked, checked.authorities[authority.id], binding, filename, sourceSha256, language,
        { pageCount }));
    } else {
      const slot = AUTHORITIES_BOOK_SLOTS.find(value => value === input?.slot)
        ?? reject(400, "Book-part slot is invalid");
      const supplementId = input?.supplement_id;
      if (supplementId !== undefined && (typeof supplementId !== "string" || !supplementId.trim() ||
          supplementId.length > 500)) reject(400, "Book-part ID is invalid");
      return value(attachAuthoritiesBookPdf(current, { slot, supplementId: supplementId as string | undefined }, binding, filename, sourceSha256));
    }
    },
    "pdf-authority": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const current = draft(input?.draft);
    return value({ authorityId: await folderPdfAuthority(current, decodePdfOpening(input),
      (authority) => authorityReferenceText(current, authority)) });
    },
    "build": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const progress = context.progress;
    let raw: unknown, roles: unknown;
    try { raw = json(input?.draft, "draft"); roles = json(input?.roles, "roles"); }
    catch { reject(400, "draft and roles must be JSON"); }
    const state = draft(raw);
    const files = Array.isArray(input.files) ? input.files : [];
    assertAuthoritiesBuildUploadSize(files.map(file => ({ size: file.bytes.length })));
    if (!Array.isArray(roles) || roles.length !== files.length ||
        !roles.every((role) => typeof role === "string" && role.length <= 300))
      reject(400, "Authorities build inputs are invalid");
    const roleNames = roles as string[];
    if (new Set(roleNames).size !== roleNames.length) reject(400, "Duplicate source roles are invalid");
    const id = String(input?.id ?? ""), revision = Number(input?.revision);
    const title = String(input?.title ?? "").trim();
    if (!id || !title || title.length > 300 || !Number.isSafeInteger(revision) || revision < 1)
      reject(400, "Authorities build identity is invalid");
    let preparation: ReturnType<typeof createAuthoritiesPreparation>;
    // Saved highlights for a PDF that was since replaced are the user's to review, not a server fault.
    try { preparation = createAuthoritiesPreparation(state, readings); }
    catch (error) { return reject(409, error instanceof Error ? error.message : "Authorities could not be built"); }
    // Every source is read at once: its preparation waits only on the parsers and recognizers that
    // bound that work (native preparation runs off the event loop), so a scan's pages are queued
    // for recognition from the start, not after the sources before it. The count is of those finished.
    let read = 0;
    progress?.(`Reading sources · 0 of ${files.length}`);
    const sources: NonNullable<AuthoritiesBuildInput["sources"]> = Object.fromEntries(
      await Promise.all(files.map(async (file, index) => {
        const role = roleNames[index], bytes = sourceBytes(file);
        context.signal.throwIfAborted();
        const binding = state.bindings[role];
        const expectedHash = binding?.kind === "local-file" ? binding.lastSeen.sha256
          : binding?.kind === "document" && binding.version !== "latest" ? binding.version.sha256 : null;
        const sourceSha256 = expectedHash && sha256(bytes) === expectedHash ? expectedHash
          : reject(409, "An attached PDF changed. Add the current file before continuing.");
        // Recognizing a scan's pages is the long part of reading one: it reports page by page.
        const recognizing = (done: number, total: number) =>
          progress?.(`Recognizing text in ${file.filename} · ${done} of ${total} page${total === 1 ? "" : "s"}`);
        return [role, { bytes, ...await preparation.prepareText(role, { bytes, sourceSha256,
          signal: context.signal, progress: recognizing })
          .catch((error) => {
            if (context.signal.aborted) throw error;
            return reject(409, error instanceof Error
              ? `Could not read ${file.filename}: ${error.message}`
              : `Could not read ${file.filename}`);
          }).finally(() => progress?.(`Reading sources · ${++read} of ${files.length}`)) }] as const;
      })));
    let book: PreparedAuthoritiesBook | undefined;
    const built = await buildAuthorities({ draft: state, title,
      workProduct: { id, revision }, sources, signal: context.signal, progress,
      statuteText: (authority, signal) => authorityStatuteText(state, authority, undefined, signal),
      ...(wordToPdfAvailable() ? { finalPdfSource: async (bytes: Uint8Array) => docxToPdf(Buffer.from(bytes)) } : {}),
    }, state.settings.finalPdf ? undefined : async (prepared) => {
      book = prepared; return [];
    }).catch((error) => {
      if (context.signal.aborted) throw error;
      return reject(409, error instanceof Error ? error.message : "Authorities could not be built");
    });
    const artifacts = Object.values(built.artifacts).filter((artifact) => artifact !== undefined);
    const bookFiles: Array<{ role: string; mimeType: string; bytes: Buffer }> = [];
    const prepared = book && await mapAuthorityBookBytes(book, (bytes, role) => {
      bookFiles.push({ role, mimeType: "application/pdf", bytes: Buffer.from(bytes) }); return role;
    });
    return fileResult( { receipt: built.receipt, ...(prepared ? { book: prepared } : {}) },
      [...artifacts, ...bookFiles]);
    },
  };
}
