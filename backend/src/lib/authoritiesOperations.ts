import { decodePdfProfileSelection } from "./documentStore";
import { authorityCitationForms } from "./authoritiesDomain";
import { documentProjectionService } from "./documentProjectionService";
import { docxToPdf, wordToPdfAvailable } from "./convert";
import { AUTHORITIES_BOOK_SLOTS } from "mike/shared/authorities-sources.mjs";
import { reject } from "./applicationError";
import { excerptPageCounts, statuteExcerptSummary } from "./authoritiesBuild";
import { sourceReadings } from "./sourceReadings";
import { mapAuthorityBookBytes } from "mike/shared/runtime/authoritiesBook.mjs";
import { attachedAuthoritySources, createAuthoritiesDraft, decodeAuthoritiesDraft,
  type AuthoritiesDraft } from "./authoritiesDomain";
import { importStandaloneAuthoritiesFile } from "./authoritiesImport";
import { reviewAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";
import { applyAuthoritiesInitialSettings, applyAuthoritiesUserAction, folderPdfAuthority,
  readPinpoints } from "./authoritiesActions";
import { authorityReferenceText, authorityStatuteText, resolveAuthoritiesSources,
  type PreparedAuthoritySource } from "./authoritiesSourceResolution";
import { authoritiesSourceText, createAuthoritiesPreparation, prepareAuthoritiesCorrection } from
  "./authoritiesPreparation";
import { attachAuthorityFile, attachBookFile, authoritiesBookFrontPdf, authorityAnnotations, buildAuthoritiesDraft,
  correctedAuthoritiesDraft, gatherAuthoritySources, refreshedAuthoritiesDraft, type KeptPdf } from "./authoritiesCore";
import { sha256 } from "./hash";
import { decodeQuoteLinks } from "./quoteCheck";
import { attachedSourceDocuments, verificationResults, verifyQuotations, writeVerifiedWordCopy,
  type QuoteVerification } from "./quoteVerification/verifier";
import type { AlrModel, AlrWorkbookOptions } from "./quoteVerification/checkedWorkbook";
import type { WordCitation, WordCopy, WordResult } from "./quoteVerification/wordResult";
import { linkPropagationTargets } from "./authoritiesLinkPropagation";
import { withSqliteRun } from "./legalDataPath";
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

/** The page keeps every PDF it is handed; here a PDF is known by its hash until the page binds its kept copy. */
const keptByPage = (filename: string, bytes: Uint8Array, sourceSha256: string, handleId: string): KeptPdf => ({
  binding: { kind: "local-file", handleId, lastSeen: { name: filename, size: bytes.length, modified: 0, sha256: sourceSha256 } } });


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
/** Each operation reads the local stores through handles it keeps until it ends (legalDataPath.ts withSqliteRun). */
function inRuns<T extends Record<string, (...args: any[]) => Promise<unknown>>>(operations: T): T {
  return Object.fromEntries(Object.entries(operations).map(([name, operation]) =>
    [name, (...args: unknown[]) => withSqliteRun(() => operation(...args))])) as T;
}
type OperationContext = { signal: AbortSignal; progress?: (message: string) => void; quoteProgress?: (value: unknown) => void };
/** An app's AI run mode for the verifier, from the request it was sent (an app that connects models supplies one). */
export type VerifierModel = (request: unknown, progress: (message: string) => void) =>
  { model: AlrModel; stats: unknown } | null;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export function createAuthoritiesOperations(resolveSources: typeof resolveAuthoritiesSources = resolveAuthoritiesSources,
  reviewDiscrepancies: typeof reviewAuthoritiesDiscrepancies = reviewAuthoritiesDiscrepancies,
  verifierModel: VerifierModel = () => null) {
  const readings = sourceReadings();
  return inRuns({
    capabilities: async () => value({ wordToPdf: wordToPdfAvailable() }),
    "quote-check": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const state = draft(json(input.draft, "draft")), files = input.files ?? [];
      const roles = json(input.roles ?? "[]", "roles");
      if (!Array.isArray(roles) || roles.length !== files.length) reject(400, "Each attached PDF needs its source role");
      const asked = json(input.excludedProviders ?? "[]", "excludedProviders");
      if (!Array.isArray(asked)) reject(400, "excludedProviders must be a list");
      // The verifier's check: each option a caller leaves out is the verifier's own (quoteVerification/verifier.ts).
      return { data: await verifyQuotations(state, { links: decodeQuoteLinks(input.links), signal: context.signal,
        attached: await attachedSourceDocuments(state, files.map((file, index) => ({ role: String(roles[index]), bytes: file.bytes })),
          context.signal, true),
        excludedProviders: (asked as unknown[]).map(String),
        ...(input.discoverPdfs === true ? { discoverPdfs: true } : {}),
        ...(input.allCitations === false ? { allCitations: false } : {}),
        quoteContext: input.quoteContext === "sentence" ? "sentence" : "passage",
        ...(input.quotations === "text" ? { quotations: "text" as const } : {}),
        compare: input.compare !== false,
        progress: (completed, total, quote) => context.quoteProgress?.({ completed, total, quote }) }) };
    },
    // A check's "[CHECKED]" workbook, in free mode or the app's AI run mode, and its results on the document's text.
    // The PDFs attached for authorities (`sources`, each with its role; one that no longer matches is left out) give a
    // decision's pinpointed link its passage.
    "verify-workbook": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const state = draft(input.draft);
      if (state.import.kind !== "document") reject(400, "The draft has no imported document.");
      const citation = input.wordCitation ?? "first";
      if (citation !== "first" && citation !== "best") reject(400, "Invalid Word citation choice.");
      const run = verifierModel(input.model, (message) => context.progress?.(message));
      const written = await verificationResults(state.import.kind === "document" ? state.import.filename : "document",
        state, input.check as QuoteVerification, { options: (input.options ?? {}) as AlrWorkbookOptions, model: run?.model,
          attached: await attachedSourceDocuments(state, (input.sources ?? []) as Array<{ role: string; bytes: Uint8Array }>,
            context.signal),
          wordCitation: citation as WordCitation, signal: context.signal, progress: (message) => context.progress?.(message) });
      return { data: { references: written.references, ...run ? { model: run.stats } : {} }, files: [
        { role: "workbook", filename: written.name, mimeType: XLSX, bytes: written.workbook },
        { role: "word", filename: "word.json", mimeType: "application/json", bytes: new TextEncoder().encode(JSON.stringify(written.word)) },
        ...written.sidecar ? [{ role: "sidecar", filename: written.sidecar.name, mimeType: "application/json",
          bytes: new TextEncoder().encode(JSON.stringify(written.sidecar.value, null, 2)) }] : []] };
    },
    // The draft's Word document (unchanged since its import) with a check's results written into it as `copy` says.
    "verify-docx": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const state = draft(input.draft), file = requiredSource(input);
      const written = await writeVerifiedWordCopy(state, sourceBytes(file), input.word as WordResult, input.copy as WordCopy,
        typeof input.author === "string" && input.author.trim() ? input.author.trim().slice(0, 100) : "Beaver");
      return fileResult({ writes: written.writes, written: written.written }, [{ role: "docx",
        filename: state.import.kind === "document" ? state.import.filename : file.filename, mimeType: DOCX, bytes: written.bytes }]);
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
        ocrProvider: "indra", pages, signal: context.signal, ...(progress ? { progress: (value) => {
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
    "pinpoints": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> =>
      value(readPinpoints(input?.text, input?.start, input?.end)),
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
    // The source is read as a build reads it, so a source read ahead or built is not read again; the page has no
    // recognition queue of its own, so reading it recognizes what the draft's scan setting asks for.
    "annotations": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> =>
      value(await authorityAnnotations(draft(json(input?.draft, "draft")), { authorityId: String(input?.authorityId),
        bindingRole: String(input?.bindingRole), bytes: sourceBytes(requiredSource(input)), recognize: true, readings,
        signal: context.signal })),
    "create": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    return draftResult( applyAuthoritiesInitialSettings(
      createAuthoritiesDraft({ kind: "manual" }), initialSettings(input?.settings),
    ), []);
    },
    "import": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const settings = initialSettings(input?.settings);
    const imported = await importStandaloneAuthoritiesFile({
      ...await standaloneSource(input), sourceMode: settings?.sourceMode, supraLinking: settings?.supraLinking,
    });
    return draftResult( applyAuthoritiesInitialSettings(imported, settings), []);
    },
    "refresh": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const source = await standaloneSource(input);
    const current = draft(json(input?.draft, "draft"));
    const imported = current.import.kind === "document" ? current.import
      : reject(400, "Only an imported document can be refreshed");
    if (input?.replace !== "true" && imported.fileType !== source.fileType)
      reject(400, "The refreshed source type must match the imported document");
    const fresh = await importStandaloneAuthoritiesFile({
      ...source, sourceMode: current.settings.sourceMode, supraLinking: current.settings.supraLinking,
    });
    const currentInput = current.bindings[imported.bindingRole], freshInput = fresh.bindings.source;
    const currentSource = currentInput?.kind === "local-file" ? currentInput
      : reject(400, "The imported source binding is invalid");
    const freshSource = freshInput?.kind === "local-file" ? freshInput
      : reject(400, "The imported source binding is invalid");
    fresh.bindings.source = { ...freshSource, handleId: currentSource.handleId };
    return draftResult(await refreshedAuthoritiesDraft(current, fresh, context.signal), []);
    },
    "action": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const current = draft(input?.draft);
    const action = decodeAuthoritiesUserAction(input?.action);
    return draftResult( applyAuthoritiesUserAction(current, action), []);
    },
    "book-front": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const actions = Array.isArray(input?.actions) && input.actions.length <= 3 ? input.actions as unknown[]
      : reject(400, "actions are invalid");
    // The pages each excerpted authority keeps, as "excerpt-pages" counted them in the runtime that reads sources.
    const counted = input?.excerptPages === undefined ? {} : typeof input.excerptPages === "string"
      ? json(input.excerptPages, "excerptPages") : input.excerptPages;
    const excerptPages = counted && typeof counted === "object" && Object.values(counted).every((pages) =>
      Number.isSafeInteger(pages) && (pages as number) > 0) ? counted as Record<string, number> : reject(400, "excerptPages is invalid");
    return fileResult(null, [{ role: "output", mimeType: "application/pdf",
      bytes: await authoritiesBookFrontPdf(draft(input?.draft), actions.map(decodeAuthoritiesUserAction),
        String(input?.title ?? ""), excerptPages) }]);
    },
    // An excerpt's pages for the index preview, one PDF at a time: the PDF given is read as a build reads
    // it (a build then finds it read), and its authority's pages counted once all its PDFs are read.
    "excerpt-pages": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const state = draft(json(input?.draft, "draft"));
    const role = String(input?.role), bytes = sourceBytes(requiredSource(input));
    const authority = Object.values(state.authorities).find(item =>
      attachedAuthoritySources(item.source).some(source => source.bindingRole === role));
    const source = authority && attachedAuthoritySources(authority.source).find(item => item.bindingRole === role);
    if (!authority || !source || sha256(bytes) !== source.sourceSha256)
      return reject(409, "The PDF no longer matches this authority source");
    const read = authoritiesSourceText(state, readings);
    const own = await read(role, { bytes, sourceSha256: source.sourceSha256, signal: context.signal });
    const counts = await excerptPageCounts(state, async (item) => item.bindingRole === role ? own : read(item.bindingRole,
      { sourceSha256: item.sourceSha256, signal: context.signal } as Parameters<typeof read>[1]).catch(() => null), authority.id);
    return value({ authorityId: authority.id, pages: counts[authority.id] ?? null });
    },
    "sources": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
      const progress = context.progress;
    const current = draft(input?.draft);
    const onlyAuthorityId = input?.authorityId === undefined
      ? undefined : text(input.authorityId, 200);
    const gathered = await gatherAuthoritySources(current, { progress, signal: context.signal,
      resolve: (state) => resolveSources(state, undefined, context.signal, onlyAuthorityId, progress, input?.keptOnly === true),
      keep: async (attachments) => attachments.map(({ filename, bytes, sourceSha256 }) =>
        keptByPage(filename, bytes, sourceSha256, `stored:${sourceSha256}`)) });
    return draftResult(gathered.draft, gathered.attachments);
    },
    // The other citations of a citation's authority that a link given to it would carry to (authoritiesLinkPropagation.ts).
    "link-propagation": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> =>
      value(await linkPropagationTargets(draft(input?.draft), text(input?.occurrenceId), text(input?.url, 8192), context.signal)),
    // The findings as data: the passage each was read from stays with the engine that read it.
    "discrepancies": async (input: AuthoritiesOperationInput, context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    return value((await reviewDiscrepancies(draft(input?.draft), context.signal)).map(({ citedPassage: _, ...finding }) => finding));
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
      modified: 0, sourceMode: current.settings.sourceMode, supraLinking: current.settings.supraLinking });
    const state = correctedAuthoritiesDraft(decided, fresh, current.stage);
    return fileResult( { draft: state }, [{ role: "source", filename: "source.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes }]);
    },
    "pdf": async (input: AuthoritiesOperationInput, _context: OperationContext): Promise<AuthoritiesRuntimeResult> => {
    const current = draft(json(input?.draft, "draft"));
    const { filename, fileType, bytes, modified } = await standaloneSource(input);
    if (!filename.trim() || filename.length > 500 || /[\u0000-\u001f\u007f]/u.test(filename) ||
        fileType !== "pdf" || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") reject(400, "Add a valid PDF");
    const keep = async () => ({ binding: { kind: "local-file" as const, handleId: "standalone",
      lastSeen: { name: filename, size: bytes.length, modified, sha256: sha256(bytes) } } });
    if (input?.authority_id !== undefined) {
      const authorityId = typeof input.authority_id === "string" ? input.authority_id
        : reject(400, "This authority no longer exists.");
      const language = (["en", "fr", "bilingual"] as const).find(value => value === input.language)
        ?? reject(400, "Choose the PDF language.");
      return value(await attachAuthorityFile(current, { authorityId, language, autoFetched: input.auto_fetched === "true",
        filename, bytes, keep }));
    }
    const slot = AUTHORITIES_BOOK_SLOTS.find(value => value === input?.slot)
      ?? reject(400, "Book-part slot is invalid");
    const supplementId = input?.supplement_id;
    if (supplementId !== undefined && (typeof supplementId !== "string" || !supplementId.trim() ||
        supplementId.length > 500)) reject(400, "Book-part ID is invalid");
    return value(await attachBookFile(current, { slot, supplementId: supplementId as string | undefined,
      filename, bytes, keep }));
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
    const buildFiles = files.map((file, index) => {
      const role = roleNames[index], bytes = sourceBytes(file), binding = state.bindings[role];
      const expectedHash = binding?.kind === "local-file" ? binding.lastSeen.sha256
        : binding?.kind === "document" && binding.version !== "latest" ? binding.version.sha256 : null;
      const sourceSha256 = expectedHash && sha256(bytes) === expectedHash ? expectedHash
        : reject(409, "An attached PDF changed. Add the current file before continuing.");
      return { role, filename: file.filename, bytes, sourceSha256 };
    });
    // A page assembles the book in its own worker; only a final PDF is assembled here.
    const { built, book } = await buildAuthoritiesDraft(state, { title, workProduct: { id, revision }, files: buildFiles,
      readings, prepareBook: true, signal: context.signal, progress,
      statuteText: (authority, signal) => authorityStatuteText(state, authority, undefined, signal),
      ...(wordToPdfAvailable() ? { finalPdfSource: async (bytes: Uint8Array) => docxToPdf(Buffer.from(bytes)) } : {}) });
    const artifacts = Object.values(built.artifacts).filter((artifact) => artifact !== undefined);
    const bookFiles: Array<{ role: string; mimeType: string; bytes: Buffer }> = [];
    const prepared = book && await mapAuthorityBookBytes(book, (bytes, role) => {
      bookFiles.push({ role, mimeType: "application/pdf", bytes: Buffer.from(bytes) }); return role;
    });
    return fileResult( { receipt: built.receipt, ...(prepared ? { book: prepared } : {}) },
      [...artifacts, ...bookFiles]);
    },
  });
}
