import path from "node:path";
import { mikeLocalDataHome } from "./legalDataPath";
import { createFilesystemObjectStorage, scopeObjectStorage } from "./storage";

let documents: ReturnType<typeof scopeObjectStorage> | undefined;

export function localDocumentObjects() {
  return documents ??= scopeObjectStorage(
    createFilesystemObjectStorage(path.join(mikeLocalDataHome(), "blobs")),
    "documents",
  );
}
