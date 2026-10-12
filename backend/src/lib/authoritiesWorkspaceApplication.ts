import type { Progress } from "./followedRoute";
import { mapBounded } from "./mapBounded";
import { authorityCitationForms } from "./authoritiesDomain";
import { reporterStartPages } from "./pdfPagination";
import { docxToPdf, wordToPdfAvailable } from "./convert";
import type { AuthoritiesBookSlot } from "mike/shared/authorities-sources.mjs";
import { readFile } from "node:fs/promises";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { applyAuthoritiesInitialSettings, applyAuthoritiesUserAction,
  folderPdfAuthority, authoritiesReview as review, updateAuthoritiesDraft as update,
  type AuthoritiesInitialSettings, type AuthoritiesUserAction, type PdfOpening } from "./authoritiesActions";
import { authorityPassageTargets, buildAuthorities, citedSourcePages,
  type AuthoritiesBuildResult, type BuildSourceText } from "./authoritiesBuild";
import { attachAuthorityFile, attachBookFile, authorityAnnotations, buildAuthoritiesDraft, correctedAuthoritiesDraft,
  gatherAuthoritySources, refreshedAuthoritiesDraft, type AuthoritiesBuildFile, type KeptPdf } from "./authoritiesCore";
import { attachedAuthoritySources, decodeAuthoritiesDraft,
  type AuthoritiesAction, type AuthoritiesDraft,
  type AuthoritySourceLanguage } from "./authoritiesDomain";
import type { AuthoritiesDiscrepancyRequest } from "mike/shared/authorities-contract.d.ts";
import { createAuthoritiesImporter, type AuthoritiesImporter, type AuthoritiesImportSource,
  type GroundedReceiptSeed } from "./authoritiesImport";
import { reviewAuthoritiesDiscrepancies } from "./authoritiesDiscrepancy";
import { createAuthoritiesPreparation, prepareAuthoritiesCorrection } from "./authoritiesPreparation";
import { authorityReferenceText, authorityStatuteText, authoritySourceServices, resolveAuthoritiesSources,
  type SourceServices } from "./authoritiesSourceResolution";
import { createdDocumentRollback, createdVersionRollback, rollbackDocuments,
  type DocumentFile, type DocumentRollback, type DocumentStore } from "./documentStore";
