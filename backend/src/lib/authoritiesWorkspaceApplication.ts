import { readFile } from "node:fs/promises";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { applyAuthoritiesInitialSettings, applyAuthoritiesUserAction,
  attachAuthorityPdf as attachSource, attachAuthoritiesBookPdf as attachBookSource,
  checkCanliiPdf, authoritiesReview as review, updateAuthoritiesDraft as update,
  type AuthoritiesInitialSettings, type AuthoritiesUserAction } from "./authoritiesActions";
import { authorityPassageTargets, buildAuthorities, citedSourcePages,
  type AuthoritiesBuildInput, type AuthoritiesBuildResult } from "./authoritiesBuild";
import { attachedAuthoritySources, decodeAuthoritiesDraft,
  type AuthoritiesAction, type AuthoritiesDraft, type AuthoritiesDiscrepancyAction,
  type AuthoritySourceLanguage } from "./authoritiesDomain";
import { createAuthoritiesImporter, type AuthoritiesImporter, type AuthoritiesImportSource,
  type GroundedReceiptSeed } from "./authoritiesImport";
import { reviewAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";
import { createAuthoritiesPreparation, prepareAuthoritiesCorrection } from "./authoritiesPreparation";
import { authoritySourceServices, resolveAuthoritiesSources, type SourceServices } from "./authoritiesSourceResolution";
import { createdDocumentRollback, createdVersionRollback, rollbackDocuments,
  type DocumentFile, type DocumentRollback, type DocumentStore } from "./documentStore";
import { sha256 } from "./hash";
import { cancelPdfJobs, enqueueAuthorityOcr } from "./pdfJobs";
import { documentProjectionService } from "./documentProjectionService";
import type { WorkProduct, WorkProductInput, WorkProductState } from "./workProduct";
import { saveWorkProductBuild, type WorkProductApplication } from "./workProductApplication";
import type { WorkflowFiles } from "./workflowFiles";

type AuthoritiesProduct = Extract<WorkProduct, { kind: "authorities" }>;

function draftState(state: WorkProductState): AuthoritiesDraft {
  const draft = decodeAuthoritiesDraft(state);
  if (!draft) throw new ApplicationError(409, "Authorities draft state is invalid");
  return draft;
}

type LibraryBinding = Extract<WorkProductInput, { kind: "document" }>;
type BoundPdf = { bindingRole: string; filename: string; sourceSha256: string };

/** Workspace drafts bind Library documents only; any other binding is a corrupted draft. */
function libraryBinding(draft: AuthoritiesDraft, role: string): LibraryBinding {
  const binding = draft.bindings[role];
  if (binding?.kind !== "document") {
    throw new ApplicationError(409, "This source is not a Library document");
  }
  return binding;
}

/** Every bound PDF in the draft, keyed by role, with the action that re-points its slot. */
function boundPdfs(draft: AuthoritiesDraft) {
  const entries: Array<{ pdf: BoundPdf;
    apply: (next: BoundPdf, binding: LibraryBinding) => AuthoritiesAction }> = [
    ...Object.values(draft.authorities).flatMap((authority) =>
      attachedAuthoritySources(authority.source).map((source) => ({ pdf: source,
        apply: (next: BoundPdf, binding: LibraryBinding): AuthoritiesAction =>
          ({ type: "attach-source", authorityId: authority.id, bindingRole: source.bindingRole,
            binding, filename: next.filename, sourceSha256: next.sourceSha256,
            sourceUrl: source.sourceUrl, origin: source.origin, language: source.language }) }))),
    ...draft.bookParts.supplements.map((supplement) => ({ pdf: supplement,
      apply: (next: BoundPdf, binding: LibraryBinding): AuthoritiesAction =>
        ({ type: "set-book-supplement", supplement: { ...supplement, ...next }, binding }) })),
    ...(["cover", "index"] as const).flatMap((slot) => {
      const part = draft.bookParts[slot];
      return part ? [{ pdf: part, apply: (next: BoundPdf, binding: LibraryBinding):
        AuthoritiesAction => ({ type: "set-book-part", slot, pdf: { ...part, ...next }, binding }) }] : [];
    }),
  ];
  return new Map(entries.map((entry) => [entry.pdf.bindingRole, entry]));
}

function attachableAuthority(draft: AuthoritiesDraft, authorityId: string) {
  const authority = draft.authorities[authorityId];
  if (!authority) {
    throw new ApplicationError(409, "This authority cannot accept that PDF");
  }
  return authority;
}

export function createAuthoritiesWorkspaceApplication(
  documents: DocumentStore,
  workProducts: WorkProductApplication,
  files: WorkflowFiles,
  builder: typeof buildAuthorities = buildAuthorities,
  importer: AuthoritiesImporter = createAuthoritiesImporter(documents),
  sources: SourceServices = authoritySourceServices,
  discrepancyReviewer: typeof reviewAuthoritiesDiscrepancies = reviewAuthoritiesDiscrepancies,
) {
  async function open(scope: ApplicationScope, id: string) {
    const found = await workProducts.get(scope, id);
    if (found.kind !== "authorities") throw new ApplicationError(404,
      "Authorities draft not found");
    return { product: found, draft: draftState(found.state) };
  }

  async function edit(scope: ApplicationScope, id: string, revision: number) {
    const current = await open(scope, id);
    if (current.product.revision !== revision) throw new ApplicationError(409,
      "This draft changed. Reload it before saving.", {
        current_revision: String(current.product.revision),
      });
    return current;
  }

  async function withRollback<T>(scope: ApplicationScope, rollback: DocumentRollback[], save: () => Promise<T>,
    message = "Authorities changes could not be saved or rolled back") {
    try { return await save(); }
    catch (error) { return rollbackDocuments(documents, scope, rollback, error, message); }
  }

  async function resolveSources(scope: ApplicationScope, initial: AuthoritiesDraft,
    projectId?: string | null, signal?: AbortSignal) {
    let { draft, attachments } = await resolveAuthoritiesSources(initial, sources, signal);
    const created: DocumentRollback[] = [];
    return withRollback(scope, created, async () => {
      for (const attachment of attachments) {
        signal?.throwIfAborted();
        const saved = await files.create(scope, "authorities",
          { filename: attachment.filename, fileType: "pdf", bytes: attachment.bytes },
          { projectId, pdfOcrProvider: null });
        created.push(createdDocumentRollback(saved));
        if (saved.source_sha256 !== attachment.sourceSha256) {
          throw new Error("Saved authority PDF hash does not match its prepared source");
        }
        draft = attachSource(draft, draft.authorities[attachment.authorityId],
          { kind: "document", documentId: saved.id,
            version: { versionId: saved.current_version_id, sha256: saved.source_sha256 } },
          saved.filename, saved.source_sha256, attachment.language,
          attachment.origin, attachment.sourceUrl);
      }
      return { draft, created };
    }, "Authority sources could not be saved or rolled back");
  }

  async function saveRefresh(scope: ApplicationScope, product: AuthoritiesProduct,
    draft: AuthoritiesDraft, revision: number, source: AuthoritiesImportSource) {
    const fresh = await importer.draft(scope, source);
    return workProducts.save(scope, product.id, { revision,
      state: update(draft, { type: "refresh", review: review(fresh) }) });
  }

  async function currentLibraryVersion(scope: ApplicationScope, binding: LibraryBinding,
    expected: "pdf" | "docx") {
    const version = await documents.metadata(scope, binding.documentId);
    if (!version) throw new ApplicationError(409,
      "This Library file is no longer available. Add it again.");
    if (version.file_type.toLowerCase() !== expected) throw new ApplicationError(409,
      `The current Library file is not a ${expected === "pdf" ? "PDF" : "Word document"}`);
    return { id: version.current_version_id, filename: version.filename,
      source_sha256: version.source_sha256 };
  }

  function adoptCurrentPdf(draft: AuthoritiesDraft, role: string, binding: LibraryBinding,
    version: { filename: string; source_sha256: string }) {
    const bound = boundPdfs(draft).get(role);
    if (!bound) throw new ApplicationError(409, "This source is no longer in the draft");
    if (binding.version === "latest" && bound.pdf.filename === version.filename &&
        bound.pdf.sourceSha256 === version.source_sha256) return draft;
    return update(draft, bound.apply({ bindingRole: role, filename: version.filename,
      sourceSha256: version.source_sha256 }, { ...binding, version: "latest" }));
  }

  async function followLatestBindings(scope: ApplicationScope, initial: AuthoritiesDraft,
    signal?: AbortSignal) {
    let draft = initial;
    if (draft.import.kind === "document") {
      const binding = libraryBinding(draft, draft.import.bindingRole);
      if (binding.version === "latest") {
        const version = await currentLibraryVersion(scope, binding, draft.import.fileType);
        const snapshot = draft.import.snapshot;
        if (!snapshot || snapshot.documentId !== binding.documentId ||
            snapshot.versionId !== version.id || snapshot.sha256 !== version.source_sha256 ||
            draft.import.filename !== version.filename) {
          signal?.throwIfAborted();
          const fresh = await importer.draft(scope, binding);
          draft = update(draft, { type: "refresh", review: review(fresh) });
        }
      }
    }
    const latest = [...boundPdfs(draft).keys()].flatMap((role) => {
      const binding = libraryBinding(draft, role);
      return binding.version === "latest" ? [{ role, binding }] : [];
    });
    const current = await Promise.all(latest.map(async (item) => ({ ...item,
      version: await currentLibraryVersion(scope, item.binding, "pdf") })));
    for (const item of current) draft = adoptCurrentPdf(
      draft, item.role, item.binding, item.version);
    return draft;
  }

  async function pendingDiscrepancies(draft: AuthoritiesDraft, signal?: AbortSignal) {
    return (await discrepancyReviewer(draft, signal))
      .filter(({ id }) => !draft.discrepancyDecisions?.[id]);
  }

  async function buildSources(scope: ApplicationScope, draft: AuthoritiesDraft,
    signal?: AbortSignal) {
    const result: NonNullable<AuthoritiesBuildInput["sources"]> = {};
    if (draft.import.kind === "document" && draft.import.snapshot) {
      const { bindingRole, snapshot, filename } = draft.import;
      const binding = libraryBinding(draft, bindingRole);
      const requested = binding.version === "latest" ? null : binding.version.versionId;
      const [source, current] = await Promise.all([
        documents.projectionSource(scope, binding.documentId, requested),
        binding.version === "latest" ? documents.metadata(scope, binding.documentId) : null,
      ]);
      const currentFilename = current && current.current_version_id === source?.versionId
        ? current.filename : null;
      const resolvedFilename = binding.version === "latest" ? currentFilename : filename;
      if (!source || source.documentId !== snapshot.documentId ||
          source.versionId !== snapshot.versionId ||
          source.sourceSha256 !== snapshot.sha256 || typeof resolvedFilename !== "string") {
        throw new ApplicationError(409, "The imported document changed. Refresh before building.");
      }
      result[bindingRole] = { resolved: { kind: "document",
        documentId: source.documentId, versionId: source.versionId,
        filename: resolvedFilename, sha256: source.sourceSha256 } };
      if (draft.insertIntoDocument) {
        const file = await documents.read(scope, binding.documentId, source.versionId, false);
        if (!file || file.fileType.toLowerCase() !== draft.import.fileType ||
            file.version.source_sha256 !== snapshot.sha256 ||
            sha256(file.bytes) !== snapshot.sha256) {
          throw new ApplicationError(409, "The imported document changed. Refresh before building.");
        }
        result[bindingRole].bytes = file.bytes;
      }
    }
    const plan = createAuthoritiesPreparation(draft);
    const preparedRoles = new Set([...plan.bookRoles, ...plan.textRoles]);
    const preparation = new Map(preparedRoles.size
      ? (await documents.parseStates(scope, [...preparedRoles].map((role) =>
        libraryBinding(draft, role).documentId))).map((state) => [state.id, state.parse_state])
      : []);
    const readPdf = async (source: BoundPdf, label: string) => {
      const binding = libraryBinding(draft, source.bindingRole);
      const file = await documents.read(scope, binding.documentId,
        binding.version === "latest" ? null : binding.version.versionId, false);
      if (!file || file.fileType.toLowerCase() !== "pdf" ||
          file.version.source_sha256 !== source.sourceSha256 ||
          sha256(file.bytes) !== source.sourceSha256) throw new ApplicationError(409,
        `${label} changed: ${source.filename}`);
      return { binding, file, resolved: { kind: "document" as const,
        documentId: binding.documentId, versionId: file.version.id,
        filename: file.filename, sha256: file.version.source_sha256 } };
    };
    await Promise.all(plan.authoritySources.map(async ({ source }) => {
      signal?.throwIfAborted();
      const { binding, file, resolved } = await readPdf(source, "Attached PDF");
      const forBook = plan.bookRoles.has(source.bindingRole);
      if (forBook && !file.pdfProfile) {
        const state = preparation.get(binding.documentId);
        const pending = state?.status === "queued" || state?.status === "parsing";
        throw new ApplicationError(409, pending
          ? `${source.filename} is still being prepared.`
          : state?.error?.includes("password-protected")
            ? `${source.filename}: ${state.error}`
            : `${source.filename} could not be prepared. Remove any password or usage restrictions, then add it again.`,
        { document_id: binding.documentId,
          pdf_status: state?.status ?? "unprepared",
          pdf_phase: state?.phase,
          pdf_pages: state?.pages?.join(",") });
      }
      result[source.bindingRole] = { ...(plan.byteRoles.has(source.bindingRole) ? { bytes: file.bytes } : {}),
        ...await plan.prepareText(source.bindingRole, { bytes: file.bytes,
          documentId: binding.documentId, versionId: file.version.id,
          sourceSha256: file.version.source_sha256, pdfProfile: file.pdfProfile, signal }),
        resolved };
    }));
    await Promise.all(plan.bookPdfs.map(async (source) => {
      signal?.throwIfAborted();
      const { file, resolved } = await readPdf(source, "Book PDF");
      result[source.bindingRole] = { bytes: file.bytes, resolved };
    }));
    return result;
  }

  async function uploadPdf(scope: ApplicationScope, id: string,
    input: { revision: number; file: DocumentFile; authorityId?: string },
    attach: (draft: AuthoritiesDraft, binding: WorkProductInput, filename: string, hash: string) => AuthoritiesDraft) {
    if (input.file.fileType.toLowerCase() !== "pdf") throw new ApplicationError(400, "Attach a PDF file");
    const { product, draft } = await edit(scope, id, input.revision);
    if (input.authorityId !== undefined && attachableAuthority(draft, input.authorityId).source.kind === "pending-canlii") {
      await checkCanliiPdf(draft, input.authorityId,
        "bytes" in input.file ? input.file.bytes : await readFile(input.file.path));
    }
    const created = await files.create(scope, "authorities", input.file,
      { projectId: product.projectId, pdfOcrProvider: null });
    return withRollback(scope, [createdDocumentRollback(created)], () => workProducts.save(scope, id,
      { revision: input.revision, state: attach(draft, { kind: "document", documentId: created.id,
        version: { versionId: created.current_version_id, sha256: created.source_sha256 } },
      created.filename, created.source_sha256) }), "Attaching the PDF could not be completed");
  }

  return Object.freeze({
    list: (scope: ApplicationScope, options: { projectId?: string; limit?: number } = {}) =>
      workProducts.list(scope, { kind: "authorities", ...options }),
    async get(scope: ApplicationScope, id: string) {
      return (await open(scope, id)).product;
    },
    async discrepancies(scope: ApplicationScope, id: string, signal?: AbortSignal) {
      return pendingDiscrepancies((await open(scope, id)).draft, signal);
    },
    async resolveDiscrepancy(scope: ApplicationScope, id: string, input: {
      revision: number; id: string; action: AuthoritiesDiscrepancyAction;
    }, signal?: AbortSignal) {
      const { draft } = await edit(scope, id, input.revision);
      const prepared = await prepareAuthoritiesCorrection(draft, input, async (imported) => {
        const snapshot = imported.snapshot;
        if (!snapshot) throw new ApplicationError(409,
          "Source corrections require an imported Word document");
        const binding = libraryBinding(draft, imported.bindingRole);
        const source = await documents.read(scope, binding.documentId, snapshot.versionId, false);
        if (!source || source.fileType.toLowerCase() !== "docx" ||
            source.version.source_sha256 !== snapshot.sha256 || sha256(source.bytes) !== snapshot.sha256) {
          throw new ApplicationError(409, "The imported Word document changed. Refresh first.");
        }
        return { ...source, binding, snapshot };
      }, discrepancyReviewer, signal);
      if (prepared.kind === "ignored") {
        return workProducts.save(scope, id, { revision: input.revision, state: prepared.draft });
      }
      const { bytes, draft: decided, source } = prepared, { binding, snapshot } = source;
      const version = await documents.addVersion(scope, binding.documentId, {
        filename: source.filename, fileType: "docx", bytes,
        comment: `Authorities: ${input.action.replace("_", " ")}`,
        expectedCurrentVersionId: snapshot.versionId,
        expectedCurrentWorkingRevision: source.version.working_revision,
        expectedCurrentSha256: snapshot.sha256,
      });
      if (!version) throw new ApplicationError(409,
        "The imported Word document changed while the correction was being saved");
      return withRollback(scope, [createdVersionRollback(binding.documentId, version)], async () => {
        if (version.source_sha256 !== sha256(bytes)) {
          throw new Error("Saved Word correction does not match its accepted source");
        }
        signal?.throwIfAborted();
        const fresh = await importer.draft(scope, { kind: "document",
          documentId: binding.documentId,
          version: { versionId: version.id, sha256: version.source_sha256 } });
        const state = update(decided, { type: "refresh", review: review(fresh) });
        state.stage = draft.stage === "citations" ? "citations" : "sources";
        return workProducts.save(scope, id, { revision: input.revision, state });
      }, "The accepted Authorities correction could not be saved");
    },
    async saveFile(scope: ApplicationScope, file: DocumentFile, projectId?: string | null) {
      if (!["pdf", "docx"].includes(file.fileType.toLowerCase())) {
        throw new ApplicationError(400, "Add a PDF or Word document");
      }
      return files.create(scope, "authorities", file, { projectId });
    },
    async importDraft(scope: ApplicationScope, input: {
      source: AuthoritiesImportSource; title?: string; projectId?: string | null;
      settings?: AuthoritiesInitialSettings;
    }) {
      const initial = applyAuthoritiesInitialSettings(
        await importer.draft(scope, input.source), input.settings);
      const title = input.title ?? (initial.import.kind === "document"
        ? initial.import.filename.replace(/\.[^.]+$/u, "") || "Authorities"
        : "Authorities");
      return workProducts.create(scope,
        { kind: "authorities", title, projectId: input.projectId, state: initial });
    },
    async addReceipts(scope: ApplicationScope, id: string, revision: number,
      seeds: readonly GroundedReceiptSeed[]) {
      const { draft } = await edit(scope, id, revision);
      const incoming = review(await importer.draft(scope, { kind: "receipts", seeds }));
      const current = review(draft);
      const changed = update(draft, { type: "refresh", review: {
        ...current,
        authorities: { ...current.authorities, ...incoming.authorities },
        authorityOrder: [...current.authorityOrder, ...incoming.authorityOrder.filter(
          (authorityId) => !current.authorities[authorityId],
        )],
      } });
      return workProducts.save(scope, id, { revision, state: changed });
    },
    async act(scope: ApplicationScope, id: string, revision: number,
      action: AuthoritiesUserAction) {
      const { draft } = await edit(scope, id, revision);
      const changed = applyAuthoritiesUserAction(draft, action, sources);
      return workProducts.save(scope, id, { revision, state: changed });
    },
    async prepareSources(scope: ApplicationScope, id: string, revision: number,
      signal?: AbortSignal) {
      const { product, draft } = await edit(scope, id, revision);
      const resolved = await resolveSources(scope,
        await followLatestBindings(scope, draft, signal), product.projectId, signal);
      if (resolved.draft === draft && !resolved.created.length) return product;
      return withRollback(scope, resolved.created, () =>
        workProducts.save(scope, id, { revision, state: resolved.draft }));
    },
    async refresh(scope: ApplicationScope, id: string, revision: number,
      receiptSeeds?: readonly GroundedReceiptSeed[]) {
      const { product, draft } = await edit(scope, id, revision);
      const binding = draft.import.kind === "document"
        ? libraryBinding(draft, draft.import.bindingRole) : null;
      if (!binding && !receiptSeeds?.length) return product;
      const source: AuthoritiesImportSource = binding ??
        { kind: "receipts", seeds: receiptSeeds! };
      return saveRefresh(scope, product, draft, revision, source);
    },
    async refreshInput(scope: ApplicationScope, id: string, input: {
      revision: number; role: string;
    }) {
      const { product, draft } = await edit(scope, id, input.revision);
      const binding = libraryBinding(draft, input.role);
      if (draft.import.kind === "document" && draft.import.bindingRole === input.role) {
        await currentLibraryVersion(scope, binding, draft.import.fileType);
        return saveRefresh(scope, product, draft, input.revision,
          { ...binding, version: "latest" });
      }
      const version = await currentLibraryVersion(scope, binding, "pdf");
      return workProducts.save(scope, id, { revision: input.revision,
        state: adoptCurrentPdf(draft, input.role, binding, version) });
    },
    attachPdf: (scope: ApplicationScope, id: string, input: {
      revision: number; authorityId: string; file: DocumentFile; language: AuthoritySourceLanguage;
    }) => uploadPdf(scope, id, input, (draft, binding, filename, hash) =>
      attachSource(draft, attachableAuthority(draft, input.authorityId), binding, filename, hash, input.language)),
    attachBookPdf: (scope: ApplicationScope, id: string, input: {
      revision: number; slot: "cover" | "index" | "supplemental"; file: DocumentFile; supplementId?: string;
    }) => uploadPdf(scope, id, input, (draft, binding, filename, hash) =>
      attachBookSource(draft, input, binding, filename, hash)),
    async attachLibraryPdf(scope: ApplicationScope, id: string, input: {
      revision: number; documentId: string; versionId: string;
      target: { kind: "authority"; authorityId: string; language: AuthoritySourceLanguage } |
        { kind: "book"; slot: "cover" | "index" | "supplemental"; supplementId?: string };
    }) {
      const { draft } = await edit(scope, id, input.revision);
      const version = await documents.metadata(scope, input.documentId);
      if (!version || version.current_version_id !== input.versionId ||
          version.file_type.toLowerCase() !== "pdf") {
        throw new ApplicationError(409, "Select the current PDF version from Library");
      }
      if (input.target.kind === "authority" &&
          draft.authorities[input.target.authorityId]?.source.kind === "pending-canlii") {
        const file = await documents.read(scope, input.documentId, input.versionId, false);
        if (!file) throw new ApplicationError(409, "The PDF is no longer available.");
        await checkCanliiPdf(draft, input.target.authorityId, file.bytes);
      }
      const binding = { kind: "document" as const, documentId: input.documentId,
        version: "latest" as const };
      return workProducts.save(scope, id, { revision: input.revision,
        state: input.target.kind === "authority"
          ? attachSource(draft, attachableAuthority(draft, input.target.authorityId), binding,
            version.filename, version.source_sha256, input.target.language)
          : attachBookSource(draft, input.target, binding, version.filename,
            version.source_sha256) });
    },
    /** Recognition runs in the durable queue so the workspace can watch, pause, and stop it. */
    async sourceOcr(scope: ApplicationScope, id: string, roles: string[], cancel: boolean, pages?: number[]) {
      const { draft } = await open(scope, id);
      const plan = createAuthoritiesPreparation(draft);
      return Promise.all(plan.authoritySources
        .filter(({ source }) => roles.includes(source.bindingRole))
        .map(async ({ source, authority }) => {
          const binding = libraryBinding(draft, source.bindingRole);
          const resolved = await documents.projectionSource(scope, binding.documentId,
            binding.version === "latest" ? null : binding.version.versionId);
          if (!resolved) throw new ApplicationError(409, `The PDF for ${source.filename} is unavailable`);
          const reference = { userId: scope.userId, documentId: resolved.documentId,
            versionId: resolved.versionId, sourceSha256: resolved.sourceSha256 };
          if (cancel) return { role: source.bindingRole, cancelled: await cancelPdfJobs(reference) };
          if (!pages && resolved.pdfProfile?.profile.ocr) return {
            role: source.bindingRole, documentId: resolved.documentId, done: true };
          const prepared = await documentProjectionService.preparePdf({ ...reference,
            bytes: await resolved.readBytes(), ocrProvider: null });
          if (pages?.some((page) => page > prepared.pageCount)) throw new ApplicationError(400,
            `Choose page numbers within the PDF for ${source.filename}.`);
          const targets = pages ? [] : authorityPassageTargets(draft, authority.id);
          // Page pinpoints locate themselves without any text, so a scan whose passages the
          // geometry cannot find still has its cited pages recognized before the whole PDF.
          const citedPages = pages ? [] : [...citedSourcePages(draft, authority.id, [],
            undefined, prepared.pageCount)].map((index) => index + 1);
          for (let start = 0; start < targets.length; start += 100) {
            const geometry = await documentProjectionService.pdfPassageGeometry(resolved.readBytes,
              targets.slice(start, start + 100), { ...reference, cacheKey: prepared.cacheKey },
              { pdfProfile: { cacheKey: prepared.cacheKey, profile: prepared.profile, status: prepared.status } });
            citedPages.push(...geometry.targets.flatMap(target => target.status === "found"
              ? target.pages.map(page => page.pageNumber) : []));
          }
          await enqueueAuthorityOcr({ ...reference, citedPages, pages });
          return { role: source.bindingRole, documentId: resolved.documentId };
        }));
    },
    async build(scope: ApplicationScope, id: string, revision: number, signal?: AbortSignal):
      Promise<{ product: AuthoritiesProduct; receipt: AuthoritiesBuildResult["receipt"] }> {
      const { product, draft: storedDraft } = await edit(scope, id, revision);
      const draft = await followLatestBindings(scope, storedDraft, signal);
      let built: AuthoritiesBuildResult;
      try {
        built = await builder({ draft, title: product.title,
          workProduct: { id, revision }, sources: await buildSources(scope, draft, signal), signal });
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(409,
          error instanceof Error ? error.message : "Authorities could not be built");
      }
      const artifacts = Object.values(built.artifacts).filter(
        (item): item is NonNullable<typeof item> => Boolean(item)).map((artifact) => ({
          role: artifact.role,
          file: { filename: artifact.filename,
            fileType: artifact.mimeType === "application/pdf" ? "pdf" : "docx",
            bytes: artifact.bytes, expectedSha256: artifact.sha256 },
          receipt: artifact.receipt,
        }));
      const saved = await saveWorkProductBuild({ documents, files, workProducts }, scope,
        product, artifacts, { signal, ...(draft === storedDraft ? {} : { state: draft }) });
      if (saved.kind !== "authorities") throw new ApplicationError(409, "Authorities draft state is invalid");
      return { product: saved, receipt: built.receipt };
    },
  });
}

export type AuthoritiesWorkspaceApplication =
  ReturnType<typeof createAuthoritiesWorkspaceApplication>;
