import {
  actOnAuthorities, attachAuthorityPdf, buildAuthorities, createAuthorities,
  createWorkProduct, deleteWorkProduct, directoryResource, downloadDocument,
  duplicateWorkProduct, getWorkProduct, listWorkProducts, refreshAuthorities,
  updateWorkProduct, uploadAuthoritiesDocument,
} from "@/app/lib/beaverApi";
import { waitForPdfPreparation } from "@/app/lib/pdfPreparation";
import type { WorkProductStore } from "@/app/lib/workProducts";
import type { AuthoritiesHost } from "./host";

const library = directoryResource({ library: "files" });
const drafts: WorkProductStore = {
  list: listWorkProducts, get: getWorkProduct, create: createWorkProduct,
  update: updateWorkProduct, duplicate: duplicateWorkProduct, remove: deleteWorkProduct,
};

export const beaverAuthoritiesHost: AuthoritiesHost = {
  mode: "beaver", drafts,
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
  async build(draft, progress) {
    if (draft.state.outputMode !== "table") {
      const sources = new Map(draft.state.authorityOrder.flatMap((authorityId) => {
        const authority = draft.state.authorities[authorityId];
        if (!authority || authority.excluded || authority.source.kind !== "attached") return [];
        const binding = draft.state.bindings[authority.source.bindingRole];
        return binding?.kind === "document"
          ? [[binding.documentId, authority.source.filename] as const] : [];
      }));
      for (const [documentId, filename] of sources) {
        progress?.(`Preparing ${filename}`);
        await waitForPdfPreparation(documentId,
          (status) => progress?.(`${filename}: ${status}`));
      }
    }
    progress?.("Building outputs");
    return buildAuthorities(draft.id, draft.revision);
  },
  download: (documentId, versionId) =>
    downloadDocument(documentId, versionId).then(({ blob }) => blob),
  async searchLibrary(query, signal) {
    const page = await library.list({ q: query.trim(), limit: 30 }, signal);
    return page.items.flatMap((item) => item.kind === "document" ? [item.document] : [])
      .filter((item) => ["pdf", "docx"].includes(item.file_type?.toLowerCase() ?? ""));
  },
};
