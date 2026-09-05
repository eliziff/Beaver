import { Router, type Request, type RequestHandler, type Response } from "express";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { reject } from "../lib/applicationError";
import { authorityPassageTargets, authoritiesTextRoles, buildAuthorities } from
  "../lib/authoritiesBuild";
import { attachedAuthoritySources, createAuthoritiesDraft, decodeAuthoritiesDraft,
  reduceAuthoritiesDraft, type AuthoritiesDraft } from "../lib/authoritiesDomain";
import { importStandaloneAuthoritiesFile } from "../lib/authoritiesImport";
import { authorityPdfText } from "../lib/authorityPdfText";
import { authoritiesDiscrepancyCorrection, reviewAuthoritiesDiscrepancies } from
  "../lib/authoritiesDiscrepancy";
import { applyAuthorityDiscrepancyCorrection } from "../lib/docxOperations";
import { applyAuthoritiesInitialSettings, applyAuthoritiesUserAction,
  resolveAuthoritiesSources, type PreparedAuthoritySource } from
  "../lib/authoritiesWorkspaceApplication";
import { asyncRoute } from "../lib/asyncRoute";
import { sha256 } from "../lib/hash";
import { multipleFileUpload, singleFileUpload } from "../lib/upload";
import { requireAuth } from "../middleware/auth";
import { decodeAuthoritiesDiscrepancyAction, decodeAuthoritiesInitialSettings,
  decodeAuthoritiesUserAction } from "./authorities";

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
    const role = `authority:${sha256(draft.authorities[attachment.authorityId].key)
      .slice(0, 24)}:${attachment.language}`;
    draft = reduceAuthoritiesDraft(draft, { type: "attach-source",
      authorityId: attachment.authorityId, bindingRole: role,
      binding: { kind: "local-file", handleId: `stored:${attachment.sourceSha256}`,
        lastSeen: { name: attachment.filename, size: attachment.bytes.length,
          modified: 0, sha256: attachment.sourceSha256 } },
      filename: attachment.filename, sourceSha256: attachment.sourceSha256,
      sourceUrl: attachment.sourceUrl, origin: attachment.origin,
      language: attachment.language });
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
  resolveSources: typeof resolveAuthoritiesSources = resolveAuthoritiesSources,
  authenticate: RequestHandler = requireAuth,
  reviewDiscrepancies: typeof reviewAuthoritiesDiscrepancies = reviewAuthoritiesDiscrepancies,
) {
  const router = Router(); router.use(authenticate);
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
    await sendDraft(res, reduceAuthoritiesDraft(current, { type: "refresh", review: {
      import: fresh.import, bindings: fresh.bindings, cover: fresh.cover, units: fresh.units,
      occurrences: fresh.occurrences, authorities: fresh.authorities,
      authorityOrder: fresh.authorityOrder,
    } }), []);
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
    const finding = (await reviewDiscrepancies(current, review.signal))
      .find(({ id }) => id === input.id) ?? reject(409,
        "This discrepancy is no longer present. Review the document again.");
    if (!finding.actions.includes(input.action))
      reject(400, "That correction is not available for this discrepancy");
    const decided = reduceAuthoritiesDraft(current,
      { type: "resolve-discrepancy", id: finding.id, action: input.action });
    if (input.action === "ignore") return sendDraft(res, decided, []);
    const imported = current.import.kind === "document" && current.import.fileType === "docx"
      ? current.import : reject(409, "Source corrections require an imported Word document");
    const source = await standaloneSource(req), binding = current.bindings[imported.bindingRole];
    if (source.fileType !== "docx" || binding?.kind !== "local-file" ||
        binding.lastSeen.sha256 !== sha256(source.bytes)) {
      reject(409, "The imported Word document changed. Refresh first.");
    }
    const correction = authoritiesDiscrepancyCorrection(current, finding, input.action) ??
      reject(409, "The correction cannot be mapped to the reviewed Word document");
    const bytes = await applyAuthorityDiscrepancyCorrection(source.bytes, current.units, correction)
      .catch((error) => reject(409, error instanceof Error ? error.message
        : "The Word correction could not be applied"));
    review.signal.throwIfAborted();
    const filename = imported.filename.replace(/(?: corrected)?\.docx$/iu, " corrected.docx");
    const fresh = await importStandaloneAuthoritiesFile({ filename, fileType: "docx", bytes,
      modified: 0, sourceMode: current.settings.sourceMode });
    const state = reduceAuthoritiesDraft(decided, { type: "refresh", review: {
      import: fresh.import, bindings: fresh.bindings, cover: fresh.cover, units: fresh.units,
      occurrences: fresh.occurrences, authorities: fresh.authorities,
      authorityOrder: fresh.authorityOrder,
    } });
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
    const sourceSha256 = sha256(bytes), id = slot === "supplemental"
      ? supplementId ?? randomUUID() : slot;
    const existing = slot === "supplemental"
      ? supplementId
        ? current.bookParts.supplements.find((part) => part.id === supplementId) ??
          reject(409, "This book PDF is no longer in the draft")
        : null
      : current.bookParts[slot];
    const bindingRole = existing?.bindingRole ?? `book:${slot}:${id}`;
    const binding = { kind: "local-file" as const, handleId: "standalone",
      lastSeen: { name: filename, size: bytes.length, modified, sha256: sourceSha256 } };
    const pdf = { bindingRole, filename, sourceSha256 };
    res.json(reduceAuthoritiesDraft(current, slot === "supplemental"
      ? { type: "set-book-supplement", supplement: { ...pdf, id }, binding }
      : { type: "set-book-part", slot, pdf, binding }));
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
    const id = String(req.body?.id ?? ""), revision = Number(req.body?.revision);
    const title = String(req.body?.title ?? "").trim();
    if (!id || !title || title.length > 300 || !Number.isSafeInteger(revision) || revision < 1)
      reject(400, "Authorities build identity is invalid");
    const textRoles = authoritiesTextRoles(state);
    const sources: Record<string, { bytes: Buffer; pageTextByPage?: string[];
      ocrTextByPage?: string[]; passageGeometry?: Awaited<ReturnType<typeof authorityPdfText>>["passageGeometry"] }> = {};
    for (let index = 0; index < files.length; index += 1) {
      const role = roleNames[index], bytes = await readFile(files[index].path);
      build.signal.throwIfAborted();
      const authority = Object.values(state.authorities).find(({ source }) =>
        attachedAuthoritySources(source).some(({ bindingRole }) => bindingRole === role));
      const text = textRoles.has(role)
        ? await authorityPdfText({ bytes, signal: build.signal,
          passageTargets: state.settings.passageMarking === "none" || !authority
            ? [] : authorityPassageTargets(state, authority.id) }).catch((error) => {
          if (build.signal.aborted) throw error;
          return reject(409, error instanceof Error
            ? `Could not read ${files[index].originalname}: ${error.message}`
            : `Could not read ${files[index].originalname}`);
        }) : null;
      sources[role] = { bytes,
        ...(text ? { pageTextByPage: text.pageTextByPage } : {}),
        ...(text?.ocrTextByPage.some(Boolean) ? { ocrTextByPage: text.ocrTextByPage } : {}),
        ...(text?.passageGeometry ? { passageGeometry: text.passageGeometry } : {}) };
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
