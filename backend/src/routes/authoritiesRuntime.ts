import { Router, type Request, type RequestHandler, type Response } from "express";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { reject } from "../lib/applicationError";
import { authorityPassageTargets, buildAuthorities, prepareAuthorityAnnotations, type AuthoritiesBuildInput } from
  "../lib/authoritiesBuild";
import { attachedAuthoritySources, createAuthoritiesDraft, decodeAuthoritiesDraft,
  reduceAuthoritiesDraft, type AuthoritiesDraft } from "../lib/authoritiesDomain";
import { importStandaloneAuthoritiesFile } from "../lib/authoritiesImport";
import { authorityPdfText } from "../lib/authorityPdfText";
import { reviewAuthoritiesDiscrepancies } from "../lib/authoritiesDiscrepancy";
import { applyAuthoritiesInitialSettings, applyAuthoritiesUserAction, attachAuthorityPdf,
  attachAuthoritiesBookPdf, authoritiesReview } from "../lib/authoritiesActions";
import { resolveAuthoritiesSources, type PreparedAuthoritySource } from "../lib/authoritiesSourceResolution";
import { createAuthoritiesPreparation, prepareAuthoritiesCorrection } from "../lib/authoritiesPreparation";
import { asyncRoute } from "../lib/asyncRoute";
import { sha256 } from "../lib/hash";
import { multipleFileUpload, singleFileUpload } from "../lib/upload";
import { checkQuotes, decodeQuoteLinks } from "../lib/quoteCheck";
import { decodeAuthoritiesDiscrepancyAction, decodeAuthoritiesInitialSettings,
  decodeAuthoritiesUserAction } from "../lib/authoritiesActionContract";

const MAX_BUILD_INPUT_BYTES = 512 * 1024 * 1024;

export function assertAuthoritiesBuildUploadSize(
  files: ReadonlyArray<Pick<Express.Multer.File, "size">>,
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
  try { return JSON.parse(String(value)); }
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
      attachment.filename, attachment.sourceSha256, attachment.language,
      attachment.origin, attachment.sourceUrl);
  }
  return draft;
}

function sendMultipart(res: Response, metadata: Record<string, unknown>,
  files: Iterable<{ role: string; mimeType: string; bytes: Buffer; filename?: string }>) {
  const boundary = `beaver-${randomUUID()}`;
  res.setHeader("Content-Type", `multipart/form-data; boundary=${boundary}`);
  return pipeline((function* () {
    for (const [name, value] of Object.entries(metadata)) yield Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n` +
      `Content-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n`);
    for (const file of files) {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; ` +
        `name="${file.role}"; filename="${file.filename ?? "output"}"\r\n` +
        `Content-Type: ${file.mimeType}\r\n\r\n`);
      yield file.bytes;
      yield Buffer.from("\r\n");
    }
    yield Buffer.from(`--${boundary}--\r\n`);
  })(), res);
}

async function sendDraft(res: Response, state: AuthoritiesDraft,
  attachments: PreparedAuthoritySource[]) {
  if (!attachments.length) return void res.json(state);
  await sendMultipart(res, { draft: state, attachments: attachments.map((item, index) => ({
      part: `file-${index}`, authorityId: item.authorityId, filename: item.filename,
      sourceSha256: item.sourceSha256, language: item.language,
    })) }, attachments.map((item, index) => ({ role: `file-${index}`,
      filename: "source.pdf", mimeType: "application/pdf", bytes: item.bytes })));
}

async function resolveDraft(res: Response, initial: AuthoritiesDraft,
  resolveSources: typeof resolveAuthoritiesSources, signal?: AbortSignal) {
  const prepared = await resolveSources(initial, undefined, signal);
  await sendDraft(res, attachPreparedSources(prepared.draft, prepared.attachments),
    prepared.attachments);
}

async function standaloneSource(req: Request): Promise<
  Parameters<typeof importStandaloneAuthoritiesFile>[0]
> {
  const file = req.file ?? reject(400, "file is required");
  const filename = file.originalname, extension = filename.split(".").at(-1)?.toLowerCase();
  const fileType = extension === "pdf" || extension === "docx" ? extension
    : reject(400, "Add a PDF or Word document");
  const modified = Number(req.body?.modified);
  if (!Number.isSafeInteger(modified) || modified < 0) reject(400, "modified is invalid");
  return { filename, fileType, bytes: await readFile(file.path), modified };
}

