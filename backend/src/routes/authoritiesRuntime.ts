import { Router, type Request, type RequestHandler, type Response } from "express";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { reject } from "../lib/applicationError";
import { authorityPassageTargets, authoritiesTextRoles, buildAuthorities } from
  "../lib/authoritiesBuild";
import { createAuthoritiesDraft, decodeAuthoritiesDraft,
  reduceAuthoritiesDraft, type AuthoritiesDraft } from "../lib/authoritiesDomain";
import { importStandaloneAuthoritiesFile } from "../lib/authoritiesImport";
import { authorityPdfText } from "../lib/authorityPdfText";
import { reviewAuthoritiesDiscrepancies } from "../lib/authoritiesDiscrepancy";
import { applyAuthoritiesInitialSettings, applyAuthoritiesUserAction,
  resolveAuthoritiesSources, type PreparedAuthoritySource } from
  "../lib/authoritiesWorkspaceApplication";
import { asyncRoute } from "../lib/asyncRoute";
import { sha256 } from "../lib/hash";
import { multipleFileUpload, singleFileUpload } from "../lib/upload";
import { requireAuth } from "../middleware/auth";
import { decodeAuthoritiesInitialSettings, decodeAuthoritiesUserAction } from "./authorities";

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
    const role = `authority:${sha256(draft.authorities[attachment.authorityId].key).slice(0, 24)}`;
    draft = reduceAuthoritiesDraft(draft, { type: "attach-source",
      authorityId: attachment.authorityId, bindingRole: role,
      binding: { kind: "local-file", handleId: `stored:${attachment.sourceSha256}`,
        lastSeen: { name: attachment.filename, size: attachment.bytes.length,
          modified: 0, sha256: attachment.sourceSha256 } },
      filename: attachment.filename, sourceSha256: attachment.sourceSha256,
      sourceUrl: attachment.sourceUrl, origin: attachment.origin });
  }
  return draft;
}

function sendDraft(res: Response, state: AuthoritiesDraft,
  attachments: PreparedAuthoritySource[]) {
  if (!attachments.length) return void res.json(state);
  const boundary = `beaver-${randomUUID()}`;
  res.setHeader("Content-Type", `multipart/form-data; boundary=${boundary}`);
  const part = (headers: string, bytes: Buffer) => {
    res.write(`--${boundary}\r\n${headers}\r\n\r\n`); res.write(bytes); res.write("\r\n");
  };
  part('Content-Disposition: form-data; name="draft"\r\nContent-Type: application/json',
    Buffer.from(JSON.stringify(state)));
  part('Content-Disposition: form-data; name="attachments"\r\nContent-Type: application/json',
    Buffer.from(JSON.stringify(attachments.map((item, index) => ({
      part: `file-${index}`, authorityId: item.authorityId, filename: item.filename,
      sourceSha256: item.sourceSha256,
    })))));
  attachments.forEach((item, index) => part(
    `Content-Disposition: form-data; name="file-${index}"; filename="source.pdf"\r\n` +
      "Content-Type: application/pdf", item.bytes));
  res.end(`--${boundary}--\r\n`);
}

