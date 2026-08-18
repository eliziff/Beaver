import { createDocumentApplication } from "../../documentApplication";
import type { DocumentProvenance } from "../../documentStore";
import { localDocumentRepository } from "../../localDocumentStore";
import { localDocumentObjects } from "../../localObjectStorage";
import { createLocalLibraryStore } from "../../localLibraryStore";
import { createLocalProjectStore } from "../../localProjectStore";

export * from "../../localDocumentStore";

const application = () => createDocumentApplication(
  localDocumentRepository, localDocumentObjects(),
);
export const localDocuments = application();
export const localLibraryStore = createLocalLibraryStore(localDocuments);
export const localProjects = createLocalProjectStore(localDocuments);

export const createLocalDocument = (input: {
  userId: string;
  kind: "file" | "template";
  filename: string;
  bytes: Buffer;
  provenance?: DocumentProvenance;
}) => application().create({ userId: input.userId }, {
  filename: input.filename,
  fileType: input.filename.split(".").pop()?.toLowerCase() ?? "",
  bytes: input.bytes,
  libraryKind: input.kind,
  provenance: input.provenance,
});

export const addLocalVersion = (input: {
  userId: string;
  documentId: string;
  filename: string;
  bytes: Buffer;
}) => application().addVersion({ userId: input.userId }, input.documentId, {
  filename: input.filename,
  fileType: input.filename.split(".").pop()?.toLowerCase() ?? "",
  bytes: input.bytes,
});

export const listLocalVersions = (userId: string, documentId: string) =>
  application().versions({ userId }, documentId);

export const replaceLocalVersion = (input: {
  userId: string;
  documentId: string;
  versionId: string;
  filename: string;
  bytes: Buffer;
}) => application().replaceVersion({ userId: input.userId }, input.documentId,
  input.versionId, {
    filename: input.filename,
    fileType: input.filename.split(".").pop()?.toLowerCase() ?? "",
    bytes: input.bytes,
  }).then((result) => result.status === "replaced" ? result.version : null);

export const deleteLocalDocument = (userId: string, documentId: string) =>
  application().deleteDocument({ userId }, documentId);
