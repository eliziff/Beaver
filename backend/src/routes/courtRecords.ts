import { Router } from "express";
import { applicationScope, reject } from "../lib/applicationError";
import { asyncRoute } from "../lib/asyncRoute";
import { MAX_COURT_BUILD_OUTPUTS, type CourtRecordsApplication } from
  "../lib/courtRecordsApplication";
import { requireAuth } from "../middleware/auth";
import { multipleFileUpload, requiredFile, requiredUpload, singleFileUpload,
  uploadedDocument } from "../lib/upload";

export function createCourtRecordsRouter(application: CourtRecordsApplication) {
  const router = Router();
  router.use(requireAuth);
  router.post("/documents", singleFileUpload("file"), asyncRoute(async (req, res) => {
    res.status(201).json(await application.saveFile(applicationScope(res), requiredUpload(req),
      textField(req.body?.work_product_id, "work_product_id")));
  }));
  router.post("/builds", multipleFileUpload("files", MAX_COURT_BUILD_OUTPUTS),
    asyncRoute(async (req, res) => {
      const files = Array.isArray(req.files) ? req.files : [];
      const receipts = jsonFields(req.body?.receipts, "receipts");
      if (!files.length || files.length !== receipts.length) {
        reject(400, "Each Court Record output requires one receipt");
      }
      res.json(await application.saveBuild(applicationScope(res), files.map((file, index) => ({
        file: uploadedDocument(file), receipt: receipts[index],
      }))));
    }));
  router.post("/docx-rendition", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const pdf = await application.pdfRendition(requiredUpload(req));
    res.type("application/pdf").send(pdf);
  }));
  router.post("/pdf-preparation", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const file = requiredFile(req);
    let pages: unknown;
    try { pages = JSON.parse(String(req.body?.pages)); }
    catch { reject(400, "pages must be JSON"); }
    res.json(await application.prepareUploadedPdf(uploadedDocument(file), pages));
  }));
  router.get("/documents/:documentId/preparation", asyncRoute(async (req, res) => {
    const versionId = typeof req.query.version_id === "string" && req.query.version_id.trim()
      ? req.query.version_id.trim() : null;
    res.json(await application.preparedPageText(
      applicationScope(res), req.params.documentId, versionId,
    ));
  }));
  return router;
}

function textField(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return reject(400, `${name} must be a string`);
  const text = value.trim();
  if (!text) reject(400, `${name} must be a string`);
  return text;
}

function jsonFields(value: unknown, name: string): unknown[] {
  const values = typeof value === "string" ? [value]
    : Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
  if (!values?.length) return reject(400, `${name} must contain JSON values`);
  return values.map((item) => {
    try { return JSON.parse(item); }
    catch { return reject(400, `${name} must contain JSON values`); }
  });
}
