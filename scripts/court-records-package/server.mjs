import path from "node:path";
import { readFile } from "node:fs/promises";

async function start() {
  const root = __dirname;
  process.env.LEGAL_STRUCTURE_NATIVE ||= path.join(root, "runtime/legal_structure_node.dll");
  process.env.LEGALPDF_ENGINE_ROOT ||= root;
  process.env.MIKE_LOCAL_DATA_DIR ||= path.join(root, "data");
  const [{ default: express }, { prepareCourtRecordPdf }, { docxToPdf },
    { singleFileUpload, uploadedDocument }, { asyncRoute }, { ApplicationError, reject }] =
    await Promise.all([import("express"), import("../../backend/src/lib/courtRecordPdfPreparation.ts"),
      import("../../backend/src/lib/convert.ts"), import("../../backend/src/lib/upload.ts"),
      import("../../backend/src/lib/asyncRoute.ts"), import("../../backend/src/lib/applicationError.ts")]);
  const port = Number(process.env.PORT || 3003);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  const origin = `http://127.0.0.1:${port}`;
  const app = express(); app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin && req.headers.origin !== origin) {
      res.status(403).json({ detail: "This local request was refused" }); return;
    }
    next();
  });
  app.post("/api/court-records/pdf-preparation", singleFileUpload("file"), asyncRoute(async (req, res) => {
    let pages;
    try { pages = JSON.parse(String(req.body?.pages)); } catch { reject(400, "pages must be JSON"); }
    res.json(await prepareCourtRecordPdf(uploadedDocument(req.file ?? reject(400, "file is required")), pages));
  }));
  app.post("/api/court-records/docx-rendition", singleFileUpload("file"), asyncRoute(async (req, res) => {
    const file = uploadedDocument(req.file ?? reject(400, "file is required"));
    if (file.fileType !== "docx") reject(400, "A Word (.docx) file is required");
    res.type("application/pdf").send(await docxToPdf("bytes" in file ? file.bytes : await readFile(file.path)));
  }));
  app.get("/health", (_req, res) => res.json({ status: "ok", app: "court-records" }));
  app.get("/", (_req, res) => res.redirect("/court-records.html"));
  app.use(express.static(path.join(root, "dist")));
  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(error instanceof ApplicationError ? error.status : 500)
      .json({ detail: error instanceof Error ? error.message : "The operation could not be completed" });
  });
  const server = app.listen(port, "127.0.0.1", () => console.log(`Court Records: ${origin}`));
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
start().catch((error) => { console.error(error); process.exitCode = 1; });
