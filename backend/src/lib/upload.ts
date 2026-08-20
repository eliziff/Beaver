import type { RequestHandler } from "express";
import multer from "multer";
import { concurrentRequests } from "./requestConcurrency";

const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_SIZE_MB = Math.round(
  MAX_UPLOAD_SIZE_BYTES / (1024 * 1024),
);
const uploadSlot = concurrentRequests(2, "The upload service is busy. Try again shortly.");
const OFFICE_ZIP = /\.(?:docx|xlsx|xlsm|pptx)$/iu;

async function validateOfficeArchive(file?: Express.Multer.File) {
  if (!file || !OFFICE_ZIP.test(file.originalname)) return;
  const { assertBoundedZip, loadZip, readZipEntry, zipReadBudget } = await import("./zip");
  const zip = await loadZip(file.buffer);
  assertBoundedZip(zip, "Office document", {
    maxEntries: 10_000, maxExpandedBytes: 256 * 1024 * 1024,
  });
  const budget = zipReadBudget(256 * 1024 * 1024);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    await readZipEntry(entry, 128 * 1024 * 1024, budget, "Office package part");
  }
}

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
    files: 1,
    fields: 10,
    parts: 11,
    fieldNameSize: 100,
    fieldSize: 1024 * 1024,
  },
});

export function singleFileUpload(fieldName: string): RequestHandler {
  return (req, res, next) => uploadSlot(req, res, () => {
    try {
      memoryUpload.single(fieldName)(req, res, (err) => {
        if (!err) {
          void validateOfficeArchive(req.file).then(() => next()).catch(() =>
            res.status(400).json({ detail: "Office document archive is invalid or too large." }));
          return;
        }

        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return void res.status(413).json({
              detail: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_MB} MB.`,
            });
          }
          return void res.status(400).json({
            detail: `Upload failed: ${err.message}`,
          });
        }

        return next(err);
      });
    } catch (error) {
      next(error);
    }
  });
}
