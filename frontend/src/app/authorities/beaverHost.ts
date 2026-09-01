import {
  actOnAuthorities, attachAuthoritiesBookPdf, attachAuthorityPdf, buildAuthorities, createAuthorities,
  createWorkProduct, deleteWorkProduct, directoryResource, downloadDocument,
  duplicateWorkProduct, getWorkProduct, getWorkProductResolution,
  listWorkProductMetadata, listWorkProducts, refreshAuthorities,
  prepareAuthoritiesSources, refreshAuthoritiesInput, replaceAuthoritiesSource, reviewAuthorities,
  updateWorkProduct, uploadAuthoritiesDocument,
} from "@/app/lib/beaverApi";
import { waitForPdfPreparation } from "@/app/lib/pdfPreparation";
import type { WorkProductStore } from "@/app/lib/workProducts";
import type { AuthoritiesHost, AuthoritiesSourceIssue } from "./host";

const library = directoryResource({ library: "files" });
const drafts: WorkProductStore = {
  list: listWorkProducts, get: getWorkProduct, create: createWorkProduct,
  listMetadata: listWorkProductMetadata,
  update: updateWorkProduct, duplicate: duplicateWorkProduct, remove: deleteWorkProduct,
};

export const beaverAuthoritiesHost: AuthoritiesHost = {
  drafts,
  async create({ source, title, projectId, settings }) {
    const imported = source.kind === "file"
      ? { kind: "document" as const,
        documentId: (await uploadAuthoritiesDocument(source.selected.file, projectId)).id,
        version: "latest" as const }
      : source.kind === "document"
        ? { kind: "document" as const, documentId: source.document.id,
          version: "latest" as const }
        : source;
    return createAuthorities({ source: imported, title, projectId, settings });
  },
  act: actOnAuthorities, refresh: refreshAuthorities, review: reviewAuthorities,
  prepareSources: (draft, signal) =>
    prepareAuthoritiesSources(draft.id, draft.revision, signal),
  relinkSource: refreshAuthoritiesInput,
  replaceSource: (id, revision, selected) =>
    replaceAuthoritiesSource(id, revision, selected.file),
  attach: (id, authorityId, revision, selected) =>
    attachAuthorityPdf(id, authorityId, revision, selected.file),
  attachBookPdf: (id, revision, slot, selected) =>
    attachAuthoritiesBookPdf(id, revision, slot, selected.file),
  async build(draft, progress, signal) {
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
          (status) => progress?.(`${filename}: ${status}`), signal);
      }
    }
    progress?.("Building outputs");
    return buildAuthorities(draft.id, draft.revision, signal);
  },
  download: (documentId, versionId) =>
    downloadDocument(documentId, versionId).then(({ blob }) => blob),
  async searchLibrary(query, signal) {
    const page = await library.list({ q: query.trim(), limit: 30 }, signal);
    return page.items.flatMap((item) => item.kind === "document" ? [item.document] : [])
      .filter((item) => ["pdf", "docx"].includes(item.file_type?.toLowerCase() ?? ""));
  },
  async sourceIssues(draft) {
    const resolved = await getWorkProductResolution(draft.id);
    const issues = Object.entries(resolved.inputs).flatMap<[string, AuthoritiesSourceIssue]>(([role, input]) =>
      input.status === "changed" ? [[role, { status: "changed" as const }]]
        : input.status === "missing" ? [[role, { status: "missing" as const,
            reason: input.reason === "deleted" ? "deleted" as const : "unavailable" as const }]]
          : []);
    return Object.fromEntries(issues);
  },
};