export function createAuthoritiesRuntimeRouter(
  authenticate: RequestHandler,
  resolveSources: typeof resolveAuthoritiesSources = resolveAuthoritiesSources,
  reviewDiscrepancies: typeof reviewAuthoritiesDiscrepancies = reviewAuthoritiesDiscrepancies,
) {
  const router = Router(); router.use(authenticate);
  router.post("/quote-check", asyncRoute(async (req, res) => {
    const state = draft(req.body?.draft), links = decodeQuoteLinks(req.body?.links);
    if (!req.accepts("text/event-stream") || req.get("accept") !== "text/event-stream") {
      res.json(await checkQuotes(state, links)); return;
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache"); res.flushHeaders();
    try {
      const report = await checkQuotes(state, links, abort.signal, (completed, total, quote) =>
        res.write(`data: ${JSON.stringify({ quote, completed, total })}\n\n`));
      res.write(`data: ${JSON.stringify({ done: true, counts: report.counts })}\n\n`);
    } catch {
      if (!abort.signal.aborted) res.write(`data: ${JSON.stringify({ error: "Checking stopped. Completed receipts are available to download." })}\n\n`);
    } finally { res.end(); }
  }));
  router.post("/annotations", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const state = draft(json(req.body?.draft, "draft"));
    const authority = state.authorities[String(req.body?.authorityId)];
    const source = authority && attachedAuthoritySources(authority.source).find(item =>
      item.bindingRole === req.body?.bindingRole);
    if (!authority || !source) return reject(400, "The authority PDF is not attached");
    const file = req.file ?? reject(400, "file is required");
    const bytes = await readFile(file.path);
    if (sha256(bytes) !== source.sourceSha256) return reject(409, "This PDF changed. Relink it before editing highlights.");
    const abort = new AbortController(); res.on("close", () => abort.abort());
    const pdf = await import("pdf-lib");
    const document = await pdf.PDFDocument.load(bytes, { updateMetadata: false });
    if (!document.getPageCount() || document.getPageCount() > 2_000) return reject(400, "Unsupported PDF page count");
    const targets = authorityPassageTargets(state, authority.id);
    // Manual editing never forces OCR or depends on a successful automatic match.
    const text = state.settings.passageMarking !== "none" && targets.length
      ? await authorityPdfText({ bytes, signal: abort.signal, passageTargets: targets,
          scannedPdfPolicy: state.settings.scannedPdfPolicy }) : {};
    res.json(prepareAuthorityAnnotations(pdf, document, state, authority, source, text, true));
  }));
  router.post("/create", asyncRoute(async (req, res) => {
    await sendDraft(res, applyAuthoritiesInitialSettings(
      createAuthoritiesDraft({ kind: "manual" }), initialSettings(req.body?.settings),
    ), []);
  }));
  router.post("/import", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const settings = initialSettings(req.body?.settings);
    const imported = await importStandaloneAuthoritiesFile({
      ...await standaloneSource(req), sourceMode: settings?.sourceMode,
    });
    await sendDraft(res, applyAuthoritiesInitialSettings(imported, settings), []);
  }));
  router.post("/refresh", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const source = await standaloneSource(req);
    const current = draft(json(req.body?.draft, "draft"));
    const imported = current.import.kind === "document" ? current.import
      : reject(400, "Only an imported document can be refreshed");
    if (req.body?.replace !== "true" && imported.fileType !== source.fileType)
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
    await sendDraft(res, reduceAuthoritiesDraft(current, { type: "refresh", review: authoritiesReview(fresh) }), []);
  }));
  router.post("/action", asyncRoute(async (req, res) => {
    const current = draft(req.body?.draft);
    const action = decodeAuthoritiesUserAction(req.body?.action);
    await sendDraft(res, applyAuthoritiesUserAction(current, action), []);
  }));
  router.post("/sources", asyncRoute(async (req, res) => {
    const preparation = new AbortController(); res.once("close", () => preparation.abort());
    await resolveDraft(res, draft(req.body?.draft), resolveSources, preparation.signal);
  }));
  router.post("/discrepancies", asyncRoute(async (req, res) => {
    const review = new AbortController(); res.once("close", () => review.abort());
    res.json(await reviewDiscrepancies(draft(req.body?.draft), review.signal));
  }));
  router.post("/discrepancies/actions", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const review = new AbortController(); res.once("close", () => review.abort());
    const current = draft(typeof req.body?.draft === "string"
      ? json(req.body.draft, "draft") : req.body?.draft);
    const input = decodeAuthoritiesDiscrepancyAction(typeof req.body?.request === "string"
      ? json(req.body.request, "request") : req.body?.request);
    const prepared = await prepareAuthoritiesCorrection(current, input, async (imported) => {
      const source = await standaloneSource(req), binding = current.bindings[imported.bindingRole];
      if (source.fileType !== "docx" || binding?.kind !== "local-file" ||
          binding.lastSeen.sha256 !== sha256(source.bytes)) {
        reject(409, "The imported Word document changed. Refresh first.");
      }
      return { ...source, filename: imported.filename };
    }, reviewDiscrepancies, review.signal);
    if (prepared.kind === "ignored") return sendDraft(res, prepared.draft, []);
    const { bytes, draft: decided } = prepared;
    const filename = prepared.source.filename.replace(/(?: corrected)?\.docx$/iu, " corrected.docx");
    const fresh = await importStandaloneAuthoritiesFile({ filename, fileType: "docx", bytes,
      modified: 0, sourceMode: current.settings.sourceMode });
    const state = reduceAuthoritiesDraft(decided, { type: "refresh", review: authoritiesReview(fresh) });
    state.stage = current.stage === "citations" ? "citations" : "sources";
    await sendMultipart(res, { draft: state }, [{ role: "source", filename: "source.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes }]);
  }));
  router.post("/book-part", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const current = draft(json(req.body?.draft, "draft"));
    const file = req.file ?? reject(400, "file is required");
    const slot = (["cover", "index", "supplemental"] as const)
      .find((value) => value === req.body?.slot) ?? reject(400, "Book-part slot is invalid");
    const rawSupplementId = req.body?.supplement_id;
    const supplementId = typeof rawSupplementId === "string" && rawSupplementId.trim() &&
      rawSupplementId.trim().length <= 500 ? rawSupplementId.trim()
      : rawSupplementId === undefined ? undefined : reject(400, "Book-part ID is invalid");
    if (supplementId && slot !== "supplemental") reject(400, "Book-part ID is invalid");
    const filename = file.originalname.trim(), modified = Number(req.body?.modified);
    if (!filename || filename.length > 500 || /[\u0000-\u001f\u007f]/u.test(filename) ||
        !/\.pdf$/iu.test(filename) ||
        !Number.isSafeInteger(modified) || modified < 0) reject(400, "Add a PDF file");
    const bytes = await readFile(file.path);
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") reject(400, "Add a valid PDF");
    const sourceSha256 = sha256(bytes);
    const binding = { kind: "local-file" as const, handleId: "standalone",
      lastSeen: { name: filename, size: bytes.length, modified, sha256: sourceSha256 } };
    res.json(attachAuthoritiesBookPdf(current, { slot, supplementId }, binding, filename, sourceSha256));
  }));
  router.post("/build", multipleFileUpload("files", 100), asyncRoute(async (req, res) => {
    const build = new AbortController();
    res.once("close", () => build.abort());
    let raw: unknown, roles: unknown;
    try { raw = JSON.parse(String(req.body?.draft)); roles = JSON.parse(String(req.body?.roles)); }
    catch { reject(400, "draft and roles must be JSON"); }
    const state = draft(raw);
    const files = Array.isArray(req.files) ? req.files : [];
    assertAuthoritiesBuildUploadSize(files);
    if (!Array.isArray(roles) || roles.length !== files.length ||
        !roles.every((role) => typeof role === "string" && role.length <= 300))
      reject(400, "Authorities build inputs are invalid");
    const roleNames = roles as string[];
    if (new Set(roleNames).size !== roleNames.length) reject(400, "Duplicate source roles are invalid");
    const id = String(req.body?.id ?? ""), revision = Number(req.body?.revision);
    const title = String(req.body?.title ?? "").trim();
    if (!id || !title || title.length > 300 || !Number.isSafeInteger(revision) || revision < 1)
      reject(400, "Authorities build identity is invalid");
    const preparation = createAuthoritiesPreparation(state);
    const sources: NonNullable<AuthoritiesBuildInput["sources"]> = {};
    for (let index = 0; index < files.length; index += 1) {
      const role = roleNames[index], bytes = await readFile(files[index].path);
      build.signal.throwIfAborted();
      const binding = state.bindings[role];
      const expectedHash = binding?.kind === "local-file" ? binding.lastSeen.sha256
        : binding?.kind === "document" && binding.version !== "latest" ? binding.version.sha256 : null;
      if (!expectedHash || sha256(bytes) !== expectedHash) reject(409, "An attached PDF changed. Add the current file before continuing.");
      sources[role] = { bytes, ...await preparation.prepareText(role, { bytes, signal: build.signal })
        .catch((error) => {
          if (build.signal.aborted) throw error;
          return reject(409, error instanceof Error
            ? `Could not read ${files[index].originalname}: ${error.message}`
            : `Could not read ${files[index].originalname}`);
        }) };
    }
    const built = await buildAuthorities({ draft: state, title,
      workProduct: { id, revision }, sources, signal: build.signal }).catch((error) => {
      if (build.signal.aborted) throw error;
      return reject(409, error instanceof Error ? error.message : "Authorities could not be built");
    });
    await sendMultipart(res, { receipt: built.receipt },
      Object.values(built.artifacts).filter((artifact) => artifact !== undefined));
  }));
  return router;
}
