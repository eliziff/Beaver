import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { reject } from "../lib/applicationError";
import { buildAuthorities } from "../lib/authoritiesBuild";
import { decodeAuthoritiesDraft, reduceAuthoritiesDraft } from "../lib/authoritiesDomain";
import { importStandaloneAuthoritiesFile } from "../lib/authoritiesImport";
import { authorityPdfOcrText } from "../lib/authorityPdfText";
import { applyAuthoritiesUserAction } from "../lib/authoritiesWorkspaceApplication";
import { asyncRoute } from "../lib/asyncRoute";
import { multipleFileUpload, singleFileUpload } from "../lib/upload";
import { requireAuth } from "../middleware/auth";
import { decodeAuthoritiesUserAction } from "./authorities";

function draft(value: unknown) {
  return decodeAuthoritiesDraft({ ...(value as object),
    ledger: (value as { ledger?: unknown })?.ledger ?? null }) ??
    reject(400, "Authorities draft is invalid");
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

export function createAuthoritiesRuntimeRouter() {
  const router = Router(); router.use(requireAuth);
  router.post("/import", singleFileUpload("file"), asyncRoute(async (req, res) => {
    res.json(await importStandaloneAuthoritiesFile(await standaloneSource(req)));
  }));
  router.post("/refresh", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const source = await standaloneSource(req);
    let raw: unknown;
    try { raw = JSON.parse(String(req.body?.draft)); }
    catch { reject(400, "draft must be JSON"); }
    const current = draft(raw);
    const imported = current.import.kind === "document" ? current.import
      : reject(400, "Only an imported document can be refreshed");
    if (imported.fileType !== source.fileType)
      reject(400, "The refreshed source type must match the imported document");
    const fresh = await importStandaloneAuthoritiesFile(source);
    const currentInput = current.bindings[imported.bindingRole], freshInput = fresh.bindings.source;
    const currentSource = currentInput?.kind === "local-file" ? currentInput
      : reject(400, "The imported source binding is invalid");
    const freshSource = freshInput?.kind === "local-file" ? freshInput
      : reject(400, "The imported source binding is invalid");
    fresh.bindings.source = { ...freshSource, handleId: currentSource.handleId };
    res.json(reduceAuthoritiesDraft(current, { type: "refresh", review: {
      import: fresh.import, bindings: fresh.bindings, units: fresh.units,
      occurrences: fresh.occurrences, authorities: fresh.authorities,
      authorityOrder: fresh.authorityOrder,
    } }));
  }));
  router.post("/action", asyncRoute(async (req, res) => {
    res.json(applyAuthoritiesUserAction(draft(req.body?.draft),
      decodeAuthoritiesUserAction(req.body?.action)));
  }));
  router.post("/build", multipleFileUpload("files", 100), asyncRoute(async (req, res) => {
    let raw: unknown, roles: unknown;
    try { raw = JSON.parse(String(req.body?.draft)); roles = JSON.parse(String(req.body?.roles)); }
    catch { reject(400, "draft and roles must be JSON"); }
    const state = draft(raw);
    const files = Array.isArray(req.files) ? req.files : [];
    if (!Array.isArray(roles) || roles.length !== files.length ||
        !roles.every((role) => typeof role === "string" && role.length <= 300))
      reject(400, "Authorities build inputs are invalid");
    const roleNames = roles as string[];
    const id = String(req.body?.id ?? ""), revision = Number(req.body?.revision);
    const title = String(req.body?.title ?? "").trim();
    if (!id || !title || title.length > 300 || !Number.isSafeInteger(revision) || revision < 1)
      reject(400, "Authorities build identity is invalid");
    const bookRoles = new Set(state.outputMode === "table" ? [] : Object.values(
      state.authorities).flatMap(({ excluded, source }) =>
      !excluded && source.kind === "attached" ? [source.bindingRole] : []));
    const sources: Record<string, { bytes: Buffer; ocrTextByPage?: string[] }> = {};
    for (let index = 0; index < files.length; index += 1) {
      const role = roleNames[index], bytes = await readFile(files[index].path);
      const ocrTextByPage = bookRoles.has(role) ? await authorityPdfOcrText({ bytes }) : [];
      sources[role] = { bytes, ...(ocrTextByPage.some(Boolean) ? { ocrTextByPage } : {}) };
    }
    const built = await buildAuthorities({ draft: state, title,
      workProduct: { id, revision }, sources });
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
