import {
  createS3ObjectStorage,
  readS3Configuration,
  scopeObjectStorage,
  type ObjectStorage,
} from "./storage";

let documents: ObjectStorage | undefined;

function initialize() {
  if (documents) return;
  const root = createS3ObjectStorage(readS3Configuration());
  documents = scopeObjectStorage(root, "documents");
}

export function s3DocumentObjects() {
  initialize();
  return documents!;
}