async function resolveDraft(res: Response, initial: AuthoritiesDraft,
  resolveSources: typeof resolveAuthoritiesSources, signal?: AbortSignal) {
  const prepared = await resolveSources(initial, undefined, signal);
  sendDraft(res, attachPreparedSources(prepared.draft, prepared.attachments),
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
) {
  const router = Router(); router.use(authenticate);
  router.post("/create", asyncRoute(async (req, res) => {
    sendDraft(res, applyAuthoritiesInitialSettings(
      createAuthoritiesDraft({ kind: "manual" }), initialSettings(req.body?.settings),
    ), []);
  }));
  router.post("/import", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const settings = initialSettings(req.body?.settings);
    const imported = await importStandaloneAuthoritiesFile({
      ...await standaloneSource(req), sourceMode: settings?.sourceMode,
    });
    sendDraft(res, applyAuthoritiesInitialSettings(imported, settings), []);
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
    sendDraft(res, reduceAuthoritiesDraft(current, { type: "refresh", review: {
      import: fresh.import, bindings: fresh.bindings, units: fresh.units,
      occurrences: fresh.occurrences, authorities: fresh.authorities,
      authorityOrder: fresh.authorityOrder,
    } }), []);
  }));
  router.post("/action", asyncRoute(async (req, res) => {
    const current = draft(req.body?.draft);
    const action = decodeAuthoritiesUserAction(req.body?.action);
    sendDraft(res, applyAuthoritiesUserAction(current, action), []);
  }));
  router.post("/sources", asyncRoute(async (req, res) => {
    const preparation = new AbortController(); res.once("close", () => preparation.abort());
    await resolveDraft(res, draft(req.body?.draft), resolveSources, preparation.signal);
  }));
  router.post("/discrepancies", asyncRoute(async (req, res) => {
    const review = new AbortController(); res.once("close", () => review.abort());
    res.json(await reviewAuthoritiesDiscrepancies(draft(req.body?.draft), review.signal));
  }));
  router.post("/book-part", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const current = draft(json(req.body?.draft, "draft"));
    const file = req.file ?? reject(400, "file is required");
    const slot = (["cover", "index", "supplemental"] as const)
      .find((value) => value === req.body?.slot) ?? reject(400, "Book-part slot is invalid");
    const filename = file.originalname.trim(), modified = Number(req.body?.modified);
    if (!filename || filename.length > 500 || /[\u0000-\u001f\u007f]/u.test(filename) ||
        !/\.pdf$/iu.test(filename) ||
        !Number.isSafeInteger(modified) || modified < 0) reject(400, "Add a PDF file");
    const bytes = await readFile(file.path);
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") reject(400, "Add a valid PDF");
    const sourceSha256 = sha256(bytes), id = slot === "supplemental" ? randomUUID() : slot;
    const existing = slot === "supplemental" ? null : current.bookParts[slot];
    const bindingRole = existing?.bindingRole ?? `book:${slot}:${id}`;
    const binding = { kind: "local-file" as const, handleId: "standalone",
      lastSeen: { name: filename, size: bytes.length, modified, sha256: sourceSha256 } };
    const pdf = { bindingRole, filename, sourceSha256 };
    if (slot !== "supplemental") {
      return void res.json(reduceAuthoritiesDraft(current,
        { type: "set-book-part", slot, pdf, binding }));
    }
    const title = String(req.body?.title ?? "").trim() ||
      filename.replace(/\.pdf$/iu, "").trim() || `Supplement ${current.bookParts.supplements.length + 1}`;
    let tab = String(req.body?.tab ?? "").trim(), number = 1;
    while (!tab && current.bookParts.supplements.some((item) =>
      item.tab.toLocaleLowerCase("en-CA") === `appendix ${number}`.toLocaleLowerCase("en-CA"))) number += 1;
    tab ||= `Appendix ${number}`;
    if (title.length > 500 || tab.length > 80 || /[\u0000-\u001f\u007f]/u.test(title + tab) ||
        current.bookParts.supplements.some((item) =>
          item.tab.toLocaleLowerCase("en-CA") === tab.toLocaleLowerCase("en-CA")))
      reject(400, "Supplement title or tab is invalid");
    res.json(reduceAuthoritiesDraft(current, { type: "set-book-supplement",
      supplement: { ...pdf, id, title, tab }, binding }));
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
        source.kind === "attached" && source.bindingRole === role);
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
    const boundary = `beaver-${randomUUID()}`, chunks: Buffer[] = [];
    const part = (headers: string, bytes: Buffer) => chunks.push(Buffer.from(
      `--${boundary}\r\n${headers}\r\n\r\n`, "utf8"), bytes, Buffer.from("\r\n"));
    part('Content-Disposition: form-data; name="receipt"\r\nContent-Type: application/json',
      Buffer.from(JSON.stringify(built.receipt)));
    for (const artifact of Object.values(built.artifacts)) if (artifact) part(
      `Content-Disposition: form-data; name="${artifact.role}"; filename="output"\r\n` +
      `Content-Type: ${artifact.mimeType}`, artifact.bytes);
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    res.setHeader("Content-Type", `multipart/form-data; boundary=${boundary}`);
    res.send(Buffer.concat(chunks));
  }));
  return router;
}
