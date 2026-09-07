import { ApplicationError, type ApplicationScope } from "./applicationError";
import { applyAuthoritiesInitialSettings, applyAuthoritiesUserAction,
  attachAuthorityPdf as attachSource, attachAuthoritiesBookPdf as attachBookSource,
  authoritiesReview as review, updateAuthoritiesDraft as update,
  type AuthoritiesInitialSettings, type AuthoritiesUserAction } from "./authoritiesActions";
import { authorityPassageTargets, buildAuthorities, type AuthoritiesBuildInput,
  type AuthoritiesBuildResult } from "./authoritiesBuild";
import { attachedAuthoritySources, authoritiesBookPdfs, decodeAuthoritiesDraft,
  type AuthoritiesDraft, type AuthoritiesDiscrepancyAction,
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
import type { WorkProduct, WorkProductInput, WorkProductState } from "./workProduct";
import { saveWorkProductBuild, type WorkProductApplication } from "./workProductApplication";
import type { WorkflowFiles } from "./workflowFiles";

type AuthoritiesProduct = Extract<WorkProduct, { kind: "authorities" }>;

function draftState(state: WorkProductState): AuthoritiesDraft {
  const draft = decodeAuthoritiesDraft(state);
  if (!draft) throw new ApplicationError(409, "Authorities draft state is invalid");
  return draft;
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

  async function currentLibraryVersion(scope: ApplicationScope, draft: AuthoritiesDraft,
    role: string, expected: "pdf" | "source") {
    const binding = draft.bindings[role];
    if (binding?.kind !== "document") {
      throw new ApplicationError(409, "This source is not a Library document");
    }
    const version = await documents.metadata(scope, binding.documentId);
    if (!version) throw new ApplicationError(409,
      "This Library file is no longer available. Add it again.");
    const fileType = version.file_type.toLowerCase();
    if (expected === "pdf" ? fileType !== "pdf" : !["pdf", "docx"].includes(fileType)) {
      throw new ApplicationError(409, expected === "pdf"
        ? "The current Library file is not a PDF"
        : "The current Library file is not a PDF or Word document");
    }
    return { binding, version: { id: version.current_version_id, filename: version.filename,
      file_type: fileType, source_sha256: version.source_sha256 } };
  }

  function adoptCurrentPdf(draft: AuthoritiesDraft, role: string,
    binding: Extract<WorkProductInput, { kind: "document" }>,
    version: { filename: string; source_sha256: string }) {
    const attached = Object.values(draft.authorities).flatMap((authority) =>
      attachedAuthoritySources(authority.source).map((source) => ({ authority, source })))
      .find(({ source }) => source.bindingRole === role);
    const cover = draft.bookParts.cover?.bindingRole === role ? draft.bookParts.cover : null;
    const index = draft.bookParts.index?.bindingRole === role ? draft.bookParts.index : null;
    const supplement = draft.bookParts.supplements.find(({ bindingRole }) => bindingRole === role);
    const boundPdf = attached?.source ?? cover ?? index ?? supplement;
    if (!boundPdf) throw new ApplicationError(409, "This source is no longer in the draft");
    if (binding.version === "latest" && boundPdf.filename === version.filename &&
        boundPdf.sourceSha256 === version.source_sha256) return draft;
    const nextBinding = { ...binding, version: "latest" as const };
    const pdf = { ...boundPdf, filename: version.filename,
      sourceSha256: version.source_sha256 };
    return attached
      ? update(draft, { type: "attach-source", authorityId: attached.authority.id,
        bindingRole: role, binding: nextBinding, filename: pdf.filename,
        sourceSha256: pdf.sourceSha256, sourceUrl: attached.source.sourceUrl,
        origin: attached.source.origin, language: attached.source.language })
      : supplement
        ? update(draft, { type: "set-book-supplement",
          supplement: { ...supplement, ...pdf }, binding: nextBinding })
        : update(draft, { type: "set-book-part", slot: cover ? "cover" : "index",
          pdf, binding: nextBinding });
  }

  async function followLatestBindings(scope: ApplicationScope, initial: AuthoritiesDraft,
    signal?: AbortSignal) {
    let draft = initial;
    if (draft.import.kind === "document") {
      const role = draft.import.bindingRole, binding = draft.bindings[role];
      if (binding?.kind === "document" && binding.version === "latest") {
        const { version } = await currentLibraryVersion(scope, draft, role, "source");
        if (version.file_type !== draft.import.fileType) throw new ApplicationError(409,
          `The current Library file is not a ${draft.import.fileType === "pdf" ? "PDF" : "Word document"}`);
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
    const roles = [...new Set([
      ...Object.values(draft.authorities).flatMap(({ source }) =>
        attachedAuthoritySources(source).map(({ bindingRole }) => bindingRole)),
      ...authoritiesBookPdfs(draft).map(({ bindingRole }) => bindingRole),
    ])].filter((role) => {
      const binding = draft.bindings[role];
      return binding?.kind === "document" && binding.version === "latest";
    });
    const current = await Promise.all(roles.map(async (role) => ({ role,
      ...await currentLibraryVersion(scope, draft, role, "pdf"),
    })));
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
      const binding = draft.bindings[bindingRole];
      if (binding?.kind !== "document") {
        throw new ApplicationError(409, "Imported document binding is invalid");
      }
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
      ? (await documents.parseStates(scope, [...preparedRoles].flatMap((role) => {
        const binding = draft.bindings[role];
        return binding?.kind === "document" ? [binding.documentId] : [];
      }))).map((state) => [state.id, state.parse_state])
      : []);
    const readPdf = async (source: { bindingRole: string; filename: string;
      sourceSha256: string }, label: string) => {
      const binding = draft.bindings[source.bindingRole];
      if (binding?.kind !== "document") throw new ApplicationError(409,
        `${label} is unavailable: ${source.filename}`);
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
        const binding = draft.bindings[imported.bindingRole];
        if (binding?.kind !== "document" || binding.documentId !== snapshot.documentId) {
          throw new ApplicationError(409, "The imported Word document is unavailable");
        }
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
        ? draft.bindings[draft.import.bindingRole] : null;
      if (binding && binding.kind !== "document") {
        throw new ApplicationError(409, "Imported document binding is invalid");
      }
      if (!binding && !receiptSeeds?.length) return product;
      const source: AuthoritiesImportSource = binding ??
        { kind: "receipts", seeds: receiptSeeds! };
      return saveRefresh(scope, product, draft, revision, source);
    },
    async refreshInput(scope: ApplicationScope, id: string, input: {
      revision: number; role: string;
    }) {
      const { product, draft } = await edit(scope, id, input.revision);
      if (draft.import.kind === "document" && draft.import.bindingRole === input.role) {
        const { binding, version } = await currentLibraryVersion(
          scope, draft, input.role, "source");
        if (version.file_type.toLowerCase() !== draft.import.fileType) {
          throw new ApplicationError(409,
            `The current Library file is not a ${draft.import.fileType === "pdf" ? "PDF" : "Word document"}`);
        }
        return saveRefresh(scope, product, draft, input.revision,
          { ...binding, version: "latest" });
      }
      const { binding, version } = await currentLibraryVersion(scope, draft, input.role, "pdf");
      const state = adoptCurrentPdf(draft, input.role, binding, version);
      return workProducts.save(scope, id, { revision: input.revision, state });
    },
    async attachPdf(scope: ApplicationScope, id: string, input: {
      revision: number; authorityId: string; file: DocumentFile;
      language: AuthoritySourceLanguage;
    }) {
      if (input.file.fileType.toLowerCase() !== "pdf") {
        throw new ApplicationError(400, "Attach a PDF file");
      }
      const { product, draft } = await edit(scope, id, input.revision);
      const authority = attachableAuthority(draft, input.authorityId);
      const created = await files.create(scope, "authorities", input.file,
        { projectId: product.projectId, pdfOcrProvider: null });
      return withRollback(scope, [createdDocumentRollback(created)], async () => {
        const state = attachSource(draft, authority,
          { kind: "document", documentId: created.id,
            version: { versionId: created.current_version_id,
              sha256: created.source_sha256 } }, created.filename, created.source_sha256,
          input.language);
        return workProducts.save(scope, id, { revision: input.revision, state });
      }, "Attaching the PDF could not be completed");
    },
    async attachBookPdf(scope: ApplicationScope, id: string, input: {
      revision: number; slot: "cover" | "index" | "supplemental"; file: DocumentFile;
      supplementId?: string;
    }) {
      if (input.file.fileType.toLowerCase() !== "pdf") {
        throw new ApplicationError(400, "Attach a PDF file");
      }
      const { product, draft } = await edit(scope, id, input.revision);
      const created = await files.create(scope, "authorities", input.file,
        { projectId: product.projectId, pdfOcrProvider: null });
      return withRollback(scope, [createdDocumentRollback(created)], async () => {
        const binding = { kind: "document" as const, documentId: created.id,
          version: { versionId: created.current_version_id, sha256: created.source_sha256 } };
        const state = attachBookSource(draft, input, binding, created.filename,
          created.source_sha256);
        return workProducts.save(scope, id, { revision: input.revision, state });
      }, "Attaching the book PDF could not be completed");
    },
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
    async sourceOcr(scope: ApplicationScope, id: string, roles: string[], cancel: boolean) {
      const { draft } = await open(scope, id);
      const plan = createAuthoritiesPreparation(draft);
      return Promise.all(plan.authoritySources
        .filter(({ source }) => roles.includes(source.bindingRole))
        .map(async ({ source, authority }) => {
          const binding = draft.bindings[source.bindingRole];
          if (binding?.kind !== "document") throw new ApplicationError(409,
            `The PDF for ${source.filename} is unavailable`);
          const resolved = await documents.projectionSource(scope, binding.documentId,
            binding.version === "latest" ? null : binding.version.versionId);
          if (!resolved) throw new ApplicationError(409, `The PDF for ${source.filename} is unavailable`);
          const reference = { userId: scope.userId, documentId: resolved.documentId,
            versionId: resolved.versionId, sourceSha256: resolved.sourceSha256 };
          if (cancel) return { role: source.bindingRole, cancelled: await cancelPdfJobs(reference) };
          const citedPages = authorityPassageTargets(draft, authority.id)
            .flatMap(({ locatorKind, locator }) => locatorKind === "page" && /^\d+$/u.test(locator)
              ? [Number(locator)] : []);
          return { role: source.bindingRole, documentId: resolved.documentId,
            ...await enqueueAuthorityOcr({ ...reference, citedPages }) };
        }));
    },
    async prepareHighlights(scope: ApplicationScope, id: string, revision: number, signal?: AbortSignal) {
      const { product, draft } = await edit(scope, id, revision);
      // This prepares the same source/profile cache used by the book builder.
      // No output artifact is generated and no newer source is silently adopted.
      await buildSources(scope, draft, signal);
      signal?.throwIfAborted();
      return product;
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
