import {
  actOnAuthorities, attachAuthorityPdf, buildAuthorities, createAuthorities,
  deleteWorkProduct, directoryResource, downloadDocument, duplicateWorkProduct,
  getAuthorities, listAuthorities, refreshAuthorities, updateWorkProduct,
  uploadAuthoritiesDocument,
} from "@/app/lib/beaverApi";
import type { AuthoritiesProduct } from "./types";
import type { AuthoritiesHost } from "./host";

const library = directoryResource({ library: "files" });

export const beaverAuthoritiesHost: AuthoritiesHost = {
  mode: "beaver", list: listAuthorities, get: getAuthorities,
  async create({ source, title, projectId }) {
    const imported = source.kind === "file"
      ? { kind: "document" as const,
        documentId: (await uploadAuthoritiesDocument(source.selected.file, projectId)).id,
        version: "latest" as const }
      : source.kind === "document"
        ? { kind: "document" as const, documentId: source.document.id,
          version: "latest" as const }
        : source;
    return createAuthorities({ source: imported, title, projectId });
  },
  act: actOnAuthorities, refresh: refreshAuthorities,
  attach: (id, authorityId, revision, selected) =>
    attachAuthorityPdf(id, authorityId, revision, selected.file),
  build: buildAuthorities,
  update: (id, revision, title) => updateWorkProduct(id, { revision, title })
    .then((product) => product as AuthoritiesProduct),
  duplicate: (id, title) => duplicateWorkProduct(id, { title })
    .then((product) => product as AuthoritiesProduct),
  remove: deleteWorkProduct,
  download: (documentId, versionId) =>
    downloadDocument(documentId, versionId).then(({ blob }) => blob),
  async searchLibrary(query) {
    const page = await library.list({ q: query.trim(), limit: 30 });
    return page.items.flatMap((item) => item.kind === "document" ? [item.document] : [])
      .filter((item) => ["pdf", "docx"].includes(item.file_type?.toLowerCase() ?? ""));
  },
};
