import {
  createS3ObjectStorage,
  readOnlyObjectStorage,
  readS3Configuration,
  scopeObjectStorage,
  type ObjectStorage,
  type ReadOnlyObjectStorage,
} from "./storage";

let documents: ObjectStorage | undefined;
let legalCorpus: ReadOnlyObjectStorage | undefined;

function initialize() {
  if (documents && legalCorpus) return;
  const root = createS3ObjectStorage(readS3Configuration());
  documents = scopeObjectStorage(root, "documents");
  legalCorpus = readOnlyObjectStorage(scopeObjectStorage(root, "legal-corpus"));
}

/** Validate cloud object storage before the HTTP server accepts requests. */
export function initializeCloudObjectStorage() {
  initialize();
}

export function cloudDocumentObjects() {
  initialize();
  return documents!;
}

export function cloudLegalCorpusObjects() {
  initialize();
  return legalCorpus!;
}
