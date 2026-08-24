import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";
import type { RequestHandler } from "express";
import multer from "multer";
import { ApplicationError } from "./applicationError";
import { documentFileType } from "./documentTypes";
import { concurrentRequests } from "./requestConcurrency";

const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_SIZE_MB = Math.round(
  MAX_UPLOAD_SIZE_BYTES / (1024 * 1024),
);
const uploadSlot = concurrentRequests(4, "The upload service is busy. Try again shortly.");
const stagedUpload = multer({
  storage: multer.diskStorage({ destination: tmpdir() }),
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
      stagedUpload.single(fieldName)(req, res, (err) => {
        if (!err) {
          if (req.file) {
            const cleanup = () => void unlink(req.file!.path).catch(() => undefined);
            res.once("finish", cleanup).once("close", cleanup);
          }
          next();
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

export function uploadedDocument(file: Express.Multer.File, filename = file.originalname) {
  const type = documentFileType(filename);
  if (!type.ok) throw new ApplicationError(400, type.error);
  return { filename, fileType: type.fileType, path: file.path, sizeBytes: file.size };
}
