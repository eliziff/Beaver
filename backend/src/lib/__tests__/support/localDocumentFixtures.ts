import { createDocumentApplication } from "../../documentApplication";
import type { DocumentProvenance } from "../../documentStore";
import { documentRepository, libraryRepository,
  projectRepository } from "../../relationalRepositories";
import { filesystemDocumentObjects } from "../../filesystemObjectStorage";
import { createLibraryStore } from "../../libraryStore";
import { createProjectStore } from "../../projectStore";

process.env.AUTH_MODE = "local";

const application = () => createDocumentApplication(
  documentRepository, filesystemDocumentObjects(),
);
export const localDocuments = application();
export const localLibraryStore = createLibraryStore(
  libraryRepository, localDocuments,
);
export const localProjects = createProjectStore(projectRepository, localDocuments);

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

export const localDocumentFile = async (
  userId: string, documentId: string, versionId: string | null = null,
) => {
  const file = await localDocuments.read({ userId }, documentId, versionId, false);
  if (!file) return null;
  const { documentProjectionService } = await import("../../documentProjectionService");
  return { ...file, path: await documentProjectionService.publishPdf(
    file.bytes, file.version.source_sha256) };
};