import { canonicalJsonSha256, sha256 } from "./hash";
import { cancelPdfJobs, enqueueAuthorityOcr } from "./pdfJobs";
import { documentProjectionService } from "./documentProjectionService";
import type { ResolvedWorkProductInput, WorkProduct, WorkProductInput, WorkProductState } from "./workProduct";
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
    ...(["cover", "index", "brief"] as const).flatMap((slot) => {
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

  /** Library keeps each PDF the core hands it as a document of its own, removed again if the change is not saved. */
  async function keepInLibrary(scope: ApplicationScope, created: DocumentRollback[], file: DocumentFile,
    projectId: string | null | undefined, sourceSha256: string): Promise<KeptPdf> {
    const saved = await files.create(scope, "authorities", file, { projectId, pdfOcrProvider: null });
    created.push(createdDocumentRollback(saved));
    if (saved.source_sha256 !== sourceSha256) throw new Error("Saved authority PDF hash does not match its source");
    return { binding: { kind: "document", documentId: saved.id,
      version: { versionId: saved.current_version_id, sha256: saved.source_sha256 } },
    reference: { documentId: saved.id, versionId: saved.current_version_id }, filename: saved.filename };
  }

  async function resolveSources(scope: ApplicationScope, initial: AuthoritiesDraft,
    projectId?: string | null, signal?: AbortSignal, onlyAuthorityId?: string, progress?: Progress) {
    const created: DocumentRollback[] = [];
    return withRollback(scope, created, async () => ({ created, ...await gatherAuthoritySources(initial, {
      progress, signal,
      resolve: (draft) => resolveAuthoritiesSources(draft, sources, signal, onlyAuthorityId, progress),
      keep: async (attachments) => {
        const kept: KeptPdf[] = [];
        for (const { filename, bytes, sourceSha256 } of attachments) {
          signal?.throwIfAborted();
          kept.push(await keepInLibrary(scope, created, { filename, fileType: "pdf", bytes }, projectId, sourceSha256));
        }
        return kept;
      },
    }) }), "Authority sources could not be saved or rolled back");
  }

  async function saveRefresh(scope: ApplicationScope, product: AuthoritiesProduct,
    draft: AuthoritiesDraft, revision: number, source: AuthoritiesImportSource) {
    const fresh = await importer.draft(scope, source, { sourceMode: draft.settings.sourceMode });
    return workProducts.save(scope, product.id, { revision, state: await refreshedAuthoritiesDraft(draft, fresh) });
  }

  async function currentLibraryVersion(scope: ApplicationScope, binding: LibraryBinding,
    expected: "pdf" | "docx", allowMissing = false) {
    const version = await documents.metadata(scope, binding.documentId);
    if (!version && allowMissing) return null;
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
        const version = (await currentLibraryVersion(scope, binding, draft.import.fileType))!;
        const snapshot = draft.import.snapshot;
        if (!snapshot || snapshot.documentId !== binding.documentId ||
            snapshot.versionId !== version.id || snapshot.sha256 !== version.source_sha256 ||
            draft.import.filename !== version.filename) {
          signal?.throwIfAborted();
          const fresh = await importer.draft(scope, binding, { sourceMode: draft.settings.sourceMode });
          draft = await refreshedAuthoritiesDraft(draft, fresh, signal);
        }
      }
    }
    const latest = [...boundPdfs(draft).keys()].flatMap((role) => {
      const binding = libraryBinding(draft, role);
      return binding.version === "latest" ? [{ role, binding }] : [];
    });
    const plan = createAuthoritiesPreparation(draft);
    const authorityRoles = new Set(plan.authoritySources
      .map(({ source }) => source.bindingRole));
    const bookRoles = new Set(plan.bookPdfs
      .map(({ bindingRole }) => bindingRole));
    const current = await Promise.all(latest.map(async (item) => ({ ...item,
      version: await currentLibraryVersion(scope, item.binding, "pdf",
        !!draft.settings.allowIncomplete && authorityRoles.has(item.role) && !bookRoles.has(item.role)) })));
    for (const item of current) if (item.version) draft = adoptCurrentPdf(
      draft, item.role, item.binding, item.version);
    return draft;
  }

  async function pendingDiscrepancies(draft: AuthoritiesDraft, signal?: AbortSignal) {
    return (await discrepancyReviewer(draft, signal))
      .filter(({ id }) => !draft.discrepancyDecisions?.[id]);
  }

  /** The sources a build reads, from Library: each the exact version the draft is bound to, a book's PDFs prepared. */
  async function buildFiles(scope: ApplicationScope, draft: AuthoritiesDraft, signal?: AbortSignal) {
    const files: AuthoritiesBuildFile[] = [], unread: Record<string, ResolvedWorkProductInput> = {};
    const plan = createAuthoritiesPreparation(draft);
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
      const resolved = { kind: "document" as const, documentId: source.documentId, versionId: source.versionId,
        filename: resolvedFilename, sha256: source.sourceSha256 };
      if (plan.byteRoles.has(bindingRole)) {
        const file = await documents.read(scope, binding.documentId, source.versionId, false);
        if (!file || file.fileType.toLowerCase() !== draft.import.fileType ||
            file.version.source_sha256 !== snapshot.sha256 ||
            sha256(file.bytes) !== snapshot.sha256) {
          throw new ApplicationError(409, "The imported document changed. Refresh before building.");
        }
        files.push({ role: bindingRole, filename: resolvedFilename, bytes: file.bytes, sourceSha256: snapshot.sha256,
          reference: { documentId: binding.documentId, versionId: source.versionId }, pdfProfile: file.pdfProfile, resolved });
      } else unread[bindingRole] = resolved;
    }
    const preparedRoles = new Set([...plan.bookRoles, ...plan.textRoles]);
    const preparation = new Map(preparedRoles.size
      ? (await documents.parseStates(scope, [...preparedRoles].map((role) =>
        libraryBinding(draft, role).documentId))).map((state) => [state.id, state.parse_state])
      : []);
    const readPdf = async (source: BoundPdf, label: string, allowMissing = false) => {
      signal?.throwIfAborted();
      const binding = libraryBinding(draft, source.bindingRole);
      const file = await documents.read(scope, binding.documentId,
        binding.version === "latest" ? null : binding.version.versionId, false);
      if (!file && allowMissing) return;
      if (!file || file.fileType.toLowerCase() !== "pdf" ||
          file.version.source_sha256 !== source.sourceSha256 ||
          sha256(file.bytes) !== source.sourceSha256) throw new ApplicationError(409,
        `${label} changed: ${source.filename}`);
      // A book's sources are recognized by Library's own queue before a build reads them.
      if (plan.bookRoles.has(source.bindingRole) && !file.pdfProfile) {
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
      files.push({ role: source.bindingRole, filename: source.filename, bytes: file.bytes,
        sourceSha256: source.sourceSha256, reference: { documentId: binding.documentId, versionId: file.version.id },
        pdfProfile: file.pdfProfile, resolved: { kind: "document", documentId: binding.documentId,
          versionId: file.version.id, filename: file.filename, sha256: file.version.source_sha256 } });
    };
    // Every attached source is verified against the version it is bound to, even where the build needs no bytes.
    await mapBounded(plan.authoritySources, ({ source }) => readPdf(source, "Attached PDF",
      !!draft.settings.allowIncomplete && !plan.bookPdfs.some(({ bindingRole }) => bindingRole === source.bindingRole)));
    await mapBounded(plan.bookPdfs, (source) => readPdf(source, "Book PDF"));
    if (plan.briefPdf) await readPdf(plan.briefPdf, "Brief PDF");
    return { files, unread };
  }

  /** A PDF the user uploads, kept in Library only once the core has checked it. */
  async function attachUpload(scope: ApplicationScope, id: string, input: { revision: number; file: DocumentFile },
    attach: (draft: AuthoritiesDraft, bytes: Buffer, keep: () => Promise<KeptPdf>) => Promise<AuthoritiesDraft>) {
    if (input.file.fileType.toLowerCase() !== "pdf") throw new ApplicationError(400, "Attach a PDF file");
    const { product, draft } = await edit(scope, id, input.revision);
    const bytes = "bytes" in input.file ? input.file.bytes : await readFile(input.file.path);
    const created: DocumentRollback[] = [];
    return withRollback(scope, created, async () => workProducts.save(scope, id, { revision: input.revision,
      state: await attach(draft, bytes, () => keepInLibrary(scope, created, input.file, product.projectId, sha256(bytes))) }),
    "Attaching the PDF could not be completed");
  }
  return Object.freeze({
    list: (scope: ApplicationScope, options: { projectId?: string; limit?: number } = {}) =>
      workProducts.list(scope, { kind: "authorities", ...options }),
    async get(scope: ApplicationScope, id: string) {
      return (await open(scope, id)).product;
    },
    /** A draft's attached PDFs' text as a build reads it, for the index preview: read from the stored file, a
     *  changed or missing file read as nothing. */
    sourceText(scope: ApplicationScope, draft: AuthoritiesDraft, signal?: AbortSignal): BuildSourceText {
      const plan = createAuthoritiesPreparation(draft);
      return async (source) => {
        const binding = libraryBinding(draft, source.bindingRole);
        const file = await documents.read(scope, binding.documentId,
          binding.version === "latest" ? null : binding.version.versionId, false);
        if (!file || file.version.source_sha256 !== source.sourceSha256) return null;
        return plan.prepareText(source.bindingRole, { bytes: file.bytes, documentId: binding.documentId,
          versionId: file.version.id, sourceSha256: source.sourceSha256, pdfProfile: file.pdfProfile, signal });
      };
    },
    async discrepancies(scope: ApplicationScope, id: string, signal?: AbortSignal) {
      return pendingDiscrepancies((await open(scope, id)).draft, signal);
    },
    async resolveDiscrepancy(scope: ApplicationScope, id: string, input: {
      revision: number; id: string; action: AuthoritiesDiscrepancyRequest;
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
          version: { versionId: version.id, sha256: version.source_sha256 } },
        { sourceMode: draft.settings.sourceMode });
        return workProducts.save(scope, id, { revision: input.revision,
          state: correctedAuthoritiesDraft(decided, fresh, draft.stage) });
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
        await importer.draft(scope, input.source, { sourceMode: input.settings?.sourceMode }), input.settings);
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
      signal?: AbortSignal, onlyAuthorityId?: string, progress?: Progress) {
      const { product, draft } = await edit(scope, id, revision);
      const resolved = await resolveSources(scope,
        onlyAuthorityId ? draft : await followLatestBindings(scope, draft, signal),
        product.projectId, signal, onlyAuthorityId, progress);
      // Every reducer hands back a fresh object, so re-offering a CanLII handoff
      // the draft already holds reads as a change. Opening a draft that needed
      // nothing must not spend a revision: compare the state, not the reference.
      if (!resolved.created.length && (resolved.draft === draft ||
        canonicalJsonSha256(resolved.draft) === canonicalJsonSha256(draft))) return product;
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
      const version = (await currentLibraryVersion(scope, binding, "pdf"))!;
      return workProducts.save(scope, id, { revision: input.revision,
        state: adoptCurrentPdf(draft, input.role, binding, version) });
    },
    /** The authority still without a PDF that a PDF from the watched folder is, if exactly one. */
    async pdfAuthority(scope: ApplicationScope, id: string, opening: PdfOpening) {
      const { draft } = await open(scope, id);
      return folderPdfAuthority(draft, opening, (authority) => authorityReferenceText(draft, authority, sources));
    },
    attachPdf: (scope: ApplicationScope, id: string, input: {
      revision: number; authorityId: string; file: DocumentFile; language: AuthoritySourceLanguage;
      autoFetched?: boolean;
    }) => attachUpload(scope, id, input, (draft, bytes, keep) => attachAuthorityFile(draft, {
      authorityId: input.authorityId, language: input.language, autoFetched: input.autoFetched,
      filename: input.file.filename, bytes, keep })),
    attachBookPdf: (scope: ApplicationScope, id: string, input: {
      revision: number; slot: AuthoritiesBookSlot; file: DocumentFile; supplementId?: string;
    }) => attachUpload(scope, id, input, (draft, bytes, keep) => attachBookFile(draft, {
      slot: input.slot, supplementId: input.supplementId, filename: input.file.filename, bytes, keep })),
    async attachLibraryPdf(scope: ApplicationScope, id: string, input: {
      revision: number; documentId: string; versionId: string;
      target: { kind: "authority"; authorityId: string; language: AuthoritySourceLanguage } |
        { kind: "book"; slot: AuthoritiesBookSlot; supplementId?: string };
    }) {
      const { draft } = await edit(scope, id, input.revision);
      const version = await documents.metadata(scope, input.documentId);
      if (!version || version.current_version_id !== input.versionId ||
          version.file_type.toLowerCase() !== "pdf") {
        throw new ApplicationError(409, "Select the current PDF version from Library");
      }
      const file = await documents.read(scope, input.documentId, input.versionId, false);
      if (!file) throw new ApplicationError(409, "The PDF is no longer available.");
      // A Library PDF is already kept: the draft follows its latest version.
      const keep = async (): Promise<KeptPdf> => ({
        binding: { kind: "document", documentId: input.documentId, version: "latest" },
        reference: { documentId: input.documentId, versionId: input.versionId }, filename: version.filename });
      return workProducts.save(scope, id, { revision: input.revision,
        state: input.target.kind === "authority"
          ? await attachAuthorityFile(draft, { authorityId: input.target.authorityId, language: input.target.language,
            filename: version.filename, bytes: file.bytes, keep })
          : await attachBookFile(draft, { ...input.target, filename: version.filename, bytes: file.bytes, keep }) });
    },
    async annotations(scope: ApplicationScope, id: string, input: {
      authorityId: string; bindingRole: string; sourceSha256: string;
      /** Marks the passages as this marking would, without saving it: an import's preview. */
      passageMarking?: AuthoritiesDraft["settings"]["passageMarking"];
    }, signal?: AbortSignal) {
      const opened = (await open(scope, id)).draft;
      const draft = input.passageMarking ? { ...opened, settings: { ...opened.settings, passageMarking: input.passageMarking } } : opened;
      const attached = attachedAuthoritySources(attachableAuthority(draft, input.authorityId).source)
        .find(source => source.bindingRole === input.bindingRole);
      const binding = libraryBinding(draft, input.bindingRole);
      const source = await documents.projectionSource(scope, binding.documentId,
        binding.version === "latest" ? null : binding.version.versionId);
      if (!attached || !source || source.fileType !== "pdf" ||
          attached.sourceSha256 !== input.sourceSha256 || source.sourceSha256 !== input.sourceSha256)
        throw new ApplicationError(409, "This PDF changed. Relink it before editing highlights.");
      signal?.throwIfAborted();
      // Annotation review is a reader, not a second OCR job: Library's queue recognizes scans, and the source is read
      // with the recognition that queue kept.
      return authorityAnnotations(draft, { authorityId: input.authorityId, bindingRole: input.bindingRole,
        bytes: await source.readBytes(), reference: { documentId: source.documentId, versionId: source.versionId },
        pdfProfile: source.pdfProfile, recognize: false, signal });
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
          // An explicit recognition request also repairs missing retained artifacts;
          // an OCR profile alone is not proof that its selectable text still exists.
          const prepared = await documentProjectionService.preparePdf({ ...reference,
            bytes: await resolved.readBytes(), ocrProvider: null });
          if (pages?.some((page) => page > prepared.pageCount)) throw new ApplicationError(400,
            `Choose page numbers within the PDF for ${source.filename}.`);
          const citations = authorityCitationForms(draft, authority.id);
          const bindings = pages ? [] : await documentProjectionService.pdfPagination({ ...resolved,
            reporterOriginal: source.origin === "original" }, citations);
          const targets = pages ? [] : authorityPassageTargets(draft, authority.id);
          // Page pinpoints locate themselves without any text, so a scan whose passages the
          // geometry cannot find still has its cited pages recognized before the whole PDF.
          const citedPages = pages ? [] : [...citedSourcePages(draft, authority.id, [],
            bindings, prepared.pageCount)].map((index) => index + 1);
          if (!pages && !citedPages.length && targets.some(target => target.locatorKind === "page") &&
              source.origin === "original" && reporterStartPages(citations).length) {
            // Let the existing priority OCR pass establish an opening reporter anchor first.
            citedPages.push(...Array.from({ length: Math.min(3, prepared.pageCount) }, (_, index) => index + 1));
          }
          for (let start = 0; start < targets.length; start += 100) {
            const geometry = await documentProjectionService.pdfPassageGeometry(resolved.readBytes,
              targets.slice(start, start + 100), { ...reference, cacheKey: prepared.cacheKey },
              { citations, reporterOriginal: source.origin === "original",
                pdfProfile: { cacheKey: prepared.cacheKey, profile: prepared.profile, status: prepared.status } });
            citedPages.push(...geometry.targets.flatMap(target => target.status === "found"
              ? target.pages.map(page => page.pageNumber) : []));
          }
          await enqueueAuthorityOcr({ ...reference, citedPages, pages });
          return { role: source.bindingRole, documentId: resolved.documentId };
        }));
    },
    async build(scope: ApplicationScope, id: string, revision: number, signal?: AbortSignal, progress?: Progress):
      Promise<{ product: AuthoritiesProduct; receipt: AuthoritiesBuildResult["receipt"] }> {
      const { product, draft: storedDraft } = await edit(scope, id, revision);
      const draft = await followLatestBindings(scope, storedDraft, signal);
      let built: AuthoritiesBuildResult;
      try {
        const { files, unread } = await buildFiles(scope, draft, signal);
        ({ built } = await buildAuthoritiesDraft(draft, { title: product.title, workProduct: { id, revision },
          files, unread, builder, signal: signal ?? new AbortController().signal, progress,
          statuteText: (authority, abort) => authorityStatuteText(draft, authority, sources, abort),
          ...(wordToPdfAvailable() ? { finalPdfSource: async (bytes: Uint8Array) => docxToPdf(Buffer.from(bytes)) } : {}),
        }));
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(409,
          error instanceof Error ? error.message : "Authorities could not be built");
      }
      const artifacts = Object.values(built.artifacts).filter(
        (item): item is NonNullable<typeof item> => Boolean(item)).map((artifact) => ({
          role: artifact.role,
          file: { filename: artifact.filename,
            fileType: artifact.mimeType === "application/pdf" ? "pdf"
              : artifact.mimeType === "text/plain" ? "txt" : "docx",
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
